/**
 * Session alarm feed — automatic tolerance monitoring for the console.
 *
 * The Dashboard's HUD tick evaluates the engine snapshot against the loaded
 * chain (true-peak ceiling, output clipping, loudness tolerance, stereo
 * correlation) and fires events here. Each kind has a cooldown so a stuck
 * condition logs once instead of flooding the alarm history.
 *
 * This is deliberately a client-side, session-lifetime feed; the Convex
 * broadcast log keeps the durable station record (sessions, presets,
 * metadata) and is not written to from the audio thread's watchdog.
 */

export type AlarmKind =
  | "peak"
  | "clip"
  | "loudness"
  | "correlation"
  | "mod"
  /** programme feed lost (dead air) */
  | "silence"
  /** standby source took over / programme returned */
  | "failover"
  /** 19 kHz pilot missing or badly off frequency */
  | "pilot"
  /** RDS data stale, PI unset or the subcarrier is unmodulated */
  | "rds"
  /** MPX-over-IP link degraded (loss, jitter, single link) */
  | "link"
  /** audio thread starved — the graph fell behind real time */
  | "glitch";

/** Severity used when an alarm is written to the durable history. */
export const ALARM_SEVERITY: Record<AlarmKind, "critical" | "warning" | "info"> = {
  peak: "warning",
  clip: "critical",
  loudness: "warning",
  correlation: "warning",
  mod: "critical",
  silence: "critical",
  failover: "warning",
  pilot: "warning",
  rds: "warning",
  link: "warning",
  glitch: "critical",
};

export interface AlarmEvent {
  id: number;
  at: number;
  kind: AlarmKind;
  title: string;
  detail: string;
}

const COOLDOWN_MS: Record<AlarmKind, number> = {
  peak: 30_000,
  clip: 30_000,
  loudness: 60_000,
  correlation: 60_000,
  mod: 30_000,
  silence: 60_000,
  failover: 10_000,
  pilot: 60_000,
  rds: 120_000,
  link: 30_000,
  glitch: 60_000,
};

const MAX_EVENTS = 50;

let seq = 0;
let snapshot: AlarmEvent[] = [];
const lastFired: Record<AlarmKind, number> = {
  peak: 0,
  clip: 0,
  loudness: 0,
  correlation: 0,
  mod: 0,
  silence: 0,
  failover: 0,
  pilot: 0,
  rds: 0,
  link: 0,
  glitch: 0,
};

const listeners = new Set<() => void>();

function emit() {
  for (const cb of listeners) cb();
}

/** Immutable snapshot for useSyncExternalStore — replaced only on change. */
export function getAlarms(): AlarmEvent[] {
  return snapshot;
}

export function subscribeAlarms(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function clearAlarms() {
  snapshot = [];
  for (const k of Object.keys(lastFired) as AlarmKind[]) lastFired[k] = 0;
  emit();
}

/**
 * Record an alarm if its kind is outside its cooldown window.
 * Returns true when the event was recorded.
 */
export function fireAlarm(
  kind: AlarmKind,
  title: string,
  detail: string,
): boolean {
  const now = Date.now();
  if (now - lastFired[kind] < COOLDOWN_MS[kind]) return false;
  lastFired[kind] = now;
  seq += 1;
  snapshot = [{ id: seq, at: now, kind, title, detail }, ...snapshot].slice(
    0,
    MAX_EVENTS,
  );
  emit();
  return true;
}
