/**
 * Headless engine checks for the studio page:
 *
 *   bun scripts/verify-studio-engine.ts
 *
 * A mock AudioContext stands in for the browser. This does not prove the
 * signal sounds right — that needs a real device — but it does prove the
 * graph is wired without throwing, the measured frame is finite, the demo
 * program renders, and the parameter surface reaches real nodes.
 *
 *  1  the graph builds and creates the expected node counts
 *  2  a measurement pass produces a finite, sane frame
 *  3  five band meters are always present and in range
 *  4  correlation and peak reads stay inside their physical bounds
 *  5  a second preset applies cleanly over the first
 *  6  the demo program starts, measures and stops
 *  7  the scope returns real sample buffers
 */
import { PRESET_A, PRESET_B, StudioEngine } from "../src/pages/Studio";

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

/* ── mock Web Audio ────────────────────────────────────────────────────── */

class FakeParam {
  value = 0;
  setTargetAtTime(v: number) {
    this.value = v;
  }
  setValueAtTime(v: number) {
    this.value = v;
  }
  cancelScheduledValues() {
    /* no automation to cancel */
  }
}

class FakeNode {
  connect(): this {
    return this;
  }
  disconnect() {
    /* no graph to tear down */
  }
}

class FakeGain extends FakeNode {
  gain = new FakeParam();
}

class FakeFilter extends FakeNode {
  type = "lowpass";
  frequency = new FakeParam();
  Q = new FakeParam();
  gain = new FakeParam();
}

class FakeCompressor extends FakeNode {
  threshold = new FakeParam();
  knee = new FakeParam();
  ratio = new FakeParam();
  attack = new FakeParam();
  release = new FakeParam();
  reduction = -3;
}

let fakeLevel = 0.5;

class FakeAnalyser extends FakeNode {
  fftSize = 2048;
  smoothingTimeConstant = 0;
  private phase = 0;
  getFloatTimeDomainData(out: Float32Array) {
    for (let i = 0; i < out.length; i++) {
      out[i] = Math.sin((2 * Math.PI * 100 * (i + this.phase)) / 48000) * fakeLevel;
    }
    this.phase += 7;
  }
}

class FakeShaper extends FakeNode {
  oversample = "none";
  curve: Float32Array | null = null;
}

class FakeOscillator extends FakeNode {
  type = "sine";
  frequency = new FakeParam();
  start() {
    /* already running */
  }
  stop() {
    /* stopped */
  }
}

class FakeBuffer {
  numberOfChannels: number;
  length: number;
  sampleRate: number;
  private data: Float32Array[];
  constructor(channels: number, length: number, sampleRate: number) {
    this.numberOfChannels = channels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.data = Array.from({ length: channels }, () => new Float32Array(length));
  }
  getChannelData(ch: number) {
    return this.data[ch];
  }
}

class FakeSource extends FakeNode {
  buffer: FakeBuffer | null = null;
  loop = false;
  start() {
    /* playing */
  }
  stop() {
    /* stopped */
  }
}

class FakeContext {
  sampleRate = 48000;
  currentTime = 0;
  baseLatency = 0.005;
  outputLatency = 0.01;
  destination = new FakeNode();
  gains: FakeGain[] = [];
  filters: FakeFilter[] = [];
  compressors: FakeCompressor[] = [];
  analysers: FakeAnalyser[] = [];
  oscillators: FakeOscillator[] = [];
  shapers: FakeShaper[] = [];
  sources: FakeSource[] = [];

