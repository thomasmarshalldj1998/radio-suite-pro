/**
 * Dead-air protection.
 *
 * The watchdog reads the engine's pre-gate programme level every tick. When the
 * feed stays below `thresholdDb` for `holdMs` it takes over automatically: the
 * chain cross-fades to the armed standby source (any audio file the operator
 * picked, looped), an event is emitted for the alarm history, and when the
 * programme has been healthy again for `returnMs` the chain cross-fades back.
 *
 * Manual take-over and return are always available, and a manual take-over
 * stays put — the watchdog will not yank the operator off the backup source.
 * Everything here is module scope (like `alarms.ts` / `outputs.ts`) so the
 * protection survives tab switches, and the settings persist per device.
 */
import { getEngine } from "./engine";

export interface FailoverConfig {
  /** Watchdog armed. The standby source can still be loaded while disarmed. */
  enabled: boolean;
  /** Programme considered lost below this level (dBFS). */
  thresholdDb: number;
  /** How long the feed must stay dead before automatic take-over (ms). */
  holdMs: number;
  /** How long the feed must be healthy before automatic return (ms). */
  returnMs: number;
  /** Take-over / return cross-fade (ms). */
  fadeMs: number;
}

export const DEFAULT_FAILOVER: FailoverConfig = {
  enabled: false,
  thresholdDb: -48,
  holdMs: 4000,
  returnMs: 8000,
  fadeMs: 250,
};

export interface FailoverState {
  config: FailoverConfig;
  /** Standby source armed (a file is loaded into the engine). */
  loaded: boolean;
  /** Standby source file name. */
  name: string | null;
  /** Backup is feeding the chain right now. */
  active: boolean;
  /** How the current take-over was started. */
  trigger: "auto" | "manual" | null;
  /** Epoch ms of the current take-over (0 when not on backup). */
  since: number;
  /** Current dead-air episode length (ms; 0 when healthy). */
  deadMs: number;
  /** How long the programme has been healthy (ms). */
  healthyMs: number;
  /** Latest measured programme level (dBFS). */
  levelDb: number;
  /** Quietest-programme estimate from the last auto-tune (dBFS; null = never). */
  floorDb: number | null;
  /** Epoch ms of the last auto-tune (0 = never). */
  tunedAt: number;
  /** Automatic take-overs this session. */
  takes: number;
  /** Last state change, for the status line. */
  lastEvent: string | null;
  lastEventAt: number;
  /** Internal: timestamp of the previous tick (episode timing). */
  lastTickAt: number;
}

/** Emitted on every automatic transition so the caller can alarm + log it. */
export interface FailoverEvent {
  type: "takeover" | "return";
  reason: string;
  at: number;
  /** Dead-air episode length that triggered a take-over (ms). */
  deadMs: number;
}

const STORAGE_KEY = "signalpath.failover.v1";

/** Programme levels kept for auto-tune (about two minutes at the 2 Hz tick). */
const TRACE_MS = 120_000;
const levelTrace: { at: number; db: number; backup: boolean }[] = [];

function recordLevel(levelDb: number, at: number, backup: boolean) {
  const last = levelTrace[levelTrace.length - 1];
  if (last && at - last.at < 100) return;
  levelTrace.push({ at, db: levelDb, backup });
  const cutoff = at - TRACE_MS;
  while (levelTrace.length > 0 && levelTrace[0].at < cutoff) levelTrace.shift();
}

/** Result of a measured auto-tune, with the figures behind the setting. */
export interface FailoverTuning {
  ok: boolean;
  reason: string;
  thresholdDb: number;
  holdMs: number;
  returnMs: number;
  fadeMs: number;
  /** Quietest-programme percentile the threshold was derived from. */
  floorDb: number;
  medianDb: number;
  /** Spread (dB) between typical programme and its quiet passages. */
  spreadDb: number;
  samples: number;
}

/**
 * Measure the station rather than guessing at it.
 *
 * A dead-air threshold set too high trips on quiet speech; set too low it
 * misses a dead carrier. This takes the last ~90 s of genuine programme
 * (not standby, not digital silence), finds its quietest decile and places
 * the threshold 10 dB below that. The hold follows the measured level
 * spread: a station that runs ads 15 dB hotter than speech gets a longer
 * hold, so a quiet link doesn't look like a dead one.
 */
