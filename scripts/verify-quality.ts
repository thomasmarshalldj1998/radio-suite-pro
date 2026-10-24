/**
 * Processing transparency.
 *
 *   bun scripts/verify-quality.ts
 *
 * The chain must not colour programme it is not asked to process. Three
 * concrete failures are pinned here:
 *
 *   · a biquad corner sitting on (or within 4 % of) Nyquist, where the
 *     coefficients blow up — the 22 kHz defaults are only unsafe at 44.1 kHz;
 *   · a "safety" ceiling implemented as `tanh(x)` across the whole range,
 *     which is a compressor and adds harmonic distortion at every level;
 *   · a wet/dry blend between an oversampled shaper and a direct tap, which
 *     combs because the oversampler delays the wet leg.
 *
 * The pure maths is checked directly; the wiring is driven through the real
 * AudioEngine against a stand-in AudioContext. Nothing here claims the result
 * sounds right — only that the transfer is linear where it should be and that
 * the nodes are built the way the maths assumes.
 */
import { AudioEngine } from "../src/lib/audio/engine";
import {
  DEFAULT_PARAMS,
  dbToGain,
  type ProcessorParams,
} from "../src/lib/audio/params";
import { identityCurve, safeFilterHz, softCeilingCurve } from "../src/lib/audio/quality";
import { autoDeessThresholdDb, autoMakeupDb } from "../src/lib/audio/tools";

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

/* ── 1 · Nyquist-safe filter tuning ────────────────────────────────────── */

console.log("\n1 · filter tuning vs Nyquist");
{
  check(safeFilterHz(22000, 48000) === 22000, "22 kHz is left alone at 48 kHz");
  check(
    safeFilterHz(22000, 44100) === 0.9 * 22050,
    "22 kHz folds down to 0.9 × Nyquist at 44.1 kHz",
    `${safeFilterHz(22000, 44100)} Hz`,
  );
  check(safeFilterHz(12000, 44100) === 12000, "a 12 kHz shelf is untouched at 44.1 kHz");
  check(safeFilterHz(16000, 44100) === 16000, "a 16 kHz air shelf is untouched at 44.1 kHz");
  check(safeFilterHz(30000, 48000) === 0.9 * 24000, "above Nyquist folds to the comfort point");
  check(safeFilterHz(22050, 44100) === 0.9 * 22050, "exactly Nyquist is folded too");
  check(safeFilterHz(Number.NaN, 48000) === 20, "a missing corner gets a sane floor");
  check(safeFilterHz(80, Number.NaN) === 80, "a missing sample rate assumes 48 kHz");
  check(
    safeFilterHz(22000, 96000) === 22000,
    "a high-rate context leaves the setting exactly as it was",
  );
}

/* ── 2 · transparent ceiling guard ─────────────────────────────────────── */

