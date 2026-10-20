/**
 * Shared clock for the stream pair.
 *
 * The sender stamps audio with its own wall clock; the receiver has no shared
 * time base, so it estimates the offset from arrival times. The best sample
 * in a window is the one with the least queuing delay — the *minimum* of
 * (arrival − sent), not the average, which is why the offset filter is a
 * minimum rather than a mean (a mean would follow congestion instead of the
 * clock).
 *
 * Drift is the slope of that offset over local time, in parts per million.
 * With `adaptive` on, the receiver stretches its playout clock by the
 * measured slope, clamped to `maxAdjustPpm` so a burst of congestion cannot
 * yank the timeline. Adaptive is on by default; turning it off holds the
 * last offset and reports drift without correcting it.
 */

export interface ClockConfig {
  /** Correct the playout clock from the measured drift. */
  adaptive: boolean;
  /** Hard ceiling on correction, parts per million. */
  maxAdjustPpm: number;
  /** Offset spread (ms) that still counts as locked. */
  lockWindowMs: number;
  /** Samples required before a lock is declared. */
  lockSamples: number;
  /** Samples kept for the minimum / slope estimate. */
  windowSamples: number;
}

export const DEFAULT_CLOCK_CONFIG: ClockConfig = {
  adaptive: true,
  maxAdjustPpm: 500,
  lockWindowMs: 8,
  lockSamples: 6,
  windowSamples: 64,
};

export interface ClockSnapshot {
  /** remote = local + offset (ms). */
  offsetMs: number;
  driftPpm: number;
  /** Drift actually applied to the playout clock (0 when not adaptive). */
  correctionPpm: number;
  locked: boolean;
  samples: number;
  /** Peak-to-peak spread of the offset window, ms. */
  spreadMs: number;
}

interface Sample {
  localMs: number;
  /** arrival − sent; includes one-way delay plus clock offset. */
  offsetMs: number;
}

export class AdaptiveClock {
  config: ClockConfig;
  private samples: Sample[] = [];

  constructor(config: Partial<ClockConfig> = {}) {
    this.config = { ...DEFAULT_CLOCK_CONFIG, ...config };
  }

  configure(patch: Partial<ClockConfig>): void {
    this.config = { ...this.config, ...patch };
  }

  reset(): void {
    this.samples = [];
  }

  /**
   * Feed one arrival. `sentMs` and `localMs` must share a time base on their
   * own sides (monotonic is fine); only their difference is used.
   */
  observe(sentMs: number, localMs: number): void {
    if (!Number.isFinite(sentMs) || !Number.isFinite(localMs)) return;
    this.samples.push({ localMs, offsetMs: localMs - sentMs });
    if (this.samples.length > this.config.windowSamples) this.samples.shift();
  }

  /** Smallest observed offset — the least-delayed path through the network. */
  offsetMs(): number {
    if (this.samples.length === 0) return 0;
    let min = Infinity;
    for (const s of this.samples) min = Math.min(min, s.offsetMs);
    return min;
  }

  /**
   * Least-squares slope of offset against local time, converted to ppm.
   * Falls back to 0 until there are at least three samples.
   */
  driftPpm(): number {
    const n = this.samples.length;
    if (n < 3) return 0;
    let sumX = 0;
    let sumY = 0;
    for (const s of this.samples) {
      sumX += s.localMs;
      sumY += s.offsetMs;
    }
    const meanX = sumX / n;
    const meanY = sumY / n;
    let num = 0;
    let den = 0;
    for (const s of this.samples) {
      const dx = s.localMs - meanX;
      num += dx * (s.offsetMs - meanY);
      den += dx * dx;
    }
    if (den === 0) return 0;
    const slope = num / den; // ms of offset per ms of local time
    return clamp(slope * 1e6, -this.config.maxAdjustPpm, this.config.maxAdjustPpm);
  }

  /** Applied correction: the clamped drift when adaptive, otherwise none. */
  correctionPpm(): number {
    return this.config.adaptive ? this.driftPpm() : 0;
  }

  spreadMs(): number {
    if (this.samples.length === 0) return 0;
    let min = Infinity;
    let max = -Infinity;
    for (const s of this.samples) {
      min = Math.min(min, s.offsetMs);
      max = Math.max(max, s.offsetMs);
    }
    return max - min;
  }

  locked(): boolean {
    return (
      this.samples.length >= this.config.lockSamples &&
      this.spreadMs() <= this.config.lockWindowMs
    );
  }

  /** Sender timestamp → local playout time, drift-corrected. */
  remoteToLocal(remoteMs: number): number {
    const offset = this.offsetMs();
    const correction = this.correctionPpm() / 1e6;
    // Apply the correction to the elapsed distance from the window start.
    const base = this.samples[0]?.localMs ?? 0;
    const elapsed = remoteMs + offset - base;
    return base + elapsed * (1 + correction);
  }

  snapshot(): ClockSnapshot {
    return {
      offsetMs: this.offsetMs(),
      driftPpm: this.driftPpm(),
      correctionPpm: this.correctionPpm(),
      locked: this.locked(),
      samples: this.samples.length,
      spreadMs: this.spreadMs(),
    };
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
