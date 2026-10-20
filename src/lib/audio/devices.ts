/**
 * Physical audio device handling for the console.
 *
 * Two jobs, both kept out of the engine so they can be checked without an
 * AudioContext:
 *
 *  1  turn `enumerateDevices()` output into a clean, selectable list — no
 *     duplicate ids, no blank entries, honest fallback labels, and a flag
 *     that says whether the list is actually identifiable;
 *  2  remember the operator's picks, and decide when a saved pick is genuinely
 *     gone as opposed to merely hidden behind a permission prompt.
 *
 * The distinction matters: before the microphone permission is granted,
 * Chromium lists input devices with an empty `deviceId`. Treating those as
 * "the saved device is missing" would wipe the rig every boot, so a list with
 * no usable ids never invalidates a saved choice.
 */

/** One physical audio device, as listed by the OS. */
export interface AudioDevice {
  id: string;
  label: string;
  /** Endpoint group — equal group ids usually mean the same hardware. */
  groupId?: string;
}

/** Persisted I/O prefs: last input/output device + program source. */
export const DEVICE_STORE = "signalpath.devices.v1";

export type StoredSource = "signal" | "mic" | "file";

export interface DevicePrefs {
  input: string;
  output: string;
  source: StoredSource;
}

export const EMPTY_PREFS: DevicePrefs = { input: "", output: "", source: "signal" };

export interface DeviceListing {
  inputs: AudioDevice[];
  outputs: AudioDevice[];
  /** True when enumeration returned usable ids (permission granted). */
  inputsIdentified: boolean;
  outputsIdentified: boolean;
}

interface RawDevice {
  deviceId: string;
  kind: string;
  label: string;
  groupId?: string;
}

/**
 * Normalise enumeration output. Entries with no device id cannot be opened,
 * so they are dropped; the flag records that this happened, so callers can
 * tell "no hardware" from "not allowed to see it yet".
 */
export function listDevices(all: readonly RawDevice[]): DeviceListing {
  const pick = (kind: "audioinput" | "audiooutput", fallback: string) => {
    const seen = new Set<string>();
    const list: AudioDevice[] = [];
    let n = 0;
    for (const d of all) {
      if (d.kind !== kind) continue;
      if (!d.deviceId || seen.has(d.deviceId)) continue;
      seen.add(d.deviceId);
      n += 1;
      list.push({
        id: d.deviceId,
        label: (d.label || `${fallback} ${n}`).trim(),
        groupId: d.groupId || undefined,
      });
    }
    return list;
  };
  const inputs = pick("audioinput", "Input");
  const outputs = pick("audiooutput", "Output");
  return {
    inputs,
    outputs,
    inputsIdentified: inputs.length > 0,
    outputsIdentified: outputs.length > 0,
  };
}

/**
 * Keep a saved pick only when the list is trustworthy and the device is not
 * in it. Returns "" (OS default) when the device is genuinely gone.
 */
export function reconcileSelection(
  saved: string,
  devices: readonly AudioDevice[],
  identified: boolean,
): string {
  if (!saved) return "";
  if (!identified) return saved;
  return devices.some((d) => d.id === saved) ? saved : "";
}

/** Parse stored prefs defensively — a corrupt entry must not break boot. */
export function parsePrefs(raw: string | null): DevicePrefs {
  if (!raw) return { ...EMPTY_PREFS };
  try {
    const p = JSON.parse(raw) as Partial<DevicePrefs>;
    const source =
      p.source === "mic" || p.source === "file" || p.source === "signal"
        ? p.source
        : "signal";
    return {
      input: typeof p.input === "string" ? p.input : "",
      output: typeof p.output === "string" ? p.output : "",
      source,
    };
  } catch {
    return { ...EMPTY_PREFS };
  }
}

export function serializePrefs(prefs: DevicePrefs): string {
  return JSON.stringify(prefs);
}

/**
 * Virtual / loopback endpoints (VB-Audio Cable, BlackHole, Stereo Mix …).
 * Monitoring into one is legitimate for a stream feed but inaudible locally,
 * so the console says so instead of leaving the operator wondering.
 */
const VIRTUAL_RE =
  /(vb-audio|vb-cable|virtual|cable|loopback|blackhole|soundflower|stereo mix|monitor of|aggregate)/i;

export function isVirtualDevice(label: string): boolean {
  return VIRTUAL_RE.test(label);
}

/**
 * True when the program input and the monitor sink are the same endpoint —
 * the chain would feed its own output straight back into its input. The shell
 * reports a shared group id for two sides of one device, so this catches the
 * classic "CABLE output in, CABLE input out" loop.
 */
export function isFeedbackLoop(
  input: AudioDevice | undefined,
  output: AudioDevice | undefined,
): boolean {
  if (!input?.groupId || !output?.groupId) return false;
  if (input.id === output.id) return false;
  return input.groupId === output.groupId;
}
