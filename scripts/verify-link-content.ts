/**
 * End-to-end link content test:
 *
 *   bun scripts/verify-link-content.ts
 *
 * The chain under test is the whole one, with nothing mocked except the clock:
 * the real FM generator builds a composite from programme audio and RDS, the
 * real packetiser frames it, the bytes go through real UDP sockets on two
 * paths, the real dual-link receiver selects and splices them, and the real
 * composite decoder pulls the station name and the stereo programme back out.
 *
 * The decoder never sees the parameters that went in. Every assertion below is
 * about what came off the wire.
 *
 * Checks:
 *  1  both paths carry the whole stream, intact and in order
 *  2  a clean link decodes the station: PI, PTY, programme service name
 *  3  the same link decodes RadioText, character for character
 *  4  the programme audio comes back on the right legs, at the right level
 *  5  channel separation survives the multiplex
 *  6  with a quarter of path A missing, the receiver splices to B
 *  7  after the splice the station and the programme still decode
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
import { MpxGenerator } from "../src/lib/audio/mpx";
import { CompositeDecoder, type DecodeSnapshot } from "../src/lib/audio/mpxdecode";
import { DEFAULT_PARAMS } from "../src/lib/audio/params";
import type { FmParams } from "../src/lib/audio/params";

const require = createRequire(import.meta.url);
const { UdpEndpoint } = require("../electron/udp-link.cjs") as {
  UdpEndpoint: new (options?: { onData?: (bytes: Uint8Array) => void }) => {
    open(args: { listenPort?: number; host: string; port: number }): Promise<number>;
    send(bytes: Uint8Array): boolean;
    close(): void;
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
const IN_RATE = 48000;
const frameMs = (MPX_LINK_FRAME_SAMPLES / RATE) * 1000;
const LEFT_HZ = 1000;
const RIGHT_HZ = 600;
const LEFT_AMP = 0.25;
const RIGHT_AMP = 0.1;

const PS = "SIGNAL  ";
/** Three RadioText segments: the schedule carries two per cycle, so a full
 *  text arrives in well under two seconds on a healthy link. The separator is
 *  what makes the encoder emit two RadioText Plus tags. */
const RT = "Miles - Blue";
const PI = 0xc479;
const PTY = 10;

function fmParams(): FmParams {
  const params = structuredClone(DEFAULT_PARAMS.fm);
  params.on = true;
  params.emphasis = "off";
  params.mpx.on = true;
  params.mpx.pilotPct = 9;
  params.mpx.rdsPct = 3.3;
  params.mpx.rdsPs = PS;
  params.mpx.rdsRt = RT;
  params.mpx.rdsPi = "C479";
  params.mpx.rdsPty = PTY;
  params.mpx.rdsRtPlus = true;
  return params;
}

/** Composite of `seconds` of programme: a tone on each leg. */
function makeComposite(seconds: number): Float32Array {
  const gen = new MpxGenerator(IN_RATE, fmParams(), 4096);
  const block = 4096;
  const total = IN_RATE * seconds;
  const out = new Float32Array(total * 4);
  const l = new Float32Array(block);
  const r = new Float32Array(block);
  let at = 0;
  for (let k = 0; k < total; k += block) {
    const n = Math.min(block, total - k);
    for (let i = 0; i < n; i++) {
      const t = (k + i) / IN_RATE;
      l[i] = LEFT_AMP * Math.sin(2 * Math.PI * LEFT_HZ * t);
      r[i] = RIGHT_AMP * Math.sin(2 * Math.PI * RIGHT_HZ * t);
    }
    const comp = gen.process(l, r);
    out.set(comp.subarray(0, n * 4), at);
    at += n * 4;
  }
  return out.subarray(0, at);
}

function toPayload(samples: Float32Array, from: number, count: number): Uint8Array {
  const bytes = new Uint8Array(count * 2);
  for (let i = 0; i < count; i++) {
    const v = Math.max(-1, Math.min(1, samples[from + i]));
    const s = Math.round(v * 32767);
    bytes[i * 2] = s & 0xff;
    bytes[i * 2 + 1] = (s >> 8) & 0xff;
  }
  return bytes;
}

