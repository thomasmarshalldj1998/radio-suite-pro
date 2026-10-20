/**
 * Signalpath audio engine.
 *
 * Signal flow:
 *   source → inputGain → HPF ─┬─ input meters (L/R)
 *                              ├─ spectrum (pre)
 *                              └─ phase rotator (4-stage allpass cascade)
 *                                 → 6-band EQ → harmonic exciter (parallel)
 *                                 → dynamic EQ (3 subtractive bands)
 *                                 → program AGC (window-gated leveller)
 *                                 → 6-band multiband compressor (LR4,
 *                                    scaled by the Less–More macro)
 *                                 → loudness rider
 *                                 → de-esser (dynamic 6–10 kHz cut)
 *                                 → composite limiter → output gain
 *                                 → ceiling guard → M/S stereo width → duck
 *                                  ├─ monitor out (speakers)
 *                                  ├─ encoder send (MediaStream for Icecast)
 *                                  ├─ spectrum (post)
 *                                  ├─ sample-peak / true-peak meters (L/R)
 *                                  └─ K-weighted loudness (BS.1770, L/R)
 */

import { GlitchMonitor } from "./glitch";
import type { ProcessorParams } from "./params";
import {
  DEFAULT_CLIPPER,
  DEFAULT_PARAMS,
  DEFAULT_SPLITS,
  agcFast,
  dbToGain,
  eqBandOn,
  hpfSectionQs,
  limiterClipper,
} from "./params";
import {
  WindowGate,
  clampDeessFreq,
  deessAlpha,
  densityProfile,
  phaseStageFrequencies,
} from "./tools";

export type SourceKind = "signal" | "mic" | "file";
export type SignalMode = "tone" | "pink";
export type MicStatus = "idle" | "arming" | "on" | "error";

/** One physical audio device, as listed by the OS. */
export interface AudioDevice {
  id: string;
  label: string;
}

export interface MeterSnapshot {
  t: number;
  powered: boolean;
  inPeakL: number;
  inPeakR: number;
  outPeakL: number;
  outPeakR: number;
  truePeak: number;
  lufsM: number;
  lufsS: number;
  /** K-weighted input-stage loudness (BS.1770, pre-chain) */
  lufsIn: number;
  /** Gated integrated loudness (BS.1770-4) — null until enough programme */
  lufsI: number | null;
  /** Loudness range (EBU Tech 3342) — null until enough short-term data */
  lra: number | null;
  /** Measurement duration since reset (ms of powered time) */
  measureMs: number;
  /** Maximum sample peak since reset (dBFS) */
  samplePeakDb: number;
  correlation: number;
  /** per-band GR (6), dynamic-EQ cut (3), AGC GR, limiter GR */
  gr: {
    bands: number[];
    deq: number[];
    /** Combined AGC reduction (fast + slow windows). */
    agc: number;
    /** Fast peak window alone, so the operator can see which stage works. */
    agcFast: number;
    limiter: number;
  };
  /** AGC window gate — true while the gain is held inside the window. */
  agcWindow: { frozen: boolean; spreadDb: number };
  /** Current de-esser cut (dB). */
  deessCut: number;
  /** current loudness-rider gain in dB (negative = pulling down) */
  riderDb: number;
  /** latency & main-thread health */
  perf: {
    baseLatencyMs: number;
    outputLatencyMs: number;
    frameMs: number;
    driftMs: number;
    throttled: boolean;
    /** Starved render-thread episodes this session. */
    stalls: number;
    /** Epoch ms of the last stall report (0 = never). */
    glitchAt: number;
  };
  clipIn: boolean;
  clipOut: boolean;
  /** Output clip events this session + wall-clock of the latest one. */
  clipEvents: number;
  clipAt: number;
  /** Pre-gate programme-bus level (dBFS) — the dead-air detector's source. */
  srcLevelDb: number;
  /** Speech-sense profile engaged (faster AGC/MB envelopes). */
  speechFast: boolean;
  /** True while the standby source is feeding the chain (failover active). */
  backupActive: boolean;
}

export const SILENT_SNAPSHOT: MeterSnapshot = {
  t: 0,
  powered: false,
  inPeakL: -120,
  inPeakR: -120,
  outPeakL: -120,
  outPeakR: -120,
  truePeak: -120,
  lufsM: -70,
  lufsS: -70,
  lufsIn: -70,
  lufsI: null,
  lra: null,
  measureMs: 0,
  samplePeakDb: -120,
  correlation: 1,
  gr: { bands: [0, 0, 0, 0, 0, 0], deq: [0, 0, 0], agc: 0, agcFast: 0, limiter: 0 },
  agcWindow: { frozen: false, spreadDb: 0 },
  deessCut: 0,
  riderDb: 0,
  perf: {
    baseLatencyMs: 0,
    outputLatencyMs: 0,
    frameMs: 0,
    driftMs: 0,
    throttled: false,
    stalls: 0,
    glitchAt: 0,
  },
  clipIn: false,
  clipOut: false,
  clipEvents: 0,
  clipAt: 0,
  srcLevelDb: -120,
  speechFast: false,
  backupActive: false,
};

const METER_FLOOR = -120;

function toDb(v: number): number {
  const db = 20 * Math.log10(Math.max(Math.abs(v), 1e-12));
  return db < METER_FLOOR ? METER_FLOOR : db;
}

interface LufsPoint {
  t: number;
  ms: number;
}

/** Persisted I/O prefs: last input/output device + source. */
const DEVICE_STORE = "signalpath.devices.v1";

export class AudioEngine {
  ctx: AudioContext | null = null;
  powered = false;
  sourceKind: SourceKind = "signal";
  signalMode: SignalMode = "pink";
  micStatus: MicStatus = "idle";
  micLabel = "";
  /** Physical devices from enumerateDevices — picked in the UI, not default-only. */
  inputDevices: AudioDevice[] = [];
  outputDevices: AudioDevice[] = [];
  /** Chosen input ("" = OS default). Survives re-arms. */
  inputDeviceId = "";
  /** Chosen monitor output ("" = OS default). Applied via setSinkId. */
  outputDeviceId = "";
  private deviceWatching = false;

  // file transport
  fileBuffer: AudioBuffer | null = null;
  fileName = "";
  filePeaks: Float32Array<ArrayBuffer> | null = null;
  filePlaying = false;
  private fileOffset = 0;
  private fileStartedAt = 0;
  private fileSource: AudioBufferSourceNode | null = null;

  private listeners = new Set<(s: MeterSnapshot) => void>();
  private snapshotValue: MeterSnapshot = { ...SILENT_SNAPSHOT };

  private raf = 0;
  private frame = 0;
  private notifyAcc = 0;

  private lufsPoints: LufsPoint[] = [];
  private clipInUntil = 0;
  private clipOutUntil = 0;
  private clipEvents = 0;
  private clipAt = 0;
  /** Live speech profile: mic programme detected while sense is armed. */
  private speechFast = false;
  /**
   * Graph-complete invariant: set at the end of buildGraph, cleared by
   * dispose. apply() and the meter loop refuse to touch nodes/analysers
   * until it is true, so teardown races (power-off fades, device-change
   * rebuilds, HMR module reloads) can never dereference a torn-down graph.
   */
  private graphReady = false;
  private scopeBufL = new Float32Array(4096);
  private scopeBufR = new Float32Array(4096);

  // integrated loudness (BS.1770-4 gated) + LRA (EBU Tech 3342)
  private iBlocks: number[] = [];
  private stBlocks: number[] = [];
  private lufsIValue: number | null = null;
  private lraValue: number | null = null;
  private measureMsAcc = 0;
  private lastMeasureT = 0;
  private lastIBlockAt = 0;
  private lastStBlockAt = 0;
  private samplePeakDb = -120;

  // graph
  private sourceBus!: GainNode;
  private inputGain!: GainNode;
  /**
   * HPF cascade — one biquad per 12 dB/oct of the selected steepness (up to
   * four). Sections past the selected slope stay in the graph as allpass,
   * which is magnitude-neutral, so changing steepness never rewires audio.
   */
  private hpfStages: BiquadFilterNode[] = [];
  private phaseWet!: GainNode;
  private phaseDry!: GainNode;
  private phaseStages: BiquadFilterNode[] = [];
  private gateGain!: GainNode;
  private gateAnalyser!: AnalyserNode;
  private gateBuf!: Float32Array<ArrayBuffer>;
  private gateOpen = true;
  private gateCloseAt = 0;
  // failover: primary crossfade gain + standby media element into the chain
  private srcGain!: GainNode;
  private backupGain!: GainNode;
  private backupEl: HTMLAudioElement | null = null;
  private backupSrc: MediaElementAudioSourceNode | null = null;
  private backupUrl: string | null = null;
  private backupLabel: string | null = null;
  private backupActiveFlag = false;
  private eqFilters: BiquadFilterNode[] = [];
  private eqWetPre!: GainNode;
  private eqDry!: GainNode;
  private mbWetPre!: GainNode;
  private mbDry!: GainNode;
  private mbComps: DynamicsCompressorNode[] = [];
  private mbMakeups: GainNode[] = [];
  /** LR4 filter pairs per crossover split index */
  private mbSplitFilters: BiquadFilterNode[][] = [];
  // dynamic EQ: band-pass detectors + subtractive parallel bands
  private deqBpDet: BiquadFilterNode[] = [];
  private deqBpAudio: BiquadFilterNode[] = [];
  private deqDets: DynamicsCompressorNode[] = [];
  private deqSubs: GainNode[] = [];
  private deqCutDb: number[] = [0, 0, 0];
  // composite ceiling guard (per-sample soft clip after output trim)
  private guardWet!: GainNode;
  private guardDry!: GainNode;
  private guardShaper!: WaveShaperNode;
  // pre-limiter soft clipper: one 4× oversampled shaper blended in parallel
  // with the dry program, so clipping shaves peaks without dulling the mix
  private clipShaper!: WaveShaperNode;
  private clipDry!: GainNode;
  private clipWet!: GainNode;
  private clipThresholdDb = Number.NaN;
  private guardCeilingDb = Number.NaN;
  // loudness rider (Compellor-style leveler / AERO long-term controller)
  private riderGain!: GainNode;
  private riderDb = 0;
  // parallel harmonic exciter
  private exBp1!: BiquadFilterNode;
  private exBp2!: BiquadFilterNode;
  private exMix!: GainNode;
  // M/S stereo width (transparent when bypassed)
  private widthDry!: GainNode;
  private widthWet!: GainNode;
  private widthGain!: GainNode;
  /** Low-end mono: side highs pass, side lows fold back to centred. */
  private sideDry!: GainNode;
  private sideWet!: GainNode;
  private sideLp!: BiquadFilterNode;
  private sideLpNeg!: GainNode;
  private sideWetInv!: GainNode;
  // latency / stability telemetry
  lowLatency = false;
  private glitch = new GlitchMonitor();
  /** Invalidates a pending power-off fade when the engine is re-powered. */
  private fadeToken = 0;
  /** Invalidates a pending source switch when another one is requested. */
  private sourceToken = 0;
  private frameCostMs = 0;
  private meterTick = 0;
  private driftMs = 0;
  private clockRefWall = 0;
  private clockRefCtx = 0;
  private agcWetPre!: GainNode;
  /** Fast peak window, ahead of the slow leveller (dual-window AGC). */
  private agcFastComp!: DynamicsCompressorNode;
  private agcComp!: DynamicsCompressorNode;
  private agcMakeup!: GainNode;
  private agcDry!: GainNode;
  /** Metering branch of the leveller (off while the window gate is holding). */
  private agcWetOut!: GainNode;
  /** Static hold path: frozen gain, crossfaded in by the window gate. */
  private agcHold!: GainNode;
  private agcHoldGainDb = 0;
  private windowGate = new WindowGate();
  private agcFrozen = false;
  private agcSpreadDb = 0;
  private deessBpAudio!: BiquadFilterNode;
  private deessBpDet!: BiquadFilterNode;
  private deessDet!: DynamicsCompressorNode;
  private deessSub!: GainNode;
  /** Program bus leaving the de-esser, on its way to the limiter. */
  private deessOut!: GainNode;
  private deessCutDb = 0;
  private limDrive!: GainNode;
  private limWetPre!: GainNode;
  private limComp!: DynamicsCompressorNode;
  private limDry!: GainNode;
  private outputGain!: GainNode;
  private duckGain!: GainNode;
  private matchGain!: GainNode;
  /** v3.0 tilt pair: 0 dB shelves are bit-transparent passthrough. */
  private tiltLo!: BiquadFilterNode;
  private tiltHi!: BiquadFilterNode;
  private monitorGain!: GainNode;
  private streamGain!: GainNode;
  private streamDest!: MediaStreamAudioDestinationNode;

