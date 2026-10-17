/**
 * Composite over IP — link framing, jitter buffer and dual-link splice.
 *
 * The FM composite is what an exciter needs, so feeding it across a network is
 * how a studio and a transmitter site get wired together without a baseband
 * STL. This module is the link layer only: it takes whatever the codec
 * produced (FLAC frames, or raw composite PCM) and makes a packet stream out
 * of it that a receiver can reorder, measure, conceal and splice.
 *
 *   packetiser → [ network ] → jitter buffer → dual-link splice → receiver
 *
 * Everything is a plain object with an injected clock, so the whole path runs
 * deterministically under test (`scripts/verify-mpxlink.ts`) and the same
 * objects drive the console's link panel and its loopback self-test.
 */
export const MPX_LINK_MAGIC = 0x4d505831; // "MPX1"
export const MPX_LINK_VERSION = 1;
/** magic, version, codec, channels, link, sequence, timestamp, rate, length, CRC */
export const MPX_LINK_HEADER_BYTES = 28;

/** 192 kHz composite, mono, 16-bit equivalent frame — the wire granularity. */
export const MPX_LINK_FRAME_SAMPLES = 1024;

export type MpxCodec = "flac" | "raw";

const CODEC_ID: Record<MpxCodec, number> = { raw: 0, flac: 1 };
const CODEC_BY_ID: Record<number, MpxCodec> = { 0: "raw", 1: "flac" };

export interface MpxPacket {
  codec: MpxCodec;
  /** Monotonic per link, wraps at 2^32. */
  sequence: number;
  /** Composite sample position of the first sample in the payload. */
  timestamp: number;
  sampleRate: number;
  channels: number;
  /** 0 = link A, 1 = link B. */
  link: number;
  payload: Uint8Array;
  /** Set on a packet the receiver synthesised to cover a gap. */
  concealed?: boolean;
}

export interface LinkHealth {
  /** A packet has arrived within the silence timeout. */
  alive: boolean;
  /** Lost frames as a percentage of frames expected, over the whole link. */
  lossPct: number;
  /** Interarrival jitter, ms (RFC 3550 estimator). */
  jitterMs: number;
  /** Frames currently held, ms of composite. */
  depthMs: number;
  /** Payload throughput, kbit/s. */
  kbps: number;
  received: number;
  lost: number;
  duplicates: number;
  reordered: number;
  concealed: number;
  /** Milliseconds since the newest packet arrived. */
  silentMs: number;
}

export interface SpliceEvent {
  at: number;
  from: number;
  to: number;
  reason: string;
}

/* ── framing ───────────────────────────────────────────────────────────── */

/** CRC-32 (IEEE 802.3, reflected, 0xEDB88320) — over the header and payload. */
let crcTable: Uint32Array | null = null;

function buildCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
}

