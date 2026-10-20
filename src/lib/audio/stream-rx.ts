/**
 * Stream RX engine — receiver-side playout core.
 *
 * The sender's clock and the receiver's clock are not the same. This engine
 * buffers arriving frames by a target delay measured from the observed
 * interarrival jitter, estimates the shared clock (stream-shared-clock.ts),
 * holds the output under the configured true-peak ceiling, and reports the
 * condition an operator should see on the badge.
 *
 * It owns no network I/O: a transport hands it decoded frame metadata
 * (`seq`, sender stamp, arrival time, peak/RMS), which keeps the playout
 * logic deterministic and testable without a socket or an AudioContext.
 *
 * Defaults: jitter Auto, ceiling −0.3 dBFS, adaptive clock on, protective
 * limits on. Every limit is overridable, and with the protective limits off
 * the engine still measures — it just stops dropping and clamping.
 */
import { AdaptiveClock } from "./stream-shared-clock";
import { rxBadge, type Badge, type RxBadge } from "./stream-status";

export type RxJitterSetting = "auto" | number;

export interface RxSettings {
  /** Target buffer: "auto" tracks measured jitter, a number is a fixed ms. */
  jitter: RxJitterSetting;
  /** Output ceiling, dBFS. The RX default is −0.3, not 0. */
  ceilingDb: number;
  /** Correct playout from the estimated clock drift. */
  clockAdaptive: boolean;
  /** Drop and clamp instead of passing damaged audio through. */
  protectiveLimits: boolean;
  /** Programme below this RMS counts as silence, dBFS. */
  silenceDb: number;
  /** Silence duration before the badge flips to SILENT, ms. */
  silenceMs: number;
  /** Auto-jitter floor and ceiling, ms. */
  minTargetMs: number;
  maxTargetMs: number;
  /** Jitter above which a frame counts as a late arrival, ms. */
  lateToleranceMs: number;
  /** Drift shown as DRIFTING above this magnitude, ppm. */
  driftLimitPpm: number;
  /** Rolling window for DROPPING, ms. */
  dropWindowMs: number;
}

export const DEFAULT_RX_SETTINGS: RxSettings = {
  jitter: "auto",
  ceilingDb: -0.3,
  clockAdaptive: true,
  protectiveLimits: true,
  silenceDb: -60,
  silenceMs: 3000,
  minTargetMs: 40,
  maxTargetMs: 1000,
  lateToleranceMs: 30,
  driftLimitPpm: 75,
  dropWindowMs: 10_000,
};

/** Metadata for one decoded frame, in the receiver's clock domain. */
export interface RxFrame {
  seq: number;
  /** Sender's timestamp for the frame, ms (any shared sender time base). */
  sentMs: number;
  /** Local arrival time, ms. */
  arrivalMs: number;
  /** Frame duration, ms; defaults to 20 when absent. */
  durationMs?: number;
  /** Post-decode peak, dBFS. */
  peakDb: number;
  /** Post-decode RMS, dBFS. */
  rmsDb: number;
}

export interface RxSnapshot {
  badge: Badge<RxBadge>;
  targetMs: number;
  jitterMs: number;
  bufferedFrames: number;
  bufferedMs: number;
  underruns: number;
  lateFrames: number;
  droppedFrames: number;
  limitedFrames: number;
  /** Most gain reduction the ceiling has applied, dB (positive number). */
  maxReductionDb: number;
  silent: boolean;
  silentMs: number;
  locked: boolean;
  driftPpm: number;
  correctionPpm: number;
  offsetMs: number;
  /** Frames pulled over the engine's lifetime. */
  pulledFrames: number;
}

interface QueuedFrame {
  frame: RxFrame;
  playoutAt: number;
  durationMs: number;
}

/** Ceiling gain for one frame: 0 dB when under, negative when clamped. */
export function ceilingGainDb(peakDb: number, ceilingDb: number): number {
  if (!Number.isFinite(peakDb)) return 0;
  return Math.min(0, ceilingDb - peakDb);
}

