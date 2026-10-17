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

export interface SignalpathBridge {
  platform?: string;
  udp?: SignalpathUdp;
}

declare global {
  interface Window {
    signalpath?: SignalpathBridge;
  }
}

export {};
