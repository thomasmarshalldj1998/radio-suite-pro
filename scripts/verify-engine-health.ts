/**
 * Engine status, clock-drift arithmetic and recovery:
 *
 *   bun scripts/verify-engine-health.ts
 *
 * The console's reported faults all came from the status layer rather than the
 * DSP, so this suite pins down exactly what each status means:
 *
 *   · a suspended context is NO OUTPUT, not "live" (a suspended analyser keeps
 *     its last buffer, so meters moving proves nothing);
 *   · loudness still measuring and an unconfigured stream are not faults;
 *   · a stall is a measured render underrun, normalised per second, and a
 *     background-tab gap or a suspend is not a stall;
 *   · recovery resumes the device and reopens the output once, without a loop.
 *
 * The AudioContext here is a stand-in: this proves the status decisions and the
 * recovery sequence, not that a speaker sounds right.
 */
import { DEFAULT_PARAMS } from "../src/lib/audio/params";
import {
  IDLE_HEALTH,
  INPUT_TIMEOUT_MS,
  OUTPUT_TIMEOUT_MS,
  deriveEngineHealth,
  phaseAdvice,
  type EnginePhase,
  type HealthFacts,
} from "../src/lib/audio/health";
import { driftPerSecond } from "../src/lib/audio/glitch";

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

/* ── facts ─────────────────────────────────────────────────────────────── */

/** A healthy, clocking chain with programme and a -6 dB monitor. */
const HEALTHY: HealthFacts = {
  powered: true,
  starting: false,
  bootError: null,
  uptimeMs: 30_000,
  contextState: "running",
  everClocked: true,
  programmeDb: -18,
  outPeakDb: -14,
  silentForMs: 0,
  outSilentForMs: 0,
  monitorMuted: false,
  monitorDb: -6,
  sinkRefused: false,
  sinkVirtual: false,
  sinkLabel: "System default",
  stalls: 0,
  stalledNow: false,
  lastStallAgoMs: Infinity,
  clipOut: false,
  loudnessMeasuring: false,
  measureMs: 60_000,
  streamOnAir: false,
  streamConfigured: false,
};

const facts = (patch: Partial<HealthFacts> = {}): HealthFacts => ({
  ...HEALTHY,
  ...patch,
});

const phaseOf = (patch: Partial<HealthFacts> = {}): EnginePhase =>
  deriveEngineHealth(facts(patch)).phase;

const checkOf = (h: ReturnType<typeof deriveEngineHealth>, id: string) =>
  h.checks.find((c) => c.id === id);

/* ── 1 · the seven phases ─────────────────────────────────────────────── */

console.log("\n1 · phases");

check(phaseOf({ powered: false, contextState: "none" }) === "stopped", "unpowered engine is STOPPED");
check(
  phaseOf({ powered: false, bootError: "NotAllowedError: blocked" }) === "error",
  "an initialisation failure with no graph is ERROR",
);
check(
  phaseOf({ powered: false, starting: true }) === "starting",
  "a start request in flight is STARTING",
);
check(phaseOf() === "live", "clocking context with signal and an open monitor is LIVE");
check(phaseOf({ stalledNow: true }) === "degraded", "a live stall is DEGRADED");
check(phaseOf({ stalledNow: true, lastStallAgoMs: 500 }) === "degraded", "a recent stall is DEGRADED");
check(
  phaseOf({ stalledNow: false, lastStallAgoMs: 60_000 }) === "live",
  "a stall from a minute ago has recovered to LIVE",
);
check(phaseOf({ clipOut: true }) === "degraded", "measured output clipping is DEGRADED");
check(
  phaseOf({ contextState: "suspended" }) === "no-output",
  "a suspended context is NO OUTPUT, not live",
);
check(
  deriveEngineHealth(facts({ contextState: "suspended" })).summary.includes("asleep"),
  "and the summary says the output is asleep",
);
check(
  deriveEngineHealth(
    facts({ contextState: "suspended", everClocked: false }),
  ).summary.includes("has not started yet"),
  "a context that never clocked says the device has not started, not that it fell asleep",
);
check(
  phaseOf({
    programmeDb: -120,
    silentForMs: INPUT_TIMEOUT_MS + 1000,
    outPeakDb: -120,
    outSilentForMs: OUTPUT_TIMEOUT_MS + 1000,
  }) === "no-input",
  "with both input and output missing, the source is reported — not the processor",
);
check(
  phaseOf({ programmeDb: -120, silentForMs: INPUT_TIMEOUT_MS + 1000 }) === "no-input",
  "no programme past the timeout is NO INPUT",
);
check(
  phaseOf({ programmeDb: -120, silentForMs: 1200, uptimeMs: 1200 }) === "live",
  "silence inside the grace window is not a fault",
);
check(
  phaseOf({ outPeakDb: -120, outSilentForMs: OUTPUT_TIMEOUT_MS + 500 }) === "no-output",
  "input present but no processed signal is NO OUTPUT",
);
check(phaseOf({ monitorMuted: true, monitorDb: -Infinity }) === "no-output", "a muted monitor is NO OUTPUT");
check(
  deriveEngineHealth(facts({ monitorMuted: true, monitorDb: -Infinity })).summary.includes("muted"),
  "and says the monitor is muted rather than blaming the chain",
);
check(
  phaseOf({ sinkRefused: true }) === "no-output",
  "a speaker that refused the switch is NO OUTPUT",
);
check(
  phaseOf({ sinkVirtual: true }) === "live" &&
    checkOf(deriveEngineHealth(facts({ sinkVirtual: true })), "output")?.state === "warn",
  "a loopback endpoint is LIVE with a warning on the speaker route",
);
check(
  phaseOf({ monitorMuted: true, monitorDb: -Infinity, streamOnAir: true, streamConfigured: true }) ===
    "live",
  "a muted monitor does not take the console down while the stream is on air",
);

