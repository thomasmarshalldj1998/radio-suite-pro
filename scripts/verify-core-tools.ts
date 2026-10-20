/**
 * Broadcast tool checks — the four console tools added for v2:
 *
 *   bun scripts/verify-core-tools.ts
 *
 *  1  window gate: freeze inside the window, release outside, reset on silence
 *  2  phase rotator: a 4-stage staggered allpass cascade, bypassable
 *  3  Less–More macro: ratios, timing and limiter drive move together
 *  4  de-esser: band clamp, cut depth and coefficient
 *  5  parameters: new controls default cleanly and old saved presets coerce
 *  6  wiring: the graph really carries those nodes, and apply() reaches them
 *
 * Section 6 drives the real AudioEngine against a mock AudioContext, so the
 * numbers below are the values the live graph would receive.
 */
import { AudioEngine } from "../src/lib/audio/engine";
import {
  BUILTIN_PRESETS,
  DEFAULT_PARAMS,
  chainResponseDb,
  coerceParams,
  dbToGain,
  agcFast,
  eqBandOn,
  hpfSectionQs,
  limiterClipper,
} from "../src/lib/audio/params";
import {
  DEESS_MAX_HZ,
  DEESS_MIN_HZ,
  DENSITY_MAX,
  DENSITY_MIN,
  WindowGate,
  clampDeessFreq,
  deessAlpha,
  densityProfile,
  phaseStageFrequencies,
} from "../src/lib/audio/tools";

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

/* ── 1 · window gate ───────────────────────────────────────────────────── */

console.log("\n1 · AGC window gate");
{
  const gate = new WindowGate({ windowDb: 3, spanMs: 1000, floorDb: -70 });
  // a steady programme inside the window: freeze after the history fills
  let t = 0;
  let reading = gate.update(-20, t);
  for (let i = 0; i < 12; i++) reading = gate.update(-20 + (i % 2 ? 0.5 : -0.5), (t += 100));
  check(reading.frozen, "a steady ±0.5 dB programme freezes the gain", `${reading.spreadDb.toFixed(1)} dB spread`);
  check(near(reading.spreadDb, 1, 1e-9), "the spread is measured, not assumed", `${reading.spreadDb.toFixed(2)} dB`);

  // the programme moves: the gate must let go
  reading = gate.update(-8, (t += 100));
  check(!reading.frozen, "leaving the window releases the gate", `${reading.spreadDb.toFixed(1)} dB spread`);

  // silence is not a stable programme
  const quiet = new WindowGate({ windowDb: 3, spanMs: 1000, floorDb: -70 });
  for (let i = 0; i < 12; i++) quiet.update(-80, (t += 100));
  check(!quiet.frozen, "silence below the floor never freezes");

  // hysteresis: a level sitting right on the edge must not chatter
  const edge = new WindowGate({ windowDb: 3, spanMs: 600, floorDb: -70 });
  for (let i = 0; i < 10; i++) edge.update(-20, (t += 100));
  check(edge.frozen, "a flat programme freezes");
  edge.update(-16.5, (t += 100)); // 3.5 dB spread — inside the 35 % release band
  check(edge.frozen, "a spill just past the window keeps the hold (hysteresis)");
  edge.update(-10, (t += 100));
  check(!edge.frozen, "a clear departure releases it");

  // disabled
  const off = new WindowGate({ windowDb: 0, spanMs: 1000, floorDb: -70 });
  for (let i = 0; i < 20; i++) off.update(-20, (t += 100));
  check(!off.frozen, "window 0 dB disables the gate entirely");
}

/* ── 2 · phase rotator cascade ─────────────────────────────────────────── */

console.log("\n2 · phase rotator");
{
  const stages = phaseStageFrequencies(300);
  check(stages.length === 4, "the rotor is a 4-stage cascade", `${stages.length} stages`);
  check(
    stages.every((hz, i) => i === 0 || hz > stages[i - 1]),
    "the stages are staggered upward",
    stages.join(" / "),
  );
  check(near(stages[0], 150) && near(stages[3], 450), "0.5× … 1.5× around the tuning frequency", `${stages[0]}–${stages[3]} Hz`);
  const clamped = phaseStageFrequencies(1e6);
  check(clamped[2] <= 2000, "an absurd tuning is clamped, not passed through", `${clamped[2]} Hz`);
}

