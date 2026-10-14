import type { EncoderStats, ProgramEncoder } from "./encoder";

/**
 * Module-scope broadcast runtime. The encoder must survive tab switches
 * inside the app (leaving the Encoder tab must not stop the stream), so the
 * recorder handle and take list live here with a tiny pub/sub, while React
 * components subscribe for re-renders.
 */
export interface Take {
  id: string;
  name: string;
  url: string;
  ext: string;
  bytes: number;
  durationMs: number;
  at: number;
}

export interface StreamRuntime {
  onAir: boolean;
  encoder: ProgramEncoder | null;
  stats: EncoderStats;
  startedAt: number;
  takes: Take[];
  /** Total connection attempts this session — first is initial, the rest reconnects. */
  connects: number;
  /** Last connection failure (message + time) — cleared on success or manual stop. */
  lastError: { message: string; at: number } | null;
}

const runtime: StreamRuntime = {
  onAir: false,
  encoder: null,
  stats: { bytes: 0, elapsedMs: 0, kbps: 0, chunks: 0 },
  startedAt: 0,
  takes: [],
  connects: 0,
  lastError: null,
};

const listeners = new Set<() => void>();

function emit() {
  for (const cb of listeners) cb();
}

export function getRuntime(): StreamRuntime {
  return runtime;
}

export function subscribeRuntime(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function patchRuntime(patch: Partial<StreamRuntime>) {
  Object.assign(runtime, patch);
  emit();
}

export function addTake(take: Take) {
  runtime.takes.unshift(take);
  if (runtime.takes.length > 20) {
    const dropped = runtime.takes.pop();
    if (dropped) URL.revokeObjectURL(dropped.url);
  }
  emit();
}

let takeSeq = 0;
export function nextTakeId(): string {
  takeSeq += 1;
  return `take-${Date.now()}-${takeSeq}`;
}