  createGain() {
    const n = new FakeGain();
    this.gains.push(n);
    return n;
  }
  createBiquadFilter() {
    const n = new FakeFilter();
    this.filters.push(n);
    return n;
  }
  createDynamicsCompressor() {
    const n = new FakeCompressor();
    this.compressors.push(n);
    return n;
  }
  createAnalyser() {
    const n = new FakeAnalyser();
    this.analysers.push(n);
    return n;
  }
  createWaveShaper() {
    const n = new FakeShaper();
    this.shapers.push(n);
    return n;
  }
  createOscillator() {
    const n = new FakeOscillator();
    this.oscillators.push(n);
    return n;
  }
  delays: { delayTime: FakeParam }[] = [];
  createDelay() {
    const node = new FakeNode() as FakeNode & { delayTime: FakeParam };
    node.delayTime = new FakeParam();
    this.delays.push(node);
    return node;
  }
  createChannelSplitter() {
    return new FakeNode();
  }
  createChannelMerger() {
    return new FakeNode();
  }
  createBuffer(channels: number, length: number, sampleRate: number) {
    return new FakeBuffer(channels, length, sampleRate);
  }
  createBufferSource() {
    const n = new FakeSource();
    this.sources.push(n);
    return n;
  }
  createMediaStreamSource() {
    return new FakeNode();
  }
  resume() {
    return Promise.resolve();
  }
  suspend() {
    return Promise.resolve();
  }
  close() {
    return Promise.resolve();
  }
}

/* ── 1: graph construction ─────────────────────────────────────────────── */

console.log("\n1 · graph");
const ctx = new FakeContext();
let engine: StudioEngine | null = null;
try {
  engine = new StudioEngine(ctx as unknown as AudioContext);
  check(true, "the engine builds a complete graph");
} catch (err) {
  check(false, "the engine builds a complete graph", (err as Error).message);
}
if (!engine) {
  console.log("\n1 checks passed, 1 failed — cannot continue without an engine.");
  process.exit(1);
}

check(ctx.compressors.length === 7, "AGC + 5 bands + limiter are all compressors", `${ctx.compressors.length}`);
check(ctx.oscillators.length === 2, "sub and upper-harmonic oscillators exist", `${ctx.oscillators.length}`);
check(ctx.filters.length >= 20, "the filter network is built", `${ctx.filters.length} biquads`);
check(ctx.analysers.length === 15, "all meter and detector taps exist", `${ctx.analysers.length} analysers`);
check(ctx.shapers.length === 2, "de-clipper and talent safety shapers both exist", `${ctx.shapers.length}`);
check(ctx.shapers.some((s) => s.oversample === "4x"), "the de-clipper is a 4× overshaper");
check(ctx.delays.length === 1, "the codec preview has its pre-echo delay", `${ctx.delays.length}`);

/* ── 2-4: measurement ──────────────────────────────────────────────────── */

console.log("\n2 · measurement");
engine.setControlState(PRESET_A);
engine.apply(PRESET_A);
for (let i = 0; i < 12; i++) engine.tickNow();
const f = engine.frame;
check(Number.isFinite(f.inputL) && f.inputL > -120, "input peak is finite and present", `${f.inputL.toFixed(1)} dBFS`);
check(f.inputL <= 6, "input peak is a plausible level", `${f.inputL.toFixed(1)} dBFS`);
check(Number.isFinite(f.truePeak), "true peak is measured", `${f.truePeak.toFixed(1)} dBTP`);
check(f.agcGr >= 0 && f.limiterGr >= 0, "gain-reduction reads are non-negative");
check(f.momentary <= 0 && f.shortTerm <= 0 && f.integrated <= 0, "loudness is a negative LUFS value");
check(Number.isFinite(f.momentary) && Number.isFinite(f.integrated), "loudness is finite");

console.log("\n3 · bands");
check(f.bandGr.length === 5, "five band meters report", `${f.bandGr.length}`);
check(f.bandGr.every((v) => Number.isFinite(v) && v >= 0 && v < 60), "every band GR is in range", f.bandGr.map((v) => v.toFixed(1)).join(" · "));

console.log("\n4 · bounds");
check(f.correlation >= -1 && f.correlation <= 1, "correlation stays in [-1, +1]", f.correlation.toFixed(3));
check(f.stereo >= 0 && f.stereo <= 100, "side energy is a percentage", `${f.stereo.toFixed(0)} %`);
check(f.silenceMs === 0, "a live signal does not trip the silence gate", `${f.silenceMs} ms`);

