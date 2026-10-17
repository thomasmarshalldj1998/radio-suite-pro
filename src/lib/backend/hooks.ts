/** Consumer hooks for the pluggable backend. Panels import these instead of
 * `convex/react` directly, so the same components run against the cloud
 * binding (web + deployment) or the device-local binding (desktop package).
 */
import { use } from "react";
import { BackendContext } from "./context";
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

function useBackend() {
  const backend = use(BackendContext);
  if (!backend) {
    throw new Error(
      "Backend provider missing — mount BackendProvider in the app root",
    );
  }
  return backend;
}

/** Saved preset library (`undefined` while cloud mode is loading). */
export function usePresets(): PresetRecord[] | undefined {
  return useBackend().presets;
}

export function useSavePreset(): BackendSave["savePreset"] {
  return useBackend().savePreset;
}

export function useRemovePreset(): BackendSave["removePreset"] {
  return useBackend().removePreset;
}

type BackendSave = ReturnType<typeof useBackend>;

/** Broadcast log, newest first. */
export function useStationLog(): LogRecord[] | undefined {
  return useBackend().log;
}

export function usePushLog(): (args: LogPush) => Promise<unknown> {
  return useBackend().pushLog;
}

/** Saved stream mount configuration. */
export function useMount(): MountRecord | null | undefined {
  return useBackend().mount;
}

export function useSaveMount(): (args: MountRecord) => Promise<unknown> {
  return useBackend().saveMount;
}

export function useSetNowPlaying(): (
  title: string,
  artist?: string,
) => Promise<void> {
  return useBackend().setNowPlaying;
}

/** Operator session (always signed-in under the local binding). */
export function useSession(): Session {
  return useBackend().session;
}

/** Backend connectivity — `"local"` when persisting on-device. */
export function useConnectionState(): ConnectionState {
  return useBackend().connection;
}

/* ── durable alarms ── */

/** Alarm history, newest first (`undefined` while cloud mode is loading). */
export function useAlarms(): AlarmRecord[] | undefined {
  return useBackend().alarms;
}

export function usePushAlarm(): (args: AlarmPush) => Promise<unknown> {
  return useBackend().pushAlarm;
}

export function useAckAlarm(): (id: string) => Promise<void> {
  return useBackend().ackAlarm;
}

export function useAckAllAlarms(): () => Promise<unknown> {
  return useBackend().ackAllAlarms;
}

export function useClearAlarms(): () => Promise<unknown> {
  return useBackend().clearAlarms;
}

/* ── dayparting schedules ── */

export function useSchedules(): ScheduleRecord[] | undefined {
  return useBackend().schedules;
}

export function useSaveSchedule(): (args: ScheduleInput) => Promise<unknown> {
  return useBackend().saveSchedule;
}

export function useRemoveSchedule(): (id: string) => Promise<void> {
  return useBackend().removeSchedule;
}

export function useSetScheduleEnabled(): (
  id: string,
  enabled: boolean,
) => Promise<void> {
  return useBackend().setScheduleEnabled;
}

/* ── multi-station console ── */

export function useStations(): StationRecord[] | undefined {
  return useBackend().stations;
}

export function useRegisterStation(): (args: {
  name: string;
  token: string;
  note?: string;
}) => Promise<unknown> {
  return useBackend().registerStation;
}

export function useRemoveStation(): (id: string) => Promise<void> {
  return useBackend().removeStation;
}

export function useReportStation(): (args: StationReport) => Promise<unknown> {
  return useBackend().reportStation;
}
