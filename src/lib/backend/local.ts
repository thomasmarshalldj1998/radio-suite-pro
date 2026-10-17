/** Device-local backend — localStorage persistence for the standalone
 * desktop build, where there is no Convex deployment to talk to.
 *
 * Presets, the broadcast log and the mount configuration live under
 * `signalpath.*` keys; the session is always signed-in as the local
 * operator. The log mirrors the cloud rules: newest first, capped at
 * LOG_LIMIT entries, 180-day retention applied on write.
 */
import type {
  AlarmPush,
  AlarmRecord,
  ConnectionState,
  LogPush,
  LogRecord,
  MountRecord,
  PresetRecord,
  ScheduleInput,
  ScheduleRecord,
  Session,
  StationRecord,
  StationReport,
} from "./types";

const PRESETS_KEY = "signalpath.presets.v1";
const LOG_KEY = "signalpath.log.v1";
const MOUNT_KEY = "signalpath.mount.v1";
const ALARMS_KEY = "signalpath.alarms.v1";
const SCHEDULES_KEY = "signalpath.schedules.v1";
const STATIONS_KEY = "signalpath.stations.v1";
const LOG_LIMIT = 200;
const ALARM_LIMIT = 500;
const LOG_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;

/** Local ids mimic Convex doc ids so panels can key rows the same way. */
let idSeq = 0;
const newId = (table: string): string =>
  `local_${table}_${Date.now().toString(36)}_${(idSeq++).toString(36)}`;

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage may be full or unavailable — local mode stays in memory */
  }
}

/* ── tiny shared store: one snapshot object, subscribe/getSnapshot ── */

interface LocalState {
  presets: PresetRecord[];
  log: LogRecord[];
  mount: MountRecord | null;
  alarms: AlarmRecord[];
  schedules: ScheduleRecord[];
  stations: StationRecord[];
}

let state: LocalState = {
  presets: read<PresetRecord[]>(PRESETS_KEY, []),
  log: read<LogRecord[]>(LOG_KEY, []),
  mount: read<MountRecord | null>(MOUNT_KEY, null),
  alarms: read<AlarmRecord[]>(ALARMS_KEY, []),
  schedules: read<ScheduleRecord[]>(SCHEDULES_KEY, []),
  stations: read<StationRecord[]>(STATIONS_KEY, []),
};

const listeners = new Set<() => void>();

function commit(next: Partial<LocalState>): void {
  state = { ...state, ...next };
  if (next.presets) write(PRESETS_KEY, next.presets);
  if (next.log) write(LOG_KEY, next.log);
  if (next.mount !== undefined) write(MOUNT_KEY, next.mount);
  if (next.alarms) write(ALARMS_KEY, next.alarms);
  if (next.schedules) write(SCHEDULES_KEY, next.schedules);
  if (next.stations) write(STATIONS_KEY, next.stations);
  for (const cb of listeners) cb();
}

