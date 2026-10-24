/**
 * Program-source routing for the console engine:
 *
 *   bun scripts/verify-audio-sources.ts
 *
 * The engine has three possible sources (test generator, microphone, file)
 * feeding one program bus. The failures that matter on air are:
 *
 *   · two sources connected at once (a mic mixed with the test tone);
 *   · an "armed" microphone that is not actually on the program bus;
 *   · an engine that says it is running but has no source at all — which is
 *     what a power cycle used to leave behind;
 *   · a mono interface that leaves the right channel silent.
 *
 * The AudioContext here is a stand-in, so this proves the routing decisions
 * and the state the console shows, not that a speaker sounds right.
 *
 *  1  power-on starts the program source on a two-channel bus
 *  2  arming a microphone takes the generator off the bus
 *  3  going back to the generator releases the microphone
 *  4  a file source leaves nothing else connected
 *  5  power cycling restores the program source
 *  6  power-off releases open hardware
 *  7  only one source is ever live
 */
import { AudioEngine } from "../src/lib/audio/engine";

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

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ── fake Web Audio ────────────────────────────────────────────────────── */

class FakeParam {
  value = 0;
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
    /* nothing scheduled */
  }
}

class FakeNode {
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
  channelCountMode = "max";
  channelInterpretation = "speakers";
  buffer: unknown = null;
  loop = false;
  onended: (() => void) | null = null;
  connect(): this {
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

const sinks: string[] = [];

class FakeAudioContext {
  state = "running";
  sampleRate = 48000;
  currentTime = 0;
  baseLatency = 0.01;
  outputLatency = 0.02;
  onstatechange: null | (() => void) = null;
  destination = new FakeNode();
  createGain = () => new FakeNode();
  createBiquadFilter = () => new FakeNode();
  createDynamicsCompressor = () => new FakeNode();
  createAnalyser = () => new FakeNode();
  createWaveShaper = () => new FakeNode();
  createChannelSplitter = () => new FakeNode();
  createChannelMerger = () => new FakeNode();
  createMediaStreamDestination = () => Object.assign(new FakeNode(), { stream: {} });
  createOscillator = () => new FakeNode();
  createBufferSource = () => new FakeNode();
  createMediaElementSource = () => new FakeNode();
  createMediaStreamSource = () => new FakeNode();
  createBuffer = (_channels: number, length: number) => ({
    getChannelData: () => new Float32Array(length),
  });
  decodeAudioData = async () => ({ duration: 0 });
  resume = async () => undefined;
  suspend = async () => undefined;
  close = async () => undefined;
  setSinkId = async (id: string) => {
    sinks.push(id);
  };
}

/* ── fake hardware ─────────────────────────────────────────────────────── */

const stopped: string[] = [];
let openedDevice = "";

/** A mono input, like most real interfaces — the bus must up-mix it. */
const monoStream = (label: string) => {
  const track = {
    label,
    stop: () => stopped.push(label),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  return {
    getAudioTracks: () => [track],
    getTracks: () => [track],
  };
};

const mediaDevices = {
  async enumerateDevices() {
    return [
      { deviceId: "mic-a", kind: "audioinput", label: "Studio Mic", groupId: "g1" },
      { deviceId: "mic-b", kind: "audioinput", label: "Guest Mic", groupId: "g1" },
      { deviceId: "spk-a", kind: "audiooutput", label: "Monitors", groupId: "g2" },
    ];
  },
  async getUserMedia(constraints: { audio?: { deviceId?: { exact?: string } } }) {
    openedDevice = constraints?.audio?.deviceId?.exact ?? "";
    return monoStream(openedDevice || "System Default Mic");
  },
  addEventListener() {
    /* no hotplug here */
  },
  removeEventListener() {
    /* no hotplug here */
  },
};

/* ── environment ───────────────────────────────────────────────────────── */

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
    mediaDevices,
    permissions: { query: async () => ({ state: "granted" }) },
  },
});
Object.defineProperty(globalThis, "AudioContext", {
  configurable: true,
  value: FakeAudioContext,
});
// The meter loop is not under test, and a running rAF would keep the process
// alive forever: schedule the callback never, cancel it always.
Object.defineProperty(globalThis, "requestAnimationFrame", {
  configurable: true,
  value: () => 1,
});
Object.defineProperty(globalThis, "cancelAnimationFrame", {
  configurable: true,
  value: () => undefined,
});

const logs: string[] = [];
const realError = console.error;
const realWarn = console.warn;
console.error = (...args: unknown[]) => {
  logs.push(`error: ${args.join(" ")}`);
};
console.warn = (...args: unknown[]) => {
  logs.push(`warn: ${args.join(" ")}`);
};
const rejections: unknown[] = [];
process.on("unhandledRejection", (reason) => {
  rejections.push(reason);
});

interface Internals {
  sourceBus: FakeNode;
  micNode: FakeNode | null;
  micStream: unknown;
}

