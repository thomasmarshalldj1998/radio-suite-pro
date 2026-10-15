/**
 * FM MPX worker — runs the composite generator off the program-bus PCM
 * batches, off the main thread. Posts metering ticks (mod %, clip %, component
 * deviation) and the composite spectrum back; optionally forwards composite
 * batches to the MPX-over-IP FLAC encoder while that stream is live.
 */
import type { FmParams } from "./params";
import { MpxGenerator, spectrumDb, type MpxTickStats } from "./mpx";

export interface MpxInitMsg {
  cmd: "init";
  inRate: number;
  fm: FmParams;
  /** Forward composite to an already-running FLAC worker (MPX over IP). */
  stream: boolean;
}
export interface MpxChunkMsg {
  cmd: "chunk";
  channels: Float32Array[];
}
export interface MpxParamsMsg {
  cmd: "params";
  fm: FmParams;
  stream: boolean;
}
export interface MpxStopMsg {
  cmd: "stop";
}
export type MpxWorkerIn =
  | MpxInitMsg
  | MpxChunkMsg
  | MpxParamsMsg
  | MpxStopMsg;

export type MpxWorkerOut =
  | { type: "ready" }
  | { type: "tick"; stats: MpxTickStats; spectrum: Float32Array; outRate: number }
  | { type: "composite"; channels: Float32Array[] }
  | { type: "error"; message: string };

const worker = globalThis as unknown as {
  postMessage(m: unknown, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<MpxWorkerIn>) => void) | null;
};

let gen: MpxGenerator | null = null;
let streamOn = false;
let lastComp: Float32Array | null = null;
/** Post a metering tick every N batches (~680 ms at 48 kHz / 4096). */
const TICK_EVERY = 8;
let batchCount = 0;

worker.onmessage = (e: MessageEvent<MpxWorkerIn>) => handle(e.data);

function handle(msg: MpxWorkerIn): void {
  try {
    if (msg.cmd === "init") {
      gen = new MpxGenerator(msg.inRate, msg.fm);
      streamOn = msg.stream;
      worker.postMessage({ type: "ready" } satisfies MpxWorkerOut);
    } else if (msg.cmd === "params" && gen) {
      gen.setParams(msg.fm);
      streamOn = msg.stream;
    } else if (msg.cmd === "chunk" && gen) {
      const [l, r] = msg.channels;
      const comp = gen.process(l, r);
      lastComp = comp;
      if (streamOn) {
        // mono composite copy for the FLAC encoder (composite rate)
        const copy = new Float32Array(comp);
        worker.postMessage(
          { type: "composite", channels: [copy] } satisfies MpxWorkerOut,
          [copy.buffer],
        );
      }
      batchCount += 1;
      if (batchCount % TICK_EVERY === 0) {
        const spectrum = spectrumDb(comp);
        worker.postMessage(
          {
            type: "tick",
            stats: gen.takeStats(),
            spectrum,
            outRate: gen.outRate,
          } satisfies MpxWorkerOut,
          [spectrum.buffer],
        );
      }
    } else if (msg.cmd === "stop") {
      gen = null;
      lastComp = null;
      streamOn = false;
    }
  } catch (err) {
    worker.postMessage({
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    } satisfies MpxWorkerOut);
  }
  // silence unused when the generator is torn down
  void lastComp;
}