export function crc32(bytes: Uint8Array): number {
  const table = (crcTable ??= buildCrcTable());
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = table[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** Serialise a packet: 28-byte little-endian header, then the payload. */
export function encodePacket(p: MpxPacket): Uint8Array {
  const out = new Uint8Array(MPX_LINK_HEADER_BYTES + p.payload.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, MPX_LINK_MAGIC, true);
  view.setUint8(4, MPX_LINK_VERSION);
  view.setUint8(5, CODEC_ID[p.codec]);
  view.setUint8(6, p.channels & 0xff);
  view.setUint8(7, p.link & 0xff);
  view.setUint32(8, p.sequence >>> 0, true);
  view.setUint32(12, p.timestamp >>> 0, true);
  view.setUint32(16, p.sampleRate >>> 0, true);
  view.setUint32(20, p.payload.byteLength, true);
  out.set(p.payload, MPX_LINK_HEADER_BYTES);
  // CRC covers the header with its own field zeroed, plus the payload
  view.setUint32(24, 0, true);
  view.setUint32(24, crc32(out), true);
  return out;
}

/** Parse a packet, or null if it is not one of ours (bad magic, length, CRC). */
export function decodePacket(buf: Uint8Array): MpxPacket | null {
  if (buf.byteLength < MPX_LINK_HEADER_BYTES) return null;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (view.getUint32(0, true) !== MPX_LINK_MAGIC) return null;
  if (view.getUint8(4) !== MPX_LINK_VERSION) return null;
  const codec = CODEC_BY_ID[view.getUint8(5)];
  if (!codec) return null;
  const length = view.getUint32(20, true);
  if (MPX_LINK_HEADER_BYTES + length !== buf.byteLength) return null;
  const want = view.getUint32(24, true);
  view.setUint32(24, 0, true);
  const got = crc32(buf);
  if (got !== want) return null;
  return {
    codec,
    sequence: view.getUint32(8, true),
    timestamp: view.getUint32(12, true),
    sampleRate: view.getUint32(16, true),
    channels: view.getUint8(6),
    link: view.getUint8(7),
    payload: buf.subarray(MPX_LINK_HEADER_BYTES),
  };
}

/** Forward distance from `last` to `next`, correct across the 2^32 wrap. */
export function sequenceGap(last: number, next: number): number {
  return (next - last) >>> 0;
}

/* ── sender ────────────────────────────────────────────────────────────── */

export interface PacketiserStats {
  packets: number;
  bytes: number;
  kbps: number;
  fps: number;
  sequence: number;
  /** Composite sample position carried by the newest packet. */
  timestamp: number;
}

/** Slices codec output (or composite PCM) into a numbered packet stream. */
export class MpxPacketiser {
  private seq = 0;
  private timestamp = 0;
  private packets = 0;
  private bytes = 0;
  private windowBytes = 0;
  private windowStart: number;
  private windowPackets = 0;
  private kbps = 0;
  private fps = 0;

  private readonly link: number;
  private readonly sampleRate: number;
  private readonly channels: number;
  private readonly now: () => number;

  constructor(
    link: number,
    sampleRate: number,
    channels = 1,
    now: () => number = () => Date.now(),
  ) {
    this.link = link;
    this.sampleRate = sampleRate;
    this.channels = channels;
    this.now = now;
    this.windowStart = now();
  }

  /**
   * Wrap one chunk. `samples` advances the composite clock; for a compressed
   * codec the caller passes the samples the chunk decoded to (the packet still
   * carries the right timestamp, which is what the receiver reorders on).
   */
  push(codec: MpxCodec, payload: Uint8Array, samples = MPX_LINK_FRAME_SAMPLES): MpxPacket {
    const packet: MpxPacket = {
      codec,
      sequence: this.seq,
      timestamp: this.timestamp,
      sampleRate: this.sampleRate,
      channels: this.channels,
      link: this.link,
      payload,
    };
    this.seq = (this.seq + 1) >>> 0;
    this.timestamp = (this.timestamp + samples) >>> 0;
    this.packets += 1;
    this.bytes += payload.byteLength;
    this.windowBytes += payload.byteLength;
    this.windowPackets += 1;
    const now = this.now();
    const elapsed = now - this.windowStart;
    if (elapsed >= 500) {
      this.kbps = (this.windowBytes * 8) / elapsed;
      this.fps = (this.windowPackets * 1000) / elapsed;
      this.windowBytes = 0;
      this.windowPackets = 0;
      this.windowStart = now;
    }
    return packet;
  }

  stats(): PacketiserStats {
    return {
      packets: this.packets,
      bytes: this.bytes,
      kbps: this.kbps,
      fps: this.fps,
      sequence: this.seq === 0 ? 0xffffffff : this.seq - 1,
      timestamp: this.timestamp,
    };
  }
}

/* ── receiver: jitter buffer ───────────────────────────────────────────── */

export interface JitterBufferConfig {
  /** Composite held before playout starts, ms — trades latency for loss cover. */
  targetMs: number;
  /** A forward gap this long is treated as loss and skipped, ms. */
  gapTimeoutMs: number;
  /** Repeat the previous payload over a gap instead of muting it. */
  conceal: boolean;
  sampleRate: number;
}

const DEFAULT_JITTER: Omit<JitterBufferConfig, "sampleRate"> = {
  targetMs: 120,
  gapTimeoutMs: 200,
  conceal: true,
};

interface Held {
  packet: MpxPacket;
  arrival: number;
}

/**
 * Reorders a link's packets, releases them on a constant playout delay, and
 * measures what the network did to them: loss, duplicates, reordering and
 * RFC 3550 interarrival jitter.
 */
export class MpxJitterBuffer {
  config: JitterBufferConfig;
  private held = new Map<number, Held>();
  /** Next sequence to release; -1 until the first pull commits an origin. */
  private expect = -1;
  private lastTransit = -1;
  private jitter = 0;
  private lastPayload: Uint8Array | null = null;
  private lastReleased: MpxPacket | null = null;
  /** Media step between frames, learned from the stream itself. */
  private stepSamples = MPX_LINK_FRAME_SAMPLES;
  private newestTimestamp = -1;
  private newestSeq = -1;
  private lastArrival = 0;
  private firstArrival = 0;
  private stats = {
    received: 0,
    lost: 0,
    duplicates: 0,
    reordered: 0,
    concealed: 0,
    bytes: 0,
    windowBytes: 0,
    windowStart: 0,
    kbps: 0,
    dropped: 0,
  };

  private readonly now: () => number;

  constructor(
    now: () => number = () => Date.now(),
    config: Partial<JitterBufferConfig> & { sampleRate: number },
  ) {
    this.now = now;
    const { sampleRate, ...rest } = config;
    this.config = { sampleRate, ...DEFAULT_JITTER, ...rest };
    this.stats.windowStart = now();
  }

  /**
   * Accept a packet: drop duplicates, count late arrivals, update the jitter
   * estimate. Nothing is classified as lost here — that needs evidence that
   * time moved on, which is what `pull` waits for.
   */
  push(packet: MpxPacket): void {
    const now = this.now();
    const s = this.stats;
    if (this.expect >= 0) {
      const gap = sequenceGap(this.expect, packet.sequence);
      if (gap >= 0x80000000) {
        // behind the playout point: too late to be used
        s.duplicates += 1;
        return;
      }
    }
    if (this.held.has(packet.sequence)) {
      s.duplicates += 1;
      return;
    }
    if (this.newestTimestamp >= 0 && packet.timestamp < this.newestTimestamp) {
      s.reordered += 1;
    } else if (this.newestTimestamp >= 0) {
      // the media step is only learned from genuinely adjacent frames — a
      // packet that skipped a lost one carries two frames' worth of time
      const step = packet.timestamp - this.newestTimestamp;
      if (step > 0 && sequenceGap(this.newestSeq, packet.sequence) === 1) {
        this.stepSamples = step;
      }
      this.newestTimestamp = packet.timestamp;
      this.newestSeq = packet.sequence;
    } else {
      this.newestTimestamp = packet.timestamp;
      this.newestSeq = packet.sequence;
    }
    this.held.set(packet.sequence, { packet, arrival: now });

    // RFC 3550 interarrival jitter, from the timestamp clock
    const arrivalMs = now;
    const rtpMs = (packet.timestamp / packet.sampleRate) * 1000;
    const transit = arrivalMs - rtpMs;
    if (this.lastTransit >= 0) {
      const d = Math.abs(transit - this.lastTransit);
      this.jitter += (d - this.jitter) / 16;
    }
    this.lastTransit = transit;

    s.received += 1;
    s.bytes += packet.payload.byteLength;
    s.windowBytes += packet.payload.byteLength;
    this.lastArrival = now;
    if (this.firstArrival === 0) this.firstArrival = now;
    const elapsed = now - s.windowStart;
    if (elapsed >= 500) {
      s.kbps = (s.windowBytes * 8) / elapsed;
      s.windowBytes = 0;
      s.windowStart = now;
    }
  }

  /**
   * Release the next packet in sequence order, or null while the buffer is
   * still filling (or nothing has arrived). A gap is skipped once it has
   * outlived `gapTimeoutMs`, and concealed by repeating the previous payload
   * when concealment is on.
   */
  /** The oldest frame held, chosen on the media clock so the wrap is safe. */
  private oldestHeld(): [number, Held] | null {
    let best: [number, Held] | null = null;
    for (const entry of this.held.entries()) {
      if (!best || entry[1].packet.timestamp < best[1].packet.timestamp) best = entry;
    }
    return best;
  }

  pull(): MpxPacket | null {
    if (this.held.size === 0) return null;
    const now = this.now();
    if (this.expect < 0) {
      // start-up: reordering before the first release is normal, so the
      // playout origin is the oldest frame we actually hold
      const oldest = this.oldestHeld();
      if (!oldest) return null;
      this.expect = oldest[0];
    }
    const next = this.held.get(this.expect);
    if (next) {
      // hold until the configured playout delay has passed since it arrived
      if (now - next.arrival < this.config.targetMs) return null;
      this.held.delete(this.expect);
      this.expect = (this.expect + 1) >>> 0;
      this.lastPayload = next.packet.payload;
      this.lastReleased = next.packet;
      this.lastArrival = now;
      return next.packet;
    }

    // The expected frame is missing. It is only lost once a later frame has
    // been sitting here longer than the gap timeout — that waiting frame is
    // the evidence that the stream moved on without it.
    let later: Held | null = null;
    let distance = Infinity;
    for (const [seq, entry] of this.held) {
      const gap = sequenceGap(this.expect, seq);
      if (gap > 0 && gap < distance) {
        distance = gap;
        later = entry;
      }
    }
    if (!later) return null;
    if (now - later.arrival < this.config.gapTimeoutMs) return null;

    const missing = this.expect;
    this.stats.lost += 1;
    this.expect = (this.expect + 1) >>> 0;
    if (this.config.conceal && this.lastPayload && this.lastReleased) {
      // one concealed frame per missing frame, carrying the missing frame's
      // own sequence and timestamp so the composite clock stays aligned
      this.stats.concealed += 1;
      const step =
        this.stepSamples > 0 ? this.stepSamples : MPX_LINK_FRAME_SAMPLES;
      return {
        codec: this.lastReleased.codec,
        sequence: missing,
        timestamp: (this.lastReleased.timestamp + step) >>> 0,
        sampleRate: this.lastReleased.sampleRate,
        channels: this.lastReleased.channels,
        link: this.lastReleased.link,
        payload: this.lastPayload,
        concealed: true,
      };
    }
    // concealment off: skip the whole gap at once and release what follows
    this.stats.lost += distance - 1;
    this.expect = (this.expect + (distance - 1)) >>> 0;
    const substitute = this.held.get(this.expect);
    if (!substitute) return null;
    this.held.delete(this.expect);
    this.expect = (this.expect + 1) >>> 0;
    this.lastPayload = substitute.packet.payload;
    this.lastReleased = substitute.packet;
    this.lastArrival = now;
    return substitute.packet;
  }

  /**
   * Drop everything buffered beyond the playout target and start again from
   * the newest held packet — how a splice jumps onto a link that has been
   * running with its own backlog, without replaying old composite.
   * Returns the number of frames dropped.
   */
  trimToTarget(): number {
    if (this.held.size === 0) return 0;
    let newest: [number, Held] | null = null;
    for (const entry of this.held.entries()) {
      if (!newest || entry[1].packet.timestamp > newest[1].packet.timestamp) {
        newest = entry;
      }
    }
    if (!newest) return 0;
    const step = this.stepSamples > 0 ? this.stepSamples : MPX_LINK_FRAME_SAMPLES;
    const windowFrames = Math.max(
      1,
      Math.round((this.config.targetMs / 1000) * this.config.sampleRate / step),
    );
    let dropped = 0;
    for (const [seq] of [...this.held.entries()]) {
      // frames behind the newest one are the backlog a splice must not replay
      const back = sequenceGap(seq, newest[0]);
      if (back > windowFrames) {
        this.held.delete(seq);
        this.stats.dropped += 1;
        dropped += 1;
      }
    }
    const first = this.oldestHeld();
    if (first && (this.expect < 0 || sequenceGap(this.expect, first[0]) < 0x80000000)) {
      this.expect = first[0];
    }
    return dropped;
  }

  reset(): void {
    this.held.clear();
    this.expect = -1;
    this.lastTransit = -1;
    this.jitter = 0;
    this.lastPayload = null;
    this.lastReleased = null;
    this.newestTimestamp = -1;
    this.newestSeq = -1;
    this.lastArrival = 0;
    this.firstArrival = 0;
  }

  /** Measured health of this link. */
  health(silenceMs: number): LinkHealth {
    const s = this.stats;
    const expected = s.received + s.lost;
    const depth = this.depthMs();
    return {
      alive: this.lastArrival !== 0 && this.now() - this.lastArrival <= silenceMs,
      lossPct: expected > 0 ? (s.lost / expected) * 100 : 0,
      jitterMs: this.jitter,
      depthMs: depth,
      kbps: s.kbps,
      received: s.received,
      lost: s.lost,
      duplicates: s.duplicates,
      reordered: s.reordered,
      concealed: s.concealed,
      silentMs: this.lastArrival === 0 ? Infinity : this.now() - this.lastArrival,
    };
  }

  /** Composite held between the oldest and newest frames, ms. */
  private depthMs(): number {
    if (this.held.size === 0) return 0;
    let min = Infinity;
    let max = -Infinity;
    for (const { packet } of this.held.values()) {
      if (packet.timestamp < min) min = packet.timestamp;
      if (packet.timestamp > max) max = packet.timestamp;
    }
    if (min === Infinity) return 0;
    return ((max - min) / this.config.sampleRate) * 1000;
  }
}

/* ── receiver: dual link with automatic splice ─────────────────────────── */

export interface DualLinkConfig {
  targetMs: number;
  gapTimeoutMs: number;
  conceal: boolean;
  sampleRate: number;
  /** Loss above this marks a link degraded, %. */
  maxLossPct: number;
  /** Jitter above this marks a link degraded, ms. */
  maxJitterMs: number;
  /** No packet for this long marks a link dead, ms. */
  silenceMs: number;
  /** A degraded state must persist this long before the splice runs, ms. */
  holdMs: number;
  /** Prefer the other link only if it is better by this much, ms of jitter. */
  marginMs: number;
}

const DEFAULT_DUAL: DualLinkConfig = {
  targetMs: 120,
  gapTimeoutMs: 200,
  conceal: true,
  sampleRate: 192000,
  maxLossPct: 1.5,
  maxJitterMs: 25,
  silenceMs: 400,
  holdMs: 500,
  marginMs: 5,
};

const splices: SpliceEvent[] = [];
const spliceListeners = new Set<() => void>();

export function getSplices(): SpliceEvent[] {
  return splices;
}

export function subscribeSplices(cb: () => void): () => void {
  spliceListeners.add(cb);
  return () => {
    spliceListeners.delete(cb);
  };
}

export function clearSplices(): void {
  splices.length = 0;
  for (const cb of spliceListeners) cb();
}

/**
 * Receiver for two independent paths. One is active; the other is fed and
 * measured alongside it. When the active link degrades past its thresholds for
 * longer than the hold time, the receiver splices onto the healthy link,
 * trimming its buffer to the playout target so the switch lands on a frame
 * boundary without replaying composite that has already gone out.
 */
export class MpxDualLink {
  config: DualLinkConfig;
  buffers: [MpxJitterBuffer, MpxJitterBuffer];
  /** null = automatic, otherwise 0 or 1 to hold a link manually. */
  private forced: number | null = null;
  private active = 0;
  private degradedSince = [0, 0];
  private events: SpliceEvent[] = [];

  private readonly now: () => number;

  constructor(
    now: () => number = () => Date.now(),
    config: Partial<DualLinkConfig> = {},
  ) {
    this.now = now;
    this.config = { ...DEFAULT_DUAL, ...config };
    const make = () =>
      new MpxJitterBuffer(now, {
        sampleRate: this.config.sampleRate,
        targetMs: this.config.targetMs,
        gapTimeoutMs: this.config.gapTimeoutMs,
        conceal: this.config.conceal,
      });
    this.buffers = [make(), make()];
  }

  push(packet: MpxPacket): void {
    this.buffers[packet.link === 1 ? 1 : 0]?.push(packet);
  }

  /** Hold a link regardless of health, or null to resume automatic selection. */
  force(link: number | null): void {
    this.forced = link;
    if (link !== null && link !== this.active) {
      this.spliceTo(link, "manual");
    }
  }

  get activeLink(): number {
    return this.active;
  }

  get forcedLink(): number | null {
    return this.forced;
  }

  health(): [LinkHealth, LinkHealth] {
    return [
      this.buffers[0].health(this.config.silenceMs),
      this.buffers[1].health(this.config.silenceMs),
    ];
  }

  /** Splice log, newest first. */
  history(): SpliceEvent[] {
    return this.events;
  }

  /** One receiver step: evaluate the links, release the next packet. */
  pull(): MpxPacket | null {
    const now = this.now();
    const [a, b] = this.health();

    if (this.forced === null) {
      const active = this.active === 0 ? a : b;
      const other = this.active === 0 ? b : a;
      const activeBad =
        !active.alive ||
        active.lossPct > this.config.maxLossPct ||
        active.jitterMs > this.config.maxJitterMs;
      const otherHealthy =
        other.alive &&
        other.lossPct <= this.config.maxLossPct &&
        other.jitterMs <= this.config.maxJitterMs;
      const clearlyBetter =
        other.alive &&
        (active.jitterMs - other.jitterMs > this.config.marginMs ||
          active.lossPct - other.lossPct > this.config.maxLossPct);
      if (activeBad && (otherHealthy || clearlyBetter)) {
        if (this.degradedSince[this.active] === 0) {
          this.degradedSince[this.active] = now;
        } else if (now - this.degradedSince[this.active] >= this.config.holdMs) {
          this.spliceTo(this.active === 0 ? 1 : 0, reason(active, other, this.config));
        }
      } else {
        this.degradedSince[this.active] = 0;
      }
    }

    const buffer = this.buffers[this.active];
    const packet = buffer?.pull() ?? null;
    if (packet) return packet;
    // Nothing to play. A buffer that has merely drained a slot is not a
    // reason to switch links — that is what concealment and the health
    // thresholds are for. Only a link that has actually gone quiet is
    // abandoned at once, which is what keeps the exciter fed through a hard
    // failure without waiting out the hold time.
    const activeHealth = this.active === 0 ? a : b;
    if (!activeHealth.alive && this.forced === null) {
      const other = this.buffers[this.active === 0 ? 1 : 0];
      const fallback = other?.pull() ?? null;
      if (fallback) {
        this.spliceTo(
          this.active === 0 ? 1 : 0,
          activeHealth.received > 0
            ? `link silent for ${activeHealth.silentMs.toFixed(0)} ms`
            : "link never delivered a frame",
        );
        return fallback;
      }
    }
    return null;
  }

  private spliceTo(link: number, reason: string): void {
    if (link === this.active) return;
    const from = this.active;
    this.active = link;
    this.degradedSince = [0, 0];
    // don't replay the new link's backlog: keep only the playout window
    const dropped = this.buffers[link]?.trimToTarget() ?? 0;
    const event: SpliceEvent = {
      at: this.now(),
      from,
      to: link,
      reason: dropped > 0 ? `${reason} · skipped ${dropped} buffered frames` : reason,
    };
    this.events = [event, ...this.events].slice(0, 20);
    splices.unshift(event);
    if (splices.length > 20) splices.length = 20;
    for (const cb of spliceListeners) cb();
  }
}

function reason(active: LinkHealth, other: LinkHealth, cfg: DualLinkConfig): string {
  if (!active.alive) return `link ${active.received > 0 ? "silent" : "never arrived"}`;
  if (active.lossPct > cfg.maxLossPct)
    return `loss ${active.lossPct.toFixed(1)} % over the ${cfg.maxLossPct} % limit`;
  if (active.jitterMs > cfg.maxJitterMs)
    return `jitter ${active.jitterMs.toFixed(1)} ms over the ${cfg.maxJitterMs} ms limit`;
  return other.alive ? "link better on both counts" : "link degraded";
}

/* ── link self-test: a network with loss, reordering and jitter ────────── */

export interface SimulatorConfig {
  /** Packet loss, %. */
  lossPct: number;
  /** Duplicated packets, %. */
  duplicatePct: number;
  /** Packets held back and delivered late, %. */
  reorderPct: number;
  /** Uniform delivery jitter, ms. */
  jitterMs: number;
}

export const DEFAULT_SIMULATOR: SimulatorConfig = {
  lossPct: 0,
  duplicatePct: 0,
  reorderPct: 0,
  jitterMs: 0,
};

/**
 * A deterministic-by-seed network model used by the console's self-test: it
 * carries real packets from the packetiser to a receiver with the configured
 * damage, so the receive path is exercised end to end rather than simulated
 * with made-up numbers.
 */
export class MpxLinkSimulator {
  config: SimulatorConfig;
  private seed: number;
  /** Packets in flight, by delivery time. */
  private inFlight: { at: number; packet: MpxPacket; delayed?: boolean }[] = [];
  delivered = 0;
  dropped = 0;
  duplicated = 0;
  delayed = 0;

  private readonly now: () => number;

  constructor(
    config: Partial<SimulatorConfig> = {},
    now: () => number = () => Date.now(),
    seed = 0x2f6e2b1,
  ) {
    this.now = now;
    this.config = { ...DEFAULT_SIMULATOR, ...config };
    this.seed = seed;
  }

  /** 0–1, reproducible per instance. */
  private rand(): number {
    this.seed = (this.seed * 1103515245 + 12345) & 0x7fffffff;
    return this.seed / 0x7fffffff;
  }

  /** Hand a packet to the network; delivery happens in `flush`. */
  send(packet: MpxPacket): void {
    if (this.rand() * 100 < this.config.lossPct) {
      this.dropped += 1;
      return;
    }
    const base = this.now() + this.rand() * this.config.jitterMs;
    const reorder = this.rand() * 100 < this.config.reorderPct;
    if (reorder) this.delayed += 1;
    this.inFlight.push({
      at: base + (reorder ? this.config.jitterMs * 3 + 20 : 0),
      packet,
      delayed: reorder,
    });
    if (this.rand() * 100 < this.config.duplicatePct) {
      this.duplicated += 1;
      this.inFlight.push({ at: base + 5, packet, delayed: true });
    }
  }

  /** Deliver everything whose time has come to `sink`, in arrival order. */
  flush(sink: (packet: MpxPacket) => void): void {
    const now = this.now();
    const due = this.inFlight.filter((f) => f.at <= now);
    this.inFlight = this.inFlight.filter((f) => f.at > now);
    due.sort((a, b) => a.at - b.at);
    for (const f of due) {
      sink(f.packet);
      this.delivered += 1;
    }
  }

  /** Packets still in flight. */
  get pending(): number {
    return this.inFlight.length;
  }
}
