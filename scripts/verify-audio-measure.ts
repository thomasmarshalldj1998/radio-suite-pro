/**
 * Measurement + device-listing maths for the console engine:
 *
 *   bun scripts/verify-audio-measure.ts
 *
 * These are the numbers the whole console reports (peaks, true peak, LUFS,
 * LRA) and the rules that decide whether a saved device still exists. Both
 * are pure, so they can be pinned exactly without an AudioContext.
 *
 *  1  peak / mean square / correlation
 *  2  true peak finds inter-sample crests
 *  3  loudness windows and their floors
 *  4  gated integrated loudness + LRA
 *  5  device listing: ids, labels, duplicates
 *  6  saved picks survive a hidden list and drop when the device is gone
 *  7  virtual-endpoint + feedback detection
 */
import {
  LoudnessWindow,
  correlationOf,
  gatedIntegrated,
  loudnessOf,
  loudnessRange,
  meanSquare,
  peakDb,
  peakOf,
  toDb,
  truePeak,
} from "../src/lib/audio/measure";
import {
  EMPTY_PREFS,
  isFeedbackLoop,
  isVirtualDevice,
  listDevices,
  parsePrefs,
  reconcileSelection,
  serializePrefs,
} from "../src/lib/audio/devices";

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

const near = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) <= tol;
const dbfs = (v: number) => 20 * Math.log10(v);

function sine(amp: number, freq: number, phase = 0, n = 4096, fs = 48000) {
  const buf = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    buf[i] = amp * Math.sin((2 * Math.PI * freq * i) / fs + phase);
  }
  return buf;
}

/* ── 1 · peaks, power, correlation ─────────────────────────────────────── */

console.log("\n1 · peak, power, correlation");
{
  const half = sine(0.5, 997);
  check(near(peakOf(half), 0.5, 0.001), "peak finds the amplitude", peakOf(half).toFixed(4));
  check(
    near(peakDb(half), dbfs(0.5), 0.01),
    "peak in dBFS matches the amplitude",
    peakDb(half).toFixed(2),
  );
  check(toDb(0) === -120, "digital silence floors the meter", String(toDb(0)));
  check(toDb(0.5) > -6.1 && toDb(0.5) < -6.0, "−6 dBFS is 0.5 full scale", toDb(0.5).toFixed(2));

  const full = sine(1, 1000);
  check(near(meanSquare(full), 0.5, 0.01), "a full-scale sine has power 0.5", meanSquare(full).toFixed(3));
  check(meanSquare(new Float32Array(512)) === 0, "silence has no power");

  const left = sine(0.3, 440);
  check(near(correlationOf(left, left), 1), "a channel against itself is +1");
  const inverted = Float32Array.from(left, (v) => -v);
  check(near(correlationOf(left, inverted), -1), "an inverted channel is −1");
  const unrelated = sine(0.3, 631, 1.1);
  check(
    Math.abs(correlationOf(left, unrelated)) < 0.2,
    "unrelated programme sits near zero",
    correlationOf(left, unrelated).toFixed(2),
  );
  check(
    correlationOf(new Float32Array(512), new Float32Array(512)) === 1,
    "silence reports mono, not NaN",
  );
}

/* ── 2 · true peak ─────────────────────────────────────────────────────── */

console.log("\n2 · true peak");
{
  const amp = 0.5;
  const expected = dbfs(amp);
  const phases = [0, 0.4, 0.9, 1.4, 2.2].map((p) => truePeak(sine(amp, 997, p)));
  const worst = Math.max(...phases.map((p) => Math.abs(p - expected)));
  check(
    phases.every((p) => p >= expected - 0.05 && p <= expected + 0.35),
    "4× interpolation recovers the crest at every phase",
    `worst ${worst.toFixed(2)} dB off`,
  );

  // fs/4 at 45° puts every sample at 0.707 × the crest: a sample meter
  // under-reads by 3 dB and only interpolation finds the top.
  const miss = sine(amp, 12000, Math.PI / 4);
  const sample = peakDb(miss);
  const tp = truePeak(miss);
  check(sample < expected - 2.5, "the samples really do miss the crest", sample.toFixed(2));
  check(tp > sample + 2, "true peak finds it", `${sample.toFixed(2)} → ${tp.toFixed(2)}`);
  check(Math.abs(tp - expected) < 0.6, "and lands within half a dB", Math.abs(tp - expected).toFixed(2));

  check(truePeak(new Float32Array(2048)) === -120, "silence reads as the meter floor");
  const short = new Float32Array([0, 0.25, -0.25]);
  check(truePeak(short) >= peakDb(short) - 1e-9, "a block shorter than the kernel still reads");
}

/* ── 3 · loudness windows ──────────────────────────────────────────────── */

console.log("\n3 · loudness windows");
{
  check(loudnessOf(0) === -70, "silence floors at −70 LUFS", String(loudnessOf(0)));
  check(near(loudnessOf(1), -0.691, 1e-6), "unity power is −0.691 LUFS", loudnessOf(1).toFixed(3));

  const win = new LoudnessWindow(3200);
  win.push(0, 1);
  win.push(10, 3);
  check(near(win.power(1000, 20), 2), "the window averages its entries", win.power(1000, 20).toFixed(2));
  check(
    near(win.loudness(1000, 20), loudnessOf(2), 1e-9),
    "and converts the average to LUFS",
    win.loudness(1000, 20).toFixed(2),
  );
  win.push(5000, 1);
  check(win.size === 1, "entries older than the span are dropped", `${win.size} kept`);
  win.clear();
  check(win.size === 0 && win.power(3000, 9000) === 0, "clear empties the history");
}

