/**
 * Station reporting agent — pushes this console's health to the cloud console.
 *
 * The standalone desktop build has no Convex client by design, so it reports
 * with its station token to the deployment's HTTP endpoint
 * (`POST /station-report`, see `src/convex/http.ts`). The web console reports
 * through its normal signed-in binding instead; this agent is what makes a
 * desk in another city appear in the Network tab.
 *
 * Sends are fire-and-forget and never block audio: a failed report only
 * updates the local status line, and alarms raised while offline stay queued
 * (bounded) so the operator's alarm history still sees them on reconnect.
 */
import { APP_VERSION } from "@/lib/version";

export interface ReportingConfig {
  enabled: boolean;
  /** Deployment site URL, e.g. https://gregarious-butterfly-636.convex.site */
  endpoint: string;
  /** Station token minted in the Network tab. */
  token: string;
  /** Heartbeat period (ms). */
  intervalMs: number;
}

export interface QueuedAlarm {
  kind: string;
  severity: "critical" | "warning" | "info";
  title: string;
  detail?: string;
  at: number;
}

export interface ReportingState {
  config: ReportingConfig;
  lastSentAt: number;
  lastResultAt: number;
  lastOk: boolean | null;
  lastError: string | null;
  sent: number;
  failed: number;
  pending: number;
}

const STORAGE_KEY = "signalpath.reporting.v1";
const QUEUE_LIMIT = 25;

export const DEFAULT_REPORTING: ReportingConfig = {
  enabled: false,
  endpoint: "",
  token: "",
  intervalMs: 15_000,
};

function loadConfig(): ReportingConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_REPORTING };
    const parsed = JSON.parse(raw) as Partial<ReportingConfig>;
    return {
      enabled: parsed.enabled ?? false,
      endpoint: typeof parsed.endpoint === "string" ? parsed.endpoint : "",
      token: typeof parsed.token === "string" ? parsed.token : "",
      intervalMs:
        typeof parsed.intervalMs === "number"
          ? Math.max(5000, Math.min(parsed.intervalMs, 300_000))
          : DEFAULT_REPORTING.intervalMs,
    };
  } catch {
    return { ...DEFAULT_REPORTING };
  }
}

export interface ReportPayload {
  onAir: boolean;
  presetName?: string;
  lufs?: number;
  truePeakDb?: number;
  modPct?: number;
  openAlarms?: number;
}

let state: ReportingState = {
  config: loadConfig(),
  lastSentAt: 0,
  lastResultAt: 0,
  lastOk: null,
  lastError: null,
  sent: 0,
  failed: 0,
  pending: 0,
};

let queue: QueuedAlarm[] = [];

const listeners = new Set<() => void>();

function emit() {
  for (const cb of listeners) cb();
}

function commit(patch: Partial<ReportingState>) {
  state = { ...state, ...patch, pending: queue.length };
  emit();
}

export const getReporting = (): ReportingState => state;

export function subscribeReporting(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function setReportingConfig(patch: Partial<ReportingConfig>) {
  state = { ...state, config: { ...state.config, ...patch } };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.config));
  } catch {
    /* storage unavailable — config stays session-only */
  }
  emit();
}

/** True when the agent can actually deliver (enabled + endpoint + token). */
export function reportingReady(): boolean {
  const { enabled, endpoint, token } = state.config;
  return enabled && /^https?:\/\//.test(endpoint) && token.length >= 16;
}

/** Queue an alarm for the next report (no-op while the agent is off). */
export function queueRemoteAlarm(alarm: QueuedAlarm) {
  if (!state.config.enabled) return;
  queue = [...queue, alarm].slice(-QUEUE_LIMIT);
  commit({});
}

/** Normalise a pasted deployment URL to the `/station-report` endpoint. */
export function reportEndpoint(endpoint: string): string {
  const base = endpoint.trim().replace(/\/+$/, "");
  if (!base) return "";
  return /\/station-report$/.test(base) ? base : `${base}/station-report`;
}

async function post(
  payload: ReportPayload,
  alarms: QueuedAlarm[],
): Promise<{ ok: boolean; error?: string }> {
  const url = reportEndpoint(state.config.endpoint);
  const body = JSON.stringify({
    token: state.config.token,
    version: APP_VERSION,
    ...payload,
    alarms,
  });
  try {
    const res = await fetch(url, {
      method: "POST",
      // text/plain keeps this a CORS "simple request": the desktop build runs
      // from the app:// scheme, where a preflight would be refused.
      headers: { "Content-Type": "text/plain" },
      body,
    });
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "network error" };
  }
}

/** Send one report now (used by the heartbeat and the "test" button). */
export async function sendStationReport(
  payload: ReportPayload,
): Promise<{ ok: boolean; error?: string }> {
  if (!reportingReady()) return { ok: false, error: "Reporting is not configured" };
  const alarms = queue;
  const result = await post(payload, alarms);
  if (result.ok) {
    if (alarms.length > 0) queue = queue.filter((a) => !alarms.includes(a));
    commit({
      lastSentAt: Date.now(),
      lastResultAt: Date.now(),
      lastOk: true,
      lastError: null,
      sent: state.sent + 1,
    });
  } else {
    commit({
      lastResultAt: Date.now(),
      lastOk: false,
      lastError: result.error ?? "failed",
      failed: state.failed + 1,
    });
  }
  return result;
}

/**
 * Heartbeat — call from the console tick. Sends at the configured interval and
 * only when the agent is configured; returns immediately otherwise.
 */
export function maybeReport(
  payload: ReportPayload,
  now = Date.now(),
  inflight = false,
): void {
  if (inflight || !reportingReady()) return;
  if (now - state.lastSentAt < state.config.intervalMs && state.sent > 0) return;
  if (now - state.lastResultAt < 2000) return;
  commit({ lastSentAt: now });
  void sendStationReport(payload);
}

/** Reset per-session counters (keeps the queued alarms). */
export function resetReportingCounters() {
  commit({ sent: 0, failed: 0, lastError: null, lastOk: null });
}