/* ── 3 · Less–More density macro ───────────────────────────────────────── */

console.log("\n3 · Less–More macro");
{
  const neutral = densityProfile(5);
  check(neutral.ratioScale === 1 && neutral.timeScale === 1 && neutral.driveDb === 0, "5 is exactly neutral", JSON.stringify(neutral));
  const open = densityProfile(DENSITY_MIN);
  const dense = densityProfile(DENSITY_MAX);
  check(open.ratioScale < neutral.ratioScale && neutral.ratioScale < dense.ratioScale, "ratio rises with the macro", `${open.ratioScale} → ${dense.ratioScale}`);
  check(open.timeScale > neutral.timeScale && neutral.timeScale > dense.timeScale, "envelopes speed up with the macro", `${open.timeScale}s → ${dense.timeScale}s`);
  check(open.driveDb < 0 && dense.driveDb > 0, "limiter drive follows the macro", `${open.driveDb} → +${dense.driveDb} dB`);
  check(densityProfile(-4).ratioScale === open.ratioScale && densityProfile(99).ratioScale === dense.ratioScale, "out-of-range settings clamp");
  check(open.label === "Open" && dense.label === "Maximum", "the label describes the setting", `${open.label} / ${dense.label}`);
}

/* ── 4 · de-esser ──────────────────────────────────────────────────────── */

console.log("\n4 · de-esser");
{
  check(clampDeessFreq(1000) === DEESS_MIN_HZ, "tuning clamps to 5 kHz", `${clampDeessFreq(1000)} Hz`);
  check(clampDeessFreq(20000) === DEESS_MAX_HZ, "tuning clamps to 10 kHz", `${clampDeessFreq(20000)} Hz`);
  check(clampDeessFreq(8000) === 8000, "an in-band tuning passes through", "8000 Hz");
  check(deessAlpha(0) === 0, "no cut, no subtraction");
  check(deessAlpha(6) > deessAlpha(3) && deessAlpha(3) > 0, "deeper cuts subtract more");
  check(deessAlpha(80) < 1, "the subtractor never nulls the band completely", deessAlpha(80).toFixed(3));
  // α = 1 − 10^(−cut/20) is a −cut dB cut by construction
  const cut = 6;
  const alpha = deessAlpha(cut);
  check(near(20 * Math.log10(1 - alpha), -cut, 1e-9), "the coefficient equals the requested cut", `${(20 * Math.log10(1 - alpha)).toFixed(2)} dB`);
}

/* ── 5 · parameters and old saves ─────────────────────────────────────── */

