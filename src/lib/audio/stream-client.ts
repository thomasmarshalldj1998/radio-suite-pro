/**
 * Source-side stream client.
 *
 * The console encodes the program bus to a container; this module is the
 * other half — it hands those bytes to an Icecast/SHOUTcast source socket and
 * keeps that socket alive.
 *
 * Two transports:
 *  - desktop: `window.signalpath.stream`, a Node `http` request in the
 *    Electron main process. This is the only transport that can authenticate:
 *    a browser PUT with an `Authorization` header triggers a CORS preflight
 *    that Icecast does not answer, so the request is rejected before it is
 *    sent.
 *  - browser: `fetch` with a streaming body (Chromium). Works against a
 *    server that answers the preflight; reported as such in the UI.
 *
 * Retries use a 1→2→4→8→15→30 s ladder with ±15 % jitter because a live source should
 * reconnect itself while the operator is looking at something else. Audio
 * produced while offline is dropped, never queued: a stream that catches up
 * is worse than a stream with a gap.
 *
 * A configured backup mount turns repeated failures into a mount switch
 * (see mount-failover.ts): the primary is tried first, the backup takes over
 * after two dead attempts, and a healthy backup hands the primary another
 * chance on a later reconnect.
 */
import { DualMountFailover } from "./mount-failover";
import { TxBuffer, type TxSettings } from "./stream-tx";

export type StreamStatus = "idle" | "connecting" | "live" | "retrying" | "offline";

export type StreamTransport = "desktop" | "browser" | "none";

export interface StreamClientState {
  status: StreamStatus;
  transport: StreamTransport;
  /** Bytes of encoded audio handed to the transport this session. */
  sentBytes: number;
  /** Bytes produced while no connection was live (dropped by design). */
  droppedBytes: number;
  /** Audio currently held in the TX send buffer, ms. */
  bufferedMs: number;
  /** True while the pre-buffer is still filling — no bytes sent yet. */
  prebuffering: boolean;
  /** Bytes discarded by the TX protective limit (queue over ceiling). */
  protectedBytes: number;
  /** Protective limits engaged — the socket is up but audio was dropped. */
  warning: boolean;
  /** Failed connection attempts since the last live connection. */
  attempt: number;
  /** Countdown to the next reconnect, in ms; null when not retrying. */
  nextRetryMs: number | null;
  error: string | null;
  /** Epoch ms the current live connection started (0 when not live). */
  since: number;
  /** Mount the current (or next) source session is using. */
  mount: string;
  /** Primary mount as configured. */
  primaryMount: string;
  /** Backup mount, null when the station runs a single mount. */
  backupMount: string | null;
  /** True while the backup mount has taken over from the primary. */
  mountSwitched: boolean;
  /** Automatic mount transitions this session. */
  mountSwitches: number;
}

export const IDLE_TX: StreamClientState = {
  status: "idle",
  transport: "none",
  sentBytes: 0,
  droppedBytes: 0,
  bufferedMs: 0,
  prebuffering: false,
  protectedBytes: 0,
  warning: false,
  attempt: 0,
  nextRetryMs: null,
  error: null,
  since: 0,
  mount: "",
  primaryMount: "",
  backupMount: null,
  mountSwitched: false,
  mountSwitches: 0,
};

export interface SourceConfig {
  protocol: string;
  server: string;
  port: number;
  mount: string;
  /** Optional second mount on the same server used when the primary fails. */
  backupMount?: string;
  username: string;
  password: string;
  /** Container MIME type of the encoded chunks. */
  contentType: string;
  /** ICY metadata interval in bytes (0 disables in-stream metadata). */
  metaint: number;
  name: string;
  bitrateKbps: number;
  secure?: boolean;
}

export const STREAM_METAINT = 16_000;

/** Containers Icecast can take as a source. */
const SOURCE_TYPES = new Set([
  "audio/mpeg",
  "audio/aac",
  "audio/aacp",
  "audio/ogg",
  "audio/flac",
  "audio/opus",
]);

/**
 * Whether an encoded container can be pushed to a source socket. MP4/M4A and
 * WebM fragments are recordable but are not Icecast source streams, so those
 * profiles stay local (take library) or go out through a relay.
 */
