/**
 * Adaptive declipper — flat-top peak reconstruction.
 *
 * A clipped waveform does not stop rising because the music stopped: it is
 * held at the converter's ceiling while the original peak is missing. What
 * the ear hears is not the missing peak but the flat top, because the flat
 * top is a long run of identical samples — a discontinuity in the waveform's
 * derivative that splatters harmonics across the spectrum.
 *
 * This kernel rebuilds the missing peak instead of adding harmonics:
 *
 *   1. A run of consecutive samples at/above the clip threshold is a flat top.
 *   2. The waveform just before and just after the run gives two positions and
 *      two slopes. A cubic Hermite segment through those four values is the
 *      smoothest waveform consistent with both edges.
 *   3. The reconstructed samples replace the plateau, blended by `mix`, and
 *      are limited to `maxRestoreDb` above the threshold so the stage cannot
 *      invent an unbounded peak.
 *
 * The algorithm needs the end of the run before it can draw the arch, so the
 * stage runs with a fixed delay of `MAX_RUN + POST + 4` samples (≈ 4.3 ms at
 * 48 kHz). The delay is constant whether the module is on or bypassed: a
 * module that changed latency when toggled would pitch-shift the programme,
 * which is worse than the clipping it repairs.
 *
 * Runs longer than `MAX_RUN` (4 ms at 48 kHz) are repaired in sections; the
 * reconstruction of a section uses the still-clipped sample after it as its
 * right edge, so a very long clipped passage gets its edge shape restored
 * rather than an invented arch.
 */

export const DECLIP_WORKLET_NAME = "signalpath-declip";

/** Longest run reconstructed as one arch. */
export const DECLIP_MAX_RUN = 192;

/** Samples observed after a run ends before its right-hand slope is known. */
export const DECLIP_POST = 4;

/** Fixed processing delay, in samples (≈ 4.3 ms at 48 kHz). */
export const DECLIP_DELAY = DECLIP_MAX_RUN + DECLIP_POST + 4;

export interface DeclipConfig {
  on: boolean;
  /** Level at/above which a sample is treated as clipped (dBFS). */
  thresholdDb: number;
  /** Maximum height a reconstructed peak may reach above the threshold (dB). */
  maxRestoreDb: number;
  /** Wet/dry blend, 0…1. */
  mix: number;
}

export const DEFAULT_DECLIP: DeclipConfig = {
  on: false,
  thresholdDb: -0.5,
  maxRestoreDb: 4,
  mix: 0.65,
};

/** Meter values written by the audio thread once per render quantum. */
export interface DeclipMeter {
  /** Share of input samples reconstructed this block, 0…100. */
  repairPct: number;
  /** Largest reconstruction boost this block, dB (0 when nothing repaired). */
  peakRestoreDb: number;
}

export const SILENT_DECLIP_METER: DeclipMeter = { repairPct: 0, peakRestoreDb: 0 };

/**
 * Sample-accurate declipper. Deliberately written with no module-scope
 * references inside its methods: the worklet source below embeds this class
 * by `toString()`, so the audio thread runs the same code as any offline use.
 */
export class DeclipKernel {
  private sampleRate: number;
  private size: number;
  private delay: number;
  private post: number;
  private maxRun: number;

  private bufL: Float32Array;
  private bufR: Float32Array;
  private write: number;
  private total: number;

  private on: boolean;
  private ceiling: number;
  private restoreLimit: number;
  private mix: number;

  private runOn: Int32Array;
  private runStart: Float64Array;
  private runLen: Int32Array;
  private runSign: Int32Array;

  private pendCount: number;
  private pendCh: Int32Array;
  private pendStart: Float64Array;
  private pendLen: Int32Array;
  private pendSign: Int32Array;
  private pendWait: Int32Array;

  private repaired: number;
  private boostDb: number;

  constructor(sampleRate = 48000) {
    this.sampleRate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 48000;
    // Literals on purpose (no module constants): this class is stringified
    // into the worklet module, where the module scope does not exist.
    this.maxRun = 192;
    this.post = 4;
    this.delay = this.maxRun + this.post + 4;
    this.size = this.delay + 2;
    this.bufL = new Float32Array(this.size);
    this.bufR = new Float32Array(this.size);
    this.write = 0;
    this.total = 0;

    this.on = false;
    this.ceiling = Math.pow(10, -0.5 / 20);
    this.restoreLimit = this.ceiling * 1.58;
    this.mix = 0.65;

    this.runOn = new Int32Array(2);
    this.runStart = new Float64Array(2);
    this.runLen = new Int32Array(2);
    this.runSign = new Int32Array(2);

    this.pendCount = 0;
    this.pendCh = new Int32Array(8);
    this.pendStart = new Float64Array(8);
    this.pendLen = new Int32Array(8);
    this.pendSign = new Int32Array(8);
    this.pendWait = new Int32Array(8);

    this.repaired = 0;
    this.boostDb = 0;
  }

