/**
 * Real-time safety checks.
 *
 *   bun scripts/verify-rt-safety.ts
 *
 * Two things are verified here that the audio engine cannot verify by ear:
 *
 *  1. the limiter kernel's monotonic queue is preallocated typed arrays, so a
 *     24/7 show cannot grow a container from the audio thread;
 *  2. the PCM tap worklet stages samples in buffers allocated in its
 *     constructor instead of allocating a Float32Array per block;
 *  3. the SPSC meter ring preserves ordering and refuses instead of
 *     overwriting when the consumer falls behind.
 *
 * Allocation itself cannot be observed from a unit test, so the worklet
 * sources are also checked for the primitives that would allocate: array
 * push/slice, per-block constructor calls and transfer lists.
 */
import { LookaheadLimiter, limiterWorkletSource } from "../src/lib/audio/limiter";
import { SpscRing, createSpscRing } from "../src/lib/audio/spsc-ring";
import { pcmTapWorkletSource } from "../src/lib/audio/js-encoder";

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

/* ── 1 · limiter queue is preallocated ────────────────────────────────── */

console.log("\n1 · limiter audio-thread queue");
{
  const SR = 48_000;
  const lim = new LookaheadLimiter(SR);
  lim.configure(-3, 60, 0, 5);
  check(lim.queueCapacity >= lim.latencySamples + 1, "queue capacity covers the lookahead window", `${lim.queueCapacity} slots`);
  check(lim.queueDepth === 0, "queue starts empty");

  const block = 128;
  const inL = new Float32Array(block);
  const inR = new Float32Array(block);
  const outL = new Float32Array(block);
  const outR = new Float32Array(block);
  let phase = 0;
  let maxDepth = 0;
  let peak = 0;
  const blocks = Math.floor((2_000_000 / block));
  for (let b = 0; b < blocks; b += 1) {
    for (let i = 0; i < block; i += 1) {
      const v = 0.9 * Math.sin(phase);
      phase += (2 * Math.PI * 997) / SR;
      inL[i] = v;
      inR[i] = v;
    }
    lim.process(inL, inR, outL, outR);
    maxDepth = Math.max(maxDepth, lim.queueDepth);
    for (let i = 0; i < block; i += 1) peak = Math.max(peak, Math.abs(outL[i]));
  }
  const ceiling = Math.pow(10, -3 / 20);
  check(maxDepth <= lim.queueCapacity, "the queue never exceeds its allocation", `${maxDepth}/${lim.queueCapacity}`);
  check(maxDepth > 0, "the queue was actually exercised");
  // Float32 storage rounds the last bit; 1e-4 is 0.0009 dB, far below any
  // audible ceiling breach and still far above the rounding error.
  check(peak <= ceiling + 1e-4, "the preallocated queue still holds the ceiling", `${(20 * Math.log10(peak)).toFixed(3)} dBFS`);
  check(Number.isFinite(lim.gainReductionDb), "gain reduction stays finite");

  // Reconfiguring to a long lookahead must reuse the same allocation.
  const cap = lim.queueCapacity;
  lim.configure(-3, 60, 0, 20);
  for (let b = 0; b < 200; b += 1) lim.process(inL, inR, outL, outR);
  check(lim.queueCapacity === cap, "reconfiguring never resizes the queue");
  check(lim.queueDepth <= cap, "the longer window fits the same queue");
}

/* ── 2 · generated worklets avoid per-block allocation ────────────────── */