interface LinkRun {
  snapshot: DecodeSnapshot;
  captured: { left: Float32Array; right: Float32Array };
  splices: number;
  active: number;
  deliveredA: number;
  deliveredB: number;
  expected: number;
}

/**
 * Send a composite over two real UDP paths, then play the arriving packets
 * through the dual-link receiver on a controlled clock. `dropEvery` thins path
 * A so the splice has something to do.
 */
async function runLink(composite: Float32Array, dropEvery: number): Promise<LinkRun> {
  const inboxA: MpxPacket[] = [];
  const inboxB: MpxPacket[] = [];
  const rxA = new UdpEndpoint({
    onData: (bytes) => {
      const p = decodePacket(bytes);
      if (p) inboxA.push(p);
    },
  });
  const rxB = new UdpEndpoint({
    onData: (bytes) => {
      const p = decodePacket(bytes);
      if (p) inboxB.push(p);
    },
  });
  const portA = await rxA.open({ listenPort: 0, host: "127.0.0.1", port: 9 });
  const portB = await rxB.open({ listenPort: 0, host: "127.0.0.1", port: 9 });
  const txA = new UdpEndpoint();
  const txB = new UdpEndpoint();
  await txA.open({ listenPort: 0, host: "127.0.0.1", port: portA });
  await txB.open({ listenPort: 0, host: "127.0.0.1", port: portB });

  let clock = 0;
  const packetiser = new MpxPacketiser(0, RATE, 1, () => clock);
  const frames = Math.floor(composite.length / MPX_LINK_FRAME_SAMPLES);
  let sentA = 0;
  for (let i = 0; i < frames; i++) {
    const packet = packetiser.push(
      "raw",
      toPayload(composite, i * MPX_LINK_FRAME_SAMPLES, MPX_LINK_FRAME_SAMPLES),
    );
    if (dropEvery <= 1 || i % dropEvery !== 0) {
      txA.send(encodePacket({ ...packet, link: 0 }));
      sentA += 1;
    }
    txB.send(encodePacket({ ...packet, link: 1 }));
    clock += frameMs;
    if (i % 12 === 11) await new Promise((res) => setTimeout(res, 2));
  }

  // wait for the sockets to drain
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && (inboxA.length < sentA || inboxB.length < frames)) {
    await new Promise((res) => setTimeout(res, 5));
  }
  txA.close();
  txB.close();
  rxA.close();
  rxB.close();

  // replay through the real receiver on a deterministic clock
  let rxClock = 0;
  const receiver = new MpxDualLink(() => rxClock, {
    sampleRate: RATE,
    targetMs: 120,
    gapTimeoutMs: 200,
    silenceMs: 400,
    holdMs: 300,
    maxLossPct: 1.5,
    maxJitterMs: 25,
  });
  const decoder = new CompositeDecoder({ sampleRate: RATE });
  decoder.startCapture(composite.length);

  const bySeqA = new Map(inboxA.map((p) => [p.sequence, p]));
  const bySeqB = new Map(inboxB.map((p) => [p.sequence, p]));
  for (let i = 0; i < frames; i++) {
    const a = bySeqA.get(i);
    const b = bySeqB.get(i);
    if (a) receiver.push({ ...a, link: 0 });
    if (b) receiver.push({ ...b, link: 1 });
    rxClock += frameMs;
    for (let k = 0; k < 2; k++) {
      const out = receiver.pull();
      if (!out) break;
      const payload = out.payload;
      const n = payload.length >> 1;
      const samples = new Float32Array(n);
      for (let s = 0; s < n; s++) {
        const v = payload[s * 2] | (payload[s * 2 + 1] << 8);
        samples[s] = ((v << 16) >> 16) / 32768;
      }
      decoder.process(samples);
    }
  }
  rxClock += 500;
  for (let i = 0; i < 500; i++) {
    const out = receiver.pull();
    if (!out) continue;
    const payload = out.payload;
    const n = payload.length >> 1;
    const samples = new Float32Array(n);
    for (let s = 0; s < n; s++) {
      const v = payload[s * 2] | (payload[s * 2 + 1] << 8);
      samples[s] = ((v << 16) >> 16) / 32768;
    }
    decoder.process(samples);
  }

  const captured = decoder.takeCapture();
  return {
    snapshot: decoder.snapshot(),
    captured: cap(captured),
    splices: receiver.history().length,
    active: receiver.activeLink,
    deliveredA: inboxA.length,
    deliveredB: inboxB.length,
    expected: frames,
  };
}

