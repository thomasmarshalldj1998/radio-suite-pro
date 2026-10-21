/**
 * Monitor-route checks for the console engine:
 *
 *   bun scripts/verify-monitor-path.ts
 *
 * Every other suite proves a *calculation*; this one proves a *route*. The
 * console's meters tap the programme bus, so a fault anywhere between that
 * tap and `ctx.destination` reads exactly the same on screen: meters moving,
 * no sound. Here the real `buildGraph` runs against a recording Web Audio
 * mock, and the gain product from the programme bus to the destination is
 * computed along every branch of the built graph.
 *
 *  1  the graph builds from the engine's own source
 *  2  the programme bus reaches ctx.destination (default parameters)
 *  3  the monitor branch is the named -6 dB stage, not a bypass
 *  4  muting the monitor silences the speakers and not the stream feed
 *  5  the monitor level control really reaches the destination
 *  6  mono fold and channel invert keep audio on the monitor
 *  7  the encoder send is independent of the monitor
 *  8  the header readout reports the bus as the node holds it
 */
import { DEFAULT_PARAMS } from "../src/lib/audio/params";

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

/* ── recording Web Audio ───────────────────────────────────────────────── */

class Param {
  value = 0;
  setTargetAtTime(v: number) {
    this.value = v;
  }
  setValueAtTime(v: number) {
    this.value = v;
  }
  cancelScheduledValues() {
    /* no automation */
  }
  setValueCurveAtTime() {
    /* no automation */
  }
}

interface Edge {
  to: Node;
  out: number;
  input: number;
}

class Node {
  kind = "node";
  connections: Edge[] = [];
  constructor(public ctx: MockContext) {
    ctx.nodes.push(this);
  }
  connect(to: Node, out = 0, input = 0): this {
    this.connections.push({ to, out, input });
    return this;
  }
  disconnect() {
    this.connections = [];
  }
}

class Gain extends Node {
  kind = "gain";
  gain = new Param();
}

class Filter extends Node {
  kind = "filter";
  type = "lowpass";
  frequency = new Param();
  Q = new Param();
  gain = new Param();
  detune = new Param();
}

class Compressor extends Node {
  kind = "compressor";
  threshold = new Param();
  knee = new Param();
  ratio = new Param();
  attack = new Param();
  release = new Param();
  reduction = 0;
}

class Analyser extends Node {
  kind = "analyser";
  fftSize = 2048;
  smoothingTimeConstant = 0;
  get frequencyBinCount() {
    return this.fftSize / 2;
  }
  getFloatTimeDomainData(out: Float32Array) {
    out.fill(0.1);
  }
  getFloatFrequencyData(out: Float32Array) {
    out.fill(-90);
  }
  getByteFrequencyData(out: Uint8Array) {
    out.fill(0);
  }
}

class Shaper extends Node {
  kind = "shaper";
  oversample = "none";
  curve: Float32Array | null = null;
}

class Splitter extends Node {
  kind = "splitter";
  constructor(
    ctx: MockContext,
    public outputs: number,
  ) {
    super(ctx);
  }
}

class Merger extends Node {
  kind = "merger";
  constructor(
    ctx: MockContext,
    public inputs: number,
  ) {
    super(ctx);
  }
}

class BufferSource extends Node {
  kind = "bufferSource";
  buffer: unknown = null;
  loop = false;
  start() {}
  stop() {}
}

class Oscillator extends Node {
  kind = "oscillator";
  type = "sine";
  frequency = new Param();
  start() {}
  stop() {}
}

class StreamDest extends Node {
  kind = "streamDest";
  stream = {};
}

class MockContext {
  sampleRate = 48000;
  currentTime = 0;
  state = "running";
  baseLatency = 0.005;
  outputLatency = 0.01;
  nodes: Node[] = [];
  destination = new Node(this);
  audioWorklet = undefined as unknown;
  onstatechange: (() => void) | null = null;