export function isStreamableContainer(mime: string): boolean {
  return SOURCE_TYPES.has(mime.split(";")[0].trim().toLowerCase());
}

/** `Artist - Title` for the ICY `StreamTitle` field, trimmed to 250 chars. */
export function streamTitle(artist: string, title: string): string {
  const a = artist.trim();
  const t = title.trim();
  const line = a && t ? `${a} - ${t}` : t || a;
  return line.slice(0, 250);
}

/** Reconnect ladder: 1 s, 2 s, 4 s, 8 s, 15 s, then 30 s. */
export const RETRY_STEPS_MS = [1000, 2000, 4000, 8000, 15_000, 30_000] as const;

/** App-level keep-alive: re-announce metadata while live, every 30 s. */
export const KEEPALIVE_MS = 30_000;

/** Deterministic step for a given attempt (1-based). */
export function retryDelayBaseMs(attempt: number): number {
  const index = Math.max(0, Math.min(RETRY_STEPS_MS.length - 1, Math.floor(attempt) - 1));
  return RETRY_STEPS_MS[index];
}

/**
 * Reconnect delay with ±15 % jitter so a server restart does not make every
 * source reconnect in lockstep. `rand` is injectable for tests.
 */
export function retryDelayMs(attempt: number, rand: number = Math.random()): number {
  const base = retryDelayBaseMs(attempt);
  const jitter = Math.max(-1, Math.min(1, rand * 2 - 1)) * 0.15;
  return Math.round(Math.min(30_000, Math.max(500, base * (1 + jitter))));
}

export function streamTransport(): StreamTransport {
  if (typeof window !== "undefined" && window.signalpath?.stream?.available) {
    return "desktop";
  }
  if (typeof ReadableStream !== "undefined" && typeof fetch === "function") {
    return "browser";
  }
  return "none";
}

type Writer = {
  write: (bytes: Uint8Array) => void;
  close: () => Promise<void>;
};

/**
 * Desktop transport: one Node request in the shell, fed over IPC.
 *
 * The writer is handed back immediately and the server's verdict separately.
 * That is what lets frames flow during the handshake: a server that answers
 * only after it has heard the source would otherwise deadlock — the console
 * waits for a 200 that can never arrive, and every attempt ends in a retry
 * loop the panel used to label "Underflow".
 */
async function openDesktop(
  cfg: SourceConfig,
): Promise<{ writer: Writer; accepted: Promise<void> }> {
  const bridge = window.signalpath?.stream;
  if (!bridge) throw new Error("Desktop stream bridge unavailable");
  // `open` creates the request synchronously in the shell, so any write
  // issued after this call has a socket behind it.
  const opening = bridge.open({
    protocol: cfg.protocol,
    server: cfg.server,
    port: cfg.port,
    mount: cfg.mount,
    username: cfg.username,
    password: cfg.password,
    contentType: cfg.contentType,
    metaint: cfg.metaint,
    name: cfg.name,
    bitrateKbps: cfg.bitrateKbps,
    secure: cfg.secure,
  });
  const writer: Writer = {
    write: (bytes) => bridge.write(bytes),
    close: async () => {
      await bridge.close();
    },
  };
  const accepted = opening.then((res) => {
    if (!res.ok) throw new Error(res.error || "the source connection was refused");
  });
  return { writer, accepted };
}

/**
 * Preflight a mount before the encoder is started.
 *
 * Only the desktop shell can do this: a browser PUT cannot pass the CORS
 * preflight an Icecast source requires, so the browser build reports that
 * honestly instead of pretending the mount was checked. A successful probe
 * briefly holds the mount (the shell closes it immediately), which is why the
 * UI only offers it while off air.
 */
export interface SourceProbeResult {
  ok: boolean;
  status: number;
  detail: string;
}