console.log("\n5 · parameters");
{
  check(DEFAULT_PARAMS.agc.windowDb === 0, "the window gate ships off", `${DEFAULT_PARAMS.agc.windowDb} dB`);
  check(DEFAULT_PARAMS.phase.on, "the phase rotator ships engaged");
  check(DEFAULT_PARAMS.density === 5, "the macro ships neutral", `${DEFAULT_PARAMS.density}`);
  check(DEFAULT_PARAMS.deess.on, "the de-esser ships engaged");
  check(DEFAULT_PARAMS.deess.freqHz >= DEESS_MIN_HZ && DEFAULT_PARAMS.deess.freqHz <= DEESS_MAX_HZ, "its default tuning is inside the band", `${DEFAULT_PARAMS.deess.freqHz} Hz`);

  const legacy = structuredClone(DEFAULT_PARAMS) as unknown as Record<string, unknown>;
  delete (legacy.agc as Record<string, unknown>).windowDb;
  delete (legacy.phase as Record<string, unknown>).on;
  delete (legacy as Record<string, unknown>).density;
  delete (legacy as Record<string, unknown>).deess;
  const coerced = coerceParams(legacy);
  check(coerced.agc.windowDb === 0 && coerced.phase.on === true, "a pre-v2 save gains the new AGC/phase defaults");
  check(coerced.density === 5 && coerced.deess.on === true, "and the macro/de-esser defaults");

  const missing = BUILTIN_PRESETS.filter(
    (p) =>
      typeof p.params.density !== "number" ||
      typeof p.params.agc.windowDb !== "number" ||
      typeof p.params.deess?.freqHz !== "number",
  );
  check(missing.length === 0, "every built-in preset carries the new controls", `${BUILTIN_PRESETS.length - missing.length}/${BUILTIN_PRESETS.length}`);

  // HPF steepness: one section per 12 dB/oct, more sections = steeper
  check(DEFAULT_PARAMS.hpf.slope === 24, "the HPF ships at 24 dB/oct", `${DEFAULT_PARAMS.hpf.slope} dB/oct`);
  const slopes = ([12, 24, 36, 48] as const).map((s) => hpfSectionQs(s).length);
  check(
    slopes.join("/") === "1/2/3/4",
    "steepness maps to 1–4 cascade sections",
    slopes.join("/"),
  );
  check(
    hpfSectionQs(48).every((q) => q > 0.5 && q < 3),
    "Butterworth sections use sane pole Qs",
    hpfSectionQs(48).map((q) => q.toFixed(2)).join("/"),
  );
  // 30 Hz rolloff should be far deeper at 48 dB/oct than at 12
  const shallow = chainResponseDb({ ...DEFAULT_PARAMS, eq: { ...DEFAULT_PARAMS.eq, on: false }, hpf: { on: true, freqHz: 80, slope: 12 } }, 20);
  const steep = chainResponseDb({ ...DEFAULT_PARAMS, eq: { ...DEFAULT_PARAMS.eq, on: false }, hpf: { on: true, freqHz: 80, slope: 48 } }, 20);
  check(steep < shallow - 12, "48 dB/oct cuts far deeper below the corner", `${shallow.toFixed(1)} → ${steep.toFixed(1)} dB @ 20 Hz`);

  // EQ per-band bypass + extended shapes
  const legacyBand = { freq: 120, gainDb: 3, q: 1, type: "peaking" as const };
  check(eqBandOn(legacyBand), "a band saved without a bypass flag reads as on");
  check(!eqBandOn({ ...legacyBand, on: false }), "an explicit off keeps the band out of the chain");
  const notch = chainResponseDb(
    { ...DEFAULT_PARAMS, hpf: { ...DEFAULT_PARAMS.hpf, on: false }, eq: { on: true, bands: [{ freq: 1000, gainDb: 0, q: 4, type: "notch", on: true }] } },
    1000,
  );
  const notchBypassed = chainResponseDb(
    { ...DEFAULT_PARAMS, hpf: { ...DEFAULT_PARAMS.hpf, on: false }, eq: { on: true, bands: [{ freq: 1000, gainDb: 0, q: 4, type: "notch", on: false }] } },
    1000,
  );
  check(notch < -20 && near(notchBypassed, 0, 1e-9), "a notch cuts and per-band bypass removes it", `${notch.toFixed(1)} dB / ${notchBypassed.toFixed(1)} dB`);

  // clipper defaults on old limiter blocks
  const legacyLimiter = { on: true, ceilingDb: -1, attackMs: 1, releaseMs: 100 };
  check(limiterClipper(legacyLimiter).on === false, "the clipper ships bypassed on legacy saves");
  check(limiterClipper({ ...legacyLimiter, clipper: { on: true, thresholdDb: -2, mix: 40 } }).mix === 40, "a saved clipper setting survives coercion");

  // dual-window AGC: the fast window is opt-in, and old saves get it bypassed
  check(agcFast(DEFAULT_PARAMS.agc).on === false, "the fast window ships bypassed so presets sound unchanged");
  const oldAgc = { ...DEFAULT_PARAMS.agc } as Record<string, unknown>;
  delete oldAgc.fast;
  const coercedAgc = coerceParams({ ...DEFAULT_PARAMS, agc: oldAgc }).agc;
  check(
    agcFast(coercedAgc).on === false && agcFast(coercedAgc).thresholdDb === -10,
    "a pre-dual-window save gains the fast-window defaults",
  );
  const savedFast = agcFast({ ...DEFAULT_PARAMS.agc, fast: { ...agcFast(DEFAULT_PARAMS.agc), on: true, thresholdDb: -6 } });
  check(savedFast.on && savedFast.thresholdDb === -6, "an engaged fast window survives coercion");
}

/* ── 6 · graph wiring ─────────────────────────────────────────────────── */

console.log("\n6 · graph");

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

/** Every connection made while building the graph, as [from, to] node ids. */
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
  smoothingTimeConstant = 0;
  channelCount = 2;
  stream = {};
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