  // analysers
  private inAnalyserL!: AnalyserNode;
  private inAnalyserR!: AnalyserNode;
  private preSpec!: AnalyserNode;
  private postSpec!: AnalyserNode;
  private outAnalyserL!: AnalyserNode;
  private outAnalyserR!: AnalyserNode;
  private ksAnalyserL!: AnalyserNode;
  private ksAnalyserR!: AnalyserNode;
  private inKsAnalyserL!: AnalyserNode;
  private inKsAnalyserR!: AnalyserNode;

  // buffers
  private timeBuf!: Float32Array<ArrayBuffer>;
  /** Output-tap scratch (outAnalyser fftSize) — never shared with the
   * shorter K-weighting buffers or getFloatTimeDomainData throws. */
  private outBufL!: Float32Array<ArrayBuffer>;
  private outBufR!: Float32Array<ArrayBuffer>;
  private ksBufL!: Float32Array<ArrayBuffer>;
  private ksBufR!: Float32Array<ArrayBuffer>;
  private ksBufInL!: Float32Array<ArrayBuffer>;
  private ksBufInR!: Float32Array<ArrayBuffer>;
  private specBufPre!: Uint8Array<ArrayBuffer>;
  private specBufPost!: Uint8Array<ArrayBuffer>;

  private signalOsc: AudioScheduledSourceNode | null = null;
  private signalGain: GainNode | null = null;
  private micStream: MediaStream | null = null;
  private micNode: MediaStreamAudioSourceNode | null = null;
  private params: ProcessorParams | null = null;

  /* ── lifecycle ────────────────────────────────────────────────────────── */

  constructor() {
    this.loadDevicePrefs();
  }

  /** Last-used I/O + source survive restarts, so boot restores the rig. */
  private loadDevicePrefs() {
    try {
      const raw = localStorage.getItem(DEVICE_STORE);
      if (!raw) return;
      const p = JSON.parse(raw) as Partial<{
        input: string;
        output: string;
        source: SourceKind;
      }>;
      if (typeof p.input === "string") this.inputDeviceId = p.input;
      if (typeof p.output === "string") this.outputDeviceId = p.output;
      if (p.source === "mic" || p.source === "signal" || p.source === "file") {
        this.sourceKind = p.source;
      }
    } catch {
      /* fresh install or blocked storage — defaults stand */
    }
  }

  private saveDevicePrefs() {
    try {
      localStorage.setItem(
        DEVICE_STORE,
        JSON.stringify({
          input: this.inputDeviceId,
          output: this.outputDeviceId,
          source: this.sourceKind,
        }),
      );
    } catch {
      /* storage may be unavailable */
    }
  }

  /**
   * Cold-boot input: if the rig was left on mic and the OS permission is
   * already granted, arm the saved device without prompting. Anything else
   * (denied/prompt/unplugged) stays idle — boot must never throw a
   * permission dialog at the operator.
   */
  private async autoInitInput(): Promise<void> {
    if (this.sourceKind !== "mic") return;
    if (this.micStatus === "on" || this.micStatus === "arming") return;
    try {
      const q = await navigator.permissions.query({
        name: "microphone" as PermissionName,
      });
      if (q.state === "granted") await this.armMic();
    } catch {
      /* permissions API missing — leave idle for an explicit Arm press */
    }
  }

  async powerOn(): Promise<void> {
    this.resetLoudness();
    this.fadeToken += 1; // any pending power-off teardown is now stale
    if (this.ctx) {
      await this.ctx.resume();
      this.powered = true;
      this.openOutput();
      this.watchDevices();
      void this.applyOutputDevice();
      void this.autoInitInput();
      this.startMeterLoop();
      this.notify();
      return;
    }
    const ctx = new AudioContext({ latencyHint: "interactive" });
    this.ctx = ctx;
    this.buildGraph(ctx);
    this.watchDevices();
    void this.applyOutputDevice();
    void this.autoInitInput();
    if (this.params) this.apply(this.params);
    await ctx.resume();
    this.powered = true;
    this.openOutput();
    this.setSource(this.sourceKind);
    this.startMeterLoop();
    this.notify();
  }

  /** Fade the output bus in from silence — no click on power-up or resume. */
  private openOutput() {
    if (!this.ctx || !this.duckGain) return;
    const now = this.ctx.currentTime;
    const gain = this.duckGain.gain;
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(0, now);
    gain.setTargetAtTime(1, now, 0.008);
  }

  powerOff() {
    const ctx = this.ctx;
    const token = ++this.fadeToken;
    this.cancelMeterLoop();
    this.powered = false;
    this.lufsPoints = [];
    this.snapshotValue = { ...SILENT_SNAPSHOT };
    this.notify();

    const teardown = () => {
      this.stopFile();
      this.disarmMic();
      this.stopSignal();
      // the standby source never outlives the on-air chain
      if (this.backupEl) this.backupEl.pause();
      this.backupActiveFlag = false;
      if (this.srcGain) this.srcGain.gain.value = 1;
      if (this.backupGain) this.backupGain.gain.value = 0;
      if (ctx && ctx.state !== "closed") void ctx.suspend();
    };

    // Suspend only after the bus has faded: stopping the graph at programme
    // level is a click, and a click on the composite is audible on air.
    if (ctx && ctx.state === "running" && this.duckGain) {
      const now = ctx.currentTime;
      this.duckGain.gain.cancelScheduledValues(now);
      this.duckGain.gain.setTargetAtTime(0, now, 0.005);
      window.setTimeout(() => {
        if (this.fadeToken === token && !this.powered) teardown();
      }, 45);
    } else {
      teardown();
    }
  }

  dispose() {
    this.graphReady = false;
    this.powerOff();
    this.backupSrc = null;
    this.backupEl = null;
    if (this.backupUrl) URL.revokeObjectURL(this.backupUrl);
    this.backupUrl = null;
    if (this.ctx) {
      void this.ctx.close();
      this.ctx = null;
    }
  }

  /* ── graph construction ───────────────────────────────────────────────── */

  private ramp(param: AudioParam | undefined, value: number, tc = 0.02) {
    if (!this.ctx || !param) return;
    param.setTargetAtTime(value, this.ctx.currentTime, tc);
  }