export async function probeSource(cfg: SourceConfig): Promise<SourceProbeResult> {
  const bridge = typeof window !== "undefined" ? window.signalpath?.stream : undefined;
  if (!bridge?.probe) {
    return {
      ok: false,
      status: 0,
      detail:
        "A preflight needs the desktop app — a browser source PUT is blocked by the server's CORS policy. Start the source to test the mount from a browser.",
    };
  }
  const res = await bridge.probe({
    protocol: cfg.protocol,
    server: cfg.server,
    port: cfg.port,
    mount: cfg.mount,
    username: cfg.username,
    password: cfg.password,
    contentType: cfg.contentType,
    metaint: 0,
    name: cfg.name,
    bitrateKbps: cfg.bitrateKbps,
    secure: cfg.secure,
  });
  return {
    ok: res.ok,
    status: res.status,
    detail: res.ok
      ? `The mount accepted the source and its credentials (${cfg.server}:${cfg.port}/${cfg.mount.replace(/^\/+/, "")}).`
      : (res.error ?? "the mount refused the source"),
  };
}

/** Browser transport: streaming `fetch` body. CORS permitting. */
async function openBrowser(
  cfg: SourceConfig,
  onFailure: (message: string) => void,
): Promise<Writer> {
  const scheme = cfg.secure ? "https" : "http";
  const path = `/${cfg.mount.replace(/^\/+/, "")}`;
  const url = `${scheme}://${cfg.server}:${cfg.port}${path}`;
  const controller = new AbortController();
  let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      streamController = c;
    },
  });
  const auth = btoa(`${cfg.username}:${cfg.password}`);
  const headers: Record<string, string> = {
    Authorization: `Basic ${auth}`,
    "Content-Type": cfg.contentType,
    "Ice-Name": cfg.name,
    "Ice-Public": "0",
    "User-Agent": "Signalpath/2.0",
  };
  if (cfg.metaint > 0) headers["icy-metaint"] = String(cfg.metaint);

  // The request resolves when the server answers with headers; a later drop
  // rejects the body stream, so both paths report through onFailure.
  void fetch(url, {
    method: "PUT",
    headers,
    body,
    signal: controller.signal,
    // Chromium streams a request body only in half-duplex mode.
    duplex: "half",
  } as RequestInit & { duplex: "half" })
    .then(async (res) => {
      if (res.ok) return;
      const detail = await res.text().catch(() => "");
      onFailure(
        `${res.status} ${res.statusText}${detail ? ` — ${detail.slice(0, 160)}` : ""}`.trim(),
      );
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      onFailure(message || "the source connection failed");
    });

  return {
    write: (bytes) => {
      try {
        streamController?.enqueue(bytes);
      } catch {
        /* stream already closed */
      }
    },
    close: async () => {
      try {
        streamController?.close();
      } catch {
        /* already closed */
      }
      controller.abort();
      // Aborting resolves/rejects the pending fetch; nothing to await, the
      // failure handler simply sees a stopped client and stays quiet.
    },
  };
}

export class StreamClient {
  onState: ((state: StreamClientState) => void) | null = null;

  private cfg: SourceConfig | null = null;
  private writer: Writer | null = null;
  private stopped = true;
  private unsubBridge: (() => void) | null = null;
  private retryTimer: number | null = null;
  private countdownTimer: number | null = null;
  private keepAliveTimer: number | null = null;
  /** Dual-mount policy for this session (null before start). */
  private router: DualMountFailover | null = null;
  /** Identifies the current open attempt, so stale failures are ignored. */
  private attemptId = 0;
  /** Latest ICY title; replayed to a fresh source session after a drop. */
  private metadata = "";
  private retryAt = 0;
  /** Send buffer: pre-buffer, pacing and the protective ceiling. */
  private tx = new TxBuffer();
  private state: StreamClientState = {
    status: "idle",
    transport: "none",
    sentBytes: 0,
    droppedBytes: 0,
    bufferedMs: 0,
    prebuffering: false,
    protectedBytes: 0,
    warning: false,
    attempt: 0,
    nextRetryMs: null,
    error: null,
    since: 0,
    mount: "",
    primaryMount: "",
    backupMount: null,
    mountSwitched: false,
    mountSwitches: 0,
  };

  getState(): StreamClientState {
    return this.state;
  }

  /** TX buffer defaults: 500 ms in hand, 400 ms pre-buffer, limits on. */
  configureTx(patch: Partial<TxSettings>): void {
    this.tx.configure(patch);
  }

