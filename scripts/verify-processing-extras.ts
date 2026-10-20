/**
 * Processing extras: loudness compliance, adaptive limiter envelopes,
 * per-band width, M/S trim, dual-stage limiter, monitor checks and the
 * true-peak oversampling factors.
 *
 *   bun scripts/verify-processing-extras.ts
 *
 * The pure maths is checked directly; the graph and parameter wiring are
 * driven through the real AudioEngine against a stand-in AudioContext, so the
 * console's controls are proven to reach real nodes.
 *
 *  1  loudness standards and targets
 *  2  deviation + compliance verdict
 *  3  CSV report
 *  4  adaptive limiter releases
 *  5  coherence-width safety
 *  6  true-peak oversampling
 *  7  graph: bass, per-band width, M/S trim, program limiter, monitor checks
 *  8  old saves gain the new stages bypassed
 */
import { AudioEngine } from "../src/lib/audio/engine";
import {
  DEFAULT_PARAMS,
  coerceParams,
  limiterProgram,
  type ProcessorParams,
} from "../src/lib/audio/params";
import {
  LOUDNESS_STANDARDS,
  complianceState,
  complianceTarget,
  loudnessCsv,
  loudnessDeviation,
  loudnessStandard,
} from "../src/lib/audio/loudness";
import { coherenceSafety, dynamicReleaseMs, safeWidth } from "../src/lib/audio/tools";
import { truePeak } from "../src/lib/audio/measure";

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

/* ── 1 · loudness standards ────────────────────────────────────────────── */

console.log("\n1 · loudness standards");
{
  check(LOUDNESS_STANDARDS.length === 6, "six standards are offered", `${LOUDNESS_STANDARDS.length}`);
  check(loudnessStandard("ebu").targetLufs === -23, "EBU R128 is −23 LUFS");
  check(loudnessStandard("atsc").targetLufs === -24, "ATSC A/85 is −24 LUFS");
  check(loudnessStandard("spotify").targetLufs === -14, "Spotify is −14 LUFS");
  check(loudnessStandard("apple").targetLufs === -16, "Apple Music is −16 LUFS");
  check(loudnessStandard("r128s1").truePeakDb === -1, "R128 s1 keeps a −1 dBTP ceiling");
  check(loudnessStandard("atsc").truePeakDb === -2, "A/85 asks for −2 dBTP");

  const ebu = complianceTarget({
    ...DEFAULT_PARAMS,
    loudness: { standard: "ebu", customLufs: -14, customTpDb: -1 },
  });
  check(ebu.lufs === -23 && ebu.truePeakDb === -1, "the chain resolves the EBU target", `${ebu.lufs} LUFS`);

  const custom = complianceTarget({
    ...DEFAULT_PARAMS,
    loudness: { standard: "custom", customLufs: -18.5, customTpDb: -1.5 },
  });
  check(custom.lufs === -18.5 && custom.truePeakDb === -1.5, "a custom target is honoured", `${custom.lufs} LUFS`);
  const clamped = complianceTarget({
    ...DEFAULT_PARAMS,
    loudness: { standard: "custom", customLufs: -90, customTpDb: 6 },
  });
  check(clamped.lufs === -30 && clamped.truePeakDb === 0, "a custom target is clamped to a sane window", `${clamped.lufs} / ${clamped.truePeakDb}`);
  const bad = complianceTarget({
    ...DEFAULT_PARAMS,
    loudness: { standard: "custom", customLufs: Number.NaN, customTpDb: Number.NaN },
  });
  check(bad.lufs === -14 && bad.truePeakDb === -1, "a NaN custom target falls back", `${bad.lufs}`);
}

/* ── 2 · deviation + verdict ───────────────────────────────────────────── */

console.log("\n2 · deviation and verdict");
{
  const t = { id: "ebu" as const, label: "EBU R128", lufs: -23, truePeakDb: -1 };
  check(loudnessDeviation(-23.04, -23) === 0, "a 0.04 LU miss rounds to zero", String(loudnessDeviation(-23.04, -23)));
  check(loudnessDeviation(-21, -23) === 2, "over target is positive", String(loudnessDeviation(-21, -23)));
  check(loudnessDeviation(null, -23) === null, "no measurement, no deviation");
  check(complianceState(null, -3, t) === "measuring", "no verdict before the integrated meter fills");
  check(complianceState(-23.2, -1.5, t) === "pass", "inside ±2 LU passes");
  check(complianceState(-20.5, -1.5, t) === "warn", "1.5× the tolerance warns");
  check(complianceState(-14, -1.5, t) === "fail", "well over target fails");
  check(complianceState(-23, -0.5, t) === "fail", "a true-peak overshoot always fails");
  check(complianceState(-23, -1.05, t) === "pass", "a true peak inside the ceiling passes");
}

