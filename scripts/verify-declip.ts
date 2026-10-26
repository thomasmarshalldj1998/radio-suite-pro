/**
 * Declipper kernel checks.
 *
 *   bun scripts/verify-declip.ts
 *
 * The stage has one job that can be measured: give back the peaks a hard clip
 * removed, without changing anything when it is bypassed. These checks pin:
 *
 *   · bypass is a pure delay — bit-exact, so the stage can stay in circuit
 *     with a constant latency instead of rewiring the graph on every toggle;
 *   · a clipped sine comes out with peaks above the clip point, bounded by
 *     the configured restore ceiling;
 *   · stereo channels are reconstructed independently;
 *   · a reset returns the kernel to silence and clears its meters.
 */
import {
  DECLIP_DELAY,
  DeclipKernel,
  declipWorkletSource,
} from "../src/lib/audio/declip";

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
const BLOCK = 128;
const N = 9600;

/** Run a whole signal through the kernel in render quanta. */
function run(
  kernel: DeclipKernel,
  l: Float32Array,
  r: Float32Array,
  outL: Float32Array,
  outR: Float32Array,
): { peak: number; repair: number; peakRestore: number; finite: boolean } {
  let repair = 0;
  let peakRestore = 0;
  for (let off = 0; off < l.length; off += BLOCK) {
    const len = Math.min(BLOCK, l.length - off);
    const m = kernel.process(
      l.subarray(off, off + len),
      r.subarray(off, off + len),
      outL.subarray(off, off + len),
      outR.subarray(off, off + len),
    );
    repair = Math.max(repair, m.repairPct);
    peakRestore = Math.max(peakRestore, m.peakRestoreDb);
  }
  let peak = 0;
  let finite = true;
  for (let i = 0; i < outL.length; i += 1) {
    if (!Number.isFinite(outL[i]) || !Number.isFinite(outR[i])) finite = false;
    peak = Math.max(peak, Math.abs(outL[i]), Math.abs(outR[i]));
  }
  return { peak, repair, peakRestore, finite };
}

/* ── 1 · bypass is a pure delay ───────────────────────────────────────── */

console.log("\n1 · bypass transparency");
{
  const l = new Float32Array(N);
  const r = new Float32Array(N);
  for (let i = 0; i < N; i += 1) {
    const v = 0.4 * Math.sin((2 * Math.PI * 317 * i) / SR);
    l[i] = v;
    r[i] = v * 0.5;
  }
  const outL = new Float32Array(N);
  const outR = new Float32Array(N);
  const kernel = new DeclipKernel(SR);
  kernel.configure(false, -0.5, 5, 1);
  const result = run(kernel, l, r, outL, outR);

  let maxErr = 0;
  for (let i = DECLIP_DELAY + 10; i < N; i += 1) {
    maxErr = Math.max(
      maxErr,
      Math.abs(outL[i] - l[i - DECLIP_DELAY]),
      Math.abs(outR[i] - r[i - DECLIP_DELAY]),
    );
  }
  check(maxErr === 0, "bypassed output is the input delayed by the declared latency", `max err ${maxErr}`);
  check(DECLIP_DELAY >= 198 && DECLIP_DELAY <= 210, "declared latency is ~4 ms at 48 kHz", `${DECLIP_DELAY} samples`);
  check(result.repair === 0, "a bypassed stage reports no repair");
  check(result.finite, "bypassed output is finite");
}

/* ── 2 · flat tops are reconstructed ──────────────────────────────────── */

console.log("\n2 · flat-top restoration");
{
  const CLIP = 1;
  const AMP = 1.7;
  const l = new Float32Array(N);
  const r = new Float32Array(N);
  let clipped = 0;
  for (let i = 0; i < N; i += 1) {
    const v = AMP * Math.sin((2 * Math.PI * 440 * i) / SR);
    if (Math.abs(v) >= CLIP) clipped += 1;
    l[i] = Math.max(-CLIP, Math.min(CLIP, v));
    r[i] = l[i];
  }
  const outL = new Float32Array(N);
  const outR = new Float32Array(N);
  const kernel = new DeclipKernel(SR);
  kernel.configure(true, -0.5, 6, 1);
  const result = run(kernel, l, r, outL, outR);
  const limit = Math.pow(10, -0.5 / 20) * Math.pow(10, 6 / 20);

  check(clipped > N * 0.1, "test signal really is clipped", `${clipped} of ${N} samples`);
  check(result.peak > 1.01, "reconstructed peaks rise above the clip point", `${result.peak.toFixed(3)}`);
  check(result.peak <= limit + 1e-4, "reconstruction stays under the restore ceiling", `${result.peak.toFixed(3)} ≤ ${limit.toFixed(3)}`);
  check(result.repair > 0, "the kernel reports repair activity", `${result.repair.toFixed(1)} %`);
  check(result.peakRestore > 0.05, "the peak-restore meter moves", `${result.peakRestore.toFixed(2)} dB`);
  check(result.finite, "reconstructed output is finite");
}

/* ── 3 · channels are independent ─────────────────────────────────────── */

console.log("\n3 · stereo independence");
{
  const l = new Float32Array(N);
  const r = new Float32Array(N);
  for (let i = 0; i < N; i += 1) {
    const hot = 1.6 * Math.sin((2 * Math.PI * 220 * i) / SR);
    l[i] = Math.max(-1, Math.min(1, hot));
    r[i] = 0.25 * Math.sin((2 * Math.PI * 660 * i) / SR);
  }
  const outL = new Float32Array(N);
  const outR = new Float32Array(N);
  const kernel = new DeclipKernel(SR);
  kernel.configure(true, -0.5, 6, 1);
  run(kernel, l, r, outL, outR);

  let rightErr = 0;
  for (let i = DECLIP_DELAY + 10; i < N; i += 1) {
    rightErr = Math.max(rightErr, Math.abs(outR[i] - r[i - DECLIP_DELAY]));
  }
  check(rightErr < 1e-6, "an unclipped right channel passes untouched", `max err ${rightErr}`);
}

/* ── 4 · reset ────────────────────────────────────────────────────────── */

console.log("\n4 · reset");
{
  const l = new Float32Array(N).fill(0.5);
  const r = new Float32Array(N).fill(-0.5);
  const outL = new Float32Array(N);
  const outR = new Float32Array(N);
  const kernel = new DeclipKernel(SR);
  kernel.configure(true, -0.5, 6, 1);
  run(kernel, l, r, outL, outR);
  kernel.reset();

  const silenceL = new Float32Array(BLOCK);
  const silenceR = new Float32Array(BLOCK);
  const silenceOutL = new Float32Array(BLOCK);
  const silenceOutR = new Float32Array(BLOCK);
  const meter = kernel.process(silenceL, silenceR, silenceOutL, silenceOutR);
  check(Array.from(silenceOutL).every((v) => v === 0), "reset clears the delay line");
  check(meter.repairPct === 0 && meter.peakRestoreDb === 0, "reset clears the repair meters");
}

/* ── 5 · worklet module ───────────────────────────────────────────────── */

console.log("\n5 · worklet source");
{
  const source = declipWorkletSource();
  check(
    source.includes('registerProcessor("signalpath-declip"'),
    "module registers the declip processor",
  );
  check(source.includes("class SignalpathDeclipProcessor"), "processor class is embedded");
  check(source.includes("this.kernel.process"), "processor runs the verified kernel");
}

console.log(`\n${passed} checks passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