/* ── 5: preset swap ────────────────────────────────────────────────────── */

console.log("\n5 · preset swap");
engine.setControlState(PRESET_B);
engine.apply(PRESET_B);
engine.tickNow();
check(Number.isFinite(engine.frame.shortTerm), "the second preset applies cleanly", `${engine.frame.shortTerm.toFixed(1)} LUFS`);
check(ctx.shapers[0].curve !== null && ctx.shapers[0].curve!.length === 4096, "the de-clipper curve follows the drive", `${ctx.shapers[0].curve?.length}`);

/* ── 5b: sub cutoff ─────────────────────────────────────────────────────── */

console.log("\n5b · sub cutoff");
const lowCut = { ...PRESET_A, subCutoff: 30 };
engine.setControlState(lowCut);
engine.apply(lowCut);
for (let i = 0; i < 8; i++) engine.tickNow();
const capped = ctx.oscillators[0].frequency.value;
check(capped <= 30.01, "a 30 Hz cutoff caps the synthesised sub", `${capped.toFixed(1)} Hz`);
const highCut = { ...PRESET_A, subCutoff: 60 };
engine.setControlState(highCut);
engine.apply(highCut);
for (let i = 0; i < 8; i++) engine.tickNow();
const raised = ctx.oscillators[0].frequency.value;
check(raised > 30 && raised <= 60.01, "a 60 Hz cutoff lets it rise", `${raised.toFixed(1)} Hz`);

/* ── 5c: streaming & automation ─────────────────────────────────────── */

console.log("\n5c · codec preview");
const codecOn = { ...PRESET_A, codec: "mp3-64" as const, hfComp: true };
engine.setControlState(codecOn);
engine.apply(codecOn);
engine.tickNow();
check(
  ctx.filters.some((f) => f.type === "lowpass" && Math.abs(f.frequency.value - 11000) < 2),
  "the 64 kbps profile band-limits at 11 kHz",
);
const highBandCut = ctx.compressors[5].threshold.value;
const expectedCut = PRESET_A.bands.high.thresholdDb - 3;
check(Math.abs(highBandCut - expectedCut) < 0.05, "HF compensation trims the top band", `${highBandCut.toFixed(1)} dB`);
const codecOffHf = { ...PRESET_A, codec: "off" as const, hfComp: true };
engine.setControlState(codecOffHf);
engine.apply(codecOffHf);
check(
  Math.abs(ctx.compressors[5].threshold.value - PRESET_A.bands.high.thresholdDb) < 0.05,
  "with preview off the band is untouched",
  `${ctx.compressors[5].threshold.value.toFixed(1)} dB`,
);

console.log("\n5d · voice ducking");
const duck = { ...PRESET_A, duckOn: true, duckMicOpen: true, duckDepthDb: 6 };
engine.setControlState(duck);
engine.apply(duck);
engine.tickNow();
check(Math.abs(engine.frame.duckDb - 6) < 0.01, "an open mic ducks the bed", `${engine.frame.duckDb} dB`);
check(
  Math.abs(ctx.compressors[0].release.value - 0.25) < 0.001,
  "the AGC release follows the duck recovery time",
  `${(ctx.compressors[0].release.value * 1000).toFixed(0)} ms`,
);
const duckClosed = { ...duck, duckMicOpen: false, duckAuto: false };
engine.setControlState(duckClosed);
engine.apply(duckClosed);
engine.tickNow();
check(engine.frame.duckDb === 0, "a closed mic releases the duck");