  private buildGraph(ctx: AudioContext) {
    // A context suspended by the platform (sleep, device change, tab
    // eviction) is a hard glitch. Resume it as soon as we are allowed to;
    // a deliberate power-off sets `powered` false first, so it is not undone.
    ctx.onstatechange = () => {
      if (this.powered && ctx.state === "suspended") void ctx.resume();
    };
    const g = (v = 1) => {
      const n = ctx.createGain();
      n.gain.value = v;
      return n;
    };

    this.sourceBus = g(1);

    // input stage: silence gate → trim → HPF → phase rotation
    this.gateGain = g(1);
    this.inputGain = g(1);
    for (let i = 0; i < 4; i++) {
      const stage = ctx.createBiquadFilter();
      stage.type = "highpass";
      stage.frequency.value = 80;
      stage.Q.value = 0.7071;
      this.hpfStages.push(stage);
    }
    this.sourceBus.connect(this.gateGain);
    // Failover crossfade point. The primary path (post-gate) and the standby
    // source meet at inputGain: the backup therefore bypasses the silence gate
    // but still feeds the whole chain, and the pre-gate analyser above stays a
    // truthful view of the programme feed while the backup is on air.
    this.srcGain = g(1);
    this.backupGain = g(0);
    this.gateGain.connect(this.srcGain);
    this.srcGain.connect(this.inputGain);
    this.backupGain.connect(this.inputGain);
    // pre-gate detector so a closed gate still hears program return
    this.gateAnalyser = ctx.createAnalyser();
    this.gateAnalyser.fftSize = 2048;
    this.gateBuf = new Float32Array(this.gateAnalyser.fftSize);
    this.sourceBus.connect(this.gateAnalyser);

    const inSplit = ctx.createChannelSplitter(2);
    this.inAnalyserL = ctx.createAnalyser();
    this.inAnalyserR = ctx.createAnalyser();
    this.inAnalyserL.fftSize = 2048;
    this.inAnalyserR.fftSize = 2048;
    this.inputGain.connect(inSplit);
    inSplit.connect(this.inAnalyserL, 0);
    inSplit.connect(this.inAnalyserR, 1);

    this.preSpec = ctx.createAnalyser();
    this.preSpec.fftSize = 2048;
    this.preSpec.smoothingTimeConstant = 0.8;
    this.inputGain.connect(this.preSpec);

    let hpfNode: AudioNode = this.inputGain;
    for (const stage of this.hpfStages) {
      hpfNode.connect(stage);
      hpfNode = stage;
    }

    // ── phase rotator: 4-stage allpass cascade (voice asymmetry) ──
    // Allpass sections change phase and never magnitude, so a staggered
    // cascade levels the waveform's positive and negative peaks without
    // touching the spectrum. Bypassable as a whole.
    this.phaseWet = g(1);
    this.phaseDry = g(0);
    hpfNode.connect(this.phaseWet);
    hpfNode.connect(this.phaseDry);
    let phaseNode: AudioNode = this.phaseWet;
    for (const stageHz of phaseStageFrequencies(300)) {
      const ap = ctx.createBiquadFilter();
      ap.type = "allpass";
      ap.frequency.value = stageHz;
      ap.Q.value = 0.5;
      phaseNode.connect(ap);
      phaseNode = ap;
      this.phaseStages.push(ap);
    }
    const phaseOut = g(1);
    phaseNode.connect(phaseOut);
    this.phaseDry.connect(phaseOut);

    // ── 6-band EQ (wet/dry crossfade) ──
    this.eqWetPre = g(1);
    this.eqDry = g(0);
    phaseOut.connect(this.eqWetPre);
    phaseOut.connect(this.eqDry);
    let eqNode: AudioNode = this.eqWetPre;
    for (const band of [
      { freq: 60, type: "lowshelf" as BiquadFilterType, q: 0.7 },
      { freq: 200, type: "peaking" as BiquadFilterType, q: 1 },
      { freq: 700, type: "peaking" as BiquadFilterType, q: 1 },
      { freq: 2500, type: "peaking" as BiquadFilterType, q: 1.2 },
      { freq: 6000, type: "peaking" as BiquadFilterType, q: 1.4 },
      { freq: 12000, type: "highshelf" as BiquadFilterType, q: 0.7 },
    ]) {
      const b = ctx.createBiquadFilter();
      b.type = band.type;
      b.frequency.value = band.freq;
      b.Q.value = band.q;
      b.gain.value = 0;
      eqNode.connect(b);
      eqNode = b;
      this.eqFilters.push(b);
    }
    const eqOut = g(1);
    eqNode.connect(eqOut);
    this.eqDry.connect(eqOut);

    // ── dynamic EQ: subtractive parallel bands driven by level detectors ──
    const deqIn = g(1);
    const deqSum = g(1);
    eqOut.connect(deqIn);
    deqIn.connect(deqSum); // dry pass-through
    const DEQ_META = [
      { freq: 80, q: 0.9 },
      { freq: 250, q: 1.0 },
      { freq: 1600, q: 1.1 },
      { freq: 5000, q: 1.2 },
      { freq: 10000, q: 1.1 },
    ];
    for (const meta of DEQ_META) {
      const mkBp = () => {
        const bp = ctx.createBiquadFilter();
        bp.type = "bandpass";
        bp.frequency.value = meta.freq;
        bp.Q.value = meta.q;
        return bp;
      };
      // audio path: band → subtractor (α) → inverter (−1) → sum
      const bpAudio = mkBp();
      const sub = g(0);
      const inv = g(-1);
      deqIn.connect(bpAudio);
      bpAudio.connect(sub);
      sub.connect(inv);
      inv.connect(deqSum);
      // detector path: band → envelope compressor → silent sink
      const bpDet = mkBp();
      const det = ctx.createDynamicsCompressor();
      det.threshold.value = -20;
      det.ratio.value = 20;
      det.knee.value = 3;
      det.attack.value = 0.006;
      det.release.value = 0.18;
      deqIn.connect(bpDet);
      bpDet.connect(det);
      const sink = g(0);
      det.connect(sink);
      sink.connect(ctx.destination);
      this.deqBpAudio.push(bpAudio);
      this.deqBpDet.push(bpDet);
      this.deqDets.push(det);
      this.deqSubs.push(sub);
    }

    // ── harmonic exciter: band-limited odd-order harmonics, blended subtly ──
    this.exBp1 = ctx.createBiquadFilter();
    this.exBp1.type = "bandpass";
    this.exBp1.frequency.value = 3200;
    this.exBp1.Q.value = 0.9;
    const exDrive = g(4);
    const exShaper = ctx.createWaveShaper();
    const exCurve = new Float32Array(4097);
    const exK = 2.5;
    for (let i = 0; i < exCurve.length; i++) {
      const x = -1 + (2 * i) / (exCurve.length - 1);
      exCurve[i] = Math.tanh(exK * x) / Math.tanh(exK);
    }
    exShaper.curve = exCurve;
    this.exBp2 = ctx.createBiquadFilter();
    this.exBp2.type = "bandpass";
    this.exBp2.frequency.value = 5400;
    this.exBp2.Q.value = 0.7;
    this.exMix = g(0);
    eqOut.connect(this.exBp1);
    this.exBp1.connect(exDrive);
    exDrive.connect(exShaper);
    exShaper.connect(this.exBp2);
    this.exBp2.connect(this.exMix);
    this.exMix.connect(deqSum); // harmonics join the program here

    // ── program AGC (pre-multiband leveller — its leveled output feeds
    //    the multiband stage as the input reference level) ──
    this.agcWetPre = g(1);
    this.agcDry = g(0);
    // Fast window: a short-release peak follower. Bypassed = ratio 1, which
    // Web Audio treats as unity regardless of threshold, so the stage can
    // stay in the graph (and keep its latency constant) while off.
    this.agcFastComp = ctx.createDynamicsCompressor();
    this.agcFastComp.threshold.value = -10;
    this.agcFastComp.ratio.value = 1;
    this.agcFastComp.knee.value = 0;
    this.agcFastComp.attack.value = 0.003;
    this.agcFastComp.release.value = 0.25;
    this.agcComp = ctx.createDynamicsCompressor();
    this.agcComp.threshold.value = -18;
    this.agcComp.ratio.value = 3;
    this.agcComp.knee.value = 6;
    this.agcComp.attack.value = 0.015;
    this.agcComp.release.value = 0.4;
    this.agcMakeup = g(dbToGain(4));
    // Window-gate hold path: the same programme at a fixed gain equal to the
    // leveller's current gain. Crossfading to it freezes the gain without
    // muting the program.
    this.agcWetOut = g(1);
    this.agcHold = g(0);
    const agcOut = g(1);
    deqSum.connect(this.agcWetPre);
    deqSum.connect(this.agcDry);
    deqSum.connect(this.agcHold);
    this.agcWetPre.connect(this.agcFastComp);
    this.agcFastComp.connect(this.agcComp);
    this.agcComp.connect(this.agcMakeup);
    this.agcMakeup.connect(this.agcWetOut);
    this.agcWetOut.connect(agcOut);
    this.agcHold.connect(agcOut);
    this.agcDry.connect(agcOut);

    // ── 6-band multiband compressor (LR4 crossovers), driven by the
    //    leveled AGC output ──
    this.mbWetPre = g(1);
    this.mbDry = g(0);
    agcOut.connect(this.mbWetPre);
    agcOut.connect(this.mbDry);
    const mbSum = g(1);
    this.mbDry.connect(mbSum);

    const mkSplitFilter = (split: number, type: BiquadFilterType) => {
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = DEFAULT_SPLITS[split];
      f.Q.value = 0.707;
      (this.mbSplitFilters[split] ??= []).push(f);
      return f;
    };
    // LR4 = two cascaded biquads of the same type at one split point
    const lr4 = (split: number, type: BiquadFilterType, input: AudioNode) => {
      const a = mkSplitFilter(split, type);
      const b = mkSplitFilter(split, type);
      input.connect(a);
      a.connect(b);
      return b;
    };

    const mbDefaults = DEFAULT_PARAMS.multiband.bands;
    const mbStarts: GainNode[] = [];
    mbDefaults.forEach((band, i) => {
      const start = g(1);
      mbStarts.push(start);
      // band i spans split(i−1)…split(i): ends use one LR4 pair, middle
      // bands cascade a highpass pair into a lowpass pair
      let node: AudioNode = start;
      if (i > 0) node = lr4(i - 1, "highpass", node);
      if (i < mbDefaults.length - 1) node = lr4(i, "lowpass", node);
      const tail = node;

      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = band.thresholdDb;
      comp.ratio.value = band.ratio;
      comp.attack.value = band.attackMs / 1000;
      comp.release.value = band.releaseMs / 1000;
      comp.knee.value = 3;
      const makeup = g(dbToGain(band.makeupDb));
      tail.connect(comp);
      comp.connect(makeup);
      makeup.connect(mbSum);
      this.mbComps.push(comp);
      this.mbMakeups.push(makeup);
    });
    for (const start of mbStarts) this.mbWetPre.connect(start);

    // ── loudness rider: slow K-weighted gain ride (Compellor leveler /
    //    AERO.lite long-term controller); driven from the meter loop ──
    this.riderGain = g(1);
    // multiband sum carries the AGC-leveled program into the rider
    mbSum.connect(this.riderGain);

    // ── de-esser: dynamic HF cut ahead of the limiter ──
    // Parallel-subtract, exactly like a dynamic-EQ band: the sibilance band
    // is isolated, its level drives a fast detector, and α of that band is
    // subtracted from the program before the final stage sees it.
    const deessIn = g(1);
    const deessOut = g(1);
    this.deessOut = deessOut;
    this.riderGain.connect(deessIn);
    deessIn.connect(deessOut); // dry pass-through
    this.deessBpAudio = ctx.createBiquadFilter();
    this.deessBpAudio.type = "bandpass";
    this.deessBpAudio.frequency.value = 7500;
    this.deessBpAudio.Q.value = 0.7;
    this.deessSub = g(0);
    const deessInv = g(-1);
    deessIn.connect(this.deessBpAudio);
    this.deessBpAudio.connect(this.deessSub);
    this.deessSub.connect(deessInv);
    deessInv.connect(deessOut);
    this.deessBpDet = ctx.createBiquadFilter();
    this.deessBpDet.type = "bandpass";
    this.deessBpDet.frequency.value = 7500;
    this.deessBpDet.Q.value = 0.7;
    this.deessDet = ctx.createDynamicsCompressor();
    this.deessDet.threshold.value = -26;
    this.deessDet.ratio.value = 20;
    this.deessDet.knee.value = 3;
    this.deessDet.attack.value = 0.001;
    this.deessDet.release.value = 0.06;
    deessIn.connect(this.deessBpDet);
    this.deessBpDet.connect(this.deessDet);
    const deessSink = g(0);
    this.deessDet.connect(deessSink);
    deessSink.connect(ctx.destination);

    // ── brickwall limiter (the density macro drives it from the front) ──
    this.limWetPre = g(1);
    this.limDry = g(0);
    this.limDrive = g(1);
    this.limComp = ctx.createDynamicsCompressor();
    this.limComp.threshold.value = -1;
    this.limComp.ratio.value = 20;
    this.limComp.knee.value = 0;
    this.limComp.attack.value = 0.0015;
    this.limComp.release.value = 0.1;
    const limOut = g(1);
    deessOut.connect(this.limWetPre);
    deessOut.connect(this.limDry);
    this.limWetPre.connect(this.limDrive);
    // software clipper between the drive stage and the peak limiter
    this.clipDry = g(1);
    this.clipWet = g(0);
    this.clipShaper = ctx.createWaveShaper();
    this.clipShaper.oversample = "4x";
    this.rebuildClipCurve(DEFAULT_CLIPPER.thresholdDb);
    this.limDrive.connect(this.clipDry);
    this.clipDry.connect(this.limComp);
    this.limDrive.connect(this.clipShaper);
    this.clipShaper.connect(this.clipWet);
    this.clipWet.connect(this.limComp);
    this.limComp.connect(limOut);
    this.limDry.connect(limOut);

    // ── output / ceiling guard / duck / monitor / encoder send ──
    this.outputGain = g(1);
    this.duckGain = g(1);
    limOut.connect(this.outputGain);

    // composite ceiling guard: per-sample soft clip after the output trim so
    // the composite bus can never exceed the limiter ceiling
    this.guardWet = g(1);
    this.guardDry = g(0);
    this.guardShaper = ctx.createWaveShaper();
    this.guardShaper.oversample = this.lowLatency ? "2x" : "4x";
    this.outputGain.connect(this.guardWet);
    this.outputGain.connect(this.guardDry);
    this.guardWet.connect(this.guardShaper);
    const postGuard = g(1);
    this.guardShaper.connect(postGuard);
    this.guardDry.connect(postGuard);

    // ── M/S stereo width (Stereo Tool “stereo boost” / Compellor enhance).
    //    Dry path stays in circuit at width = 1 so mono sources are untouched.─
    this.widthDry = g(1);
    this.widthWet = g(0);
    postGuard.connect(this.widthDry);
    postGuard.connect(this.widthWet);
    // v3.0 perceptual tilt sits ahead of the duck/meter taps, so the
    // analysers, the LUFS engine and the encoder send all hear it. Both
    // shelves default to 0 dB — exact unity passthrough until enabled.
    this.tiltLo = ctx.createBiquadFilter();
    this.tiltLo.type = "lowshelf";
    this.tiltLo.frequency.value = 1000;
    this.tiltLo.gain.value = 0;
    this.tiltHi = ctx.createBiquadFilter();
    this.tiltHi.type = "highshelf";
    this.tiltHi.frequency.value = 1000;
    this.tiltHi.gain.value = 0;
    this.widthDry.connect(this.tiltLo);
    this.tiltLo.connect(this.tiltHi);
    this.tiltHi.connect(this.duckGain);
    this.widthGain = g(1);
    this.widthWet.connect(this.widthGain);
    const wSplit = ctx.createChannelSplitter(2);
    this.widthGain.connect(wSplit);
    const mid = g(0.5);
    const side = g(0.5);
    const sideNeg = g(-1);
    wSplit.connect(mid, 0);
    wSplit.connect(mid, 1);
    wSplit.connect(side, 0);
    wSplit.connect(sideNeg, 1);
    sideNeg.connect(side);
    const wMerge = ctx.createChannelMerger(2);
    // NOTE: connect(dest, output, input) — a GainNode only has output 0, so
    // routing into the merger's right channel must target input 1 (3rd arg).
    mid.connect(wMerge, 0, 0);
    mid.connect(wMerge, 0, 1);
    // Low-end mono matrix: dry side always available; wet side carries
    // side − lowpassed(side), i.e. bass folds to mono below the crossover.
    this.sideDry = g(1);
    this.sideWet = g(0);
    this.sideLp = ctx.createBiquadFilter();
    this.sideLp.type = "lowpass";
    this.sideLp.frequency.value = 120;
    this.sideLp.Q.value = 0.707;
    this.sideLpNeg = g(-1);
    side.connect(this.sideDry);
    side.connect(this.sideLp);
    side.connect(this.sideWet);
    this.sideLp.connect(this.sideLpNeg);
    this.sideLpNeg.connect(this.sideWet);
    this.sideDry.connect(wMerge, 0, 0);
    const sideInv = g(-1);
    this.sideDry.connect(sideInv);
    sideInv.connect(wMerge, 0, 1);
    this.sideWet.connect(wMerge, 0, 0);
    this.sideWetInv = g(-1);
    this.sideWet.connect(this.sideWetInv);
    this.sideWetInv.connect(wMerge, 0, 1);
    wMerge.connect(this.tiltLo);

    this.monitorGain = g(dbToGain(-6));
    this.matchGain = g(1);
    this.duckGain.connect(this.matchGain);
    this.matchGain.connect(this.monitorGain);
    this.monitorGain.connect(ctx.destination);

    this.streamGain = g(1);
    this.streamDest = ctx.createMediaStreamDestination();
    this.duckGain.connect(this.streamGain);
    this.streamGain.connect(this.streamDest);

    // ── metering tap (post) ──
    const outSplit = ctx.createChannelSplitter(2);
    this.outAnalyserL = ctx.createAnalyser();
    this.outAnalyserR = ctx.createAnalyser();
    this.outAnalyserL.fftSize = 4096;
    this.outAnalyserR.fftSize = 4096;
    this.duckGain.connect(outSplit);
    outSplit.connect(this.outAnalyserL, 0);
    outSplit.connect(this.outAnalyserR, 1);

    this.postSpec = ctx.createAnalyser();
    this.postSpec.fftSize = 2048;
    this.postSpec.smoothingTimeConstant = 0.82;
    this.duckGain.connect(this.postSpec);

    // K-weighting (ITU-R BS.1770-4): high shelf + RLB high-pass
    const ksShelf = ctx.createBiquadFilter();
    ksShelf.type = "highshelf";
    ksShelf.frequency.value = 1681.97;
    ksShelf.gain.value = 3.99984;
    const ksHp = ctx.createBiquadFilter();
    ksHp.type = "highpass";
    ksHp.frequency.value = 38.135;
    ksHp.Q.value = 0.5003271;
    const ksSplit = ctx.createChannelSplitter(2);
    this.ksAnalyserL = ctx.createAnalyser();
    this.ksAnalyserR = ctx.createAnalyser();
    this.ksAnalyserL.fftSize = 2048;
    this.ksAnalyserR.fftSize = 2048;
    this.duckGain.connect(ksShelf);
    ksShelf.connect(ksHp);
    ksHp.connect(ksSplit);
    ksSplit.connect(this.ksAnalyserL, 0);
    ksSplit.connect(this.ksAnalyserR, 1);

    // input-stage loudness tap (same K-weighting, ahead of the chain)
    const inKsShelf = ctx.createBiquadFilter();
    inKsShelf.type = "highshelf";
    inKsShelf.frequency.value = 1681.97;
    inKsShelf.gain.value = 3.99984;
    const inKsHp = ctx.createBiquadFilter();
    inKsHp.type = "highpass";
    inKsHp.frequency.value = 38.135;
    inKsHp.Q.value = 0.5003271;
    this.inKsAnalyserL = ctx.createAnalyser();
    this.inKsAnalyserR = ctx.createAnalyser();
    this.inKsAnalyserL.fftSize = 2048;
    this.inKsAnalyserR.fftSize = 2048;
    const inKsSplit = ctx.createChannelSplitter(2);
    this.inputGain.connect(inKsShelf);
    inKsShelf.connect(inKsHp);
    inKsHp.connect(inKsSplit);
    inKsSplit.connect(this.inKsAnalyserL, 0);
    inKsSplit.connect(this.inKsAnalyserR, 1);

    this.timeBuf = new Float32Array(this.outAnalyserL.fftSize);
    this.outBufL = new Float32Array(this.outAnalyserL.fftSize);
    this.outBufR = new Float32Array(this.outAnalyserR.fftSize);
    this.ksBufL = new Float32Array(this.ksAnalyserL.fftSize);
    this.ksBufR = new Float32Array(this.ksAnalyserR.fftSize);
    this.ksBufInL = new Float32Array(this.inKsAnalyserL.fftSize);
    this.ksBufInR = new Float32Array(this.inKsAnalyserR.fftSize);
    this.specBufPre = new Uint8Array(this.preSpec.frequencyBinCount);
    this.specBufPost = new Uint8Array(this.postSpec.frequencyBinCount);
    this.graphReady = true;
  }

