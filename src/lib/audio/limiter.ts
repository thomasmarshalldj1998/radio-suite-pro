/**
 * Lookahead brickwall limiter — the sample-accurate final gain stage.
 *
 * The console's native limiter is a `DynamicsCompressorNode` with a 20:1
 * ratio: fast, but its knee and release curve are the browser's, and a
 * compressor is not a promise. This kernel makes the ceiling a hard one: the
 * gain target for every sample is the minimum over the coming lookahead
 * window, so the gain is already down when a transient reaches the output and
 * no sample can leave above `ceilingDb`.
 *
 *   gainTarget = min(1, ceiling / peak)  over [now, now + lookahead]
 *   gain       = min(target, released gain)
 *   output     = input delayed by lookahead × gain
 *
 * The class is plain JavaScript in spirit (no imports, no closures over module
 * state) because the worklet source below is generated from it: the audio
 * thread runs exactly the kernel the verification suite exercises.
 */

import { SpscRing } from "./spsc-ring";

export const LIMITER_WORKLET_NAME = "signalpath-limiter";

export interface LimiterKernelConfig {
  /** Hard ceiling in dBFS (≤ 0). */
  ceilingDb: number;
  /** Release time constant in ms. */
  releaseMs: number;
  /** Freeze the release this long after a reduction event, in ms. */
  holdMs: number;
  /** Lookahead / attack window in ms. */
  lookaheadMs: number;
}

export const DEFAULT_LIMITER_KERNEL: LimiterKernelConfig = {
  ceilingDb: -1,
  releaseMs: 60,
  holdMs: 0,
  lookaheadMs: 2,
};

/**
 * Longest lookahead the kernel will honour (ms). Mirrored as a literal inside
 * the class so the generated worklet module stays self-contained.
 */
export const MAX_LOOKAHEAD_MS = 20;

export class LookaheadLimiter {
  // Every field is assigned in the constructor on purpose: no initialisers
  // means no class-field helper can be injected by a bundler into the source
  // this class is stringified from for the worklet module.
  private readonly sampleRate: number;
  private readonly maxLookahead: number;
  private readonly bufL: Float32Array;
  private readonly bufR: Float32Array;
  private write: number;
  private total: number;

  private ceiling: number;
  private releaseCoef: number;
  private holdSamples: number;
  private lookahead: number;

  private gain: number;
  private holdLeft: number;
  private reductionDb: number;

  // Monotonic queue of gain targets: values decrease front → back, so the
  // front is the window minimum. Both rings are sized for the longest
  // lookahead at construction; the audio thread never grows them. Absolute
  // head/tail counters mean expiry is a pointer move, with no compaction.
  private qVal: Float32Array;
  private qIdx: Float64Array;
  private qHead: number;
  private qTail: number;
  private qCount: number;
  private qCap: number;

  constructor(sampleRate = 48000) {
    this.sampleRate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 48000;
    this.write = 0;
    this.total = 0;
    this.ceiling = Math.pow(10, -1 / 20);
    this.releaseCoef = 0;
    this.holdSamples = 0;
    this.lookahead = 1;
    this.gain = 1;
    this.holdLeft = 0;
    this.reductionDb = 0;
    // The delay line and the monotonic queue are allocated for the longest
    // permitted lookahead once; reconfiguring only moves pointers, so
    // processing never allocates or grows a container.
    // Literals on purpose: this class is stringified into the worklet module,
    // where no module-scope constant exists.
    this.maxLookahead = Math.max(1, Math.round(0.02 * this.sampleRate));
    const size = this.maxLookahead + 2;
    this.bufL = new Float32Array(size);
    this.bufR = new Float32Array(size);
    // One live entry per sample in the window, plus headroom for the push
    // before the expiry of the oldest entry.
    this.qCap = this.maxLookahead + 4;
    this.qVal = new Float32Array(this.qCap);
    this.qIdx = new Float64Array(this.qCap);
    this.qHead = 0;
    this.qTail = 0;
    this.qCount = 0;
    this.configure(-1, 60, 0, 2);
  }

  /** Ceiling, release, hold and lookahead in one write (values clamped). */
  configure(
    ceilingDb: number,
    releaseMs: number,
    holdMs: number,
    lookaheadMs: number,
  ): void {
    const db = Number.isFinite(ceilingDb) ? Math.min(0, Math.max(-24, ceilingDb)) : -1;
    this.ceiling = Math.pow(10, db / 20);
    const release = Number.isFinite(releaseMs)
      ? Math.min(2000, Math.max(10, releaseMs))
      : 60;
    this.releaseCoef = 1 - Math.exp(-1 / ((release / 1000) * this.sampleRate));
    const hold = Number.isFinite(holdMs) ? Math.min(500, Math.max(0, holdMs)) : 0;
    this.holdSamples = Math.round((hold / 1000) * this.sampleRate);
    const look = Number.isFinite(lookaheadMs)
      ? Math.min(20, Math.max(0.5, lookaheadMs))
      : 2;
    this.lookahead = Math.min(
      this.maxLookahead,
      Math.max(1, Math.round((look / 1000) * this.sampleRate)),
    );
  }

