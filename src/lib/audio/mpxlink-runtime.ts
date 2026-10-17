/**
 * Composite-over-IP runtime — the live sender, the receiver and the self-test.
 *
 * The FM branch taps its own composite at the composite rate; this module
 * frames those batches into numbered packets (`MpxPacketiser`), hands them to
 * whatever transport is attached, and — when receive mode is on — feeds the
 * same packets into the dual-link receiver. Nothing here invents link numbers:
 * the counters, the health, the splice log and the self-test all come from the
 * link layer in `mpxlink.ts` doing the real work.
 *
 * A transport is a one-line plug-in:
 *
 *   setMpxTransport((wire) => socket.send(wire));   // wire = encodePacket()
 *
 * With no transport attached the sender still frames and meters the stream, so
 * the console shows exactly what would go out.
 */
import { acquireStream, releaseStream, subscribeComposite } from "./fm";
import type { FmParams } from "./params";
import {
  DEFAULT_SIMULATOR,
  MPX_LINK_FRAME_SAMPLES,
  MpxDualLink,
  MpxLinkSimulator,
  MpxPacketiser,
  clearSplices,
  encodePacket,
  getSplices,
  type LinkHealth,
  type MpxCodec,
  type MpxPacket,
  type SimulatorConfig,
  type SpliceEvent,
} from "./mpxlink";

export interface SelfTestReport {
  at: number;
  frames: number;
  faulted: { dropped: number; duplicated: number; reordered: number; lossPct: number };
  received: { lost: number; concealed: number; reordered: number; duplicates: number };
  splices: number;
  active: number;
  verdict: string;
}

export interface LinkSnapshot {
  /** The FM branch is feeding the framer. */
  armed: boolean;
  codec: MpxCodec;
  packets: number;
  bytes: number;
  kbps: number;
  fps: number;
  /** A transport is attached (otherwise packets are framed but not sent). */
  transporting: boolean;
  /** Receive mode: arriving packets are put through the receiver. */
  receive: boolean;
  active: number;
  forced: number | null;
  links: [LinkHealth, LinkHealth];
  splices: SpliceEvent[];
  /** The last link self-test, if one has been run. */
  selfTest: SelfTestReport | null;
}

const COMPOSITE_RATE = 192000;
/** Composite batches the framer expects per packet. */
export const LINK_RATE = COMPOSITE_RATE / MPX_LINK_FRAME_SAMPLES;

const health0: LinkHealth = {
  alive: false,
  lossPct: 0,
  jitterMs: 0,
  depthMs: 0,
  kbps: 0,
  received: 0,
  lost: 0,
  duplicates: 0,
  reordered: 0,
  concealed: 0,
  silentMs: Infinity,
};

let snapshot: LinkSnapshot = {
  armed: false,
  codec: "flac",
  packets: 0,
  bytes: 0,
  kbps: 0,
  fps: 0,
  transporting: false,
  receive: false,
  active: 0,
  forced: null,
  links: [{ ...health0 }, { ...health0 }],
  splices: [],
  selfTest: null,
};

const listeners = new Set<() => void>();
let detach: (() => void) | null = null;
let sender: MpxPacketiser | null = null;
let receiver: MpxDualLink | null = null;
let transport: ((wire: Uint8Array, packet: MpxPacket) => void) | null = null;
/** Composite bytes carried but not yet formed into a full frame. */
let carry: Uint8Array | null = null;
let carryLength = 0;

let lastEmit = 0;

function emit(): void {
  lastEmit = performance.now();
  for (const cb of listeners) cb();
}

/**
 * Counter updates land once per packet — a couple of hundred times a second —
 * so the display refresh is capped while the counters themselves stay exact.
 */
function emitThrottled(): void {
  if (performance.now() - lastEmit < 200) return;
  emit();
}

export function getLink(): LinkSnapshot {
  return snapshot;
}

