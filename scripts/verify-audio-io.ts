/**
 * Audio I/O routing checks — hot-standby failover and delivery-bus config.
 *
 *   bun scripts/verify-audio-io.ts
 *
 * The failover state machine is the one part of the I/O layer that hardware
 * cannot prove in CI: it depends on two live device levels and *time*. This
 * feeds it synthetic levels through the same analyser buffers it reads at
 * runtime, so the thresholds, hold times and restore hysteresis are checked
 * deterministically.
 *
 *  1  Input 1 stays on air while it has signal
 *  2  a silent Input 1 hands over only after the hold window
 *  3  a silent backup is never switched to
 *  4  failover stays off unless the operator armed it
 *  5  a healthy Input 1 is restored, again after its hold window
 *  6  delivery/trim settings clamp and persist
 *  7  a hardware rate/quantum request is stored for the next boot
 */
import { AudioEngine } from "../src/lib/audio/engine";
import { dbToGain } from "../src/lib/audio/params";

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

const fakeParam = (value = 1) => ({
  value,
  setValueAtTime(v: number) {
    this.value = v;
  },
  linearRampToValueAtTime(v: number) {
    this.value = v;
  },
  setTargetAtTime(v: number) {
    this.value = v;
  },
  cancelScheduledValues() {
    /* nothing scheduled */
  },
});

interface FakePath {
  analyser: {
    fftSize: number;
    connect(): unknown;
    disconnect(): void;
    getFloatTimeDomainData(buf: Float32Array): void;
  };
  buf: Float32Array;
  fader: { gain: ReturnType<typeof fakeParam> };
  gain: { gain: ReturnType<typeof fakeParam> };
  label: string;
}

/**
 * A path whose detector reports `db` on every read. The buffer is filled with
 * a DC value of the matching amplitude; peakDb measures max|x|, so the level
 * the state machine sees is exactly the one asked for.
 */
const fakePath = (db: number): FakePath => {
  const amp = dbToGain(db);
  const buf = new Float32Array(1024);
  return {
    analyser: {
      fftSize: 1024,
      connect() {
        return this;
      },
      disconnect() {
        /* nothing to tear down */
      },
      getFloatTimeDomainData(target: Float32Array) {
        target.fill(amp);
      },
    },
    buf,
    fader: { gain: fakeParam(1) },
    gain: { gain: fakeParam(1) },
    label: "test input",
  };
};

interface EngineInternals {
  ctx: { currentTime: number };
  inputActive: "main" | "backup";
  autoSwitched: boolean;
  mainPath: FakePath | null;
  backupPath: FakePath | null;
  updateInputRouting(now: number): void;
  ioState: { activeInput: "main" | "backup"; autoSwitched: boolean };
}

const makeEngine = () => {
  const engine = new AudioEngine() as unknown as EngineInternals & AudioEngine;
  engine.ctx = { currentTime: 0 } as AudioContext;
  engine.mainPath = fakePath(-120);
  engine.backupPath = fakePath(-120);
  return engine;
};

const setLevel = (path: FakePath | null, db: number) => {
  if (!path) return;
  const amp = dbToGain(db);
  path.analyser.getFloatTimeDomainData = (target: Float32Array) => {
    target.fill(amp);
  };
};

/* ── 1 · no failover while the main input is healthy ───────────────────── */

console.log("\n1 · main input healthy");
let e = makeEngine();
e.io.backupEnabled = true;
setLevel(e.mainPath, -18);
setLevel(e.backupPath, -18);
for (let t = 1000; t <= 20000; t += 500) e.updateInputRouting(t);
check(e.inputActive === "main", "Input 1 stays on the bus", e.inputActive);
check(!e.autoSwitched, "no automatic switch is recorded");

/* ── 2 · silent main hands over after the hold ─────────────────────────── */

console.log("\n2 · Input 1 goes silent");
e = makeEngine();
e.io.backupEnabled = true;
setLevel(e.mainPath, -120);
setLevel(e.backupPath, -16);
e.updateInputRouting(1000);
e.updateInputRouting(3999);
check(e.inputActive === "main", "still on Input 1 inside the 3 s hold window", e.inputActive);
e.updateInputRouting(4001);
check(e.inputActive === "backup", "the backup takes the bus after the hold", e.inputActive);
check(e.autoSwitched, "the switch is marked automatic");
check(e.mainPath?.fader.gain.value === 0, "Input 1 is faded out");
check(e.backupPath?.fader.gain.value === 1, "Input 2 is faded in");

