/**
 * On-air broadcast delay (profanity delay).
 *
 *   bun scripts/verify-air-delay.ts
 *
 * The delay is the one stage in the chain whose failure is unrecoverable: if a
 * dump clicks, the station has broadcast a click; if the rebuild plays at the
 * wrong rate, the station has broadcast a pitch shift. The engine is driven
 * here against a stand-in AudioContext that records every scheduled automation
 * event, so the guarantees can be checked without ears:
 *
 *   · arming on a cold graph grows the delay at true speed instead of
 *     replaying the empty buffer;
 *   · arming a primed line seats the tap at the full delay immediately;
 *   · a dump is an 8 ms crossfade onto a live tap, and the rebuild ramp has a
 *     slope of 1.0 (true-speed playback, no pitch shift);
 *   · a dump is refused when the delay is bypassed or the engine is stopped;
 *   · old saves and presets coerce to a bypassed delay.
 */
import { AudioEngine } from "../src/lib/audio/engine";
import { DEFAULT_PARAMS, coerceParams, type ProcessorParams } from "../src/lib/audio/params";

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

interface Event {
  type: "set" | "linear";
  value: number;
  at: number;
}

class FakeParam {
  value = 0;
  events: Event[] = [];
  setTargetAtTime(v: number) {
    this.value = v;
  }
  setValueAtTime(v: number, at = 0) {
    this.value = v;
    this.events.push({ type: "set", value: v, at });
  }
  linearRampToValueAtTime(v: number, at = 0) {
    this.value = v;
    this.events.push({ type: "linear", value: v, at });
  }
  cancelScheduledValues() {
    /* history is kept for the assertions */
  }
  /** Last scheduled event of a kind. */
  last(type: Event["type"]): Event | undefined {
    for (let i = this.events.length - 1; i >= 0; i--) {
      if (this.events[i].type === type) return this.events[i];
    }
    return undefined;
  }
}