console.log("\n5e · metadata trigger");
const talk = { ...PRESET_A, genre: "talk" as const };
engine.setControlState(talk);
engine.apply(talk);
check(engine.frame.genre === "Talk", "an explicit genre selects its profile", engine.frame.genre);
const talkTilt = ctx.filters[0].gain.value;
const hiphop = { ...PRESET_A, genre: "hiphop" as const };
engine.setControlState(hiphop);
engine.apply(hiphop);
const hiphopTilt = ctx.filters[0].gain.value;
check(hiphopTilt > talkTilt + 3, "the genre profile really moves the tone stage", `${talkTilt.toFixed(1)} dB → ${hiphopTilt.toFixed(1)} dB`);
const talkGenre = { ...PRESET_A, genre: "talk" as const };
engine.setControlState(talkGenre);
engine.apply(talkGenre);
const talkLowBand = ctx.compressors[1].threshold.value;
engine.setControlState(hiphop);
engine.apply(hiphop);
const hiphopLowBand = ctx.compressors[1].threshold.value;
check(
  hiphopLowBand < talkLowBand - 2,
  "the genre profile also shifts the multiband thresholds",
  `${talkLowBand.toFixed(1)} dB talk vs ${hiphopLowBand.toFixed(1)} dB hip-hop`,
);
const auto = { ...PRESET_A, genre: "auto" as const, metadata: "Artist - Track [EDM]" };
engine.setControlState(auto);
engine.apply(auto);
check(engine.frame.genre === "EDM", "a metadata tag switches the profile", engine.frame.genre);

console.log("\n5f · talent monitor");
const talent = { ...PRESET_A, talentMode: true };
engine.setControlState(talent);
engine.apply(talent);
check(engine.frame.talent, "talent mode reports the pre-limiter path");

console.log("\n5g · silence backup");
engine.backupHoldMs = 300;
engine.backupReturnMs = 150;
fakeLevel = 0;
engine.tickNow();
await new Promise((r) => setTimeout(r, 380));
engine.tickNow();
check(engine.frame.backup, "a 300 ms hold brings the backup on air", `${engine.frame.silenceMs.toFixed(0)} ms`);
fakeLevel = 0.5;
engine.tickNow();
engine.tickNow();
check(!engine.frame.backup, "healthy programme hands the chain back");
engine.backupHoldMs = 5000;
engine.backupReturnMs = 2000;

/* ── 6: demo program ───────────────────────────────────────────────────── */

console.log("\n6 · demo source");
let started = false;
try {
  await engine.start("demo");
  started = true;
} catch (err) {
  check(false, "the demo program starts", (err as Error).message);
}
if (started) {
  check(ctx.sources.length >= 2, "the backup and demo buffers were both created", `${ctx.sources.length} sources`);
  const demo = ctx.sources[ctx.sources.length - 1].buffer;
  check((demo?.length ?? 0) > 48000, "the generated loop is at least a second long", `${demo?.length} frames`);
  if (demo) {
    const left = demo.getChannelData(0);
    const right = demo.getChannelData(1);
    let demoTrackPeak = 0;
    let legDifference = 0;
    for (let i = 0; i < left.length; i += 97) {
      demoTrackPeak = Math.max(demoTrackPeak, Math.abs(left[i]), Math.abs(right[i]));
      legDifference += Math.abs(left[i] - right[i]);
    }
    check(demoTrackPeak > 0.5 && demoTrackPeak <= 0.9, "the loop is normalised with headroom", demoTrackPeak.toFixed(2));
    check(legDifference > 1, "the loop has a real stereo image", `${legDifference.toFixed(0)} summed difference`);
  }
  engine.tickNow();
  check(Number.isFinite(engine.frame.inputL), "the running engine keeps measuring", `${engine.frame.inputL.toFixed(1)} dBFS`);
  engine.suspend();
  check(true, "the engine suspends without throwing");
}

/* ── 7: scope ──────────────────────────────────────────────────────────── */

console.log("\n7 · scope");
const scope = engine.scope();
check(scope.l.length === 2048 && scope.r.length === 2048, "the scope returns both legs", `${scope.l.length} samples`);
check(scope.l.every((v) => Number.isFinite(v)), "scope samples are finite");

engine.dispose();
check(true, "dispose completes");

console.log(`\n${passed} checks passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
