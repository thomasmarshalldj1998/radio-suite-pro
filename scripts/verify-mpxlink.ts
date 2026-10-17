/**
 * Independent verification of the composite-over-IP link layer — pure code,
 * fake clock, no browser APIs:
 *
 *   bun scripts/verify-mpxlink.ts
 *
 * Checks:
 *   1  framing: fields survive the round trip, damage is rejected
 *   2  sequence arithmetic across the 2^32 wrap
 *   3  packetiser: numbering, composite clock, throughput
 *   4  jitter buffer: reordering is undone, duplicates dropped
 *   5  jitter buffer: a lost frame is counted, skipped and concealed
 *   6  jitter buffer: playout waits the configured target delay
 *   7  jitter estimate: converges on the injected interarrival spread
 *   8  dual link: a silent active link is spliced away after the hold time
 *   9  dual link: the new link's backlog is trimmed, not replayed
 *  10  dual link: minor loss and jitter do not cause flapping
 *  11  dual link: a forced link is held, and releases back to automatic
 *  12  network model: loss, duplication and reordering are counted honestly
 */

import {
  DEFAULT_SIMULATOR,
  MPX_LINK_FRAME_SAMPLES,
  MpxDualLink,
  MpxJitterBuffer,
  MpxLinkSimulator,
  MpxPacketiser,
  decodePacket,
  encodePacket,
  sequenceGap,
  type MpxPacket,
} from "../src/lib/audio/mpxlink";

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

/** Controllable clock so every timing assertion is exact. */
let clock = 0;
const now = () => clock;
const advance = (ms: number) => {
  clock += ms;
};

const RATE = 192000;
const frameMs = (MPX_LINK_FRAME_SAMPLES / RATE) * 1000; // 5.333 ms