  /** Detection threshold, restore ceiling and blend in one write. */
  configure(on: boolean, thresholdDb: number, maxRestoreDb: number, mix: number): void {
    this.on = !!on;
    const db = Number.isFinite(thresholdDb)
      ? Math.min(-0.01, Math.max(-12, thresholdDb))
      : -0.5;
    this.ceiling = Math.pow(10, db / 20);
    const restore = Number.isFinite(maxRestoreDb)
      ? Math.min(12, Math.max(0, maxRestoreDb))
      : 4;
    // Absolute cap: the chain downstream has its own limiter, but an input
    // stage should never hand it +20 dBFS from a malformed peak estimate.
    this.restoreLimit = Math.min(4, this.ceiling * Math.pow(10, restore / 20));
    this.mix = Number.isFinite(mix) ? Math.min(1, Math.max(0, mix)) : 0.65;
  }

  /**
   * Flush the delay line and every run in flight. Called on a device swap
   * from the audio thread, between render quanta, so no sample is read from a
   * buffer that still holds the previous endpoint's waveform.
   */
  reset(): void {
    this.bufL.fill(0);
    this.bufR.fill(0);
    this.write = 0;
    this.total = 0;
    this.runOn[0] = 0;
    this.runOn[1] = 0;
    this.runLen[0] = 0;
    this.runLen[1] = 0;
    this.pendCount = 0;
    this.repaired = 0;
    this.boostDb = 0;
  }

  /** Percentage of samples reconstructed in the last processed block. */
  get repairPct(): number {
    return Math.min(100, (this.repaired / this.delay) * 100);
  }

  /** Largest reconstruction boost from the last block, dB. */
  get peakRestoreDb(): number {
    return this.boostDb;
  }

  /** Delayed sample at a global index, or 0 outside the live window. */
  private at(ch: number, g: number): number {
    if (g < 0 || g >= this.total || g <= this.total - this.size) return 0;
    const buf = ch === 0 ? this.bufL : this.bufR;
    return buf[((g % this.size) + this.size) % this.size];
  }

  /** Write a reconstructed sample back into the delay line at history g. */
  private put(ch: number, g: number, value: number): void {
    if (g < 0 || g <= this.total - this.size) return;
    const buf = ch === 0 ? this.bufL : this.bufR;
    buf[((g % this.size) + this.size) % this.size] = value;
  }

  private enqueue(ch: number, start: number, len: number, sign: number): void {
    if (len <= 0) return;
    // The delay is sized for one run plus its right edge. If a second run is
    // still waiting, its start is still inside the line, so the queue can
    // hold several without any sample having been emitted yet.
    if (this.pendCount >= 8) {
      this.pendCount = 0;
    }
    const i = this.pendCount;
    this.pendCh[i] = ch;
    this.pendStart[i] = start;
    this.pendLen[i] = len;
    this.pendSign[i] = sign;
    this.pendWait[i] = this.post;
    this.pendCount += 1;
  }

  /** Draw the Hermite arch over a finished run. */
  private reconstruct(index: number): void {
    const ch = this.pendCh[index];
    const start = this.pendStart[index];
    const len = this.pendLen[index];
    const sign = this.pendSign[index];
    const end = start + len - 1;

    const p0 = this.at(ch, start - 1);
    const p1 = this.at(ch, end + 1);
    const m0 = (this.at(ch, start - 1) - this.at(ch, start - 3)) / 2;
    const m1 = (this.at(ch, end + 3) - this.at(ch, end + 1)) / 2;
    const span = len + 1;

    for (let k = 0; k < len; k++) {
      const g = start + k;
      const orig = this.at(ch, g);
      const u = (k + 1) / span;
      const u2 = u * u;
      const u3 = u2 * u;
      const h00 = 2 * u3 - 3 * u2 + 1;
      const h10 = u3 - 2 * u2 + u;
      const h01 = -2 * u3 + 3 * u2;
      const h11 = u3 - u2;
      let y = h00 * p0 + h10 * m0 * span + h01 * p1 + h11 * m1 * span;
      if (!Number.isFinite(y)) continue;

      // Do not invent a peak in the wrong polarity, and never exceed the
      // configured restoration ceiling.
      y = Math.max(-this.restoreLimit, Math.min(this.restoreLimit, y));
      if (sign > 0 && y < 0) y = Math.abs(y);
      if (sign < 0 && y > 0) y = -Math.abs(y);

      const mixed = orig + this.mix * (y - orig);
      const magnitude = Math.abs(mixed);
      if (magnitude <= Math.abs(orig) + 1e-6) continue;

      this.put(ch, g, mixed);
      this.repaired += 1;
      const boost = 20 * Math.log10((magnitude + 1e-9) / (Math.abs(orig) + 1e-9));
      if (boost > this.boostDb) this.boostDb = Math.min(24, boost);
    }
  }

  private finish(ch: number, start: number, len: number, sign: number): void {
    this.runOn[ch] = 0;
    this.runLen[ch] = 0;
    this.enqueue(ch, start, len, sign);
  }