/** Subscribe to local-data changes (React `useSyncExternalStore` shape). */
export function subscribeLocal(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export const getLocalState = (): LocalState => state;

/* ── presets ── */

export const listLocalPresets = (): PresetRecord[] => state.presets;

export function saveLocalPreset(args: {
  name: string;
  description?: string;
  params: unknown;
}): string {
  const name = args.name.trim().slice(0, 80);
  if (!name) throw new Error("Preset name is required");
  const existing = state.presets.find(
    (p) => p.name.toLowerCase() === name.toLowerCase(),
  );
  if (existing) {
    commit({
      presets: state.presets.map((p) =>
        p._id === existing._id
          ? {
              ...p,
              name,
              description: args.description?.trim().slice(0, 280) || undefined,
              params: args.params,
            }
          : p,
      ),
    });
    return existing._id;
  }
  const id = newId("presets");
  commit({
    presets: [
      {
        _id: id,
        name,
        description: args.description?.trim().slice(0, 280) || undefined,
        params: args.params,
        _creationTime: Date.now(),
      },
      ...state.presets,
    ],
  });
  return id;
}

export function removeLocalPreset(id: string): void {
  commit({ presets: state.presets.filter((p) => p._id !== id) });
}

/* ── broadcast log ── */

export function pushLocalLog(args: LogPush): string {
  const now = Date.now();
  const cutoff = now - LOG_RETENTION_MS;
  const next = [
    {
      _id: newId("broadcastLog"),
      kind: args.kind,
      title: args.title,
      detail: args.detail,
      at: now,
    },
    ...state.log.filter((e) => e.at >= cutoff),
  ].slice(0, LOG_LIMIT);
  commit({ log: next });
  return next[0]._id;
}

export const listLocalLog = (limit = 50): LogRecord[] =>
  state.log.slice(0, Math.min(Math.max(limit, 1), LOG_LIMIT));

/* ── mount configuration ── */

export const getLocalMount = (): MountRecord | null => state.mount;

export function saveLocalMount(args: MountRecord): void {
  commit({ mount: { ...args, updatedAt: Date.now() } });
}

export function setLocalNowPlaying(title: string, artist?: string): void {
  const now = Date.now();
  commit({
    mount: state.mount
      ? { ...state.mount, nowPlayingTitle: title, nowPlayingArtist: artist || undefined, updatedAt: now }
      : state.mount,
  });
  pushLocalLog({
    kind: "metadata",
    title: artist ? `${artist} — ${title}` : title,
    detail: "Now-playing metadata sent to listeners",
  });
}

/* ── session & connection ── */

/** The standalone build has no accounts: the device itself is the operator. */
export const LOCAL_SESSION: Session = {
  isLoading: false,
  isAuthenticated: true,
  user: { name: "Local operator" },
  signIn: async () => {
    /* no-op — no identity provider in local mode */
  },
  signOut: async () => {
    /* no-op — there is nothing to sign out of */
  },
};

export const LOCAL_CONNECTION: ConnectionState = "local";

/* ── durable alarms ─────────────────────────────────────────────────────── */

const ALARM_COLLAPSE_MS = 60_000;

/**
 * Record an alarm, collapsing a repeat of the same kind+title that is still
 * open within the last minute — the same rule the cloud binding applies, so
 * a runaway condition cannot bury the history in duplicates either way.
 */
export function pushLocalAlarm(args: AlarmPush): string {
  const at = args.at ?? Date.now();
  const cutoff = Date.now() - LOG_RETENTION_MS;
  const twin = state.alarms.find(
    (a) =>
      a.kind === args.kind &&
      a.title === args.title &&
      a.ackAt === undefined &&
      at - a.at < ALARM_COLLAPSE_MS,
  );
  if (twin) {
    commit({
      alarms: state.alarms.map((a) =>
        a._id === twin._id ? { ...a, at, detail: args.detail } : a,
      ),
    });
    return twin._id;
  }
  const id = newId("alarms");
  commit({
    alarms: [
      {
        _id: id,
        kind: args.kind,
        severity: args.severity,
        title: args.title,
        detail: args.detail,
        at,
        source: args.source ?? "console",
      },
      ...state.alarms.filter((a) => a.at >= cutoff),
    ].slice(0, ALARM_LIMIT),
  });
  return id;
}

export const listLocalAlarms = (limit = 100): AlarmRecord[] =>
  state.alarms.slice(0, Math.min(Math.max(limit, 1), ALARM_LIMIT));

export function ackLocalAlarm(id: string): void {
  const at = Date.now();
  commit({
    alarms: state.alarms.map((a) => (a._id === id ? { ...a, ackAt: at } : a)),
  });
}

export function ackAllLocalAlarms(): number {
  const at = Date.now();
  let n = 0;
  const alarms = state.alarms.map((a) => {
    if (a.ackAt !== undefined) return a;
    n += 1;
    return { ...a, ackAt: at };
  });
  if (n > 0) commit({ alarms });
  return n;
}

export function clearLocalAlarms(): number {
  const n = state.alarms.length;
  if (n > 0) commit({ alarms: [] });
  return n;
}

/* ── dayparting schedules ───────────────────────────────────────────────── */

export const listLocalSchedules = (): ScheduleRecord[] =>
  [...state.schedules].sort(
    (a, b) => a.startMin - b.startMin || a.name.localeCompare(b.name),
  );

export function saveLocalSchedule(args: ScheduleInput): string {
  const name = args.name.trim().slice(0, 80);
  const presetName = args.presetName.trim().slice(0, 80);
  if (!name) throw new Error("Schedule name is required");
  if (!presetName) throw new Error("Pick a preset for the slot");
  if (args.days.length === 0) throw new Error("Pick at least one day");
  const days = Array.from(
    new Set(args.days.map((d) => Math.min(Math.max(Math.round(d), 0), 6))),
  ).sort();
  const startMin = Math.min(Math.max(Math.round(args.startMin), 0), 1439);
  const endMin = Math.min(Math.max(Math.round(args.endMin), 0), 1439);
  const existing = args.id
    ? state.schedules.find((s) => s._id === args.id)
    : undefined;
  const id = existing?._id ?? newId("schedules");
  const row: ScheduleRecord = {
    _id: id,
    name,
    days,
    startMin,
    endMin,
    presetName,
    params: args.params,
    enabled: args.enabled,
    updatedAt: Date.now(),
  };
  commit({
    schedules: existing
      ? state.schedules.map((s) => (s._id === id ? row : s))
      : [row, ...state.schedules],
  });
  return id;
}

export function removeLocalSchedule(id: string): void {
  commit({ schedules: state.schedules.filter((s) => s._id !== id) });
}

export function setLocalScheduleEnabled(id: string, enabled: boolean): void {
  commit({
    schedules: state.schedules.map((s) =>
      s._id === id ? { ...s, enabled, updatedAt: Date.now() } : s,
    ),
  });
}

/* ── multi-station registry ─────────────────────────────────────────────── */

export const listLocalStations = (): StationRecord[] =>
  [...state.stations].sort((a, b) => b.lastSeenAt - a.lastSeenAt);

export function registerLocalStation(args: {
  name: string;
  token: string;
  note?: string;
}): string {
  const name = args.name.trim().slice(0, 80);
  const token = args.token.trim();
  if (!name) throw new Error("Station name is required");
  if (token.length < 16) throw new Error("Reporting token is too short");
  const existing = state.stations.find((s) => s.token === token);
  const id = existing?._id ?? newId("stations");
  const row: StationRecord = {
    _id: id,
    stationId: existing?.stationId ?? `st_${token.slice(0, 8)}`,
    name,
    token,
    note: args.note,
    lastSeenAt: existing?.lastSeenAt ?? 0,
    onAir: existing?.onAir ?? false,
  };
  commit({
    stations: existing
      ? state.stations.map((s) => (s._id === id ? { ...s, ...row } : s))
      : [row, ...state.stations],
  });
  return id;
}

export function removeLocalStation(id: string): void {
  commit({ stations: state.stations.filter((s) => s._id !== id) });
}

/** Heartbeat for a console running the device-local binding. */
export function reportLocalStation(args: StationReport): void {
  const row = state.stations.find((s) => s.stationId === args.stationId) ?? state.stations[0];
  if (!row) return;
  commit({
    stations: state.stations.map((s) =>
      s._id === row._id
        ? { ...s, ...args, stationId: row.stationId, lastSeenAt: Date.now() }
        : s,
    ),
  });
}
