/**
 * Device-selection checks for the console engine:
 *
 *   bun scripts/verify-audio-devices.ts
 *
 * Media devices and an AudioContext stand in for real hardware. That cannot
 * prove a speaker sounds right, but it does prove that picking an input or an
 * output never throws, never leaves the UI pointing at a device that is not in
 * use, and always ends up armed on the device the operator picked last.
 *
 *  1  enumeration lists inputs and outputs with labels
 *  2  a chosen input is remembered and armed with that exact device
 *  3  switching input on air re-arms on the new device
 *  4  a pick made while arming wins over the in-flight arm
 *  5  an unplugged input falls back to the default and forgets itself
 *  6  the monitor output reaches setSinkId
 *  7  a rejected sink reverts to default instead of lying
 *  8  a runtime without setSinkId keeps the pick and throws nothing
 *  9  a stale saved device is dropped on refresh
 * 10  boot never fades the monitor for a sink it already renders to
 * 11  a sink call that never answers still gives the monitor back
 * 12  the monitor mute is engine state every subscriber sees
 * 13  a device fade is linear and lands on exact zero
 * 14  the monitor stays muted for the whole hand-off
 * 15  the old context is closed before the new one is built
 * 16  nothing is logged and no promise rejection escapes
 */
import { DEFAULT_PARAMS } from "../src/lib/audio/params";
import { AudioEngine } from "../src/lib/audio/engine";
import { DEVICE_RAMP_MS, rampWaitMs } from "../src/lib/audio/declick";

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

/* ── fake hardware ─────────────────────────────────────────────────────── */

interface FakeDevice {
  deviceId: string;
  kind: "audioinput" | "audiooutput";
  label: string;
  groupId: string;
}

const roster: FakeDevice[] = [
  { deviceId: "mic-a", kind: "audioinput", label: "Studio Mic A", groupId: "g1" },
  { deviceId: "mic-b", kind: "audioinput", label: "Guest Mic B", groupId: "g1" },
  { deviceId: "spk-a", kind: "audiooutput", label: "Monitors A", groupId: "g2" },
  { deviceId: "spk-b", kind: "audiooutput", label: "Headphones B", groupId: "g2" },
];

/** Every getUserMedia call: the exact id asked for, if any. */
let gumCalls: (string | undefined)[] = [];
let sinkCalls: string[] = [];
const stoppedTracks: string[] = [];
/** Delay applied to getUserMedia so "arming" is observable. */
let gumDelayMs = 0;
/** Devices that exist in the roster but refuse to open (busy / unplugged). */
const broken = new Set<string>();
/** setSinkId rejects for these ids. */
const badSinks = new Set<string>();
/** setSinkId never settles for these ids (a prompt the frame will not show). */
const hungSinks = new Set<string>();

const fakeStream = (label: string) => {
  const track = {
    label,
    stop: () => {
      stoppedTracks.push(label);
    },
  };
  return {
    getAudioTracks: () => [track],
    getTracks: () => [track],
  };
};

const mediaDevices = {
  async enumerateDevices() {
    return roster.map((d) => ({ ...d }));
  },
  async getUserMedia(constraints: { audio?: { deviceId?: { exact?: string } } }) {
    const id = constraints?.audio?.deviceId?.exact;
    gumCalls.push(id);
    if (gumDelayMs) await new Promise((r) => setTimeout(r, gumDelayMs));
    if (id && (broken.has(id) || !roster.some((d) => d.deviceId === id))) {
      throw new Error("NotFoundError: device unavailable");
    }
    if (broken.has("all")) throw new Error("NotAllowedError: permission denied");
    const device =
      roster.find((d) => d.deviceId === id) ??
      roster.find((d) => d.kind === "audioinput" && !broken.has(d.deviceId));
    if (!device) throw new Error("NotFoundError: no audio input");
    return fakeStream(device.label);
  },
  addEventListener() {
    /* no hotplug in the harness */
  },
  removeEventListener() {
    /* no hotplug in the harness */
  },
};

/** Minimal AudioParam stand-in for graph plumbing (events are not asserted here). */
const fakeAudioParam = (value = 1) => ({
  value,
  setTargetAtTime(v: number) {
    this.value = v;
  },
  setValueAtTime(v: number) {
    this.value = v;
  },
  linearRampToValueAtTime(v: number) {
    this.value = v;
  },
  cancelScheduledValues() {
    /* nothing scheduled */
  },
});

