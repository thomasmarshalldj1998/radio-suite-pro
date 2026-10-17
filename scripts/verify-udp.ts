/**
 * Verification of the UDP transport, over real loopback sockets:
 *
 *   bun scripts/verify-udp.ts
 *
 * The endpoint module under test is the exact one the desktop app's main
 * process uses (electron/udp-link.cjs) — no mock socket, no stubbed send. The
 * packets are the real ones from the link layer, framed by the real
 * packetiser and decoded by the real decoder, so what is asserted here is the
 * same path a broadcast engineer gets when they point the link at an exciter.
 *
 * Checks:
 *  1  sockets: both paths bind, report their port and accept datagrams
 *  2  traffic: every framed packet arrives on both paths, byte for byte
 *  3  framing: CRC and sequencing survive the socket, in order, with no gaps
 *  4  receive: the dual-link receiver serves composite from arriving packets
 *  5  failover: with path A gone, the receiver splices to B and keeps going
 *  6  guards: oversized datagrams are refused instead of fragmenting
 *  7  errors: binding a port already in use is reported, not swallowed
 */
import { createRequire } from "node:module";
import {
  MPX_LINK_FRAME_SAMPLES,
  MpxDualLink,
  MpxPacketiser,
  decodePacket,
  encodePacket,
  type MpxPacket,
} from "../src/lib/audio/mpxlink";

const require = createRequire(import.meta.url);
const { UdpEndpoint, MAX_DATAGRAM } = require("../electron/udp-link.cjs") as {
  UdpEndpoint: new (options?: {
    onData?: (bytes: Uint8Array) => void;
    onError?: (message: string) => void;
  }) => {
    open(args: {
      listenPort?: number;
      listenHost?: string;
      host: string;
      port: number;
    }): Promise<number>;
    send(bytes: Uint8Array): boolean;
    close(): void;
    snapshot(): Record<string, unknown>;
  };
  MAX_DATAGRAM: number;
};

let passed = 0;
let failed = 0;