/* ── 3 · a silent backup is not a backup ───────────────────────────────── */

console.log("\n3 · Input 1 silent, Input 2 silent");
e = makeEngine();
e.io.backupEnabled = true;
setLevel(e.mainPath, -120);
setLevel(e.backupPath, -120);
for (let t = 1000; t <= 20000; t += 500) e.updateInputRouting(t);
check(e.inputActive === "main", "the bus stays where it is", e.inputActive);
check(!e.autoSwitched, "and no phantom failover is reported");

/* ── 4 · failover only when armed ──────────────────────────────────────── */

console.log("\n4 · failover disarmed");
e = makeEngine();
e.io.backupEnabled = false;
setLevel(e.mainPath, -120);
setLevel(e.backupPath, -10);
for (let t = 1000; t <= 20000; t += 500) e.updateInputRouting(t);
check(e.inputActive === "main", "the backup never takes over while disarmed", e.inputActive);

/* ── 5 · restoring the main input has its own hold ─────────────────────── */

console.log("\n5 · Input 1 returns");
e = makeEngine();
e.io.backupEnabled = true;
setLevel(e.mainPath, -120);
setLevel(e.backupPath, -16);
e.updateInputRouting(1000);
e.updateInputRouting(4001);
check(e.inputActive === "backup", "setup: the backup is on air", e.inputActive);
setLevel(e.mainPath, -18);
e.updateInputRouting(5000);
e.updateInputRouting(8999);
check(e.inputActive === "backup", "a brief healthy moment does not flap the bus", e.inputActive);
e.updateInputRouting(9001);
check(e.inputActive === "main", "Input 1 is restored after its hold window", e.inputActive);
check(!e.autoSwitched, "the restore clears the automatic flag");
check(e.mainPath?.fader.gain.value === 1, "Input 1 is faded back in");
check(e.backupPath?.fader.gain.value === 0, "Input 2 is parked again");

/* ── 6 · delivery settings clamp and persist ───────────────────────────── */

console.log("\n6 · delivery settings");
e = makeEngine();
e.setWebGainDb(-120);
check(e.io.webGainDb === -60, "the Web/HD trim clamps at −60 dB", String(e.io.webGainDb));
e.setWebGainDb(40);
check(e.io.webGainDb === 12, "and at +12 dB", String(e.io.webGainDb));
e.setInputGain("main", 90);
check(e.io.mainGainDb === 24, "input preamp clamps at +24 dB", String(e.io.mainGainDb));
e.setInputGain("backup", -90);
check(e.io.backupGainDb === -24, "and at −24 dB", String(e.io.backupGainDb));
e.setWebChannels("mono");
const saved = JSON.parse(store.get("signalpath.io.v1") ?? "{}") as {
  webChannels?: string;
  webGainDb?: number;
};
check(saved.webChannels === "mono", "channel format is persisted", String(saved.webChannels));
check(saved.webGainDb === 12, "trim is persisted", String(saved.webGainDb));
const restored = new AudioEngine();
check(restored.io.webChannels === "mono", "a new engine restores the format");
check(restored.io.webGainDb === 12, "and the trim");

/* ── 7 · hardware request storage ──────────────────────────────────────── */

console.log("\n7 · hardware rate / quantum");
// No context: this checks the stored request, not the async rebuild (which
// needs a real AudioContext and is covered by the device suite's ordering
// guarantees).
const cfgEngine = new AudioEngine();
await cfgEngine.applyAudioConfig({ sampleRate: 48000, latencyFrames: 64 });
check(cfgEngine.io.sampleRate === 48000, "the requested rate is held", String(cfgEngine.io.sampleRate));
check(
  cfgEngine.io.latencyFrames === 128,
  "the quantum clamps at 128 frames",
  String(cfgEngine.io.latencyFrames),
);
const booted = new AudioEngine();
check(booted.io.sampleRate === 48000, "the next boot restores the rate");
check(booted.io.latencyFrames === 128, "and the quantum");

console.log(`\n${passed} checks passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