function cap(
  c: { left: Float32Array; right: Float32Array } | null,
): { left: Float32Array; right: Float32Array } {
  return c ?? { left: new Float32Array(0), right: new Float32Array(0) };
}

/** The last `seconds` of a capture — the part after a splice has settled. */
function tail(samples: Float32Array, seconds: number): Float32Array {
  const n = Math.min(samples.length, Math.round(seconds * RATE));
  return samples.subarray(samples.length - n);
}

/** Amplitude of one tone in a signal (Goertzel over the whole capture). */
function toneAmplitude(samples: Float32Array, hz: number): number {
  if (samples.length === 0) return 0;
  const w = (2 * Math.PI * hz) / RATE;
  let re = 0;
  let im = 0;
  for (let i = 0; i < samples.length; i++) {
    re += samples[i] * Math.cos(w * i);
    im += samples[i] * Math.sin(w * i);
  }
  return (2 * Math.sqrt(re * re + im * im)) / samples.length;
}

async function main(): Promise<void> {
  const SECONDS = 4;
  // The schedule carries two RadioText segments per 12-group cycle, so the
  // damaged run has to be long enough to come back round to segment zero after
  // the splice — about eight seconds of programme.
  const DAMAGED_SECONDS = 10;
  console.log("\nbuilding programme and composite…");
  const full = makeComposite(DAMAGED_SECONDS);
  const composite = full.subarray(0, SECONDS * RATE);

  // ── clean link ───────────────────────────────────────────────────────────
  console.log("\n1 · transport");
  const clean = await runLink(composite, 0);
  check(
    clean.deliveredA === clean.expected && clean.deliveredB === clean.expected,
    "both paths delivered every frame",
    `${clean.deliveredA}/${clean.expected} A · ${clean.deliveredB}/${clean.expected} B`,
  );
  check(clean.splices === 0, "a clean pair never switches", `${clean.splices} splices`);

  console.log("\n2 · station identity");
  const rds = clean.snapshot.rds;
  check(rds.locked, "block sync acquired on the received stream");
  check(
    rds.pi === PI,
    "PI decoded",
    `0x${(rds.pi ?? 0).toString(16).toUpperCase()} want 0x${PI.toString(16).toUpperCase()}`,
  );
  check(rds.pty === PTY, "PTY decoded", `${rds.pty}`);
  check(rds.ps.trim() === PS.trim(), "programme service name decoded", `"${rds.ps}"`);
  check(rds.psComplete, "all four PS segments arrived");

  console.log("\n3 · RadioText");
  check(rds.rt === RT, "RadioText decoded", `"${rds.rt}"`);
  check(rds.rtPlus, "the 3A announcement for RT+ was heard");
  const tagText = rds.rtPlusTags.map((t) => `${t.name}="${t.text}"`).join(" ");
  check(
    rds.rtPlusTags.some((t) => t.name === "Item.Artist" && t.text === "Miles"),
    "RT+ artist tag decoded from 11A",
    tagText,
  );
  check(
    rds.rtPlusTags.some((t) => t.name === "Item.Title" && t.text === "Blue"),
    "RT+ title tag decoded from 11A",
    tagText,
  );
  check(rds.groups >= 30, "groups decoded at the expected rate", `${rds.groups} groups in ${SECONDS} s`);
  check(rds.errors === 0, "no block failed its syndrome", `${rds.errors}`);

  console.log("\n4 · programme audio");
  const leftTone = toneAmplitude(clean.captured.left, LEFT_HZ);
  const rightTone = toneAmplitude(clean.captured.right, RIGHT_HZ);
  check(
    Math.abs(leftTone - LEFT_AMP) / LEFT_AMP < 0.05,
    "left leg carries the left tone at the right level",
    `${leftTone.toFixed(4)} want ${LEFT_AMP.toFixed(4)}`,
  );
  check(
    Math.abs(rightTone - RIGHT_AMP) / RIGHT_AMP < 0.05,
    "right leg carries the right tone at the right level",
    `${rightTone.toFixed(4)} want ${RIGHT_AMP.toFixed(4)}`,
  );

  console.log("\n5 · channel separation");
  const leftLeak = toneAmplitude(clean.captured.left, RIGHT_HZ);
  const rightLeak = toneAmplitude(clean.captured.right, LEFT_HZ);
  check(
    leftLeak < LEFT_AMP * 0.03,
    "the right tone does not appear on the left leg",
    `${leftLeak.toFixed(4)} (${((leftLeak / LEFT_AMP) * 100).toFixed(1)} %)`,
  );
  check(
    rightLeak < RIGHT_AMP * 0.1,
    "the left tone does not appear on the right leg",
    `${rightLeak.toFixed(4)} (${((rightLeak / RIGHT_AMP) * 100).toFixed(1)} %)`,
  );

  // ── damaged link ─────────────────────────────────────────────────────────
  console.log("\n6 · failover");
  const damaged = await runLink(full, 4);
  check(
    damaged.deliveredA < damaged.expected,
    "path A is genuinely damaged",
    `${damaged.deliveredA}/${damaged.expected} frames`,
  );
  check(damaged.splices >= 1, "the receiver spliced away from it", `${damaged.splices} splice(s)`);
  check(damaged.active === 1, "the standby is serving", `active ${damaged.active === 0 ? "A" : "B"}`);

  console.log("\n7 · content after the splice");
  const dRds = damaged.snapshot.rds;
  check(dRds.locked, "RDS is locked again after the switch");
  check(dRds.ps.trim() === PS.trim(), "programme service name still decodes", `"${dRds.ps}"`);
  check(dRds.rt === RT, "RadioText still decodes", `"${dRds.rt}"`);
  check(
    dRds.rtPlusTags.length === 2,
    "RT+ tags still decode after the switch",
    dRds.rtPlusTags.map((t) => `${t.name}="${t.text}"`).join(" "),
  );
  // The first second carries the damage; what matters is the programme after
  // the splice settled, so measure the tail rather than the whole capture.
  const dLeft = toneAmplitude(tail(damaged.captured.left, 3), LEFT_HZ);
  const dRight = toneAmplitude(tail(damaged.captured.right, 3), RIGHT_HZ);
  check(
    Math.abs(dLeft - LEFT_AMP) / LEFT_AMP < 0.03,
    "left tone survives the splice",
    `${dLeft.toFixed(4)} want ${LEFT_AMP.toFixed(4)}`,
  );
  check(
    Math.abs(dRight - RIGHT_AMP) / RIGHT_AMP < 0.03,
    "right tone survives the splice",
    `${dRight.toFixed(4)} want ${RIGHT_AMP.toFixed(4)}`,
  );
  const dLeak = toneAmplitude(tail(damaged.captured.left, 3), RIGHT_HZ);
  check(
    dLeak < LEFT_AMP * 0.03,
    "separation survives the splice",
    `${dLeak.toFixed(4)} leaked`,
  );

  console.log(`\n${passed} checks passed, ${failed} failed.\n`);
  if (failed > 0) process.exit(1);
}

await main();