function rawPayload(value = 0): Uint8Array {
  const bytes = new Uint8Array(MPX_LINK_FRAME_SAMPLES * 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (value + i) & 0xff;
  return bytes;
}

function packet(seq: number, link = 0, value = 0): MpxPacket {
  return {
    codec: "raw",
    sequence: seq,
    timestamp: seq * MPX_LINK_FRAME_SAMPLES,
    sampleRate: RATE,
    channels: 1,
    link,
    payload: rawPayload(value),
  };
}

/* ── 1-3: framing and the sender ────────────────────────────────────────── */

console.log("\n1 · framing");
const original: MpxPacket = {
  codec: "flac",
  sequence: 0x1234abcd,
  timestamp: 0x00000007,
  sampleRate: 192000,
  channels: 1,
  link: 1,
  payload: new Uint8Array([1, 2, 3, 4, 5, 250, 251, 252]),
};
const wire = encodePacket(original);
const back = decodePacket(wire);
check(
  back !== null &&
    back.codec === original.codec &&
    back.sequence === original.sequence &&
    back.timestamp === original.timestamp &&
    back.sampleRate === original.sampleRate &&
    back.link === original.link &&
    back.payload.byteLength === original.payload.byteLength &&
    back.payload.every((b, i) => b === original.payload[i]),
  "every header field and the payload survive the round trip",
  `${wire.byteLength} bytes on the wire`,
);

const corrupt = new Uint8Array(wire);
corrupt[corrupt.length - 1] ^= 0x40;
check(decodePacket(corrupt) === null, "a flipped payload bit is rejected by the CRC");
const corruptHeader = new Uint8Array(wire);
corruptHeader[9] ^= 0x01;
check(decodePacket(corruptHeader) === null, "a damaged sequence field is rejected");
const truncated = wire.subarray(0, wire.byteLength - 3);
check(decodePacket(truncated) === null, "a short buffer is rejected");
const alien = new Uint8Array(64);
check(decodePacket(alien) === null, "a foreign packet is rejected");

console.log("\n2 · sequence arithmetic");
check(sequenceGap(5, 7) === 2, "forward distance within a window", `${sequenceGap(5, 7)}`);
check(
  sequenceGap(0xffffffff, 1) === 2,
  "distance across the 2^32 wrap",
  `${sequenceGap(0xffffffff, 1)}`,
);
check(sequenceGap(0, 0xffffffff) > 0x7fffffff, "a behind-the-window packet reads as old");

console.log("\n3 · packetiser");
const sender = new MpxPacketiser(0, RATE, 1, now);
const p0 = sender.push("raw", rawPayload(0));
const p1 = sender.push("raw", rawPayload(0));
const p2 = sender.push("raw", rawPayload(0));
check(
  p0.sequence === 0 && p1.sequence === 1 && p2.sequence === 2,
  "packets are numbered in order",
  `${p0.sequence},${p1.sequence},${p2.sequence}`,
);
check(
  p0.timestamp === 0 && p1.timestamp === MPX_LINK_FRAME_SAMPLES,
  "the composite clock advances by the frame length",
  `${p0.timestamp} → ${p1.timestamp}`,
);
check(
  sender.stats().packets === 3 && sender.stats().bytes === 3 * MPX_LINK_FRAME_SAMPLES * 2,
  "the sender accounts for packets and bytes",
  `${sender.stats().bytes} bytes`,
);

/* ── 4-7: jitter buffer ────────────────────────────────────────────────── */

console.log("\n4 · jitter buffer ordering");
clock = 0;
const jb = new MpxJitterBuffer(now, { sampleRate: RATE, targetMs: 20 });
jb.push(packet(2, 0, 2));
jb.push(packet(0, 0, 0));
jb.push(packet(1, 0, 1));
jb.push(packet(1, 0, 1)); // duplicate
check(jb.health(1000).reordered === 2, "out-of-order arrivals are counted", "2 of 4");
check(jb.health(1000).duplicates === 1, "a duplicate is dropped", "1");
advance(25);
const released: number[] = [];
for (let i = 0; i < 4; i++) {
  const got = jb.pull();
  if (got) released.push(got.sequence);
}
check(
  released.join(",") === "0,1,2",
  "packets are released in sequence order",
  released.join(","),
);

console.log("\n5 · loss and concealment");
clock = 0;
const lossy = new MpxJitterBuffer(now, {
  sampleRate: RATE,
  targetMs: 20,
  gapTimeoutMs: 50,
});
lossy.push(packet(0));
advance(30);
const firstOut = lossy.pull();
check(
  firstOut !== null && firstOut.sequence === 0 && firstOut.concealed !== true,
  "the first frame comes out intact",
);
advance(10);
lossy.push(packet(2, 0, 9)); // frame 1 never arrived
advance(60); // past the gap timeout, buffered frame is playable
const concealed = lossy.pull();
const health = lossy.health(1000);
check(health.lost === 1, "the missing frame is counted as lost", `${health.lost}`);
check(
  concealed !== null && concealed.concealed === true,
  "the gap is concealed rather than muting the exciter",
  concealed ? `repeat of frame ${concealed.sequence}` : "nothing returned",
);
check(
  concealed !== null && concealed.payload[0] === firstOut?.payload[0],
  "concealment repeats the previous composite frame",
);
advance(30);
const afterGap = lossy.pull();
check(
  afterGap !== null && afterGap.sequence === 2 && afterGap.concealed !== true,
  "the stream picks up again at the next real frame",
  afterGap ? `frame ${afterGap.sequence}` : "nothing returned",
);

console.log("\n6 · playout delay");
clock = 0;
const delayed = new MpxJitterBuffer(now, { sampleRate: RATE, targetMs: 100 });
delayed.push(packet(0));
advance(60);
check(delayed.pull() === null, "nothing is released before the target delay");
check(delayed.health(1000).depthMs === 0, "a single frame is not yet a depth");
advance(45);
const onTime = delayed.pull();
check(onTime !== null, "the frame is released once the target has passed", `t=${clock} ms`);

console.log("\n7 · jitter estimate");
clock = 0;
const jittery = new MpxJitterBuffer(now, { sampleRate: RATE, targetMs: 5 });
for (let i = 0; i < 80; i++) {
  // arrival holds the frame period but alternates a 10 ms spread
  advance(i === 0 ? 0 : frameMs + (i % 2 === 1 ? 10 : -10));
  jittery.push(packet(i));
}
const jitter = jittery.health(1000).jitterMs;
check(
  jitter > 9 && jitter < 11,
  "the RFC 3550 estimator converges on the injected spread",
  `${jitter.toFixed(2)} ms against 10 ms`,
);

/* ── 8-11: dual link ───────────────────────────────────────────────────── */

console.log("\n8 · dual-link splice");
clock = 0;
const dual = new MpxDualLink(now, {
  sampleRate: RATE,
  targetMs: 40,
  gapTimeoutMs: 60,
  silenceMs: 100,
  holdMs: 200,
  maxLossPct: 1.5,
  maxJitterMs: 25,
});
for (let i = 0; i < 6; i++) {
  dual.push(packet(i, 0));
  dual.push(packet(i, 1));
  advance(frameMs);
}
advance(60); // past the playout target so the first frames are releasable
const lead: number[] = [];
for (let i = 0; i < 3; i++) {
  const got = dual.pull();
  if (got) lead.push(got.link);
}
check(
  lead.length === 3 && lead.every((l) => l === 0),
  "the first link carries the feed while both are healthy",
  `packets from link ${[...new Set(lead)].join(",")}`,
);
check(dual.history().length === 0, "no splice while the active link is healthy");

// link A stops; link B keeps arriving
for (let i = 6; i < 40; i++) {
  dual.push(packet(i, 1));
  advance(frameMs);
  for (let p = 0; p < 1; p++) dual.pull();
}
const events = dual.history();
check(dual.activeLink === 1, "the silent link is spliced away", `active ${dual.activeLink}`);
check(events.length > 0, "the splice is logged");
check(
  events.length > 0 && /silent|no frames|arrived/.test(events[0].reason),
  "the log names the reason",
  events[0]?.reason ?? "none",
);
advance(60); // let the trimmed window age into its playout delay
const afterSplice = dual.pull();
check(
  afterSplice !== null && afterSplice.link === 1,
  "the receiver keeps producing packets after the splice",
  afterSplice ? `frame ${afterSplice.sequence} from link ${afterSplice.link}` : "nothing returned",
);
const [ha, hb] = dual.health();
check(hb.received > 30, "the standby link was being measured all along", `${hb.received} frames`);
check(ha.received > 0 && !ha.alive, "the failed link is marked dead", `heard ${ha.received} frames`);

console.log("\n9 · splice does not replay the backlog");
clock = 0;
const sprint = new MpxDualLink(now, {
  sampleRate: RATE,
  targetMs: 40,
  silenceMs: 100,
  holdMs: 100,
});
// link B has been running with a long backlog while A carried the feed
for (let i = 0; i < 50; i++) {
  sprint.push(packet(i, 0));
  sprint.push(packet(i, 1));
  advance(frameMs);
}
const droppedBefore = sprint.buffers[1].health(1000).depthMs;
clock += 30; // let the playout delay expire so packets are releasable
sprint.force(1);
const droppedAfter = sprint.buffers[1].health(1000).depthMs;
check(
  sprint.activeLink === 1 && droppedBefore > droppedAfter,
  "the new link's buffer is trimmed to the playout window",
  `${droppedBefore.toFixed(0)} ms → ${droppedAfter.toFixed(0)} ms`,
);
check(
  sprint.history()[0]?.reason.includes("manual"),
  "a forced splice is logged as manual",
  sprint.history()[0]?.reason ?? "none",
);

console.log("\n10 · no flapping on minor damage");
clock = 0;
const steady = new MpxDualLink(now, {
  sampleRate: RATE,
  targetMs: 30,
  silenceMs: 150,
  holdMs: 300,
  maxLossPct: 1.5,
  maxJitterMs: 25,
});
// one frame in a hundred (under 1 %) sits below the loss limit, and the
// standby link is measured the whole time — the receiver must stay put.
// The frame is dropped mid-stream: a frame missing from the very start is
// unknowable to a buffer, which is why the counter anchors on what it holds.
for (let i = 0; i < 120; i++) {
  if (i !== 60) steady.push(packet(i, 0));
  steady.push(packet(i, 1, 3));
  advance(frameMs);
  steady.pull();
}
check(
  steady.history().length === 0,
  "under 1 % loss and no jitter does not trip the splice",
  `${steady.history().length} splices · active ${steady.activeLink}`,
);
const steadyHealth = steady.health()[0];
check(
  steadyHealth.lossPct > 0.5 && steadyHealth.lossPct < 1.5 && steadyHealth.lost === 1,
  "the loss is still measured, and stays under the limit",
  `${steadyHealth.lossPct.toFixed(2)} % (${steadyHealth.lost} frame)`,
);

console.log("\n11 · forced link");
clock = 0;
const forced = new MpxDualLink(now, { sampleRate: RATE, targetMs: 20, silenceMs: 100, holdMs: 50 });
for (let i = 0; i < 4; i++) {
  forced.push(packet(i, 1, 5));
  advance(frameMs);
}
forced.force(1);
check(forced.forcedLink === 1 && forced.activeLink === 1, "the operator's link is held");
for (let i = 0; i < 40; i++) {
  forced.push(packet(i, 0));
  advance(frameMs);
  forced.pull();
}
check(
  forced.activeLink === 1,
  "a forced link is not abandoned when the other one looks better",
  `active ${forced.activeLink}`,
);
forced.force(null);
check(forced.forcedLink === null, "automatic selection resumes on request");

/* ── 12: the network model used by the self-test ───────────────────────── */

console.log("\n12 · network model");
clock = 0;
const clean = new MpxLinkSimulator(DEFAULT_SIMULATOR, now, 7);
for (let i = 0; i < 20; i++) clean.send(packet(i));
clock += 100;
let got = 0;
clean.flush(() => {
  got += 1;
});
check(got === 20 && clean.dropped === 0, "a clean link delivers everything", `${got}/20`);

clock = 0;
const lossyNet = new MpxLinkSimulator({ lossPct: 100, duplicatePct: 0, reorderPct: 0, jitterMs: 0 }, now, 7);
for (let i = 0; i < 20; i++) lossyNet.send(packet(i));
clock += 100;
got = 0;
lossyNet.flush(() => {
  got += 1;
});
check(got === 0 && lossyNet.dropped === 20, "total loss delivers nothing", `${lossyNet.dropped} dropped`);

clock = 0;
const rough = new MpxLinkSimulator(
  { lossPct: 10, duplicatePct: 20, reorderPct: 20, jitterMs: 15 },
  now,
  99,
);
const receiver = new MpxJitterBuffer(now, { sampleRate: RATE, targetMs: 30, gapTimeoutMs: 40 });
for (let i = 0; i < 200; i++) {
  rough.send(packet(i));
  clock += frameMs;
  rough.flush((p) => receiver.push(p));
  receiver.pull();
}
advance(120);
for (let i = 0; i < 40; i++) receiver.pull();
const rh = receiver.health(1000);
check(
  rough.dropped > 0 && rough.duplicated > 0 && rough.delayed > 0,
  "the model actually damages the stream",
  `${rough.dropped} lost · ${rough.duplicated} duplicated · ${rough.delayed} reordered`,
);
check(
  rh.received > 150 && rh.lost > 0 && rh.concealed > 0,
  "the receiver counts what the network took",
  `${rh.received} received · ${rh.lost} lost · ${rh.concealed} concealed`,
);
check(
  rh.lossPct > 3 && rh.lossPct < 20,
  "measured loss tracks the injected loss",
  `${rh.lossPct.toFixed(1)} % against 10 % injected`,
);
check(!Number.isNaN(rh.jitterMs) && rh.jitterMs > 3, "jitter is measured", `${rh.jitterMs.toFixed(1)} ms`);

console.log(
  `\n${passed} checks passed, ${failed} failed${failed ? " — THE LINK LAYER IS NOT CORRECT" : ""}.`,
);
process.exit(failed ? 1 : 0);