interface EngineInternals {
  buildGraph: (ctx: unknown) => void;
  truePeak: (buf: Float32Array) => number;
  monitorGain: FakeNode;
  setMonitorMuted: (muted: boolean) => void;
  hpfStages: FakeNode[];
  eqFilters: FakeNode[];
  clipShaper: FakeNode;
  clipWet: FakeNode;
  clipDry: FakeNode;
  agcFastComp: FakeNode;
  agcComp: FakeNode;
  agcMakeup: FakeNode;
  agcWetPre: FakeNode;
  phaseStages: FakeNode[];
  phaseWet: FakeNode;
  phaseDry: FakeNode;
  deessBpAudio: FakeNode;
  deessBpDet: FakeNode;
  deessDet: FakeNode;
  deessSub: FakeNode;
  deessOut: FakeNode;
  limDrive: FakeNode;
  limWetPre: FakeNode;
  limComp: FakeNode;
  mbComps: FakeNode[];
  agcHold: FakeNode;
  agcWetOut: FakeNode;
  windowGate: { frozen: boolean };
}

const engine = new AudioEngine();
const internals = engine as unknown as EngineInternals;
engine.ctx = fakeCtx as unknown as AudioContext;
internals.buildGraph(fakeCtx);
check(internals.phaseStages.length === 4, "the graph holds four allpass stages", `${internals.phaseStages.length}`);
check(
  internals.phaseStages.every((n) => n.type === "allpass"),
  "every stage is an allpass filter",
  internals.phaseStages.map((n) => `${n.frequency.value.toFixed(0)}`).join("/"),
);
check(internals.windowGate !== undefined, "the AGC carries a window gate");
check(internals.deessBpAudio.frequency.value === 7500, "the de-esser band starts at 7.5 kHz");

engine.apply(DEFAULT_PARAMS);
check(internals.phaseWet.gain.value === 1 && internals.phaseDry.gain.value === 0, "the rotor is in circuit by default");
check(near(internals.limDrive.gain.value, 1), "density 5 adds no limiter drive", internals.limDrive.gain.value.toFixed(3));

engine.apply({ ...DEFAULT_PARAMS, density: DENSITY_MAX });
check(near(internals.limDrive.gain.value, dbToGain(densityProfile(DENSITY_MAX).driveDb)), "density 10 drives the limiter", internals.limDrive.gain.value.toFixed(3));
check(
  near(internals.mbComps[0].ratio.value, DEFAULT_PARAMS.multiband.bands[0].ratio * densityProfile(DENSITY_MAX).ratioScale),
  "and raises the multiband ratios with it",
  internals.mbComps[0].ratio.value.toFixed(2),
);
check(
  internals.mbComps[0].attack.value < DEFAULT_PARAMS.multiband.bands[0].attackMs / 1000,
  "and speeds the band envelopes up",
  `${(internals.mbComps[0].attack.value * 1000).toFixed(1)} ms`,
);

engine.apply({ ...DEFAULT_PARAMS, phase: { ...DEFAULT_PARAMS.phase, on: false } });
check(internals.phaseWet.gain.value === 0 && internals.phaseDry.gain.value === 1, "bypass drops the whole cascade");

// HPF cascade: sections follow the selected steepness, bypass makes them neutral
check(internals.hpfStages.length === 4, "the graph holds four HPF sections", `${internals.hpfStages.length}`);
engine.apply({ ...DEFAULT_PARAMS, hpf: { on: true, freqHz: 60, slope: 48 } });
check(
  internals.hpfStages.every((s) => s.type === "highpass") && near(internals.hpfStages[0].frequency.value, 60),
  "48 dB/oct engages all four sections at the set corner",
  internals.hpfStages.map((s) => s.type.slice(0, 2)).join("/"),
);
engine.apply({ ...DEFAULT_PARAMS, hpf: { on: true, freqHz: 60, slope: 12 } });
check(
  internals.hpfStages[0].type === "highpass" && internals.hpfStages.slice(1).every((s) => s.type === "allpass"),
  "12 dB/oct leaves one section and neutralises the rest",
);
engine.apply({ ...DEFAULT_PARAMS, hpf: { on: false, freqHz: 60, slope: 48 } });
check(internals.hpfStages.every((s) => s.type === "allpass"), "HPF bypass keeps the topology but removes the cut");