const fakeNode = () => ({
  gain: fakeAudioParam(),
  frequency: fakeAudioParam(),
  Q: fakeAudioParam(),
  channelCount: 2,
  channelCountMode: "explicit",
  channelInterpretation: "speakers",
  connect() {
    return this;
  },
  disconnect() {
    /* nothing to tear down */
  },
});

const fakeAnalyser = () => ({
  fftSize: 1024,
  connect() {
    return this;
  },
  disconnect() {
    /* nothing to tear down */
  },
  getFloatTimeDomainData() {
    /* silence */
  },
});

/** A browser rejects with a DOMException whose name is what code branches on. */
const domError = (name: string, message: string) =>
  Object.assign(new Error(message), { name });

function fakeContext(options: { sink: boolean } = { sink: true }) {
  return {
    state: "running",
    sampleRate: 48000,
    currentTime: 0,
    destination: fakeNode(),
    createMediaStreamSource: () => fakeNode(),
    createGain: () => fakeNode(),
    createAnalyser: () => fakeAnalyser(),
    createChannelSplitter: () => fakeNode(),
    createChannelMerger: () => fakeNode(),
    createMediaStreamDestination: () => ({ stream: {} }),
    setSinkId: options.sink
      ? async (id: string) => {
          sinkCalls.push(id);
          if (hungSinks.has(id)) await new Promise(() => undefined);
          if (badSinks.has(id)) {
            throw domError("NotFoundError", `The device ${id} is gone`);
          }
        }
      : undefined,
    resume: async () => undefined,
    close: async () => undefined,
  };
}

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

const settle = async () => {
  for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 5));
};

const prefs = () => JSON.parse(store.get("signalpath.devices.v1") ?? "{}") as Record<string, string>;

/* ── 1 · enumeration ───────────────────────────────────────────────────── */

console.log("\n1 · device enumeration");
const engine = new AudioEngine();
engine.ctx = fakeContext() as unknown as AudioContext;
await engine.refreshDevices();
check(engine.inputDevices.length === 2 && engine.outputDevices.length === 2, "inputs and outputs are listed", `${engine.inputDevices.length} in / ${engine.outputDevices.length} out`);
check(engine.inputDevices[0].label === "Studio Mic A", "labels come through once permission is granted", engine.inputDevices[0].label);
check(engine.outputDevices[1].label === "Headphones B", "output labels survive enumeration", engine.outputDevices[1].label);

/* ── 2 · choose + arm ──────────────────────────────────────────────────── */

console.log("\n2 · choose an input and arm it");
engine.setInputDevice("mic-a");
check(engine.inputDeviceId === "mic-a", "the pick is held on the engine", engine.inputDeviceId);
check(prefs().input === "mic-a", "and persisted for the next boot");
check(gumCalls.length === 0 && engine.micStatus === "idle", "picking alone opens no microphone");
await engine.armMic();
check(engine.micStatus === "on", "arming lands in the live state", engine.micStatus);
check(gumCalls.at(-1) === "mic-a", "getUserMedia asked for the chosen device exactly", String(gumCalls.at(-1)));
check(engine.micLabel === "Studio Mic A", "the live label names the open device", engine.micLabel);

/* ── 3 · switch on air ─────────────────────────────────────────────────── */

console.log("\n3 · switch input while armed");
engine.setInputDevice("mic-b");
await settle();
check(engine.micStatus === "on", "the new device is live", engine.micStatus);
check(engine.micLabel === "Guest Mic B", "and named correctly", engine.micLabel);
check(stoppedTracks.includes("Studio Mic A"), "the old stream is released", stoppedTracks.join(", "));
check(gumCalls.at(-1) === "mic-b", "the new device was opened", String(gumCalls.at(-1)));

/* ── 4 · pick during arming ────────────────────────────────────────────── */

console.log("\n4 · a second pick while the first is still opening");
gumDelayMs = 10;
gumCalls = [];
engine.setInputDevice("mic-a");
engine.setInputDevice("mic-b");
await settle();
gumDelayMs = 0;
check(engine.micStatus === "on", "the console settles armed", engine.micStatus);
check(engine.inputDeviceId === "mic-b", "the last pick is the selection", engine.inputDeviceId);
check(engine.micLabel === "Guest Mic B", "the open stream matches that pick", engine.micLabel);
check(gumCalls.filter((id) => id === "mic-b").length >= 1, "the winner was opened", gumCalls.map(String).join(" → "));