  /* ── parameter application ────────────────────────────────────────────── */

  apply(params: ProcessorParams) {
    this.params = params;
    const ctx = this.ctx;
    if (!ctx || !this.graphReady) return; // applied on powerOn

    this.ramp(this.inputGain.gain, dbToGain(params.inputGainDb));

    // HPF: 12/24/36/48 dB/oct as 1–4 Butterworth sections in cascade.
    // Sections beyond the selected slope go allpass (unity magnitude) so the
    // chain topology is fixed and only the slope's shape changes.
    const hpfQs = hpfSectionQs(params.hpf.slope);
    this.hpfStages.forEach((stage, i) => {
      const active = params.hpf.on && i < hpfQs.length;
      stage.type = active ? "highpass" : "allpass";
      this.ramp(stage.frequency, params.hpf.freqHz);
      this.ramp(stage.Q, hpfQs[i] ?? 0.7071);
    });

    // phase rotator: auto = fixed voice window, manual = user frequency;
    // the cascade is retuned as a whole and bypassed as a whole
    const phaseBase = params.phase.mode === "auto" ? 300 : params.phase.freqHz;
    phaseStageFrequencies(phaseBase).forEach((hz, i) => {
      this.ramp(this.phaseStages[i]?.frequency, hz);
    });
    this.crossfade(this.phaseWet, this.phaseDry, params.phase.on);
    // silence-gate bypass
    if (!params.gate.on) {
      this.gateCloseAt = 0;
      if (!this.gateOpen) {
        this.gateOpen = true;
        this.ramp(this.gateGain.gain, 1, 0.02);
      }
    }

    params.eq.bands.forEach((band, i) => {
      const f = this.eqFilters[i];
      if (!f) return;
      // Per-band bypass keeps the band's settings: it just leaves the
      // cascade as an allpass section, which is magnitude-neutral.
      f.type = eqBandOn(band) ? band.type : "allpass";
      this.ramp(f.gain, band.gainDb);
      this.ramp(f.frequency, band.freq);
      this.ramp(f.Q, Math.max(band.q, 0.01));
    });
    this.crossfade(this.eqWetPre, this.eqDry, params.eq.on);

    params.multiband.splitsHz.forEach((hz, split) => {
      for (const f of this.mbSplitFilters[split] ?? []) this.ramp(f.frequency, hz);
    });
    // Less–More macro: one setting scales every band's ratio and envelope.
    // 5 is the preset's own tuning, so the loaded preset is heard as designed
    // until the operator moves the macro.
    const dens = densityProfile(params.density);
    params.multiband.bands.forEach((band, i) => {
      const comp = this.mbComps[i];
      const makeup = this.mbMakeups[i];
      if (!comp || !makeup) return;
      this.ramp(comp.threshold, band.thresholdDb);
      this.ramp(comp.ratio, Math.min(20, Math.max(1, band.ratio * dens.ratioScale)));
      this.ramp(
        comp.attack,
        (Math.max(band.attackMs, 0) * dens.timeScale * (this.speechFast ? 0.5 : 1)) / 1000,
      );
      this.ramp(
        comp.release,
        (Math.max(band.releaseMs, 10) * dens.timeScale * (this.speechFast ? 0.5 : 1)) / 1000,
      );
      this.ramp(makeup.gain, dbToGain(band.makeupDb));
    });
    this.crossfade(this.mbWetPre, this.mbDry, params.multiband.on);

    // dynamic EQ: ramp band + detector filters; force α → 0 when bypassed
    params.deq.bands.forEach((band, i) => {
      const det = this.deqDets[i];
      const sub = this.deqSubs[i];
      if (!det || !sub) return;
      this.ramp(this.deqBpAudio[i]?.frequency, band.freqHz);
      this.ramp(this.deqBpDet[i]?.frequency, band.freqHz);
      this.ramp(this.deqBpAudio[i]?.Q, Math.max(band.q, 0.05));
      this.ramp(this.deqBpDet[i]?.Q, Math.max(band.q, 0.05));
      this.ramp(det.threshold, band.thresholdDb);
      this.ramp(det.attack, Math.max(band.attackMs, 1) / 1000);
      this.ramp(det.release, Math.max(band.releaseMs, 20) / 1000);
      if (!params.deq.on) {
        this.ramp(sub.gain, 0, 0.01);
        this.deqCutDb[i] = 0;
      }
    });

    // auto-speech profile: halve the levelling envelopes while mic
    // programme is present (engagement is transition-detected in the meter
    // loop below, so these ramps glide instead of jumping)
    const spd = this.speechFast ? 0.5 : 1;
    // Dual-window AGC: the fast peak window rides ahead of the slow
    // leveller and has its own threshold, so it acts only on the transients
    // the long release would let through.
    const fast = agcFast(params.agc);
    const fastOn = params.agc.on && fast.on;
    this.ramp(this.agcFastComp.threshold, fastOn ? fast.thresholdDb : 0);
    this.ramp(this.agcFastComp.ratio, fastOn ? Math.min(20, Math.max(1, fast.ratio)) : 1);
    this.ramp(this.agcFastComp.knee, fastOn ? Math.max(0, fast.kneeDb) : 0);
    this.ramp(
      this.agcFastComp.attack,
      (Math.max(fast.attackMs, 0.1) * spd) / 1000,
    );
    this.ramp(
      this.agcFastComp.release,
      (Math.max(fast.releaseMs, 20) * spd) / 1000,
    );

    this.ramp(this.agcComp.threshold, params.agc.thresholdDb);
    this.ramp(this.agcComp.ratio, params.agc.ratio);
    this.ramp(this.agcComp.knee, params.agc.kneeDb);
    this.ramp(this.agcComp.attack, (Math.max(params.agc.attackMs, 0) * spd) / 1000);
    this.ramp(this.agcComp.release, (Math.max(params.agc.releaseMs, 10) * spd) / 1000);
    this.ramp(this.agcMakeup.gain, dbToGain(params.agc.makeupDb));
    this.crossfade(this.agcWetPre, this.agcDry, params.agc.on);
    this.windowGate.configure({ windowDb: params.agc.windowDb });
    if (!params.agc.on || params.agc.windowDb <= 0) {
      this.agcFrozen = false;
      this.agcSpreadDb = 0;
      this.ramp(this.agcHold.gain, 0, 0.02);
      this.ramp(this.agcWetOut.gain, 1, 0.02);
    }

    // de-esser: retune the band and detector; a bypass closes the cut
    const deessHz = clampDeessFreq(params.deess.freqHz);
    this.ramp(this.deessBpAudio?.frequency, deessHz);
    this.ramp(this.deessBpDet?.frequency, deessHz);
    this.ramp(this.deessDet?.threshold, params.deess.thresholdDb);
    this.ramp(
      this.deessDet?.attack,
      Math.max(params.deess.attackMs, 0.1) / 1000,
    );
    this.ramp(
      this.deessDet?.release,
      Math.max(params.deess.releaseMs, 10) / 1000,
    );
    if (!params.deess.on) {
      this.deessCutDb = 0;
      this.ramp(this.deessSub?.gain, 0, 0.01);
    }

    // density drives the limiter from the front; the ceiling is untouched
    this.ramp(
      this.limDrive?.gain,
      params.limiter.on ? dbToGain(dens.driveDb) : 1,
    );
    this.ramp(this.limComp.threshold, params.limiter.ceilingDb);
    this.ramp(this.limComp.attack, Math.max(params.limiter.attackMs, 0.1) / 1000);
    this.ramp(this.limComp.release, Math.max(params.limiter.releaseMs, 10) / 1000);
    this.crossfade(this.limWetPre, this.limDry, params.limiter.on);

    // Soft clipper: rebuilds its curve only when the threshold moves, then
    // blends wet/dry by the mix control. Bypassed (dry only) by default.
    const clip = limiterClipper(params.limiter);
    if (clip.thresholdDb !== this.clipThresholdDb) {
      this.rebuildClipCurve(clip.thresholdDb);
    }
    const clipMix = Math.min(1, Math.max(0, clip.mix / 100));
    const clipOn = params.limiter.on && clip.on;
    this.ramp(this.clipWet.gain, clipOn ? clipMix : 0, 0.02);
    this.ramp(this.clipDry.gain, clipOn ? 1 - clipMix : 1, 0.02);

    // composite ceiling guard follows the limiter ceiling
    if (params.limiter.ceilingDb !== this.guardCeilingDb) {
      this.rebuildGuardCurve(params.limiter.ceilingDb);
    }
    this.crossfade(this.guardWet, this.guardDry, params.limiter.on);

    // harmonic exciter
    this.ramp(this.exBp1?.frequency, params.exciter.freqHz);
    this.ramp(this.exBp2?.frequency, params.exciter.freqHz * 1.7);
    this.ramp(
      this.exMix?.gain,
      params.exciter.on ? (params.exciter.mix / 100) * 0.5 : 0,
    );

    // stereo width: engage the M/S matrix only away from unity so the dry
    // path (exact for mono sources) stays in circuit at width = 1
    const widen = Math.abs(params.stereo.width - 1) > 0.01;
    this.ramp(this.widthGain?.gain, params.stereo.width);
    this.crossfade(this.widthWet, this.widthDry, widen);
    // low-end mono: 0 = off, otherwise fold side-bass below the crossover
    const lm = Math.min(500, Math.max(0, params.stereo.lowMonoHz ?? 120));
    if (this.sideLp) this.sideLp.frequency.setTargetAtTime(Math.max(40, lm || 120), ctx.currentTime, 0.01);
    this.crossfade(this.sideWet, this.sideDry, lm > 0);

    this.ramp(this.outputGain.gain, dbToGain(params.outputGainDb));
    this.ramp(this.monitorGain.gain, dbToGain(params.monitorDb));

    // ── v3.0 psychoacoustic layer ──
    // latency profile: low drops the ceiling guard to 2× oversampling;
    // balanced and max both run the full 4× path (max additionally hosts
    // staged oversampled modules as they land).
    this.setLowLatency(params.psy.latency === "low");
    // perceptual tilt: slope = treble-minus-bass pivot 1 kHz, split evenly
    // across the two shelves. Off / 0 dB = exact unity.
    const slope = params.psy.tilt.on ? params.psy.tilt.slopeDb : 0;
    this.ramp(this.tiltLo?.gain, -slope / 2, 0.03);
    this.ramp(this.tiltHi?.gain, slope / 2, 0.03);
    // every other psy module is STORED (parameter-complete, no DSP yet):
    // engaged or not, the graph above is the whole audible path.
  }