// EQ: shape and per-band bypass reach the real filters
engine.apply({
  ...DEFAULT_PARAMS,
  eq: {
    on: true,
    bands: DEFAULT_PARAMS.eq.bands.map((b, i) =>
      i === 3 ? { ...b, type: "notch" as const } : i === 4 ? { ...b, on: false } : b,
    ),
  },
});
check(internals.eqFilters[3].type === "notch", "a band's shape is applied to its filter", internals.eqFilters[3].type);
check(internals.eqFilters[4].type === "allpass", "a bypassed band goes magnitude-neutral", internals.eqFilters[4].type);

// true peak: 4× oversampling must find crests between samples, and must not
// invent them where the signal crosses zero
{
  const fs = 48000;
  const amp = 0.5;
  const n = 4096;
  const sine = (phaseOffset: number, freq = 997) => {
    const buf = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      buf[i] = amp * Math.sin((2 * Math.PI * freq * i) / fs + phaseOffset);
    }
    return buf;
  };
  const expected = 20 * Math.log10(amp);
  const peaks = [0, 0.4, 0.9, 1.4, 2.2].map((phase) => internals.truePeak(sine(phase)));
  const worst = Math.max(...peaks.map((p) => Math.abs(p - expected)));
  check(
    peaks.every((p) => p >= expected - 0.05 && p <= expected + 0.35),
    "4× true peak recovers the crest at every phase",
    `worst ${worst.toFixed(2)} dB off`,
  );
  const samplePeak = (buf: Float32Array) => {
    let m = 0;
    for (const v of buf) m = Math.max(m, Math.abs(v));
    return 20 * Math.log10(m);
  };
  // fs/4 with a 45° phase offset puts every sample at 0.707 × the crest, so a
  // sample-peak meter under-reads by 3 dB and only interpolation finds the top.
  const missPeak = sine(Math.PI / 4, fs / 4);
  const tpMiss = internals.truePeak(missPeak);
  const spMiss = samplePeak(missPeak);
  check(
    spMiss < expected - 2.5 && tpMiss > spMiss + 2,
    "4× true peak finds a crest the samples miss",
    `sample ${spMiss.toFixed(2)} → true ${tpMiss.toFixed(2)} dB`,
  );
  check(
    Math.abs(tpMiss - expected) < 0.6,
    "and lands within half a dB of the real amplitude",
    `${Math.abs(tpMiss - expected).toFixed(2)} dB off`,
  );
  const offset = sine(1.4);
  check(
    internals.truePeak(offset) >= samplePeak(offset) - 0.01,
    "true peak is never below the sample peak",
    `${internals.truePeak(offset).toFixed(2)} vs ${samplePeak(offset).toFixed(2)} dB`,
  );
  const silence = new Float32Array(n);
  check(internals.truePeak(silence) <= -100, "silence reads as silence", `${internals.truePeak(silence).toFixed(1)} dB`);
}

// monitor mute survives a parameter re-apply
engine.apply(DEFAULT_PARAMS);
engine.setMonitorMuted(true);
check(internals.monitorGain.gain.value === 0, "monitor mute zeroes the monitor bus");
engine.apply({ ...DEFAULT_PARAMS, inputGainDb: 3 });
check(
  internals.monitorGain.gain.value === 0,
  "re-applying the chain does not un-mute the monitor",
);
engine.setMonitorMuted(false);
check(
  near(internals.monitorGain.gain.value, dbToGain(DEFAULT_PARAMS.monitorDb)),
  "un-muting restores the configured monitor level",
  `${internals.monitorGain.gain.value.toFixed(3)}`,
);

// dual-window AGC: fast peak window ahead of the slow leveller
engine.apply(DEFAULT_PARAMS);
check(
  near(internals.agcFastComp.ratio.value, 1) && internals.agcFastComp.threshold.value === 0,
  "the fast window is unity when bypassed",
  `ratio ${internals.agcFastComp.ratio.value} / thr ${internals.agcFastComp.threshold.value}`,
);
engine.apply({
  ...DEFAULT_PARAMS,
  agc: { ...DEFAULT_PARAMS.agc, fast: { on: true, thresholdDb: -6, ratio: 6, kneeDb: 0, attackMs: 2, releaseMs: 180 } },
});
check(
  near(internals.agcFastComp.threshold.value, -6) &&
    near(internals.agcFastComp.ratio.value, 6) &&
    near(internals.agcFastComp.release.value, 0.18),
  "the fast window carries its own threshold, ratio and release",
  `${internals.agcFastComp.threshold.value} dB · ${internals.agcFastComp.ratio.value}:1 · ${internals.agcFastComp.release.value}s`,
);
check(
  near(internals.agcComp.threshold.value, DEFAULT_PARAMS.agc.thresholdDb) &&
    near(internals.agcComp.release.value, DEFAULT_PARAMS.agc.releaseMs / 1000),
  "and the leveller keeps its own settings",
  `${internals.agcComp.threshold.value} dB · ${(internals.agcComp.release.value * 1000).toFixed(0)} ms`,
);
engine.apply({ ...DEFAULT_PARAMS, agc: { ...DEFAULT_PARAMS.agc, on: false } });
check(
  near(internals.agcFastComp.ratio.value, 1),
  "bypassing the AGC also stands the fast window down",
);