  get latencySamples(): number {
    return this.lookahead;
  }

  /** Current gain reduction as a positive number of dB. */
  get gainReductionDb(): number {
    return this.reductionDb;
  }

  /** Live entries in the monotonic queue (fixed capacity, for tests). */
  get queueDepth(): number {
    return this.qCount;
  }

  get queueCapacity(): number {
    return this.qCap;
  }

  private pushTarget(target: number): void {
    while (this.qCount > 0) {
      const back = (this.qTail - 1) % this.qCap;
      if (this.qVal[back] < target) break;
      this.qTail -= 1;
      this.qCount -= 1;
    }
    const slot = this.qTail % this.qCap;
    this.qVal[slot] = target;
    this.qIdx[slot] = this.total;
    this.qTail += 1;
    this.qCount += 1;
  }

  private expire(oldest: number): void {
    while (this.qCount > 0 && this.qIdx[this.qHead % this.qCap] < oldest) {
      this.qHead += 1;
      this.qCount -= 1;
    }
  }

  /**
   * Limit one block in place into `outL` / `outR`. Returns the peak gain
   * reduction seen in the block (positive dB).
   */
  process(
    inL: Float32Array,
    inR: Float32Array,
    outL: Float32Array,
    outR: Float32Array,
  ): number {
    const n = Math.min(inL.length, inR.length, outL.length, outR.length);
    const size = this.bufL.length;
    const window = this.lookahead;
    let worst = 0;
    for (let i = 0; i < n; i++) {
      const l = Number.isFinite(inL[i]) ? inL[i] : 0;
      const r = Number.isFinite(inR[i]) ? inR[i] : 0;
      const peak = Math.max(Math.abs(l), Math.abs(r));
      const target = peak > this.ceiling ? this.ceiling / peak : 1;

      this.pushTarget(target);
      this.expire(this.total - window);
      const windowGain = this.qCount > 0 ? this.qVal[this.qHead % this.qCap] : 1;

      if (windowGain < this.gain) {
        this.gain = windowGain;
        this.holdLeft = this.holdSamples;
      } else if (this.holdLeft > 0) {
        this.holdLeft -= 1;
      } else {
        this.gain += (1 - this.gain) * this.releaseCoef;
      }

      this.bufL[this.write] = l;
      this.bufR[this.write] = r;
      const read = (this.write - window + size) % size;
      outL[i] = this.bufL[read] * this.gain;
      outR[i] = this.bufR[read] * this.gain;
      this.write = (this.write + 1) % size;
      this.total += 1;

      const gr = this.gain > 0 ? -20 * Math.log10(Math.max(this.gain, 1e-9)) : 180;
      if (gr > worst) worst = gr;
    }
    this.reductionDb = Math.min(180, Math.max(0, worst));
    return this.reductionDb;
  }
}

/**
 * The module the audio thread loads. `LookaheadLimiter` is embedded from its
 * own source, so the worklet and the offline batch path cannot drift apart:
 * one implementation, one set of tests, two runtimes.
 */
export function limiterWorkletSource(): string {
  return `
const SpscRing = ${SpscRing.toString()};
const LookaheadLimiter = ${LookaheadLimiter.toString()};
class SignalpathLimiterProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.lim = new LookaheadLimiter(sampleRate);
    this.blocks = 0;
    // Metering is lock-free when the host supplies a SharedArrayBuffer: the
    // audio callback writes one float, the UI reads it, no message objects.
    try {
      const sab = options && options.processorOptions && options.processorOptions.meter;
      this.meter = sab ? new SpscRing(sab) : null;
    } catch (e) {
      this.meter = null;
    }
    this.port.onmessage = (e) => {
      const d = e.data || {};
      if (typeof d.ceilingDb === "number") {
        this.lim.configure(d.ceilingDb, d.releaseMs, d.holdMs, d.lookaheadMs);
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
    this.lim.process(inL, inR, outL, outR);
    if (this.meter) {
      this.meter.write(this.lim.gainReductionDb);
    } else if ((this.blocks++ & 7) === 0) {
      this.port.postMessage(this.lim.gainReductionDb);
    }
    return true;
  }
}
try { registerProcessor("${LIMITER_WORKLET_NAME}", SignalpathLimiterProcessor); } catch (e) {}
`;
}