  /**
   * Process one interleaved stereo block in place into the output buffers.
   * The returned meter is the block's repair activity.
   */
  process(
    inL: Float32Array,
    inR: Float32Array,
    outL: Float32Array,
    outR: Float32Array,
  ): DeclipMeter {
    const n = Math.min(inL.length, inR.length, outL.length, outR.length);
    this.repaired = 0;
    this.boostDb = 0;
    const totalIn = n * 2;

    for (let i = 0; i < n; i++) {
      const xl = Number.isFinite(inL[i]) ? inL[i] : 0;
      const xr = Number.isFinite(inR[i]) ? inR[i] : 0;
      const slot = ((this.total % this.size) + this.size) % this.size;
      this.bufL[slot] = xl;
      this.bufR[slot] = xr;

      for (let ch = 0; ch < 2; ch++) {
        const x = ch === 0 ? xl : xr;
        const sign = x >= 0 ? 1 : -1;
        const clipped = this.on && Math.abs(x) >= this.ceiling;
        if (!this.runOn[ch]) {
          if (clipped) {
            this.runOn[ch] = 1;
            this.runStart[ch] = this.total;
            this.runLen[ch] = 1;
            this.runSign[ch] = sign;
          }
          continue;
        }
        if (clipped && sign === this.runSign[ch]) {
          this.runLen[ch] += 1;
          if (this.runLen[ch] >= this.maxRun) {
            this.finish(ch, this.runStart[ch], this.runLen[ch], this.runSign[ch]);
          }
        } else {
          this.finish(
            ch,
            this.runStart[ch],
            this.runLen[ch],
            this.runSign[ch],
          );
          if (clipped) {
            this.runOn[ch] = 1;
            this.runStart[ch] = this.total;
            this.runLen[ch] = 1;
            this.runSign[ch] = sign;
          }
        }
      }

      this.total += 1;

      // Runs whose right-hand samples have arrived are drawn now, while the
      // affected samples are still ahead of the output pointer.
      for (let p = 0; p < this.pendCount; p++) {
        this.pendWait[p] -= 1;
        if (this.pendWait[p] <= 0) this.reconstruct(p);
      }
      // Compact finished runs without allocating.
      let keep = 0;
      for (let p = 0; p < this.pendCount; p++) {
        if (this.pendWait[p] > 0) {
          if (keep !== p) {
            this.pendCh[keep] = this.pendCh[p];
            this.pendStart[keep] = this.pendStart[p];
            this.pendLen[keep] = this.pendLen[p];
            this.pendSign[keep] = this.pendSign[p];
            this.pendWait[keep] = this.pendWait[p];
          }
          keep += 1;
        }
      }
      this.pendCount = keep;

      const read = this.total - this.delay - 1;
      if (read >= 0) {
        outL[i] = this.at(0, read);
        outR[i] = this.at(1, read);
      } else {
        outL[i] = 0;
        outR[i] = 0;
      }
    }

    // When bypassed the block is a pure delay: report no repair activity.
    return this.on
      ? {
          repairPct: Math.min(100, (this.repaired / totalIn) * 100),
          peakRestoreDb: this.boostDb,
        }
      : { repairPct: 0, peakRestoreDb: 0 };
  }
}

/**
 * Module registered on the audio thread. The kernel is embedded from its own
 * source so the worklet cannot drift from the implementation above.
 */
export function declipWorkletSource(): string {
  return `
const DeclipKernel = ${DeclipKernel.toString()};
class SignalpathDeclipProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.kernel = new DeclipKernel(sampleRate);
    this.blocks = 0;
    try {
      const meter = options && options.processorOptions && options.processorOptions.meter;
      const peak = options && options.processorOptions && options.processorOptions.peak;
      this.meterF = meter ? new Float32Array(meter, 0, 1) : null;
      this.peakF = peak ? new Float32Array(peak, 0, 1) : null;
    } catch (e) {
      this.meterF = null;
      this.peakF = null;
    }
    this.port.onmessage = (e) => {
      const d = e.data || {};
      if (d.reset) this.kernel.reset();
      if (typeof d.thresholdDb === "number") {
        this.kernel.configure(!!d.on, d.thresholdDb, d.maxRestoreDb, d.mix);
      }
    };
  }
  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !output || input.length === 0 || output.length === 0) return true;
    const inL = input[0];
    const inR = input.length > 1 ? input[1] : input[0];
    const outL = output[0];
    const outR = output.length > 1 ? output[1] : output[0];
    const m = this.kernel.process(inL, inR, outL, outR);
    if (this.meterF && this.peakF) {
      // One published float per render quantum: the UI reads the newest and
      // the audio thread never waits on it.
      this.meterF[0] = m.repairPct;
      this.peakF[0] = m.peakRestoreDb;
    } else if ((this.blocks++ & 7) === 0) {
      this.port.postMessage({ repairPct: m.repairPct, peakRestoreDb: m.peakRestoreDb });
    }
    return true;
  }
}
try { registerProcessor("${DECLIP_WORKLET_NAME}", SignalpathDeclipProcessor); } catch (e) {}
`;
}