  createGain() {
    return new Gain(this);
  }
  createBiquadFilter() {
    return new Filter(this);
  }
  createDynamicsCompressor() {
    return new Compressor(this);
  }
  createAnalyser() {
    return new Analyser(this);
  }
  createWaveShaper() {
    return new Shaper(this);
  }
  createChannelSplitter(n = 2) {
    return new Splitter(this, n);
  }
  createChannelMerger(n = 2) {
    return new Merger(this, n);
  }
  createBufferSource() {
    return new BufferSource(this);
  }
  createOscillator() {
    return new Oscillator(this);
  }
  createMediaStreamDestination() {
    return new StreamDest(this);
  }
  createMediaStreamSource() {
    return new Node(this);
  }
  createDelay() {
    const n = new Node(this) as Node & { delayTime: Param };
    n.delayTime = new Param();
    return n;
  }
  createBuffer(channels: number, length: number, sampleRate: number) {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return {
      numberOfChannels: channels,
      length,
      sampleRate,
      duration: length / sampleRate,
      getChannelData: (ch: number) => data[ch],
    };
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

/* ── environment the engine touches ────────────────────────────────────── */

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

/* ── 1 · the graph ─────────────────────────────────────────────────────── */

console.log("\n1 · graph");
const ctx = new MockContext();
const engine = new AudioEngine();
const internal = engine as unknown as Record<string, any>;
internal.ctx = ctx;
try {
  internal.buildGraph(ctx as unknown as AudioContext);
  engine.apply(DEFAULT_PARAMS);
  check(true, "the real buildGraph accepts the mock context", `${ctx.nodes.length} nodes`);
} catch (err) {
  check(false, "the real buildGraph accepts the mock context", (err as Error).message);
  console.log(`\n${passed} checks passed, ${failed + 1} failed.`);
  process.exit(1);
}

/**
 * Best gain product from one node to another through the *recorded* edges.
 *
 * Recursion is memoised per target, so parallel branches cost one visit each
 * rather than one per path — the built graph has millions of source→output
 * routes and only their maximum matters here.
 */
function bestGain(start: Node, target: Node): number {
  const memo = new Map<Node, number>();
  const onStack = new Set<Node>();
  const best = (node: Node): number => {
    if (node === target) return 1;
    if (onStack.has(node)) return 0; // cycle: no contribution
    const cached = memo.get(node);
    if (cached !== undefined) return cached;
    onStack.add(node);
    let top = 0;
    for (const edge of node.connections) {
      const step = edge.to instanceof Gain ? (edge.to.gain.value as number) : 1;
      const rest = best(edge.to);
      if (step > 0 && rest > 0) top = Math.max(top, step * rest);
    }
    onStack.delete(node);
    memo.set(node, top);
    return top;
  };
  return best(start);
}

const source = internal.sourceBus as Node;
const duck = internal.duckGain as Node;
const monitor = internal.monitorGain as Gain;
const destination = ctx.destination;
const streamDest = internal.streamDest as StreamDest;

const close = (a: number, b: number, tol = 1e-3) => Math.abs(a - b) < tol;
const monitorDb = () => 20 * Math.log10(Math.max(1e-9, bestGain(duck, destination)));

/* ── 2 · the route ─────────────────────────────────────────────────────── */

console.log("\n2 · programme reaches the output");
const programGain = bestGain(source, destination);
check(programGain > 0.5, "the programme bus has a live route to the destination", programGain.toFixed(3));
check(Number.isFinite(programGain), "and the route is finite, not a runaway loop");
check(
  close(bestGain(duck, destination), Math.pow(10, DEFAULT_PARAMS.monitorDb / 20)),
  "the monitor tap is the programmed level, not a bypass",
  `${monitorDb().toFixed(2)} dB`,
);
check(
  (internal.monL as Gain).gain.value === 1 && (internal.monR as Gain).gain.value === 1,
  "both monitor legs are open",
  `${(internal.monL as Gain).gain.value} / ${(internal.monR as Gain).gain.value}`,
);

/* ── 3 · mute ──────────────────────────────────────────────────────────── */

console.log("\n3 · monitor mute");
engine.setMonitorMuted(true);
check(monitor.gain.value === 0, "muting zeroes the monitor stage", monitor.gain.value.toFixed(3));
check(bestGain(duck, destination) === 0, "so nothing of the programme reaches the speakers");
check(
  close(bestGain(duck, streamDest), 1),
  "the stream feed is untouched by the monitor mute",
  bestGain(duck, streamDest).toFixed(3),
);
engine.setMonitorMuted(false);
check(monitor.gain.value > 0.4, "un-muting reopens the monitor", monitor.gain.value.toFixed(3));

/* ── 4 · level control ─────────────────────────────────────────────────── */

console.log("\n4 · monitor level");
engine.setMonitorDb(-20);
check(close(bestGain(duck, destination), Math.pow(10, -20 / 20)), "a -20 dB monitor is -20 dB at the destination", `${monitorDb().toFixed(2)} dB`);
engine.setMonitorDb(-6);
check(close(bestGain(duck, destination), Math.pow(10, -6 / 20)), "and comes back to -6 dB", `${monitorDb().toFixed(2)} dB`);

/* ── 5 · monitor checks ────────────────────────────────────────────────── */

console.log("\n5 · mono fold and polarity");
engine.apply({ ...DEFAULT_PARAMS, monitor: { mono: true, invertL: false, invertR: false } });
check(bestGain(duck, destination) > 0.2, "a mono fold-down still reaches the speakers", `${monitorDb().toFixed(2)} dB`);
engine.apply({ ...DEFAULT_PARAMS, monitor: { mono: false, invertL: true, invertR: false } });
check(bestGain(duck, destination) > 0.2, "an inverted leg still reaches the speakers", `${monitorDb().toFixed(2)} dB`);
engine.apply(DEFAULT_PARAMS);
check(close(bestGain(duck, destination), Math.pow(10, -6 / 20)), "and the default matrix restores", `${monitorDb().toFixed(2)} dB`);

/* ── 6 · the encoder send ──────────────────────────────────────────────── */

console.log("\n6 · encoder send");
check(close(bestGain(duck, streamDest), 1), "the stream destination is fed at unity from the programme bus");
check(
  bestGain(source, streamDest) > 0.5,
  "and the whole chain feeds it, not just the tail",
  bestGain(source, streamDest).toFixed(3),
);

/* ── 7 · the header readout ────────────────────────────────────────────── */

console.log("\n7 · header readout");
engine.setMonitorDb(-12);
const route = engine.monitorState;
check(close(route.gainDb, -12, 0.05), "the readout follows the bus, not the parameter", `${route.gainDb.toFixed(1)} dB`);
check(!route.muted, "an open monitor is reported open");
check(route.sink === "" && route.sinkLabel === "System default", "with no sink picked it names the OS default", route.sinkLabel);
engine.outputDeviceId = "spk-unlisted";
check(
  engine.monitorState.sink === "spk-unlisted" &&
    engine.monitorState.sinkLabel === "Chosen output",
  "a pick the enumeration cannot label is still reported as one",
  engine.monitorState.sinkLabel,
);
engine.outputDeviceId = "";
engine.setMonitorMuted(true);
const mutedRoute = engine.monitorState;
check(mutedRoute.muted, "a muted bus is reported muted");
check(mutedRoute.gainDb === -Infinity, "and reports no level rather than the parameter's", String(mutedRoute.gainDb));
engine.setMonitorMuted(false);
check(close(engine.monitorState.gainDb, -6, 0.05), "un-muting reports the restored level", `${engine.monitorState.gainDb.toFixed(1)} dB`);

console.log(`\n${passed} checks passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
