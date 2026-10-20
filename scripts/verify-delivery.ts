/**
 * Delivery stage: the lookahead limiter kernel, the dual-mount failover
 * policy and the offline batch pipeline.
 *
 *   bun scripts/verify-delivery.ts
 *
 * The limiter and the batch normaliser are pure sample maths, so the exact
 * implementation the AudioWorklet runs is exercised here. The failover router
 * is time-injected, so the switch/retry rules are checked without a server.
 *
 *  1  limiter holds the ceiling and pays only its lookahead
 *  2  below-ceiling programme passes untouched
 *  3  release and hold behave as configured
 *  4  the worklet module is self-contained
 *  5  dual-mount routing: switch, retry, restore
 *  6  batch: K-weighted loudness and target convergence
 *  7  batch: 16-bit WAV container
 */
import {
  LIMITER_WORKLET_NAME,
  LookaheadLimiter,
  limiterWorkletSource,
} from "../src/lib/audio/limiter";
import { createSpscRing } from "../src/lib/audio/spsc-ring";
import {
  DualMountFailover,
  mountCandidates,
  normalizeMount,
} from "../src/lib/audio/mount-failover";
import {
  integratedLoudness48k,
  normalizeSamples,
  outputName,
  wavBytes,
} from "../src/lib/audio/batch";
import { limiterEngine } from "../src/lib/audio/params";

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

const SR = 48_000;
const sine = (amplitude: number, seconds: number, hz = 1000): Float32Array => {
  const n = Math.round(SR * seconds);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / SR);
  return out;
};

const peak = (s: Float32Array): number => {
  let max = 0;
  for (let i = 0; i < s.length; i++) max = Math.max(max, Math.abs(s[i]));
  return max;
};

const runLimiter = (
  lim: LookaheadLimiter,
  l: Float32Array,
  r: Float32Array,
): { l: Float32Array; r: Float32Array; gr: number } => {
  const outL = new Float32Array(l.length);
  const outR = new Float32Array(r.length);
  let gr = 0;
  for (let start = 0; start < l.length; start += 128) {
    const end = Math.min(l.length, start + 128);
    gr = Math.max(
      gr,
      lim.process(l.subarray(start, end), r.subarray(start, end), outL.subarray(start, end), outR.subarray(start, end)),
    );
  }
  return { l: outL, r: outR, gr };
};

/* ── 1 · ceiling ───────────────────────────────────────────────────────── */

console.log("\n1 · lookahead limiter");

{
  const lim = new LookaheadLimiter(SR);
  lim.configure(-1, 60, 0, 5);
  check(lim.latencySamples === Math.round(0.005 * SR), "5 ms lookahead is 240 samples", `${lim.latencySamples}`);
  const input = sine(0.99, 1);
  const { l, r, gr } = runLimiter(lim, input, input);
  const ceiling = Math.pow(10, -1 / 20);
  const outPeak = Math.max(peak(l), peak(r));
  check(outPeak <= ceiling + 1e-4, "output never exceeds the ceiling", `${(20 * Math.log10(outPeak)).toFixed(3)} dBFS`);
  check(gr > 0.5, "the stage reports reduction on a hot sine", `${gr.toFixed(2)} dB`);
  check(l[0] === 0 && l[100] === 0, "the delay line fills before audio leaves");
}

/* ── 2 · transparency below the ceiling ────────────────────────────────── */

{
  const lim = new LookaheadLimiter(SR);
  lim.configure(-1, 60, 0, 2);
  const input = sine(0.5, 0.5);
  const { l, gr } = runLimiter(lim, input, input);
  let worst = 0;
  for (let i = 0; i < input.length - lim.latencySamples; i++) {
    worst = Math.max(worst, Math.abs(l[i + lim.latencySamples] - input[i]));
  }
  check(worst < 1e-6, "programme under the ceiling is untouched", `Δ ${worst.toExponential(1)}`);
  check(gr === 0, "no reduction is reported below the ceiling");

  const impulse = new Float32Array(SR);
  impulse[500] = 0.5;
  const fresh = new LookaheadLimiter(SR);
  fresh.configure(-1, 60, 0, 2);
  const delay = runLimiter(fresh, impulse, impulse);
  let at = -1;
  for (let i = 0; i < delay.l.length; i++) {
    if (delay.l[i] !== 0) {
      at = i;
      break;
    }
  }
  check(
    at === 500 + fresh.latencySamples,
    "a transient leaves after exactly the lookahead",
    `${at} vs ${500 + fresh.latencySamples}`,
  );
}

/* ── 3 · release + hold ────────────────────────────────────────────────── */

