/**
 * TX send buffer and pre-buffer.
 *
 * Encoders hand over chunks in bursts (a frame every 20–100 ms depending on
 * codec) while a source socket wants a steady flow at the configured
 * bitrate. This buffer does two jobs:
 *
 *  - pre-buffer: hold the first `prebufferMs` (400 ms by default) of audio
 *    before the socket is fed, so the first seconds are not a burst the
 *    server has to absorb and listeners can start immediately;
 *  - pacing: in steady state, hold `bufferMs` of audio in hand and release
 *    only the excess, which keeps the write rate tied to the encode rate
 *    instead of to the shell's IPC scheduling.
 *
 * The protective limits are on by default. When the queue passes the
 * protected ceiling the oldest audio is dropped — a live stream that falls
 * further behind is worse than one with a gap — and the drop is counted so
 * the badge can show WARN while the socket stays LIVE.
 */

export interface TxSettings {
  /** Audio held in the send queue during steady state, ms. */
  bufferMs: number;
  /** Audio accumulated before the first write, ms. */
  prebufferMs: number;
  /** Drop the oldest audio when the queue passes the protected ceiling. */
  protectiveLimits: boolean;
}

export const DEFAULT_TX_SETTINGS: TxSettings = {
  bufferMs: 500,
  prebufferMs: 400,
  protectiveLimits: true,
};

export const TX_LIMITS = {
  minBufferMs: 0,
  maxBufferMs: 5000,
  maxPrebufferMs: 5000,
  /** Protected ceiling as a multiple of the configured buffer. */
  ceilingFactor: 3,
  /** Absolute floor for the protected ceiling, ms. */
  minCeilingMs: 3000,
} as const;

/** Audio duration of `bytes` at `bitrateKbps`, ms. 0 when bitrate is unknown. */
export function bytesToMs(bytes: number, bitrateKbps: number): number {
  if (!(bitrateKbps > 0) || !(bytes > 0)) return 0;
  return (bytes * 8) / bitrateKbps;
}

/** Bytes carrying `ms` of audio at `bitrateKbps`. */
export function msToBytes(ms: number, bitrateKbps: number): number {
  if (!(bitrateKbps > 0) || !(ms > 0)) return 0;
  return (ms * bitrateKbps) / 8;
}

export interface TxQueueSnapshot {
  bufferedMs: number;
  bufferedBytes: number;
  /** Still filling the pre-buffer — nothing has been written yet. */
  priming: boolean;
  droppedBytes: number;
  droppedChunks: number;
  /** Protective limits engaged (drops or an over-ceiling queue). */
  warning: boolean;
}

/**
 * Pure queue — no timers and no socket. `enqueue` returns the chunks the
 * caller should write now, so the transport stays a thin writer and the
 * buffer is deterministically testable.
 */
export class TxBuffer {
  settings: TxSettings;
  private chunks: Uint8Array[] = [];
  private chunkMs: number[] = [];
  private bufferedMs = 0;
  private bufferedBytes = 0;
  private priming = true;
  private droppedBytes = 0;
  private droppedChunks = 0;

  constructor(settings: Partial<TxSettings> = {}) {
    this.settings = { ...DEFAULT_TX_SETTINGS };
    this.configure(settings);
  }

  configure(patch: Partial<TxSettings>): void {
    const next = { ...this.settings, ...patch };
    this.settings = {
      bufferMs: clamp(next.bufferMs, TX_LIMITS.minBufferMs, TX_LIMITS.maxBufferMs),
      prebufferMs: clamp(next.prebufferMs, 0, TX_LIMITS.maxPrebufferMs),
      protectiveLimits: next.protectiveLimits,
    };
  }

  /** Clear the queue. Called on start and after a reconnect (audio is stale). */
  reset(): void {
    this.chunks = [];
    this.chunkMs = [];
    this.bufferedMs = 0;
    this.bufferedBytes = 0;
    this.priming = true;
    this.droppedBytes = 0;
    this.droppedChunks = 0;
  }

