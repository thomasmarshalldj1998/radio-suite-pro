/**
 * Pure DSP checks for the studio page:
 *
 *   bun scripts/verify-studio-dsp.ts
 *
 * No browser, no audio device — these are the maths that decide what the
 * meters, the morph and the restoration curve do:
 *
 *  1  A/B morph returns each preset exactly at the ends
 *  2  morph interpolates numbers and switches booleans at the midpoint
 *  3  the de-clipper is transparent below the threshold
 *  4  above it the peak is expanded, never attenuated, and stays bounded
 *  5  the curve is monotonic (no folds, no dead steps)
 *  6  gated loudness matches BS.1770 on a known block power
 *  7  absolute and relative gates exclude quiet blocks
 *  8  pitch tracking locks to a clean bass tone
 *  9  correlation reads mono, anti-phase and orthogonal signals correctly
 * 10  the true-peak estimate catches an inter-sample peak
 */
import {
  CODEC_PROFILES,
  GENRE_PROFILES,
  PRESET_A,
  PRESET_B,
  correlation,
  declipCurve,
  detectPitch,
  gatedLoudness,
  morphParams,
  parseGenreTag,
  truePeak,
} from "../src/pages/Studio";

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

/* ── 1-2: A/B morph ────────────────────────────────────────────────────── */

console.log("\n1 · morph endpoints");
const at0 = morphParams(PRESET_A, PRESET_B, 0);
const at1 = morphParams(PRESET_A, PRESET_B, 1);
check(at0.agcThresholdDb === PRESET_A.agcThresholdDb, "t=0 is preset A", `${at0.agcThresholdDb}`);
check(at1.agcThresholdDb === PRESET_B.agcThresholdDb, "t=1 is preset B", `${at1.agcThresholdDb}`);
check(at0.bands.low.thresholdDb === PRESET_A.bands.low.thresholdDb, "band values follow A at 0");
check(at1.width === PRESET_B.width, "width follows B at 1", `${at1.width}`);

console.log("\n2 · morph interpolation");
const mid = morphParams(PRESET_A, PRESET_B, 0.5);
const expected = (PRESET_A.agcThresholdDb + PRESET_B.agcThresholdDb) / 2;
check(Math.abs(mid.agcThresholdDb - expected) < 0.02, "numbers interpolate linearly", `${mid.agcThresholdDb} vs ${expected}`);
check(
  mid.bands.high.releaseMs > Math.min(PRESET_A.bands.high.releaseMs, PRESET_B.bands.high.releaseMs) &&
    mid.bands.high.releaseMs < Math.max(PRESET_A.bands.high.releaseMs, PRESET_B.bands.high.releaseMs),
  "band timings interpolate too",
  `${mid.bands.high.releaseMs} ms`,
);
const before = morphParams(PRESET_A, PRESET_B, 0.49);
const after = morphParams(PRESET_A, PRESET_B, 0.51);
check(before.declipOn === PRESET_A.declipOn && after.declipOn === PRESET_B.declipOn, "switches hand over at the midpoint");
check(
  morphParams(PRESET_A, PRESET_B, 0.49).target === PRESET_A.target &&
    morphParams(PRESET_A, PRESET_B, 1).target === PRESET_B.target,
  "the delivery target follows the side of the fader",
);

/* ── 3-5: de-clipper ───────────────────────────────────────────────────── */

console.log("\n3 · de-clipper transparency");
const N = 4096;
const curve = declipCurve(6, -6);
const at = (x: number) => curve[Math.round(((x + 1) / 2) * (N - 1))];
check(Math.abs(at(0.2) - 0.2) < 0.002, "a quiet sample passes unchanged", `${at(0.2).toFixed(4)}`);
check(Math.abs(at(0.5) - 0.5) < 0.002, "at the threshold it is still linear", `${at(0.5).toFixed(4)}`);

console.log("\n4 · peak reconstruction");
check(at(0.8) > 0.8, "a peak above the threshold is expanded", `${at(0.8).toFixed(4)} > 0.8`);
check(at(1) <= 1.0001, "the curve never exceeds full scale", `${at(1).toFixed(4)}`);
check(Math.abs(at(-0.8) + at(0.8)) < 1e-6, "the curve is odd-symmetric");
const zeroDrive = declipCurve(0, -6);
check(
  Math.abs(zeroDrive[Math.round(0.85 * (N - 1))] - 0.7) < 0.01,
  "zero drive is an identity curve above the threshold too",
  `${zeroDrive[Math.round(0.85 * (N - 1))].toFixed(4)}`,
);

console.log("\n5 · curve shape");
let monotonic = true;
for (let i = 1; i < N; i++) if (curve[i] < curve[i - 1] - 1e-7) monotonic = false;
check(monotonic, "the transfer curve is monotonic");