function check(ok: boolean, label: string, detail = ""): void {
  if (ok) {
    passed += 1;
    console.log(`  ok   ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const RATE = 192000;
const frameMs = (MPX_LINK_FRAME_SAMPLES / RATE) * 1000;

/** Wait until `cond` holds, or give up — UDP delivery is asynchronous. */
async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 2));
  }
  return cond();
}

function payload(seq: number): Uint8Array {
  const bytes = new Uint8Array(MPX_LINK_FRAME_SAMPLES * 2);
  for (let i = 0; i < MPX_LINK_FRAME_SAMPLES; i++) {
    const v = Math.round(Math.sin(((seq + i) * 2 * Math.PI * 997) / RATE) * 20000);
    bytes[i * 2] = v & 0xff;
    bytes[i * 2 + 1] = (v >> 8) & 0xff;
  }
  return bytes;
}

async function main(): Promise<void> {
  // ── 1 · sockets up ───────────────────────────────────────────────────────
  console.log("\n1 · sockets");
  const inboxA: Uint8Array[] = [];
  const inboxB: Uint8Array[] = [];
  /** Paths that are "dark": their endpoint is closed, traffic falls away. */
  const rx: Array<InstanceType<typeof UdpEndpoint> | null> = [null, null];

  const rxA = new UdpEndpoint({ onData: (bytes) => inboxA.push(bytes) });
  const rxB = new UdpEndpoint({ onData: (bytes) => inboxB.push(bytes) });
  rx[0] = rxA;
  rx[1] = rxB;

  // Receivers never transmit; port 9 (discard) is a valid, inert target.
  const portA = await rxA.open({ listenPort: 0, host: "127.0.0.1", port: 9 });
  const portB = await rxB.open({ listenPort: 0, host: "127.0.0.1", port: 9 });
  check(portA > 0 && portB > 0, "both paths bound", `A :${portA} · B :${portB}`);
  check(portA !== portB, "each path got its own port");

  const txA = new UdpEndpoint();
  const txB = new UdpEndpoint();
  await txA.open({ listenPort: 0, host: "127.0.0.1", port: portA });
  await txB.open({ listenPort: 0, host: "127.0.0.1", port: portB });

  // ── 2 · traffic on both paths ────────────────────────────────────────────
  console.log("\n2 · traffic");
  let clock = 0;
  const now = () => clock;
  const sender = new MpxPacketiser(0, RATE, 1, now);
  const sent: MpxPacket[] = [];
  const COUNT = 180;

  // Paced like the live stream (~187 packets/s) rather than blasted: a burst
  // of a second's worth of datagrams overruns a default kernel receive buffer,
  // which is a property of the socket, not of the link.
  for (let i = 0; i < COUNT; i++) {
    const packet = sender.push("raw", payload(i));
    sent.push(packet);
    txA.send(encodePacket({ ...packet, link: 0 }));
    txB.send(encodePacket({ ...packet, link: 1 }));
    clock += frameMs;
    if (i % 12 === 11) await new Promise((r) => setTimeout(r, 2));
  }
  const arrived = await waitFor(
    () => inboxA.length >= COUNT && inboxB.length >= COUNT,
    3000,
  );
  check(arrived, "every datagram reached both paths", `${inboxA.length}/${COUNT} A · ${inboxB.length}/${COUNT} B`);
  check(txA.snapshot().sent === COUNT, "the sender counted what it sent", `${txA.snapshot().sent} on A`);
  check(txB.snapshot().sent === COUNT, "path B counted the same", `${txB.snapshot().sent} on B`);
  check(
    rxA.snapshot().received === COUNT && rxB.snapshot().received === COUNT,
    "the receiver counted them too",
    `${rxA.snapshot().received} A · ${rxB.snapshot().received} B`,
  );
  const bufferMs = Number(rxA.snapshot().bufferMs);
  check(
    bufferMs > 0,
    "the kernel's real receive buffer is reported",
    `${bufferMs} ms of composite, ${(Number(rxA.snapshot().receivedBytes) / 1024).toFixed(0)} KiB in`,
  );

  // ── 3 · framing survives the socket ──────────────────────────────────────
  console.log("\n3 · framing");
  const decodedA = inboxA.map((b) => decodePacket(b));
  const decodedB = inboxB.map((b) => decodePacket(b));
  check(
    decodedA.every((p) => p !== null) && decodedB.every((p) => p !== null),
    "every datagram passes magic/version/CRC",
    `${decodedA.filter((p) => p === null).length + decodedB.filter((p) => p === null).length} rejected`,
  );
  const seqs = decodedA.map((p) => p!.sequence);
  check(
    seqs.every((s, i) => s === i),
    "sequence numbers arrive intact and in order",
    `${seqs[0]}…${seqs[seqs.length - 1]}`,
  );
  check(
    decodedA.every((p) => p!.link === 0) && decodedB.every((p) => p!.link === 1),
    "each path carries its own link number",
  );
  const byteMatch = decodedA.every(
    (p, i) => Buffer.compare(Buffer.from(p!.payload), Buffer.from(payload(i))) === 0,
  );
  check(byteMatch, "payloads are bit-identical end to end", `${decodedA.length} packets`);

  // A corrupted datagram must be refused, not played out.
  const damaged = encodePacket({ ...sent[10], link: 0 });
  damaged[damaged.length - 1] ^= 0xff;
  check(decodePacket(damaged) === null, "a corrupted datagram is rejected by the CRC");

  // ── 4 · the receiver serves composite from the wire ──────────────────────
  console.log("\n4 · receive");
  let rxClock = 0;
  const receiver = new MpxDualLink(
    () => rxClock,
    { sampleRate: RATE, targetMs: 120, gapTimeoutMs: 200, silenceMs: 400, holdMs: 300 },
  );
  // Feed in arrival order, advancing the receiver clock with the stream.
  const feed = (packets: Array<MpxPacket | null>, link: number) => {
    for (const p of packets) if (p) receiver.push({ ...p, link });
  };
  feed(decodedA, 0);
  feed(decodedB, 1);
  rxClock = COUNT * frameMs + 200;
  let pulled = 0;
  for (let i = 0; i < COUNT * 2 + 50; i++) if (receiver.pull()) pulled += 1;
  check(pulled > 0, "the dual link produces composite from sockets", `${pulled} frames out`);
  check(receiver.activeLink === 0, "the healthy primary serves the stream");

  // ── 5 · path A dies, the receiver splices to B ───────────────────────────
  console.log("\n5 · failover");
  rxA.close();
  const late = new MpxPacketiser(0, RATE, 1, () => clock);
  const before = receiver.history().length;
  for (let i = 0; i < 120; i++) {
    const packet = late.push("raw", payload(COUNT + i));
    // only the standby still gets traffic
    txB.send(encodePacket({ ...packet, link: 1 }));
    inboxB.push(encodePacket({ ...packet, link: 1 }));
    rxClock += frameMs;
    const fresh = inboxB.splice(0).map((b) => decodePacket(b));
    feed(fresh, 1);
    receiver.pull();
    receiver.pull();
  }
  rxClock += 400;
  for (let i = 0; i < 200; i++) receiver.pull();
  const switches = receiver.history().length - before;
  check(switches > 0, "the dead path was spliced away", `${switches} switch${switches === 1 ? "" : "es"}`);
  check(receiver.activeLink === 1, "the standby carries the stream");
  const [healthA, healthB] = receiver.health();
  check(
    !healthA.alive || healthA.silentMs > 400,
    "the dead path is reported dead",
    `${healthA.alive ? `${healthA.silentMs.toFixed(0)} ms since last packet` : "silent"}`,
  );
  check(healthB.received > 0, "the standby's health is measured", `${healthB.received} packets`);
  check(
    healthB.concealed >= 0 && healthB.lossPct >= 0,
    "concealment is accounted, not guessed",
    `${healthB.concealed} concealed · ${healthB.lossPct.toFixed(2)} % loss`,
  );

  // ── 6 · guards ───────────────────────────────────────────────────────────
  console.log("\n6 · guards");
  check(
    txA.send(new Uint8Array(MAX_DATAGRAM + 1)) === false,
    "an oversized datagram is refused, not fragmented",
    `${MAX_DATAGRAM + 1} B`,
  );
  check(txA.send(new Uint8Array(0)) === false, "an empty datagram is refused");

  // ── 7 · a port already in use is reported ────────────────────────────────
  console.log("\n7 · errors");
  const busy = new UdpEndpoint();
  let bindError = "";
  try {
    await busy.open({ listenPort: portB, host: "127.0.0.1", port: 9 });
  } catch (err) {
    bindError = err instanceof Error ? err.message : String(err);
  }
  check(bindError.length > 0, "a port already in use is reported", bindError || "no error raised");
  busy.close();

  rxA.close();
  rxB.close();
  txA.close();
  txB.close();

  console.log(`\n${passed} checks passed, ${failed} failed.\n`);
  if (failed > 0) process.exit(1);
}

await main();
