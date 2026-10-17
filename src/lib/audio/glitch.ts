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
