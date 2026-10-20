/**
 * Stream TX / RX engine checks.
 *
 *   bun scripts/verify-stream-engines.ts
 *
 * Pure engine checks: the TX send buffer (pre-buffer, pacing, protective
 * ceiling), the RX jitter buffer (auto target, late/dropped frames, ceiling
 * clamp, silence), the adaptive shared clock, and the badge vocabulary.
 * No sockets and no AudioContext.
 */
import {
  DEFAULT_TX_SETTINGS,
  TX_LIMITS,
  TxBuffer,
  bytesToMs,
  msToBytes,
} from "../src/lib/audio/stream-tx";
import {
  DEFAULT_RX_SETTINGS,
  StreamRxEngine,
  ceilingGainDb,
  type RxFrame,
} from "../src/lib/audio/stream-rx";
import { AdaptiveClock } from "../src/lib/audio/stream-shared-clock";
import { retryDelayMs } from "../src/lib/audio/stream-client";
import { rxBadge, txBadge } from "../src/lib/audio/stream-status";

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

const tick = (ms: number, bitrate: number) =>
  new Uint8Array(Math.round(msToBytes(ms, bitrate)));

/* ── 1 · TX defaults & conversion ──────────────────────────────────────── */

console.log("\n1 · TX defaults");
check(DEFAULT_TX_SETTINGS.bufferMs === 500, "TX buffer defaults to 500 ms");
check(DEFAULT_TX_SETTINGS.prebufferMs === 500, "TX pre-buffer defaults to 500 ms");
check(DEFAULT_TX_SETTINGS.protectiveLimits, "TX protective limits default on");
check(bytesToMs(320_000, 320) === 8000, "320 kB at 320 kbps is 8 s", `${bytesToMs(320_000, 320)} ms`);
check(msToBytes(500, 320) === 20_000, "500 ms at 320 kbps is 20 kB");
check(bytesToMs(1000, 0) === 0, "unknown bitrate yields no duration estimate");
check(retryDelayMs(1) === 1000, "first reconnect waits 1 s");
check(retryDelayMs(2) === 2000, "second reconnect waits 2 s");
check(retryDelayMs(99) === 30_000, "backoff caps at 30 s");

/* ── 2 · pre-buffer ───────────────────────────────────────────────────── */

console.log("\n2 · TX pre-buffer");
{
  const q = new TxBuffer();
  const bitrate = 320;
  let writes = 0;
  let firstWriteAt = -1;
  for (let i = 0; i < 24; i += 1) {
    writes += q.enqueue(tick(20, bitrate), bitrate).length;
    if (writes > 0 && firstWriteAt < 0) firstWriteAt = i + 1;
  }
  check(writes === 0, "no audio is written before 500 ms is accumulated");
  check(q.snapshot().priming, "queue reports pre-buffering");
  check(Math.abs(q.snapshot().bufferedMs - 480) < 0.01, "480 ms is held", `${q.snapshot().bufferedMs.toFixed(2)} ms`);

  const out = q.enqueue(tick(20, bitrate), bitrate);
  const total = out.reduce((n, c) => n + c.byteLength, 0);
  check(out.length === 1 && total === Math.round(msToBytes(500, bitrate)), "the pre-buffer flushes as one write at 500 ms");
  check(!q.snapshot().priming, "pre-buffering ends when the target is met");
  check(q.snapshot().bufferedMs === 0, "a flush empties the queue");

  // No bitrate means no duration estimate: pass through rather than stall.
  const unknown = new TxBuffer();
  const pass = unknown.enqueue(new Uint8Array(100), 0);
  check(pass.length === 1, "unknown bitrate bypasses the pre-buffer");
  check(!unknown.snapshot().priming, "unknown bitrate does not leave the queue priming");

  // A configured buffer must survive a session reset.
  const configured = new TxBuffer({ bufferMs: 250, prebufferMs: 100 });
  configured.reset();
  check(
    configured.settings.bufferMs === 250 && configured.settings.prebufferMs === 100,
    "reset clears audio but keeps the configured buffer",
  );

  // Steady state: the queue holds one buffer of audio in hand.
  const held: number[] = [];
  for (let i = 0; i < 40; i += 1) {
    q.enqueue(tick(20, bitrate), bitrate);
    held.push(q.snapshot().bufferedMs);
  }
  const afterWarmup = held.slice(25);
  check(
    afterWarmup.every((ms) => ms >= 480 && ms <= 520),
    "steady state holds 500 ms of audio",
    `${Math.min(...afterWarmup).toFixed(0)}–${Math.max(...afterWarmup).toFixed(0)} ms`,
  );
}

