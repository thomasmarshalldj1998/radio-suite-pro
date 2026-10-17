/**
 * Latency-control checks — a live link must never grow a bufferbloat tail.
 *
 *   bun scripts/verify-bufferbloat.ts
 *
 * The jitter buffer used to hold a fixed 120 ms and had no ceiling at all: a
 * consumer that stopped pulling let the backlog grow without bound, and a
 * jitter burst left the delay inflated long after the network settled. These
 * checks drive the real buffer with a fake clock and assert the properties an
 * on-air feed needs:
 *
 *  1  a clean link settles at the configured floor, not the fixed default
 *  2  the floor is still honoured (a frame is not released early)
 *  3  a jitter burst raises the playout delay before a frame is lost
 *  4  the delay drains back once the burst ends
 *  5  an undrained buffer can never exceed its ceiling
 *  6  a returning consumer skips the missed composite instead of replaying it
 *  7  the desktop socket's receive buffer is bounded to about a second
 */
import { createRequire } from "node:module";
import {
  MPX_LINK_FRAME_SAMPLES,
  MpxJitterBuffer,
  type MpxPacket,
} from "../src/lib/audio/mpxlink";

const require = createRequire(import.meta.url);
const { UdpEndpoint } = require("../electron/udp-link.cjs") as {
  UdpEndpoint: new (options?: Record<string, unknown>) => {
    open(args: { listenPort: number; host: string; port: number }): Promise<number>;
    close(): void;
    snapshot(): { bufferMs: number; open: boolean };
  };
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
const FRAME_MS = (MPX_LINK_FRAME_SAMPLES / RATE) * 1000; // 5.333 ms

let clock = 0;
const now = () => clock;

function packet(seq: number): MpxPacket {
  const payload = new Uint8Array(MPX_LINK_FRAME_SAMPLES * 2);
  for (let i = 0; i < payload.length; i++) payload[i] = (seq + i) & 0xff;
  return {
    codec: "raw",
    sequence: seq,
    timestamp: seq * MPX_LINK_FRAME_SAMPLES,
    sampleRate: RATE,
    channels: 1,
    link: 0,
    payload,
  };
}

/** A real consumer: release everything that is due, then wait. */
function drain(buffer: MpxJitterBuffer): number {
  let released = 0;
  while (buffer.pull()) released += 1;
  return released;
}

const LIVE = {
  sampleRate: RATE,
  targetMs: 120,
  adaptive: true,
  minTargetMs: 40,
  maxTargetMs: 200,
  maxDepthMs: 240,
  stallMs: 250,
};

/* ── 1-2: the target adapts down on a clean link ───────────────────────── */

console.log("\n1 · clean link");
clock = 0;
const clean = new MpxJitterBuffer(now, LIVE);
const initialTarget = clean.health(1000).targetMs;
const total = Math.round(12_000 / FRAME_MS);
for (let i = 0; i < total; i++) {
  clock = i * FRAME_MS;
  clean.push(packet(i));
  drain(clean);
}
const cleanHealth = clean.health(1000);
check(
  initialTarget === 120,
  "the controller starts from the configured delay",
  `${initialTarget} ms`,
);
check(
  cleanHealth.targetMs <= 45,
  "a clean link settles at the floor",
  `${cleanHealth.targetMs.toFixed(1)} ms after 12 s`,
);
check(
  cleanHealth.lost === 0 && cleanHealth.concealed === 0,
  "adapting down costs no frames",
  `${cleanHealth.lost} lost · ${cleanHealth.concealed} concealed`,
);
check(
  cleanHealth.depthMs < 60,
  "the held composite follows the target down",
  `${cleanHealth.depthMs.toFixed(1)} ms held`,
);

console.log("\n2 · floor");
clock = 0;
const floored = new MpxJitterBuffer(now, { ...LIVE, targetMs: 40 });
floored.push(packet(0));
clock += 30;
check(floored.pull() === null, "a frame is not released before the floor");
clock += 15;
check(floored.pull() !== null, "it is released once the floor has passed");

/* ── 3-4: a jitter burst raises the delay, then it drains ──────────────── */

console.log("\n3 · jitter burst");
clock = 0;
const bursty = new MpxJitterBuffer(now, LIVE);
const burstFrames = Math.round(4000 / FRAME_MS); // 4 s of +/-18 ms arrivals
for (let i = 0; i < burstFrames; i++) {
  clock = i * FRAME_MS + (i % 2 === 1 ? 18 : 0);
  bursty.push(packet(i));
  drain(bursty);
}
const burstHealth = bursty.health(1000);
check(
  burstHealth.jitterMs > 12,
  "the jitter estimator sees the spread",
  `${burstHealth.jitterMs.toFixed(1)} ms`,
);
check(
  burstHealth.targetMs > 50,
  "the playout delay rose to cover it",
  `${burstHealth.targetMs.toFixed(1)} ms, was 120 at most`,
);
check(
  burstHealth.targetMs <= 200,
  "the delay never passes the ceiling",
  `${burstHealth.targetMs.toFixed(1)} ms`,
);
check(
  burstHealth.lost === 0 && burstHealth.concealed === 0,
  "no frame was lost to the burst",
  `${burstHealth.lost} lost · ${burstHealth.concealed} concealed`,
);

console.log("\n4 · drain");
const base = burstFrames;
for (let i = 0; i < Math.round(8000 / FRAME_MS); i++) {
  clock = (base + i) * FRAME_MS;
  bursty.push(packet(base + i));
  drain(bursty);
}
const settled = bursty.health(1000);
check(
  settled.jitterMs < 2,
  "the estimator converges back to zero",
  `${settled.jitterMs.toFixed(2)} ms`,
);
check(
  settled.targetMs <= 45,
  "the delay drains back to the floor after the burst",
  `${settled.targetMs.toFixed(1)} ms`,
);
check(
  settled.depthMs <= 70,
  "and the held composite comes down with it",
  `${settled.depthMs.toFixed(1)} ms held`,
);

/* ── 5-6: a stalled consumer cannot grow the buffer ────────────────────── */

console.log("\n5 · consumer stall");
clock = 0;
const stalled = new MpxJitterBuffer(now, LIVE);
const stalledFrames = Math.round(20_000 / FRAME_MS); // 20 s, not one pull
for (let i = 0; i < stalledFrames; i++) {
  clock = i * FRAME_MS;
  stalled.push(packet(i));
}
const stallHealth = stalled.health(1000);
check(
  stallHealth.received === stalledFrames,
  "everything that arrived was accounted for",
  `${stallHealth.received} frames`,
);
check(
  stallHealth.depthMs <= 240 + FRAME_MS,
  "the buffer is capped at its ceiling, not 20 s",
  `${stallHealth.depthMs.toFixed(1)} ms held of 20 000 ms arrived`,
);
check(
  stallHealth.dropped > stalledFrames - 200,
  "the excess was skipped rather than queued",
  `${stallHealth.dropped} skipped`,
);

console.log("\n6 · resume");
const resumed = stalled.pull();
// age of the released frame measured against the newest arrival on the link
const releasedAge =
  resumed === null
    ? Infinity
    : (stalledFrames - 1) * FRAME_MS - (resumed.timestamp / RATE) * 1000;
check(
  resumed !== null,
  "the consumer still gets audio back after the stall",
  resumed ? `frame ${resumed.sequence}` : "nothing returned",
);
check(
  releasedAge <= 240 + 2 * FRAME_MS,
  "that frame is live, not the oldest of the backlog",
  Number.isFinite(releasedAge) ? `${releasedAge.toFixed(0)} ms behind the newest arrival` : "—",
);

/* ── 7: the socket buffer is bounded ───────────────────────────────────── */

console.log("\n7 · kernel receive buffer");
const endpoint = new UdpEndpoint();
try {
  await endpoint.open({ listenPort: 0, host: "127.0.0.1", port: 9 });
  const bufferMs = endpoint.snapshot().bufferMs;
  check(
    bufferMs > 0 && bufferMs <= 2000,
    "the granted receive buffer holds at most ~2 s of composite",
    `${bufferMs} ms granted`,
  );
} catch (err) {
  failed += 1;
  console.log(`  FAIL the test socket would not bind — ${(err as Error).message}`);
} finally {
  endpoint.close();
}

console.log(
  `\n${passed} checks passed, ${failed} failed.${failed === 0 ? "" : " Review the failures above."}`,
);
process.exit(failed === 0 ? 0 : 1);
