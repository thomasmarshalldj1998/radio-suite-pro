/**
 * Lock-free single-producer / single-consumer ring of float32 values.
 *
 * The producer is the audio thread (an AudioWorklet), the consumer is the UI
 * thread. Both indices are 32-bit atomics over a SharedArrayBuffer, and the
 * payload slots are only ever touched by one side at a time, so neither
 * thread takes a lock and the audio callback never waits.
 *
 * Capacity is fixed at construction. When the UI cannot keep up, the writer
 * refuses the value and increments `dropped` instead of overwriting unread
 * data — metering may skip a tick, it may never tear.
 *
 * `latest()` is the cheap path for meters: it reads the most recent value
 * without consuming the queue, so a slow UI frame still shows fresh gain
 * reduction. The ring itself is for anything that must not be missed.
 *
 * No imports and no module constants: this class's source is embedded in the
 * generated limiter worklet, exactly like the limiter kernel.
 */

export const SPSC_HEADER_BYTES = 16;

export class SpscRing {
  private header: Int32Array;
  private data: Float32Array;
  private lastF32: Float32Array;
  private lastI32: Int32Array;
  private cap: number;

  constructor(sab: SharedArrayBuffer) {
    if (typeof SharedArrayBuffer === "undefined" || !(sab instanceof SharedArrayBuffer)) {
      throw new Error("SpscRing needs a SharedArrayBuffer");
    }
    if (sab.byteLength < 20 || (sab.byteLength - 16) % 4 !== 0) {
      throw new Error("SpscRing buffer is malformed");
    }
    // [write, read, dropped, last-bits]
    this.header = new Int32Array(sab, 0, 4);
    // Two views over the same four bytes: float write, int publish. Both are
    // allocated here so write() never creates a view or a buffer.
    this.lastF32 = new Float32Array(sab, 12, 1);
    this.lastI32 = new Int32Array(sab, 12, 1);
    this.data = new Float32Array(sab, 16);
    this.cap = this.data.length;
  }

  /** Slots available to the producer. */
  capacity(): number {
    return this.cap;
  }

  /** Unread values. */
  available(): number {
    const write = Atomics.load(this.header, 0);
    const read = Atomics.load(this.header, 1);
    return Math.max(0, Math.min(this.cap, write - read));
  }

  /** Values the producer could not enqueue because the consumer was behind. */
  dropped(): number {
    return Atomics.load(this.header, 2);
  }

  /** Enqueue one value. Returns false when full (the value is then dropped). */
  write(value: number): boolean {
    const write = Atomics.load(this.header, 0);
    const read = Atomics.load(this.header, 1);
    if (write - read >= this.cap) {
      Atomics.add(this.header, 2, 1);
      return false;
    }
    this.data[write % this.cap] = value;
    // Publish the value before the index so the consumer never sees an index
    // that points at an unwritten slot.
    this.lastF32[0] = value;
    Atomics.store(this.header, 3, this.lastI32[0]);
    Atomics.store(this.header, 0, write + 1);
    return true;
  }

  /** Dequeue one value, or null when empty. */
  read(): number | null {
    const read = Atomics.load(this.header, 1);
    const write = Atomics.load(this.header, 0);
    if (read === write) return null;
    const value = this.data[read % this.cap];
    Atomics.store(this.header, 1, read + 1);
    return value;
  }

  /** Most recent value the producer wrote, without consuming it. */
  latest(): number {
    return this.lastF32[0];
  }

  /** Drop every unread value (consumer-side reset). */
  clear(): void {
    Atomics.store(this.header, 1, Atomics.load(this.header, 0));
  }
}

/** Allocate a ring plus its transferable SAB. */
export function createSpscRing(capacity: number): {
  sab: SharedArrayBuffer;
  ring: SpscRing;
} {
  const cap = Math.max(2, Math.min(65_536, Math.floor(capacity)));
  const sab = new SharedArrayBuffer(SPSC_HEADER_BYTES + cap * 4);
  return { sab, ring: new SpscRing(sab) };
}