/* ── 3 · protective ceiling ───────────────────────────────────────────── */

console.log("\n3 · TX protective ceiling");
{
  const bitrate = 320;
  const q = new TxBuffer({ bufferMs: 100, prebufferMs: 5000 });
  let dropped = 0;
  for (let i = 0; i < 200; i += 1) q.enqueue(tick(20, bitrate), bitrate);
  const snap = q.snapshot();
  check(snap.droppedChunks > 0, "the protected ceiling drops the oldest audio", `${snap.droppedChunks} chunks`);
  check(snap.droppedBytes > 0, "dropped bytes are counted", `${snap.droppedBytes} B`);
  check(snap.bufferedMs <= q.ceilingMs() + 0.01, "the queue stays inside the ceiling", `${snap.bufferedMs.toFixed(0)} ms`);
  check(snap.warning, "drops raise the TX warning flag");
  check(q.ceilingMs() >= TX_LIMITS.minCeilingMs, "the ceiling never falls below its floor");
  dropped = snap.droppedChunks;

  const off = new TxBuffer({ bufferMs: 100, prebufferMs: 5000, protectiveLimits: false });
  for (let i = 0; i < 200; i += 1) off.enqueue(tick(20, bitrate), bitrate);
  check(off.snapshot().droppedChunks === 0, "limits off keeps every chunk");
  check(!off.snapshot().warning, "limits off never raises the protective warning");
  check(dropped > 0, "the ceiling test actually exercised drops");

  const reset = new TxBuffer();
  reset.enqueue(tick(100, bitrate), bitrate);
  reset.reset();
  check(reset.snapshot().bufferedMs === 0 && reset.snapshot().priming, "reset clears the queue for a new session");
}

/* ── 4 · shared clock ─────────────────────────────────────────────────── */

console.log("\n4 · shared clock");
{
  const clock = new AdaptiveClock();
  for (let i = 0; i < 10; i += 1) clock.observe(i * 20, i * 20 + 120);
  check(clock.offsetMs() === 120, "a constant offset is measured exactly", `${clock.offsetMs()} ms`);
  check(clock.locked(), "a stable offset locks");
  check(clock.driftPpm() === 0, "no drift on a perfect clock");

  // A 0.002 ms slip per 20 ms frame is 100 ppm.
  const drifting = new AdaptiveClock();
  for (let i = 0; i < 40; i += 1) drifting.observe(i * 20, i * 20 + 100 + i * 0.002);
  check(
    Math.abs(drifting.driftPpm() - 100) < 1,
    "drift is measured in ppm",
    `${drifting.driftPpm().toFixed(2)} ppm`,
  );
  check(
    Math.abs(drifting.correctionPpm() - 100) < 1,
    "adaptive mode applies the drift",
    `${drifting.correctionPpm().toFixed(2)} ppm`,
  );

  const fixed = new AdaptiveClock({ adaptive: false });
  for (let i = 0; i < 40; i += 1) fixed.observe(i * 20, i * 20 + 100 + i * 0.01);
  check(fixed.driftPpm() > 0, "non-adaptive still measures drift");
  check(fixed.correctionPpm() === 0, "non-adaptive applies no correction");

  const clamped = new AdaptiveClock({ maxAdjustPpm: 200 });
  for (let i = 0; i < 40; i += 1) clamped.observe(i * 20, i * 20 + 100 + i * 0.5);
  check(
    Math.abs(clamped.driftPpm()) <= 200,
    "correction is clamped to maxAdjustPpm",
    `${clamped.driftPpm().toFixed(0)} ppm`,
  );
  check(!clamped.locked(), "a climbing offset does not lock");
  check(clamped.snapshot().spreadMs > 0, "offset spread is reported");
}

/* ── 5 · RX defaults, jitter & ceiling ────────────────────────────────── */

