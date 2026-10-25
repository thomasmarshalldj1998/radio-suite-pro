/**
 * Clock health — is the audio graph still keeping up with real time?
 *
 * The engine compares `AudioContext.currentTime` against wall time once a
 * second. A perfectly healthy graph advances both by the same amount; a graph
 * whose render thread was starved (an underrun, a long GC pause, a suspended
 * context) falls behind, and the difference is exactly the audio that never
 * reached the device — an audible glitch.
 *
 * This module turns that raw number into episodes, so one bad second is not
 * three alarms and a recovery is told apart from the stall that preceded it.
 * It is pure apart from the timestamps the caller passes in, which is what
 * lets the rules be checked tick by tick without an audio device.
 */

export interface GlitchConfig {
  /** Drift at or below this (ms per second) is a starved render thread. */
  thresholdMs: number;
  /** Consecutive one-second samples below the threshold before reporting. */
  holdTicks: number;
  /** Drift at or above this (ms per second) is healthy again. */
  recoverMs: number;
}

export const DEFAULT_GLITCH: GlitchConfig = {
  thresholdMs: -6,
  holdTicks: 2,
  recoverMs: -1,
};

/**
 * One clock-drift reading: how far the audio clock moved against wall time.
 *
 * The engine samples this from the meter pass, which is *not* a fixed-rate
 * timer: it is a requestAnimationFrame loop that slows down when the page is
 * busy and stops entirely in a background tab. Turning that into "ms of audio
 * lost per second" therefore has to divide by the interval actually measured —
 * a 1.5 s gap with 6 ms lost is 4 ms/s, not 6 — and has to refuse readings it
 * cannot trust rather than reporting them as stalls.
 */
export interface DriftReading {
  /** Wall time between the two samples (ms). */
  intervalMs: number;
  /** Audio clock advance over the same interval (ms). */
  audioMs: number;
  /** False when the context was not running at the sample point. */
  running: boolean;
}

/** Below this the clock has not advanced enough to resolve a rate. */
export const MIN_DRIFT_INTERVAL_MS = 600;
/** Above this the sample covers a throttled/backgrounded page: reject it. */
export const MAX_DRIFT_INTERVAL_MS = 2600;

/**
 * Convert a reading into ms of audio lost per second of wall time.
 *
 * Returns null when the reading cannot be trusted: a suspended context (the
 * clock is not meant to advance), a gap too short to resolve, or a gap long
 * enough to be a throttled tab rather than a starved render thread. The caller
 * must treat null as "no new information" and re-baseline, never as "healthy"
 * or "stalled" — that distinction is what stops a background tab from being
 * reported as an audio underrun.
 */
export function driftPerSecond(reading: DriftReading): number | null {
  const { intervalMs, audioMs, running } = reading;
  if (!running) return null;
  if (!Number.isFinite(intervalMs) || !Number.isFinite(audioMs)) return null;
  if (intervalMs < MIN_DRIFT_INTERVAL_MS) return null;
  if (intervalMs > MAX_DRIFT_INTERVAL_MS) return null;
  const lostMs = audioMs - intervalMs;
  return (lostMs / intervalMs) * 1000;
}

export interface GlitchEvent {
  type: "stall" | "recovered";
  at: number;
  /** The one-second drift that produced the transition, ms. */
  driftMs: number;
  /** Consecutive starved seconds at the moment of the report. */
  ticks: number;
}

export class GlitchMonitor {
  config: GlitchConfig;
  /** The graph is currently losing time. */
  stalled = false;
  /** Starved episodes reported this session. */
  stalls = 0;
  /** Epoch ms of the last stall report (0 = never). */
  lastStallAt = 0;
  /** Worst one-second drift seen this session (ms, negative = starved). */
  worstDriftMs = 0;
  /** Consecutive samples below the threshold. */
  private below = 0;

  constructor(config: Partial<GlitchConfig> = {}) {
    this.config = { ...DEFAULT_GLITCH, ...config };
  }

  reset(): void {
    this.stalled = false;
    this.stalls = 0;
    this.lastStallAt = 0;
    this.worstDriftMs = 0;
    this.below = 0;
  }

  /**
   * Feed one drift sample (ms of audio lost per second of wall time).
   * Returns an event only on a transition: one stall per episode and one
   * recovery when the graph catches up again.
   */
  update(driftMs: number, now: number): GlitchEvent | null {
    if (!Number.isFinite(driftMs)) return null;
    if (driftMs < this.worstDriftMs) this.worstDriftMs = driftMs;

    if (driftMs <= this.config.thresholdMs) {
      this.below += 1;
      if (!this.stalled && this.below >= this.config.holdTicks) {
        this.stalled = true;
        this.stalls += 1;
        this.lastStallAt = now;
        return { type: "stall", at: now, driftMs, ticks: this.below };
      }
      return null;
    }

    // Only a reading near zero proves the graph is healthy again; a sample
    // between the threshold and the recovery point is merely inconclusive and
    // must not reset the streak.
    if (driftMs >= this.config.recoverMs) {
      this.below = 0;
      if (this.stalled) {
        this.stalled = false;
        return { type: "recovered", at: now, driftMs, ticks: 0 };
      }
    }
    return null;
  }
}