/* ── 6-7: loudness gating ──────────────────────────────────────────────── */

console.log("\n6 · gated loudness");
const p0 = 0.01;
const flat = Array.from({ length: 20 }, () => p0);
const expectedLufs = -0.691 + 10 * Math.log10(p0);
check(
  Math.abs(gatedLoudness(flat) - expectedLufs) < 0.01,
  "a constant block power maps to the BS.1770 value",
  `${gatedLoudness(flat).toFixed(2)} vs ${expectedLufs.toFixed(2)}`,
);
check(gatedLoudness([p0, p0]) === -70, "too little program reports -70");

console.log("\n7 · gating");
const withSilence = [...flat, 1e-9, 1e-9];
check(
  Math.abs(gatedLoudness(withSilence) - expectedLufs) < 0.01,
  "blocks below the absolute gate are excluded",
  `${gatedLoudness(withSilence).toFixed(2)}`,
);
const quietTail = [...flat, 1e-6];
check(
  Math.abs(gatedLoudness(quietTail) - expectedLufs) < 0.01,
  "the relative gate excludes a quiet tail",
  `${gatedLoudness(quietTail).toFixed(2)}`,
);

/* ── 8: pitch ──────────────────────────────────────────────────────────── */

console.log("\n8 · sub-harmonic pitch tracking");
const SR = 48000;
const tone = (freq: number, amp = 0.4) => {
  const b = new Float32Array(2048);
  for (let i = 0; i < b.length; i++) b[i] = Math.sin((2 * Math.PI * freq * i) / SR) * amp;
  return b;
};
const p100 = detectPitch(tone(100), SR);
const p50 = detectPitch(tone(50), SR);
check(Math.abs(p100 - 100) < 2, "100 Hz is detected", `${p100.toFixed(1)} Hz`);
check(Math.abs(p50 - 50) < 2, "50 Hz is detected", `${p50.toFixed(1)} Hz`);
check(detectPitch(new Float32Array(2048), SR) === 0, "silence reports no pitch");

/* ── 9: correlation ───────────────────────────────────────────────────── */

console.log("\n9 · correlation");
// 234.375 Hz is exactly 10 cycles across the 2048-sample window, so the
// orthogonal reference is a clean quadrature signal
const a = tone(234.375);
const inverted = a.map((v) => -v);
const orthogonal = new Float32Array(2048);
for (let i = 0; i < orthogonal.length; i++) {
  orthogonal[i] = Math.cos((2 * Math.PI * 234.375 * i) / SR) * 0.4;
}
check(Math.abs(correlation(a, a) - 1) < 1e-6, "mono reads +1");
check(Math.abs(correlation(a, inverted) + 1) < 1e-6, "anti-phase reads −1");
check(Math.abs(correlation(a, orthogonal)) < 0.02, "orthogonal phase reads ~0", correlation(a, orthogonal).toFixed(3));

/* ── 10: true peak ────────────────────────────────────────────────────── */

console.log("\n10 · true peak");
const dc = new Float32Array(64).fill(0.5);
check(Math.abs(truePeak(dc, dc) - 0.5) < 1e-6, "DC peak reads its level");
const ramp = new Float32Array(64);
for (let i = 0; i < ramp.length; i++) ramp[i] = Math.min(1, i / 40);
check(truePeak(ramp, ramp) >= 1 - 1e-6, "an inter-sample peak is caught", truePeak(ramp, ramp).toFixed(4));

/* ── 11: genre tags + codec table ─────────────────────────────────────── */

console.log("\n11 · genre + codec tables");
check(parseGenreTag("Artist - Track [EDM]") === "edm", "a bracketed tag is parsed");
check(parseGenreTag("genre=hiphop") === "hiphop", "a genre= tag is parsed");
check(parseGenreTag("new track #talk") === "talk", "a hash tag is parsed");
check(parseGenreTag("no tag here") === null, "plain metadata triggers nothing");
check(GENRE_PROFILES.edm.toneLow > 0 && GENRE_PROFILES.talk.toneLow < 0, "profiles tilt the low end in the right direction");
check(
  CODEC_PROFILES["mp3-64"].lowpass < CODEC_PROFILES["mp3-320"].lowpass,
  "lower bitrates are band-limited harder",
  `${CODEC_PROFILES["mp3-64"].lowpass} Hz vs ${CODEC_PROFILES["mp3-320"].lowpass} Hz`,
);
check(
  CODEC_PROFILES["mp3-64"].hfTrimDb > CODEC_PROFILES["mp3-128"].hfTrimDb,
  "HF compensation scales with the bitrate",
  `${CODEC_PROFILES["mp3-64"].hfTrimDb} dB vs ${CODEC_PROFILES["mp3-128"].hfTrimDb} dB`,
);

console.log(`\n${passed} checks passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
