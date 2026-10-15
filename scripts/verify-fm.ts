/**
 * Numeric verification of the FM/MPX branch — pure DSP, no browser APIs.
 *
 *   bun scripts/verify-fm.ts
 *
 * Checks, in order:
 *   1  pre/de-emphasis constants (50/75 µs corner and boost curves)
 *   2  emphasis FIR measured through the full chain vs the ideal boost
 *   3  15 kHz brick-wall: flat passband, shaped transition, stopband depth
 *   4  interpolator gain (polyphase branch sums → unity per branch) and
 *      first-image rejection of the ×4 zero-stuff upsampler
 *   5  polyphase block phase continuity (guards the time-reflection bug)
 *   6  pilot level / spectral placement, mono flag gating
 *   7  stereo matrix allocation (L+R / L−R, DSB-SC sidebands, carrier
 *      suppression) — the 45/45 % split, √2 headroom accounting
 *   8  deviation metering, overmodulation clipper, sustained-over alarm
 *   9  RDS CRC-10 cross-checked against an independent implementation,
 *      offset-word syndromes, group framing / PS assembly
 *  10  RDS end-to-end: 57 kHz DSB-SC biphase → differential decode →
 *      group codewords → syndromes + PS over the air
 *  11  spectrum occupancy (RDS around 57 kHz, SCA slot, no leakage)
 *  12  hot-noise sweep: finiteness, ceiling hold; 44.1 kHz engine rate
 */
import {
  MpxGenerator,
  RdsBitSource,
  RDS_BIT_RATE,
  emphasisBoostDb,
  emphasisCornerHz,
  rdsBlock,
  spectrumDb,
} from "../src/lib/audio/mpx";
import type { FmParams } from "../src/lib/audio/params";

/* ─────────────────────────── harness ─────────────────────────── */

let passed = 0;
const failures: string[] = [];

function fmt(v: number): string {
  return Number.isFinite(v) ? v.toFixed(4) : String(v);
}
function section(title: string): void {
  console.log(`\n${title}`);
}
function check(name: string, ok: boolean, detail = ""): void {
  const line = `${name}${detail ? ` — ${detail}` : ""}`;
  if (ok) {
    passed += 1;
    console.log(`  ok   ${line}`);
  } else {
    failures.push(line);
    console.log(`  FAIL ${line}`);
  }
}
function near(name: string, actual: number, want: number, tol: number): void {
  check(
    name,
    Number.isFinite(actual) && Math.abs(actual - want) <= tol,
    `got ${fmt(actual)}, want ${fmt(want)} ± ${tol}`,
  );
}
function atMost(name: string, actual: number, max: number): void {
  check(
    name,
    Number.isFinite(actual) && actual <= max,
    `got ${fmt(actual)}, want ≤ ${max}`,
  );
}
function db20(x: number): number {
  return 20 * Math.log10(Math.max(x, 1e-30));
}

/* ───────────────────────── test plumbing ───────────────────────── */

const IN = 48000;
const BLOCK = 4096;

function fmParams(
  mpxPatch: Partial<FmParams["mpx"]> = {},
  patch: Partial<FmParams> = {},
): FmParams {
  return {
    on: true,
    emphasis: "off",
    mpx: {
      on: false,
      pilotPct: 9,
      rdsPct: 0,
      rdsPs: "VERIFYFM",
      scaPct: 0,
      ceilingPct: 110,
      alarmPct: 100,
      ...mpxPatch,
    },
    ...patch,
  };
}

/** Deterministic tone over a half-open sample range (phase-continuous). */
function tone(fs: number, f: number, a: number, start: number, n: number): Float32Array {
  const out = new Float32Array(n);
  const w = (2 * Math.PI * f) / fs;
  for (let i = 0; i < n; i++) out[i] = a * Math.sin(w * (start + i));
  return out;
}

