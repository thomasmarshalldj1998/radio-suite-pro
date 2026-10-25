/**
 * Signalpath audio engine.
 *
 * Signal flow:
 *   source (mic | generator | file) → 2-channel program bus
 *     → silence gate → failover crossfade → input trim
 *     → HPF ─┬─ input meters (L/R)
 *            ├─ spectrum (pre)
 *            └─ phase rotator (4-stage allpass cascade)
 *               → 6-band EQ → harmonic exciter (parallel)
 *               → dynamic EQ (5 subtractive bands)
 *               → program AGC (dual-window, window-gated leveller)
 *               → 6-band multiband compressor (LR4)
 *               → loudness rider
 *               → de-esser (dynamic 6–10 kHz cut)
 *               → composite limiter → output gain
 *               → ceiling guard → M/S stereo width → tilt → duck
 *                  ├─ monitor out (chosen speakers, setSinkId)
 *                  ├─ encoder send (MediaStream for Icecast)
 *                  ├─ spectrum (post)
 *                  ├─ sample-peak / true-peak meters (L/R)
 *                  └─ K-weighted loudness (BS.1770, L/R)
 *
 * The module is split by responsibility:
 *   devices.ts  — enumeration, saved picks, loop/virtual-endpoint detection
 *   measure.ts  — peaks, true peak, loudness windows, gating, correlation
 *   engine.ts   — this file: the graph, the sources, the control loop
 *
 * Invariants this file is responsible for:
 *   · exactly one program source feeds the bus at any time;
 *   · the bus is always 2 channels, so a mono interface never leaves the
 *     right meter (or the S-side of the matrix) silent;
 *   · power cycling restores the program source — "running" with a dead
 *     source is the one failure an operator cannot see from the meters;
 *   · every node write goes through one ramp helper, so re-applying an
 *     unchanged chain schedules no automation at all.
 */

import { GlitchMonitor, driftPerSecond } from "./glitch";
import {
  deriveEngineHealth,
  type EngineHealth,
  type HealthFacts,
} from "./health";
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
  limiterEngine,
  limiterProgram,
} from "./params";
import {
  LIMITER_WORKLET_NAME,
  limiterWorkletSource,
} from "./limiter";
import { createSpscRing, type SpscRing } from "./spsc-ring";
import {
  DEVICE_RAMP_MS,
  outputLatencyMs,
  rampTo,
  rampWaitMs,
  waitForRunning,
} from "./declick";
import {
  DEFAULT_ADVANCED,
  agcProfileEnvelope,
  airShelf,
  channelTrim,
  codecLowpassHz,
  dcHighpassHz,
  dimDb,
  mainsNotchHz,
  crestDriveDb,
  gateGainTarget,
  harmonicMix,
  notchQ,
  preEmphCorrection,
  presenceGains,
  riderTargetLufs,
  type AdvancedParams,
} from "./advanced";
import {
  WindowGate,
  autoDeessThresholdDb,
  autoMakeupDb,
  clampDeessFreq,
  coherenceSafety,
  deessAlpha,
  densityProfile,
  dynamicReleaseMs,
  phaseStageFrequencies,
  safeWidth,
} from "./tools";
import { identityCurve, safeFilterHz, softCeilingCurve } from "./quality";
import {
  complianceState,
  complianceTarget,
  loudnessDeviation,
  type ComplianceState,
  type LoudnessLogRow,
} from "./loudness";
import {
  DEVICE_STORE,
  listDevices,
  parsePrefs,
  reconcileSelection,
  serializePrefs,
  isFeedbackLoop,
  isVirtualDevice,
  type AudioDevice,
} from "./devices";
import {
  LoudnessWindow,
  correlationOf,
  gatedIntegrated,
  loudnessOf,
  loudnessRange,
  meanSquare,
  peakDb,
  truePeak as measureTruePeak,
} from "./measure";

export type { AudioDevice } from "./devices";

export type SourceKind = "signal" | "mic" | "file";
export type SignalMode = "tone" | "pink";
export type MicStatus = "idle" | "arming" | "on" | "error";

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
  /** per-band GR (6), dynamic-EQ cut (5), AGC GR, limiter GR */
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
  /** Loudness target in force (LUFS) and the measured deviation from it. */
  loudnessTarget: number;
  loudnessDeviation: number | null;
  /** Compliance verdict against that target (BS.1770 gated integrated). */
  compliance: ComplianceState;
  /** True-peak oversampling factor in use (2 / 4 / 8). */
  truePeakX: number;
  /** latency & render-thread health */
  perf: {
    baseLatencyMs: number;
    outputLatencyMs: number;
    /** Cost of the main-thread measurement pass (not the render thread). */
    frameMs: number;
    /** ms of audio lost per second of wall time (negative = starved). */
    driftMs: number;
    /** False while a drift reading has been rejected as untrustworthy. */
    driftValid: boolean;
    /** Wall interval the last accepted drift reading covered (ms). */
    intervalMs: number;
    /** The meter pass slowed itself down. Never a render-thread fault. */
    throttled: boolean;
    /** Starved render-thread episodes this session. */
    stalls: number;
    /** The clock monitor is inside a stall episode right now. */
    stalled: boolean;
    /** Worst accepted drift this session, ms of audio lost per second. */
    worstDriftMs: number;
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
  /** Peak limiter actually in circuit — the worklet when it loaded, else native. */
  limiterEngine: "native" | "worklet";
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
  gr: { bands: [0, 0, 0, 0, 0, 0], deq: [0, 0, 0, 0, 0], agc: 0, agcFast: 0, limiter: 0 },
  agcWindow: { frozen: false, spreadDb: 0 },
  deessCut: 0,
  riderDb: 0,
  loudnessTarget: -14,
  loudnessDeviation: null,
  compliance: "measuring",
  truePeakX: 4,
  perf: {
    baseLatencyMs: 0,
    outputLatencyMs: 0,
    frameMs: 0,
    driftMs: 0,
    driftValid: false,
    intervalMs: 0,
    throttled: false,
    stalls: 0,
    stalled: false,
    worstDriftMs: 0,
    glitchAt: 0,
  },
  clipIn: false,
  clipOut: false,
  clipEvents: 0,
  clipAt: 0,
  srcLevelDb: -120,
  speechFast: false,
  backupActive: false,
  limiterEngine: "native",
};

/** One heavy measurement pass every N ms (true peak, loudness, blocks). */
const HEAVY_BASE_MS = 40;
/** Tail of the output buffer used for the true-peak estimate. */
const TRUE_PEAK_WINDOW = 1024;
/** Clip indicator hold (ms). */
const CLIP_HOLD_MS = 600;

/**
 * A source switch fades the program bus out, rebuilds the source, and fades
 * back in. Cutting a live feed at programme level is a click on air.
 *
 * DEVICE_RAMP_MS is the fade; this is the wait around it — long enough for
 * the ramp to land *and* for the delay lines and filter histories to drain
 * into that silence before the new device is patched in.
 */
const SOURCE_FADE_MS = 20;

/**
 * How long a newly opened sink gets to settle before programme is let back
 * through. An endpoint that has just opened has no history yet: its first
 * blocks belong to the hardware, not to the programme.
 */
const ENDPOINT_SETTLE_MS = 24;

/**
 * Bound on one sink switch. The monitor is faded for the length of the call,
 * so a call that never settles (a permission prompt the frame will not show,
 * an endpoint the OS is still waking) must not leave the console silent with
 * its meters still live. Past this the switch is treated as unattempted and
 * retried by the next device event.
 */
const SINK_SWITCH_TIMEOUT_MS = 1500;

const stopStream = (stream: MediaStream) => {
  for (const track of stream.getTracks()) track.stop();
};