const engine = new AudioEngine();
const internals = engine as unknown as Internals;
const liveSources = () =>
  [engine.generatorOn, engine.micStatus === "on", engine.filePlaying].filter(Boolean).length;

/* ── 1 · power-on ──────────────────────────────────────────────────────── */

console.log("\n1 · power on");
engine.signalMode = "tone"; // the tone path is the fast one to fake
await engine.powerOn();
check(engine.powered, "the engine comes up", `state ${engine.ctx?.state}`);
check(engine.generatorOn, "and the program source starts with it");
check(
  internals.sourceBus.channelCount === 2 && internals.sourceBus.channelCountMode === "explicit",
  "the program bus is forced to two channels",
  `${internals.sourceBus.channelCount}ch · ${internals.sourceBus.channelCountMode}`,
);
check(internals.sourceBus.channelInterpretation === "speakers", "so a mono source is up-mixed, not panned");
check(engine.sourceKind === "signal", "the console reports the generator as the source", engine.sourceKind);

/* ── 2 · arming routes the mic ─────────────────────────────────────────── */

console.log("\n2 · arming the microphone");
await engine.armMic();
await wait(60); // the switch fades before the old source is torn down
check(engine.sourceKind === "mic", "arming makes the mic the program source", engine.sourceKind);
check(engine.micStatus === "on", "the input is live", engine.micStatus);
check(engine.micLabel === "System Default Mic", "the live device is named", engine.micLabel);
check(!engine.generatorOn, "the test generator is stopped — no mixed sources");
check(liveSources() === 1, "exactly one source is connected", `${liveSources()} live`);
check(!!internals.micNode, "the microphone node is on the bus");

/* ── 3 · back to the generator ─────────────────────────────────────────── */

console.log("\n3 · back to the generator");
await engine.setSource("signal");
await wait(60);
check(engine.micStatus === "idle", "the microphone is released", engine.micStatus);
check(internals.micNode === null && internals.micStream === null, "and its node and stream are gone");
check(stopped.includes("System Default Mic"), "the hardware track was stopped", stopped.join(", "));
check(engine.generatorOn, "the generator is back on the bus");
check(liveSources() === 1, "still exactly one source", `${liveSources()} live`);

/* ── 4 · a file source ─────────────────────────────────────────────────── */

console.log("\n4 · file source");
await engine.setSource("file");
await wait(60);
check(engine.sourceKind === "file", "the console reports file playback", engine.sourceKind);
check(!engine.generatorOn && engine.micStatus === "idle", "nothing else is left connected");
check(liveSources() === 0, "an empty file source is silent, not mixed", `${liveSources()} live`);

/* ── 5 · power cycle ───────────────────────────────────────────────────── */

console.log("\n5 · power cycle");
await engine.setSource("signal");
await wait(60);
check(engine.generatorOn, "the generator is running before the cycle");
engine.powerOff();
await wait(100);
check(!engine.generatorOn, "power-off stops the generator");
check(!engine.powered, "and the console says the engine is off");
await engine.powerOn();
check(engine.powered, "power-on brings the engine back");
check(
  engine.generatorOn,
  "and the program source with it — no silently dead console",
  engine.generatorOn ? "generator restored" : "NO SOURCE",
);
check(internals.sourceBus.channelCount === 2, "the rebuilt graph still has a two-channel bus");
check(liveSources() === 1, "one source, not a leaked duplicate", `${liveSources()} live`);

/* ── 6 · hardware is released ──────────────────────────────────────────── */

console.log("\n6 · power-off releases hardware");
await engine.armMic();
await wait(60);
check(engine.micStatus === "on", "the microphone is live again");
const stoppedBefore = stopped.length;
engine.powerOff();
await wait(100);
check(engine.micStatus === "idle", "power-off disarms the microphone", engine.micStatus);
check(stopped.length > stoppedBefore, "and stops the capture track", `${stopped.length - stoppedBefore} track(s)`);
check(!engine.generatorOn, "while the generator stays stopped");

/* ── 7 · picking a device while armed ─────────────────────────────────── */

console.log("\n7 · picking an input while armed");
engine.setInputDevice("mic-b");
await wait(60);
check(engine.micStatus === "on", "the input re-arms on the new device", engine.micStatus);
check(engine.inputDeviceId === "mic-b", "the pick is held", engine.inputDeviceId);
check(openedDevice === "mic-b", "the device that was opened is the one picked", openedDevice);
check(engine.micLabel === "mic-b", "and the label matches the open stream", engine.micLabel);

/* ── 8 · quiet ─────────────────────────────────────────────────────────── */

console.log("\n8 · no noise");
await wait(40);
check(logs.length === 0, "nothing was logged to console.error/warn", logs.join(" | "));
check(rejections.length === 0, "no promise rejection escaped", rejections.map(String).join(" | "));

console.error = realError;
console.warn = realWarn;
console.log(`\n${passed} checks passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
