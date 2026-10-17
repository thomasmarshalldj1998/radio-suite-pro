/**
 * Dayparting — which scheduled slot is live right now.
 *
 * Pure helpers only: the console owns persistence (Convex in the web build,
 * device storage in the standalone package) and this module decides which slot
 * the clock says is active, including slots that wrap past midnight (a
 * 22:00–06:00 overnight chain belongs to the day it *started*).
 */

export interface ScheduleSlot {
  _id: string;
  name: string;
  /** 0 = Sunday … 6 = Saturday */
  days: number[];
  /** minutes past local midnight */
  startMin: number;
  endMin: number;
  presetName: string;
  params: unknown;
  enabled: boolean;
  updatedAt: number;
}

export const DAY_LABELS = [
  "Sun",
  "Mon",
  "Tue",
  "Wed",
  "Thu",
  "Fri",
  "Sat",
] as const;

export const DAY_SHORT = ["S", "M", "T", "W", "T", "F", "S"] as const;

/** Minutes past local midnight for a Date. */
export function minutesOfDay(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
}

/** "06:00" from minutes past midnight (handles 24:00 as 00:00). */
export function formatMinute(min: number): string {
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  return `${String(h).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** "06:00" → 360 (accepts "6:00" too). Returns null when unparseable. */
export function parseMinute(text: string): number | null {
  const match = /^\s*(\d{1,2}):?(\d{2})?\s*$/.exec(text);
  if (!match) return null;
  const h = Number(match[1]);
  const m = match[2] ? Number(match[2]) : 0;
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  if (h > 23 || m > 59) return null;
  return h * 60 + m;
}

/** "Mon–Fri" style summary of the selected days. */
export function describeDays(days: number[]): string {
  const sorted = Array.from(new Set(days)).sort((a, b) => a - b);
  if (sorted.length === 0) return "never";
  if (sorted.length === 7) return "every day";
  const runs: number[][] = [];
  for (const d of sorted) {
    const last = runs[runs.length - 1];
    if (last && d === last[last.length - 1] + 1) last.push(d);
    else runs.push([d]);
  }
  return runs
    .map((run) =>
      run.length === 1
        ? DAY_LABELS[run[0]]
        : `${DAY_LABELS[run[0]]}–${DAY_LABELS[run[run.length - 1]]}`,
    )
    .join(", ");
}

/** Does this slot cover the given local time? */
export function isSlotActive(slot: ScheduleSlot, date: Date): boolean {
  if (!slot.enabled) return false;
  const day = date.getDay();
  const minute = minutesOfDay(date);
  if (slot.startMin <= slot.endMin) {
    return (
      slot.days.includes(day) &&
      minute >= slot.startMin &&
      minute < slot.endMin
    );
  }
  // wraps midnight: the tail belongs to the day the slot started
  const previous = (day + 6) % 7;
  if (slot.days.includes(day) && minute >= slot.startMin) return true;
  return slot.days.includes(previous) && minute < slot.endMin;
}

/** The live slot, or null when the schedule is empty / nothing is due. */
export function resolveActiveSchedule<T extends ScheduleSlot>(
  schedules: T[] | undefined,
  date: Date = new Date(),
): T | null {
  if (!schedules || schedules.length === 0) return null;
  const matches = schedules.filter((s) => isSlotActive(s, date));
  if (matches.length === 0) return null;
  const minute = minutesOfDay(date);
  // When slots overlap the most recently started one wins; a wrapped slot is
  // measured from its start on the previous day.
  const elapsed = (s: T): number => {
    if (s.startMin <= s.endMin) return minute - s.startMin;
    return minute >= s.startMin
      ? minute - s.startMin
      : minute + 1440 - s.startMin;
  };
  return matches.reduce((best, s) => (elapsed(s) < elapsed(best) ? s : best));
}

/** The next slot to start (for "up next" displays). */
export function nextSchedule<T extends ScheduleSlot>(
  schedules: T[] | undefined,
  date: Date = new Date(),
): { slot: T; inMinutes: number } | null {
  const active = schedules?.filter((s) => s.enabled) ?? [];
  if (active.length === 0) return null;
  const day = date.getDay();
  const minute = minutesOfDay(date);
  let best: { slot: T; inMinutes: number } | null = null;
  for (let offset = 0; offset <= 7; offset++) {
    const di = (day + offset) % 7;
    for (const slot of active) {
      if (!slot.days.includes(di)) continue;
      let inMinutes = offset * 1440 + slot.startMin - minute;
      if (inMinutes <= 0) inMinutes += 1440 * (offset === 0 ? 1 : 0);
      if (inMinutes <= 0) continue;
      if (!best || inMinutes < best.inMinutes) best = { slot, inMinutes };
    }
    if (best) break;
  }
  return best;
}
