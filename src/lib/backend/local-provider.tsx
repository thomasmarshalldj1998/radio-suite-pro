/** Local binding — the same `Backend` shape backed by device storage. Used
 * by the standalone desktop package (and by web builds with no Convex
 * deployment configured). Nothing here touches the network.
 */
import { useMemo, type ReactNode } from "react";
import { useSyncExternalStore } from "react";
import {
  ackAllLocalAlarms,
  ackLocalAlarm,
  clearLocalAlarms,
  getLocalState,
  LOCAL_CONNECTION,
  LOCAL_SESSION,
  pushLocalAlarm,
  pushLocalLog,
  registerLocalStation,
  removeLocalPreset,
  removeLocalSchedule,
  removeLocalStation,
  reportLocalStation,
  saveLocalMount,
  saveLocalPreset,
  saveLocalSchedule,
  setLocalNowPlaying,
  setLocalScheduleEnabled,
  subscribeLocal,
} from "./local";
import type { Backend } from "./context";
import { BackendContext } from "./context";
import type { LogPush, MountRecord } from "./types";

export function LocalBackendProvider({ children }: { children: ReactNode }) {
  const state = useSyncExternalStore(subscribeLocal, getLocalState);

  const value = useMemo<Backend>(
    () => ({
      presets: state.presets,
      savePreset: async (args) => saveLocalPreset(args),
      removePreset: async (id) => removeLocalPreset(id),

      log: state.log,
      pushLog: async (args: LogPush) => pushLocalLog(args),

      mount: state.mount,
      saveMount: async (args: MountRecord) => saveLocalMount(args),
      setNowPlaying: async (title, artist) => setLocalNowPlaying(title, artist),

      alarms: state.alarms,
      pushAlarm: async (args) => pushLocalAlarm(args),
      ackAlarm: async (id) => ackLocalAlarm(id),
      ackAllAlarms: async () => ackAllLocalAlarms(),
      clearAlarms: async () => clearLocalAlarms(),

      schedules: state.schedules,
      saveSchedule: async (args) => saveLocalSchedule(args),
      removeSchedule: async (id) => removeLocalSchedule(id),
      setScheduleEnabled: async (id, enabled) =>
        setLocalScheduleEnabled(id, enabled),

      stations: state.stations,
      registerStation: async (args) => registerLocalStation(args),
      removeStation: async (id) => removeLocalStation(id),
      reportStation: async (args) => reportLocalStation(args),

      session: LOCAL_SESSION,
      connection: LOCAL_CONNECTION,
    }),
    [state],
  );

  return (
    <BackendContext.Provider value={value}>{children}</BackendContext.Provider>
  );
}