{
  const burst = new Float32Array(SR);
  burst.set(sine(0.99, 0.1), 0);

  const fast = new LookaheadLimiter(SR);
  fast.configure(-1, 40, 0, 5);
  const fastRun = runLimiter(fast, burst, burst);
  check(fastRun.gr > 0.5, "a 100 ms burst is limited");

  const loose = new LookaheadLimiter(SR);
  loose.configure(-1, 40, 0, 5);
  runLimiter(loose, burst, burst);
  const quiet = new Float32Array(SR);
  quiet.set(sine(0.4, 0.1), 0);
  const afterRelease = runLimiter(loose, quiet, quiet);
  check(afterRelease.gr < 1, "the gain releases on the quieter programme", `${afterRelease.gr.toFixed(2)} dB`);

  const held = new LookaheadLimiter(SR);
  held.configure(-1, 40, 200, 5);
  runLimiter(held, burst, burst);
  const heldRun = runLimiter(held, quiet, quiet);
  check(
    heldRun.gr >= afterRelease.gr,
    "hold keeps the gain down longer than a free release",
    `${heldRun.gr.toFixed(2)} vs ${afterRelease.gr.toFixed(2)} dB`,
  );
}

/* ── 4 · worklet module ────────────────────────────────────────────────── */

{
  const source = limiterWorkletSource();
  check(source.includes(`registerProcessor("${LIMITER_WORKLET_NAME}"`), "processor is registered");
  check(source.includes("class LookaheadLimiter"), "the kernel is embedded from its source");
  check(!/\bimport\s/.test(source), "the module has no imports");
  check(source.includes("new LookaheadLimiter(sampleRate)"), "the node runs at the graph's sample rate");
  check(limiterEngine(undefined) === "worklet", "old saves take the worklet path");
  check(limiterEngine({ engine: "native" } as never) === "native", "native can be forced");

  // Execute the generated module against the audio-thread globals and run a
  // hot block through it: the wrapper, not just the kernel, has to hold.
  interface WorkletNode {
    port: {
      postMessage: (msg: unknown) => void;
      onmessage: ((e: { data: unknown }) => void) | null;
    };
    process: (inputs: Float32Array[][], outputs: Float32Array[][]) => boolean;
  }
  const posted: unknown[] = [];
  const scope = globalThis as unknown as Record<string, unknown>;
  let registered = "";
  scope.AudioWorkletProcessor = class {
    port = { postMessage: (msg: unknown) => posted.push(msg), onmessage: null };
  };
  scope.sampleRate = SR;
  scope.registerProcessor = (name: string) => {
    registered = name;
  };
  const Processor = new Function(
    `${source}\nreturn SignalpathLimiterProcessor;`,
  )() as new (options?: {
    processorOptions?: { meter?: SharedArrayBuffer };
  }) => WorkletNode;
  const node = new Processor();
  node.port.onmessage?.({ data: { ceilingDb: -1, releaseMs: 60, holdMs: 0, lookaheadMs: 5 } });
  const inL = new Float32Array(128).fill(0.99);
  const outL = new Float32Array(128);
  const outR = new Float32Array(128);
  for (let i = 0; i < 64; i++) node.process([[inL, inL]], [[outL, outR]]);
  check(registered === LIMITER_WORKLET_NAME, "the generated module registers its processor");
  check(peak(outL) <= Math.pow(10, -1 / 20) + 1e-4, "the running worklet holds the ceiling", `${(20 * Math.log10(peak(outL))).toFixed(2)} dBFS`);
  const fallbackGr = posted.at(-1);
  check(typeof fallbackGr === "number" && fallbackGr > 0, "the worklet posts gain reduction as a bare number", `${Number(fallbackGr ?? 0).toFixed(2)} dB`);

  // With a shared meter ring the callback writes the slot and posts nothing.
  const meter = createSpscRing(16);
  const withRing = new Processor({ processorOptions: { meter: meter.sab } });
  const before = posted.length;
  for (let i = 0; i < 64; i++) withRing.process([[inL, inL]], [[outL, outR]]);
  check(meter.ring.latest() > 0, "the meter ring receives gain reduction", `${meter.ring.latest().toFixed(2)} dB`);
  check(posted.length === before, "a ring meter posts no messages from the audio thread");
}

/* ── 5 · dual mount ────────────────────────────────────────────────────── */

console.log("\n2 · dual mount failover");

{
  check(normalizeMount("live") === "/live", "mounts gain a leading slash");
  check(normalizeMount(" /backup ") === "/backup", "mounts are trimmed");
  check(mountCandidates("/live", "live").length === 1, "an identical backup is ignored");
  check(mountCandidates("/live", "")[0] === "/live", "an empty backup leaves one mount");

  const single = new DualMountFailover("/live", "");
  single.recordFailure(0);
  single.recordFailure(1);
  check(single.active === "/live", "a single mount never switches");

  const router = new DualMountFailover("/live", "/backup", {
    failuresBeforeSwitch: 2,
    primaryRetryMs: 60_000,
  });
  check(router.active === "/live", "the primary is tried first");
  router.recordFailure(1000);
  check(router.active === "/live", "one failure is not enough to switch");
  router.recordFailure(2000);
  check(router.active === "/backup", "two failures move the source to the backup");
  check(router.switched, "the router reports the backup in use");
  check(router.state.switches === 1, "the switch is counted");

  router.recordLive(3000, "/backup");
  check(router.choose(30_000) === "/backup", "the backup is held during its healthy window");
  check(router.choose(70_000) === "/live", "the primary is retried after the window");

  router.recordFailure(71_000);
  check(router.active === "/backup", "a failed retry drops straight back to the backup");
  router.recordLive(72_000, "/backup");
  router.recordFailure(200_000);
  router.recordFailure(201_000);
  check(router.active === "/backup", "the backup is kept when it is the only healthy path");

  router.recordLive(202_000, "/backup");
  const retry = router.choose(400_000);
  check(retry === "/live", "a later reconnect tries the primary again");
  router.recordLive(401_000, "/live");
  check(router.active === "/live", "a healthy primary is restored");
  check(!router.switched, "the router reports the primary back in use");
  check(router.state.switches === 2, "both transitions are counted");
}