  getTxSettings(): TxSettings {
    return { ...this.tx.settings };
  }

  getTxSnapshot() {
    return this.tx.snapshot();
  }

  private update(patch: Partial<StreamClientState>) {
    this.state = { ...this.state, ...patch };
    this.onState?.(this.state);
  }

  async start(cfg: SourceConfig): Promise<void> {
    await this.stop(true);
    this.cfg = cfg;
    this.stopped = false;
    // A new session starts with an empty queue; the configured pre-buffer
    // (400 ms by default) holds the first frames so the server is not fed a
    // burst. Settings survive start() — only the queue is cleared.
    this.tx.reset();
    const router = new DualMountFailover(cfg.mount, cfg.backupMount);
    this.router = router;
    this.update({
      status: "connecting",
      transport: streamTransport(),
      error: null,
      attempt: 0,
      since: 0,
      bufferedMs: 0,
      prebuffering: this.tx.settings.prebufferMs > 0,
      protectedBytes: 0,
      warning: false,
      mount: router.active,
      primaryMount: router.primary,
      backupMount: router.backup,
      mountSwitched: false,
      mountSwitches: 0,
    });
    await this.open();
  }

  private async open(): Promise<void> {
    const cfg = this.cfg;
    if (!cfg || this.stopped) return;
    this.clearTimers();
    const transport = streamTransport();
    const attemptId = ++this.attemptId;
    // The router decides which mount this attempt uses; everything below
    // talks to that mount only.
    const mount = this.router?.choose() ?? cfg.mount;
    const target = mount === cfg.mount ? cfg : { ...cfg, mount };
    this.update({
      status: "connecting",
      transport,
      nextRetryMs: null,
      mount,
      mountSwitched: this.router?.switched ?? false,
      mountSwitches: this.router?.state.switches ?? 0,
    });
    try {
      let writer: Writer;
      let accepted: Promise<void> | null = null;
      if (transport === "desktop") {
        const opened = await openDesktop(target);
        writer = opened.writer;
        accepted = opened.accepted;
      } else if (transport === "browser") {
        writer = await openBrowser(target, (message) => {
          void this.fail(message, attemptId);
        });
      } else {
        throw new Error(
          "This build cannot open a source connection — use the desktop app or a relay.",
        );
      }
      if (this.stopped) {
        await writer.close();
        return;
      }
      this.writer = writer;
      this.attachBridge();
      // Attach first, verdict second: `push` feeds the socket while the
      // handshake is outstanding, which is the whole point of the split.
      if (accepted) {
        await accepted;
        if (this.stopped || this.attemptId !== attemptId) return;
      }
      // A reconnect opens a new source session on the server, so the current
      // title has to be announced again or listeners see an empty field.
      if (this.metadata) window.signalpath?.stream?.metadata(this.metadata);
      this.router?.recordLive(Date.now(), mount);
      this.startKeepAlive();
      this.update({
        status: "live",
        attempt: 0,
        error: null,
        since: Date.now(),
        nextRetryMs: null,
        warning: false,
        bufferedMs: 0,
        prebuffering: this.tx.settings.prebufferMs > 0,
        protectedBytes: 0,
        mount,
        mountSwitched: this.router?.switched ?? false,
        mountSwitches: this.router?.state.switches ?? 0,
      });
    } catch (err) {
      await this.fail(err instanceof Error ? err.message : String(err), attemptId);
    }
  }

  /** Unexpected drop while live: the shell tells us, we reopen with backoff. */
  private attachBridge() {
    this.unsubBridge?.();
    const bridge = window.signalpath?.stream;
    if (!bridge) {
      this.unsubBridge = null;
      return;
    }
    this.unsubBridge = bridge.onState((s) => {
      if (this.stopped) return;
      if (s.status === "offline" && this.state.status === "live") {
        void this.fail(s.error || "the source connection dropped");
      }
    });
  }