export class StreamRxEngine {
  settings: RxSettings;
  clock: AdaptiveClock;
  private queue: QueuedFrame[] = [];
  private lastSeq = -1;
  private lastTransitMs = 0;
  private jitterMs = 0;
  private hasTransit = false;
  private pulledFrames = 0;
  private limitedFrames = 0;
  private maxReductionDb = 0;
  private underruns = 0;
  private lateFrames = 0;
  private droppedFrames = 0;
  private events: { at: number; kind: "under" | "late" | "drop" }[] = [];
  private lastArrivalAt = 0;
  /** −1 until the first frame; 0 is a valid sender timestamp. */
  private lastLoudAt = -1;
  private lastReleaseAt = 0;
  private starved = false;
  private seenFrames = 0;

  constructor(settings: Partial<RxSettings> = {}) {
    this.settings = { ...DEFAULT_RX_SETTINGS, ...settings };
    this.clock = new AdaptiveClock({ adaptive: this.settings.clockAdaptive });
  }

  configure(patch: Partial<RxSettings>): void {
    this.settings = { ...this.settings, ...patch };
    this.clock.configure({ adaptive: this.settings.clockAdaptive });
  }

  reset(): void {
    this.queue = [];
    this.lastSeq = -1;
    this.lastTransitMs = 0;
    this.jitterMs = 0;
    this.hasTransit = false;
    this.pulledFrames = 0;
    this.limitedFrames = 0;
    this.maxReductionDb = 0;
    this.underruns = 0;
    this.lateFrames = 0;
    this.droppedFrames = 0;
    this.events = [];
    this.lastArrivalAt = 0;
    this.lastLoudAt = -1;
    this.lastReleaseAt = 0;
    this.starved = false;
    this.seenFrames = 0;
    this.clock.reset();
  }

  /** Current target delay, ms. Auto tracks jitter inside [min, max]. */
  targetMs(): number {
    const { jitter, minTargetMs, maxTargetMs } = this.settings;
    if (jitter !== "auto") {
      return clamp(Number(jitter) || 0, 0, maxTargetMs);
    }
    const frameMs = this.lastFrameMs();
    const tracked = 2.5 * this.jitterMs + frameMs * 2;
    return clamp(Math.max(minTargetMs, tracked), minTargetMs, maxTargetMs);
  }

  /** Trim the DROPPING event window so an old glitch does not stick forever. */
  private note(kind: "under" | "late" | "drop", at: number): void {
    this.events.push({ at, kind });
    const cutoff = at - this.settings.dropWindowMs;
    while (this.events.length > 0 && this.events[0].at < cutoff) this.events.shift();
  }

  private recent(kind: "under" | "late" | "drop"): boolean {
    return this.events.some((e) => e.kind === kind);
  }

  private lastFrameMs(): number {
    const last = this.queue[this.queue.length - 1];
    return last?.durationMs ?? 20;
  }

  /**
   * Accept one frame. Duplicates and reordering are dropped (a late frame is
   * worse than a gap at this layer). Returns false when the frame was not
   * queued.
   */
  push(frame: RxFrame): boolean {
    if (!Number.isFinite(frame.seq) || !Number.isFinite(frame.arrivalMs)) return false;
    if (frame.seq <= this.lastSeq) {
      this.lateFrames += 1;
      this.note("late", frame.arrivalMs);
      return false;
    }
    this.lastSeq = frame.seq;
    this.seenFrames += 1;
    this.lastArrivalAt = frame.arrivalMs;

    if (Number.isFinite(frame.sentMs)) {
      const transit = frame.arrivalMs - frame.sentMs;
      if (this.hasTransit) {
        // RFC 3550 EWMA of the interarrival variation.
        this.jitterMs += (Math.abs(transit - this.lastTransitMs) - this.jitterMs) / 16;
      }
      this.lastTransitMs = transit;
      this.hasTransit = true;
      this.clock.observe(frame.sentMs, frame.arrivalMs);
    }

    if (frame.rmsDb >= this.settings.silenceDb) this.lastLoudAt = frame.arrivalMs;

    const durationMs = Math.max(1, frame.durationMs ?? 20);
    const target = this.targetMs();
    this.queue.push({
      frame,
      durationMs,
      playoutAt: frame.arrivalMs + target,
    });

    if (this.settings.protectiveLimits) {
      const ceilingMs = Math.max(this.settings.minTargetMs * 2, target * 3 + 500);
      let buffered = this.bufferedMs();
      while (buffered > ceilingMs && this.queue.length > 0) {
        const dropped = this.queue.shift();
        buffered -= dropped?.durationMs ?? 0;
        this.droppedFrames += 1;
        this.note("drop", frame.arrivalMs);
      }
    }
    return true;
  }

