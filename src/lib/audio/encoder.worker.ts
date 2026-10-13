/**
 * Broadcast encoder worker.
 *
 * Receives batches of Float32 channel data from the PCM tap and streams them
 * through the @audio/encode WASM encoders (MP3 via LAME, FLAC via libflac,
 * Ogg Vorbis via libvorbis, HE-AAC v2 via the FDK-AAC build). Container
 * chunks are posted back for measurement and assembly — the same contract
 * MediaRecorder provides for the native formats.
 */
import encode, { type EncodeOptions, type StreamEncoder } from "@audio/encode";
import type { JsFormat } from "./encoder";

export interface InitMsg {
  cmd: "init";
  format: JsFormat;
  sampleRate: number;
  channels: number;
  bitrateKbps: number;
}
export interface ChunkMsg {
  cmd: "chunk";
  channels: Float32Array[];
}
export interface FlushMsg {
  cmd: "flush";
}
export type WorkerIn = InitMsg | ChunkMsg | FlushMsg;

export type WorkerOut =
  | { type: "ready" }
  | { type: "chunk"; bytes: Uint8Array }
  | { type: "done" }
  | { type: "error"; message: string };

const worker = globalThis as unknown as {
  postMessage(m: unknown, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<WorkerIn>) => void) | null;
};

let encoder: StreamEncoder | null = null;

function optionsFor(msg: InitMsg): EncodeOptions {
  const base: EncodeOptions = {
    sampleRate: msg.sampleRate,
    channels: msg.channels,
    stream: true,
  };
  switch (msg.format) {
    case "flac":
      // lossless: 16-bit, mid compression
      return { ...base, bitDepth: 16, compression: 5 };
    case "ogg":
      // Vorbis VBR quality 0–10 — ~4 ≈ 128 kbps
      return { ...base, quality: Math.max(0, Math.min(10, Math.round(msg.bitrateKbps / 32))) };
    case "aac":
      // HE-AAC v2 (SBR + parametric stereo) through the FDK wasm build
      return { ...base, bitrate: msg.bitrateKbps, profile: "hev2" };
    case "aac-lc":
      // standard AAC-LC (WebCodecs where available, else FDK wasm)
      return { ...base, bitrate: msg.bitrateKbps, profile: "lc" };
    default:
      return { ...base, bitrate: msg.bitrateKbps };
  }
}

worker.onmessage = (e: MessageEvent<WorkerIn>) => {
  void handle(e.data);
};

async function handle(msg: WorkerIn): Promise<void> {
  try {
    if (msg.cmd === "init") {
      encoder = await encode(msg.format, optionsFor(msg));
      worker.postMessage({ type: "ready" } satisfies WorkerOut);
    } else if (msg.cmd === "chunk" && encoder) {
      const out = await encoder(msg.channels);
      if (out && out.length > 0) {
        worker.postMessage({ type: "chunk", bytes: out } satisfies WorkerOut, [out.buffer]);
      }
    } else if (msg.cmd === "flush" && encoder) {
      const out = await encoder(); // flush + free
      if (out && out.length > 0) {
        worker.postMessage({ type: "chunk", bytes: out } satisfies WorkerOut, [out.buffer]);
      }
      encoder = null;
      worker.postMessage({ type: "done" } satisfies WorkerOut);
    }
  } catch (err) {
    worker.postMessage(
      {
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      } satisfies WorkerOut,
    );
  }
}