/* ── 3 · CSV ───────────────────────────────────────────────────────────── */

console.log("\n3 · compliance CSV");
{
  const csv = loudnessCsv(
    [
      { at: Date.UTC(2026, 0, 2, 3, 4, 5), momentary: -13.2, shortTerm: -14.1, integrated: -14.4, lra: 6.2, truePeak: -1.2 },
      { at: Date.UTC(2026, 0, 2, 3, 4, 6), momentary: -12.9, shortTerm: -13.9, integrated: -14.3, lra: 6.1, truePeak: -1.1 },
    ],
    {
      station: "Signalpath, Main",
      preset: "Music, tight",
      standard: { id: "spotify", label: "Spotify / streaming", lufs: -14, truePeakDb: -1 },
    },
  );
  check(csv.startsWith("# Signalpath loudness log"), "the report carries a readable preamble");
  check(csv.includes("# station: \"Signalpath, Main\"") || csv.includes("# station: Signalpath, Main"), "the station name is included", csv.split("\n")[1]);
  check(csv.includes("# target: -14 LUFS / -1 dBTP"), "the target is included");
  const lines = csv.trimEnd().split("\n");
  const header = lines.findIndex((l) => l.startsWith("timestamp_utc"));
  check(header > 0, "a header row separates metadata from readings");
  check(lines.length === header + 3, "two readings produce two rows", `${lines.length - header - 1} rows`);
  const first = lines[header + 1].split(",");
  check(first.length === 7, "each row has seven columns", `${first.length}`);
  check(first[0] === "2026-01-02T03:04:05.000Z", "timestamps are absolute UTC", first[0]);
  check(first[2] === "-14.1" && first[4] === "6.2", "short-term and LRA are carried", `${first[2]} / ${first[4]}`);
  check(first[6] === "-0.4", "deviation from target is computed", first[6]);
  const quoted = loudnessCsv([], {
    station: "A \"B\" C",
    preset: "x",
    standard: { id: "ebu", label: "EBU", lufs: -23, truePeakDb: -1 },
  });
  check(quoted.includes("# station: A \"B\" C") || quoted.includes('"A ""B"" C"'), "quotes in metadata do not break the file");
}

/* ── 4 · adaptive releases ─────────────────────────────────────────────── */

console.log("\n4 · adaptive limiter release");
{
  check(dynamicReleaseMs(100, 8, 3, false) === 100, "adaptive off keeps the operator's release");
  const percussive = dynamicReleaseMs(100, 6, 3, true);
  const sustained = dynamicReleaseMs(100, 20, 3, true);
  check(percussive < sustained, "percussive programme releases faster", `${percussive.toFixed(0)} vs ${sustained.toFixed(0)} ms`);
  check(percussive >= 20 && sustained <= 2000, "both stay inside the usable window", `${percussive.toFixed(0)}…${sustained.toFixed(0)}`);
  const pushed = dynamicReleaseMs(100, 6, 6, true);
  check(pushed > percussive, "a deep reduction lengthens the recovery", `${pushed.toFixed(0)} ms`);
  check(dynamicReleaseMs(Number.NaN, 10, 0, false) === 100, "a broken saved value falls back");
}

/* ── 5 · coherence width ───────────────────────────────────────────────── */

console.log("\n5 · per-band width safety");
{
  check(coherenceSafety(1, 0.95) === 1, "a mono-correlated source may widen freely");
  check(coherenceSafety(0.95, 0.95) === 1, "at the guard the full width is allowed");
  const low = coherenceSafety(0.2, 0.95);
  check(low < 0.1, "a decorrelated source is held back", low.toFixed(2));
  check(coherenceSafety(-1, 0.95) === 0, "an out-of-phase source cannot be widened");
  check(safeWidth(1.4, 0.5) === 1.2, "widening is scaled by the safety factor", String(safeWidth(1.4, 0.5)));
  check(safeWidth(0, 0.5) === 0, "narrowing is never limited", String(safeWidth(0, 0.5)));
  check(safeWidth(0.6, 0) === 0.6, "a zero safety still allows narrowing", String(safeWidth(0.6, 0)));
}

/* ── 6 · true peak oversampling ────────────────────────────────────────── */

