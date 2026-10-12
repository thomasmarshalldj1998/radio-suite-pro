/**
 * Signalpath audio engine.
 *
 * Signal flow:
 *   source → inputGain → HPF ─┬─ input meters (L/R)
 *                              ├─ spectrum (pre)
 *                              └─ 6-band EQ → 3-band multiband compressor
 *                                 → program AGC → brickwall limiter
 *                                 → output gain → duck
 *                                  ├─ monitor out (speakers)
 *                                  ├─ encoder send (MediaStream for Icecast)
 *                                  ├─ spectrum (post)
 *                                  ├─ sample-peak / true-peak meters (L/R)
 *                                  └─ K-weighted loudness (BS.1770, L/R)
 */

import type { ProcessorParams } from "./params";
import { dbToGain } from "./params";

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
  correlation: number;
  gr: { low: number; mid: number; high: number; agc: number; limiter: number };
  clipIn: boolean;
  clipOut: boolean;
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
  correlation: 1,
  gr: { low: 0, mid: 0, high: 0, agc: 0, limiter: 0 },
  clipIn: false,
  clipOut: false,
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

export class AudioEngine {
  ctx: AudioContext | null = null;
  powered = false;
  sourceKind: SourceKind = "signal";
  signalMode: SignalMode = "pink";
  micStatus: MicStatus = "idle";
  micLabel = "";

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

  // graph
  private sourceBus!: GainNode;
  private inputGain!: GainNode;
  private hpf!: BiquadFilterNode;
  private eqFilters: BiquadFilterNode[] = [];
  private eqWetPre!: GainNode;
  private eqDry!: GainNode;
  private mbWetPre!: GainNode;
  private mbDry!: GainNode;
  private mbComps: DynamicsCompressorNode[] = [];
  private mbMakeups: GainNode[] = [];
  private mbFilters: BiquadFilterNode[] = [];
  private agcWetPre!: GainNode;
  private agcComp!: DynamicsCompressorNode;
  private agcMakeup!: GainNode;
  private agcDry!: GainNode;
  private limWetPre!: GainNode;
  private limComp!: DynamicsCompressorNode;
  private limDry!: GainNode;
  private outputGain!: GainNode;
  private duckGain!: GainNode;
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

  // buffers
  private timeBuf!: Float32Array<ArrayBuffer>;
  private ksBufL!: Float32Array<ArrayBuffer>;
  private ksBufR!: Float32Array<ArrayBuffer>;
  private specBufPre!: Uint8Array<ArrayBuffer>;
  private specBufPost!: Uint8Array<ArrayBuffer>;

  private signalOsc: AudioScheduledSourceNode | null = null;
  private signalGain: GainNode | null = null;
  private micStream: MediaStream | null = null;
  private micNode: MediaStreamAudioSourceNode | null = null;
  private params: ProcessorParams | null = null;

  /* ── lifecycle ────────────────────────────────────────────────────────── */

  async powerOn(): Promise<void> {
    if (this.ctx) {
      await this.ctx.resume();
      this.powered = true;
      this.startMeterLoop();
      this.notify();
      return;
    }
    const ctx = new AudioContext({ latencyHint: "interactive" });
    this.ctx = ctx;
    this.buildGraph(ctx);
    if (this.params) this.apply(this.params);
    await ctx.resume();
    this.powered = true;
    this.setSource(this.sourceKind);
    this.startMeterLoop();
    this.notify();
  }

  powerOff() {
    this.stopFile();
    this.disarmMic();
    this.stopSignal();
    this.cancelMeterLoop();
    this.powered = false;
    this.lufsPoints = [];
    this.snapshotValue = { ...SILENT_SNAPSHOT };
    if (this.ctx) {
      void this.ctx.suspend();
    }
    this.notify();
  }