export function tuneFailover(now = Date.now()): FailoverTuning {
  const samples = levelTrace.filter(
    (s) =>
      now - s.at <= 90_000 &&
      !s.backup &&
      Number.isFinite(s.db) &&
      s.db > -80 &&
      s.db < -3,
  );
  const cfg = state.config;
  if (samples.length < 12) {
    return {
      ok: false,
      reason: "Not enough programme yet — run the engine with programme for about 10 seconds.",
      thresholdDb: cfg.thresholdDb,
      holdMs: cfg.holdMs,
      returnMs: cfg.returnMs,
      fadeMs: cfg.fadeMs,
      floorDb: state.floorDb ?? -70,
      medianDb: -70,
      spreadDb: 0,
      samples: samples.length,
    };
  }

  const dbs = samples.map((s) => s.db).sort((a, b) => a - b);
  const pct = (p: number) =>
    dbs[Math.min(dbs.length - 1, Math.max(0, Math.round(p * (dbs.length - 1))))];
  const floorDb = pct(0.1);
  const medianDb = pct(0.5);
  const p90 = pct(0.9);
  const spreadDb = Math.max(0, p90 - floorDb);
  const quantize = (v: number, step: number) => Math.round(v / step) * step;

  const thresholdDb = quantize(
    Math.max(-75, Math.min(-25, floorDb - 10)),
    0.5,
  );
  const holdMs = quantize(
    Math.max(2500, Math.min(9000, 2500 + spreadDb * 50)),
    500,
  );
  const returnMs = quantize(Math.max(5000, Math.min(18_000, holdMs * 2)), 500);
  const fadeMs = quantize(Math.max(150, Math.min(800, holdMs / 8)), 10);

  setFailoverConfig({ thresholdDb, holdMs, returnMs, fadeMs });
  commit({
    floorDb,
    tunedAt: now,
    lastEvent: `Auto-tuned from ${samples.length} programme samples — threshold ${thresholdDb.toFixed(1)} dBFS (floor ${floorDb.toFixed(1)} dBFS)`,
    lastEventAt: now,
  });

  return {
    ok: true,
    reason: "measured programme floor",
    thresholdDb,
    holdMs,
    returnMs,
    fadeMs,
    floorDb,
    medianDb,
    spreadDb,
    samples: samples.length,
  };
}

function loadConfig(): FailoverConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_FAILOVER };
    const parsed = JSON.parse(raw) as Partial<FailoverConfig>;
    return {
      enabled: parsed.enabled ?? DEFAULT_FAILOVER.enabled,
      thresholdDb:
        typeof parsed.thresholdDb === "number"
          ? parsed.thresholdDb
          : DEFAULT_FAILOVER.thresholdDb,
      holdMs:
        typeof parsed.holdMs === "number"
          ? Math.max(500, Math.min(parsed.holdMs, 60_000))
          : DEFAULT_FAILOVER.holdMs,
      returnMs:
        typeof parsed.returnMs === "number"
          ? Math.max(1000, Math.min(parsed.returnMs, 120_000))
          : DEFAULT_FAILOVER.returnMs,
      fadeMs:
        typeof parsed.fadeMs === "number"
          ? Math.max(20, Math.min(parsed.fadeMs, 3000))
          : DEFAULT_FAILOVER.fadeMs,
    };
  } catch {
    return { ...DEFAULT_FAILOVER };
  }
}

let state: FailoverState = {
  config: loadConfig(),
  loaded: false,
  name: null,
  active: false,
  trigger: null,
  since: 0,
  deadMs: 0,
  healthyMs: 0,
  levelDb: -120,
  floorDb: null,
  tunedAt: 0,
  takes: 0,
  lastEvent: null,
  lastEventAt: 0,
  lastTickAt: 0,
};

/**
 * The picked standby file is held here as well as in the engine: the engine
 * drops its media element on power-off, so the watchdog can re-arm the same
 * file without asking the operator to pick it again.
 */
let backupFile: File | null = null;

const listeners = new Set<() => void>();

function emit() {
  for (const cb of listeners) cb();
}

function commit(patch: Partial<FailoverState>) {
  state = { ...state, ...patch };
  emit();
}

export function getFailover(): FailoverState {
  return state;
}

export function subscribeFailover(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function setFailoverConfig(patch: Partial<FailoverConfig>) {
  // ignore half-typed numbers (an empty input yields NaN, which would silently
  // disable the watchdog) and keep the timings physical
  const clean: Partial<FailoverConfig> = {};
  for (const key of ["enabled"] as const) {
    if (typeof patch[key] === "boolean") clean[key] = patch[key];
  }
  const clamp = (v: unknown, lo: number, hi: number): number | undefined =>
    typeof v === "number" && Number.isFinite(v)
      ? Math.max(lo, Math.min(v, hi))
      : undefined;
  const threshold = clamp(patch.thresholdDb, -90, -6);
  const hold = clamp(patch.holdMs, 500, 60_000);
  const ret = clamp(patch.returnMs, 1000, 120_000);
  const fade = clamp(patch.fadeMs, 20, 3000);
  if (threshold !== undefined) clean.thresholdDb = threshold;
  if (hold !== undefined) clean.holdMs = hold;
  if (ret !== undefined) clean.returnMs = ret;
  if (fade !== undefined) clean.fadeMs = fade;
  state = { ...state, config: { ...state.config, ...clean } };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.config));
  } catch {
    /* storage unavailable — settings stay session-only */
  }
  if (!state.config.enabled && state.active && state.trigger === "auto") {
    returnToProgram("watchdog disarmed");
  }
  emit();
}