console.log("\n6 · true-peak oversampling");
{
  const fs = 48000;
  const n = 4096;
  // fs/8 at 22.5° puts samples close to, but not on, the crest.
  const buf = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    buf[i] = 0.5 * Math.sin((2 * Math.PI * (fs / 8) * i) / fs + Math.PI / 8);
  }
  const p2 = truePeak(buf, 2);
  const p4 = truePeak(buf, 4);
  const p8 = truePeak(buf, 8);
  check(p8 >= p4 - 1e-9 && p4 >= p2 - 1e-9, "more phases never read lower", `${p2.toFixed(2)} ≤ ${p4.toFixed(2)} ≤ ${p8.toFixed(2)}`);
  check(Math.abs(p8 - 20 * Math.log10(0.5)) < 0.6, "8× lands on the real amplitude", `${(p8 - 20 * Math.log10(0.5)).toFixed(2)} dB off`);
  check(near(truePeak(buf, 4), truePeak(buf), 1e-9), "4× is the default");
  check(truePeak(buf, 3) === p4, "an unsupported factor falls back to 4×");
}

/* ── 7 · engine graph ──────────────────────────────────────────────────── */

console.log("\n7 · graph wiring");

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

const EDGES: [number, number][] = [];
let nodeId = 0;

class FakeNode {
  id = (nodeId += 1);
  gain = new FakeParam();
  frequency = new FakeParam();
  Q = new FakeParam();
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
  connect(target: FakeNode): this {
    EDGES.push([this.id, target.id]);
    return this;
  }
  disconnect() {
    /* mock graph */
  }
  getFloatTimeDomainData(out: Float32Array) {
    out.fill(0);
  }
  getByteFrequencyData(out: Uint8Array) {
    out.fill(0);
  }
  start() {
    /* running */
  }
  stop() {
    /* stopped */
  }
}