console.log("\n5 · RX playout");
check(DEFAULT_RX_SETTINGS.jitter === "auto", "RX jitter defaults to Auto");
check(DEFAULT_RX_SETTINGS.ceilingDb === -0.3, "RX ceiling defaults to −0.3 dBFS");
check(DEFAULT_RX_SETTINGS.clockAdaptive, "RX clock sync is adaptive by default");
check(DEFAULT_RX_SETTINGS.protectiveLimits, "RX protective limits default on");
check(Math.abs(ceilingGainDb(-0.1, -0.3) + 0.2) < 1e-9, "a hot frame gets 0.2 dB of ceiling gain");
check(ceilingGainDb(-3, -0.3) === 0, "a frame under the ceiling is untouched");

function frame(seq: number, sent: number, arrival: number, peak = -6, rms = -20): RxFrame {
  return { seq, sentMs: sent, arrivalMs: arrival, durationMs: 20, peakDb: peak, rmsDb: rms };
}

{
  const rx = new StreamRxEngine({ jitter: 200, minTargetMs: 40, maxTargetMs: 1000 });
  check(rx.targetMs() === 200, "a fixed jitter target is used as-is");
  rx.push(frame(0, 0, 1000));
  check(rx.pull(1100).length === 0, "a frame is not played before its target delay");
  check(rx.pull(1200).length === 1, "the frame plays when the target delay elapses");

  const hot = rx.pull(1220);
  const hotRx = new StreamRxEngine({ jitter: 0, ceilingDb: -0.3 });
  hotRx.push(frame(0, 0, 100, -0.1));
  const clamped = hotRx.pull(100);
  check(clamped.length === 1 && Math.abs(clamped[0].peakDb + 0.3) < 1e-9, "the ceiling clamps the played peak", `${clamped[0]?.peakDb.toFixed(2)} dBFS`);
  const hotSnap = hotRx.snapshot(100);
  check(hotSnap.limitedFrames === 1, "limited frames are counted");
  check(Math.abs(hotSnap.maxReductionDb - 0.2) < 1e-9, "gain reduction is reported", `${hotSnap.maxReductionDb.toFixed(2)} dB`);

  const bypass = new StreamRxEngine({ jitter: 0, protectiveLimits: false });
  bypass.push(frame(0, 0, 0, 0));
  const raw = bypass.pull(0);
  check(raw[0]?.peakDb === 0, "limits off leaves the peak untouched");
  check(bypass.snapshot(0).limitedFrames === 0, "limits off applies no ceiling gain");
  check(hot.length === 0, "a frame does not play twice");
}

/* ── 6 · RX auto jitter, loss & silence ───────────────────────────────── */

console.log("\n6 · RX resilience");
{
  const steady = new StreamRxEngine({ jitter: "auto", minTargetMs: 40 });
  for (let i = 0; i < 10; i += 1) steady.push(frame(i, i * 20, 1000 + i * 20));
  const targetSteady = steady.targetMs();
  check(targetSteady >= 40, "auto target stays above the floor", `${targetSteady.toFixed(1)} ms`);

  const jittery = new StreamRxEngine({ jitter: "auto", minTargetMs: 40 });
  for (let i = 0; i < 10; i += 1) {
    jittery.push(frame(i, i * 20, 1000 + i * 20 + (i % 2 === 0 ? 0 : 30)));
  }
  check(jittery.snapshot(1200).jitterMs > 0, "interarrival jitter is measured");
  check(
    jittery.targetMs() > targetSteady,
    "auto target grows with jitter",
    `${jittery.targetMs().toFixed(1)} > ${targetSteady.toFixed(1)} ms`,
  );

  const loss = new StreamRxEngine({ jitter: 200 });
  loss.push(frame(4, 0, 1000));
  check(!loss.push(frame(4, 0, 1000)), "a duplicate frame is rejected");
  check(loss.snapshot(1000).lateFrames === 1, "the duplicate is counted as late");
  loss.push(frame(6, 40, 1040));
  check(!loss.push(frame(5, 20, 1060)), "reordering is rejected");
  check(loss.snapshot(1060).lateFrames === 2, "reordered frames count as late");

  const silent = new StreamRxEngine({ jitter: 0, silenceMs: 3000 });
  silent.push(frame(0, 0, 0, -6, -12));
  silent.pull(0);
  check(!silent.isSilent(1000), "recent programme is not silent");
  check(silent.isSilent(3000), "silence is detected after the configured stretch");
  check(silent.snapshot(3000).badge.code === "SILENT", "silence outranks other RX badges");
  silent.push(frame(1, 3000, 3000, -6, -12));
  check(!silent.isSilent(3000), "audio clears the silent state");

  const starving = new StreamRxEngine({ jitter: 200, dropWindowMs: 10_000 });
  starving.push(frame(0, 0, 1000, -6, -12));
  starving.pull(1200);
  starving.pull(1300);
  starving.pull(1400);
  check(starving.snapshot(1400).underruns === 1, "an underrun episode is counted once");
  check(starving.snapshot(1400).badge.code === "DROPPING", "an underrun shows DROPPING", starving.snapshot(1400).badge.code);
  starving.push(frame(1, 400, 1400, -6, -12));
  starving.pull(1600);
  check(starving.snapshot(2000).badge.code === "DROPPING", "dropping stays visible inside the event window");
}