/* ── 6 · batch loudness ────────────────────────────────────────────────── */

console.log("\n3 · batch processing");

{
  const tone = sine(0.1, 2); // −20 dBFS peak, −23 dBFS RMS per channel
  const lufs = integratedLoudness48k(tone, tone);
  // BS.1770 sums both channels: two identical −23 dBFS-RMS channels read
  // ≈ −20 LUFS, which is also how a mono source lands in a stereo chain.
  check(Math.abs(lufs + 20) < 0.5, "K-weighted stereo tone sums channel power", `${lufs.toFixed(1)} LUFS`);
  check(integratedLoudness48k(new Float32Array(SR), new Float32Array(SR)) === -70, "silence floors at −70 LUFS");

  const quiet = normalizeSamples(tone, tone, { targetLufs: -16, ceilingDb: -1 });
  check(Math.abs(quiet.metrics.lufsOut + 16) < 0.6, "quiet programme is raised to target", `${quiet.metrics.lufsOut.toFixed(1)} LUFS`);
  check(quiet.metrics.gainDb > 0, "a positive make-up gain is applied", `${quiet.metrics.gainDb.toFixed(1)} dB`);
  check(quiet.metrics.truePeakOut <= -0.9, "the true-peak ceiling is met", `${quiet.metrics.truePeakOut.toFixed(2)} dBTP`);
  check(peak(quiet.l) <= Math.pow(10, -1 / 20) + 1e-4, "no sample leaves above the ceiling");

  const hot = normalizeSamples(sine(0.9, 2), sine(0.9, 2), { targetLufs: -23, ceilingDb: -1 });
  check(Math.abs(hot.metrics.lufsOut + 23) < 0.6, "hot programme is pulled to target", `${hot.metrics.lufsOut.toFixed(1)} LUFS`);
  check(hot.metrics.gainDb < 0, "a negative gain is applied", `${hot.metrics.gainDb.toFixed(1)} dB`);

  // A quiet body with loud transients: normalising to −10 LUFS needs +10 dB,
  // which drives the 1.0 impulses well over the ceiling — the limiter, not
  // the gain, has to do the peak work.
  const body = sine(0.09, 2);
  for (let i = 0; i < body.length; i += SR / 4) body[i] = 1;
  const transient = normalizeSamples(body, body, { targetLufs: -10, ceilingDb: -1 });
  check(Math.abs(transient.metrics.lufsOut + 10) < 1, "crest-heavy programme hits its target", `${transient.metrics.lufsOut.toFixed(1)} LUFS`);
  check(transient.metrics.grMaxDb > 3, "the limiter does the peak work", `${transient.metrics.grMaxDb.toFixed(1)} dB GR`);
  check(transient.metrics.truePeakOut <= -0.9, "transients stay under the ceiling", `${transient.metrics.truePeakOut.toFixed(2)} dBTP`);

  const silent = normalizeSamples(new Float32Array(SR), new Float32Array(SR), {
    targetLufs: -14,
    ceilingDb: -1,
  });
  check(silent.metrics.silent, "silence is flagged instead of amplified");
  check(silent.metrics.gainDb === 0, "silence is not normalised");
}

/* ── 7 · WAV container ─────────────────────────────────────────────────── */

{
  const frames = 480;
  const l = new Float32Array(frames).fill(0.5);
  const r = new Float32Array(frames).fill(-0.5);
  const wav = wavBytes(l, r);
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const text = (offset: number, length: number) =>
    String.fromCharCode(...Array.from(wav.slice(offset, offset + length)));
  check(text(0, 4) === "RIFF" && text(8, 4) === "WAVE", "RIFF/WAVE magic");
  check(view.getUint16(20, true) === 1 && view.getUint16(22, true) === 2, "PCM, stereo");
  check(view.getUint32(24, true) === SR, "48 kHz sample rate");
  check(view.getUint16(34, true) === 16, "16-bit samples");
  check(view.getUint32(40, true) === frames * 4, "data chunk size matches the frames");
  check(wav.byteLength === 44 + frames * 4, "file length matches the header");
  check(view.getInt16(44 + 4 * 10, true) === 16384, "positive samples map to PCM");
  check(view.getInt16(44 + 4 * 10 + 2, true) === -16384, "negative samples map to PCM");
  check(outputName("mix.mp3") === "mix.normalized.wav", "output names are derived");
  check(outputName("no-extension") === "no-extension.normalized.wav", "extension-less names keep their stem");
}

console.log(`\n${passed} checks passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