  ceilingMs(): number {
    if (!this.settings.protectiveLimits) return Infinity;
    return Math.max(
      TX_LIMITS.minCeilingMs,
      this.settings.bufferMs * TX_LIMITS.ceilingFactor,
    );
  }

  /**
   * Queue one encoded chunk and return the bytes to write now. An empty
   * array means the pre-buffer is still filling or the queue is holding its
   * target delay.
   */
  enqueue(bytes: Uint8Array, bitrateKbps: number): Uint8Array[] {
    if (bytes.byteLength === 0) return [];
    const ms = bytesToMs(bytes.byteLength, bitrateKbps);
    this.chunks.push(bytes);
    this.chunkMs.push(ms);
    this.bufferedBytes += bytes.byteLength;
    this.bufferedMs += ms;

    // Without a bitrate there is no duration to pace or bound the queue by.
    // Pass audio straight through instead of holding it forever.
    if (!(bitrateKbps > 0)) {
      this.priming = false;
      return this.flushAll();
    }

    this.enforceCeiling();

    if (this.priming) {
      // Zero pre-buffer means "go now" — there is nothing to wait for.
      if (this.bufferedMs < this.settings.prebufferMs && this.settings.prebufferMs > 0) {
        return [];
      }
      this.priming = false;
      return this.flushAll();
    }

    const excess = this.bufferedMs - this.settings.bufferMs;
    if (excess <= 0) return [];
    return this.releaseMs(excess);
  }

  /** Drop from the front until the queue is inside the protected ceiling. */
  private enforceCeiling(): void {
    const ceiling = this.ceilingMs();
    while (this.bufferedMs > ceiling && this.chunks.length > 0) {
      const dropped = this.chunks.shift();
      const ms = this.chunkMs.shift() ?? 0;
      this.bufferedMs -= ms;
      this.bufferedBytes -= dropped?.byteLength ?? 0;
      this.droppedChunks += 1;
      this.droppedBytes += dropped?.byteLength ?? 0;
    }
    if (this.bufferedMs < 0) this.bufferedMs = 0;
    if (this.bufferedBytes < 0) this.bufferedBytes = 0;
  }

  private flushAll(): Uint8Array[] {
    const total = this.bufferedBytes;
    if (total === 0) return [];
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    this.chunks = [];
    this.chunkMs = [];
    this.bufferedMs = 0;
    this.bufferedBytes = 0;
    return [out];
  }

  /** Release roughly `ms` of audio from the front of the queue. */
  private releaseMs(ms: number): Uint8Array[] {
    let remaining = ms;
    let bytes = 0;
    let count = 0;
    // Release whole chunks while they fit; a partially released chunk would
    // need a split buffer for no gain on a byte stream. The first chunk is
    // always released when we are over target, even if it alone overshoots.
    while (count < this.chunks.length) {
      const chunkMs = this.chunkMs[count] ?? 0;
      if (count > 0 && chunkMs > remaining + 1e-9) break;
      remaining -= chunkMs;
      bytes += this.chunks[count].byteLength;
      count += 1;
      if (remaining <= 0) break;
    }
    if (bytes === 0) return [];
    const out = new Uint8Array(bytes);
    let offset = 0;
    for (let i = 0; i < count; i += 1) {
      const chunk = this.chunks.shift();
      if (!chunk) break;
      const chunkMs = this.chunkMs.shift() ?? 0;
      out.set(chunk, offset);
      offset += chunk.byteLength;
      this.bufferedBytes -= chunk.byteLength;
      this.bufferedMs -= chunkMs;
    }
    if (this.bufferedMs < 0) this.bufferedMs = 0;
    if (this.bufferedBytes < 0) this.bufferedBytes = 0;
    return [out];
  }

  snapshot(): TxQueueSnapshot {
    return {
      bufferedMs: this.bufferedMs,
      bufferedBytes: this.bufferedBytes,
      priming: this.priming,
      droppedBytes: this.droppedBytes,
      droppedChunks: this.droppedChunks,
      warning:
        this.droppedChunks > 0 ||
        (this.settings.protectiveLimits &&
          this.bufferedMs >= this.ceilingMs() * 0.9),
    };
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