// clipper: bypassed by default, blended when engaged, curve bounded
engine.apply(DEFAULT_PARAMS);
check(
  internals.clipWet.gain.value === 0 && internals.clipDry.gain.value === 1,
  "the clipper is bypassed in the default chain",
);
engine.apply({
  ...DEFAULT_PARAMS,
  limiter: { ...DEFAULT_PARAMS.limiter, clipper: { on: true, thresholdDb: -3, mix: 60 } },
});
check(
  near(internals.clipWet.gain.value, 0.6) && near(internals.clipDry.gain.value, 0.4),
  "the mix control blends clipped and dry program",
  `${internals.clipWet.gain.value.toFixed(2)} / ${internals.clipDry.gain.value.toFixed(2)}`,
);
const clipCurve = internals.clipShaper.curve as Float32Array | null;
const clipT = dbToGain(-3);
check(
  !!clipCurve && clipCurve.length > 1000 && Math.max(...Array.from(clipCurve, Math.abs)) <= clipT + 1e-6,
  "the clipper curve never exceeds its threshold",
  `${clipT.toFixed(3)}`, 
);
{
  const n = clipCurve?.length ?? 0;
  const i = Math.floor(n / 2) + 20;
  const x = n ? -1 + (2 * i) / (n - 1) : 0;
  check(
    !!clipCurve && near(clipCurve[i], x, 1e-6),
    "quiet program passes the clipper untouched",
    `${clipCurve?.[i].toFixed(4)} vs ${x.toFixed(4)}`,
  );
}

engine.apply({ ...DEFAULT_PARAMS, deess: { ...DEFAULT_PARAMS.deess, freqHz: 9000 } });
check(internals.deessBpAudio.frequency.value === 9000 && internals.deessBpDet.frequency.value === 9000, "retuning moves audio and detector together", "9 kHz");
engine.apply({ ...DEFAULT_PARAMS, deess: { ...DEFAULT_PARAMS.deess, on: false } });
check(internals.deessSub.gain.value === 0, "bypass removes the cut");

// chain order: the de-esser must sit BEFORE the limiter, not beside it
const edge = (a: FakeNode, b: FakeNode) =>
  EDGES.some(([from, to]) => from === a.id && to === b.id);
check(edge(internals.deessOut, internals.limWetPre), "the de-esser feeds the limiter input");
check(!edge(internals.deessOut, internals.limComp), "it never feeds the limiter directly");
check(
  edge(internals.limWetPre, internals.limDrive),
  "the density drive sits between the de-esser and the limiter",
);
// the soft clipper is inserted at that same point: drive → (dry ∥ clipped) →
// limiter, so the peak stage sees shaved transients instead of driving itself
// into a harder knee.
check(
  edge(internals.limDrive, internals.clipShaper) &&
    edge(internals.clipShaper, internals.clipWet) &&
    edge(internals.clipWet, internals.limComp) &&
    edge(internals.limDrive, internals.clipDry) &&
    edge(internals.clipDry, internals.limComp),
  "the soft clipper sits between the drive and the limiter",
);
// the dual-window AGC is a chain: fast peak → slow leveller → makeup
{
  check(
    edge(internals.agcWetPre, internals.agcFastComp) &&
      edge(internals.agcFastComp, internals.agcComp) &&
      edge(internals.agcComp, internals.agcMakeup),
    "the fast window sits ahead of the leveller in the chain",
  );
}

// the phase cascade is a chain, not parallel stages
check(
  internals.phaseStages.every((n, i) => i === 0 || edge(internals.phaseStages[i - 1], n)),
  "the four allpass stages are connected in series",
);

console.log(`\n${passed} checks passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