  dispose() {
    this.powerOff();
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
    const g = (v = 1) => {
      const n = ctx.createGain();
      n.gain.value = v;
      return n;
    };

    this.sourceBus = g(1);

    // input stage
    this.inputGain = g(1);
    this.hpf = ctx.createBiquadFilter();
    this.hpf.type = "highpass";
    this.hpf.frequency.value = 80;
    this.hpf.Q.value = 0.707;
    this.sourceBus.connect(this.inputGain);

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

    this.inputGain.connect(this.hpf);

    // ── 6-band EQ (wet/dry crossfade) ──
    this.eqWetPre = g(1);
    this.eqDry = g(0);
    this.hpf.connect(this.eqWetPre);
    this.hpf.connect(this.eqDry);
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

    // ── 3-band multiband compressor ──
    this.mbWetPre = g(1);
    this.mbDry = g(0);
    eqOut.connect(this.mbWetPre);
    eqOut.connect(this.mbDry);
    const mbSum = g(1);
    this.mbDry.connect(mbSum);

    const mkBand = (
      build: (input: AudioNode) => AudioNode,
      thresholdDb: number,
      ratio: number,
      attackMs: number,
      releaseMs: number,
    ) => {
      const start = g(1);
      const filters = build(start);
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = thresholdDb;
      comp.ratio.value = ratio;
      comp.attack.value = attackMs / 1000;
      comp.release.value = releaseMs / 1000;
      comp.knee.value = 3;
      const makeup = g(1);
      filters.connect(comp);
      comp.connect(makeup);
      makeup.connect(mbSum);
      this.mbComps.push(comp);
      this.mbMakeups.push(makeup);
      return start;
    };

    // low band: LR4 lowpass @ xoverLow
    const lowStart = mkBand(
      (input) => {
        const a = ctx.createBiquadFilter();
        a.type = "lowpass";
        a.frequency.value = 120;
        a.Q.value = 0.707;
        const b = ctx.createBiquadFilter();
        b.type = "lowpass";
        b.frequency.value = 120;
        b.Q.value = 0.707;
        input.connect(a);
        a.connect(b);
        this.mbFilters.push(a, b);
        return b;
      },
      -12,
      4,
      10,
      250,
    );
    // mid band: band-pass between the crossovers
    const midStart = mkBand(
      (input) => {
        const a = ctx.createBiquadFilter();
        a.type = "highpass";
        a.frequency.value = 120;
        a.Q.value = 0.707;
        const b = ctx.createBiquadFilter();
        b.type = "lowpass";
        b.frequency.value = 5500;
        b.Q.value = 0.707;
        input.connect(a);
        a.connect(b);
        this.mbFilters.push(a, b);
        return b;
      },
      -14,
      3,
      5,
      200,
    );
    // high band: LR4 highpass @ xoverHigh
    const highStart = mkBand(
      (input) => {
        const a = ctx.createBiquadFilter();
        a.type = "highpass";
        a.frequency.value = 5500;
        a.Q.value = 0.707;
        const b = ctx.createBiquadFilter();
        b.type = "highpass";
        b.frequency.value = 5500;
        b.Q.value = 0.707;
        input.connect(a);
        a.connect(b);
        this.mbFilters.push(a, b);
        return b;
      },
      -16,
      3,
      2,
      150,
    );
    this.mbWetPre.connect(lowStart);
    this.mbWetPre.connect(midStart);
    this.mbWetPre.connect(highStart);

    // ── program AGC ──
    this.agcWetPre = g(1);
    this.agcDry = g(0);
    this.agcComp = ctx.createDynamicsCompressor();
    this.agcComp.threshold.value = -18;
    this.agcComp.ratio.value = 3;
    this.agcComp.knee.value = 6;
    this.agcComp.attack.value = 0.015;
    this.agcComp.release.value = 0.4;
    this.agcMakeup = g(dbToGain(4));
    const agcOut = g(1);
    mbSum.connect(this.agcWetPre);
    mbSum.connect(this.agcDry);
    this.agcWetPre.connect(this.agcComp);
    this.agcComp.connect(this.agcMakeup);
    this.agcMakeup.connect(agcOut);
    this.agcDry.connect(agcOut);

    // ── brickwall limiter ──
    this.limWetPre = g(1);
    this.limDry = g(0);
    this.limComp = ctx.createDynamicsCompressor();
    this.limComp.threshold.value = -1;
    this.limComp.ratio.value = 20;
    this.limComp.knee.value = 0;
    this.limComp.attack.value = 0.0015;
    this.limComp.release.value = 0.1;
    const limOut = g(1);
    agcOut.connect(this.limWetPre);
    agcOut.connect(this.limDry);
    this.limWetPre.connect(this.limComp);
    this.limComp.connect(limOut);
    this.limDry.connect(limOut);

    // ── output / duck / monitor / encoder send ──
    this.outputGain = g(1);
    this.duckGain = g(1);
    limOut.connect(this.outputGain);
    this.outputGain.connect(this.duckGain);

    this.monitorGain = g(dbToGain(-6));
    this.duckGain.connect(this.monitorGain);
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

    this.timeBuf = new Float32Array(this.outAnalyserL.fftSize);
    this.ksBufL = new Float32Array(this.ksAnalyserL.fftSize);
    this.ksBufR = new Float32Array(this.ksAnalyserR.fftSize);
    this.specBufPre = new Uint8Array(this.preSpec.frequencyBinCount);
    this.specBufPost = new Uint8Array(this.postSpec.frequencyBinCount);
  }

