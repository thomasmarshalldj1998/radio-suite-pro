/**
 * FM branch manager — module-scope lifecycle for the MPX composite generator.
 *
 * The branch taps the processed program bus (same PCM tap the WASM encoders
 * use) whenever the FM module is engaged and the engine is powered, feeding
 * the mpx worker. Metering ticks and the composite spectrum are republished
 * through a tiny pub/sub so the deviation meter, MPX spectrum, signal-flow
 * stage, quick-status cell and the overmodulation alarm all read one source
 * of truth. The same composite can also be FLAC-encoded at the composite
 * rate (192 kHz) for MPX-over-IP — an exciter fed over IP, the way modern
 * all-digital chains are wired.
 */
import { DEFAULT_PARAMS, type FmParams } from "./params";
import { getEngine } from "./engine";
import { attachPcmTap } from "./js-encoder";
import type { EncoderStats, ProgramEncoder } from "./encoder";
import type { MpxTickStats } from "./mpx";
import type { MpxWorkerOut } from "./mpx.worker";

export interface FmSnapshot {
  /** Branch running: engine powered + FM module engaged. */
  running: boolean;
  /** Composite sample rate (engine rate ×4). */
  outRate: number;
  /** Latest metering tick (null until the first tick arrives). */
  stats: MpxTickStats | null;
  /** Composite spectrum, dB per bin (bin ≈ outRate/4096 Hz). */
  spectrum: Float32Array | null;
  /** Last worker error, if any. */
  error: string | null;
}

const IDLE: FmSnapshot = {
  running: false,
  outRate: 192000,
  stats: null,
  spectrum: null,
  error: null,
};

let snap: FmSnapshot = { ...IDLE };
let worker: Worker | null = null;
let detachTap: (() => void) | null = null;
let tapPending: Promise<void> | null = null;
let applied: FmParams | null = null;
let streamRequested = false;
const streamSinks = new Set<(l: Float32Array) => void>();

const listeners = new Set<() => void>();

function emit() {
  for (const cb of listeners) cb();
}

export function getFm(): FmSnapshot {
  return snap;
}