/* ── 4 · gated integrated loudness + LRA ───────────────────────────────── */

console.log("\n4 · gated loudness");
{
  const steady = Array.from({ length: 200 }, () => 0.01);
  check(gatedIntegrated(steady, 5_000) === null, "no integrated figure before 20 s");
  const integrated = gatedIntegrated(steady, 30_000);
  check(
    integrated !== null && near(integrated, loudnessOf(0.01), 0.05),
    "a steady programme integrates to its own loudness",
    integrated?.toFixed(2) ?? "null",
  );

  // A quiet passage must be gated out, so the figure follows the loud part.
  const withGap = [...Array.from({ length: 150 }, () => 0.05), ...Array.from({ length: 50 }, () => 1e-9)];
  const gated = gatedIntegrated(withGap, 30_000);
  check(
    gated !== null && Math.abs(gated - loudnessOf(0.05)) < 0.6,
    "silence is gated out of the integrated figure",
    `${gated?.toFixed(2)} vs ${loudnessOf(0.05).toFixed(2)}`,
  );

  check(loudnessRange(Array.from({ length: 10 }, () => 0.01)) === null, "LRA waits for short-term history");
  const wide = Array.from({ length: 200 }, (_, i) => (i % 2 ? 0.5 : 0.005));
  const lra = loudnessRange(wide);
  check(lra !== null && lra > 10, "a loud/quiet programme has a wide range", `${lra?.toFixed(1)} LU`);
  const flat = loudnessRange(Array.from({ length: 200 }, () => 0.01));
  check(flat !== null && flat < 0.5, "a steady programme has almost no range", `${flat?.toFixed(2)} LU`);
}

/* ── 5 · device listing ────────────────────────────────────────────────── */

console.log("\n5 · device listing");
{
  const listing = listDevices([
    { deviceId: "a", kind: "audioinput", label: "Studio Mic", groupId: "g1" },
    { deviceId: "a", kind: "audioinput", label: "Studio Mic", groupId: "g1" },
    { deviceId: "b", kind: "audioinput", label: "", groupId: "g1" },
    { deviceId: "s1", kind: "audiooutput", label: "Monitors", groupId: "g2" },
    { deviceId: "", kind: "audiooutput", label: "", groupId: "" },
  ]);
  check(listing.inputs.length === 2, "duplicate entries collapse", `${listing.inputs.length} inputs`);
  check(listing.inputs[0].label === "Studio Mic", "labels are kept");
  check(listing.inputs[1].label === "Input 2", "an unlabelled device gets a readable name", listing.inputs[1].label);
  check(listing.outputs.length === 1, "an entry with no id is not selectable");
  check(listing.inputsIdentified && listing.outputsIdentified, "usable ids mark the list identifiable");

  const hidden = listDevices([{ deviceId: "", kind: "audioinput", label: "", groupId: "" }]);
  check(
    hidden.inputs.length === 0 && !hidden.inputsIdentified,
    "a pre-permission list has no usable ids",
  );
  check(hidden.outputs.length === 0 && !hidden.outputsIdentified, "…for either direction");
}

/* ── 6 · saved picks ───────────────────────────────────────────────────── */

console.log("\n6 · saved picks");
{
  const devices = [
    { id: "mic-a", label: "Studio Mic" },
    { id: "mic-b", label: "Guest" },
  ];
  check(reconcileSelection("mic-a", devices, true) === "mic-a", "a present device keeps its pick");
  check(reconcileSelection("mic-gone", devices, true) === "", "a missing device is dropped");
  check(
    reconcileSelection("mic-gone", devices, false) === "mic-gone",
    "a hidden list never wipes the saved rig",
  );
  check(reconcileSelection("", devices, true) === "", "the OS default stays the default");

  const stored = serializePrefs({ input: "mic-a", output: "spk", source: "mic" });
  const parsed = parsePrefs(stored);
  check(
    parsed.input === "mic-a" && parsed.output === "spk" && parsed.source === "mic",
    "prefs round-trip through storage",
  );
  check(parsePrefs("{not json").input === "" && parsePrefs(null).source === "signal", "corrupt prefs fall back to defaults");
  check(parsePrefs(JSON.stringify({ source: "spdif" })).source === "signal", "an unknown source is not trusted");
  check(EMPTY_PREFS.input === "" && EMPTY_PREFS.output === "", "the empty default has no device");
}

/* ── 7 · virtual endpoints + feedback ──────────────────────────────────── */

console.log("\n7 · virtual endpoints");
{
  check(isVirtualDevice("CABLE Input (VB-Audio Virtual Cable)"), "a VB-Cable sink is virtual");
  check(isVirtualDevice("BlackHole 2ch"), "BlackHole is virtual");
  check(!isVirtualDevice("Studio Monitors (Realtek)"), "real speakers are not");
  check(!isVirtualDevice(""), "an empty label is not virtual");

  const cableOut = { id: "in-1", label: "CABLE-A Output", groupId: "cable-a" };
  const sameEndpoint = { id: "out-1", label: "CABLE-A Input", groupId: "cable-a" };
  const realSink = { id: "out-2", label: "Monitors", groupId: "speakers" };
  check(isFeedbackLoop(cableOut, sameEndpoint), "two sides of one cable are a feedback loop");
  check(!isFeedbackLoop(cableOut, realSink), "a real monitor is not");
  check(!isFeedbackLoop(cableOut, { id: "out-3", label: "x" }), "no group id means no claim");
  check(!isFeedbackLoop({ id: "same", label: "a", groupId: "g" }, { id: "same", label: "b", groupId: "g" }), "the same id is not a loop");
}

console.log(`\n${passed} checks passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