/* ── 2 · what must not be called a fault ──────────────────────────────── */

console.log("\n2 · no false faults");

check(
  phaseOf({ loudnessMeasuring: true, measureMs: 4000 }) === "live",
  "loudness still measuring does not degrade the engine",
);
check(
  phaseOf({ streamConfigured: false }) === "live" &&
    checkOf(deriveEngineHealth(facts()), "delivery")?.state === "idle",
  "an unconfigured stream is idle delivery, never a chain fault",
);
check(
  phaseOf({ streamConfigured: true, streamOnAir: false }) === "live" &&
    checkOf(deriveEngineHealth(facts({ streamConfigured: true })), "delivery")?.state === "warn",
  "a configured stream that is off air warns without degrading the chain",
);
check(
  checkOf(deriveEngineHealth(facts()), "delivery")?.detail.includes("local monitoring only"),
  "and the idle delivery text says monitoring-only",
);
check(
  IDLE_HEALTH.phase === "stopped" && IDLE_HEALTH.checks.length === 6,
  "the idle HUD health is STOPPED with all six checks",
);

/* ── 3 · the check list ───────────────────────────────────────────────── */

console.log("\n3 · check list");

const live = deriveEngineHealth(facts());
check(
  live.checks.map((c) => c.id).join(",") ===
    "context,input,dsp,signal,output,delivery",
  "checks are reported in signal order",
  live.checks.map((c) => c.id).join(" → "),
);
check(
  live.checks.filter((c) => c.state === "pass").length === 5,
  "a healthy chain passes context/input/dsp/signal/output",
  `${live.checks.filter((c) => c.state === "pass").length} passing`,
);
check(
  learnAllPhases().every((p) => phaseAdvice({ ...live, phase: p }).length > 20),
  "every phase has a plain-English explanation",
);
check(
  deriveEngineHealth(facts({ stalledNow: true, clipOut: true })).faults.length === 2,
  "both active faults are listed, not just the first",
);

/* ── 4 · clock-drift arithmetic ───────────────────────────────────────── */

console.log("\n4 · clock drift");

check(driftPerSecond({ intervalMs: 1000, audioMs: 1000, running: true }) === 0, "a perfect clock is 0 ms/s");
check(
  Math.abs((driftPerSecond({ intervalMs: 1000, audioMs: 994, running: true }) ?? 0) + 6) < 1e-9,
  "6 ms lost in one second reads -6 ms/s",
);
check(
  Math.abs((driftPerSecond({ intervalMs: 1500, audioMs: 1494, running: true }) ?? 0) + 4) < 1e-9,
  "6 ms lost over 1.5 s is normalised to -4 ms/s, not -6",
);
check(
  Math.abs((driftPerSecond({ intervalMs: 1200, audioMs: 1224, running: true }) ?? 0) - 20) < 1e-9,
  "a clock that ran ahead reads positive",
);
check(
  driftPerSecond({ intervalMs: 1000, audioMs: 900, running: false }) === null,
  "a suspended context yields no reading",
);
check(
  driftPerSecond({ intervalMs: 400, audioMs: 396, running: true }) === null,
  "a window too short to resolve a rate is rejected",
);
check(
  driftPerSecond({ intervalMs: 4200, audioMs: 4150, running: true }) === null,
  "a background-tab gap is rejected rather than reported as a stall",
);
check(
  driftPerSecond({ intervalMs: Number.NaN, audioMs: 1000, running: true }) === null,
  "non-finite input is rejected",
);