  bufferedMs(): number {
    return this.queue.reduce((sum, q) => sum + q.durationMs, 0);
  }

  /**
   * Release every frame whose target delay has elapsed. Returns the frames
   * with their peak already clamped by the ceiling (when limits are on).
   */
  pull(nowMs: number): RxFrame[] {
    const out: RxFrame[] = [];
    while (this.queue.length > 0 && this.queue[0].playoutAt <= nowMs) {
      const next = this.queue.shift();
      if (next) out.push(this.clamp(next.frame));
    }

    if (out.length > 0) {
      this.pulledFrames += out.length;
      this.lastReleaseAt = nowMs;
      this.starved = false;
    } else if (
      this.seenFrames > 0 &&
      !this.starved &&
      this.lastArrivalAt > 0 &&
      nowMs - Math.max(this.lastReleaseAt, this.lastArrivalAt) > this.lastFrameMs() * 2
    ) {
      // The queue is empty and nothing has arrived for two frames: an
      // underrun episode is counted once, not once per pull.
      this.underruns += 1;
      this.starved = true;
      this.note("under", nowMs);
    }
    return out;
  }

  private clamp(frame: RxFrame): RxFrame {
    if (!this.settings.protectiveLimits) return frame;
    const gain = ceilingGainDb(frame.peakDb, this.settings.ceilingDb);
    if (gain >= 0) return frame;
    this.limitedFrames += 1;
    this.maxReductionDb = Math.max(this.maxReductionDb, -gain);
    return {
      ...frame,
      peakDb: frame.peakDb + gain,
      rmsDb: frame.rmsDb + gain,
    };
  }

  /** True when the programme has been quiet for the configured stretch. */
  silentMs(nowMs: number): number {
    if (this.lastLoudAt < 0) return 0;
    return Math.max(0, nowMs - this.lastLoudAt);
  }

  isSilent(nowMs: number): boolean {
    return this.lastLoudAt >= 0 && this.silentMs(nowMs) >= this.settings.silenceMs;
  }

  locked(): boolean {
    return this.seenFrames >= 6 && this.clock.locked();
  }

  dropping(): boolean {
    return this.recent("under") || this.recent("late") || this.recent("drop");
  }

  snapshot(nowMs: number): RxSnapshot {
    const silent = this.isSilent(nowMs);
    const locked = this.locked();
    const driftPpm = this.clock.driftPpm();
    const badge = rxBadge({
      locked,
      silent,
      dropping: this.dropping(),
      drifting: Math.abs(driftPpm) > this.settings.driftLimitPpm,
    });
    return {
      badge,
      targetMs: this.targetMs(),
      jitterMs: this.jitterMs,
      bufferedFrames: this.queue.length,
      bufferedMs: this.bufferedMs(),
      underruns: this.underruns,
      lateFrames: this.lateFrames,
      droppedFrames: this.droppedFrames,
      limitedFrames: this.limitedFrames,
      maxReductionDb: this.maxReductionDb,
      silent,
      silentMs: this.silentMs(nowMs),
      locked,
      driftPpm,
      correctionPpm: this.clock.correctionPpm(),
      offsetMs: this.clock.offsetMs(),
      pulledFrames: this.pulledFrames,
    };
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