  /* ── parameter application ────────────────────────────────────────────── */

  apply(params: ProcessorParams) {
    this.params = params;
    const ctx = this.ctx;
    if (!ctx) return; // applied on powerOn

    this.ramp(this.inputGain.gain, dbToGain(params.inputGainDb));

    this.ramp(this.hpf.frequency, params.hpf.freqHz);
    this.hpf.type = params.hpf.on ? "highpass" : "allpass";

    params.eq.bands.forEach((band, i) => {
      const f = this.eqFilters[i];
      if (!f) return;
      this.ramp(f.gain, band.gainDb);
      this.ramp(f.frequency, band.freq);
      this.ramp(f.Q, Math.max(band.q, 0.01));
    });
    this.crossfade(this.eqWetPre, this.eqDry, params.eq.on);

    this.ramp(this.mbFilters[0]?.frequency, params.multiband.xoverLowHz);
    this.ramp(this.mbFilters[1]?.frequency, params.multiband.xoverLowHz);
    this.ramp(this.mbFilters[2]?.frequency, params.multiband.xoverHighHz);
    this.ramp(this.mbFilters[3]?.frequency, params.multiband.xoverHighHz);
    params.multiband.bands.forEach((band, i) => {
      const comp = this.mbComps[i];
      const makeup = this.mbMakeups[i];
      if (!comp || !makeup) return;
      this.ramp(comp.threshold, band.thresholdDb);
      this.ramp(comp.ratio, band.ratio);
      this.ramp(comp.attack, Math.max(band.attackMs, 0) / 1000);
      this.ramp(comp.release, Math.max(band.releaseMs, 10) / 1000);
      this.ramp(makeup.gain, dbToGain(band.makeupDb));
    });
    this.crossfade(this.mbWetPre, this.mbDry, params.multiband.on);

    this.ramp(this.agcComp.threshold, params.agc.thresholdDb);
    this.ramp(this.agcComp.ratio, params.agc.ratio);
    this.ramp(this.agcComp.knee, params.agc.kneeDb);
    this.ramp(this.agcComp.attack, Math.max(params.agc.attackMs, 0) / 1000);
    this.ramp(this.agcComp.release, Math.max(params.agc.releaseMs, 10) / 1000);
    this.ramp(this.agcMakeup.gain, dbToGain(params.agc.makeupDb));
    this.crossfade(this.agcWetPre, this.agcDry, params.agc.on);

    this.ramp(this.limComp.threshold, params.limiter.ceilingDb);
    this.ramp(this.limComp.attack, Math.max(params.limiter.attackMs, 0.1) / 1000);
    this.ramp(this.limComp.release, Math.max(params.limiter.releaseMs, 10) / 1000);
    this.crossfade(this.limWetPre, this.limDry, params.limiter.on);

    this.ramp(this.outputGain.gain, dbToGain(params.outputGainDb));
    this.ramp(this.monitorGain.gain, dbToGain(params.monitorDb));
  }

