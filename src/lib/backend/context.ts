/**
 * One backend for the console, two bindings.
 *
 * - Cloud binding (web build with a Convex deployment): presets, log, mount
 *   and session sync through Convex with accounts.
 * - Local binding (standalone desktop package, or web without a deployment):
 *   the same four records persist in device storage; the operator is always
 *   signed in and nothing leaves the machine.
 *
 * The choice is made at build time so no component ever branches on hooks.
 */
import { createContext } from "react";
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

/** The desktop package is standalone by design — no cloud binding. */
export const IS_DESKTOP = import.meta.env.VITE_APP_MODE === "desktop";

/** Cloud binding is active only on the web build with a deployment URL. */
export const CLOUD_ENABLED = Boolean(import.meta.env.VITE_CONVEX_URL) && !IS_DESKTOP;

export interface Backend {
  /** Saved presets; `undefined` while the cloud binding is still loading. */
  presets: PresetRecord[] | undefined;
  savePreset: (args: {
    name: string;
    description?: string;
    params: unknown;
  }) => Promise<unknown>;
  removePreset: (id: string) => Promise<void>;

  /** Broadcast log, newest first; `undefined` while loading in cloud mode. */
  log: LogRecord[] | undefined;
  pushLog: (args: LogPush) => Promise<unknown>;

  /** Durable alarm history, newest first; `undefined` while cloud-loading. */
  alarms: AlarmRecord[] | undefined;
  pushAlarm: (args: AlarmPush) => Promise<unknown>;
  ackAlarm: (id: string) => Promise<void>;
  ackAllAlarms: () => Promise<unknown>;
  clearAlarms: () => Promise<unknown>;

  /** Dayparting schedule; `undefined` while loading in cloud mode. */
  schedules: ScheduleRecord[] | undefined;
  saveSchedule: (args: ScheduleInput) => Promise<unknown>;
  removeSchedule: (id: string) => Promise<void>;
  setScheduleEnabled: (id: string, enabled: boolean) => Promise<void>;

  /** Stations reporting into the remote console; `undefined` while loading. */
  stations: StationRecord[] | undefined;
  registerStation: (args: {
    name: string;
    token: string;
    note?: string;
  }) => Promise<unknown>;
  removeStation: (id: string) => Promise<void>;
  reportStation: (args: StationReport) => Promise<unknown>;

  /** Saved mount configuration; `undefined` while loading in cloud mode. */
  mount: MountRecord | null | undefined;
  saveMount: (args: MountRecord) => Promise<unknown>;
  setNowPlaying: (title: string, artist?: string) => Promise<void>;

  session: Session;
  connection: ConnectionState;
}

export const BackendContext = createContext<Backend | null>(null);