const waitMs = (ms: number) =>
  new Promise<void>((resolve) => globalThis.setTimeout(resolve, ms));

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
  private lastHeavyAt = 0;
  private heavyIntervalMs = HEAVY_BASE_MS;

  private loudnessWindow = new LoudnessWindow(3200);
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
  private deqCutDb: number[] = [0, 0, 0, 0, 0];
  // composite ceiling guard (per-sample soft clip after output trim)
  private guardWet!: GainNode;
  private guardDry!: GainNode;
  private guardShaper!: WaveShaperNode;
  // pre-limiter soft clipper: one 4× oversampled shaper blended in parallel
  // with the dry program, so clipping shaves peaks without dulling the mix
  private clipShaper!: WaveShaperNode;
  private clipDry!: GainNode;
  private clipWet!: GainNode;
  /**
   * Dry leg of the clipper blend. It runs through a unity transfer curve with
   * the *same* oversampling as the clipping leg, so the two arrive together:
   * an oversampled shaper is delayed by its resampler, and blending it with a
   * directly-tapped dry signal notches the top octaves.
   */
  private clipDryShape!: WaveShaperNode;
  private clipThresholdDb = Number.NaN;
  private guardCeilingDb = Number.NaN;
  // loudness rider (Compellor-style leveler / AERO long-term controller)
  private riderGain!: GainNode;
  private riderDb = 0;
  // parallel harmonic exciter
  private exBp1!: BiquadFilterNode;
  private exBp2!: BiquadFilterNode;
  private exMix!: GainNode;
  // low-band reinforcement: harmonics generated from the bass band itself
  private bass1!: BiquadFilterNode;
  private bass2!: BiquadFilterNode;
  private bassDrive!: GainNode;
  private bassShaper!: WaveShaperNode;
  private bassMix!: GainNode;
  // M/S stereo width (transparent when bypassed)
  private widthDry!: GainNode;
  private widthWet!: GainNode;
  private widthGain!: GainNode;
  /** Per-band (5-way) side width — psy.cohWidth. */
  private cwWet!: GainNode;
  private cwDry!: GainNode;
  private cwOut!: GainNode;
  private cwBands: GainNode[] = [];
  private cwSplits: BiquadFilterNode[][] = [];
  /** M/S matrix trim — psy.msTrim. */
  private midTrim!: GainNode;
  private sideTrim!: GainNode;
  private sideHpf!: BiquadFilterNode;
  private sideHpfWet!: GainNode;
  private sideHpfDry!: GainNode;
  /** Low-end mono: side highs pass, side lows fold back to centred. */
  private sideDry!: GainNode;
  private sideWet!: GainNode;
  private sideLp!: BiquadFilterNode;
  private sideLpNeg!: GainNode;
  private sideWetInv!: GainNode;
  // latency / stability telemetry
  lowLatency = false;
  private glitch = new GlitchMonitor();
  /** True only when the last clock reading was a trustworthy rate. */
  private driftValid = false;
  private driftIntervalMs = 0;
  /** Wall time of the last programme / processed-signal reading above the floor. */
  private lastProgramAt = 0;
  private lastOutAt = 0;
  private poweredAt = 0;
  /** Has this context clocked at least one quantum since power-on? */
  private everClocked = false;
  /**
   * Result of the last sink switch, for the diagnostics panel. "refused" is a
   * device that went away; "unsupported" is a browser without setSinkId —
   * different faults with the same symptom, so they are stored apart.
   */
  private sinkState:
    | "default"
    | "applied"
    | "refused"
    | "unsupported"
    | "pending" = "default";
  /** Last fault the browser reported, with the moment it was raised. */
  private lastFault: { message: string; at: number } | null = null;
  /** One recovery in flight, so the button cannot stack resume/switch calls. */
  private recoveryArm: Promise<boolean> | null = null;
  /** Identity of the in-flight recovery, so a stale one cannot clear a new one. */
  private recoveryToken: object | null = null;
  private lastRecoveryAt = 0;
  /** Invalidates a pending power-off fade when the engine is re-powered. */
  private fadeToken = 0;
  /** Invalidates a pending source switch when another one is requested. */
  private sourceToken = 0;
  /** Invalidates an in-flight microphone arm when the device changes. */
  private micToken = 0;
  private micArm: Promise<void> | null = null;
  /**
   * Device swaps run one at a time. A picker fires on every click and the
   * swap fades, tears a stream down and awaits getUserMedia/setSinkId — two
   * of those overlapping would tear down the endpoint the other just opened.
   */
  private swapArm: Promise<void> = Promise.resolve();
  /** Invalidates a queued device swap when a newer one is requested. */
  private deviceToken = 0;
  /** The one boot in flight, shared by concurrent powerOn callers. */
  private bootArm: Promise<void> | null = null;
  /** Sink the context is actually rendering to ("" = OS default). */
  private appliedSink = "";
  /**
   * Suspend/close in flight. A boot awaits this before asking the system for
   * a device: two contexts contending for one endpoint is a burst, and no
   * amount of fading downstream can hide that.
   */
  private ctxTeardown: Promise<void> = Promise.resolve();
  /** True only while this context is known to be clocking. */
  private contextRunning = false;
  /**
   * True while the output bus has been faded in on the current context.
   * Opening an already-open bus would be a dip in live programme, and
   * re-opening a bus left at programme level by a suspended power-off would
   * skip the fade that prevents the click.
   */
  private outputOpen = false;
  /**
   * The monitor is muted because a device hand-off is in progress, not by the
   * operator. Kept separately so a parameter apply landing mid-swap cannot
   * cancel the mute and put uninitialised frames through the new endpoint.
   */
  private handoffMuted = false;
  private frameCostMs = 0;
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
  /** Sibilance-band level used by the automatic threshold. */
  private deessBandAnalyser: AnalyserNode | null = null;
  private deessBandBuf: Float32Array<ArrayBuffer> = new Float32Array(1024);
  private deessBandDb = -120;
  /** Per-band automatic makeup (dB) added to the preset's makeup. */
  private autoMakeupTrack = [0, 0, 0, 0, 0, 0];
  private limDrive!: GainNode;
  private limWetPre!: GainNode;
  private limComp!: DynamicsCompressorNode;
  private limDry!: GainNode;
  /**
   * Peak-stage split: the summed clipper output feeds both limiter paths, and
   * the operator's engine choice crossfades between them (never a hard cut).
   */
  private limSum!: GainNode;
  private limNative!: GainNode;
  private limWorklet!: GainNode;
  // v3.1 pre-chain restoration + presence/brilliance + output shapers
  private restNotch1!: BiquadFilterNode;
  private restNotch2!: BiquadFilterNode;
  private restLp!: BiquadFilterNode;
  private restShelf!: BiquadFilterNode;
  private restHarmShaper!: WaveShaperNode;
  private restHarmWet!: GainNode;
  private restHarmDry!: GainNode;
  /** Latency-matched dry leg of the harmonic generator (see clipDryShape). */
  private restHarmDryShape!: WaveShaperNode;
  /** Exciter shaper — kept as a field so its oversampling is verifiable. */
  private exShaper!: WaveShaperNode;
  private dcHpf!: BiquadFilterNode;
  private mainsNotch!: BiquadFilterNode;
  /**
   * Mains harmonics 2×…8× — real hum is rarely a pure sine. They stay in the
   * graph as allpass sections when the harmonic bank is off, so engaging it
   * never rewires the chain.
   */
  private mainsHarmonics: BiquadFilterNode[] = [];
  private airShelf!: BiquadFilterNode;
  private presenceHi!: BiquadFilterNode;
  private brillianceHi!: BiquadFilterNode;
  private preEmphShelf!: BiquadFilterNode;
  private codecLp!: BiquadFilterNode;
  private chTrimL!: GainNode;
  private chTrimR!: GainNode;
  private safetyGain!: GainNode;
  private safetyMute = false;
  private restHarmKey = "";
  private crestDrive = 0;
  /** Lookahead worklet — null when the platform has no AudioWorklet. */
  private workletLimiter: AudioWorkletNode | null = null;
  /** Lock-free meter slot written by the limiter worklet, read by snapshots. */
  private limiterMeter: SpscRing | null = null;
  private workletReady = false;
  private workletGr = 0;
  private workletConfig = "";
  /** Slow second limiter stage (program limiter). */
  private progComp!: DynamicsCompressorNode;
  private outputGain!: GainNode;
  private duckGain!: GainNode;
  private matchGain!: GainNode;
  /** v3.0 tilt pair: 0 dB shelves are bit-transparent passthrough. */
  private tiltLo!: BiquadFilterNode;
  private tiltHi!: BiquadFilterNode;
  private monitorGain!: GainNode;
  /** Monitor check matrix: mono fold + per-channel polarity (monitor only). */
  private monL!: GainNode;
  private monR!: GainNode;
  private monMono!: GainNode;
  /** Operator mute on the monitor bus; survives parameter re-application. */
  private monitorMuted = false;
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

  // buffers — one per analyser size: reading a 2048-point analyser into a
  // 4096-sample buffer would leave half the block holding the previous
  // reader's samples, and the peak meter would report them as signal.
  private inBufL!: Float32Array<ArrayBuffer>;
  private inBufR!: Float32Array<ArrayBuffer>;
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
  /** Cached test-noise buffer, rebuilt only when the sample rate changes. */
  private pinkBuffer: AudioBuffer | null = null;
  private micStream: MediaStream | null = null;
  private micNode: MediaStreamAudioSourceNode | null = null;
  private params: ProcessorParams | null = null;
  /** Last value written per node parameter — re-applying is then free. */
  private written = new Map<string, number>();
  /** Guards against a measurement tick re-entering apply(). */
  private applying = false;
  /** Bitrate of the mount currently going on air, for the automatic HF cap. */
  private streamBitrateKbps: number | null = null;
  /** Programme level ahead of the gate, from the latest meter tick. */
  private srcLevelDb = -120;
  /** 1 Hz correlation history for the phase meter (ring buffer). */
  private corrHistory = new Float32Array(120).fill(1);
  private corrWrite = 0;
  private lastCorrAt = 0;
  /** 1 Hz loudness log for the CSV report (last hour, newest last). */
  private loudnessLog: LoudnessLogRow[] = [];
  private lastLogAt = 0;
  /** Limiter hold: release is frozen until this timestamp (ms). */
  private limiterHoldUntil = 0;
  private inPeakL = -120;
  private inPeakR = -120;

  /* ── lifecycle ────────────────────────────────────────────────────────── */

  constructor() {
    this.loadDevicePrefs();
  }

  /** Last-used I/O + source survive restarts, so boot restores the rig. */
  private loadDevicePrefs() {
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(DEVICE_STORE);
    } catch {
      return; // blocked storage — defaults stand
    }
    const prefs = parsePrefs(raw);
    this.inputDeviceId = prefs.input;
    this.outputDeviceId = prefs.output;
    this.sourceKind = prefs.source;
  }

  private saveDevicePrefs() {
    try {
      localStorage.setItem(
        DEVICE_STORE,
        serializePrefs({
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
      if (q.state === "granted") await this.openMic();
    } catch {
      /* permissions API missing — leave idle for an explicit Arm press */
    }
  }

  /**
   * Cold boot, at most once at a time.
   *
   * The body awaits the worklet module, so two callers (the transport button
   * and an encoder go-live, say) used to race: the second closed the first
   * context while it was still building its graph, leaving nodes attached to a
   * closed context and the first boot's teardown firing into the live one.
   * Callers now share the one boot in flight.
   */
  powerOn(): Promise<void> {
    if (this.bootArm) return this.bootArm;
    const run = this.doPowerOn().finally(() => {
      if (this.bootArm === run) this.bootArm = null;
    });
    this.bootArm = run;
    return run;
  }

  private async doPowerOn(): Promise<void> {
    this.resetLoudness();
    this.fadeToken += 1; // any pending power-off teardown is now stale
    // The previous power cycle's suspend/close has to have finished before a
    // new hardware stream is requested. This is the ordering that used to be
    // missing: `close()` was fired and forgotten, so the new context was
    // built while the old one still held the endpoint.
    await this.ctxTeardown;
    const reuse = this.ctx && this.ctx.state !== "closed" && this.graphReady;
    if (!reuse) {
      const previous = this.ctx;
      if (previous && previous.state !== "closed") {
        this.graphReady = false;
        this.contextRunning = false;
        // Awaited, not fire-and-forget: the hardware must be back before the
        // replacement asks for it.
        await previous.close().catch(() => undefined);
      }
      const ctx = this.createContext();
      this.ctx = ctx;
      this.contextRunning = false;
      // The limiter module must be registered before buildGraph can create the
      // node. Failure is not fatal: the native compressor path stays in place.
      await this.loadLimiterWorklet(ctx);
      this.buildGraph(ctx);
    }
    const ctx = this.ctx;
    if (!ctx) return;
    if (this.params) this.apply(this.params);
    // `powered` is reported even when the context refuses to run, so the wake
    // banner can offer the gesture — but nothing is faded in until the
    // endpoint is actually clocking. `onstatechange` reopens it later.
    this.powered = true;
    this.poweredAt = Date.now();
    // A fresh power cycle is a fresh clock: every drift reference and every
    // "time since signal" counter belongs to the previous context.
    this.everClocked = false;
    this.driftValid = false;
    this.driftIntervalMs = 0;
    this.clockRefWall = 0;
    this.clockRefCtx = 0;
    this.lastProgramAt = 0;
    this.lastOutAt = 0;
    this.snapshotValue = { ...this.snapshotValue, powered: true };
    await this.resumeAndWait(ctx);
    // A power-off mid-fade leaves the program bus at zero. Restore it before
    // the source is rebuilt, or the console would look alive with no audio.
    this.sourceToken += 1;
    if (this.sourceBus) {
      this.sourceBus.gain.cancelScheduledValues(ctx.currentTime);
      this.sourceBus.gain.setValueAtTime(1, ctx.currentTime);
    }
    this.watchDevices();
    if (this.contextRunning) this.openOutput();
    void this.applyOutputDevice();
    // A saved microphone is only re-armed when the OS already allows it —
    // boot must never throw a permission prompt at the operator. Every other
    // source is safe to start directly.
    if (this.sourceKind === "mic") void this.autoInitInput();
    else this.startSource(this.sourceKind);
    this.startMeterLoop();
    this.notify();
  }

  /**
   * Construction seam for the hardware context: every boot and rebuild goes
   * through here, so a second context is never created as a side effect
   * somewhere else.
   */
  protected createContext(): AudioContext {
    return new AudioContext({ latencyHint: "interactive" });
  }

  /**
   * Resume, then wait for the state rather than the promise.
   *
   * `resume()` resolves when the request is accepted; on a device that is
   * still renegotiating, `running` arrives later. Fading in on the promise is
   * how programme ends up in a buffer the endpoint has not opened yet.
   */
  private async resumeAndWait(ctx: AudioContext): Promise<boolean> {
    try {
      await ctx.resume();
    } catch (err) {
      // autoplay policy — the wake banner offers the gesture, and the reason
      // belongs in the diagnostics panel rather than only in the console.
      this.noteFault(
        err instanceof Error && err.message
          ? `Audio device refused to start: ${err.message}`
          : "Audio device refused to start — the browser is waiting for a click.",
      );
    }
    this.contextRunning = await waitForRunning(ctx);
    if (this.contextRunning) {
      this.everClocked = true;
    } else {
      this.noteFault(
        "The audio context did not reach the running state — the browser is holding the device shut.",
      );
    }
    return this.contextRunning;
  }

  /** Fade the output bus in from exact silence — no click on power-up or resume. */
  private openOutput() {
    const ctx = this.ctx;
    if (!ctx || !this.duckGain || this.outputOpen) return;
    this.outputOpen = true;
    const now = ctx.currentTime;
    const gain = this.duckGain.gain;
    // From zero rather than from wherever the param happens to sit: a bus
    // left at programme level by a suspended power-off still gets a fade.
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(0, now);
    gain.linearRampToValueAtTime(1, now + DEVICE_RAMP_MS / 1000);
  }

  powerOff() {
    const ctx = this.ctx;
    const token = ++this.fadeToken;
    this.sourceToken += 1; // a pending source switch must not fade back in
    // A queued device swap must not wake the console back up after this.
    this.deviceToken += 1;
    this.cancelMeterLoop();
    this.powered = false;
    this.poweredAt = 0;
    this.everClocked = false;
    this.driftValid = false;
    this.clockRefWall = 0;
    this.clockRefCtx = 0;
    this.loudnessWindow.clear();
    this.snapshotValue = { ...SILENT_SNAPSHOT };
    this.notify();

    const teardown = () => {
      this.stopFile();
      this.stopSignal();
      this.releaseMic();
      // the standby source never outlives the on-air chain
      if (this.backupEl) this.backupEl.pause();
      this.backupActiveFlag = false;
      // Through the ramp cache, not a raw write: a raw value here would leave
      // the cache claiming the failover crossfade is still applied, and the
      // next take-over would be a no-op.
      this.setNum("failover.src", this.srcGain?.gain, 1, 0.01);
      this.setNum("failover.backup", this.backupGain?.gain, 0, 0.01);
      this.outputOpen = false;
      if (ctx && ctx.state !== "closed") {
        // Recorded rather than fired and forgotten: the next boot awaits it,
        // so a new context is never created while this one still holds the
        // endpoint.
        this.contextRunning = false;
        this.ctxTeardown = ctx.suspend().catch(() => undefined);
      }
      this.notify();
    };

    // Suspend only after the bus has faded: stopping the graph at programme
    // level is a click, and a click on the composite is audible on air.
    if (ctx && ctx.state === "running" && this.duckGain) {
      rampTo(this.duckGain.gain, 0, ctx.currentTime);
      globalThis.setTimeout(() => {
        if (this.fadeToken === token && !this.powered) teardown();
      }, rampWaitMs());
    } else {
      teardown();
    }
  }

  dispose() {
    this.graphReady = false;
    this.deviceToken += 1;
    this.powerOff();
    this.backupSrc = null;
    this.backupEl = null;
    if (this.backupUrl) URL.revokeObjectURL(this.backupUrl);
    this.backupUrl = null;
    if (this.ctx) {
      const ctx = this.ctx;
      this.ctx = null;
      this.contextRunning = false;
      this.ctxTeardown = ctx.close().catch(() => undefined);
    }
    this.written.clear();
    this.workletLimiter = null;
    this.limiterMeter = null;
    this.clearGraphRefs();
  }

  /**
   * Register the lookahead limiter on the audio thread. The module is a Blob
   * URL built from the kernel's own source, so it ships without a build-time
   * asset and cannot drift from the verified implementation. Any failure
   * leaves the native compressor in circuit — never a silent chain.
   */
  private async loadLimiterWorklet(ctx: AudioContext): Promise<void> {
    this.workletReady = false;
    this.workletLimiter = null;
    this.limiterMeter = null;
    if (!ctx.audioWorklet) return;
    let url = "";
    try {
      url = URL.createObjectURL(
        new Blob([limiterWorkletSource()], { type: "text/javascript" }),
      );
      await ctx.audioWorklet.addModule(url);
      this.workletReady = true;
    } catch {
      this.workletReady = false;
    } finally {
      if (url) URL.revokeObjectURL(url);
    }
  }

  /**
   * Drop every node reference so a later buildGraph cannot write to a
   * teardown graph, and so node arrays are rebuilt from empty rather than
   * appended to (which duplicated HPF/EQ/split filters on every boot).
   */
  private clearGraphRefs() {
    this.hpfStages = [];
    this.mainsHarmonics = [];
    this.phaseStages = [];
    this.eqFilters = [];
    this.mbComps = [];
    this.mbMakeups = [];
    this.mbSplitFilters = [];
    this.deqBpAudio = [];
    this.deqBpDet = [];
    this.deqDets = [];
    this.deqSubs = [];
    this.deqCutDb = [0, 0, 0, 0, 0];
    this.cwBands = [];
    this.cwSplits = [];
  }

  /* ── graph construction ───────────────────────────────────────────────── */

  /**
   * One write path for every node parameter. Identical values are dropped, so
   * dragging a slider (which re-applies the whole chain on every pointer
   * move) schedules automation only for what actually changed.
   */
  private setNum(key: string, param: AudioParam | undefined, value: number, tc = 0.02) {
    if (!this.ctx || !param || !Number.isFinite(value)) return;
    const prev = this.written.get(key);
    if (prev !== undefined && Math.abs(prev - value) < 1e-7) return;
    this.written.set(key, value);
    param.setTargetAtTime(value, this.ctx.currentTime, tc);
  }

  /**
   * Filter corner, clamped to what this context can represent. A 22 kHz
   * low-pass is legal at 48 kHz and degenerate at 44.1 kHz; the console's
   * setting stays the same either way, only the coefficient is folded down.
   */
  private setHz(key: string, param: AudioParam | undefined, hz: number, tc = 0.02) {
    this.setNum(key, param, safeFilterHz(hz, this.ctx?.sampleRate ?? 48000), tc);
  }

  private buildGraph(ctx: AudioContext) {
    this.clearGraphRefs();
    this.written.clear();
    this.outputOpen = false;
    this.frameCostMs = 0;
    this.heavyIntervalMs = HEAVY_BASE_MS;
    this.lastHeavyAt = 0;
    // A context suspended by the platform (sleep, device change, tab
    // eviction) is a hard glitch. Resume it as soon as we are allowed to;
    // a deliberate power-off sets `powered` false first, so it is not undone.
    // The running transition is also the one place programme is let back in:
    // a fade that was skipped because the endpoint was not clocking gets its
    // opening here instead of playing into a dead buffer.
    ctx.onstatechange = () => {
      if (!this.powered || this.ctx !== ctx) return;
      if (ctx.state === "suspended") {
        this.contextRunning = false;
        // Nothing is playing, so the next running state must fade in again.
        this.outputOpen = false;
        void ctx.resume();
        return;
      }
      if (ctx.state === "running" && !this.contextRunning) {
        this.contextRunning = true;
        this.everClocked = true;
        this.openOutput();
        this.ensureBusOpen();
      }
    };
    const g = (v = 1) => {
      const n = ctx.createGain();
      n.gain.value = v;
      return n;
    };

    this.sourceBus = g(1);
    // Always hand the chain two channels. A mono interface (or a mono file)
    // would otherwise leave the right channel silent: the R meter dead, the
    // correlation hard right, and the M/S matrix dropping half the signal.
    this.sourceBus.channelCount = 2;
    this.sourceBus.channelCountMode = "explicit";
    this.sourceBus.channelInterpretation = "speakers";

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
    // v3.1 restoration: two tracked notches, the spectral-NR low-pass and
    // high shelf, then the parallel harmonic generator. Every stage is
    // magnitude-neutral until its module is enabled.
    this.restNotch1 = ctx.createBiquadFilter();
    this.restNotch1.type = "allpass";
    this.restNotch1.frequency.value = 100;
    this.restNotch1.Q.value = 5;
    this.restNotch2 = ctx.createBiquadFilter();
    this.restNotch2.type = "allpass";
    this.restNotch2.frequency.value = 1000;
    this.restNotch2.Q.value = 5;
    this.restLp = ctx.createBiquadFilter();
    this.restLp.type = "lowpass";
    this.restLp.frequency.value = safeFilterHz(22000, ctx.sampleRate);
    this.restLp.Q.value = 0.707;
    this.restShelf = ctx.createBiquadFilter();
    this.restShelf.type = "highshelf";
    this.restShelf.frequency.value = 8500;
    this.restShelf.gain.value = 0;
    this.dcHpf = ctx.createBiquadFilter();
    this.dcHpf.type = "allpass";
    this.dcHpf.frequency.value = 30;
    this.dcHpf.Q.value = 0.707;
    this.mainsNotch = ctx.createBiquadFilter();
    this.mainsNotch.type = "allpass";
    this.mainsNotch.frequency.value = 50;
    this.mainsNotch.Q.value = 20;
    for (let h = 2; h <= 8; h++) {
      const notch = ctx.createBiquadFilter();
      notch.type = "allpass";
      notch.frequency.value = 50 * h;
      notch.Q.value = 20;
      this.mainsHarmonics.push(notch);
    }
    this.restHarmShaper = ctx.createWaveShaper();
    this.restHarmShaper.oversample = "4x";
    this.restHarmDry = g(1);
    this.restHarmWet = g(0);
    this.restHarmDryShape = ctx.createWaveShaper();
    this.restHarmDryShape.oversample = "4x";
    this.restHarmDryShape.curve = identityCurve();
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

    // restoration inserts between the input trim and the HPF, so the noise
    // shelf and harmonic products are cleaned by the high-pass that follows.
    this.inputGain.connect(this.restNotch1);
    this.restNotch1.connect(this.restNotch2);
    this.restNotch2.connect(this.restLp);
    this.restLp.connect(this.dcHpf);
    this.dcHpf.connect(this.mainsNotch);
    let humNode: AudioNode = this.mainsNotch;
    for (const notch of this.mainsHarmonics) {
      humNode.connect(notch);
      humNode = notch;
    }
    humNode.connect(this.restShelf);
    const restOut = g(1);
    this.restShelf.connect(this.restHarmDryShape);
    this.restHarmDryShape.connect(this.restHarmDry);
    this.restHarmDry.connect(restOut);
    this.restShelf.connect(this.restHarmShaper);
    this.restHarmShaper.connect(this.restHarmWet);
    this.restHarmWet.connect(restOut);

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

    let hpfNode: AudioNode = restOut;
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

    // ── presence & brilliance (v3.1): series shelves, 0 dB when bypassed ──
    this.presenceHi = ctx.createBiquadFilter();
    this.presenceHi.type = "peaking";
    this.presenceHi.frequency.value = 3500;
    this.presenceHi.Q.value = 1;
    this.presenceHi.gain.value = 0;
    this.brillianceHi = ctx.createBiquadFilter();
    this.brillianceHi.type = "highshelf";
    this.brillianceHi.frequency.value = 11000;
    this.brillianceHi.Q.value = 0.7;
    this.brillianceHi.gain.value = 0;
    this.airShelf = ctx.createBiquadFilter();
    this.airShelf.type = "highshelf";
    this.airShelf.frequency.value = 16000;
    this.airShelf.Q.value = 0.7;
    this.airShelf.gain.value = 0;
    phaseOut.connect(this.presenceHi);
    this.presenceHi.connect(this.brillianceHi);
    this.brillianceHi.connect(this.airShelf);

    // ── 6-band EQ (wet/dry crossfade) ──
    this.eqWetPre = g(1);
    this.eqDry = g(0);
    this.airShelf.connect(this.eqWetPre);
    this.airShelf.connect(this.eqDry);
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
    // No oversampling here used to alias the tanh products back into the
    // presence band as inharmonic grit. The shaper is the same one; only the
    // rate it runs at changes.
    this.exShaper = ctx.createWaveShaper();
    this.exShaper.oversample = "4x";
    const exCurve = new Float32Array(4097);
    const exK = 2.5;
    for (let i = 0; i < exCurve.length; i++) {
      const x = -1 + (2 * i) / (exCurve.length - 1);
      exCurve[i] = Math.tanh(exK * x) / Math.tanh(exK);
    }
    this.exShaper.curve = exCurve;
    this.exBp2 = ctx.createBiquadFilter();
    this.exBp2.type = "bandpass";
    this.exBp2.frequency.value = 5400;
    this.exBp2.Q.value = 0.7;
    this.exMix = g(0);
    eqOut.connect(this.exBp1);
    this.exBp1.connect(exDrive);
    exDrive.connect(this.exShaper);
    this.exShaper.connect(this.exBp2);
    this.exBp2.connect(this.exMix);
    this.exMix.connect(deqSum); // harmonics join the program here

    // ── low-band reinforcement (psychoacoustic bass module) ──
    // The bass band is taken from the programme itself, its harmonics are
    // generated from that band, and the result joins the programme in
    // parallel. There is no delayed copy and no allpass network in the path,
    // so the low end keeps its transient shape instead of smearing.
    this.bass1 = ctx.createBiquadFilter();
    this.bass1.type = "lowpass";
    this.bass1.frequency.value = 140;
    this.bass1.Q.value = 0.707;
    this.bass2 = ctx.createBiquadFilter();
    this.bass2.type = "lowpass";
    this.bass2.frequency.value = 140;
    this.bass2.Q.value = 0.707;
    this.bassDrive = g(2);
    this.bassShaper = ctx.createWaveShaper();
    const bassCurve = new Float32Array(4097);
    for (let i = 0; i < bassCurve.length; i++) {
      const x = -1 + (2 * i) / (bassCurve.length - 1);
      bassCurve[i] = Math.tanh(2.2 * x) / Math.tanh(2.2);
    }
    this.bassShaper.curve = bassCurve;
    this.bassShaper.oversample = "2x";
    this.bassMix = g(0);
    eqOut.connect(this.bass1);
    this.bass1.connect(this.bass2);
    this.bass2.connect(this.bassDrive);
    this.bassDrive.connect(this.bassShaper);
    this.bassShaper.connect(this.bassMix);
    this.bassMix.connect(deqSum);

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
    // Band level for the automatic threshold. Tapped before the detector so
    // the reference is the source's sibilance, not its own gain reduction.
    this.deessBandAnalyser = ctx.createAnalyser();
    this.deessBandAnalyser.fftSize = 1024;
    this.deessBpDet.connect(this.deessBandAnalyser);
    this.deessBandBuf = new Float32Array(1024);
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
    this.clipDryShape = ctx.createWaveShaper();
    this.clipDryShape.oversample = "4x";
    this.clipDryShape.curve = identityCurve();
    this.rebuildClipCurve(DEFAULT_CLIPPER.thresholdDb);
    this.limDrive.connect(this.clipDryShape);
    this.clipDryShape.connect(this.clipDry);
    this.limDrive.connect(this.clipShaper);
    this.clipShaper.connect(this.clipWet);
    // Both clipper legs sum into one peak-stage input, so the native and
    // worklet limiters hear exactly the same signal.
    this.limSum = g(1);
    this.clipDry.connect(this.limSum);
    this.clipWet.connect(this.limSum);
    this.limNative = g(1);
    this.limWorklet = g(0);
    this.limSum.connect(this.limComp);
    this.limComp.connect(this.limNative);
    this.limNative.connect(limOut);
    if (this.workletReady) {
      try {
        // SharedArrayBuffer is only present when the page is isolated; when
        // it is, metering crosses threads through the ring instead of a
        // postMessage object per report.
        const meter =
          typeof SharedArrayBuffer !== "undefined" ? createSpscRing(64) : null;
        const node = new AudioWorkletNode(ctx, LIMITER_WORKLET_NAME, {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [2],
          channelCount: 2,
          channelCountMode: "explicit",
          channelInterpretation: "speakers",
          processorOptions: meter ? { meter: meter.sab } : undefined,
        });
        this.limiterMeter = meter?.ring ?? null;
        node.port.onmessage = (e: MessageEvent) => {
          const data = e.data as number | { gr?: number };
          const gr = typeof data === "number" ? data : data?.gr;
          if (typeof gr === "number" && Number.isFinite(gr)) {
            this.workletGr = Math.max(0, Math.min(60, gr));
          }
        };
        this.limSum.connect(node);
        node.connect(this.limWorklet);
        this.limWorklet.connect(limOut);
        this.workletLimiter = node;
      } catch {
        // construction refused: the native path is already wired at unity
        this.workletLimiter = null;
      }
    }
    // ── program limiter: the slow second stage ──
    // It rides the short-term level under its own ceiling, so the fast peak
    // stage only ever sees transients. Ratio 1 = unity until engaged, which
    // keeps the node (and its latency) in circuit either way.
    this.progComp = ctx.createDynamicsCompressor();
    this.progComp.threshold.value = -1.4;
    this.progComp.ratio.value = 1;
    this.progComp.knee.value = 2;
    this.progComp.attack.value = 0.012;
    this.progComp.release.value = 0.32;
    this.limComp.connect(this.progComp);
    this.progComp.connect(limOut);
    this.limDry.connect(limOut);

    // ── output / ceiling guard / duck / monitor / encoder send ──
    // post-limiter pre-emphasis correction (v3.1): a high shelf that
    // compensates the pre-emphasis the receiver will remove.
    this.preEmphShelf = ctx.createBiquadFilter();
    this.preEmphShelf.type = "highshelf";
    this.preEmphShelf.frequency.value = 7500;
    this.preEmphShelf.Q.value = 0.7;
    this.preEmphShelf.gain.value = 0;
    limOut.connect(this.preEmphShelf);

    this.outputGain = g(1);
    this.duckGain = g(1);
    this.preEmphShelf.connect(this.outputGain);
    // codec pre-shaping: a low-pass ahead of the delivery taps, transparent
    // (22 kHz) until a profile is selected.
    this.codecLp = ctx.createBiquadFilter();
    this.codecLp.type = "lowpass";
    this.codecLp.frequency.value = safeFilterHz(22000, ctx.sampleRate);
    this.codecLp.Q.value = 0.707;
    this.outputGain.connect(this.codecLp);

    // composite ceiling guard: per-sample soft clip after the output trim so
    // the composite bus can never exceed the limiter ceiling
    this.guardWet = g(1);
    this.guardDry = g(0);
    this.guardShaper = ctx.createWaveShaper();
    this.guardShaper.oversample = this.lowLatency ? "2x" : "4x";
    this.codecLp.connect(this.guardWet);
    this.codecLp.connect(this.guardDry);
    this.guardWet.connect(this.guardShaper);
    const postGuard = g(1);
    this.guardShaper.connect(postGuard);
    this.guardDry.connect(postGuard);

    // ── M/S stereo width (Stereo Tool “stereo boost” / Compellor enhance).
    //    Dry path stays in circuit at width = 1 so mono sources are untouched.─
    // channel matching: independent L/R trims after the ceiling guard.
    this.chTrimL = g(1);
    this.chTrimR = g(1);
    const chSplit = ctx.createChannelSplitter(2);
    const chMerge = ctx.createChannelMerger(2);
    postGuard.connect(chSplit);
    chSplit.connect(this.chTrimL, 0);
    chSplit.connect(this.chTrimR, 1);
    this.chTrimL.connect(chMerge, 0, 0);
    this.chTrimR.connect(chMerge, 0, 1);

    this.widthDry = g(1);
    this.widthWet = g(0);
    chMerge.connect(this.widthDry);
    chMerge.connect(this.widthWet);
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
    // safety mute (v3.1 watchdog): a dedicated gain, so a watchdog mute can
    // never fight the power-on fade or the operator's monitor mute.
    this.safetyGain = g(1);
    this.tiltHi.connect(this.safetyGain);
    this.safetyGain.connect(this.duckGain);
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
    this.midTrim = g(1);
    this.sideTrim = g(1);
    mid.connect(this.midTrim);
    this.midTrim.connect(wMerge, 0, 0);
    this.midTrim.connect(wMerge, 0, 1);

    // Side HPF (M/S trim): a bypass pair keeps the topology fixed and the
    // side band untouched until the trim is engaged.
    this.sideHpf = ctx.createBiquadFilter();
    this.sideHpf.type = "highpass";
    this.sideHpf.frequency.value = 400;
    this.sideHpf.Q.value = 0.707;
    this.sideHpfDry = g(1);
    this.sideHpfWet = g(0);
    const sideBase = g(1);
    this.sideTrim.connect(this.sideHpfDry);
    this.sideHpfDry.connect(sideBase);
    this.sideTrim.connect(this.sideHpf);
    this.sideHpf.connect(this.sideHpfWet);
    this.sideHpfWet.connect(sideBase);

    // ── per-band (5-way) side width ──
    // Splitting only the side channel keeps the mid path intact: the bass
    // band can be narrowed to mono while the air band widens, which is the
    // one stereo move that survives a mono fold-down.
    const CW_SPLITS = [120, 400, 1600, 5000];
    const cwSum = g(1);
    this.cwDry = g(1);
    this.cwWet = g(0);
    this.cwOut = g(1);
    sideBase.connect(this.cwDry);
    this.cwDry.connect(this.cwOut);
    cwSum.connect(this.cwWet);
    this.cwWet.connect(this.cwOut);
    for (let band = 0; band < 5; band++) {
      const start = g(1);
      let node: AudioNode = start;
      const link = (freq: number, type: BiquadFilterType) => {
        // LR4: two cascaded biquads at the same corner.
        const a = ctx.createBiquadFilter();
        a.type = type;
        a.frequency.value = freq;
        a.Q.value = 0.707;
        const b = ctx.createBiquadFilter();
        b.type = type;
        b.frequency.value = freq;
        b.Q.value = 0.707;
        node.connect(a);
        a.connect(b);
        (this.cwSplits[band] ??= []).push(a, b);
        node = b;
      };
      if (band > 0) link(CW_SPLITS[band - 1], "highpass");
      if (band < 4) link(CW_SPLITS[band], "lowpass");
      const width = g(1);
      node.connect(width);
      width.connect(cwSum);
      this.cwBands.push(width);
      sideBase.connect(start);
    }

    // Low-end mono matrix: dry side always available; wet side carries
    // side − lowpassed(side), i.e. bass folds to mono below the crossover.
    this.sideDry = g(1);
    this.sideWet = g(0);
    this.sideLp = ctx.createBiquadFilter();
    this.sideLp.type = "lowpass";
    this.sideLp.frequency.value = 120;
    this.sideLp.Q.value = 0.707;
    this.sideLpNeg = g(-1);
    this.cwOut.connect(this.sideDry);
    this.cwOut.connect(this.sideLp);
    this.cwOut.connect(this.sideWet);
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

    // ── monitor check matrix: mono fold-down + per-channel polarity ──
    // Monitoring only: the encoder send taps duckGain upstream, so a check
    // can never leak into the stream.
    this.monitorGain = g(dbToGain(-6));
    this.matchGain = g(1);
    this.duckGain.connect(this.matchGain);
    const monSplit = ctx.createChannelSplitter(2);
    const monMerge = ctx.createChannelMerger(2);
    this.monL = g(1);
    this.monR = g(1);
    this.monMono = g(0);
    this.matchGain.connect(monSplit);
    monSplit.connect(this.monL, 0);
    monSplit.connect(this.monR, 1);
    this.monL.connect(monMerge, 0, 0);
    this.monR.connect(monMerge, 0, 1);
    const monoL = g(0.5);
    const monoR = g(0.5);
    monSplit.connect(monoL, 0);
    monSplit.connect(monoR, 1);
    monoL.connect(this.monMono);
    monoR.connect(this.monMono);
    this.monMono.connect(monMerge, 0, 0);
    this.monMono.connect(monMerge, 0, 1);
    monMerge.connect(this.monitorGain);
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

    this.inBufL = new Float32Array(this.inAnalyserL.fftSize);
    this.inBufR = new Float32Array(this.inAnalyserR.fftSize);
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
    if (!ctx || !this.graphReady || this.applying) return; // applied on powerOn
    this.applying = true;
    try {
      this.applyChain(params);
    } finally {
      this.applying = false;
    }
  }

  private applyChain(params: ProcessorParams) {
    const ctx = this.ctx;
    if (!ctx) return;
    const set = (key: string, param: AudioParam | undefined, value: number, tc?: number) =>
      this.setNum(key, param, value, tc);
    const setHz = (key: string, param: AudioParam | undefined, value: number, tc?: number) =>
      this.setHz(key, param, value, tc);

    const adv: AdvancedParams = params.advanced ?? DEFAULT_ADVANCED;
    // input calibration offset is a trim memory, applied with the input gain
    const calibration = adv.restoration.calibration;
    set(
      "input",
      this.inputGain.gain,
      dbToGain(params.inputGainDb + (calibration.on ? calibration.offsetDb : 0)),
    );

    // ── v3.1 restoration ──
    const nr = adv.restoration.nr;
    const nrDepth = nr.mode === "light" ? 4 : nr.mode === "medium" ? 8 : 14;
    set(
      "rest.shelf",
      this.restShelf.gain,
      nr.on ? -(nr.attenuationDb / 24) * nrDepth : 0,
      0.05,
    );
    setHz(
      "rest.lp",
      this.restLp.frequency,
      nr.on
        ? nr.mode === "light"
          ? 18000
          : nr.mode === "medium"
            ? 15000
            : 11000
        : 22000,
      0.05,
    );
    const notch = adv.eq.notch;
    const setNotch = (
      node: BiquadFilterNode,
      cfg: { freqHz: number; widthOct: number; autoTrack: boolean },
      active: boolean,
    ) => {
      node.type = active ? "notch" : "allpass";
      setHz("rest.notch.f", node.frequency, Math.min(18000, Math.max(40, cfg.freqHz)));
      set("rest.notch.q", node.Q, notchQ(cfg.widthOct));
    };
    setNotch(this.restNotch1, notch.notch1, notch.on);
    setNotch(this.restNotch2, notch.notch2, notch.on);
    const dcHz = dcHighpassHz(adv.restoration.dc);
    this.dcHpf.type = dcHz > 0 ? "highpass" : "allpass";
    setHz("rest.dc", this.dcHpf.frequency, dcHz > 0 ? dcHz : 30);
    const mains = mainsNotchHz(adv.restoration.interference);
    this.mainsNotch.type = mains > 0 ? "notch" : "allpass";
    setHz("rest.mains", this.mainsNotch.frequency, mains || 50);
    // Hum harmonics: a mains-locked notch at 2f and 3f. They stay in the
    // graph as allpass sections when the module (or just the harmonics) is
    // off, so engaging them never rebuilds the chain.
    const humHarmonics = mains > 0 && adv.restoration.interference.harmonics;
    this.mainsHarmonics.forEach((notch, i) => {
      notch.type = humHarmonics ? "notch" : "allpass";
      setHz(`rest.mains${i + 2}`, notch.frequency, mains ? mains * (i + 2) : 50 * (i + 2));
    });
    const rest = adv.restoration.harmonics;
    set("rest.harm", this.restHarmWet.gain, rest.on ? (rest.mix / 100) * 0.4 : 0, 0.02);
    set("rest.harm.dry", this.restHarmDry.gain, rest.on ? 1 : 1, 0.02);
    const harmKey = `${rest.even}|${rest.odd}|${rest.drive}|${rest.band}|${rest.on}`;
    if (harmKey !== this.restHarmKey) {
      this.restHarmKey = harmKey;
      this.rebuildRestCurve(rest);
    }

    // ── v3.1 presence & brilliance (neutral at 0 dB) ──
    const pres = adv.eq.presence;
    const presGain = presenceGains(pres);
    setHz("pres.f", this.presenceHi.frequency, pres.presenceMode === "sharp" ? 3800 : 3200);
    set("pres.q", this.presenceHi.Q, Math.max(0.6, Math.min(2.8, pres.presenceWidth * 1.6)));
    set("pres.g", this.presenceHi.gain, pres.on ? presGain.presenceDb : 0);
    setHz(
      "brill.f",
      this.brillianceHi.frequency,
      pres.airType === "open" ? 14000 : pres.airType === "sparkle" ? 12000 : 10500,
    );
    set("brill.g", this.brillianceHi.gain, pres.on ? presGain.brillianceDb : 0);
    const air = airShelf(adv.eq.air);
    setHz("air.f", this.airShelf.frequency, air.freqHz);
    set("air.q", this.airShelf.Q, air.q);
    set("air.g", this.airShelf.gain, air.gainDb);

    // HPF: 12/24/36/48 dB/oct as 1–4 Butterworth sections in cascade.
    // Sections beyond the selected slope go allpass (unity magnitude) so the
    // chain topology is fixed and only the slope's shape changes.
    const hpfQs = hpfSectionQs(params.hpf.slope);
    this.hpfStages.forEach((stage, i) => {
      const active = params.hpf.on && i < hpfQs.length;
      stage.type = active ? "highpass" : "allpass";
      setHz(`hpf.${i}.f`, stage.frequency, params.hpf.freqHz);
      set(`hpf.${i}.q`, stage.Q, hpfQs[i] ?? 0.7071);
    });

    // phase rotator: auto = fixed voice window, manual = user frequency;
    // the cascade is retuned as a whole and bypassed as a whole
    const phaseBase = params.phase.mode === "auto" ? 300 : params.phase.freqHz;
    phaseStageFrequencies(phaseBase).forEach((hz, i) => {
      setHz(`phase.${i}`, this.phaseStages[i]?.frequency, hz);
    });
    this.crossfade("phase", this.phaseWet, this.phaseDry, params.phase.on);

    // silence-gate bypass
    if (!params.gate.on) {
      this.gateCloseAt = 0;
      if (!this.gateOpen) {
        this.gateOpen = true;
        set("gate", this.gateGain.gain, 1, 0.02);
      }
    }

    params.eq.bands.forEach((band, i) => {
      const f = this.eqFilters[i];
      if (!f) return;
      // Per-band bypass keeps the band's settings: it just leaves the
      // cascade as an allpass section, which is magnitude-neutral.
      f.type = eqBandOn(band) ? band.type : "allpass";
      set(`eq.${i}.g`, f.gain, band.gainDb);
      setHz(`eq.${i}.f`, f.frequency, band.freq);
      set(`eq.${i}.q`, f.Q, Math.max(band.q, 0.01));
    });
    this.crossfade("eq", this.eqWetPre, this.eqDry, params.eq.on);

    params.multiband.splitsHz.forEach((hz, split) => {
      (this.mbSplitFilters[split] ?? []).forEach((f, i) => {
        setHz(`mb.split.${split}.${i}`, f.frequency, hz);
      });
    });
    // Less–More macro: one setting scales every band's ratio and envelope.
    // 5 is the preset's own tuning, so the loaded preset is heard as designed
    // until the operator moves the macro.
    const dens = densityProfile(params.density);
    const autoMakeupOn = params.multiband.on && !!params.multiband.autoMakeup;
    params.multiband.bands.forEach((band, i) => {
      const comp = this.mbComps[i];
      const makeup = this.mbMakeups[i];
      if (!comp || !makeup) return;
      if (!autoMakeupOn) this.autoMakeupTrack[i] = 0;
      set(`mb.${i}.t`, comp.threshold, band.thresholdDb);
      set(`mb.${i}.r`, comp.ratio, Math.min(20, Math.max(1, band.ratio * dens.ratioScale)));
      set(
        `mb.${i}.a`,
        comp.attack,
        (Math.max(band.attackMs, 0) * dens.timeScale * (this.speechFast ? 0.5 : 1)) / 1000,
      );
      set(
        `mb.${i}.rel`,
        comp.release,
        (Math.max(band.releaseMs, 10) * dens.timeScale * (this.speechFast ? 0.5 : 1)) / 1000,
      );
      set(
        `mb.${i}.m`,
        makeup.gain,
        dbToGain(band.makeupDb + (autoMakeupOn ? this.autoMakeupTrack[i] : 0)),
      );
    });
    this.crossfade("mb", this.mbWetPre, this.mbDry, params.multiband.on);

    // dynamic EQ: ramp band + detector filters; force α → 0 when bypassed
    params.deq.bands.forEach((band, i) => {
      const det = this.deqDets[i];
      const sub = this.deqSubs[i];
      if (!det || !sub) return;
      setHz(`deq.${i}.af`, this.deqBpAudio[i]?.frequency, band.freqHz);
      setHz(`deq.${i}.df`, this.deqBpDet[i]?.frequency, band.freqHz);
      set(`deq.${i}.aq`, this.deqBpAudio[i]?.Q, Math.max(band.q, 0.05));
      set(`deq.${i}.dq`, this.deqBpDet[i]?.Q, Math.max(band.q, 0.05));
      set(`deq.${i}.t`, det.threshold, band.thresholdDb);
      set(`deq.${i}.a`, det.attack, Math.max(band.attackMs, 1) / 1000);
      set(`deq.${i}.r`, det.release, Math.max(band.releaseMs, 20) / 1000);
      if (!params.deq.on) {
        set(`deq.${i}.sub`, sub.gain, 0, 0.01);
        this.deqCutDb[i] = 0;
      }
    });

    // auto-speech profile: halve the levelling envelopes while mic
    // programme is present (engagement is transition-detected in the meter
    // loop below, so these ramps glide instead of jumping)
    const spd = this.speechFast ? 0.5 : 1;
    // v3.1 multi-profile AGC: the selected profile re-times both windows.
    const profile = adv.leveling.agcProfile;
    const env = profile.on
      ? agcProfileEnvelope(profile, this.speechFast || profile.profile === "speech")
      : null;
    // Dual-window AGC: the fast peak window rides ahead of the slow
    // leveller and has its own threshold, so it acts only on the transients
    // the long release would let through.
    const fast = agcFast(params.agc);
    const fastOn = params.agc.on && fast.on;
    set("agcFast.t", this.agcFastComp.threshold, fastOn ? fast.thresholdDb : 0);
    set("agcFast.r", this.agcFastComp.ratio, fastOn ? Math.min(20, Math.max(1, fast.ratio)) : 1);
    set("agcFast.k", this.agcFastComp.knee, fastOn ? Math.max(0, fast.kneeDb) : 0);
    set("agcFast.a", this.agcFastComp.attack, (Math.max(fast.attackMs, 0.1) * spd) / 1000);
    set("agcFast.rel", this.agcFastComp.release, (Math.max(fast.releaseMs, 20) * spd) / 1000);

    set("agc.t", this.agcComp.threshold, params.agc.thresholdDb);
    set("agc.r", this.agcComp.ratio, params.agc.ratio);
    set("agc.k", this.agcComp.knee, params.agc.kneeDb);
    set(
      "agc.a",
      this.agcComp.attack,
      (env ? env.attackMs : Math.max(params.agc.attackMs, 0) * spd) / 1000,
    );
    set(
      "agc.rel",
      this.agcComp.release,
      (env ? env.releaseMs : Math.max(params.agc.releaseMs, 10) * spd) / 1000,
    );
    set("agc.makeup", this.agcMakeup.gain, dbToGain(params.agc.makeupDb));
    this.crossfade("agc", this.agcWetPre, this.agcDry, params.agc.on);
    this.windowGate.configure({ windowDb: params.agc.windowDb });
    if (!params.agc.on || params.agc.windowDb <= 0) {
      this.agcFrozen = false;
      this.agcSpreadDb = 0;
      set("agc.hold", this.agcHold.gain, 0, 0.02);
      set("agc.wet", this.agcWetOut.gain, 1, 0.02);
    }

    // de-esser: retune the band and detector; a bypass closes the cut
    const deessHz = clampDeessFreq(params.deess.freqHz);
    setHz("deess.f", this.deessBpAudio?.frequency, deessHz);
    setHz("deess.df", this.deessBpDet?.frequency, deessHz);
    // Auto threshold: the tracker in updateDeesser() owns the value; a manual
    // threshold written here is what it falls back to when auto is off.
    set(
      "deess.t",
      this.deessDet?.threshold,
      params.deess.auto
        ? autoDeessThresholdDb(this.deessBandDb)
        : params.deess.thresholdDb,
      0.05,
    );
    set("deess.a", this.deessDet?.attack, Math.max(params.deess.attackMs, 0.1) / 1000);
    set("deess.r", this.deessDet?.release, Math.max(params.deess.releaseMs, 10) / 1000);
    if (!params.deess.on) {
      this.deessCutDb = 0;
      set("deess.sub", this.deessSub?.gain, 0, 0.01);
    }

    // density drives the limiter from the front; the ceiling is untouched
    set("lim.drive", this.limDrive?.gain, params.limiter.on ? dbToGain(dens.driveDb) : 1);
    set("lim.t", this.limComp.threshold, params.limiter.ceilingDb);
    set("lim.a", this.limComp.attack, Math.max(params.limiter.attackMs, 0.1) / 1000);
    this.crossfade("lim", this.limWetPre, this.limDry, params.limiter.on);

    // peak stage: the lookahead worklet when the platform gave us one and the
    // operator chose it, otherwise the native compressor. Both paths stay
    // wired and only their gains move, so switching is a crossfade, not a
    // graph rebuild.
    const useWorklet = limiterEngine(params.limiter) === "worklet" && !!this.workletLimiter;
    this.crossfade("lim.engine", this.limWorklet, this.limNative, useWorklet);
    if (this.workletLimiter) {
      const lookaheadMs = Math.min(10, Math.max(0.5, params.limiter.attackMs));
      const holdMs = Math.min(200, Math.max(0, params.limiter.holdMs ?? 0));
      const key = `${params.limiter.ceilingDb}|${params.limiter.releaseMs}|${holdMs}|${lookaheadMs}`;
      if (key !== this.workletConfig) {
        this.workletConfig = key;
        this.workletLimiter.port.postMessage({
          ceilingDb: params.limiter.ceilingDb,
          releaseMs: params.limiter.releaseMs,
          holdMs,
          lookaheadMs,
        });
      }
    }

    // program limiter: slow second stage with its own ceiling and release
    const prog = limiterProgram(params.limiter);
    set("lim.prog.t", this.progComp?.threshold, prog.ceilingDb);
    set("lim.prog.r", this.progComp?.ratio, params.limiter.on && prog.on ? 4 : 1);
    set("lim.prog.k", this.progComp?.knee, prog.on ? 2 : 0);
    set("lim.prog.a", this.progComp?.attack, Math.max(prog.attackMs, 0.5) / 1000);
    this.applyLimiterEnvelopes();

    // Soft clipper: rebuilds its curve only when the threshold moves, then
    // blends wet/dry by the mix control. Bypassed (dry only) by default.
    const clip = limiterClipper(params.limiter);
    if (clip.thresholdDb !== this.clipThresholdDb) {
      this.rebuildClipCurve(clip.thresholdDb);
    }
    const clipMix = Math.min(1, Math.max(0, clip.mix / 100));
    const clipOn = params.limiter.on && clip.on;
    set("clip.wet", this.clipWet.gain, clipOn ? clipMix : 0, 0.02);
    set("clip.dry", this.clipDry.gain, clipOn ? 1 - clipMix : 1, 0.02);

    // post-limiter pre-emphasis correction
    const pre = adv.limiter.preEmph;
    const preFix = preEmphCorrection(pre);
    setHz("preemph.f", this.preEmphShelf.frequency, preFix.freqHz);
    set("preemph.g", this.preEmphShelf.gain, pre.apply === "after" ? preFix.gainDb : 0);

    // codec perceptual pre-shaping low-pass
    setHz(
      "codec.lp",
      this.codecLp.frequency,
      codecLowpassHz(adv.limiter.codec, this.streamBitrateKbps),
      0.05,
    );

    // L/R channel matching trims
    const match = adv.compliance.channelMatch;
    const trims = match.on ? channelTrim(match.levelTrimDb) : { l: 1, r: 1 };
    set("ch.l", this.chTrimL.gain, trims.l, 0.05);
    set("ch.r", this.chTrimR.gain, trims.r, 0.05);

    // composite ceiling guard follows the limiter ceiling
    if (params.limiter.ceilingDb !== this.guardCeilingDb) {
      this.rebuildGuardCurve(params.limiter.ceilingDb);
    }
    this.crossfade("guard", this.guardWet, this.guardDry, params.limiter.on);

    // harmonic exciter
    setHz("ex.f1", this.exBp1?.frequency, params.exciter.freqHz);
    setHz("ex.f2", this.exBp2?.frequency, params.exciter.freqHz * 1.7);
    set("ex.mix", this.exMix?.gain, params.exciter.on ? (params.exciter.mix / 100) * 0.5 : 0);

    // low-band reinforcement (psychoacoustic bass module)
    const bass = params.psy.bassSynth;
    const bassHz = Math.min(220, Math.max(40, bass.fundHz * 2));
    setHz("bass.f1", this.bass1?.frequency, bassHz);
    setHz("bass.f2", this.bass2?.frequency, bassHz);
    set("bass.drive", this.bassDrive?.gain, 1 + (Math.min(100, Math.max(0, bass.depth)) / 100) * 3);
    set(
      "bass.mix",
      this.bassMix?.gain,
      bass.on ? (Math.min(100, Math.max(0, bass.harmMix)) / 100) * 0.35 : 0,
    );

    // stereo width: engage the M/S matrix only away from unity so the dry
    // path (exact for mono sources) stays in circuit at width = 1
    const widen = Math.abs(params.stereo.width - 1) > 0.01;
    set("width.gain", this.widthGain?.gain, params.stereo.width);
    this.crossfade("width", this.widthWet, this.widthDry, widen);

    // per-band side width (psy.cohWidth): bass to mono, air wider. Widening is
    // scaled back as correlation falls, so a hollow image cannot be made
    // worse; narrowing (bass mono) is never limited.
    const cw = params.psy.cohWidth;
    const safety = coherenceSafety(this.snapshotValue.correlation, cw.corrGuard);
    this.cwBands.forEach((band, i) => {
      const width = cw.on ? safeWidth(cw.bands[i] ?? 1, safety) : 1;
      set(`cw.${i}`, band.gain, width);
    });
    this.crossfade("cw", this.cwWet, this.cwDry, cw.on);

    // M/S matrix trim (psy.msTrim): mid/side balance plus a side HPF, so the
    // side channel can be cleaned of low-end build-up without touching mid.
    const ms = params.psy.msTrim;
    set("ms.mid", this.midTrim?.gain, ms.on ? dbToGain(ms.midDb) : 1);
    set("ms.side", this.sideTrim?.gain, ms.on ? dbToGain(ms.sideDb) : 1);
    setHz("ms.hpf", this.sideHpf?.frequency, Math.min(1000, Math.max(20, ms.sideHpfHz)));
    this.crossfade("ms.hpf", this.sideHpfWet, this.sideHpfDry, ms.on);
    // low-end mono: 0 = off, otherwise fold side-bass below the crossover
    const lm = Math.min(500, Math.max(0, params.stereo.lowMonoHz ?? 120));
    setHz("side.lp", this.sideLp?.frequency, Math.max(40, lm || 120), 0.01);
    this.crossfade("side", this.sideWet, this.sideDry, lm > 0);

    set(
      "output",
      this.outputGain.gain,
      dbToGain(params.outputGainDb + dimDb(adv.limiter.output)),
    );
    this.applyMonitorGain();

    // safety mute state survives parameter re-application
    set("safety", this.safetyGain?.gain, this.safetyMute ? 0 : 1, 0.02);
    // ── v3.0 psychoacoustic layer ──
    // latency profile: low drops the ceiling guard to 2× oversampling;
    // balanced and max both run the full 4× path (max additionally hosts
    // staged oversampled modules as they land).
    this.setLowLatency(params.psy.latency === "low" || adv.latency === "low");
    // perceptual tilt: slope = treble-minus-bass pivot 1 kHz, split evenly
    // across the two shelves. Off / 0 dB = exact unity.
    const slope =
      (params.psy.tilt.on ? params.psy.tilt.slopeDb : 0) +
      (adv.eq.shelves.on ? adv.eq.shelves.tiltDb : 0);
    set("tilt.lo", this.tiltLo?.gain, -slope / 2, 0.03);
    set("tilt.hi", this.tiltHi?.gain, slope / 2, 0.03);
    // every other psy module is STORED (parameter-complete, no DSP yet):
    // engaged or not, the graph above is the whole audible path.
  }

  /** Monitor level, honouring the operator mute that survives re-applies. */
  /**
   * Tell the delivery path which mount bitrate is live. Below 96 kbps the
   * codec low-pass drops to 16 kHz without touching the monitoring chain.
   */
  setStreamBitrate(kbps: number | null): void {
    const next =
      kbps != null && Number.isFinite(kbps) && kbps > 0 ? kbps : null;
    if (next === this.streamBitrateKbps) return;
    this.streamBitrateKbps = next;
    if (this.params && this.powered) this.applyChain(this.params);
  }

  private applyMonitorGain() {
    this.setNum(
      "monitor",
      this.monitorGain?.gain,
      this.monitorMuted || this.handoffMuted
        ? 0
        : dbToGain(this.params?.monitorDb ?? -6),
    );
    // Monitor checks: mono fold and per-channel polarity, monitor path only.
    const mon = this.params?.monitor;
    this.setNum("mon.mono", this.monMono?.gain, mon?.mono ? 1 : 0, 0.01);
    this.setNum("mon.l", this.monL?.gain, mon?.mono ? 0 : mon?.invertL ? -1 : 1, 0.01);
    this.setNum("mon.r", this.monR?.gain, mon?.mono ? 0 : mon?.invertR ? -1 : 1, 0.01);
  }

  /**
   * Limiter releases: the configured value, adapted to programme density and
   * frozen for the hold window after a real reduction.
   *
   * A Web Audio DynamicsCompressor has no adjustable lookahead, so none is
   * claimed here. What is real: a slow program stage with its own ceiling,
   * density-adapted releases, and a hold that stops short peaks breathing.
   */
  private applyLimiterEnvelopes() {
    const params = this.params;
    if (!params || !this.ctx) return;
    const lim = params.limiter;
    const prog = limiterProgram(lim);
    const now = performance.now();
    const peakGr = Math.max(0, -(this.limComp?.reduction ?? 0));
    const progGr = Math.max(0, -(this.progComp?.reduction ?? 0));
    if ((lim.holdMs ?? 0) > 0 && Math.max(peakGr, progGr) > 1.5) {
      const hold = Math.min(200, Math.max(20, lim.holdMs ?? 0));
      this.limiterHoldUntil = Math.max(this.limiterHoldUntil, now + hold);
    }
    const holding = now < this.limiterHoldUntil;
    const crest = this.snapshotValue.samplePeakDb - this.snapshotValue.lufsS;
    const peakRelease = holding
      ? 1500
      : dynamicReleaseMs(lim.releaseMs, crest, peakGr, !!lim.adaptive);
    this.setNum(
      "lim.rel",
      this.limComp?.release,
      Math.min(2000, Math.max(10, peakRelease)) / 1000,
      0.05,
    );
    const progRelease = holding
      ? 2200
      : dynamicReleaseMs(prog.releaseMs, crest, progGr, !!lim.adaptive);
    this.setNum(
      "lim.prog.rel",
      this.progComp?.release,
      Math.min(3000, Math.max(20, progRelease)) / 1000,
      0.05,
    );
  }

  /** Low-latency profile: lighter 2× oversampling on the ceiling guard. */
  setLowLatency(low: boolean) {
    this.lowLatency = low;
    if (this.guardShaper) this.guardShaper.oversample = low ? "2x" : "4x";
  }

  private crossfade(key: string, wet: GainNode, dry: GainNode, on: boolean) {
    if (!wet || !dry) return; // teardown race: nodes not (or no longer) built
    this.setNum(`${key}.wet`, wet.gain, on ? 1 : 0, 0.015);
    this.setNum(`${key}.dry`, dry.gain, on ? 0 : 1, 0.015);
  }

  /**
   * v3.1 harmonic generator curve: a parallel shaper with independent even and
   * odd weights. The even term is dc-free (`x² − ⅓`), and the high-pass that
   * follows the restoration block removes the residual offset.
   */
  private rebuildRestCurve(harmonics: AdvancedParams["restoration"]["harmonics"]) {
    if (!this.restHarmShaper) return;
    const mix = harmonicMix(harmonics.even, harmonics.odd);
    const drive = 1 + (Math.min(100, Math.max(0, harmonics.drive)) / 100) * 4;
    const tilt = harmonics.band === "low" ? 0.5 : harmonics.band === "high" ? 1.5 : 1;
    const n = 2049;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (-1 + (2 * i) / (n - 1)) * drive;
      const evenTerm = (x * x - 1 / 3) * 1.5;
      const oddTerm = x * x * x;
      const y = x + mix.even * evenTerm * tilt + mix.odd * oddTerm * tilt;
      curve[i] = Math.max(-1, Math.min(1, y));
    }
    this.restHarmShaper.curve = curve;
  }

  /** Watchdog mute on the delivery bus (monitor and encoder both go quiet). */
  setSafetyMute(on: boolean) {
    this.safetyMute = on;
    if (this.safetyGain) {
      this.setNum("safety", this.safetyGain.gain, on ? 0 : 1, 0.02);
    }
  }

  get safetyMuted(): boolean {
    return this.safetyMute;
  }

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

  /**
   * Safety ceiling: unity until the last ~2 dB, then a smooth bend into the
   * ceiling. The previous transfer was `ceil·tanh(x/ceil)` across the whole
   * range, which is a compressor — it cost about a decibel at −6 dBFS and
   * added third harmonic at every level the chain ever produced.
   */
  private rebuildGuardCurve(ceilingDb: number) {
    if (!this.guardShaper) return;
    this.guardShaper.curve = softCeilingCurve(ceilingDb);
    this.guardCeilingDb = ceilingDb;
  }

  setMonitorDb(db: number) {
    if (this.monitorMuted) return;
    this.setNum("monitor", this.monitorGain?.gain, dbToGain(db));
  }

  setMonitorMuted(muted: boolean) {
    this.monitorMuted = muted;
    this.applyMonitorGain();
    // The mute lives on the engine, so every view that draws it has to hear
    // about the change — a panel that keeps its own copy can silently show
    // "Listen" while the monitor bus is at zero.
    this.notify();
  }

  get monitorMutedNow(): boolean {
    return this.monitorMuted;
  }

  /**
   * The monitor path as it actually stands, for surfaces outside the monitor
   * panel.
   *
   * `gainDb` is read from the bus itself, so it includes the operator mute and
   * any fade in flight — unlike `params.monitorDb`, which is only what the
   * console was asked to do. A header that shows the parameter instead of the
   * node can read "-6 dB" while the speakers are at zero, which is the whole
   * failure this describes.
   */
  get monitorState(): {
    muted: boolean;
    gainDb: number;
    sink: string;
    sinkLabel: string;
  } {
    const gain = this.monitorGain?.gain.value;
    return {
      muted: this.monitorMuted,
      gainDb:
        typeof gain === "number" && gain > 0
          ? 20 * Math.log10(Math.min(1e3, gain))
          : -Infinity,
      sink: this.outputDeviceId,
      // A pick the current enumeration has not labelled yet is still a pick,
      // not the OS default: say so instead of claiming the wrong endpoint.
      sinkLabel:
        this.selectedOutput?.label ??
        (this.outputDeviceId ? "Chosen output" : "System default"),
    };
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
   * Switch inputs behind a short fade, and make sure exactly one source is
   * connected afterwards: the generator is stopped, the microphone released,
   * the file paused — whichever of them is not the new source.
   */
  async setSource(kind: SourceKind): Promise<void> {
    this.sourceKind = kind;
    this.saveDevicePrefs();
    this.notify();
    if (!this.ctx) return; // powerOn starts the source
    this.activate(kind);
  }

  private activate(kind: SourceKind) {
    const token = ++this.sourceToken;
    if (!this.ctx || !this.powered || !this.graphReady) {
      this.startSource(kind);
      return;
    }
    this.fadeBus(0);
    globalThis.setTimeout(() => {
      if (token !== this.sourceToken || !this.powered) return;
      this.startSource(kind);
      // The microphone opens asynchronously and opens its own bus once the
      // new track is live; every other source is connected by the time this
      // line runs.
      if (kind !== "mic") this.ensureBusOpen();
    }, SOURCE_FADE_MS);
  }

  /**
   * Program-bus fade. Linear, so it lands on exact zero: the old source has
   * to be in silence *before* it is disconnected, or the disconnect is a step
   * down from the residual of an exponential approach.
   */
  private fadeBus(target: number) {
    const ctx = this.ctx;
    if (!ctx || !this.graphReady || !this.sourceBus) return;
    rampTo(this.sourceBus.gain, target, ctx.currentTime);
  }

  private startSource(kind: SourceKind) {
    // Leaving the microphone makes any queued input swap stale: its fade-in
    // must not reopen a bus the operator has already switched away from.
    if (kind !== "mic") this.deviceToken += 1;
    if (kind !== "mic") this.releaseMic();
    if (kind !== "signal") this.stopSignal();
    if (kind !== "file") this.pauseFile();
    if (kind === "signal") this.startSignal();
    if (kind === "mic") void this.openMic();
    if (kind === "file" && this.fileBuffer) this.startFile();
  }

  private startSignal() {
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
      this.notify();
      return;
    }

    // looped stereo pink noise at −18 dBFS RMS — exercises every band. The
    // buffer is cached per sample rate: rebuilding it on every source switch
    // blocked the main thread for tens of milliseconds.
    let buf = this.pinkBuffer;
    if (!buf || buf.sampleRate !== ctx.sampleRate) {
      buf = this.buildPinkNoise(ctx);
      this.pinkBuffer = buf;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.connect(gain);
    src.start();
    this.signalOsc = src;
    this.notify();
  }

  /** Six seconds of stereo pink noise, normalised to −18 dBFS RMS. */
  private buildPinkNoise(ctx: AudioContext): AudioBuffer {
    const buf = ctx.createBuffer(2, Math.floor(ctx.sampleRate * 6), ctx.sampleRate);
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
    return buf;
  }

  private stopSignal() {
    if (!this.signalOsc) return;
    const osc = this.signalOsc;
    this.signalOsc = null;
    try {
      osc.stop();
    } catch {
      /* already stopped */
    }
    osc.disconnect();
    this.signalGain?.disconnect();
    this.signalGain = null;
    this.notify();
  }

  async setSignalMode(mode: SignalMode) {
    this.signalMode = mode;
    // Only rebuild a generator that is actually on the bus. While a source
    // switch is fading, the pending startSource() will use the new mode.
    if (this.ctx && this.sourceKind === "signal" && this.generatorOn) {
      this.startSignal();
    }
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

  /* ── microphone ───────────────────────────────────────────────────────── */

  private micConstraints(deviceId: string): MediaStreamConstraints {
    return {
      audio: {
        // The chain is the only processor: browser DSP would fight it.
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: { ideal: 2 },
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      },
    };
  }

  /**
   * Put the microphone on air. Arming is also a routing decision: the old
   * engine armed the device but left the generator as the program source, so
   * the operator heard pink noise while the panel said "live input".
   */
  async armMic(): Promise<void> {
    if (this.sourceKind !== "mic") {
      this.sourceKind = "mic";
      this.saveDevicePrefs();
      this.notify();
      if (this.ctx) this.activate("mic");
    }
    if (!this.ctx) await this.powerOn();
    if (!this.ctx) {
      this.micStatus = "error";
      this.notify();
      return;
    }
    await this.openMic();
  }

  private openMic(): Promise<void> {
    if (this.micNode && this.micStream) {
      if (this.micStatus !== "on") {
        this.micStatus = "on";
        this.notify();
      }
      this.ensureBusOpen();
      return Promise.resolve();
    }
    if (this.micArm) return this.micArm;
    const run = this.doOpenMic().finally(() => {
      if (this.micArm === run) this.micArm = null;
    });
    this.micArm = run;
    return run;
  }

  private async doOpenMic(): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) return;
    const token = ++this.micToken;
    this.micStatus = "arming";
    this.notify();
    const wanted = this.inputDeviceId;
    let openedWith = wanted;
    try {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia(this.micConstraints(wanted));
      } catch (err) {
        if (token !== this.micToken) return;
        // No pick at all means the OS default itself failed — that is a real
        // error, not a missing device to fall back from.
        if (!wanted) throw err;
        // Chosen device gone (unplugged?) — fall back to the OS default
        // rather than leaving the operator with a dead input. Forget the
        // dead pick too, so the next boot does not restore it.
        this.inputDeviceId = "";
        openedWith = "";
        this.saveDevicePrefs();
        stream = await navigator.mediaDevices.getUserMedia(this.micConstraints(""));
      }
      // A newer pick (or a disarm) owns the microphone now.
      if (token !== this.micToken || this.sourceKind !== "mic" || !this.ctx) {
        stopStream(stream);
        return;
      }
      this.micStream = stream;
      const track = stream.getAudioTracks()[0];
      this.micLabel = track?.label || "Microphone";
      track?.addEventListener?.("ended", this.onMicTrackEnded);
      this.micNode = this.ctx.createMediaStreamSource(stream);
      this.micNode.connect(this.sourceBus);
      this.micStatus = "on";
      this.notify();
      // The bus opens only now, with a live track behind it — not when the
      // arm was requested. A getUserMedia that takes 300 ms used to be a
      // 300 ms window in which the console faded programme up over nothing.
      this.ensureBusOpen();
      // Permission granted → real device labels are visible now.
      void this.refreshDevices();
      // The operator may have picked another input while getUserMedia was
      // still resolving. The winning device is always the latest pick.
      if (this.inputDeviceId !== openedWith && token === this.micToken) {
        this.releaseMic();
        void this.openMic();
      }
    } catch {
      if (token !== this.micToken) return;
      this.micStream = null;
      this.micNode = null;
      this.micStatus = "error";
      this.notify();
    }
  }

  /**
   * Device unplugged mid-show. The track is gone, so the source must go too —
   * but leaving the console armed on a dead input is the one failure the
   * meters cannot show, so the input is re-opened on whatever is left (the
   * OS default, after the pick is reconciled).
   */
  private onMicTrackEnded = () => {
    if (this.sourceKind !== "mic") return;
    const wasLive = this.micStatus === "on";
    this.releaseMic();
    this.notify();
    if (wasLive && this.ctx && this.powered) {
      void this.queueDeviceSwap((gen) => this.swapInput(gen));
    }
  };

  /** Tear the microphone down without touching the rest of the graph. */
  private releaseMic() {
    this.micToken += 1;
    this.micArm = null;
    this.micNode?.disconnect();
    this.micNode = null;
    if (this.micStream) {
      for (const track of this.micStream.getTracks()) {
        track.removeEventListener?.("ended", this.onMicTrackEnded);
        track.stop();
      }
    }
    this.micStream = null;
    this.micLabel = "";
    this.micStatus = "idle";
  }

  disarmMic() {
    this.releaseMic();
    this.notify();
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
    if (this.sourceKind === "file") this.startFile();
    this.notify();
  }

  /** Transport play. Pressing play on a loaded file also selects it. */
  playFile() {
    if (this.sourceKind !== "file") {
      void this.setSource("file");
      return;
    }
    this.startFile();
  }

  private startFile() {
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
      /* already stopped */
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
      this.startFile();
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

  /* ── physical I/O devices ─────────────────────────────────────────────── */

  /**
   * List the OS input/output devices. Labels stay blank until mic permission
   * is granted (browser privacy rule), so entries fall back to numbered
   * names and the list refreshes itself after every successful arm. A list
   * with no usable ids (pre-permission) never invalidates a saved pick.
   */
  async refreshDevices(): Promise<void> {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      const listing = listDevices(all);
      this.inputDevices = listing.inputs;
      this.outputDevices = listing.outputs;
      const input = reconcileSelection(
        this.inputDeviceId,
        listing.inputs,
        listing.inputsIdentified,
      );
      const output = reconcileSelection(
        this.outputDeviceId,
        listing.outputs,
        listing.outputsIdentified,
      );
      if (input !== this.inputDeviceId || output !== this.outputDeviceId) {
        this.inputDeviceId = input;
        this.outputDeviceId = output;
        this.saveDevicePrefs();
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
    void this.refreshDevices().then(() => {
      if (!this.ctx) return;
      // The chosen monitor sink went away. refreshDevices has already
      // reconciled the pick, but the context is still rendering into the dead
      // endpoint — re-apply or the console is live with no sound at all.
      if (this.outputDeviceId !== this.appliedSink) {
        void this.queueDeviceSwap(() => this.applyOutputDevice());
      }
    });
  };

  /**
   * Run one device lifecycle at a time, newest pick wins.
   *
   * A pick only sets a token; the task checks it after every await. A swap
   * that was overtaken while it was waiting for getUserMedia therefore bails
   * out instead of connecting a second source or reverting a sink the newer
   * swap has already moved. The queue itself is a promise chain, so the
   * teardown of one swap can never interleave with the setup of the next.
   */
  private queueDeviceSwap(task: (gen: number) => Promise<void>): Promise<void> {
    const gen = ++this.deviceToken;
    const run = this.swapArm.then(
      () => (gen === this.deviceToken ? task(gen) : undefined),
      () => (gen === this.deviceToken ? task(gen) : undefined),
    );
    this.swapArm = run.catch(() => undefined);
    return run;
  }

  /**
   * Forget every decision the previous endpoint produced.
   *
   * The source nodes own their buffers and are stopped by releaseMic, but
   * what survives a swap is the chain's *state*: the ramp cache (which would
   * suppress the first write to every node), the AGC window and its frozen
   * hold, the gate hold, the limiter's frozen release, and the worklet's
   * lookahead line. Carried into a new device at a different level, those
   * are heard as a slam, a stuck gate or a burst — so they are flushed here,
   * once, before the new endpoint is patched in.
   */
  private resetSignalState(): void {
    // Drop the cache *before* re-applying: with it cleared, every node is
    // written with the current parameter set instead of being skipped as
    // "already at that value" from the old device's take.
    this.written.clear();
    this.windowGate.reset();
    this.agcFrozen = false;
    this.agcSpreadDb = 0;
    this.agcHoldGainDb = 0;
    this.gateOpen = true;
    this.gateCloseAt = 0;
    this.limiterHoldUntil = 0;
    this.workletGr = 0;
    this.deessCutDb = 0;
    this.deqCutDb = [0, 0, 0, 0, 0];
    this.crestDrive = 0;
    this.clipInUntil = 0;
    this.clipOutUntil = 0;
    this.resetLoudness();
    this.corrHistory.fill(1);
    this.corrWrite = 0;
    // The lookahead line is the one buffer the UI cannot reach: flush it on
    // the audio thread, between quanta, with the kernel's own reset.
    this.workletLimiter?.port.postMessage({ reset: true });
    if (this.params) this.apply(this.params);
  }

  /** Fade the programme bus back in once a source is connected again. */
  private ensureBusOpen(): void {
    if (!this.powered || !this.graphReady) return;
    // Only against a clock. A context that is resumed but still renegotiating
    // hands the fade to a buffer nothing is reading; `onstatechange` reopens
    // the bus on the first state that can carry audio.
    if (this.ctx?.state !== "running") return;
    this.fadeBus(1);
  }

  /**
   * Hot-swap the microphone: fade, release, flush, open, fade back.
   *
   * The fade is what keeps a hard disconnect out of the programme, and the
   * settle after it is what empties the filters: with the source gone the
   * chain sees silence for a couple of fade lengths, so every biquad's
   * history (and the compressor's envelope) has decayed before the new
   * device — possibly at a very different level — is patched in.
   */
  private async swapInput(gen: number): Promise<void> {
    const ctx = this.ctx;
    if (!ctx || this.sourceKind !== "mic") return;
    this.micStatus = "arming";
    this.notify();

    const live = this.powered && this.graphReady;
    if (live) {
      this.fadeBus(0);
      await waitMs(SOURCE_FADE_MS);
      if (gen !== this.deviceToken) return this.ensureBusOpen();
    }

    this.releaseMic();
    this.resetSignalState();
    if (live) {
      // Silence-only settle: the old stream is stopped, so this is the point
      // where delay lines and filter histories drain.
      await waitMs(SOURCE_FADE_MS);
      if (gen !== this.deviceToken) return this.ensureBusOpen();
    }

    if (gen !== this.deviceToken || this.ctx !== ctx) return;
    await this.openMic();
    // The bus is opened by doOpenMic once the new track is live; a swap that
    // lost the race must not reopen it under a source it did not open.
    if (gen !== this.deviceToken || this.ctx !== ctx) return;
    this.notify();
  }

  /** Switch inputs; re-arms live so the new device takes over immediately. */
  setInputDevice(id: string) {
    if (id === this.inputDeviceId) return;
    this.inputDeviceId = id;
    this.saveDevicePrefs();
    this.notify();
    if (this.sourceKind !== "mic" || !this.ctx) return;
    void this.queueDeviceSwap((gen) => this.swapInput(gen));
  }

  /** Route the monitor bus to the chosen speakers/headphones. */
  setOutputDevice(id: string) {
    if (id === this.outputDeviceId) return;
    this.outputDeviceId = id;
    this.saveDevicePrefs();
    this.notify();
    void this.queueDeviceSwap(() => this.applyOutputDevice());
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
    if (!ctx) return;
    if (typeof ctx.setSinkId !== "function") {
      this.sinkState = "unsupported";
      return;
    }
    const wanted = this.outputDeviceId;
    // Boot hands both of these an empty sink: the context already renders to
    // the OS default, so there is nothing to switch and the monitor must not
    // be taken down for it.
    if (wanted === this.appliedSink && wanted === "") return;
    // A live setSinkId restarts the output stream. That restart is a click at
    // best and, on a device with a different hardware buffer, a burst of
    // uninitialised frames — so the monitor bus is faded out first. The
    // encoder send taps duckGain upstream, so muting the monitor cannot take
    // the programme off air.
    const live = this.powered && this.graphReady && ctx.state === "running";
    try {
      if (live) {
        this.handoffMuted = true;
        this.rampMonitor(0);
        // The ramp clears the graph; the endpoint still holds the frames it
        // was handed before it. Touching the device before those have played
        // is the truncated half-buffer at the head of the burst.
        await waitMs(rampWaitMs() + outputLatencyMs(ctx));
        // A newer pick owns the sink now; its own swap does the work.
        if (this.outputDeviceId !== wanted) return;
      }
      const switched = await this.switchSink(ctx, wanted);
      if (switched === "ok") {
        // The promise resolves when the endpoint is open, not when its first
        // buffers have settled. Give them somewhere to go before programme
        // is let back through.
        await waitMs(ENDPOINT_SETTLE_MS);
        this.appliedSink = wanted;
        this.sinkState = wanted ? "applied" : "default";
        return;
      }
      if (switched === "pending") {
        // The call is still in flight. Everything the console knows is left
        // as it was, so the next device event retries it — but the monitor
        // is let back through now rather than waiting on a promise that may
        // never answer.
        this.sinkState = "pending";
        return;
      }
      // The device vanished between enumeration and the switch. Drop back to
      // the OS default and say so, rather than leaving the panel claiming a
      // sink nothing is routed to. A closed context is not a dead device, and
      // a suspended one may just refuse the call until it resumes — neither
      // is evidence that the operator picked the wrong speaker.
      if (!wanted || ctx.state === "closed") return;
      if (ctx.state !== "running") return;
      if (this.outputDeviceId !== wanted) return; // a newer pick owns the sink
      this.sinkState = "refused";
      this.noteFault(
        `The output “${this.monitorState.sinkLabel}” refused to open — falling back to the system default.`,
      );
      this.outputDeviceId = "";
      this.saveDevicePrefs();
      if ((await this.switchSink(ctx, "")) === "ok") this.appliedSink = "";
      this.notify();
    } finally {
      // Restore through the ramp cache, so the next parameter apply knows the
      // monitor is back at its programmed level. The hand-off flag is cleared
      // first: it exists to keep a parameter apply from cancelling the mute,
      // not to outlive the swap.
      this.handoffMuted = false;
      this.applyMonitorGain();
    }
  }

  /**
   * Ramp the monitor bus and record the destination, so the write cache the
   * parameter path relies on stays honest about where the bus ended up.
   */
  private rampMonitor(target: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.monitorGain) return;
    rampTo(this.monitorGain.gain, target, ctx.currentTime);
    this.written.set("monitor", target);
  }

  /**
   * One sink switch, bounded.
   *
   * "ok" and "refused" are the promise's own answers; "pending" means the
   * call outlived SINK_SWITCH_TIMEOUT_MS and was abandoned. A rejection that
   * arrives after the timeout has already been consumed by the race, so no
   * unhandled rejection escapes when the caller walks away.
   */
  private async switchSink(
    ctx: AudioContext & { setSinkId?: (sinkId: string) => Promise<void> },
    id: string,
  ): Promise<"ok" | "refused" | "pending"> {
    try {
      return await Promise.race([
        ctx.setSinkId!(id).then(
          () => "ok" as const,
          () => "refused" as const,
        ),
        waitMs(SINK_SWITCH_TIMEOUT_MS).then(() => "pending" as const),
      ]);
    } catch {
      return "refused";
    }
  }

  /** The selected input, or undefined for the OS default. */
  get selectedInput(): AudioDevice | undefined {
    return this.inputDevices.find((d) => d.id && d.id === this.inputDeviceId);
  }

  /** The selected monitor sink, or undefined for the OS default. */
  get selectedOutput(): AudioDevice | undefined {
    return this.outputDevices.find((d) => d.id && d.id === this.outputDeviceId);
  }

  /** The chosen monitor is a virtual/loopback endpoint — inaudible locally. */
  get monitorIsVirtual(): boolean {
    const label = this.selectedOutput?.label ?? "";
    return isVirtualDevice(label);
  }

  /**
   * The program input and the monitor sink are two sides of one endpoint, so
   * the chain would feed back into itself. Surfaced in the devices panel.
   */
  get feedbackRisk(): boolean {
    return isFeedbackLoop(this.selectedInput, this.selectedOutput);
  }

  /* ── metering ─────────────────────────────────────────────────────────── */

  private startMeterLoop() {
    if (this.raf) return;
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      this.meterFrame();
    };
    this.raf = requestAnimationFrame(loop);
  }

  private cancelMeterLoop() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  /**
   * One meter tick.
   *
   * The steering work (silence gate, AGC window, de-esser, dynamic EQ) runs
   * every frame: those loops close on measurements, and skipping a frame is
   * audible as a stepped gate or a de-esser that lets a sibilant through.
   * The expensive work — true peak, K-weighted loudness, gating blocks — runs
   * on its own slower clock, and slows down further if it starts costing real
   * main-thread time.
   */
  private meterFrame() {
    const ctx = this.ctx;
    if (!ctx || !this.powered || !this.graphReady) return;
    const now = performance.now();

    this.controlTick(now);

    if (now - this.lastHeavyAt >= this.heavyIntervalMs) {
      this.lastHeavyAt = now;
      this.heavyTick(now);
    }

    if (++this.frame % 3 === 0) this.notify();
  }

  /** Every-frame control loop over measured levels. */
  private controlTick(now: number) {
    const ctx = this.ctx;
    if (!ctx) return;

    // input peaks
    this.inAnalyserL.getFloatTimeDomainData(this.inBufL);
    this.inAnalyserR.getFloatTimeDomainData(this.inBufR);
    this.inPeakL = peakDb(this.inBufL);
    this.inPeakR = peakDb(this.inBufR);
    if (Math.max(this.inPeakL, this.inPeakR) > -70) this.lastProgramAt = now;
    if (Math.max(this.inPeakL, this.inPeakR) > -0.2) this.clipInUntil = now + CLIP_HOLD_MS;

    // raw programme level, measured ahead of the gate — the value the
    // dead-air detector, the failover state machine and the window gate read
    this.gateAnalyser.getFloatTimeDomainData(this.gateBuf);
    const srcLevelDb = peakDb(this.gateBuf);
    this.srcLevelDb = srcLevelDb;
    if (srcLevelDb > -70) this.lastProgramAt = now;

    const advGate = this.params?.advanced?.leveling.gate;
    const gate = this.params?.gate;
    let gateWantOpen = true;
    if (advGate?.on) {
      // v3.1 lookahead gate: graded close per the release curve, with a hold
      // and hysteresis band so a level sitting on the threshold cannot
      // chatter.
      const decision = gateGainTarget(srcLevelDb, this.gateOpen, advGate);
      gateWantOpen = decision.open;
      const closing = decision.gain < this.gateGain.gain.value;
      this.setNum(
        "gate",
        this.gateGain.gain,
        decision.gain,
        closing ? Math.max(0.005, advGate.lookaheadMs / 1000) : 0.05,
      );
      this.gateOpen = decision.open;
    } else {
      if (gate?.on && !advGate?.on) {
        if (srcLevelDb >= gate.thresholdDb) {
          this.gateCloseAt = 0;
        } else if (this.gateCloseAt === 0) {
          this.gateCloseAt = now + gate.holdMs;
        } else {
          gateWantOpen = now < this.gateCloseAt;
        }
      } else {
        this.gateCloseAt = 0;
      }
      if (gateWantOpen !== this.gateOpen) {
        this.gateOpen = gateWantOpen;
        this.setNum("gate", this.gateGain.gain, gateWantOpen ? 1 : 0, gateWantOpen ? 0.03 : 0.05);
      }
    }

    this.updateAgcWindow(now, srcLevelDb);
    this.updateDeesser();
    this.updateDynamicEq();
    // Limiter hold + density-adapted release close on the live reduction.
    this.applyLimiterEnvelopes();
  }

  /** ── AGC window gate: hold the leveller while the programme is steady ── */
  private updateAgcWindow(now: number, srcLevelDb: number) {
    const params = this.params;
    if (!params) return;
    if (params.agc.on && params.agc.windowDb > 0) {
      const reading = this.windowGate.update(srcLevelDb, now);
      this.agcSpreadDb = reading.spreadDb;
      this.agcFrozen = reading.frozen;
      if (reading.frozen) {
        // leave the hold gain where the last unfrozen tick put it: that is
        // the freeze. The compressor keeps running, muted, so the release is
        // just a crossfade back to wherever it has since travelled.
        this.setNum("agc.wet", this.agcWetOut.gain, 0, 0.02);
      } else {
        const reduction = this.agcComp.reduction ?? 0;
        this.agcHoldGainDb = params.agc.makeupDb + reduction;
        this.setNum("agc.hold", this.agcHold.gain, dbToGain(this.agcHoldGainDb), 0.02);
        this.setNum("agc.wet", this.agcWetOut.gain, 1, 0.02);
      }
    } else if (this.agcFrozen) {
      this.agcFrozen = false;
      this.agcSpreadDb = 0;
      this.windowGate.reset();
      this.setNum("agc.hold", this.agcHold.gain, 0, 0.02);
      this.setNum("agc.wet", this.agcWetOut.gain, 1, 0.02);
    }
  }

  /** ── de-esser: control-rate cut over the sibilance band ── */
  private updateDeesser() {
    const params = this.params;
    if (!params) return;
    if (params.deess.auto && this.deessBandAnalyser) {
      this.deessBandAnalyser.getFloatTimeDomainData(this.deessBandBuf);
      const db = 10 * Math.log10(Math.max(1e-12, meanSquare(this.deessBandBuf)));
      // A ~2 s tracker: one loud cymbal must not move the reference the next
      // one is measured against, but a change of source should follow quickly.
      this.deessBandDb =
        this.deessBandDb <= -119
          ? db
          : this.deessBandDb + (db - this.deessBandDb) * 0.03;
      if (params.deess.on) {
        this.setNum(
          "deess.t",
          this.deessDet?.threshold,
          autoDeessThresholdDb(this.deessBandDb),
          0.2,
        );
      }
    }
    if (params.deess.on && this.deessDet) {
      const over = Math.max(0, -(this.deessDet.reduction || 0));
      const cut = Math.min(params.deess.maxCutDb, over);
      this.deessCutDb = cut;
      this.setNum("deess.sub", this.deessSub.gain, deessAlpha(cut), 0.006);
    } else if (this.deessCutDb !== 0) {
      this.deessCutDb = 0;
      this.setNum("deess.sub", this.deessSub?.gain, 0, 0.01);
    }
  }

  /** ── dynamic EQ: cut follows the detector envelopes ── */
  private updateDynamicEq() {
    const params = this.params;
    if (!params?.deq.on) return;
    params.deq.bands.forEach((band, i) => {
      const det = this.deqDets[i];
      const sub = this.deqSubs[i];
      if (!det || !sub) return;
      const over = Math.max(0, -(det.reduction || 0));
      const cut = Math.min(band.maxCutDb, over);
      this.deqCutDb[i] = cut;
      // subtracting α of the band ≈ a cut of −20·log10(1−α) at its centre
      const alpha = 1 - Math.pow(10, -cut / 20);
      this.setNum(`deq.${i}.sub`, sub.gain, alpha, 0.008);
    });
  }

  /**
   * Automatic multiband makeup.
   *
   * Each band's makeup is normally a preset number, so a band that works
   * harder than another loses body and the tonal balance tilts. This returns
   * a fraction of the measured reduction as makeup, smoothed over a few
   * hundred milliseconds so it reads as tone rather than as level movement.
   * The preset value stays the floor: the automatic part is added to it, never
   * substituted for it.
   */
  private updateAutoMakeup() {
    const params = this.params;
    if (!params?.multiband.on || !params.multiband.autoMakeup) return;
    params.multiband.bands.forEach((band, i) => {
      const comp = this.mbComps[i];
      const makeup = this.mbMakeups[i];
      if (!comp || !makeup) return;
      const target = autoMakeupDb(Math.max(0, -(comp.reduction ?? 0)));
      const cur = this.autoMakeupTrack[i];
      const next = cur + (target - cur) * 0.12;
      this.autoMakeupTrack[i] = next;
      this.setNum(`mb.${i}.m`, makeup.gain, dbToGain(band.makeupDb + next), 0.25);
    });
  }

  /**
   * Output measurement pass: peaks, correlation, true peak, loudness, gating
   * blocks, the loudness rider and the snapshot the whole console reads.
   */
  private heavyTick(now: number) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t0 = performance.now();
    const target = this.params
      ? complianceTarget(this.params)
      : { id: "spotify" as const, label: "Spotify", lufs: -14, truePeakDb: -1 };
    const tpFactor = this.params?.limiter.truePeakX ?? 4;

    // ── audio-clock health: ctx.currentTime against wall time ──
    // Sustained negative drift means the render thread missed deadlines. Two
    // gates keep the number honest, because this sampler rides the meter pass
    // (a rAF loop) rather than a fixed-rate timer:
    //   · the interval jitters and stops entirely in a background tab, so the
    //     reading is normalised per second of wall time and rejected when the
    //     gap is not a plausible window;
    //   · a suspended context is *supposed* to stop its clock, so a sample
    //     taken across a suspend is not an underrun — it is re-baselined.
    if (this.clockRefWall === 0 || ctx.state !== "running") {
      this.clockRefWall = now;
      this.clockRefCtx = ctx.currentTime;
      this.driftValid = false;
      this.driftIntervalMs = 0;
    } else if (now - this.clockRefWall >= 900) {
      const intervalMs = now - this.clockRefWall;
      const drift = driftPerSecond({
        intervalMs,
        audioMs: (ctx.currentTime - this.clockRefCtx) * 1000,
        running: ctx.state === "running",
      });
      this.clockRefWall = now;
      this.clockRefCtx = ctx.currentTime;
      this.driftIntervalMs = intervalMs;
      this.driftValid = drift !== null;
      if (drift !== null) {
        this.driftMs = drift;
        this.glitch.update(drift, now);
      }
    }

    // output peaks + correlation
    this.outAnalyserL.getFloatTimeDomainData(this.outBufL);
    this.outAnalyserR.getFloatTimeDomainData(this.outBufR);
    const outPeakL = peakDb(this.outBufL);
    const outPeakR = peakDb(this.outBufR);
    if (Math.max(outPeakL, outPeakR) > -70) this.lastOutAt = now;
    const correlation = correlationOf(this.outBufL, this.outBufR);
    // 1 Hz correlation history for the phase meter.
    if (now - this.lastCorrAt >= 1000) {
      this.lastCorrAt = now;
      this.corrHistory[this.corrWrite] = correlation;
      this.corrWrite = (this.corrWrite + 1) % this.corrHistory.length;
    }

    // Per-band width follows the live correlation: widening backs off as the
    // image decorrelates, so a hollow source cannot be made wider than it is.
    const cw = this.params?.psy.cohWidth;
    if (cw?.on) {
      const safety = coherenceSafety(correlation, cw.corrGuard);
      cw.bands.forEach((width, i) => {
        this.setNum(`cw.${i}`, this.cwBands[i]?.gain, safeWidth(width, safety), 0.05);
      });
    }

    const tail = Math.max(0, this.outBufL.length - TRUE_PEAK_WINDOW);
    const tp = Math.max(
      measureTruePeak(this.outBufL.subarray(tail), tpFactor),
      measureTruePeak(this.outBufR.subarray(tail), tpFactor),
    );

    const clipping = Math.max(outPeakL, outPeakR) > -0.2;
    // rising-edge counter + timestamp: the clip-event detector behind the
    // restoration panel (detection is measured; reconstruction stays stored)
    if (clipping && !(now < this.clipOutUntil)) {
      this.clipEvents += 1;
      this.clipAt = Date.now();
    }
    if (clipping) this.clipOutUntil = now + CLIP_HOLD_MS;

    // K-weighted loudness (BS.1770-4, no gating — momentary/short-term)
    this.ksAnalyserL.getFloatTimeDomainData(this.ksBufL);
    this.ksAnalyserR.getFloatTimeDomainData(this.ksBufR);
    const sum = meanSquare(this.ksBufL) + meanSquare(this.ksBufR);
    this.inKsAnalyserL.getFloatTimeDomainData(this.ksBufInL);
    this.inKsAnalyserR.getFloatTimeDomainData(this.ksBufInR);
    const sumIn = meanSquare(this.ksBufInL) + meanSquare(this.ksBufInR);

    this.loudnessWindow.push(now, sum);
    const windowPower = (winMs: number) => this.loudnessWindow.power(winMs, now);
    const windowLufs = (winMs: number) => this.loudnessWindow.loudness(winMs, now);

    // ── integrated loudness + LRA measurement (real, gated per spec) ──
    // Only time the device actually rendered counts as measurement time: a
    // suspended context (or a background tab whose rAF loop stopped) was not
    // measuring programme, and counting it made "20 s of programme" arrive
    // after twenty seconds of silence.
    if (this.lastMeasureT > 0 && ctx.state === "running") {
      this.measureMsAcc += Math.min(250, now - this.lastMeasureT);
    }
    this.lastMeasureT = now;
    // Only a context that is actually rendering contributes blocks. A
    // suspended analyser repeats its last buffer, so pushing while asleep
    // would stuff the gated measurement with duplicates of one frozen window.
    if (ctx.state === "running" && now - this.lastIBlockAt >= 100) {
      this.lastIBlockAt = now;
      this.iBlocks.push(windowPower(400));
      if (this.iBlocks.length > 90_000) this.iBlocks.shift();
      this.lufsIValue = gatedIntegrated(this.iBlocks, this.measureMsAcc);
    }
    if (ctx.state === "running" && now - this.lastStBlockAt >= 1000) {
      this.lastStBlockAt = now;
      this.stBlocks.push(windowPower(3000));
      if (this.stBlocks.length > 12_000) this.stBlocks.shift();
      this.lraValue = loudnessRange(this.stBlocks);
    }
    if (outPeakL > this.samplePeakDb) this.samplePeakDb = outPeakL;
    if (outPeakR > this.samplePeakDb) this.samplePeakDb = outPeakR;

    // One row per second for the compliance report (last hour kept).
    if (now - this.lastLogAt >= 1000) {
      this.lastLogAt = now;
      this.loudnessLog.push({
        at: Date.now(),
        momentary: loudnessOf(sum),
        shortTerm: windowLufs(3000),
        integrated: this.lufsIValue,
        lra: this.lraValue,
        truePeak: tp,
      });
      if (this.loudnessLog.length > 3600) this.loudnessLog.shift();
    }

    // ── v3.1 crest manager: drive the peak stage from the measured crest ──
    const adv = this.params?.advanced ?? DEFAULT_ADVANCED;
    if (this.params?.limiter.on && adv.leveling.crest.on) {
      const crest = tp - windowLufs(300);
      const next = crestDriveDb(crest, adv.leveling.crest, this.crestDrive);
      if (Math.abs(next - this.crestDrive) > 0.01) {
        this.crestDrive = next;
        const dens = densityProfile(this.params.density);
        this.setNum(
          "lim.drive",
          this.limDrive.gain,
          dbToGain(dens.driveDb + this.crestDrive),
          0.35,
        );
      }
    } else if (this.crestDrive !== 0) {
      this.crestDrive = 0;
      if (this.params?.limiter.on) {
        const dens = densityProfile(this.params.density);
        this.setNum("lim.drive", this.limDrive.gain, dbToGain(dens.driveDb), 0.5);
      }
    }

    // ── loudness rider (Compellor leveler / AERO long-term controller) ──
    if (this.params?.rider.on) {
      // silence gate (Compellor DVG style): never ride noise up in pauses
      if (windowLufs(300) > this.params.rider.gateDb) {
        // Loudness lock: ride toward the compliance target instead of the
        // rider's own number, so changing standard re-aims the chain. The
        // v3.1 drift corrector and dual anchor refine that target.
        const locked = this.params.psy.loudLock.on
          ? target.lufs
          : this.params.rider.targetLufs;
        const rideTarget = riderTargetLufs(
          {
            riderTarget: locked,
            drift: adv.leveling.drift,
            dual: adv.leveling.dualAnchor,
          },
          this.lufsIValue,
        );
        const err = rideTarget - windowLufs(1000);
        const cap = Math.abs(this.params.rider.maxRideDb);
        const ride = Math.max(-cap, Math.min(cap, err));
        const fast = this.params.rider.speed === "fast";
        // Compellor fast leveler ≈ 1.5 s down / 3 s up (setTarget ≈ ×⅓)
        const tc = ride < 0 ? (fast ? 0.5 : 1.7) : fast ? 1.0 : 3.3;
        this.setNum("rider", this.riderGain.gain, dbToGain(ride), tc);
        this.riderDb = ride;
      }
    } else {
      this.riderDb = 0;
      this.setNum("rider", this.riderGain.gain, 1, 0.05);
    }

    // auto-speech sensing: mic programme present while the sense flag is
    // armed → halve the levelling envelopes with a full (ramped) re-apply
    const wantSpeech =
      !!this.params?.agc.speechSense &&
      this.sourceKind === "mic" &&
      this.srcLevelDb > -50;
    if (wantSpeech !== this.speechFast) {
      this.speechFast = wantSpeech;
      if (this.params) this.apply(this.params);
    }

    const grOf = (comp: DynamicsCompressorNode | undefined): number =>
      Math.max(0, -(comp?.reduction ?? 0));
    const agcOn = this.params?.agc.on ?? false;
    this.updateAutoMakeup();

    if (this.limiterMeter) {
      // Drain the meter ring at snapshot rate: the newest value wins, and the
      // producer keeps free slots instead of counting drops forever.
      let gr: number | null = this.limiterMeter.read();
      let newest: number | null = null;
      while (gr !== null) {
        newest = gr;
        gr = this.limiterMeter.read();
      }
      if (newest !== null && Number.isFinite(newest)) {
        this.workletGr = Math.max(0, Math.min(60, newest));
      }
    }
    this.snapshotValue = {
      t: now,
      powered: true,
      inPeakL: this.inPeakL,
      inPeakR: this.inPeakR,
      outPeakL,
      outPeakR,
      truePeak: tp,
      lufsM: loudnessOf(sum),
      lufsS: windowLufs(3000),
      lufsIn: loudnessOf(sumIn),
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
        limiter:
          this.workletLimiter && limiterEngine(this.params?.limiter) === "worklet"
            ? this.workletGr + grOf(this.progComp)
            : grOf(this.limComp) + grOf(this.progComp),
      },
      agcWindow: { frozen: this.agcFrozen, spreadDb: this.agcSpreadDb },
      deessCut: this.deessCutDb,
      riderDb: this.riderDb,
      loudnessTarget: target.lufs,
      loudnessDeviation: loudnessDeviation(this.lufsIValue, target.lufs),
      compliance: complianceState(this.lufsIValue, tp, target),
      truePeakX: tpFactor,
      perf: {
        baseLatencyMs: (ctx.baseLatency ?? 0) * 1000,
        outputLatencyMs: (ctx.outputLatency ?? 0) * 1000,
        frameMs: this.frameCostMs,
        driftMs: this.driftMs,
        driftValid: this.driftValid,
        intervalMs: this.driftIntervalMs,
        throttled: this.heavyIntervalMs > HEAVY_BASE_MS,
        stalls: this.glitch.stalls,
        stalled: this.glitch.stalled,
        worstDriftMs: this.glitch.worstDriftMs,
        glitchAt: this.glitch.lastStallAt,
      },
      clipIn: now < this.clipInUntil,
      clipOut: now < this.clipOutUntil,
      clipEvents: this.clipEvents,
      clipAt: this.clipAt,
      speechFast: this.speechFast,
      srcLevelDb: this.srcLevelDb,
      backupActive: this.backupActiveFlag,
      limiterEngine:
        this.workletLimiter && limiterEngine(this.params?.limiter) === "worklet"
          ? "worklet"
          : "native",
    };

    const cost = performance.now() - t0;
    this.frameCostMs = this.frameCostMs === 0 ? cost : this.frameCostMs * 0.85 + cost * 0.15;
    // Adaptive stability: metering must never compete with the UI or the
    // render thread. Rather than dropping a whole frame (which froze the gate
    // and de-esser loops), the heavy pass simply runs less often.
    this.heavyIntervalMs =
      this.frameCostMs > 8 ? 90 : this.frameCostMs > 4 ? 60 : HEAVY_BASE_MS;
  }

  /** True-peak estimate used by the meters and the verification suite. */
  private truePeak(buf: Float32Array<ArrayBuffer>): number {
    return measureTruePeak(buf);
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
    this.loudnessWindow.clear();
    this.glitch.reset();
    this.notify();
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
      this.setNum("failover.src", this.srcGain.gain, 0, tc);
      this.setNum("failover.backup", this.backupGain.gain, 1, tc);
    } else {
      this.setNum("failover.src", this.srcGain.gain, 1, tc);
      this.setNum("failover.backup", this.backupGain.gain, 0, tc);
      if (this.backupEl) {
        globalThis.setTimeout(() => {
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
   * Measured facts for the console's status model.
   *
   * Nothing here is a parameter: each field comes from a node the graph is
   * really running, from the audio clock, or from the fault log. Delivery is
   * supplied by the caller because the output matrix lives outside the engine.
   */
  healthFacts(
    stream: { onAir: boolean; configured: boolean } = {
      onAir: false,
      configured: false,
    },
  ): HealthFacts {
    const now = performance.now();
    const snap = this.snapshotValue;
    return {
      powered: this.powered,
      starting: false,
      bootError: null,
      uptimeMs: this.poweredAt ? Date.now() - this.poweredAt : 0,
      contextState: this.ctx?.state ?? "none",
      everClocked: this.everClocked,
      programmeDb: Math.max(snap.inPeakL, snap.inPeakR),
      outPeakDb: Math.max(snap.outPeakL, snap.outPeakR),
      silentForMs: this.lastProgramAt ? now - this.lastProgramAt : Infinity,
      outSilentForMs: this.lastOutAt ? now - this.lastOutAt : Infinity,
      monitorMuted: this.monitorMuted,
      monitorDb: this.monitorGainDb,
      sinkRefused: this.sinkState === "refused",
      sinkVirtual: this.monitorIsVirtual,
      sinkLabel: this.monitorState.sinkLabel,
      stalls: this.glitch.stalls,
      stalledNow: this.glitch.stalled,
      lastStallAgoMs: this.glitch.lastStallAt
        ? now - this.glitch.lastStallAt
        : Infinity,
      clipOut: now < this.clipOutUntil,
      loudnessMeasuring: this.lufsIValue === null,
      measureMs: this.measureMsAcc,
      streamOnAir: stream.onAir,
      streamConfigured: stream.configured,
    };
  }

  /** The one status the console shows, derived from those facts. */
  health(stream?: { onAir: boolean; configured: boolean }): EngineHealth {
    return deriveEngineHealth(this.healthFacts(stream));
  }

  /**
   * Route facts for the diagnostics panel: context, rate, latency in frames,
   * the sink outcome and the last browser fault. `baseFrames` is derived from
   * the measured `baseLatency`, so it describes the device rather than a wish.
   */
  get diagnostics(): {
    contextState: string;
    sampleRate: number;
    channels: number;
    baseLatencyMs: number;
    outputLatencyMs: number;
    baseFrames: number;
    sinkState: string;
    sinkLabel: string;
    monitorDb: number;
    monitorMuted: boolean;
    outputOpen: boolean;
    workletLimiter: boolean;
    lastFault: { message: string; at: number } | null;
  } {
    const ctx = this.ctx;
    return {
      contextState: ctx?.state ?? "none",
      sampleRate: ctx?.sampleRate ?? 0,
      channels: this.sourceBus?.channelCount ?? 0,
      baseLatencyMs: (ctx?.baseLatency ?? 0) * 1000,
      outputLatencyMs: (ctx?.outputLatency ?? 0) * 1000,
      baseFrames: Math.round((ctx?.baseLatency ?? 0) * (ctx?.sampleRate ?? 0)),
      sinkState: this.sinkState,
      sinkLabel: this.monitorState.sinkLabel,
      monitorDb: this.monitorGainDb,
      monitorMuted: this.monitorMuted,
      outputOpen: this.outputOpen,
      workletLimiter: this.workletLimiter !== null,
      lastFault: this.lastFault,
    };
  }

  /** Monitor bus gain as the node holds it (dB, −Infinity when shut). */
  private get monitorGainDb(): number {
    const g = this.monitorGain?.gain.value;
    return typeof g === "number" && g > 0
      ? 20 * Math.log10(Math.min(1e3, g))
      : -Infinity;
  }

  /** Record a browser-reported fault for the diagnostics panel (throttled). */
  private noteFault(message: string) {
    const at = Date.now();
    if (this.lastFault?.message === message && at - this.lastFault.at < 5000) return;
    this.lastFault = { message, at };
  }

  /**
   * Safe recovery: resume the context, reopen the output path and rebuild the
   * monitor level — without reloading the page or tearing down the graph.
   *
   * Deliberately not a restart: a restart loses the source and the transport.
   * One attempt is shared by every caller and no second attempt is allowed
   * for three seconds, so a device that keeps refusing cannot be hammered by
   * a UI that keeps asking. Returns whether the context is clocking after it.
   */
  async recover(): Promise<boolean> {
    if (this.recoveryArm) return this.recoveryArm;
    if (Date.now() - this.lastRecoveryAt < 3000) return this.contextRunning;
    const token = {};
    const arm = (async (): Promise<boolean> => {
      this.lastRecoveryAt = Date.now();
      try {
        // No graph at all: a normal boot is the only recovery there is.
        if (!this.powered || !this.ctx || !this.graphReady) {
          await this.powerOn();
          return this.powered && this.contextRunning;
        }
        const ctx = this.ctx;
        if (ctx.state !== "running") await this.resumeAndWait(ctx);
        if (!this.contextRunning) {
          this.noteFault(
            "The browser would not start the audio device — it needs a click or tap first.",
          );
          this.notify();
          return false;
        }
        // Re-open from silence rather than at whatever level the bus was left
        // at, then rebuild the monitor level from the live parameters.
        this.outputOpen = false;
        this.openOutput();
        this.ensureBusOpen();
        this.applyMonitorGain();
        await this.applyOutputDevice();
        this.startMeterLoop();
        this.notify();
        return true;
      } catch (err) {
        this.noteFault(
          err instanceof Error ? err.message : "The audio device could not be recovered.",
        );
        this.notify();
        return false;
      }
    })().finally(() => {
      if (this.recoveryToken === token) {
        this.recoveryArm = null;
        this.recoveryToken = null;
      }
    });
    this.recoveryArm = arm;
    this.recoveryToken = token;
    return arm;
  }

  /**
   * Raw post-chain L/R frames for the vector scope. Copies the first N
   * samples of the output analysers (fftSize 4096) — the scope draws L vs
   * R as a Lissajous figure. Empty arrays while the graph is down.
   */
  getScopeFrames(n = 512): { l: Float32Array; r: Float32Array } {
    const N = Math.min(2048, Math.max(64, Math.floor(n)));
    const empty = { l: new Float32Array(0), r: new Float32Array(0) };
    if (!this.ctx || !this.powered || !this.graphReady) return empty;
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

  /**
   * Correlation history, oldest → newest, one point per second (two
   * minutes). The phase meter draws it as a strip: a line that dives towards
   * −1 is the warning that a wide or out-of-phase source is about to fold
   * down badly in mono.
   */
  /** One-row-per-second loudness log for the compliance CSV (last hour). */
  get loudnessLogRows(): readonly LoudnessLogRow[] {
    return this.loudnessLog;
  }

  getCorrelationHistory(): Float32Array {
    const n = this.corrHistory.length;
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = this.corrHistory[(this.corrWrite + i) % n];
    return out;
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
    if (!this.powered || !this.graphReady) return null;
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

  /**
   * The program node the delivery tap should listen to.
   *
   * Tapping the graph directly is the difference between a capture that is
   * scheduled by this context and one that is re-clocked across a
   * MediaStream hop — the hop is resampled and restarted with the output
   * device, so a hand-off stalls it. Null before a graph exists.
   */
  getCaptureNode(): AudioNode | null {
    return this.graphReady ? (this.streamGain ?? null) : null;
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