/* ── 5 · unplugged input ───────────────────────────────────────────────── */

console.log("\n5 · the chosen input disappears");
broken.add("mic-a");
engine.setInputDevice("mic-a");
await settle();
check(engine.micStatus === "on", "the console still arms on the default", engine.micStatus);
check(engine.inputDeviceId === "", "the dead pick is cleared", engine.inputDeviceId || "(default)");
check(prefs().input === "", "and the saved preference forgets it");
check(engine.micLabel !== "Studio Mic A", "the live device is the default, not the dead one", engine.micLabel);
broken.delete("mic-a");

/* ── 6 · monitor output ────────────────────────────────────────────────── */

console.log("\n6 · monitor output selection");
sinkCalls = [];
engine.setOutputDevice("spk-a");
await settle();
check(engine.outputDeviceId === "spk-a", "the output pick is held", engine.outputDeviceId);
check(sinkCalls.includes("spk-a"), "the AudioContext sink moved", sinkCalls.join(" → "));
check(prefs().output === "spk-a", "and persisted for the next boot");

/* ── 7 · sink that refuses ─────────────────────────────────────────────── */

console.log("\n7 · a sink the context refuses");
badSinks.add("spk-gone");
sinkCalls = [];
engine.setOutputDevice("spk-gone");
await settle();
check(engine.outputDeviceId === "", "the console reverts to the default sink", engine.outputDeviceId);
check(sinkCalls.includes("spk-gone") && sinkCalls.includes(""), "the default sink is re-opened", sinkCalls.join(" → "));
check(prefs().output === "", "and the saved preference matches reality");
check(rejections.length === 0, "the rejection was handled, not thrown");

/* ── 8 · no setSinkId ──────────────────────────────────────────────────── */

console.log("\n8 · a runtime without setSinkId");
const bare = new AudioEngine();
bare.ctx = fakeContext({ sink: false }) as unknown as AudioContext;
bare.setOutputDevice("spk-b");
await settle();
check(bare.outputDeviceId === "spk-b", "the pick is kept for when support exists", bare.outputDeviceId);
check(prefs().output === "spk-b", "and persisted");

/* ── 9 · stale saved device ────────────────────────────────────────────── */

console.log("\n9 · a saved device that no longer exists");
store.set("signalpath.devices.v1", JSON.stringify({ input: "mic-ghost", output: "spk-ghost", source: "signal" }));
const cold = new AudioEngine();
cold.ctx = fakeContext() as unknown as AudioContext;
check(cold.inputDeviceId === "mic-ghost", "the saved pick is restored at boot");
await cold.refreshDevices();
check(cold.inputDeviceId === "" && cold.outputDeviceId === "", "refresh drops devices that are gone", `${cold.inputDeviceId || "default"} / ${cold.outputDeviceId || "default"}`);

/* ── 10 · a sleeping context ────────────────────────────────────────────── */

console.log("\n10 · a sink call while the context is asleep");
badSinks.add("spk-b");
const sleepy = new AudioEngine();
const sleepingCtx = fakeContext();
sleepingCtx.state = "suspended";
sleepy.ctx = sleepingCtx as unknown as AudioContext;
sleepy.setOutputDevice("spk-b");
await settle();
check(
  sleepy.outputDeviceId === "spk-b",
  "a suspended context keeps the pick for the next resume",
  sleepy.outputDeviceId || "(default)",
);
check(prefs().output === "spk-b", "and does not overwrite the saved preference");
badSinks.delete("spk-b");

/* ── 11 · monitor across a sink switch ─────────────────────────────────── */

/**
 * An AudioParam stand-in that records the automation it was given, so the
 * shape of a fade can be checked and not just its destination.
 */
interface ParamEvent {
  type: "set" | "ramp" | "target";
  value: number;
  time: number;
}
const fakeParam = (value = 1) => ({
  value,
  events: [] as ParamEvent[],
  setTargetAtTime(v: number, time = 0) {
    this.value = v;
    this.events.push({ type: "target", value: v, time });
  },
  setValueAtTime(v: number, time = 0) {
    this.value = v;
    this.events.push({ type: "set", value: v, time });
  },
  linearRampToValueAtTime(v: number, time = 0) {
    this.value = v;
    this.events.push({ type: "ramp", value: v, time });
  },
  cancelScheduledValues() {
    /* no schedule to cancel */
  },
});