console.log("\n2 · worklet sources");
{
  const limiter = limiterWorkletSource();
  check(!limiter.includes(".push("), "the limiter kernel never pushes into an array");
  check(!limiter.includes(".slice("), "the limiter kernel never copies its queue");
  check(limiter.includes("new Float32Array(this.qCap)"), "the queue is a typed array allocated at construction");
  check(limiter.includes("new SpscRing("), "metering uses the SPSC ring when a buffer is provided");
  check(limiter.includes("processorOptions.meter"), "the ring arrives through processorOptions");
  check(
    limiter.includes("else if ((this.blocks++ & 7) === 0)"),
    "the postMessage fallback remains for contexts without SharedArrayBuffer",
  );

  const tap = pcmTapWorkletSource();
  check(!tap.includes(".push("), "the PCM tap never pushes into an array");
  check(!tap.includes("concat("), "the PCM tap no longer concatenates per batch");
  check(
    (tap.match(/new Float32Array/g) ?? []).length === 2,
    "the tap allocates exactly its two staging buffers",
  );
  check(tap.includes("this.fill === 4096"), "the tap flushes a full preallocated batch");
  check(!tap.includes("transfer"), "the tap does not detach its staging buffers");
}

/* ── 3 · SPSC ring ────────────────────────────────────────────────────── */

console.log("\n3 · SPSC meter ring");
{
  const { ring } = createSpscRing(4);
  check(ring.capacity() === 4, "capacity is fixed at construction");
  check(ring.read() === null, "an empty ring reads null");

  for (let i = 0; i < 4; i += 1) check(ring.write(i + 0.5), `write ${i + 1} of 4 succeeds`);
  check(!ring.write(9), "a full ring refuses the write");
  check(ring.dropped() === 1, "the refusal is counted as a drop");
  check(ring.available() === 4, "all four slots are readable");
  check(ring.latest() === 3.5, "latest reads the newest value without consuming");

  check(ring.read() === 0.5, "values come out in order (1/4)");
  check(ring.read() === 1.5, "values come out in order (2/4)");
  check(ring.write(4.5) && ring.write(5.5), "space freed by reads can be reused");
  check(ring.read() === 2.5 && ring.read() === 3.5, "wrapped values keep their order");
  check(ring.read() === 4.5 && ring.read() === 5.5, "the wrapped writes read back last");
  check(ring.read() === null, "the ring drains to empty");

  ring.write(-12.25);
  check(ring.latest() === -12.25, "latest tracks a negative value");
  ring.clear();
  check(ring.available() === 0, "clear drops unread values");

  const small = createSpscRing(0);
  check(small.ring.capacity() === 2, "capacity is clamped to a usable minimum");

  const big = createSpscRing(100_000);
  check(big.ring.capacity() === 65_536, "capacity is clamped to the maximum");
}

/* ── 4 · producer / consumer interleave ───────────────────────────────── */

console.log("\n4 · interleaved producer and consumer");
{
  const { ring } = createSpscRing(8);
  const produced: number[] = [];
  const consumed: number[] = [];
  let seq = 0;
  // Deterministic interleave: two writes, one read, repeated. Order must be
  // preserved even across the ring's wrap point and the dropped writes.
  for (let round = 0; round < 20; round += 1) {
    for (let i = 0; i < 2; i += 1) {
      const value = seq * 0.25;
      if (ring.write(value)) produced.push(value);
      seq += 1;
    }
    const got = ring.read();
    if (got !== null) consumed.push(got);
  }
  while (true) {
    const got = ring.read();
    if (got === null) break;
    consumed.push(got);
  }
  check(produced.length + ring.dropped() === 40, "every produced value is written or counted as dropped");
  check(
    consumed.every((v, i) => v === produced[i]),
    "consumed values match production order",
    `${consumed.length} values`,
  );
  const shared = createSpscRing(8);
  const second = new SpscRing(shared.sab);
  shared.ring.write(7.5);
  check(second.read() === 7.5, "two views over one SAB share the same queue");

  // A consumer that keeps up leaves no drops behind, however long it runs.
  const drain = createSpscRing(8);
  let newest = 0;
  for (let i = 0; i < 1000; i += 1) {
    drain.ring.write(i);
    let v = drain.ring.read();
    while (v !== null) {
      newest = v;
      v = drain.ring.read();
    }
  }
  check(drain.ring.dropped() === 0, "a keeping-up consumer accumulates no drops");
  check(newest === 999, "draining preserves the newest value", `${newest}`);
}

console.log(`\n${passed} checks passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