/* ── 5 · the engine's own facts ───────────────────────────────────────── */

console.log("\n5 · engine facts");

/* Minimal Web Audio stand-in — every node type the graph builds. */
class Param {
  value: number;
  constructor(v = 0) {
    this.value = v;
  }
  setTargetAtTime(v: number) {
    this.value = v;
  }
  setValueAtTime(v: number) {
    this.value = v;
  }
  linearRampToValueAtTime(v: number) {
    this.value = v;
  }
  cancelScheduledValues() {
    /* no automation */
  }
  setValueCurveAtTime() {
    /* no automation */
  }
}
class Node {
  connections: Node[] = [];
  connect(to: Node): this {
    this.connections.push(to);
    return this;
  }
  disconnect() {
    this.connections = [];
  }
}
const gainNode = () => Object.assign(new Node(), { gain: new Param(1) });
const filterNode = () =>
  Object.assign(new Node(), {
    type: "lowpass",
    frequency: new Param(1000),
    Q: new Param(1),
    gain: new Param(0),
    detune: new Param(0),
  });

class MockContext {
  state: AudioContextState = "running";
  sampleRate = 48000;
  currentTime = 0;
  baseLatency = 0.005;
  outputLatency = 0.01;
  audioWorklet = undefined as unknown;
  onstatechange: (() => void) | null = null;
  destination = new Node();
  resumes = 0;
  /** When true, resume() resolves but the device never starts clocking. */
  refuseResume = false;
  createGain = gainNode;
  createBiquadFilter = filterNode;
  createDynamicsCompressor = () =>
    Object.assign(new Node(), {
      threshold: new Param(),
      knee: new Param(),
      ratio: new Param(),
      attack: new Param(),
      release: new Param(),
      reduction: 0,
    });
  createAnalyser = () =>
    Object.assign(new Node(), {
      fftSize: 2048,
      smoothingTimeConstant: 0.8,
      get frequencyBinCount() {
        return 1024;
      },
      getFloatTimeDomainData(out: Float32Array) {
        out.fill(0);
      },
      getByteFrequencyData(out: Uint8Array) {
        out.fill(0);
      },
      getFloatFrequencyData(out: Float32Array) {
        out.fill(-100);
      },
    });
  createWaveShaper = () =>
    Object.assign(new Node(), { oversample: "none", curve: null as Float32Array | null });
  createChannelSplitter = () => new Node();
  createChannelMerger = () => new Node();
  createBufferSource = () =>
    Object.assign(new Node(), { buffer: null, loop: false, start() {}, stop() {} });
  createOscillator = () =>
    Object.assign(new Node(), {
      type: "sine",
      frequency: new Param(440),
      start() {},
      stop() {},
    });
  createMediaElementSource = () => new Node();
  createMediaStreamSource = () => new Node();
  createMediaStreamDestination = () => Object.assign(new Node(), { stream: {} });
  createBuffer = (channels: number, length: number) => {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return {
      numberOfChannels: channels,
      length,
      sampleRate: this.sampleRate,
      duration: length / this.sampleRate,
      getChannelData: (ch: number) => data[ch],
    };
  };
  async resume() {
    this.resumes += 1;
    if (!this.refuseResume) this.state = "running";
  }
  async suspend() {
    this.state = "suspended";
  }
  async close() {
    this.state = "closed";
  }
}

const store = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  },
});
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: {
    mediaDevices: {
      enumerateDevices: async () => [],
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      getUserMedia: async () => {
        throw new Error("no hardware in this suite");
      },
    },
    permissions: { query: async () => ({ state: "granted" }) },
  },
});
(globalThis as unknown as Record<string, unknown>).requestAnimationFrame = () => 0;
(globalThis as unknown as Record<string, unknown>).cancelAnimationFrame = () => undefined;

const { AudioEngine } = await import("../src/lib/audio/engine");

/** The engine's construction seam and graph builder, reached for the stubs. */
type Internals = Record<string, unknown> & {
  createContext: () => AudioContext;
  buildGraph: (ctx: AudioContext) => void;
  heavyTick: (now: number) => void;
};

const ctx = new MockContext();
const engine = new AudioEngine();
const internal = engine as unknown as Internals;
internal.createContext = () => ctx as unknown as AudioContext;

check(engine.health().phase === "stopped", "a fresh engine reports STOPPED");

await engine.powerOn();
engine.apply(DEFAULT_PARAMS);
check(engine.powered && engine.ctx?.state === "running", "powerOn brings the context up");
check(engine.health().phase === "live", "a freshly powered chain is LIVE inside the grace window");