/** A powered engine with a monitor bus, without building the whole graph. */
const poweredEngine = (ctx: ReturnType<typeof fakeContext>) => {
  const e = new AudioEngine();
  e.ctx = ctx as unknown as AudioContext;
  const anyEngine = e as unknown as Record<string, unknown>;
  anyEngine.powered = true;
  anyEngine.graphReady = true;
  anyEngine.params = DEFAULT_PARAMS;
  anyEngine.appliedSink = "";
  anyEngine.monitorGain = { gain: fakeParam(0.501) };
  return e;
};

console.log("\n11 · the monitor across a sink switch");
// A cold console with no saved sink: the one case where boot has nothing to
// switch at all.
store.set("signalpath.devices.v1", JSON.stringify({ input: "", output: "", source: "signal" }));
sinkCalls = [];
const bootCtx = fakeContext();
const bootEngine = poweredEngine(bootCtx);
await (bootEngine as unknown as { applyOutputDevice: () => Promise<void> }).applyOutputDevice();
const bootMonitor = (bootEngine as unknown as { monitorGain: { gain: { value: number } } })
  .monitorGain;
check(sinkCalls.length === 0, "boot makes no sink call for the default it already renders to");
check(
  Math.abs(bootMonitor.gain.value - 0.501) < 1e-6,
  "and leaves the monitor at its programmed level",
  bootMonitor.gain.value.toFixed(3),
);

hungSinks.add("spk-hang");
sinkCalls = [];
const hungCtx = fakeContext();
const hungEngine = poweredEngine(hungCtx);
const hungMonitor = (hungEngine as unknown as { monitorGain: { gain: { value: number } } })
  .monitorGain;
hungEngine.setOutputDevice("spk-hang");
await new Promise((r) => setTimeout(r, 1700));
check(sinkCalls.includes("spk-hang"), "the sink call was made", sinkCalls.join(" → "));
check(
  hungMonitor.gain.value > 0.4,
  "a sink call that never answers still gives the monitor back",
  hungMonitor.gain.value.toFixed(3),
);
check(hungEngine.outputDeviceId === "spk-hang", "the pick is kept, not reverted on silence", hungEngine.outputDeviceId);
hungSinks.delete("spk-hang");

console.log("\n12 · monitor mute reaches every subscriber");
let notifies = 0;
const off = hungEngine.subscribe(() => {
  notifies += 1;
});
hungEngine.setMonitorMuted(true);
check(hungEngine.monitorMutedNow, "the engine holds the mute");
check(notifies === 1, "a mute notifies subscribers", `${notifies} notification(s)`);
check(hungMonitor.gain.value === 0, "and zeroes the monitor bus", hungMonitor.gain.value.toFixed(3));
hungEngine.setMonitorMuted(false);
check(
  Math.abs(hungMonitor.gain.value - Math.pow(10, DEFAULT_PARAMS.monitorDb / 20)) < 1e-6,
  "un-muting restores the programmed level",
  hungMonitor.gain.value.toFixed(3),
);
off();

/* ── 13 · the shape of a fade ──────────────────────────────────────────── */

console.log("\n13 · a device fade is linear");
interface FadeInternals {
  sourceBus: { gain: ReturnType<typeof fakeParam> };
  monitorGain: { gain: ReturnType<typeof fakeParam> };
  fadeBus: (target: number) => void;
  ensureBusOpen: () => void;
  applyMonitorGain: () => void;
}
const rampCtx = fakeContext();
const ramped = poweredEngine(rampCtx) as unknown as FadeInternals;
ramped.sourceBus = { gain: fakeParam(1) };
ramped.fadeBus(0);
const anchor = ramped.sourceBus.gain.events.find((e) => e.type === "set");
const landing = ramped.sourceBus.gain.events.find((e) => e.type === "ramp");
check(ramped.sourceBus.gain.value === 0, "the bus reaches exact zero", ramped.sourceBus.gain.value.toFixed(4));
check(
  !!landing && landing.value === 0,
  "by ramping to it, not approaching it",
  landing ? `ramp → ${landing.value}` : "no ramp",
);
check(
  !!anchor && !!landing && Math.abs(landing.time - anchor.time - DEVICE_RAMP_MS / 1000) < 1e-9,
  `the ramp is ${DEVICE_RAMP_MS} ms long`,
  anchor && landing ? `${Math.round((landing.time - anchor.time) * 1000)} ms` : "—",
);
check(
  !ramped.sourceBus.gain.events.some((e) => e.type === "target"),
  "no exponential approach is used for a device fade",
);

