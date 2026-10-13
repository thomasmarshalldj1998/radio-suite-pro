import { useEffect, useReducer } from "react";
import type { ProbeResult } from "./encoder";
import { getRuntime } from "./runtime";

/** One output slot in the 8-output broadcast matrix. */
export interface MountForm {
  name: string;
  protocol: string;
  server: string;
  port: number;
  mount: string;
  username: string;
  password: string;
  codec: string;
  bitrateKbps: number;
  sampleRateKhz: number;
  channels: string;
  targetFormat: string;
}

/** An unconfigured output slot — renders as “―” in the outputs tables. */
export const EMPTY_SLOT: MountForm = {
  name: "",
  protocol: "",
  server: "",
  port: 0,
  mount: "",
  username: "",
  password: "",
  codec: "opus",
  bitrateKbps: 0,
  sampleRateKhz: 48,
  channels: "stereo",
  targetFormat: "",
};

export const OUTPUT_COUNT = 8;
const STORAGE_KEY = "signalpath.outputs.v1";

export const isConfigured = (s: MountForm) => Boolean(s.server || s.name);

function load(): MountForm[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        return Array.from({ length: OUTPUT_COUNT }, (_, i) => {
          const p = (parsed[i] ?? {}) as Partial<MountForm>;
          return { ...EMPTY_SLOT, ...p };
        });
      }
    }
  } catch {
    /* fall through to empty slots */
  }
  return Array.from({ length: OUTPUT_COUNT }, () => ({ ...EMPTY_SLOT }));
}

let slots: MountForm[] = load();
let liveSlot = -1;
let probes: Record<number, ProbeResult> = {};

const listeners = new Set<() => void>();

function notify() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(slots));
  } catch {
    /* storage may be unavailable */
  }
  for (const cb of listeners) cb();
}

export function subscribeOutputs(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function getOutputs(): {
  slots: MountForm[];
  liveSlot: number;
  probes: Record<number, ProbeResult>;
} {
  return { slots, liveSlot, probes };
}

export function setOutputs(next: MountForm[]) {
  slots = next;
  notify();
}

export function updateOutput(i: number, updater: (prev: MountForm) => MountForm) {
  slots = slots.map((s, idx) => (idx === i ? updater(s) : s));
  notify();
}

/** Seed a slot from the saved station mount only while the matrix is empty. */
export function seedOutputIfEmpty(seed: MountForm) {
  if (slots.some(isConfigured)) return;
  slots = slots.map((s, i) => (i === 0 ? seed : s));
  notify();
}

export function setLiveOutput(i: number) {
  liveSlot = i;
  notify();
}

export function setProbes(next: Record<number, ProbeResult>) {
  probes = next;
  notify();
}

export type OutputStatusKind = "empty" | "ready" | "onair" | "ok" | "error";

/** Derived status for one output: empty · ready · on air · probe result. */
export function outputStatus(i: number): {
  kind: OutputStatusKind;
  label: string;
} {
  const s = slots[i];
  if (!s || !isConfigured(s)) return { kind: "empty", label: "—" };
  if (getRuntime().onAir && liveSlot === i)
    return { kind: "onair", label: "On air" };
  const p = probes[i];
  if (p) {
    return p.ok
      ? { kind: "ok", label: `OK · ${p.ms} ms` }
      : { kind: "error", label: "Error" };
  }
  return { kind: "ready", label: "Ready" };
}

/** React subscription: re-render on any matrix change. */
export function useOutputs() {
  const [, force] = useReducer((n: number) => n + 1, 0);
  useEffect(() => subscribeOutputs(force), []);
  return getOutputs();
}
