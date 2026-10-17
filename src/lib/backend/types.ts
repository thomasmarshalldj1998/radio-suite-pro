/** Shared record shapes for the pluggable backend (cloud or local).
 *
 * The console only needs four things persisted — the preset library, the
 * broadcast log, the stream mount configuration and the operator session.
 * `src/lib/backend/index.ts` binds these to the Convex deployment when one is
 * configured (web build) or to device-local storage (standalone desktop
 * build), so every panel talks to one interface either way.
 */
import type { MountForm } from "@/lib/audio/outputs";

export type LogKind =
  | "session"
  | "metadata"
  | "config"
  | "preset"
  | "error"
  | "warn";

export interface PresetRecord {
  _id: string;
  name: string;
  description?: string;
  params: unknown;
  _creationTime: number;
}

export interface LogRecord {
  _id: string;
  kind: LogKind;
  title: string;
  detail?: string;
  at: number;
}

/** The saved stream configuration plus the last metadata sent to listeners. */
export interface MountRecord extends MountForm {
  nowPlayingTitle?: string;
  nowPlayingArtist?: string;
  updatedAt?: number;
}

export interface LogPush {
  kind: LogKind;
  title: string;
  detail?: string;
  meta?: unknown;
}

/** Alarm severity — drives colour and whether the event demands attention. */
export type AlarmSeverity = "critical" | "warning" | "info";

/** One durable alarm row (console watchdog or a remotely reported station). */
export interface AlarmRecord {
  _id: string;
  kind: string;
  severity: AlarmSeverity;
  title: string;
  detail?: string;
  at: number;
  ackAt?: number;
  source?: string;
}

export interface AlarmPush {
  kind: string;
  severity: AlarmSeverity;
  title: string;
  detail?: string;
  at?: number;
  source?: string;
}

/** Dayparting slot: a preset snapshot active on given days between two times. */
export interface ScheduleRecord {
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

export interface ScheduleInput {
  id?: string;
  name: string;
  days: number[];
  startMin: number;
  endMin: number;
  presetName: string;
  params: unknown;
  enabled: boolean;
}

/** A station reporting into the remote console. */
export interface StationRecord {
  _id: string;
  stationId: string;
  name: string;
  token: string;
  lastSeenAt: number;
  onAir: boolean;
  presetName?: string;
  lufs?: number;
  truePeakDb?: number;
  modPct?: number;
  openAlarms?: number;
  version?: string;
  note?: string;
}

export interface StationReport {
  stationId: string;
  onAir: boolean;
  presetName?: string;
  lufs?: number;
  truePeakDb?: number;
  modPct?: number;
  openAlarms?: number;
  version?: string;
}

/** What `useAuth()` hands every consumer, regardless of backend. */
export interface Session {
  isLoading: boolean;
  isAuthenticated: boolean;
  user: { name?: string } | null;
  signIn: (flow: string, formData?: FormData) => Promise<unknown>;
  signOut: () => Promise<unknown>;
}

export type ConnectionState =
  | "connected"
  | "connecting"
  | "disconnected"
  | "local";