const fakeCtx = {
  currentTime: 0,
  sampleRate: 48000,
  state: "running",
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

interface Internals {
  buildGraph: (ctx: unknown) => void;
  bassMix: FakeNode;
  bassDrive: FakeNode;
  cwBands: FakeNode[];
  cwWet: FakeNode;
  cwDry: FakeNode;
  midTrim: FakeNode;
  sideTrim: FakeNode;
  sideHpfWet: FakeNode;
  sideHpfDry: FakeNode;
  progComp: FakeNode;
  monL: FakeNode;
  monR: FakeNode;
  monMono: FakeNode;
  limComp: FakeNode;
}

const engine = new AudioEngine();
const internals = engine as unknown as Internals;
engine.ctx = fakeCtx as unknown as AudioContext;
internals.buildGraph(fakeCtx);

const dbToGain = (db: number) => Math.pow(10, db / 20);
const withPsy = (psy: Partial<ProcessorParams["psy"]>): ProcessorParams => ({
  ...DEFAULT_PARAMS,
  psy: { ...DEFAULT_PARAMS.psy, ...psy },
});

engine.apply(DEFAULT_PARAMS);
check(internals.cwBands.length === 5, "the side channel is split into five bands", `${internals.cwBands.length}`);
check(
  internals.cwBands.every((b) => b.gain.value === 1) && internals.cwDry.gain.value === 1 && internals.cwWet.gain.value === 0,
  "bypassed, per-band width is unity and the dry side is in circuit",
);
check(internals.bassMix.gain.value === 0, "the bass module is silent unless engaged");
check(
  internals.midTrim.gain.value === 1 && internals.sideTrim.gain.value === 1 && internals.sideHpfWet.gain.value === 0,
  "the M/S trim is unity by default",
);
check(internals.progComp.ratio.value === 1, "the program limiter is unity by default");
check(
  internals.monL.gain.value === 1 && internals.monR.gain.value === 1 && internals.monMono.gain.value === 0,
  "monitor checks are off by default",
);

engine.apply(
  withPsy({
    cohWidth: { on: true, bands: [0, 1, 1, 1.4, 1.6], corrGuard: 0.95 },
    msTrim: { on: true, midDb: -3, sideDb: -1.5, sideHpfHz: 300 },
    bassSynth: { on: true, fundHz: 70, harmMix: 40, depth: 60 },
  }),
);
check(
  near(internals.cwBands[0].gain.value, 0) && near(internals.cwBands[4].gain.value, 1.6),
  "the bass band can be mono while the air band widens",
  `${internals.cwBands[0].gain.value} / ${internals.cwBands[4].gain.value}`,
);
check(internals.cwWet.gain.value === 1 && internals.cwDry.gain.value === 0, "the banded side path is in circuit");
check(
  near(internals.midTrim.gain.value, dbToGain(-3), 1e-3) &&
    near(internals.sideTrim.gain.value, dbToGain(-1.5), 1e-3),
  "M/S trim reaches the matrix",
  `${internals.midTrim.gain.value.toFixed(3)} / ${internals.sideTrim.gain.value.toFixed(3)}`,
);
check(internals.sideHpfWet.gain.value === 1 && internals.sideHpfDry.gain.value === 0, "the side HPF is engaged with the trim");
check(near(internals.bassMix.gain.value, 0.14, 1e-6), "the bass module mix follows harm mix", internals.bassMix.gain.value.toFixed(3));
check(near(internals.bassDrive.gain.value, 2.8, 1e-6), "depth drives the bass shaper", internals.bassDrive.gain.value.toFixed(2));

engine.apply({
  ...DEFAULT_PARAMS,
  limiter: {
    ...DEFAULT_PARAMS.limiter,
    program: { on: true, ceilingDb: -1.6, attackMs: 10, releaseMs: 260 },
  },
});
check(
  internals.progComp.ratio.value === 4 && near(internals.progComp.threshold.value, -1.6),
  "the program limiter takes its own ceiling and ratio",
  `${internals.progComp.threshold.value} dB · ${internals.progComp.ratio.value}:1`,
);
const progEdge = EDGES.some(([a, b]) => a === internals.limComp.id && b === internals.progComp.id);
check(progEdge, "the program stage follows the peak stage");

engine.apply({
  ...DEFAULT_PARAMS,
  monitor: { mono: true, invertL: true, invertR: false },
});
check(
  internals.monMono.gain.value === 1 && internals.monL.gain.value === 0 && internals.monR.gain.value === 0,
  "the mono check folds the monitor",
);
engine.apply({
  ...DEFAULT_PARAMS,
  monitor: { mono: false, invertL: true, invertR: false },
});
check(
  internals.monL.gain.value === -1 && internals.monR.gain.value === 1 && internals.monMono.gain.value === 0,
  "a single channel can be polarity-flipped for the check",
);

/* ── 8 · worklet limiter path ──────────────────────────────────────────── */

console.log("\n8 · worklet limiter");

class FakeWorkletNode {
  port = {
    onmessage: null as null | ((e: { data: { gr?: number } }) => void),
    postMessage() {
      /* host → node params */
    },
  };
  connect() {
    /* wired */
  }
  disconnect() {
    /* unwired */
  }
}

(globalThis as unknown as { AudioWorkletNode: unknown }).AudioWorkletNode =
  FakeWorkletNode;

interface WorkletInternals {
  ctx: unknown;
  buildGraph: (ctx: unknown) => void;
  apply: (p: ProcessorParams) => void;
  workletReady: boolean;
  workletLimiter: FakeWorkletNode | null;
  workletGr: number;
  limWorklet: FakeNode;
  limNative: FakeNode;
}

{
  const wCtx = { ...fakeCtx, audioWorklet: {} };
  const w = new AudioEngine() as unknown as WorkletInternals;
  w.ctx = wCtx;
  w.workletReady = true;
  w.buildGraph(wCtx);
  w.apply(DEFAULT_PARAMS);

  check(w.workletLimiter !== null, "the graph builds the lookahead worklet node");
  check(
    w.limWorklet.gain.value === 1 && w.limNative.gain.value === 0,
    "the worklet is the peak stage by default",
    `worklet ${w.limWorklet.gain.value} · native ${w.limNative.gain.value}`,
  );

  w.workletLimiter?.port.onmessage?.({ data: { gr: 7.5 } });
  check(w.workletGr === 7.5, "gain reduction is read back from the audio thread");

  w.apply({
    ...DEFAULT_PARAMS,
    limiter: { ...DEFAULT_PARAMS.limiter, engine: "native" },
  });
  check(
    w.limWorklet.gain.value === 0 && w.limNative.gain.value === 1,
    "selecting native crossfades the peak stage back",
    `worklet ${w.limWorklet.gain.value} · native ${w.limNative.gain.value}`,
  );
}

/* ── 9 · old saves ─────────────────────────────────────────────────────── */

console.log("\n9 · old saves gain the new stages bypassed");
{
  const legacy = {
    ...DEFAULT_PARAMS,
    limiter: { on: true, ceilingDb: -1, attackMs: 1.5, releaseMs: 100 },
  } as Record<string, unknown>;
  delete (legacy as { loudness?: unknown }).loudness;
  delete (legacy as { monitor?: unknown }).monitor;
  delete (legacy as { psy?: unknown }).psy;
  const merged = coerceParams(legacy);
  check(merged.loudness.standard === "spotify", "a pre-standard save gets the streaming target");
  check(merged.monitor.mono === false && merged.monitor.invertL === false, "monitor checks default off");
  check(merged.psy.cohWidth.on === false, "per-band width stays bypassed");
  check(limiterProgram(merged.limiter).on === false, "the program limiter stays bypassed");
  check(merged.limiter.adaptive === false && merged.limiter.holdMs === 0, "adaptive/hold stay off");
  check(merged.limiter.truePeakX === 4, "true-peak metering defaults to 4×");
  check(merged.psy.msTrim.on === false && merged.psy.bassSynth.on === false, "M/S trim and bass stay bypassed");
  check(merged.limiter.engine === "worklet", "a pre-worklet save takes the lookahead stage");
}

console.log(`\n${passed} checks passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