const d = engine.diagnostics;
check(d.contextState === "running", "diagnostics report the context state", d.contextState);
check(d.sampleRate === 48000, "diagnostics report the device rate", `${d.sampleRate} Hz`);
check(d.channels === 2, "the program bus is two channels", `${d.channels} ch`);
check(
  Math.abs(d.baseFrames - 240) <= 2,
  "base latency is reported in frames from the device's own figure",
  `${d.baseFrames} frames`,
);
check(d.workletLimiter === false, "with no AudioWorklet the limiter reports native", String(d.workletLimiter));

const factsAfterBoot = engine.healthFacts();
check(
  Math.abs(factsAfterBoot.monitorDb + 6) < 0.2,
  "health facts carry the monitor bus level",
  `${factsAfterBoot.monitorDb.toFixed(2)} dB`,
);
check(factsAfterBoot.everClocked, "the engine records that the context has clocked");

engine.setMonitorMuted(true);
check(engine.health().phase === "no-output", "muting the monitor turns the status to NO OUTPUT");
engine.setMonitorMuted(false);
check(engine.health().phase === "live", "un-muting recovers the status without a restart");

// A suspended context must not accrue measurement time or gated blocks: the
// analyser is repeating its last buffer, not measuring programme.
const t0 = performance.now();
internal.heavyTick(t0);
internal.heavyTick(t0 + 120);
const measureRunning = engine.snapshot().measureMs;
check(
  measureRunning > 0,
  "a running context accrues integrated-measurement time",
  `${measureRunning.toFixed(0)} ms`,
);
ctx.state = "suspended";
internal.heavyTick(t0 + 400);
internal.heavyTick(t0 + 900);
check(
  engine.snapshot().measureMs === measureRunning,
  "a suspended context adds no integrated-measurement time",
  `${engine.snapshot().measureMs.toFixed(0)} ms`,
);
const suspended = engine.health();
check(suspended.phase === "no-output", "a suspended context is NO OUTPUT");
check(
  checkOf(suspended, "context")?.state === "fail",
  "and the context check is the one that failed",
);

/* ── 6 · recovery ─────────────────────────────────────────────────────── */

console.log("\n6 · recovery");

const resumesBefore = ctx.resumes;
const p1 = engine.recover();
const p2 = engine.recover();
check(internal.recoveryArm !== null, "a recovery is tracked as one attempt in flight");
const [r1, r2] = await Promise.all([p1, p2]);
check(r1 && r2, "both concurrent recoveries report success");
check(
  ctx.resumes === resumesBefore + 1,
  "and resume the device exactly once between them",
  `${ctx.resumes - resumesBefore} call(s)`,
);
check(engine.ctx?.state === "running", "the context is running afterwards");
check(internal.outputOpen === true, "the output bus is faded back in");
check(engine.health().phase === "live", "and the status recovers to LIVE");

// A second attempt inside the cooldown must not touch the device again.
const resumesAfter = ctx.resumes;
check(await engine.recover(), "a recovery inside the cooldown still reports the current state");
check(ctx.resumes === resumesAfter, "without calling resume again");

// A device that refuses: the status stays honest and recovery says so.
const stubborn = new MockContext();
stubborn.state = "suspended";
stubborn.refuseResume = true;
const stuck = new AudioEngine();
const stuckInternal = stuck as unknown as Internals;
stuckInternal.createContext = () => stubborn as unknown as AudioContext;
stuckInternal.ctx = stubborn;
stuckInternal.graphReady = true;
stuckInternal.powered = true;
stuckInternal.poweredAt = Date.now();
stuckInternal.buildGraph(stubborn as unknown as AudioContext);
stuck.setMonitorMuted(false);

check(await stuck.recover() === false, "a device that will not start reports failure");
check(stuck.diagnostics.lastFault !== null, "and the fault is recorded with a message");
check(
  (stuck.diagnostics.lastFault?.message ?? "").toLowerCase().includes("would not"),
  "the recorded fault explains the browser refused the device",
  stuck.diagnostics.lastFault?.message,
);
const stubbornResumes = stubborn.resumes;
await stuck.recover();
check(stubborn.resumes === stubbornResumes, "a failed recovery is not retried inside the cooldown");
check(stuck.health().phase === "no-output", "and the status stays NO OUTPUT rather than claiming live");

/* ── summary ──────────────────────────────────────────────────────────── */

console.log(`\n${passed} checks passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);

/** Every phase, for the advice sweep. */
function learnAllPhases(): EnginePhase[] {
  return [
    "stopped",
    "starting",
    "live",
    "degraded",
    "no-input",
    "no-output",
    "error",
  ];
}
