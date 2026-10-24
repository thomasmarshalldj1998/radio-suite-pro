/**
 * PCM capture + WASM streaming encoders for the delivery-matrix formats that
 * MediaRecorder cannot produce (MP3, FLAC, Ogg Vorbis, HE-AAC v2).
 *
 * The processed program bus (same tap the live encoder send uses) is captured
 * through an AudioWorklet — a Blob-URL module, so no build-time asset is
 * needed — with a ScriptProcessor fallback for engines without worklets.
 * Float32 channel batches are transferred to a module worker running the
 * @audio/encode WASM encoders; container chunks are measured exactly like
 * MediaRecorder chunks.
 */
import type { EncoderStats, JsFormat, ProgramEncoder } from "./encoder";
import { getEngine } from "./engine";

const MIME: Record<JsFormat, { mime: string; ext: string }> = {
  mp3: { mime: "audio/mpeg", ext: "mp3" },
  flac: { mime: "audio/flac", ext: "flac" },
  ogg: { mime: "audio/ogg", ext: "ogg" },
  aac: { mime: "audio/aac", ext: "aac" },
  "aac-lc": { mime: "audio/aac", ext: "aac" },
  opus: { mime: "audio/ogg", ext: "ogg" },
};

const TAP_NAME = "signalpath-pcm-tap";
/** Frames per posted batch (~85 ms at 48 kHz). */
const BATCH = 4096;

const TAP_WORKLET = `
class SignalpathPcmTap extends AudioWorkletProcessor {
  constructor() {
    super();
    // One batch pair, allocated at load. process() only copies samples.
    this.l = new Float32Array(${BATCH});
    this.r = new Float32Array(${BATCH});
    this.fill = 0;
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0 || !input[0] || input[0].length === 0) return true;
    const l = input[0];
    const r = input.length > 1 && input[1] ? input[1] : input[0];
    // Copy sample by sample: no views, no arrays, no growth. The message is
    // cloned synchronously at postMessage, so the staging buffers are reused
    // by the very next block and the audio thread never allocates.
    for (let i = 0; i < l.length; i++) {
      this.l[this.fill] = l[i];
      this.r[this.fill] = r[i];
      this.fill += 1;
      if (this.fill === ${BATCH}) {
        this.port.postMessage({ l: this.l, r: this.r });
        this.fill = 0;
      }
    }
    return true;
  }
}
try { registerProcessor("${TAP_NAME}", SignalpathPcmTap); } catch (e) { /* already registered */ }
`;

type TapCallback = (l: Float32Array, r: Float32Array) => void;

/** The generated tap module — exported so the RT-safety suite can inspect it. */
export function pcmTapWorkletSource(): string {
  return TAP_WORKLET;
}

/**
 * Attach a silent PCM tap to the program bus. Returns a cleanup function.
 * Prefers an AudioWorklet; falls back to a ScriptProcessorNode.
 */
export async function attachPcmTap(onBatch: TapCallback): Promise<() => void> {
  const engine = getEngine();
  const ctx = engine.ctx;
  // Prefer the program node itself over the engine's MediaStream. The stream
  // hop resamples and is re-clocked with the output device, so a sink change
  // restarts the capture mid-batch — a splice the encoder then has to emit.
  // The graph node sits upstream of the device and cannot be renegotiated
  // out from under the tap.
  const node = engine.getCaptureNode();
  const stream = node ? null : engine.getStream();
  if (!ctx || (!node && !stream)) throw new Error("Audio engine is not running");
  const source = node ?? ctx.createMediaStreamSource(stream!);

  // AudioWorklet path (blob URL — survives Vite without a build-time asset)
  if (ctx.audioWorklet) {
    try {
      const url = URL.createObjectURL(
        new Blob([TAP_WORKLET], { type: "text/javascript" }),
      );
      try {
        await ctx.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      const node = new AudioWorkletNode(ctx, TAP_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      });
      node.port.onmessage = (e: MessageEvent) => {
        const { l, r } = e.data as { l: Float32Array; r: Float32Array };
        onBatch(l, r);
      };
      // worklets only process when their output reaches the destination —
      // park it behind a muted sink so the graph keeps pulling
      const sink = ctx.createGain();
      sink.gain.value = 0;
      source.connect(node);
      node.connect(sink);
      sink.connect(ctx.destination);
      return () => {
        source.disconnect();
        node.disconnect();
        sink.disconnect();
        node.port.onmessage = null;
      };
    } catch {
      /* fall through to ScriptProcessor */
    }
  }

  // ScriptProcessor fallback
  const sp = ctx.createScriptProcessor(BATCH, 2, 2);
  sp.onaudioprocess = (e: AudioProcessingEvent) => {
    const ib = e.inputBuffer;
    onBatch(
      new Float32Array(ib.getChannelData(0)),
      new Float32Array(ib.getChannelData(1)),
    );
  };
  const sink = ctx.createGain();
  sink.gain.value = 0;
  source.connect(sp);
  sp.connect(sink);
  sink.connect(ctx.destination);
  return () => {
    source.disconnect();
    sp.disconnect();
    sink.disconnect();
    sp.onaudioprocess = null;
  };
}