console.log("\n2 · ceiling guard transfer");
{
  const CURVE = softCeilingCurve(-1);
  const n = CURVE.length;
  /** The shaper's linear interpolation between curve points. */
  const shape = (x: number): number => {
    const t = Math.min(1, Math.max(0, (x + 1) / 2)) * (n - 1);
    const i0 = Math.floor(t);
    const i1 = Math.min(n - 1, i0 + 1);
    const f = t - i0;
    return CURVE[i0] * (1 - f) + CURVE[i1] * f;
  };

  check(near(shape(0.5), 0.5, 1e-6), "half scale passes at exactly unity");
  check(near(shape(-0.5), -0.5, 1e-6), "and so does negative half scale");
  check(near(shape(0.25), 0.25, 1e-6), "−12 dBFS passes at unity");
  check(near(shape(0.1), 0.1, 1e-6), "−20 dBFS passes at unity");

  // sine sweep at −12 dBFS: no harmonic residue because the curve is linear
  let worst = 0;
  for (let i = 0; i < 4800; i++) {
    const x = 0.2512 * Math.sin((2 * Math.PI * 997 * i) / 48000);
    worst = Math.max(worst, Math.abs(shape(x) - x));
  }
  check(worst < 1e-4, "a −12 dBFS tone is unaltered", `max error ${worst.toExponential(1)}`);

  const ceiling = dbToGain(-1);
  let max = 0;
  for (let i = 0; i < 4000; i++) {
    const x = Math.sin((2 * Math.PI * 997 * i) / 48000);
    max = Math.max(max, Math.abs(shape(x)));
  }
  check(max <= ceiling + 1e-6, "a full-scale tone stays under the ceiling", `${max.toFixed(3)} ≤ ${ceiling.toFixed(3)}`);
  check(max > ceiling * 0.97, "and still reaches it", `${(20 * Math.log10(max)).toFixed(2)} dBFS`);

  let monotonic = true;
  for (let i = 1; i < n; i++) if (CURVE[i] < CURVE[i - 1] - 1e-9) monotonic = false;
  check(monotonic, "the transfer never folds back");

  let symmetric = true;
  for (let i = 0; i < n; i++) {
    if (Math.abs(CURVE[i] + CURVE[n - 1 - i]) > 1e-6) symmetric = false;
  }
  check(symmetric, "the transfer is odd-symmetric");

  const lower = softCeilingCurve(-6);
  const lMax = Math.max(...Array.from(lower, Math.abs));
  check(lMax <= dbToGain(-6) + 1e-6, "the curve follows a lower ceiling", `${lMax.toFixed(3)}`);
}

/* ── 3 · identity curve for latency-matched dry legs ───────────────────── */

console.log("\n3 · identity curve");
{
  const c = identityCurve(4097);
  check(c.length === 4097, "the curve has the requested resolution", `${c.length}`);
  check(near(c[0], -1) && near(c[c.length - 1], 1), "it spans −1 … +1");
  check(near(c[2048], 0, 1e-6), "and passes through zero");
  let mono = true;
  for (let i = 1; i < c.length; i++) if (c[i] < c[i - 1] - 1e-9) mono = false;
  check(mono, "it is monotonic");
}

/* ── 4 · automatic control maths ───────────────────────────────────────── */

console.log("\n4 · automatic thresholds and makeup");
{
  check(autoDeessThresholdDb(-30) === -24, "auto threshold sits 6 dB over the band level");
  check(autoDeessThresholdDb(-80) === -45, "a silent band floors at −45 dBFS");
  check(autoDeessThresholdDb(-2) === -6, "a very hot band caps at −6 dBFS");
  check(autoDeessThresholdDb(Number.NaN) === -45, "a missing reading floors");

  check(autoMakeupDb(0) === 0, "no reduction asks for no makeup");
  check(autoMakeupDb(10) === 6, "10 dB of reduction returns 6 dB");
  check(autoMakeupDb(40) === 12, "the automatic part is capped at 12 dB");
  check(autoMakeupDb(Number.NaN) === 0, "a missing reading asks for nothing");
}

/* ── fake Web Audio ────────────────────────────────────────────────────── */

class FakeParam {
  value = 0;
  setTargetAtTime(v: number) {
    this.value = v;
  }
  setValueAtTime(v: number) {
    this.value = v;
  }
  cancelScheduledValues() {
    /* nothing scheduled */
  }
}

class FakeNode {
  gain = new FakeParam();
  frequency = new FakeParam();
  Q = new FakeParam();
  detune = new FakeParam();
  threshold = new FakeParam();
  knee = new FakeParam();
  ratio = new FakeParam();
  attack = new FakeParam();
  release = new FakeParam();
  reduction = 0;
  type = "";
  curve: Float32Array | null = null;
  oversample = "none";
  fftSize = 2048;
  frequencyBinCount = 1024;
  smoothingTimeConstant = 0.8;
  channelCount = 2;
  channelCountMode = "max";
  channelInterpretation = "speakers";
  connect() {
    return this;
  }
  disconnect() {
    /* mock graph */
  }
  start() {
    /* running */
  }
  stop() {
    /* stopped */
  }
  getFloatTimeDomainData(out: Float32Array) {
    out.fill(0);
  }
  getByteFrequencyData(out: Uint8Array) {
    out.fill(0);
  }
}

