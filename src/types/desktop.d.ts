/**
 * The desktop shell's bridge, injected by electron/preload.cjs.
 *
 * Absent in the browser build, so every use is optional-chained: the console
 * must run identically with and without it.
 */

export interface UdpOpenArgs {
  id: "a" | "b";
  listenPort: number;
  listenHost?: string;
  host: string;
  port: number;
}

export interface UdpOpenResult {
  ok: boolean;
  /** Bound port, when the socket came up. */
  port?: number;
  error?: string;
}

export interface SignalpathUdp {
  available: boolean;
  open: (args: UdpOpenArgs) => Promise<UdpOpenResult>;
  send: (id: "a" | "b", bytes: Uint8Array) => void;
  close: (id: "a" | "b") => Promise<{ ok: boolean }>;
  /** Datagrams from either path; returns an unsubscribe function. */
  onData: (cb: (id: "a" | "b", bytes: Uint8Array) => void) => () => void;
}

export interface SignalpathAudioDevice {
  id: string;
  label: string;
}

export interface SignalpathAudioState {
  inputs: SignalpathAudioDevice[];
  outputs: SignalpathAudioDevice[];
  inputId: string;
  outputId: string;
  micStatus: string;
  micLabel: string;
  /** 0 = engine off; drives the Devices window status badge. */
  sampleRate: number;
  contextState: string;
}

export interface SignalpathAudioCommand {
  type: "input" | "output" | "refresh" | "arm" | "disarm";
  id?: string;
}

export interface SignalpathAudio {
  available: boolean;
  /** Console → shell: report current device state. */
  push: (state: SignalpathAudioState) => void;
  /** Devices window → shell: last reported state, if any. */
  get: () => Promise<SignalpathAudioState | null>;
  setInput: (id: string) => void;
  setOutput: (id: string) => void;
  refresh: () => void;
  arm: () => void;
  disarm: () => void;
  /** Devices window: follow state broadcasts. */
  onState: (cb: (s: SignalpathAudioState) => void) => () => void;
  /** Console: follow commands from the Devices window. */
  onCommand: (cb: (cmd: SignalpathAudioCommand) => void) => () => void;
}

export interface SignalpathBridge {
  platform?: string;
  udp?: SignalpathUdp;
  audio?: SignalpathAudio;
}

declare global {
  interface Window {
    signalpath?: SignalpathBridge;
  }
}

export {};