export function subscribeFm(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/**
 * Sync the branch to the current params + engine power state. Idempotent:
 * called from the Dashboard's apply effect and the power handlers. `stream`
 * asks the worker to forward composite batches (MPX over IP).
 */
export function syncFm(fm: FmParams, stream?: boolean): void {
  const engine = getEngine();
  const shouldRun = engine.powered && fm.on;
  applied = fm;
  // an explicit request (MPX encoder start/stop) latches; param syncs from
  // the Dashboard keep the current state so a live stream survives knob turns
  if (stream !== undefined) streamRequested = stream;

  if (!shouldRun) {
    stopFm();
    return;
  }
  if (!worker) {
    const inRate = engine.sampleRate || 48000;
    const w = new Worker(new URL("./mpx.worker.ts", import.meta.url), {
      type: "module",
    });
    worker = w;
    snap = { ...IDLE, running: false, outRate: inRate * 4 };
    w.onmessage = (e: MessageEvent<MpxWorkerOut>) => onWorkerMessage(e.data);
    w.onerror = (e: ErrorEvent) => {
      snap = { ...snap, error: e.message || "MPX worker failed" };
      emit();
    };
    w.postMessage({ cmd: "init", inRate, fm, stream: streamRequested });
    tapPending = attachPcmTap((l, r) => {
      w.postMessage({ cmd: "chunk", channels: [l, r] }, [l.buffer, r.buffer]);
    })
      .then(() => {
        snap = { ...snap, running: true };
        emit();
      })
      .catch((err: unknown) => {
        snap = {
          ...snap,
          error: err instanceof Error ? err.message : "PCM tap unavailable",
        };
        emit();
      });
    return;
  }
  // already running — push param/stream updates
  worker.postMessage({ cmd: "params", fm, stream: streamRequested });
}

function onWorkerMessage(msg: MpxWorkerOut): void {
  if (msg.type === "tick") {
    snap = {
      ...snap,
      stats: msg.stats,
      spectrum: msg.spectrum,
      outRate: msg.outRate,
    };
    emit();
  } else if (msg.type === "composite") {
    const l = msg.channels[0];
    for (const cb of streamSinks) cb(l);
  } else if (msg.type === "error") {
    snap = { ...snap, error: msg.message };
    emit();
  }
}

export function stopFm(): void {
  if (worker) {
    worker.postMessage({ cmd: "stop" });
    worker.terminate();
    worker = null;
  }
  detachTap?.();
  detachTap = null;
  tapPending = null;
  streamRequested = false;
  streamSinks.clear();
  const outRate = snap.outRate;
  snap = { ...IDLE, outRate };
  emit();
}

/**
 * Subscribe to mono composite batches at the composite rate (MPX over IP).
 * Returns an unsubscribe function; the caller encodes with libflac.
 */
export function subscribeComposite(cb: (l: Float32Array) => void): () => void {
  streamSinks.add(cb);
  return () => {
    streamSinks.delete(cb);
  };
}

/**
 * MPX-over-IP encoder — FLAC at the composite rate (192 kHz mono), the
 * standard transport for feeding a distant exciter or STL receiver.
 * Implements the same ProgramEncoder contract as the program encoders so the
 * TX deck drives it identically.
 */
export class MpxStreamEncoder implements ProgramEncoder {
  onStats: ((stats: EncoderStats) => void) | null = null;
  readonly ext = "flac";
  readonly mime = "audio/flac";

  private flacWorker: Worker | null = null;
  private unsub: (() => void) | null = null;
  private chunks: Uint8Array[] = [];
  private totalBytes = 0;
  private chunkCount = 0;
  private smoothedKbps = 0;
  private startedAt = 0;
  private lastReportAt = 0;
  private active = false;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((e: Error) => void) | null = null;
  private doneResolve: (() => void) | null = null;
  private fatalError: Error | null = null;

  get running(): boolean {
    return this.active;
  }

  /** Start the FM branch (if needed) and the FLAC encoder on its composite. */
  async start(): Promise<void> {
    const engine = getEngine();
    if (!engine.powered || !applied?.on) {
      throw new Error("Engage the FM module and power the engine first");
    }
    syncFm(applied, true);
    await tapPending;
    const outRate = snap.outRate;
    return new Promise<void>((resolve, reject) => {
      const w = new Worker(
        new URL("./encoder.worker.ts", import.meta.url),
        { type: "module" },
      );
      this.flacWorker = w;
      this.readyResolve = resolve;
      this.readyReject = reject;
      w.onerror = (e: ErrorEvent) =>
        reject(new Error(e.message || "FLAC worker failed to load"));
      w.onmessage = (e: MessageEvent) => void this.onMessage(e.data);
      w.postMessage({
        cmd: "init",
        format: "flac",
        sampleRate: outRate,
        channels: 1,
        bitrateKbps: 0,
      });
    });
  }

  private async onMessage(msg: {
    type: string;
    bytes?: Uint8Array;
    message?: string;
  }): Promise<void> {
    if (msg.type === "ready") {
      this.unsub = subscribeComposite((l) => this.push(l));
      this.active = true;
      this.startedAt = performance.now();
      this.lastReportAt = this.startedAt;
      this.readyResolve?.();
      this.readyResolve = null;
      this.readyReject = null;
    } else if (msg.type === "chunk" && msg.bytes) {
      const bytes =
        msg.bytes instanceof Uint8Array ? msg.bytes : new Uint8Array(msg.bytes);
      this.chunks.push(bytes);
      this.totalBytes += bytes.byteLength;
      this.chunkCount += 1;
      const now = performance.now();
      if (this.active && now - this.lastReportAt >= 500) {
        const inst = (this.totalBytes * 8) / Math.max(now - this.startedAt, 1);
        this.smoothedKbps =
          this.smoothedKbps === 0 ? inst : this.smoothedKbps * 0.7 + inst * 0.3;
        this.lastReportAt = now;
        this.onStats?.(this.stats());
      }
    } else if (msg.type === "done") {
      this.doneResolve?.();
      this.doneResolve = null;
    } else if (msg.type === "error") {
      const err = new Error(msg.message ?? "encoder error");
      if (this.readyReject) {
        this.readyReject(err);
        this.readyResolve = null;
        this.readyReject = null;
      } else {
        this.fatalError = err;
        this.doneResolve?.();
        this.doneResolve = null;
      }
    }
  }

  private push(l: Float32Array) {
    if (!this.flacWorker) return;
    // copy — the worker may transfer the batch elsewhere concurrently
    const copy = new Float32Array(l);
    this.flacWorker.postMessage({ cmd: "chunk", channels: [copy] }, [
      copy.buffer,
    ]);
  }

  stats(): EncoderStats {
    return {
      bytes: this.totalBytes,
      elapsedMs: this.active ? performance.now() - this.startedAt : 0,
      kbps: this.smoothedKbps,
      chunks: this.chunkCount,
    };
  }

  /** Flush the FLAC encoder, stop forwarding composite, resolve the take. */
  async stop(): Promise<Blob> {
    const w = this.flacWorker;
    if (!w) return new Blob([], { type: this.mime });
    syncFm(applied ?? DEFAULT_FM, false);
    await new Promise<void>((resolve) => {
      this.doneResolve = resolve;
      w.postMessage({ cmd: "flush" });
    });
    this.unsub?.();
    this.unsub = null;
    w.terminate();
    this.flacWorker = null;
    this.active = false;
    const blob = new Blob(this.chunks as BlobPart[], { type: this.mime });
    this.chunks = [];
    if (this.fatalError) throw this.fatalError;
    return blob;
  }
}

const DEFAULT_FM: FmParams = {
  on: true,
  emphasis: "75",
  // Start from the processor defaults so every new RDS field is carried
  // through (a hand-written literal here silently drops additions).
  mpx: { ...DEFAULT_PARAMS.fm.mpx },
};