export function subscribeLink(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Attach a transport. It receives the framed bytes and the packet. */
export function setMpxTransport(
  send: ((wire: Uint8Array, packet: MpxPacket) => void) | null,
): void {
  transport = send;
  snapshot = { ...snapshot, transporting: send !== null };
  emit();
}

/**
 * Arm the framer on the FM composite and start counting. The FM branch has to
 * be asked to forward its composite, which is the same switch the MPX encoder
 * uses — the panel passes the current FM parameters.
 */
export function armLink(fm: FmParams | null, codec: MpxCodec = "flac"): void {
  if (detach) return;
  snapshot = { ...snapshot, armed: true, codec };
  if (fm) acquireStream(fm);
  sender = new MpxPacketiser(0, COMPOSITE_RATE, 1);
  receiver = new MpxDualLink(undefined, {
    sampleRate: COMPOSITE_RATE,
    targetMs: 120,
    silenceMs: 400,
    holdMs: 500,
  });
  clearSplices();
  detach = subscribeComposite(pushComposite);
  emit();
}

export function disarmLink(fm?: FmParams | null): void {
  detach?.();
  detach = null;
  sender = null;
  carry = null;
  carryLength = 0;
  if (fm) releaseStream(fm);
  snapshot = {
    ...snapshot,
    armed: false,
    packets: 0,
    bytes: 0,
    kbps: 0,
    fps: 0,
    links: [{ ...health0 }, { ...health0 }],
  };
  emit();
}

export function setReceiveMode(on: boolean): void {
  snapshot = { ...snapshot, receive: on };
  if (on && !receiver) {
    receiver = new MpxDualLink(undefined, {
      sampleRate: COMPOSITE_RATE,
      targetMs: 120,
      silenceMs: 400,
      holdMs: 500,
    });
  }
  emit();
}

export function forceLink(link: number | null): void {
  receiver?.force(link);
  snapshot = { ...snapshot, forced: link, active: receiver?.activeLink ?? 0 };
  emit();
}

/**
 * Composite batch in, packets out. The batch is spliced onto any carry from
 * the previous batch so every packet holds exactly one frame of composite —
 * a packet boundary lands on a real composite frame boundary.
 */
function pushComposite(mono: Float32Array): void {
  const framer = sender;
  if (!framer) return;
  const bytesPerFrame = MPX_LINK_FRAME_SAMPLES * 2;
  if (!carry || carry.length !== bytesPerFrame) {
    carry = new Uint8Array(bytesPerFrame);
    carryLength = 0;
  }
  let read = 0;
  while (read < mono.length) {
    const room = MPX_LINK_FRAME_SAMPLES - carryLength / 2;
    const take = Math.min(room, mono.length - read);
    for (let i = 0; i < take; i++) {
      const sample = Math.max(-1, Math.min(1, mono[read + i]));
      const value = Math.round(sample * 32767);
      carry[carryLength + i * 2] = value & 0xff;
      carry[carryLength + i * 2 + 1] = (value >> 8) & 0xff;
    }
    carryLength += take * 2;
    read += take;
    if (carryLength === bytesPerFrame) {
      const packet = framer.push(snapshot.codec, carry.slice());
      if (receiver && snapshot.receive) receiver.push(packet);
      transport?.(encodePacket(packet), packet);
      carryLength = 0;
    }
  }
  const stats = framer.stats();
  snapshot = {
    ...snapshot,
    packets: stats.packets,
    bytes: stats.bytes,
    kbps: stats.kbps,
    fps: stats.fps,
  };
  emitThrottled();
}

/** One receiver step — called from the console's status tick. */
export function tickLink(): void {
  if (!receiver || !snapshot.receive) return;
  for (let i = 0; i < 64; i++) {
    if (!receiver.pull()) break;
  }
  snapshot = {
    ...snapshot,
    active: receiver.activeLink,
    forced: receiver.forcedLink,
    links: receiver.health(),
    splices: getSplices().slice(0, 8),
  };
  emit();
}

/**
 * Run the full path — framer, network model, jitter buffers, splice — with a
 * deterministic clock, so the console can show what the receiver does on a
 * damaged link without waiting for a real one to break. Two independent
 * paths are carried: the primary is damaged, the standby is clean.
 */
export function runLinkSelfTest(
  config: Partial<SimulatorConfig> = { lossPct: 8, duplicatePct: 2, reorderPct: 5, jitterMs: 25 },
  seconds = 6,
): SelfTestReport {
  const clean: SimulatorConfig = { ...DEFAULT_SIMULATOR };
  const damaged: SimulatorConfig = { ...DEFAULT_SIMULATOR, ...config };
  let clock = 0;
  const now = () => clock;
  const frameMs = (MPX_LINK_FRAME_SAMPLES / COMPOSITE_RATE) * 1000;

  const sendA = new MpxPacketiser(0, COMPOSITE_RATE, 1, now);
  const sendB = new MpxPacketiser(1, COMPOSITE_RATE, 1, now);
  const netA = new MpxLinkSimulator(damaged, now, 0x51a7);
  const netB = new MpxLinkSimulator(clean, now, 0x77b3);
  const rx = new MpxDualLink(now, {
    sampleRate: COMPOSITE_RATE,
    targetMs: 120,
    gapTimeoutMs: 200,
    silenceMs: 400,
    holdMs: 1500,
    maxLossPct: 1.5,
    maxJitterMs: 25,
  });

  const frame = (seq: number): Uint8Array => {
    const bytes = new Uint8Array(MPX_LINK_FRAME_SAMPLES * 2);
    for (let i = 0; i < MPX_LINK_FRAME_SAMPLES; i++) {
      const value = Math.round(Math.sin(((seq + i) * 2 * Math.PI * 997) / COMPOSITE_RATE) * 20000);
      bytes[i * 2] = value & 0xff;
      bytes[i * 2 + 1] = (value >> 8) & 0xff;
    }
    return bytes;
  };

  const frames = Math.round((seconds * 1000) / frameMs);
  for (let i = 0; i < frames; i++) {
    const payload = frame(i);
    netA.send(sendA.push("raw", payload));
    netB.send(sendB.push("raw", payload));
    clock += frameMs;
    netA.flush((p) => rx.push(p));
    netB.flush((p) => rx.push(p));
    // two receiver steps per frame: pull hard enough to keep the buffers flat
    rx.pull();
    rx.pull();
  }
  clock += 400;
  for (let i = 0; i < 200; i++) rx.pull();
  const splices = rx.history().length;

  const [a, b] = rx.health();
  const receiverStats = rx.buffers.reduce(
    (acc, buffer) => {
      const h = buffer.health(1000);
      acc.lost += h.lost;
      acc.concealed += h.concealed;
      acc.reordered += h.reordered;
      acc.duplicates += h.duplicates;
      return acc;
    },
    { lost: 0, concealed: 0, reordered: 0, duplicates: 0 },
  );
  const lossPct =
    netA.dropped > 0 ? (netA.dropped / (netA.dropped + netA.delivered)) * 100 : 0;
  const report: SelfTestReport = {
    at: Date.now(),
    frames,
    faulted: {
      dropped: netA.dropped,
      duplicated: netA.duplicated,
      reordered: netA.delayed,
      lossPct,
    },
    received: receiverStats,
    splices,
    active: rx.activeLink,
    verdict:
      splices > 0 && rx.activeLink === 1
        ? `Spliced to the standby after ${splices} switch${splices === 1 ? "" : "es"} and kept producing composite; ${receiverStats.concealed} frame${receiverStats.concealed === 1 ? "" : "s"} concealed in the meantime.`
        : a.lossPct > 0 || b.lossPct > 0
          ? "Stayed on the primary link: the damage never cleared the splice thresholds, and every gap was concealed rather than muted."
          : "Both links were clean — nothing to conceal or splice.",
  };
  // A self-test must not overwrite what the live receiver is reporting: when
  // receive mode is on, its health is the truth about the real links, and the
  // simulated numbers stay in the report.
  snapshot = snapshot.receive
    ? { ...snapshot, selfTest: report }
    : { ...snapshot, selfTest: report, links: rx.health(), active: rx.activeLink };
  emit();
  return report;
}