interface WorkerOutMsg {
  type: "ready" | "chunk" | "done" | "error";
  bytes?: Uint8Array;
  message?: string;
}

/**
 * Live program encoder for WASM-backed formats. Same contract as
 * StreamEncoder: start() → onStats callbacks → stop() resolves the take.
 */
export class JsStreamEncoder implements ProgramEncoder {
  onStats: ((stats: EncoderStats) => void) | null = null;
  onChunk: ((bytes: Uint8Array) => void) | null = null;
  readonly mime: string;
  readonly ext: string;

  private worker: Worker | null = null;
  private detachTap: (() => void) | null = null;
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
  private readonly opts: {
    format: JsFormat;
    sampleRate: number;
    channels: number;
    bitrateKbps: number;
  };

  constructor(opts: {
    format: JsFormat;
    sampleRate: number;
    channels: number;
    bitrateKbps: number;
  }) {
    this.opts = opts;
    this.mime = MIME[opts.format].mime;
    this.ext = MIME[opts.format].ext;
  }

  get running(): boolean {
    return this.active;
  }

  start(): Promise<void> {
    if (this.worker) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const worker = new Worker(
        new URL("./encoder.worker.ts", import.meta.url),
        { type: "module" },
      );
      this.worker = worker;
      this.readyResolve = resolve;
      this.readyReject = reject;
      worker.onerror = (e: ErrorEvent) =>
        this.failReady(new Error(e.message || "encoder worker failed to load"));
      worker.onmessage = (e: MessageEvent) => void this.onMessage(e.data);
      worker.postMessage({
        cmd: "init",
        format: this.opts.format,
        sampleRate: this.opts.sampleRate,
        channels: this.opts.channels,
        bitrateKbps: this.opts.bitrateKbps,
      });
    });
  }

  private failReady(err: Error) {
    this.readyReject?.(err);
    this.readyResolve = null;
    this.readyReject = null;
    this.teardown();
  }

  private teardown() {
    this.detachTap?.();
    this.detachTap = null;
    this.worker?.terminate();
    this.worker = null;
    this.active = false;
  }

  private async onMessage(msg: WorkerOutMsg): Promise<void> {
    if (msg.type === "ready") {
      try {
        this.detachTap = await attachPcmTap((l, r) => this.push(l, r));
        this.active = true;
        this.startedAt = performance.now();
        this.lastReportAt = this.startedAt;
        this.readyResolve?.();
        this.readyResolve = null;
        this.readyReject = null;
      } catch (err) {
        this.failReady(err instanceof Error ? err : new Error(String(err)));
      }
    } else if (msg.type === "chunk" && msg.bytes) {
      const bytes =
        msg.bytes instanceof Uint8Array ? msg.bytes : new Uint8Array(msg.bytes);
      this.chunks.push(bytes);
      this.totalBytes += bytes.byteLength;
      this.chunkCount += 1;
      this.onChunk?.(bytes);
      const now = performance.now();
      if (this.active && now - this.lastReportAt >= 500) {
        // bits per ms = kbps
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
        this.failReady(err);
      } else {
        this.fatalError = err;
        this.doneResolve?.();
        this.doneResolve = null;
      }
    }
  }

  private push(l: Float32Array, r: Float32Array) {
    if (!this.worker) return;
    this.worker.postMessage({ cmd: "chunk", channels: [l, r] }, [
      l.buffer,
      r.buffer,
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

  /** Flush the encoder, stop the tap and resolve the encoded take. */
  async stop(): Promise<Blob> {
    const worker = this.worker;
    if (!worker) return new Blob([], { type: this.mime });
    await new Promise<void>((resolve) => {
      this.doneResolve = resolve;
      worker.postMessage({ cmd: "flush" });
    });
    this.detachTap?.();
    this.detachTap = null;
    worker.terminate();
    this.worker = null;
    this.active = false;
    const blob = new Blob(this.chunks as BlobPart[], { type: this.mime });
    this.chunks = [];
    if (this.fatalError) throw this.fatalError;
    return blob;
  }
}
