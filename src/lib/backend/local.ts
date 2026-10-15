/** Device-local backend — localStorage persistence for the standalone
 * desktop build, where there is no Convex deployment to talk to.
 *
 * Presets, the broadcast log and the mount configuration live under
 * `signalpath.*` keys; the session is always signed-in as the local
 * operator. The log mirrors the cloud rules: newest first, capped at
 * LOG_LIMIT entries, 180-day retention applied on write.
 */
import type {
  ConnectionState,
  LogPush,
  LogRecord,
  MountRecord,
  PresetRecord,
  Session,
} from "./types";

const PRESETS_KEY = "signalpath.presets.v1";
const LOG_KEY = "signalpath.log.v1";
const MOUNT_KEY = "signalpath.mount.v1";
const LOG_LIMIT = 200;
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
}

let state: LocalState = {
  presets: read<PresetRecord[]>(PRESETS_KEY, []),
  log: read<LogRecord[]>(LOG_KEY, []),
  mount: read<MountRecord | null>(MOUNT_KEY, null),
};

const listeners = new Set<() => void>();

function commit(next: Partial<LocalState>): void {
  state = { ...state, ...next };
  if (next.presets) write(PRESETS_KEY, next.presets);
  if (next.log) write(LOG_KEY, next.log);
  if (next.mount !== undefined) write(MOUNT_KEY, next.mount);
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
