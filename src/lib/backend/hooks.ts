/** Consumer hooks for the pluggable backend. Panels import these instead of
 * `convex/react` directly, so the same components run against the cloud
 * binding (web + deployment) or the device-local binding (desktop package).
 */
import { use } from "react";
import { BackendContext } from "./context";
import type {
  ConnectionState,
  LogPush,
  LogRecord,
  MountRecord,
  PresetRecord,
  Session,
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