rampCtx.state = "suspended";
ramped.fadeBus(0);
ramped.ensureBusOpen();
check(ramped.sourceBus.gain.value === 0, "a fade-in is refused while the context is not running");
rampCtx.state = "running";
ramped.ensureBusOpen();
check(ramped.sourceBus.gain.value === 1, "and opens on the next running state", ramped.sourceBus.gain.value.toFixed(3));

/* ── 14 · the mute holds for the whole hand-off ─────────────────────────── */

console.log("\n14 · the monitor through a slow sink switch");
const slowCtx = fakeContext();
const slowEngine = poweredEngine(slowCtx) as unknown as FadeInternals;
const slowMonitor = (slowEngine as unknown as { monitorGain: { gain: ReturnType<typeof fakeParam> } })
  .monitorGain;
let releaseSink: (() => void) | null = null;
const monitorAtCall: number[] = [];
slowCtx.setSinkId = async () => {
  monitorAtCall.push(slowMonitor.gain.value);
  await new Promise<void>((resolve) => {
    releaseSink = resolve;
  });
};
slowEngine.setOutputDevice("spk-slow");
await new Promise((r) => setTimeout(r, rampWaitMs() + 20));
check(
  monitorAtCall[0] === 0,
  "the monitor is at zero when the sink is touched",
  monitorAtCall.length ? monitorAtCall[0].toFixed(4) : "sink not reached",
);
slowEngine.applyMonitorGain(); // a parameter apply landing mid-swap
check(slowMonitor.gain.value === 0, "a parameter apply cannot cancel the hand-off mute", slowMonitor.gain.value.toFixed(4));
releaseSink?.();
await settle();
check(
  Math.abs(slowMonitor.gain.value - Math.pow(10, DEFAULT_PARAMS.monitorDb / 20)) < 1e-6,
  "the monitor returns once the new sink is open",
  slowMonitor.gain.value.toFixed(3),
);

/* ── 15 · teardown before re-creation ──────────────────────────────────── */

console.log("\n15 · rebuilding the context");
const order: string[] = [];
const oldContext = {
  state: "running" as AudioContextState,
  close: async () => {
    order.push("close");
    oldContext.state = "closed";
  },
};
Object.defineProperty(globalThis, "AudioContext", {
  configurable: true,
  value: function RecordingContext() {
    const ctx = fakeContext();
    ctx.close = async () => {
      order.push("close");
      (ctx as { state: string }).state = "closed";
    };
    ctx.resume = async () => {
      order.push("resume");
      (ctx as { state: string }).state = "running";
    };
    order.push("create");
    return ctx;
  },
});
const booting = new AudioEngine() as unknown as Record<string, unknown> & {
  powered: boolean;
  powerOn: () => Promise<void>;
};
const duck = fakeParam(0);
const rampInto = duck.linearRampToValueAtTime.bind(duck);
duck.linearRampToValueAtTime = (v: number, t: number) => {
  if (v === 1) order.push("fade-in");
  rampInto(v, t);
};
booting.ctx = oldContext;
booting.graphReady = false;
booting.loadLimiterWorklet = async () => undefined;
booting.buildGraph = () => {
  booting.graphReady = true;
  booting.sourceBus = { gain: fakeParam(1) };
  booting.duckGain = { gain: duck };
};
booting.watchDevices = () => undefined;
booting.startSource = () => order.push("source");
booting.startMeterLoop = () => undefined;
await booting.powerOn();
check(
  order.includes("close") && order.indexOf("close") < order.indexOf("create"),
  "the old context is closed before the new one is created",
  order.join(" → "),
);
check(order.indexOf("create") < order.indexOf("resume"), "which is then resumed", order.join(" → "));
check(
  order.indexOf("resume") < order.indexOf("fade-in"),
  "and programme fades in only after it reports running",
  order.join(" → "),
);
check(booting.powered, "the console comes up powered");

/* ── 16 · quiet ────────────────────────────────────────────────────────── */

console.log("\n16 · no noise");
await settle();
check(logs.length === 0, "nothing was logged to console.error/warn", logs.join(" | "));
check(rejections.length === 0, "no promise rejection escaped", rejections.map(String).join(" | "));

console.error = realError;
console.warn = realWarn;
console.log(`\n${passed} checks passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
