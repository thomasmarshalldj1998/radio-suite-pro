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
import { CompositeDecoder, type DecodeSnapshot } from "./mpxdecode";
import type { FmParams } from "./params";
import { closeUdp, getUdp, openUdp, sendPacket, setUdpInbound, udpPaths } from "./udp";
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
  /** Which transport: the desktop UDP bridge, a plug-in, or none. */
  transport: "none" | "udp" | "custom";
  /** Receive mode: arriving packets are put through the receiver. */
  receive: boolean;
  active: number;
  forced: number | null;
  links: [LinkHealth, LinkHealth];
  splices: SpliceEvent[];
  /**
   * What the receiver actually recovered from the spliced composite: station
   * identity and text off the 57 kHz subcarrier, left and right off the 38 kHz
   * one. Null until receive mode has produced audio.
   */
  content: DecodeSnapshot | null;
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
  targetMs: 0,
  dropped: 0,
};

/**
 * How the live receiver is configured: the playout delay follows the measured
 * jitter between a 40 ms floor and a 200 ms ceiling, and no link may ever hold
 * more than 240 ms of composite. That is the bufferbloat contract — latency
 * cannot grow past the ceiling and drains back to the floor when the network
 * settles, even if nothing is pulling for a while.
 */
const LIVE_RECEIVER = {
  sampleRate: COMPOSITE_RATE,
  targetMs: 120,
  adaptive: true,
  minTargetMs: 40,
  maxTargetMs: 200,
  maxDepthMs: 240,
  stallMs: 250,
  silenceMs: 400,
  holdMs: 500,
} as const;

let snapshot: LinkSnapshot = {
  armed: false,
  codec: "raw",
  packets: 0,
  bytes: 0,
  kbps: 0,
  fps: 0,
  transporting: false,
  transport: "none",
  receive: false,
  active: 0,
  forced: null,
  links: [{ ...health0 }, { ...health0 }],
  splices: [],
  content: null,
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
/** Decoder for the receiver's spliced output — the far end of the link. */
let decoder: CompositeDecoder | null = null;

let lastEmit = 0;
/** Own drain timer: the receiver must not depend on a panel being mounted. */
let drainTimer: ReturnType<typeof setInterval> | null = null;

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
  snapshot = {
    ...snapshot,
    transporting: send !== null,
    transport: send === null ? "none" : "custom",
  };
  emit();
}

/**
 * Put the framed stream on real UDP sockets (desktop build). Each path gets
 * its own socket and its own header, and whatever arrives on either socket is
 * decoded straight into the link receiver — so the two links the panel shows
 * are the two links on the wire.
 */
export async function connectUdp(fm: FmParams | null): Promise<void> {
  if (!snapshot.armed) armLink(fm, "raw");
  setUdpInbound((packet) => {
    if (snapshot.receive) receiver?.push(packet);
  });
  await openUdp();
  const up = getUdp().open;
  transport = up ? null : transport;
  snapshot = {
    ...snapshot,
    transporting: up,
    transport: up ? "udp" : "none",
  };
  emit();
}

export async function disconnectUdp(): Promise<void> {
  await closeUdp();
  setUdpInbound(null);
  snapshot = { ...snapshot, transporting: false, transport: "none" };
  emit();
}

/**
 * Arm the framer on the FM composite and start counting. The FM branch has to
 * be asked to forward its composite, which is the same switch the MPX encoder
 * uses — the panel passes the current FM parameters.
 */
export function armLink(fm: FmParams | null, codec: MpxCodec = "raw"): void {
  if (detach) return;
  snapshot = { ...snapshot, armed: true, codec };
  if (fm) acquireStream(fm);
  sender = new MpxPacketiser(0, COMPOSITE_RATE, 1);
  decoder = new CompositeDecoder({ sampleRate: COMPOSITE_RATE });
  receiver = new MpxDualLink(undefined, LIVE_RECEIVER);
  clearSplices();
  detach = subscribeComposite(pushComposite);
  if (snapshot.receive) startDrain();
  emit();
}

export function disarmLink(fm?: FmParams | null): void {
  detach?.();
  detach = null;
  sender = null;
  stopDrain();
  // Drop the receiver too: with the link disarmed nothing drains it, and
  // inbound datagrams would pile up in its buffers.
  receiver = null;
  decoder = null;
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
    content: null,
  };
  emit();
}

export function setReceiveMode(on: boolean): void {
  snapshot = { ...snapshot, receive: on, content: on ? snapshot.content : null };
  if (on) decoder = new CompositeDecoder({ sampleRate: COMPOSITE_RATE });
  if (on && !receiver) {
    receiver = new MpxDualLink(undefined, LIVE_RECEIVER);
  }
  if (on) startDrain();
  else stopDrain();
  emit();
}

/**
 * Pull the receiver on its own clock. The panel's interval used to be the only
 * thing draining the link, so closing it let inbound packets pile up; this
 * keeps the buffers flat whether or not anything is watching, and only pays
 * the decoder's CPU while a panel is actually subscribed.
 */
function startDrain(): void {
  if (drainTimer !== null) return;
  drainTimer = setInterval(drainLink, 100);
}

function stopDrain(): void {
  if (drainTimer === null) return;
  clearInterval(drainTimer);
  drainTimer = null;
}

function drainLink(): void {
  if (!receiver || !snapshot.receive) return;
  const decode = listeners.size > 0;
  for (let i = 0; i < 256; i++) {
    const packet = receiver.pull();
    if (!packet) break;
    if (decode) decoder?.process(toComposite(packet.payload));
  }
  snapshot = {
    ...snapshot,
    active: receiver.activeLink,
    forced: receiver.forcedLink,
    links: receiver.health(),
    splices: getSplices().slice(0, 8),
    content: decoder?.snapshot() ?? null,
  };
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
      // Loopback monitoring only when nothing external is feeding the
      // receiver — otherwise the console would count its own packets twice.
      if (receiver && snapshot.receive && udpPaths() === 0) receiver.push(packet);
      if (snapshot.transport === "udp") sendPacket(packet);
      else transport?.(encodePacket(packet), packet);
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

/** Scratch for 16-bit payload → float, reused because this runs at 187 Hz. */
let decodeBuf: Float32Array | null = null;

function toComposite(payload: Uint8Array): Float32Array {
  const n = payload.length >> 1;
  if (!decodeBuf || decodeBuf.length < n) decodeBuf = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = payload[i * 2] | (payload[i * 2 + 1] << 8);
    decodeBuf[i] = ((v << 16) >> 16) / 32768;
  }
  return decodeBuf.subarray(0, n);
}

/**
 * One receiver step — called from the console's status tick. Every frame the
 * splice releases is decoded, so the panel reports content that came off the
 * wire (or, in loopback, out of the local framer) rather than what was sent.
 */
export function tickLink(): void {
  startDrain();
  drainLink();
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