/* ── 7 · RX lock & badges ─────────────────────────────────────────────── */

console.log("\n7 · RX lock and badges");
{
  const locked = new StreamRxEngine({ jitter: 0, minTargetMs: 0 });
  for (let i = 0; i < 12; i += 1) locked.push(frame(i, i * 20, 5000 + i * 20 + 80, -6, -20));
  const snap = locked.snapshot(5000 + 11 * 20 + 80);
  check(snap.locked, "a steady stream locks");
  check(snap.badge.code === "LOCKED", "a locked receiver reads LOCKED");
  check(snap.badge.tone === "ok", "LOCKED is an ok tone");

  const driftingRx = new StreamRxEngine({
    jitter: 0,
    driftLimitPpm: 75,
    silenceMs: 60_000,
    // No pulls in this test; without this the 500 ms queue ceiling would
    // legitimately report DROPPING instead, which outranks DRIFTING.
    protectiveLimits: false,
  });
  for (let i = 0; i < 40; i += 1) {
    driftingRx.push(frame(i, i * 20, i * 20 + 100 + i * 0.002, -6, -20));
  }
  const driftSnap = driftingRx.snapshot(1000);
  check(driftSnap.driftPpm > 75, "the receiver measures a drifting sender", `${driftSnap.driftPpm.toFixed(0)} ppm`);
  check(driftSnap.badge.code === "DRIFTING", "a locked but drifting receiver reads DRIFTING");

  check(txBadge("live").code === "LIVE", "live TX reads LIVE");
  check(txBadge("live", true).code === "WARN", "a live socket with limits engaged reads WARN");
  check(txBadge("connecting").code === "CONNECTING", "connecting TX reads CONNECTING");
  check(txBadge("retrying").code === "RECONNECTING", "retrying TX reads RECONNECTING");
  check(txBadge("offline").code === "FAILED", "offline TX reads FAILED");
  check(txBadge("idle").tone === "idle", "idle is not shown as a failure");

  check(
    rxBadge({ locked: false, silent: false, dropping: true, drifting: true }).code === "DROPPING",
    "dropping outranks drifting",
  );
  check(
    rxBadge({ locked: false, silent: false, dropping: false, drifting: true }).code === "DRIFTING",
    "drift is shown before sync",
  );
  check(
    rxBadge({ locked: false, silent: false, dropping: false, drifting: false }).code === "SYNCING",
    "unlocked reads SYNCING",
  );
  check(
    rxBadge({ locked: false, silent: true, dropping: true, drifting: true }).code === "SILENT",
    "silence has the highest priority",
  );
}

/* ── 8 · reconfiguration ──────────────────────────────────────────────── */

console.log("\n8 · live reconfiguration");
{
  const rx = new StreamRxEngine();
  rx.configure({ jitter: 400, ceilingDb: -1, clockAdaptive: false });
  check(rx.settings.jitter === 400, "RX jitter is reconfigurable live");
  check(rx.clock.correctionPpm() === 0, "turning adaptive off stops correction");

  const tx = new TxBuffer();
  tx.configure({ bufferMs: 250, prebufferMs: 100 });
  check(tx.settings.bufferMs === 250 && tx.settings.prebufferMs === 100, "TX buffer is reconfigurable");
  tx.configure({ bufferMs: 99_999 });
  check(tx.settings.bufferMs === TX_LIMITS.maxBufferMs, "buffer configuration is clamped");
}

console.log(`\n${passed} checks passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