  /** Low-latency profile: lighter 2× oversampling on the ceiling guard. */
  setLowLatency(low: boolean) {
    this.lowLatency = low;
    if (this.guardShaper) this.guardShaper.oversample = low ? "2x" : "4x";
  }

  private crossfade(wet: GainNode, dry: GainNode, on: boolean) {
    if (!wet || !dry) return; // teardown race: nodes not (or no longer) built
    this.ramp(wet.gain, on ? 1 : 0, 0.015);
    this.ramp(dry.gain, on ? 0 : 1, 0.015);
  }

  /** Per-sample soft-clip curve that enforces the composite ceiling. */
  /**
   * Soft-clip transfer for the pre-limiter stage: linear below 72 % of the
   * threshold, then a tanh knee that asymptotes at the threshold itself, so
   * the stage can shave a decibel of transient without a brickwall edge.
   */
  private rebuildClipCurve(thresholdDb: number) {
    if (!this.clipShaper) return;
    const t = Math.min(0.999, Math.max(0.05, dbToGain(thresholdDb)));
    const knee = 0.72;
    const n = 4097;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = -1 + (2 * i) / (n - 1);
      const u = Math.abs(x) / t;
      curve[i] =
        u <= knee
          ? x
          : Math.sign(x) *
            t *
            (knee + (1 - knee) * Math.tanh((u - knee) / (1 - knee)));
    }
    this.clipShaper.curve = curve;
    this.clipThresholdDb = thresholdDb;
  }

  private rebuildGuardCurve(ceilingDb: number) {
    if (!this.guardShaper) return;
    const ceil = Math.min(1, dbToGain(ceilingDb));
    const n = 8193;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = -1 + (2 * i) / (n - 1);
      curve[i] = ceil * Math.tanh(x / ceil);
    }
    this.guardShaper.curve = curve;
    this.guardCeilingDb = ceilingDb;
  }

  setMonitorDb(db: number) {
    this.ramp(this.monitorGain.gain, dbToGain(db));
  }

  setMonitorMuted(muted: boolean) {
    this.ramp(this.monitorGain.gain, muted ? 0 : dbToGain(this.params?.monitorDb ?? -6));
  }

  /**
   * Reference-match trim on the monitor path (Source compare A/B).
   * Raises/lowers the bypassed source so it plays at the processed chain's
   * loudness — the ear compares tone, not level. Clamped to ±12 dB and
   * glided (τ ≈ 0.25 s) so live tracking never clicks. The encoder send taps
   * duckGain upstream, so the stream/record feed is never touched.
   */
  setCompareMatchDb(db: number) {
    if (!this.ctx) return;
    const clamped = Math.min(12, Math.max(-12, Number.isFinite(db) ? db : 0));
    const p = this.matchGain.gain;
    const now = this.ctx.currentTime;
    p.cancelScheduledValues(now);
    p.setTargetAtTime(dbToGain(clamped), now, 0.25);
  }

  /** Momentary duck of the program bus (talk-over). */
  duck() {
    if (!this.ctx || !this.params) return;
    const now = this.ctx.currentTime;
    const target = dbToGain(-Math.abs(this.params.duckDb));
    this.duckGain.gain.cancelScheduledValues(now);
    this.duckGain.gain.setTargetAtTime(target, now, 0.01);
    this.duckGain.gain.setTargetAtTime(1, now + 0.45, 0.08);
  }

  /* ── sources ──────────────────────────────────────────────────────────── */

  /**
   * Switch inputs behind a short fade. Cutting the old source while it is
   * still at programme level is a click; the input bus is faded out, rebuilt,
   * and faded back in 20 ms later.
   */
  setSource(kind: SourceKind) {
    if (!this.ctx) {
      this.sourceKind = kind;
      this.saveDevicePrefs();
      this.notify();
      return;
    }
    const ctx = this.ctx;
    const token = ++this.sourceToken;
    const gain = this.sourceBus.gain;
    const now = ctx.currentTime;
    gain.cancelScheduledValues(now);
    gain.setTargetAtTime(0, now, 0.004);
    window.setTimeout(() => {
      if (this.sourceToken !== token || !this.powered) return;
      this.sourceKind = kind;
      this.saveDevicePrefs();
      this.stopSignal();
      this.pauseFile();
      if (kind === "signal") void this.startSignal();
      if (kind === "mic") void this.armMic();
      if (kind === "file" && this.fileBuffer) this.playFile();
      const t = ctx.currentTime;
      gain.cancelScheduledValues(t);
      gain.setTargetAtTime(1, t, 0.006);
      this.notify();
    }, 20);
  }

  private async startSignal() {
    if (!this.ctx) return;
    this.stopSignal();
    const ctx = this.ctx;
    const gain = ctx.createGain();
    gain.gain.value = 1;
    gain.connect(this.sourceBus);
    this.signalGain = gain;

    if (this.signalMode === "tone") {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = 1000;
      const amp = ctx.createGain();
      amp.gain.value = dbToGain(-18); // −18 dBFS reference tone
      osc.connect(amp);
      amp.connect(gain);
      osc.start();
      this.signalOsc = osc;
    } else {
      // looped stereo pink noise at −18 dBFS RMS — exercises every band
      const buf = ctx.createBuffer(2, ctx.sampleRate * 6, ctx.sampleRate);
      for (let ch = 0; ch < 2; ch++) {
        const data = buf.getChannelData(ch);
        let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
          const white = Math.random() * 2 - 1;
          b0 = 0.99886 * b0 + white * 0.0555179;
          b1 = 0.99332 * b1 + white * 0.0750759;
          b2 = 0.969 * b2 + white * 0.153852;
          b3 = 0.8665 * b3 + white * 0.3104856;
          b4 = 0.55 * b4 + white * 0.5329522;
          b5 = -0.7616 * b5 - white * 0.016898;
          const pink = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362;
          b6 = white * 0.115926;
          data[i] = pink * 0.11;
          sum += data[i] * data[i];
        }
        const rms = Math.sqrt(sum / data.length) || 1;
        const scale = dbToGain(-18) / rms;
        for (let i = 0; i < data.length; i++) data[i] *= scale;
      }
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      src.connect(gain);
      src.start();
      this.signalOsc = src;
    }
  }

  private stopSignal() {
    try {
      this.signalOsc?.stop();
    } catch {
      /* already stopped */
    }
    this.signalOsc?.disconnect();
    this.signalOsc = null;
    this.signalGain?.disconnect();
    this.signalGain = null;
  }

  async setSignalMode(mode: SignalMode) {
    this.signalMode = mode;
    if (this.ctx && this.sourceKind === "signal") await this.startSignal();
    this.notify();
  }

  /** Silence the built-in program stream (test generator) without leaving it. */
  stopSignalSource() {
    this.stopSignal();
    this.notify();
  }

  /** Whether the built-in program stream is currently sounding. */
  get generatorOn(): boolean {
    return this.signalOsc !== null;
  }

  /* ── physical I/O devices ─────────────────────────────────────────────── */

  /**
   * List the OS input/output devices. Labels stay blank until mic permission
   * is granted (browser privacy rule), so entries fall back to numbered
   * names and the list refreshes itself after every successful arm.
   */
  async refreshDevices(): Promise<void> {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      let n = 0;
      this.inputDevices = all
        .filter((d) => d.kind === "audioinput")
        .map((d) => ({ id: d.deviceId, label: d.label || `Input ${++n}` }));
      n = 0;
      this.outputDevices = all
        .filter((d) => d.kind === "audiooutput")
        .map((d) => ({ id: d.deviceId, label: d.label || `Output ${++n}` }));
      if (
        this.inputDeviceId &&
        !this.inputDevices.some((d) => d.id === this.inputDeviceId)
      ) {
        this.inputDeviceId = "";
      }
      if (
        this.outputDeviceId &&
        !this.outputDevices.some((d) => d.id === this.outputDeviceId)
      ) {
        this.outputDeviceId = "";
      }
    } catch {
      /* media devices unavailable — keep whatever was listed */
    }
    this.notify();
  }

  /** Enumerate once + follow plug/unplug while the app runs. */
  private watchDevices() {
    void this.refreshDevices();
    if (this.deviceWatching) return;
    try {
      navigator.mediaDevices.addEventListener("devicechange", this.onDeviceChange);
      this.deviceWatching = true;
    } catch {
      /* older runtimes without devicechange — manual refresh still works */
    }
  }

  private onDeviceChange = () => {
    void this.refreshDevices();
  };

  /** Switch inputs; re-arms live so the new device takes over immediately. */
  setInputDevice(id: string) {
    this.inputDeviceId = id;
    this.saveDevicePrefs();
    if (this.micStatus === "on") {
      this.disarmMic();
      void this.armMic();
    } else {
      this.notify();
    }
  }

  /** Route the monitor bus to the chosen speakers/headphones. */
  setOutputDevice(id: string) {
    this.outputDeviceId = id;
    this.saveDevicePrefs();
    void this.applyOutputDevice();
    this.notify();
  }

  /**
   * Push the chosen sink into the AudioContext. setSinkId post-dates the TS
   * lib.dom in this tree, hence the structural type; Chromium (and the
   * Electron shell) has shipped it since v110. "" = OS default.
   */
  private async applyOutputDevice(): Promise<void> {
    const ctx = this.ctx as (AudioContext & {
      setSinkId?: (sinkId: string) => Promise<void>;
    }) | null;
    if (!ctx || typeof ctx.setSinkId !== "function") return;
    try {
      await ctx.setSinkId(this.outputDeviceId);
    } catch {
      /* unknown device (unplugged?) — stays on the current sink */
    }
  }

  async armMic(): Promise<void> {
    if (!this.ctx) return;
    if (this.micStatus === "on" || this.micStatus === "arming") return;
    this.micStatus = "arming";
    this.notify();
    const base = {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 2,
    };
    const wanted = this.inputDeviceId;
    try {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: wanted ? { ...base, deviceId: { exact: wanted } } : base,
        });
      } catch {
        // Chosen device gone (unplugged?) — fall back to the OS default
        // rather than leaving the operator with a dead input.
        this.inputDeviceId = "";
        stream = await navigator.mediaDevices.getUserMedia({ audio: base });
      }
      this.micStream = stream;
      const track = stream.getAudioTracks()[0];
      this.micLabel = track?.label ?? "Microphone";
      this.micNode = this.ctx.createMediaStreamSource(stream);
      this.micNode.connect(this.sourceBus);
      this.micStatus = "on";
      // Permission granted → real device labels are visible now.
      void this.refreshDevices();
    } catch {
      this.micStatus = "error";
    }
    this.notify();
  }

  disarmMic() {
    this.micNode?.disconnect();
    this.micNode = null;
    this.micStream?.getTracks().forEach((t) => t.stop());
    this.micStream = null;
    this.micStatus = "idle";
    this.micLabel = "";
  }

  /* ── file transport ───────────────────────────────────────────────────── */

  async loadFile(file: File): Promise<void> {
    if (!this.ctx) await this.powerOn();
    const ctx = this.ctx;
    if (!ctx) return;
    const arrayBuf = await file.arrayBuffer();
    const buffer = await ctx.decodeAudioData(arrayBuf.slice(0));
    this.stopFile();
    this.fileBuffer = buffer;
    this.fileName = file.name;
    this.fileOffset = 0;
    this.filePeaks = computePeaks(buffer, 1600);
    if (this.sourceKind === "file") this.playFile();
    this.notify();
  }

  playFile() {
    const ctx = this.ctx;
    const buffer = this.fileBuffer;
    if (!ctx || !buffer || this.filePlaying) return;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.sourceBus);
    const offset = Math.min(this.fileOffset, Math.max(buffer.duration - 0.01, 0));
    src.start(0, offset);
    src.onended = () => {
      if (this.fileSource === src) {
        this.filePlaying = false;
        this.fileOffset = 0;
        this.fileSource = null;
        this.notify();
      }
    };
    this.fileSource = src;
    this.fileStartedAt = ctx.currentTime - offset;
    this.filePlaying = true;
    this.notify();
  }

  pauseFile() {
    if (!this.filePlaying || !this.ctx || !this.fileSource) return;
    this.fileOffset = Math.min(
      this.ctx.currentTime - this.fileStartedAt,
      this.fileBuffer?.duration ?? 0,
    );
    this.fileSource.onended = null;
    try {
      this.fileSource.stop();
    } catch {
      /* noop */
    }
    this.fileSource.disconnect();
    this.fileSource = null;
    this.filePlaying = false;
    this.notify();
  }

  stopFile() {
    this.pauseFile();
    this.fileOffset = 0;
  }

  seekFile(seconds: number) {
    if (!this.fileBuffer) return;
    const clamped = Math.max(0, Math.min(seconds, this.fileBuffer.duration));
    if (this.filePlaying) {
      this.pauseFile();
      this.fileOffset = clamped;
      this.playFile();
    } else {
      this.fileOffset = clamped;
    }
    this.notify();
  }

  get fileDuration(): number {
    return this.fileBuffer?.duration ?? 0;
  }

  get filePosition(): number {
    if (!this.fileBuffer) return 0;
    if (!this.filePlaying || !this.ctx) return this.fileOffset;
    return Math.min(this.ctx.currentTime - this.fileStartedAt, this.fileBuffer.duration);
  }

  /* ── metering ─────────────────────────────────────────────────────────── */

  private startMeterLoop() {
    if (this.raf) return;
    const loop = () => {
      this.computeMeters();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  private cancelMeterLoop() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private meanSquare(analyser: AnalyserNode, buf: Float32Array<ArrayBuffer>): number {
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    return sum / buf.length;
  }

  /** Inter-sample peak estimate via4× linear upsampling (dBTP-ish). */
  private truePeak(buf: Float32Array<ArrayBuffer>): number {
    let max = 0;
    for (let i = 1; i < buf.length; i++) {
      const a = Math.abs(buf[i - 1]);
      const b = Math.abs(buf[i]);
      if (a > max) max = a;
      if (b > max) max = b;
      // check3interior interpolated points between samples
      for (let k = 1; k <= 3; k++) {
        const v = a + ((b - a) * k) / 4;
        if (v > max) max = v;
      }
    }
    return toDb(max);
  }

  private computeMeters() {
    const ctx = this.ctx;
    if (!ctx || !this.powered || !this.graphReady) return;
    const t0 = performance.now();
    // adaptive stability: if metering starts costing real main-thread time,
    // halve its rate instead of competing with the UI
    this.meterTick += 1;
    if (this.frameCostMs > 4 && this.meterTick % 2 === 1) {
      this.snapshotValue = {
        ...this.snapshotValue,
        perf: {
          ...this.snapshotValue.perf,
          frameMs: this.frameCostMs,
          throttled: true,
        },
      };
      return;
    }
    const now = performance.now();
    const grOf = (comp: DynamicsCompressorNode | undefined): number =>
      Math.max(0, -(comp?.reduction ?? 0));
    const agcOn = this.params?.agc.on ?? false;

    // dynamic-EQ cut follows the detector envelopes (control rate ≈ rAF)
    if (this.params?.deq.on) {
      this.params.deq.bands.forEach((band, i) => {
        const det = this.deqDets[i];
        const sub = this.deqSubs[i];
        if (!det || !sub) return;
        const over = Math.max(0, -(det.reduction || 0));
        const cut = Math.min(band.maxCutDb, over);
        this.deqCutDb[i] = cut;
        // subtracting α of the band ≈ a cut of −20·log10(1−α) at its centre
        const alpha = 1 - Math.pow(10, -cut / 20);
        this.ramp(sub.gain, alpha, 0.008);
      });
    }

    // audio-clock health: ctx.currentTime vs wall time — sustained negative
    // drift means the audio thread missed deadlines (glitches / bufferbloat)
    if (this.clockRefWall === 0) {
      this.clockRefWall = now;
      this.clockRefCtx = ctx.currentTime;
    } else if (now - this.clockRefWall >= 1000) {
      const drift =
        (ctx.currentTime - this.clockRefCtx - (now - this.clockRefWall) / 1000) *
        1000;
      this.driftMs =
        this.driftMs === 0 ? drift : this.driftMs * 0.7 + drift * 0.3;
      this.glitch.update(this.driftMs, now);
      this.clockRefWall = now;
      this.clockRefCtx = ctx.currentTime;
    }

    // input peaks
    this.inAnalyserL.getFloatTimeDomainData(this.timeBuf);
    let inL = 0;
    for (let i = 0; i < this.timeBuf.length; i++) {
      const v = Math.abs(this.timeBuf[i]);
      if (v > inL) inL = v;
    }
    this.inAnalyserR.getFloatTimeDomainData(this.timeBuf);
    let inR = 0;
    for (let i = 0; i < this.timeBuf.length; i++) {
      const v = Math.abs(this.timeBuf[i]);
      if (v > inR) inR = v;
    }
    const inPeakL = toDb(inL);
    const inPeakR = toDb(inR);
    if (Math.max(inPeakL, inPeakR) > -0.2) this.clipInUntil = now + 600;

    // input-stage silence gate — detected pre-gate on the raw source bus so
    // a closed gate still hears the program come back
    // Raw programme level, measured ahead of the gate and always — this is the
    // value the dead-air detector and the failover state machine act on.
    this.gateAnalyser.getFloatTimeDomainData(this.gateBuf);
    let srcPeak = 0;
    for (let i = 0; i < this.gateBuf.length; i++) {
      const v = Math.abs(this.gateBuf[i]);
      if (v > srcPeak) srcPeak = v;
    }
    const srcLevelDb = toDb(srcPeak);

    const gate = this.params?.gate;
    let gateWantOpen = true;
    if (gate?.on) {
      if (srcLevelDb >= gate.thresholdDb) {
        this.gateCloseAt = 0;
      } else {
        if (this.gateCloseAt === 0) this.gateCloseAt = now + gate.holdMs;
        else gateWantOpen = now < this.gateCloseAt;
      }
    } else {
      this.gateCloseAt = 0;
    }
    if (gateWantOpen !== this.gateOpen) {
      this.gateOpen = gateWantOpen;
      this.ramp(
        this.gateGain.gain,
        gateWantOpen ? 1 : 0,
        gateWantOpen ? 0.03 : 0.05,
      );
    }

    // ── AGC window gate: hold the leveller while the programme is steady ──
    if (this.params?.agc.on && this.params.agc.windowDb > 0) {
      const reading = this.windowGate.update(srcLevelDb, now);
      this.agcSpreadDb = reading.spreadDb;
      this.agcFrozen = reading.frozen;
      if (reading.frozen) {
        // leave the hold gain where the last unfrozen tick put it: that is
        // the freeze. The compressor keeps running, muted, so the release is
        // just a crossfade back to wherever it has since travelled.
        this.ramp(this.agcWetOut.gain, 0, 0.02);
      } else {
        const reduction = this.agcComp.reduction ?? 0;
        this.agcHoldGainDb = this.params.agc.makeupDb + reduction;
        this.ramp(this.agcHold.gain, dbToGain(this.agcHoldGainDb), 0.02);
        this.ramp(this.agcWetOut.gain, 1, 0.02);
      }
    } else if (this.agcFrozen) {
      this.agcFrozen = false;
      this.agcSpreadDb = 0;
      this.windowGate.reset();
      this.ramp(this.agcHold.gain, 0, 0.02);
      this.ramp(this.agcWetOut.gain, 1, 0.02);
    }

    // ── de-esser: control-rate cut over the sibilance band ──
    if (this.params?.deess.on && this.deessDet) {
      const over = Math.max(0, -(this.deessDet.reduction || 0));
      const cut = Math.min(this.params.deess.maxCutDb, over);
      this.deessCutDb = cut;
      this.ramp(this.deessSub.gain, deessAlpha(cut), 0.006);
    } else if (this.deessCutDb !== 0) {
      this.deessCutDb = 0;
      this.ramp(this.deessSub?.gain, 0, 0.01);
    }

    // output peaks + true peak + correlation
    this.outAnalyserL.getFloatTimeDomainData(this.outBufL);
    this.outAnalyserR.getFloatTimeDomainData(this.outBufR);
    let outL = 0;
    let outR = 0;
    let dot = 0;
    let eL = 0;
    let eR = 0;
    for (let i = 0; i < this.outBufL.length; i++) {
      const l = this.outBufL[i];
      const r = this.outBufR[i];
      const al = Math.abs(l);
      const ar = Math.abs(r);
      if (al > outL) outL = al;
      if (ar > outR) outR = ar;
      dot += l * r;
      eL += l * l;
      eR += r * r;
    }
    const outPeakL = toDb(outL);
    const outPeakR = toDb(outR);
    const tp = Math.max(
      this.truePeak(this.outBufL),
      this.truePeak(this.outBufR),
    );
    const clipping = Math.max(outPeakL, outPeakR) > -0.2;
    // rising-edge counter + timestamp: the clip-event detector behind the
    // restoration panel (detection is measured; reconstruction stays stored)
    if (clipping && !(now < this.clipOutUntil)) {
      this.clipEvents += 1;
      this.clipAt = Date.now();
    }
    if (clipping) this.clipOutUntil = now + 600;
    const denom = Math.sqrt(eL * eR);
    const correlation = denom > 1e-9 ? Math.max(-1, Math.min(1, dot / denom)) : 1;

    // K-weighted loudness (BS.1770-4, no gating — momentary/short-term)
    const msL = this.meanSquare(this.ksAnalyserL, this.ksBufL);
    const msR = this.meanSquare(this.ksAnalyserR, this.ksBufR);
    const sum = msL + msR;
    const loudness = sum > 1e-12 ? -0.691 + 10 * Math.log10(sum) : -70;
    const msInL = this.meanSquare(this.inKsAnalyserL, this.ksBufInL);
    const msInR = this.meanSquare(this.inKsAnalyserR, this.ksBufInR);
    const sumIn = msInL + msInR;
    const lufsIn = sumIn > 1e-12 ? -0.691 + 10 * Math.log10(sumIn) : -70;
    this.lufsPoints.push({ t: now, ms: sum });
    while (this.lufsPoints.length > 2 && now - this.lufsPoints[0].t > 3200) {
      this.lufsPoints.shift();
    }
    const windowPower = (winMs: number) => {
      let acc = 0;
      let n = 0;
      for (const p of this.lufsPoints) {
        if (now - p.t <= winMs) {
          acc += p.ms;
          n++;
        }
      }
      return n > 0 ? acc / n : 0;
    };
    const windowLufs = (winMs: number) => {
      const v = windowPower(winMs);
      return v > 1e-12 ? -0.691 + 10 * Math.log10(v) : -70;
    };

    // ── integrated loudness + LRA measurement (real, gated per spec) ──
    if (this.lastMeasureT > 0) this.measureMsAcc += now - this.lastMeasureT;
    this.lastMeasureT = now;
    if (now - this.lastIBlockAt >= 100) {
      this.lastIBlockAt = now;
      this.iBlocks.push(windowPower(400));
      if (this.iBlocks.length > 90_000) this.iBlocks.shift();
      this.lufsIValue = this.gatedIntegrated(this.iBlocks, this.measureMsAcc);
    }
    if (now - this.lastStBlockAt >= 1000) {
      this.lastStBlockAt = now;
      this.stBlocks.push(windowPower(3000));
      if (this.stBlocks.length > 12_000) this.stBlocks.shift();
      this.lraValue = this.loudnessRange(this.stBlocks);
    }
    if (outPeakL > this.samplePeakDb) this.samplePeakDb = outPeakL;
    if (outPeakR > this.samplePeakDb) this.samplePeakDb = outPeakR;

    // ── loudness rider (Compellor leveler / AERO long-term controller) ──
    if (this.params?.rider.on) {
      // silence gate (Compellor DVG style): never ride noise up in pauses
      if (windowLufs(300) > this.params.rider.gateDb) {
        const err = this.params.rider.targetLufs - windowLufs(1000);
        const cap = Math.abs(this.params.rider.maxRideDb);
        const ride = Math.max(-cap, Math.min(cap, err));
        const fast = this.params.rider.speed === "fast";
        // Compellor fast leveler ≈ 1.5 s down / 3 s up (setTarget ≈ ×⅓)
        const tc = ride < 0 ? (fast ? 0.5 : 1.7) : fast ? 1.0 : 3.3;
        this.ramp(this.riderGain.gain, dbToGain(ride), tc);
        this.riderDb = ride;
      }
    } else {
      this.riderDb = 0;
      this.ramp(this.riderGain.gain, 1, 0.05);
    };

    // auto-speech sensing: mic programme present while the sense flag is
    // armed → halve the levelling envelopes with a full (ramped) re-apply
    const wantSpeech =
      !!this.params?.agc.speechSense &&
      this.sourceKind === "mic" &&
      srcLevelDb > -50;
    if (wantSpeech !== this.speechFast) {
      this.speechFast = wantSpeech;
      if (this.params) this.apply(this.params);
    }

    this.snapshotValue = {
      t: now,
      powered: true,
      inPeakL,
      inPeakR,
      outPeakL,
      outPeakR,
      truePeak: tp,
      lufsM: loudness > -70 ? loudness : -70,
      lufsS: windowLufs(3000),
      lufsIn: Math.max(-70, lufsIn),
      lufsI: this.lufsIValue,
      lra: this.lraValue,
      measureMs: this.measureMsAcc,
      samplePeakDb: this.samplePeakDb,
      correlation,
      gr: {
        bands: this.mbComps.map(grOf),
        deq: this.deqCutDb.slice(),
        // Bypassed AGC reports no reduction, and the fast window's own
        // reduction is exposed separately so the two windows can be told
        // apart on the meters.
        agc: agcOn ? grOf(this.agcComp) + grOf(this.agcFastComp) : 0,
        agcFast: agcOn ? grOf(this.agcFastComp) : 0,
        limiter: grOf(this.limComp),
      },
      agcWindow: { frozen: this.agcFrozen, spreadDb: this.agcSpreadDb },
      deessCut: this.deessCutDb,
      riderDb: this.riderDb,
      perf: {
        baseLatencyMs: (ctx.baseLatency ?? 0) * 1000,
        outputLatencyMs: (ctx.outputLatency ?? 0) * 1000,
        frameMs: this.frameCostMs,
        driftMs: this.driftMs,
        throttled: this.frameCostMs > 4,
        stalls: this.glitch.stalls,
        glitchAt: this.glitch.lastStallAt,
      },
      clipIn: now < this.clipInUntil,
      clipOut: now < this.clipOutUntil,
      clipEvents: this.clipEvents,
      clipAt: this.clipAt,
      speechFast: this.speechFast,
      srcLevelDb,
      backupActive: this.backupActiveFlag,
    };

    if (++this.frame % 3 === 0) this.notify();
    const cost = performance.now() - t0;
    this.frameCostMs =
      this.frameCostMs === 0 ? cost : this.frameCostMs * 0.85 + cost * 0.15;
  }

  /**
   * Reset the integrated-loudness / LRA / sample-peak measurement window.
   * Called automatically on power-on; exposed for the operator's reset key.
   */
  resetLoudness() {
    this.iBlocks = [];
    this.stBlocks = [];
    this.lufsIValue = null;
    this.lraValue = null;
    this.measureMsAcc = 0;
    this.lastMeasureT = 0;
    this.lastIBlockAt = 0;
    this.lastStBlockAt = 0;
    this.samplePeakDb = -120;
    this.clipEvents = 0;
    this.clipAt = 0;
    this.glitch.reset();
    this.notify();
  }

  /** BS.1770-4 gated integrated loudness from 400 ms block powers. */
  private gatedIntegrated(blocks: number[], measureMs: number): number | null {
    if (measureMs < 20_000 || blocks.length < 50) return null;
    const abs: number[] = [];
    for (const b of blocks) {
      if (b > 1e-12 && -0.691 + 10 * Math.log10(b) >= -70) abs.push(b);
    }
    if (abs.length === 0) return null;
    let sum = 0;
    for (const b of abs) sum += b;
    const meanL = -0.691 + 10 * Math.log10(sum / abs.length);
    const relThreshold = meanL - 10;
    let gsum = 0;
    let gn = 0;
    for (const b of abs) {
      if (-0.691 + 10 * Math.log10(b) >= relThreshold) {
        gsum += b;
        gn++;
      }
    }
    if (gn === 0) return null;
    return -0.691 + 10 * Math.log10(gsum / gn);
  }

  /** EBU Tech 3342 loudness range from short-term (3 s) block powers. */
  private loudnessRange(blocks: number[]): number | null {
    if (blocks.length < 30) return null;
    const vals: number[] = [];
    for (const b of blocks) {
      if (b > 1e-12 && -0.691 + 10 * Math.log10(b) >= -70) vals.push(b);
    }
    if (vals.length < 20) return null;
    let sum = 0;
    for (const b of vals) sum += b;
    const relThreshold = -0.691 + 10 * Math.log10(sum / vals.length) - 20;
    const gated: number[] = [];
    for (const b of vals) {
      const l = -0.691 + 10 * Math.log10(b);
      if (l >= relThreshold) gated.push(l);
    }
    if (gated.length < 10) return null;
    gated.sort((a, b) => a - b);
    const pct = (p: number) => {
      const idx = (gated.length - 1) * p;
      const lo = Math.floor(idx);
      const hi = Math.ceil(idx);
      return gated[lo] + (gated[hi] - gated[lo]) * (idx - lo);
    };
    return Math.max(0, pct(0.95) - pct(0.1));
  }

  /* ── failover (dead-air protection) ───────────────────────────────────── */

  /** Programme level ahead of the gate: dBFS, −120 when the feed is silent. */
  get sourceLevelDb(): number {
    return this.snapshotValue.srcLevelDb;
  }

  get backupLoaded(): boolean {
    return this.backupEl !== null;
  }

  get backupName(): string | null {
    return this.backupLabel;
  }

  get backupActive(): boolean {
    return this.backupActiveFlag;
  }

  /**
   * Load the standby audio. The media element decodes anything the platform
   * supports, loops forever and stays muted until a take-over. Must be called
   * from a user gesture (the file picker) so the later automatic play() is
   * not blocked by the autoplay policy.
   */
  loadBackupFile(file: File) {
    const ctx = this.ctx;
    if (!ctx) return;
    if (this.backupSrc) this.backupSrc.disconnect();
    if (this.backupUrl) URL.revokeObjectURL(this.backupUrl);
    const url = URL.createObjectURL(file);
    const el = new Audio();
    el.loop = true;
    el.preload = "auto";
    el.src = url;
    this.backupEl = el;
    this.backupUrl = url;
    this.backupLabel = file.name;
    this.backupSrc = ctx.createMediaElementSource(el);
    this.backupSrc.connect(this.backupGain);
    void el
      .play()
      .then(() => {
        // primed for the take-over; stay silent until it actually happens
        if (!this.backupActiveFlag) el.pause();
      })
      .catch(() => {
        /* take-over retries play() when it fires */
      });
    this.notify();
  }

  /** Unload the standby source and return the chain to the programme feed. */
  clearBackup() {
    this.setBackupActive(false, 60);
    if (this.backupEl) {
      this.backupEl.pause();
      this.backupEl.removeAttribute("src");
    }
    this.backupSrc?.disconnect();
    this.backupSrc = null;
    this.backupEl = null;
    this.backupLabel = null;
    if (this.backupUrl) URL.revokeObjectURL(this.backupUrl);
    this.backupUrl = null;
    this.notify();
  }

  /** Cross-fade the chain between the programme feed and the standby source. */
  setBackupActive(active: boolean, fadeMs = 200) {
    if (!this.ctx) return;
    const tc = Math.max(0.005, fadeMs / 3000);
    if (active) {
      if (this.backupEl) {
        try {
          this.backupEl.currentTime = 0;
        } catch {
          /* seeking before metadata is fine to skip */
        }
        void this.backupEl.play().catch(() => {});
      }
      this.ramp(this.srcGain.gain, 0, tc);
      this.ramp(this.backupGain.gain, 1, tc);
    } else {
      this.ramp(this.srcGain.gain, 1, tc);
      this.ramp(this.backupGain.gain, 0, tc);
      if (this.backupEl) {
        window.setTimeout(() => {
          if (!this.backupActiveFlag) this.backupEl?.pause();
        }, fadeMs + 400);
      }
    }
    this.backupActiveFlag = active;
    this.notify();
  }

  snapshot(): MeterSnapshot {
    return this.snapshotValue;
  }

  /**
   * Raw post-chain L/R frames for the vector scope. Copies the first N
   * samples of the output analysers (fftSize 4096) — the scope draws L vs
   * R as a Lissajous figure. Empty arrays while the graph is down.
   */
  getScopeFrames(n = 512): { l: Float32Array; r: Float32Array } {
    const N = Math.min(2048, Math.max(64, Math.floor(n)));
    const empty = { l: new Float32Array(0), r: new Float32Array(0) };
    if (!this.ctx || !this.powered) return empty;
    try {
      this.outAnalyserL.getFloatTimeDomainData(this.scopeBufL);
      this.outAnalyserR.getFloatTimeDomainData(this.scopeBufR);
    } catch {
      return empty;
    }
    return {
      l: this.scopeBufL.slice(0, N),
      r: this.scopeBufR.slice(0, N),
    };
  }

  subscribe(cb: (s: MeterSnapshot) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private notify() {
    for (const cb of this.listeners) cb(this.snapshotValue);
  }

  /* ── spectrum access (canvas components read directly, no re-render) ──── */

  getSpectrum(pre: boolean): Uint8Array<ArrayBuffer> | null {
    if (!this.powered) return null;
    if (pre) {
      this.preSpec.getByteFrequencyData(this.specBufPre);
      return this.specBufPre;
    }
    this.postSpec.getByteFrequencyData(this.specBufPost);
    return this.specBufPost;
  }

  get sampleRate(): number {
    return this.ctx?.sampleRate ?? 0;
  }

  /** Last applied params (null until the console applies a chain). */
  get appliedParams(): ProcessorParams | null {
    return this.params;
  }

  get fftSize(): number {
    return this.postSpec?.fftSize ?? 2048;
  }

  getStream(): MediaStream | null {
    return this.streamDest?.stream ?? null;
  }
}

/** Max-abs peak envelope for waveform rendering. */
export function computePeaks(
  buffer: AudioBuffer,
  bins: number,
): Float32Array<ArrayBuffer> {
  const data = buffer.getChannelData(0);
  const block = Math.max(1, Math.floor(data.length / bins));
  const peaks = new Float32Array(bins);
  for (let i = 0; i < bins; i++) {
    let max = 0;
    const start = i * block;
    const end = Math.min(start + block, data.length);
    for (let j = start; j < end; j++) {
      const v = Math.abs(data[j]);
      if (v > max) max = v;
    }
    peaks[i] = max;
  }
  return peaks;
}

let singleton: AudioEngine | null = null;

export function getEngine(): AudioEngine {
  if (!singleton) singleton = new AudioEngine();
  return singleton;
}