  private async fail(message: string, attemptId?: number) {
    // A late failure from an attempt that has already been replaced (the
    // browser transport reports asynchronously) must not start a second
    // backoff timer.
    if (attemptId !== undefined && attemptId !== this.attemptId) return;
    this.unsubBridge?.();
    this.unsubBridge = null;
    this.clearKeepAlive();
    this.writer = null;
    // Audio produced while the socket was down is stale — never send it late.
    this.tx.reset();
    if (this.stopped) return;
    this.router?.recordFailure();
    this.state.attempt += 1;
    const delay = retryDelayMs(this.state.attempt);
    this.retryAt = Date.now() + delay;
    this.update({
      status: "retrying",
      error: message,
      attempt: this.state.attempt,
      nextRetryMs: delay,
      since: 0,
      mount: this.router?.active ?? this.state.mount,
      mountSwitched: this.router?.switched ?? this.state.mountSwitched,
      mountSwitches: this.router?.state.switches ?? this.state.mountSwitches,
    });
    this.countdownTimer = window.setInterval(() => {
      const left = Math.max(0, this.retryAt - Date.now());
      this.update({ nextRetryMs: left });
      if (left <= 0) {
        window.clearInterval(this.countdownTimer ?? undefined);
        this.countdownTimer = null;
      }
    }, 250);
    this.retryTimer = window.setTimeout(() => void this.open(), delay);
  }

  /**
   * Hand one encoded chunk to the source. Audio is dropped, never queued,
   * when the socket is down; when it is live the TX buffer decides what is
   * written now (pre-buffer, paced release, protective ceiling).
   */
  push(bytes: Uint8Array) {
    // Feed the socket during the handshake as well as when live: a server that
    // answers only after hearing the source needs those frames, and a refused
    // source can waste at most the handshake window.
    const streaming = this.state.status === "live" || this.state.status === "connecting";
    if (!streaming || !this.writer) {
      this.update({ droppedBytes: this.state.droppedBytes + bytes.byteLength });
      return;
    }
    const writer = this.writer;
    const bitrate = this.cfg?.bitrateKbps ?? 0;
    const chunks = this.tx.enqueue(bytes, bitrate);
    let written = 0;
    for (const chunk of chunks) {
      writer.write(chunk);
      written += chunk.byteLength;
    }
    const q = this.tx.snapshot();
    this.update({
      sentBytes: this.state.sentBytes + written,
      bufferedMs: q.bufferedMs,
      prebuffering: q.priming,
      protectedBytes: q.droppedBytes,
      warning: q.warning,
    });
  }

  setMetadata(text: string) {
    this.metadata = text;
    window.signalpath?.stream?.metadata(text);
    // A title that arrives after the socket went live still needs the timer.
    if (this.state.status === "live") this.startKeepAlive();
  }

  /** The title a fresh connection will announce. */
  getMetadata(): string {
    return this.metadata;
  }

  async stop(silent = false): Promise<void> {
    this.stopped = true;
    this.attemptId += 1;
    this.clearTimers();
    this.router?.reset();
    this.router = null;
    this.unsubBridge?.();
    this.unsubBridge = null;
    const writer = this.writer;
    this.writer = null;
    try {
      await writer?.close();
    } catch {
      /* already gone */
    }
    if (!silent) {
      this.update({
        status: "offline",
        since: 0,
        nextRetryMs: null,
        error: null,
        bufferedMs: 0,
        prebuffering: false,
        warning: false,
      });
    }
  }

  /**
   * Keep the source session warm and the listener title fresh. Icecast drops
   * a source that goes quiet; a metadata frame every 30 s is cheap and the
   * desktop socket also sets TCP keep-alive.
   */
  private startKeepAlive() {
    this.clearKeepAlive();
    if (!this.metadata) return;
    this.keepAliveTimer = window.setInterval(() => {
      if (this.stopped || this.state.status !== "live" || !this.metadata) return;
      window.signalpath?.stream?.metadata(this.metadata);
    }, KEEPALIVE_MS);
  }

  private clearKeepAlive() {
    if (this.keepAliveTimer !== null) window.clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = null;
  }

  private clearTimers() {
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
    if (this.countdownTimer !== null) window.clearInterval(this.countdownTimer);
    this.clearKeepAlive();
    this.retryTimer = null;
    this.countdownTimer = null;
  }
}
