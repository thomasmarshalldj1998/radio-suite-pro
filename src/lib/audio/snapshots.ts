import type { ProcessorParams } from "@/lib/audio/params";

/**
 * SNAPSHOTS A/B/C — three instant-recall slots holding the complete
 * processor state (chain params + name + timestamp) for live operation.
 * Device-local by design: snapshots must survive offline use, so they live
 * in localStorage, not the cloud backend.
 */

export type SnapshotSlot = "A" | "B" | "C";
export const SNAPSHOT_SLOTS: SnapshotSlot[] = ["A", "B", "C"];

export interface Snapshot {
  name: string;
  params: ProcessorParams;
  at: number;
}

type Bank = Record<SnapshotSlot, Snapshot | null>;

const KEY = "signalpath.snapshots.v1";

function empty(): Bank {
  return { A: null, B: null, C: null };
}

export function loadSnapshots(): Bank {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return empty();
    const p = JSON.parse(raw) as Partial<Record<SnapshotSlot, Snapshot>>;
    const bank = empty();
    for (const s of SNAPSHOT_SLOTS) {
      const e = p[s];
      if (e && typeof e.name === "string" && e.params && typeof e.params === "object") {
        bank[s] = { name: e.name, params: e.params, at: e.at ?? 0 };
      }
    }
    return bank;
  } catch {
    return empty();
  }
}

function store(bank: Bank): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(bank));
  } catch {
    /* storage may be unavailable */
  }
}

export function saveSnapshot(
  bank: Bank,
  slot: SnapshotSlot,
  snap: Snapshot,
): Bank {
  const next = { ...bank, [slot]: snap };
  store(next);
  return next;
}

export function clearSnapshot(bank: Bank, slot: SnapshotSlot): Bank {
  const next = { ...bank, [slot]: null };
  store(next);
  return next;
}