/** Run `count` input blocks, returning the concatenated composite. */
function runBlocks(
  gen: MpxGenerator,
  lr: (start: number) => [Float32Array, Float32Array],
  count: number,
  start = 0,
): Float32Array {
  const chunks: Float32Array[] = [];
  let s = start;
  for (let b = 0; b < count; b++) {
    const [l, r] = lr(s);
    chunks.push(new Float32Array(gen.process(l, r)));
    s += BLOCK;
  }
  const total = chunks.reduce((acc, c) => acc + c.length, 0);
  const out = new Float32Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/** Warm-up block (flushes filter memory), then one phase-continuous measure block. */
function steady(
  gen: MpxGenerator,
  lr: (s: number) => [Float32Array, Float32Array],
): Float32Array {
  runBlocks(gen, lr, 1, 0);
  return runBlocks(gen, lr, 1, BLOCK);
}

function maxAbs(buf: Float32Array): number {
  let m = 0;
  for (const v of buf) m = Math.max(m, Math.abs(v));
  return m;
}

/** Hann-windowed single-bin DFT → tone amplitude at f. */
function amp(buf: Float32Array, f: number, fs: number): number {
  const n = buf.length;
  let re = 0;
  let im = 0;
  let sw = 0;
  const wstep = (2 * Math.PI * f) / fs;
  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    const th = wstep * i;
    re += buf[i] * w * Math.cos(th);
    im -= buf[i] * w * Math.sin(th);
    sw += w;
  }
  return (2 * Math.hypot(re, im)) / sw;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ─────────────── independent reference implementations ─────────────── */

const RDS_POLY = 0b10110111001; // x^10 + x^8 + x^7 + x^5 + x^4 + x^3 + 1

/** Scheme-Y serial CRC-10: top-feedback shift register, no preset/final XOR. */
function crc10Ref(data16: number): number {
  let r = 0;
  const push = (b: number): void => {
    const top = (r >> 9) & 1;
    r = ((r << 1) | b) & 0x3ff;
    if (top) r ^= RDS_POLY & 0x3ff;
  };
  for (let i = 15; i >= 0; i--) push((data16 >> i) & 1);
  for (let i = 0; i < 10; i++) push(0);
  return r;
}

/** Remainder of a 26-bit word mod g(x) — the block syndrome. */
function syndromeRef(word26: number): number {
  let r = 0;
  for (let i = 25; i >= 0; i--) {
    const top = (r >> 9) & 1;
    r = ((r << 1) | ((word26 >> i) & 1)) & 0x3ff;
    if (top) r ^= RDS_POLY & 0x3ff;
  }
  return r;
}

const OFFSETS: Record<string, number> = {
  A: 0x0fc,
  B: 0x198,
  C: 0x168,
  D: 0x1b4,
};

function bitsToNum(bits: number[], from: number, count: number): number {
  let v = 0;
  for (let i = 0; i < count; i++) v = (v << 1) | (bits[from + i] ?? 0);
  return v;
}

/* ═══════════════════════════ 1. emphasis constants ═══════════════════════════ */

section("1 · emphasis constants");
near("75 µs corner", emphasisCornerHz("75"), 2122.066, 0.01);
near("50 µs corner", emphasisCornerHz("50"), 3183.099, 0.01);
near("75 µs boost at corner = 3.01 dB", emphasisBoostDb("75", emphasisCornerHz("75")), 3.0103, 0.001);
near("50 µs boost at corner = 3.01 dB", emphasisBoostDb("50", emphasisCornerHz("50")), 3.0103, 0.001);
near("75 µs boost at 15 kHz", emphasisBoostDb("75", 15000), 17.07, 0.02);
near("50 µs boost at 15 kHz", emphasisBoostDb("50", 15000), 13.66, 0.02);
near("off = flat", emphasisBoostDb("off", 15000), 0, 1e-12);

/* ═══════════════════════════ 2. emphasis through the chain ═══════════════════════════ */

section("2 · emphasis FIR vs ideal boost (measured through the full chain)");
{
  const freqs = [100, 500, 1000, 2000, 5000, 10000, 15000];
  const lr = (f: number, s: number): [Float32Array, Float32Array] =>
    [tone(IN, f, 0.5, s, BLOCK), tone(IN, f, 0.5, s, BLOCK)];
  for (const emph of ["75", "50"] as const) {
    const gen = new MpxGenerator(IN, fmParams({}, { emphasis: emph }), BLOCK);
    for (const f of freqs) {
      const out = steady(gen, (s) => lr(f, s));
      const got = db20(amp(out, f, gen.outRate) / 0.5) - db20(0.9);
      const want = emphasisBoostDb(emph, f);
      const tol = f >= 15000 ? 0.8 : f >= 10000 ? 0.4 : 0.25;
      near(`${emph} µs @ ${f} Hz`, got, want, tol);
    }
  }
  // "off": flat across the band
  const gen = new MpxGenerator(IN, fmParams(), BLOCK);
  for (const f of [100, 1000, 10000, 15000]) {
    const out = runBlocks(
      gen,
      (s) => [tone(IN, f, 0.5, s, BLOCK), tone(IN, f, 0.5, s, BLOCK)],
      2,
    );
    const measured = out.subarray(BLOCK * 4);
    const got = db20(amp(measured, f, gen.outRate) / 0.5) - db20(0.9);
    near(`off @ ${f} Hz`, got, 0, f >= 15000 ? 0.5 : 0.15);
  }
  // setParams switches the response without rebuilding the generator
  const sw = new MpxGenerator(IN, fmParams(), BLOCK);
  const before = runBlocks(sw, (s) => [tone(IN, 10000, 0.5, s, BLOCK), tone(IN, 10000, 0.5, s, BLOCK)], 2);
  const flat = db20(amp(before.subarray(BLOCK * 4), 10000, sw.outRate) / 0.5) - db20(0.9);
  near("switch: flat before setParams", flat, 0, 0.15);
  sw.setParams(fmParams({}, { emphasis: "75" }));
  const after = runBlocks(sw, (s) => [tone(IN, 10000, 0.5, s, BLOCK), tone(IN, 10000, 0.5, s, BLOCK)], 2);
  const boosted = db20(amp(after.subarray(BLOCK * 4), 10000, sw.outRate) / 0.5) - db20(0.9);
  near("switch: +13.65 dB after setParams(75)", boosted, emphasisBoostDb("75", 10000), 0.4);
}

/* ═══════════════════════════ 3. brick-wall ═══════════════════════════ */

section("3 · 15 kHz brick-wall (emphasis off: transition shape only)");
{
  const gen = new MpxGenerator(IN, fmParams(), BLOCK);
  const measure = (f: number): number => {
    const out = runBlocks(
      gen,
      (s) => [tone(IN, f, 0.5, s, BLOCK), tone(IN, f, 0.5, s, BLOCK)],
      2,
    );
    return db20(amp(out.subarray(BLOCK * 4), f, gen.outRate) / 0.5) - db20(0.9);
  };
  near("passband flat @ 10 kHz", measure(10000), 0, 0.15);
  near("transition midpoint @ 16.5 kHz ≈ −6 dB", measure(16500), db20(0.5), 2.5);
  atMost("transition edge @ 18 kHz", measure(18000), -55);
  atMost("stopband @ 19.5 kHz", measure(19500), -60);
  atMost("stopband @ 21 kHz", measure(21000), -65);
  atMost("stopband @ 23 kHz", measure(23000), -65);
}

/* ═══════════════════════════ 4. interpolator gain + images ═══════════════════════════ */

section("4 · ×4 interpolator: DC/level gain and first-image rejection");
{
  const gen = new MpxGenerator(IN, fmParams(), BLOCK);
  // DC: each polyphase branch must sum to 1 → unity through the upsampler
  const dcL = new Float32Array(BLOCK).fill(0.5);
  runBlocks(gen, () => [dcL, dcL], 3);
  const dcOut = runBlocks(gen, () => [dcL, dcL], 1);
  const warm = Math.floor(gen.outRate * 0.002); // drop FIR/interp transient
  let mean = 0;
  for (let i = warm; i < dcOut.length; i++) mean += dcOut[i];
  mean /= dcOut.length - warm;
  near("DC through the chain = 0.9 × 0.5", mean, 0.45, 0.01);

  // AC level at 1 kHz (regression: branch-sum bug gave −12 dB here)
  const gen2 = new MpxGenerator(IN, fmParams(), BLOCK);
  const lvl = steady(gen2, (s) => [tone(IN, 1000, 0.5, s, BLOCK), tone(IN, 1000, 0.5, s, BLOCK)]);
  const lvlDb = db20(amp(lvl, 1000, gen2.outRate) / 0.5);
  near("1 kHz level = 0.9 × A (±0.2 dB)", lvlDb, db20(0.9), 0.2);

  // images of a 10 kHz tone at 48k±10k must be deep in the stopband
  const gen3 = new MpxGenerator(IN, fmParams(), BLOCK);
  const img = steady(gen3, (s) => [tone(IN, 10000, 0.5, s, BLOCK), tone(IN, 10000, 0.5, s, BLOCK)]);
  const fund = amp(img, 10000, gen3.outRate);
  near("fundamental 10 kHz", db20(fund / 0.5), db20(0.9), 0.2);
  atMost("image @ 38 kHz", db20(amp(img, 38000, gen3.outRate) / fund), -70);
  atMost("image @ 58 kHz", db20(amp(img, 58000, gen3.outRate) / fund), -70);
  atMost("image @ 48 kHz (DC image)", db20(amp(img, 48000, gen3.outRate) / fund), -70);
}

/* ═══════════════════════════ 5. polyphase continuity ═══════════════════════════ */

section("5 · polyphase block phase continuity");
{
  const f = 1000;
  const gen = new MpxGenerator(IN, fmParams(), BLOCK);
  const comp = runBlocks(gen, (s) => [tone(IN, f, 0.5, s, BLOCK), tone(IN, f, 0.5, s, BLOCK)], 6);
  const N = BLOCK * 4; // composite samples per input block
  const theta = (2 * Math.PI * f) / gen.outRate;
  const corr = (b: number): number => {
    let re = 0;
    let im = 0;
    for (let i = 0; i < N; i++) {
      const th = theta * i;
      re += comp[b * N + i] * Math.cos(th);
      im -= comp[b * N + i] * Math.sin(th);
    }
    return Math.atan2(im, re);
  };
  const want = (theta * N) % (2 * Math.PI);
  for (let b = 1; b < 5; b++) {
    const adv = corr(b) - corr(b - 1);
    const wrapped = ((adv % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    const dist = Math.min(
      Math.abs(wrapped - want),
      2 * Math.PI - Math.abs(wrapped - want),
    );
    near(`block ${b} → ${b + 1} phase advance`, dist, 0, 0.02);
  }
}

/* ═══════════════════════════ 6. pilot ═══════════════════════════ */

section("6 · pilot tone: level, frequency placement, mono gating");
{
  const fm = fmParams({ on: true, rdsPct: 0 });
  const gen = new MpxGenerator(IN, fm, BLOCK);
  runBlocks(gen, (s) => [tone(IN, 0, 0, s, BLOCK), tone(IN, 0, 0, s, BLOCK)], 1);
  const sil = runBlocks(gen, (s) => [tone(IN, 0, 0, s, BLOCK), tone(IN, 0, 0, s, BLOCK)], 1);
  near("pilot amplitude = 9 %", amp(sil, 19000, gen.outRate), 0.09, 0.0015);

  const spec = spectrumDb(sil);
  const binHz = gen.outRate / (spec.length * 2);
  near("bin frequency", binHz * 405, 19000, 50);
  let argmax = 0;
  for (let k = 395; k <= 415; k++) if (spec[k] > spec[argmax]) argmax = k;
  check("pilot peak at bin 405 (~19 kHz)", argmax === 405, `argmax=${argmax}`);
  const specAt405 = spec[405];
  const expectDb = db20(0.09) - 0.35; // Hann scallop at 405.33 bins
  near("spectrum bin 405 ≈ −21 dB", specAt405, expectDb, 0.7);

  // param sync without rebuilding: 9 % → 6.5 %
  gen.setParams(fmParams({ on: true, rdsPct: 0, pilotPct: 6.5 }));
  runBlocks(gen, (s) => [tone(IN, 0, 0, s, BLOCK), tone(IN, 0, 0, s, BLOCK)], 1);
  const sil2 = runBlocks(gen, (s) => [tone(IN, 0, 0, s, BLOCK), tone(IN, 0, 0, s, BLOCK)], 1);
  near("setParams: pilot = 6.5 %", amp(sil2, 19000, gen.outRate), 0.065, 0.0015);

  // mono (mpx off): no subcarriers at all
  const mono = new MpxGenerator(IN, fmParams({ on: false }), BLOCK);
  const mo = steady(mono, (s) => [tone(IN, 1000, 0.5, s, BLOCK), tone(IN, 1000, 0.5, s, BLOCK)]);
  const mfund = amp(mo, 1000, mono.outRate);
  atMost("mono: pilot suppressed", db20(amp(mo, 19000, mono.outRate) / mfund), -50);
}

/* ═══════════════════════════ 7. stereo matrix ═══════════════════════════ */

section("7 · stereo matrix: allocation, DSB-SC sidebands, carrier suppression");
{
  // L only → 45 % main + 45 % sub (single-channel full-scale split)
  const genA = new MpxGenerator(IN, fmParams({ on: true, rdsPct: 0 }), BLOCK);
  runBlocks(genA, (s) => [tone(IN, 1000, 1.0, s, BLOCK), tone(IN, 0, 0, s, BLOCK)], 2);
  const a = genA.takeStats();
  near("L only: main = 45 %", a.components.mainPct, 45, 1.5);
  near("L only: sub = 45 %", a.components.subPct, 45, 1.5);
  near("L only: pilot = 9 %", a.components.pilotPct, 9, 0.2);

  // L = R → sum only, no sidebands
  const genB = new MpxGenerator(IN, fmParams({ on: true, rdsPct: 0 }), BLOCK);
  const lr = steady(genB, (s) => [tone(IN, 1000, 0.5, s, BLOCK), tone(IN, 1000, 0.5, s, BLOCK)]);
  const f1k = amp(lr, 1000, genB.outRate);
  near("L = R: main = 90 % × 0.5", genB.takeStats().components.mainPct, 45, 1.5);
  atMost("L = R: no 37 kHz sideband", db20(amp(lr, 37000, genB.outRate) / f1k), -35);
  atMost("L = R: no 39 kHz sideband", db20(amp(lr, 39000, genB.outRate) / f1k), -35);

  // L = −R → difference only, DSB-SC at 38 ± 1 kHz, suppressed carrier
  const genC = new MpxGenerator(IN, fmParams({ on: true, rdsPct: 0 }), BLOCK);
  const d = steady(genC, (s) => [tone(IN, 1000, 0.5, s, BLOCK), tone(IN, 1000, -0.5, s, BLOCK)]);
  const side = 0.9 * 0.5 * 0.5; // 0.9 × S(=0.5 A) × ½ per sideband
  near("L = −R: lower sideband 37 kHz", amp(d, 37000, genC.outRate), side, side * 0.05);
  near("L = −R: upper sideband 39 kHz", amp(d, 39000, genC.outRate), side, side * 0.05);
  atMost("L = −R: carrier 38 kHz suppressed", db20(amp(d, 38000, genC.outRate) / side), -40);
  atMost("L = −R: no 1 kHz sum term", db20(amp(d, 1000, genC.outRate) / side), -40);
  const st = genC.takeStats();
  near("L = −R: main ≈ 0", st.components.mainPct, 0, 1);
  near("L = −R: sub = 45 %", st.components.subPct, 45, 1.5);
}

/* ═══════════════════════════ 8. deviation / clip / alarm ═══════════════════════════ */

section("8 · deviation metering, clipper, sustained-over alarm");
{
  // default FM params (75 µs): loud-but-legal tone → no clipping
  const fm = fmParams(
    { on: true, rdsPct: 3.3, scaPct: 0, ceilingPct: 100, alarmPct: 100 },
    { emphasis: "75" },
  );
  const gen = new MpxGenerator(IN, fm, BLOCK);
  const hot = (s: number): [Float32Array, Float32Array] =>
    [tone(IN, 1000, 0.8, s, BLOCK), tone(IN, 1000, 0.8, s, BLOCK)];
  const comp = steady(gen, hot);
  const legal = gen.takeStats();
  check("legal tone: no clip", legal.clipPct === 0, `clip=${legal.clipPct.toFixed(2)}%`);
  check(
    "legal tone: mod peak 75–97 %",
    legal.modPct >= 75 && legal.modPct <= 97,
    `mod=${legal.modPct.toFixed(1)}%`,
  );
  near("main deviation ≈ 79.6 % (90 × 1.105 boost × 0.8)", legal.components.mainPct, 79.6, 3);
  near("pilot deviation = 9 %", legal.components.pilotPct, 9, 0.2);
  near("rds deviation = 3.3 %", legal.components.rdsPct, 3.3, 0.15);
  check("composite finite", comp.every((v) => Number.isFinite(v)));

  // 1.6 A drive → overmodulation: clipped to the ceiling, clip % counted
  const over = (s: number): [Float32Array, Float32Array] =>
    [tone(IN, 1000, 1.6, s, BLOCK), tone(IN, 1000, 1.6, s, BLOCK)];
  const overComp = steady(gen, over);
  const os = gen.takeStats();
  check("overdrive: mod > 120 %", os.modPct > 120, `mod=${os.modPct.toFixed(1)}%`);
  check("overdrive: clip counted", os.clipPct > 2, `clip=${os.clipPct.toFixed(2)}%`);
  atMost("overdrive: composite held at ceiling", maxAbs(overComp), 1.0 + 1e-6);

  // ceiling at 90 %: peak clamp follows the param
  const g90 = new MpxGenerator(IN, fmParams({ ceilingPct: 90, rdsPct: 0 }), BLOCK);
  const c90 = steady(g90, (s) => [tone(IN, 1000, 1.0, s, BLOCK), tone(IN, 1000, 1.0, s, BLOCK)]);
  atMost("ceiling 90 %: peak ≤ 0.9", maxAbs(c90), 0.9 + 1e-6);

  // sustained-over alarm: over on two ticks 6 s apart trips; silence resets
  const realNow = Date.now;
  let fakeNow = realNow.call(Date);
  Date.now = () => fakeNow;
  try {
    const ga = new MpxGenerator(IN, fm, BLOCK);
    const drive = (a: number) => (s: number): [Float32Array, Float32Array] =>
      [tone(IN, 1000, a, s, BLOCK), tone(IN, 1000, a, s, BLOCK)];
    runBlocks(ga, drive(1.6), 1);
    const s1 = ga.takeStats();
    check("alarm: not sustained on first over-tick", !s1.sustainedOver);
    runBlocks(ga, drive(1.6), 1);
    fakeNow += 6000;
    const s2 = ga.takeStats();
    check("alarm: sustained after 6 s of overmodulation", s2.sustainedOver);
    runBlocks(ga, drive(0), 1);
    const s3 = ga.takeStats();
    check(
      "alarm: clears when back in range",
      !s3.sustainedOver,
      `sustained=${s3.sustainedOver} mod=${s3.modPct.toFixed(1)}%`,
    );
  } finally {
    Date.now = realNow;
  }
}

/* ═══════════════════════════ 9. RDS CRC + framing ═══════════════════════════ */

section("9 · RDS CRC-10 (independent cross-check) and group framing");
{
  check("generator polynomial literal", RDS_POLY === 0x5b9, `0b${RDS_POLY.toString(2)}`);
  const rnd = mulberry32(0x5bd1);
  const samples: number[] = [0, 1, 0x1234, 0xffff, 0x8000, 0x0fc, 0x0001, 0xaaaa, 0x5555];
  for (let i = 0; i < 3000; i++) samples.push((rnd() * 65536) | 0);

  let crcMismatch = -1;
  let syndromeBad = -1;
  const offsets = Object.values(OFFSETS);
  for (const d of samples) {
    const lib = rdsBlock(d, 0) & 0x3ff;
    const ref = crc10Ref(d);
    if (crcMismatch < 0 && lib !== ref) crcMismatch = d;
    for (const off of offsets) {
      const syn = syndromeRef(rdsBlock(d, off));
      if (syn !== off) {
        syndromeBad = d * 16 + off;
        break;
      }
    }
  }
  console.log(`    [debug] crcMismatch=${crcMismatch} syndromeBad=${syndromeBad} samples=${samples.length}`);
  check(
    "library CRC-10 ≡ independent serial CRC (4000+ words)",
    crcMismatch < 0,
    crcMismatch >= 0 ? `first mismatch data=0x${crcMismatch.toString(16)}` : "",
  );
  check(
    "codeword syndromes equal their offset words",
    syndromeBad < 0,
    syndromeBad >= 0 ? `bad at ${syndromeBad}` : "",
  );

  // group framing: 4-group PS assembly, block fields, DI segment walk
  const ps = "TESTFM  ";
  const src = new RdsBitSource(0x1234, ps, 10, 0);
  let framingOk = true;
  let detail = "";
  for (let seg = 0; seg < 4 && framingOk; seg++) {
    const bits: number[] = [];
    for (let i = 0; i < 104; i++) bits.push(src.next());
    const wA = bitsToNum(bits, 0, 26);
    const wB = bitsToNum(bits, 26, 26);
    const wC = bitsToNum(bits, 52, 26);
    const wD = bitsToNum(bits, 78, 26);
    const dataA = wA >>> 10;
    const dataB = wB >>> 10;
    const dataC = wC >>> 10;
    const dataD = wD >>> 10;
    const ok =
      syndromeRef(wA) === OFFSETS.A &&
      syndromeRef(wB) === OFFSETS.B &&
      syndromeRef(wC) === OFFSETS.C &&
      syndromeRef(wD) === OFFSETS.D &&
      dataA === 0x1234 &&
      dataB >>> 12 === 0 &&
      ((dataB >>> 10) & 1) === 0 &&
      ((dataB >>> 5) & 0x1f) === 10 &&
      ((dataB >>> 3) & 1) === 1 &&
      ((dataB >>> 2) & 1) === ((8 >> seg) & 1) &&
      (dataB & 3) === seg &&
      dataC === 0xdce8 &&
      dataD === ((ps.charCodeAt(2 * seg) << 8) | ps.charCodeAt(2 * seg + 1));
    if (!ok) {
      framingOk = false;
      detail = `seg ${seg}: A=${dataA.toString(16)} B=${dataB.toString(16)} C=${dataC.toString(16)} D=${dataD.toString(16)}`;
    }
  }
  check("4-group framing + PS assembly", framingOk, detail);

  // mid-stream PS change lands in the next group
  src.setPs("NEWSVC  ");
  const bits: number[] = [];
  for (let i = 0; i < 104; i++) bits.push(src.next());
  const wD = bitsToNum(bits, 78, 26);
  const segNow = bitsToNum(bits, 26, 26) & 3;
  const want = (psChars: string, seg: number): number =>
    (psChars.charCodeAt(2 * seg) << 8) | psChars.charCodeAt(2 * seg + 1);
  near(
    "setPs: next group carries new characters",
    wD >>> 10,
    want("NEWSVC  ", segNow),
    0,
  );
}

/* ═══════════════════════════ 10. RDS end-to-end ═══════════════════════════ */

section("10 · RDS end-to-end: 57 kHz baseband → bits → groups");
{
  const ps = "VERIFYFM";
  const fm = fmParams(
    { on: true, rdsPct: 3.3, rdsPs: ps, pilotPct: 9, scaPct: 0 },
    { emphasis: "off" },
  );
  const gen = new MpxGenerator(IN, fm, BLOCK);
  const comp = runBlocks(gen, (s) => [tone(IN, 0, 0, s, BLOCK), tone(IN, 0, 0, s, BLOCK)], 4);
  const n = comp.length;
  const outRate = gen.outRate;
  const wP = (2 * Math.PI * 19000) / outRate;

  // synchronous detector: y[n] = comp[n] · sin(3φ_n), φ_n = (n+1)·wP mod 2π
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const phi = ((i + 1) * wP) % (2 * Math.PI);
    const s1 = Math.sin(phi);
    y[i] = comp[i] * (s1 * (3 - 4 * s1 * s1));
  }

  const halfAdv = (2 * RDS_BIT_RATE) / outRate; // half-bit crossing rate
  const boundary = (m: number): number => Math.ceil(m / halfAdv) - 1;

  // expected bit stream from an independent source with identical params
  const expected: number[] = [];
  const ref = new RdsBitSource(0x1234, ps);
  for (let i = 0; i < 320; i++) expected.push(ref.next());

  const mean = (a: number, b: number, shift: number): number => {
    const lo = a + shift;
    const hi = b + shift;
    if (lo < 0 || hi > n) return NaN;
    let acc = 0;
    for (let i = lo; i < hi; i++) acc += y[i];
    return acc / (hi - lo);
  };

  // search the biphase boundary alignment (shaper group delay + parity)
  let bestShift = 0;
  let bestAcc = 0;
  for (let shift = -170; shift <= 170; shift++) {
    let hit = 0;
    let seen = 0;
    let cPrev = 0;
    for (let k = 0; k < expected.length; k++) {
      const v1 = mean(boundary(2 * k + 1), boundary(2 * k + 2), shift);
      if (Number.isNaN(v1)) break;
      const c = v1 > 0 ? 0 : 1;
      const bit = c ^ cPrev;
      cPrev = c;
      seen += 1;
      if (bit === expected[k]) hit += 1;
    }
    const acc = seen > 300 ? hit / seen : 0;
    if (acc > bestAcc) {
      bestAcc = acc;
      bestShift = shift;
    }
  }
  check(
    "decoded bits match the source stream (≥ 98 %)",
    bestAcc >= 0.98,
    `accuracy=${(bestAcc * 100).toFixed(1)}% at shift=${bestShift}`,
  );

  // decode the best alignment again, keeping the bits + biphase integrity
  const decoded: number[] = [];
  let cPrev = 0;
  let anti = 0;
  let pairs = 0;
  for (let k = 0; decoded.length < 312; k++) {
    const v1 = mean(boundary(2 * k + 1), boundary(2 * k + 2), bestShift);
    const v2 = mean(boundary(2 * k + 2), boundary(2 * k + 3), bestShift);
    if (Number.isNaN(v1) || Number.isNaN(v2)) break;
    const c = v1 > 0 ? 0 : 1;
    decoded.push(c ^ cPrev);
    cPrev = c;
    pairs += 1;
    if (v1 * v2 > 0) anti += 1;
  }
  check(
    "half-bit pairs are anti-polar (biphase)",
    pairs > 0 && anti / pairs < 0.05,
    `${anti}/${pairs} violations`,
  );

  // groups from the decoded bits must carry valid offset-word syndromes
  const groups = Math.floor(decoded.length / 104);
  check("decoded at least 3 groups", groups >= 3, `${groups} groups`);
  let synOk = 0;
  let synBad = 0;
  let psOk = 0;
  let psBad = 0;
  let piOk = 0;
  const names = ["A", "B", "C", "D"] as const;
  for (let g = 0; g < groups; g++) {
    for (let bi = 0; bi < 4; bi++) {
      const word = bitsToNum(decoded, g * 104 + bi * 26, 26);
      if (syndromeRef(word) === OFFSETS[names[bi]]) synOk += 1;
      else synBad += 1;
    }
    const wA = bitsToNum(decoded, g * 104, 26);
    const wD = bitsToNum(decoded, g * 104 + 78, 26);
    const seg = bitsToNum(decoded, g * 104 + 26, 26) & 3;
    if ((wA >>> 10) === 0x1234) piOk += 1;
    const chars = String.fromCharCode((wD >>> 18) & 0xff, (wD >>> 10) & 0xff);
    const wantStr = ps.slice(2 * seg, 2 * seg + 2);
    if (chars === wantStr) psOk += 1;
    else psBad += 1;
  }
  check(
    "every decoded block syndrome matches its offset word",
    synBad === 0 && synOk >= 12,
    `${synOk} ok / ${synBad} bad`,
  );
  check(
    "decoded PI = 0x1234 in all groups",
    piOk === groups,
    `${piOk}/${groups}`,
  );
  check(
    "decoded PS characters round-trip",
    psOk >= groups - 1 && psBad <= 1,
    `${psOk}/${groups} segments`,
  );
}

/* ═══════════════════════════ 11. spectrum occupancy ═══════════════════════════ */

section("11 · spectrum occupancy: RDS at 57 kHz, SCA slot");
{
  const fm = fmParams(
    { on: true, rdsPct: 3.3, scaPct: 0, pilotPct: 9 },
    { emphasis: "off" },
  );
  const gen = new MpxGenerator(IN, fm, BLOCK);
  runBlocks(gen, (s) => [tone(IN, 0, 0, s, BLOCK), tone(IN, 0, 0, s, BLOCK)], 2);
  const sil = runBlocks(gen, (s) => [tone(IN, 0, 0, s, BLOCK), tone(IN, 0, 0, s, BLOCK)], 1);
  const spec = spectrumDb(sil);
  const binHz = gen.outRate / (spec.length * 2);
  const bins = (loHz: number, hiHz: number): [number, number] =>
    [Math.ceil(loHz / binHz), Math.floor(hiHz / binHz)];

  const [r0, r1] = bins(54600, 59400); // RDS band ±2.4 kHz
  let rdsPeak = -Infinity;
  for (let k = r0; k <= r1; k++) rdsPeak = Math.max(rdsPeak, spec[k]);
  check("RDS energy present around 57 kHz", rdsPeak >= -50, `peak=${rdsPeak.toFixed(1)} dB`);

  const [s0, s1] = bins(62000, 72000); // SCA slot, sca = 0
  let scaBand = -Infinity;
  for (let k = s0; k <= s1; k++) scaBand = Math.max(scaBand, spec[k]);
  check(
    "no leakage into the SCA slot",
    scaBand <= rdsPeak - 8,
    `scaBand=${scaBand.toFixed(1)} dB`,
  );

  // with SCA on, an unmodulated 67 kHz subcarrier appears at −23 dB
  gen.setParams(fmParams({ on: true, rdsPct: 3.3, scaPct: 7, pilotPct: 9 }, { emphasis: "off" }));
  runBlocks(gen, (s) => [tone(IN, 0, 0, s, BLOCK), tone(IN, 0, 0, s, BLOCK)], 1);
  const withSca = runBlocks(gen, (s) => [tone(IN, 0, 0, s, BLOCK), tone(IN, 0, 0, s, BLOCK)], 1);
  const spec2 = spectrumDb(withSca);
  const scaBin = Math.round(67000 / binHz);
  const scaDb = spec2[scaBin];
  const scaWant = db20(0.07); // 7 % → −23.1 dB (≤ 1.5 dB scallop)
  near("SCA 67 kHz bin level", scaDb, scaWant, 2.5);
  check(
    "SCA injection raises its slot ≥ 8 dB",
    Number.isFinite(scaDb) && scaDb >= scaBand + 8,
    `now=${Number.isFinite(scaDb) ? scaDb.toFixed(1) : "?"} dB, was=${Number.isFinite(scaBand) ? scaBand.toFixed(1) : "?"} dB`,
  );
  const scaStats = gen.takeStats();
  near("SCA deviation reported", scaStats.components.scaPct, 7, 0.5);
}

/* ═══════════════════════════ 12. robustness ═══════════════════════════ */

section("12 · hot-noise sweep and 44.1 kHz engine rate");
{
  const rnd = mulberry32(0xf00d);
  const gen = new MpxGenerator(
    IN,
    fmParams(
      { on: true, rdsPct: 3.3, scaPct: 7, ceilingPct: 100, alarmPct: 100 },
      { emphasis: "75" },
    ),
    BLOCK,
  );
  let finite = true;
  let peak = 0;
  for (let b = 0; b < 6; b++) {
    const l = new Float32Array(BLOCK);
    const r = new Float32Array(BLOCK);
    for (let i = 0; i < BLOCK; i++) {
      l[i] = (rnd() * 2 - 1) * 1.2;
      r[i] = (rnd() * 2 - 1) * 1.2;
    }
    const out = gen.process(l, r);
    for (const v of out) {
      if (!Number.isFinite(v)) finite = false;
      peak = Math.max(peak, Math.abs(v));
    }
  }
  check("all composite samples finite under hot noise", finite);
  atMost("ceiling holds under hot noise", peak, 1.0 + 1e-6);
  const st = gen.takeStats();
  check(
    "metering finite under hot noise",
    [st.modPct, st.clipPct, st.components.mainPct, st.components.subPct].every((v) =>
      Number.isFinite(v),
    ),
  );
  check("overmodulation detected under hot noise", st.modPct >= 100, `mod=${st.modPct.toFixed(1)}%`);
  check("clipper engaged under hot noise", st.clipPct > 0, `clip=${st.clipPct.toFixed(1)}%`);

  // 44.1 kHz engine: ×4 → 176.4 kHz composite
  const g44 = new MpxGenerator(44100, fmParams({ on: true, rdsPct: 0 }), BLOCK);
  const o44 = steady(g44, (s) => [tone(44100, 1000, 0.5, s, BLOCK), tone(44100, 1000, 0.5, s, BLOCK)]);
  near("44.1k: outRate = 176400", g44.outRate, 176400, 0);
  near("44.1k: 1 kHz level", db20(amp(o44, 1000, g44.outRate) / 0.5), db20(0.9), 0.25);
  near("44.1k: pilot level", amp(o44, 19000, g44.outRate), 0.09, 0.0015);
}

/* ─────────────────────────── summary ─────────────────────────── */

console.log(`\n${passed} checks passed, ${failures.length} failed.`);
if (failures.length > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