function fakeContext(sampleRate: number) {
  const ctx = {
    state: "running",
    sampleRate,
    currentTime: 0,
    baseLatency: 0.01,
    outputLatency: 0.02,
    onstatechange: null as null | (() => void),
    destination: new FakeNode(),
    createGain: () => new FakeNode(),
    createBiquadFilter: () => new FakeNode(),
    createDynamicsCompressor: () => new FakeNode(),
    createAnalyser: () => new FakeNode(),
    createWaveShaper: () => new FakeNode(),
    createChannelSplitter: () => new FakeNode(),
    createChannelMerger: () => new FakeNode(),
    createMediaStreamDestination: () => new FakeNode(),
    createOscillator: () => new FakeNode(),
    createBufferSource: () => new FakeNode(),
    createMediaElementSource: () => new FakeNode(),
    createMediaStreamSource: () => new FakeNode(),
    createBuffer: (_c: number, length: number) => ({
      getChannelData: () => new Float32Array(length),
    }),
    decodeAudioData: async () => ({}),
    resume: async () => undefined,
    suspend: async () => undefined,
    close: async () => undefined,
  };
  return ctx;
}

interface Internals {
  ctx: unknown;
  buildGraph: (ctx: unknown) => void;
  apply: (p: ProcessorParams) => void;
  clipShaper: FakeNode;
  clipDryShape: FakeNode;
  restHarmShaper: FakeNode;
  restHarmDryShape: FakeNode;
  exShaper: FakeNode;
  guardShaper: FakeNode;
  restLp: FakeNode;
  codecLp: FakeNode;
  airShelf: FakeNode;
  mainsNotch: FakeNode;
  mainsHarmonics: FakeNode[];
  deessDet: FakeNode;
  mbComps: FakeNode[];
  mbMakeups: FakeNode[];
  autoMakeupTrack: number[];
  updateAutoMakeup: () => void;
  deessBandDb: number;
}

function boot(sampleRate: number): Internals {
  const engine = new AudioEngine();
  const internals = engine as unknown as Internals;
  const ctx = fakeContext(sampleRate);
  internals.ctx = ctx;
  internals.buildGraph(ctx);
  internals.apply(DEFAULT_PARAMS);
  return internals;
}

/* ── 5 · graph at 48 kHz ───────────────────────────────────────────────── */