/** Arm (or replace) the standby source. Must come from a user gesture. */
export function armBackupFile(file: File) {
  backupFile = file;
  getEngine().loadBackupFile(file);
  commit({ loaded: true, name: file.name });
}

export function disarmBackup() {
  backupFile = null;
  getEngine().clearBackup();
  commit({
    loaded: false,
    name: null,
    active: false,
    trigger: null,
    since: 0,
    lastEvent: "Standby source unloaded",
    lastEventAt: Date.now(),
  });
}

/**
 * Re-load the picked standby file if the engine lost it (power cycle) or was
 * rebuilt. Cheap no-op while the engine still holds it.
 */
function ensureArmed() {
  const engine = getEngine();
  if (!backupFile) {
    if (state.loaded) commit({ loaded: false, name: null });
    return;
  }
  if (engine.backupLoaded) {
    if (!state.loaded) commit({ loaded: true, name: engine.backupName });
    return;
  }
  engine.loadBackupFile(backupFile);
  commit({ loaded: true, name: backupFile.name });
}

/** Operator take-over — holds until the operator returns to programme. */
export function takeOver(reason = "manual take-over") {
  ensureArmed();
  const engine = getEngine();
  if (!engine.backupLoaded) return false;
  engine.setBackupActive(true, state.config.fadeMs);
  commit({
    active: true,
    trigger: "manual",
    since: Date.now(),
    lastEvent: `Standby source on air — ${reason}`,
    lastEventAt: Date.now(),
  });
  return true;
}

/** Operator return to programme. */
export function returnToProgram(reason = "operator returned to programme") {
  const engine = getEngine();
  const wasActive = state.active;
  engine.setBackupActive(false, state.config.fadeMs);
  commit({
    active: false,
    trigger: null,
    since: 0,
    deadMs: 0,
    healthyMs: 0,
    lastEvent: wasActive ? `Programme restored — ${reason}` : state.lastEvent,
    lastEventAt: wasActive ? Date.now() : state.lastEventAt,
  });
  return wasActive;
}

/**
 * Watchdog tick — call from the console's metering loop (≈2 Hz is plenty).
 * Returns the event when this tick caused a take-over or a return, so the
 * caller can raise a durable alarm and write the broadcast log.
 */
export function evaluateFailover(
  levelDb: number,
  powered: boolean,
  now = Date.now(),
): FailoverEvent | null {
  const cfg = state.config;
  ensureArmed();

  if (!powered) {
    if (state.deadMs !== 0 || state.healthyMs !== 0 || state.levelDb !== -120) {
      commit({ deadMs: 0, healthyMs: 0, levelDb: -120 });
    }
    return null;
  }

  if (levelDb !== state.levelDb) commit({ levelDb });
  recordLevel(levelDb, now, state.active);
  const engine = getEngine();
  const dead = Number.isFinite(levelDb) && levelDb < cfg.thresholdDb;

  // elapsed since the previous tick, floored at 0 and capped so a first tick
  // (or a background-tab stall) can never look like an hour of dead air
  const dt = Math.min(Math.max(0, now - (state.lastTickAt || now)), 5000);
  state.lastTickAt = now;

  if (!dead) {
    // programme present — reset the dead-air episode, track recovery time
    const healthyMs = state.healthyMs + dt;
    if (state.deadMs !== 0) commit({ deadMs: 0 });
    commit({ healthyMs });

    if (
      state.active &&
      state.trigger === "auto" &&
      cfg.enabled &&
      healthyMs >= cfg.returnMs
    ) {
      engine.setBackupActive(false, cfg.fadeMs);
      const at = now;
      commit({
        active: false,
        trigger: null,
        since: 0,
        healthyMs: 0,
        lastEvent: `Programme restored after ${Math.round(cfg.returnMs / 1000)} s — returned automatically`,
        lastEventAt: at,
      });
      return {
        type: "return",
        reason: `programme healthy for ${Math.round(cfg.returnMs / 1000)} s`,
        at,
        deadMs: 0,
      };
    }
    return null;
  }

  // dead air: accumulate the episode while keeping the operator's manual
  // take-over untouched
  const deadMs = state.deadMs + dt;
  commit({ deadMs, healthyMs: 0 });

  if (
    cfg.enabled &&
    !state.active &&
    engine.backupLoaded &&
    deadMs >= cfg.holdMs
  ) {
    engine.setBackupActive(true, cfg.fadeMs);
    const at = now;
    commit({
      active: true,
      trigger: "auto",
      since: at,
      takes: state.takes + 1,
      lastEvent: `Dead air ${Math.round(deadMs / 1000)} s — standby source on air`,
      lastEventAt: at,
    });
    return { type: "takeover", reason: "programme loss", at, deadMs };
  }

  return null;
}

/** Session reset — clears counters only; the standby file stays armed. */
export function resetFailoverCounters() {
  commit({ takes: 0, deadMs: 0, healthyMs: 0, lastEvent: null, lastEventAt: 0 });
}