class FakeNode {
  gain = new FakeParam();
  delayTime = new FakeParam();
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
  return {
    state: "running",
    sampleRate,
    currentTime: 0,
    baseLatency: 0.01,
    outputLatency: 0.02,
    onstatechange: null as null | (() => void),
    destination: new FakeNode(),
    createGain: () => new FakeNode(),
    createDelay: () => new FakeNode(),
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
}

interface Internals {
  ctx: unknown;
  powered: boolean;
  graphStartAt: number;
  buildGraph: (ctx: unknown) => void;
  apply: (p: ProcessorParams) => void;
  dumpDelay: () => boolean;
  getDelayStatus: () => {
    enabled: boolean;
    seconds: number;
    live: boolean;
    rebuildMs: number;
    dumps: number;
  };
  delayTaps: FakeNode[];
  delayTapGains: FakeNode[];
  delayDry: FakeNode;
}

function boot(sampleRate = 48000): Internals {
  const engine = new AudioEngine();
  const internals = engine as unknown as Internals;
  const ctx = fakeContext(sampleRate);
  internals.ctx = ctx;
  internals.buildGraph(ctx);
  internals.powered = true;
  internals.apply(DEFAULT_PARAMS);
  return internals;
}

const delayOn = (seconds: number): ProcessorParams => ({
  ...DEFAULT_PARAMS,
  delay: { on: true, seconds },
});

/* ── 1 · defaults and old saves ────────────────────────────────────────── */

console.log("\n1 · parameter compatibility");
{
  check(DEFAULT_PARAMS.delay.on === false, "the delay ships bypassed");
  check(DEFAULT_PARAMS.delay.seconds === 7, "seven seconds is the default time");

  const legacy = { ...DEFAULT_PARAMS } as Record<string, unknown>;
  delete legacy.delay;
  const coerced = coerceParams(legacy);
  check(
    coerced.delay.on === false && coerced.delay.seconds === 7,
    "a save from before v3.0.0 coerces to a bypassed delay",
  );
  check(coerceParams({}).delay.seconds === 7, "an empty save gets the same neutral block");
}

/* ── 2 · arming a cold line ───────────────────────────────────────────── */

console.log("\n2 · arming");
{
  const g = boot();
  g.apply(delayOn(7));
  const status = g.getDelayStatus();
  const ramp = g.delayTaps[0].delayTime.last("linear");

  check(status.enabled, "the module reports engaged");
  check(
    status.live && status.rebuildMs > 6_000,
    "a cold line arms live and reports a rebuild",
    `${status.rebuildMs} ms`,
  );
  check(
    !!ramp && Math.abs(ramp.value - 7) < 1e-6,
    "the rebuild ramp targets the configured delay",
    `${ramp?.value ?? "none"} s`,
  );
  check(
    g.delayTaps[1].delayTime.value === 0,
    "the standby tap is parked at 0 s (live)",
  );
  check(
    g.delayTapGains[0].gain.last("linear")?.value === 1 &&
      g.delayDry.gain.last("linear")?.value === 0,
    "the delayed leg is faded in and the dry leg out",
  );
}

/* ── 3 · arming a primed line ─────────────────────────────────────────── */

console.log("\n3 · primed line");
{
  const g = boot();
  g.graphStartAt = performance.now() - 20_000;
  g.apply(delayOn(7));
  check(g.getDelayStatus().live === false, "a primed line seats the delay immediately");
  check(
    g.delayTaps[0].delayTime.value === 7 && !g.delayTaps[0].delayTime.last("linear"),
    "the tap is set once, with no rebuild ramp",
    `${g.delayTaps[0].delayTime.value} s`,
  );

  g.apply({ ...DEFAULT_PARAMS, delay: { on: false, seconds: 7 } });
  check(g.delayDry.gain.last("linear")?.value === 1, "releasing fades the dry leg back in");
  check(!g.dumpDelay(), "a bypassed delay refuses to dump");
}

/* ── 4 · dump geometry ────────────────────────────────────────────────── */

console.log("\n4 · dump");
{
  const g = boot();
  g.graphStartAt = performance.now() - 20_000;
  g.apply(delayOn(6.5));
  const before = g.delayTapGains[0].gain.value;

  check(g.dumpDelay(), "a dump is accepted while engaged and powered");
  const status = g.getDelayStatus();
  check(status.dumps === 1, "the dump is counted", `${status.dumps}`);
  check(status.live && status.rebuildMs > 6_000, "the line is marked rebuilding");

  const out = g.delayTapGains[0].gain.last("linear");
  const into = g.delayTapGains[1].gain.last("linear");
  check(before === 1 && out?.value === 0, "the audible tap fades out");
  check(into?.value === 1, "the live tap fades in");
  check(
    !!out && !!into && Math.abs((out.at as number) - (into.at as number)) < 1e-9,
    "both legs share one crossfade window",
  );

  const tap = g.delayTaps[1];
  const parked = tap.delayTime.last("set");
  check(parked?.value === 0, "the incoming tap is parked at live first");
  const ramp = tap.delayTime.last("linear");
  // Slope of the scheduled ramp between its own endpoints, not from t=0.
  const slope = ramp
    ? (ramp.value - (parked?.value ?? 0)) / (ramp.at - (parked?.at ?? 0))
    : 0;
  check(
    !!ramp && Math.abs(ramp.value - 6.5) < 1e-6,
    "the rebuild ramp targets the dump's delay time",
    `${ramp?.value ?? "none"} s`,
  );
  check(
    Math.abs(slope - 1) < 0.02,
    "the rebuild ramp reads at true speed (1.0×), so nothing is pitch-shifted",
    `${slope.toFixed(4)}×`,
  );
  check(
    g.delayTapGains[1].gain.value === 1 && g.delayTapGains[0].gain.value === 0,
    "the tap roles swapped: the dumped-from line is now parked",
  );
}

/* ── 5 · the dump is refused when it cannot work ──────────────────────── */

console.log("\n5 · refusals");
{
  const g = boot();
  check(!g.dumpDelay(), "a bypassed delay refuses the dump");
  g.apply(delayOn(4));
  g.powered = false;
  check(!g.dumpDelay(), "a stopped engine refuses the dump");
  check(g.getDelayStatus().dumps === 0, "a refused dump is not counted");
}

console.log(`\n${passed} checks passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