console.log("\n5 · graph wiring at 48 kHz");
{
  const g = boot(48000);
  check(g.restLp.frequency.value === 22000, "the restoration low-pass keeps its 22 kHz default");
  check(g.codecLp.frequency.value === 22000, "the codec low-pass keeps its 22 kHz default");

  check(
    g.clipShaper.oversample === "4x" && g.clipDryShape.oversample === "4x",
    "both clipper legs are oversampled",
    `${g.clipShaper.oversample} / ${g.clipDryShape.oversample}`,
  );
  const dry = g.clipDryShape.curve;
  check(
    !!dry && near(dry[0], -1) && near(dry[Math.floor(dry.length / 2)], 0),
    "the clipper's dry leg has a unity curve",
  );
  check(g.restHarmShaper.oversample === "4x" && g.restHarmDryShape.oversample === "4x", "the harmonic generator's legs match");
  check(g.exShaper.oversample === "4x", "the exciter is anti-aliased at 4×");

  const guard = g.guardShaper.curve;
  const mid = guard ? guard[Math.floor(guard.length / 2)] : Number.NaN;
  const quarter = guard ? guard[Math.floor(guard.length * 0.625)] : Number.NaN;
  check(near(mid, 0, 1e-6), "the guard is zero at zero");
  check(near(quarter, 0.25, 2e-3), "the guard is transparent at −12 dBFS", `${quarter.toFixed(4)}`);

  g.deessBandDb = -30;
  g.apply({
    ...DEFAULT_PARAMS,
    deess: { ...DEFAULT_PARAMS.deess, auto: true },
  });
  check(near(g.deessDet.threshold.value, -24, 1e-9), "an auto threshold reaches the detector", `${g.deessDet.threshold.value} dBFS`);

  g.apply(DEFAULT_PARAMS);
  check(near(g.deessDet.threshold.value, -26, 1e-9), "turning auto off restores the manual threshold", `${g.deessDet.threshold.value} dBFS`);

  // Harmonic mains notches follow the interference module's own switch.
  const hum = (harmonics: boolean): ProcessorParams => ({
    ...DEFAULT_PARAMS,
    advanced: {
      ...DEFAULT_PARAMS.advanced,
      restoration: {
        ...DEFAULT_PARAMS.advanced.restoration,
        interference: {
          ...DEFAULT_PARAMS.advanced.restoration.interference,
          on: true,
          mains: 50,
          harmonics,
        },
      },
    },
  });
  g.apply(hum(true));
  check(
    g.mainsHarmonics.length === 7 &&
      g.mainsHarmonics.every((n) => n.type === "notch"),
    "hum harmonics 2nd–8th engage alongside the fundamental",
    `${g.mainsHarmonics.length} notches`,
  );
  check(
    g.mainsHarmonics.every((n, i) => near(n.frequency.value, 50 * (i + 2))),
    "the notches are locked to their harmonics",
    g.mainsHarmonics.map((n) => n.frequency.value).join(", "),
  );
  g.apply(hum(false));
  check(
    g.mainsNotch.type === "notch" &&
      g.mainsHarmonics.every((n) => n.type === "allpass"),
    "without harmonics only the fundamental is notched",
  );
}

/* ── 6 · graph at 44.1 kHz ─────────────────────────────────────────────── */

console.log("\n6 · graph at 44.1 kHz");
{
  const g = boot(44100);
  check(
    g.restLp.frequency.value === 0.9 * 22050,
    "the restoration low-pass is folded off Nyquist",
    `${g.restLp.frequency.value.toFixed(0)} Hz`,
  );
  check(
    g.codecLp.frequency.value === 0.9 * 22050,
    "the codec low-pass is folded off Nyquist",
    `${g.codecLp.frequency.value.toFixed(0)} Hz`,
  );
  check(g.airShelf.frequency.value === 20000, "the 20 kHz air shelf is still inside the safe band");
  check(g.restLp.frequency.value < 22050, "no low-pass sits on Nyquist");
}

/* ── 7 · automatic multiband makeup ────────────────────────────────────── */

console.log("\n7 · automatic multiband makeup");
{
  const g = boot(48000);
  const auto: ProcessorParams = {
    ...DEFAULT_PARAMS,
    multiband: { ...DEFAULT_PARAMS.multiband, autoMakeup: true },
  };
  g.apply(auto);
  const band = 2;
  g.mbComps[band].reduction = -6;
  for (let i = 0; i < 300; i++) g.updateAutoMakeup();
  const gainDb = 20 * Math.log10(g.mbMakeups[band].gain.value);
  const expected = DEFAULT_PARAMS.multiband.bands[band].makeupDb + 3.6;
  check(near(gainDb, expected, 0.01), "the lost band energy is partly restored", `${gainDb.toFixed(2)} dB ≈ ${expected.toFixed(2)} dB`);
  check(g.autoMakeupTrack[band] > 3.4, "the tracker converges on 60 % of the reduction", g.autoMakeupTrack[band].toFixed(2));

  g.apply(DEFAULT_PARAMS);
  const baseDb = 20 * Math.log10(g.mbMakeups[band].gain.value);
  check(
    near(baseDb, DEFAULT_PARAMS.multiband.bands[band].makeupDb, 1e-6) &&
      g.autoMakeupTrack[band] === 0,
    "switching auto off returns the preset makeup exactly",
    `${baseDb.toFixed(2)} dB`,
  );
}

console.log(`\n${passed} checks passed, ${failed} failed`);
if (failed > 0) process.exit(1);