  private crossfade(wet: GainNode, dry: GainNode, on: boolean) {
    this.ramp(wet.gain, on ? 1 : 0, 0.015);
    this.ramp(dry.gain, on ? 0 : 1, 0.015);
  }

  setMonitorDb(db: number) {
    this.ramp(this.monitorGain.gain, dbToGain(db));
  }

  setMonitorMuted(muted: boolean) {
    this.ramp(this.monitorGain.gain, muted ? 0 : dbToGain(this.params?.monitorDb ?? -6));
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

  setSource(kind: SourceKind) {
    this.sourceKind = kind;
    if (!this.ctx) return;
    this.stopSignal();
    this.pauseFile();
    if (kind === "signal") void this.startSignal();
    if (kind === "mic") void this.armMic();
    if (kind === "file" && this.fileBuffer) this.playFile();
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
  }

  async armMic(): Promise<void> {
    if (!this.ctx) return;
    if (this.micStatus === "on" || this.micStatus === "arming") return;
    this.micStatus = "arming";
    this.notify();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 2,
        },
      });
      this.micStream = stream;
      const track = stream.getAudioTracks()[0];
      this.micLabel = track?.label ?? "Microphone";
      this.micNode = this.ctx.createMediaStreamSource(stream);
      this.micNode.connect(this.sourceBus);
      this.micStatus = "on";
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
    if (!ctx || !this.powered) return;
    const now = performance.now();
    const grOf = (comp: DynamicsCompressorNode | undefined): number =>
      Math.max(0, -(comp?.reduction ?? 0));

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

    // output peaks + true peak + correlation
    this.outAnalyserL.getFloatTimeDomainData(this.ksBufL);
    this.outAnalyserR.getFloatTimeDomainData(this.ksBufR);
    let outL = 0;
    let outR = 0;
    let dot = 0;
    let eL = 0;
    let eR = 0;
    for (let i = 0; i < this.ksBufL.length; i++) {
      const l = this.ksBufL[i];
      const r = this.ksBufR[i];
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
      this.truePeak(this.ksBufL),
      this.truePeak(this.ksBufR),
    );
    if (Math.max(outPeakL, outPeakR) > -0.2) this.clipOutUntil = now + 600;
    const denom = Math.sqrt(eL * eR);
    const correlation = denom > 1e-9 ? Math.max(-1, Math.min(1, dot / denom)) : 1;

    // K-weighted loudness (BS.1770-4, no gating — momentary/short-term)
    const msL = this.meanSquare(this.ksAnalyserL, this.ksBufL);
    const msR = this.meanSquare(this.ksAnalyserR, this.ksBufR);
    const sum = msL + msR;
    const loudness = sum > 1e-12 ? -0.691 + 10 * Math.log10(sum) : -70;
    this.lufsPoints.push({ t: now, ms: sum });
    while (this.lufsPoints.length > 2 && now - this.lufsPoints[0].t > 3200) {
      this.lufsPoints.shift();
    }
    const windowLufs = (winMs: number) => {
      let acc = 0;
      let n = 0;
      for (const p of this.lufsPoints) {
        if (now - p.t <= winMs) {
          acc += p.ms;
          n++;
        }
      }
      const v = n > 0 ? acc / n : 0;
      return v > 1e-12 ? -0.691 + 10 * Math.log10(v) : -70;
    };

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
      correlation,
      gr: {
        low: grOf(this.mbComps[0]),
        mid: grOf(this.mbComps[1]),
        high: grOf(this.mbComps[2]),
        agc: grOf(this.agcComp),
        limiter: grOf(this.limComp),
      },
      clipIn: now < this.clipInUntil,
      clipOut: now < this.clipOutUntil,
    };

    if (++this.frame % 3 === 0) this.notify();
  }

  snapshot(): MeterSnapshot {
    return this.snapshotValue;
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
