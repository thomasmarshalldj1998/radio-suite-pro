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
 * Retries use exponential backoff (1 s → 30 s) because a live source should
 * reconnect itself while the operator is looking at something else. Audio
 * produced while offline is dropped, never queued: a stream that catches up
 * is worse than a stream with a gap.
 */

export type StreamStatus = "idle" | "connecting" | "live" | "retrying" | "offline";

export type StreamTransport = "desktop" | "browser" | "none";

export interface StreamClientState {
  status: StreamStatus;
  transport: StreamTransport;
  /** Bytes of encoded audio handed to the transport this session. */
  sentBytes: number;
  /** Bytes produced while no connection was live (dropped by design). */
  droppedBytes: number;
  /** Failed connection attempts since the last live connection. */
  attempt: number;
  /** Countdown to the next reconnect, in ms; null when not retrying. */
  nextRetryMs: number | null;
  error: string | null;
  /** Epoch ms the current live connection started (0 when not live). */
  since: number;
}

export const IDLE_TX: StreamClientState = {
  status: "idle",
  transport: "none",
  sentBytes: 0,
  droppedBytes: 0,
  attempt: 0,
  nextRetryMs: null,
  error: null,
  since: 0,
};

export interface SourceConfig {
  protocol: string;
  server: string;
  port: number;
  mount: string;
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

/** Exponential backoff: 1 s, 2 s, 4 s … capped at 30 s. */
export function retryDelayMs(attempt: number): number {
  return Math.min(30_000, 1000 * 2 ** Math.max(0, Math.min(attempt - 1, 5)));
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

/** Desktop transport: one Node request in the shell, fed over IPC. */
async function openDesktop(cfg: SourceConfig): Promise<Writer> {
  const bridge = window.signalpath?.stream;
  if (!bridge) throw new Error("Desktop stream bridge unavailable");
  const res = await bridge.open({
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
  if (!res.ok) throw new Error(res.error || "the source connection was refused");
  return {
    write: (bytes) => bridge.write(bytes),
    close: async () => {
      await bridge.close();
    },
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
  /** Identifies the current open attempt, so stale failures are ignored. */
  private attemptId = 0;
  /** Latest ICY title; replayed to a fresh source session after a drop. */
  private metadata = "";
  private retryAt = 0;
  private state: StreamClientState = {
    status: "idle",
    transport: "none",
    sentBytes: 0,
    droppedBytes: 0,
    attempt: 0,
    nextRetryMs: null,
    error: null,
    since: 0,
  };

  getState(): StreamClientState {
    return this.state;
  }

  private update(patch: Partial<StreamClientState>) {
    this.state = { ...this.state, ...patch };
    this.onState?.(this.state);
  }

  async start(cfg: SourceConfig): Promise<void> {
    await this.stop(true);
    this.cfg = cfg;
    this.stopped = false;
    this.update({
      status: "connecting",
      transport: streamTransport(),
      error: null,
      attempt: 0,
      since: 0,
    });
    await this.open();
  }

  private async open(): Promise<void> {
    const cfg = this.cfg;
    if (!cfg || this.stopped) return;
    this.clearTimers();
    const transport = streamTransport();
    const attemptId = ++this.attemptId;
    this.update({ status: "connecting", transport, nextRetryMs: null });
    try {
      const writer =
        transport === "desktop"
          ? await openDesktop(cfg)
          : transport === "browser"
            ? await openBrowser(cfg, (message) => {
                void this.fail(message, attemptId);
              })
            : (() => {
                throw new Error(
                  "This build cannot open a source connection — use the desktop app or a relay.",
                );
              })();
      if (this.stopped) {
        await writer.close();
        return;
      }
      this.writer = writer;
      this.attachBridge();
      // A reconnect opens a new source session on the server, so the current
      // title has to be announced again or listeners see an empty field.
      if (this.metadata) window.signalpath?.stream?.metadata(this.metadata);
      this.update({
        status: "live",
        attempt: 0,
        error: null,
        since: Date.now(),
        nextRetryMs: null,
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
    this.writer = null;
    if (this.stopped) return;
    this.state.attempt += 1;
    const delay = retryDelayMs(this.state.attempt);
    this.retryAt = Date.now() + delay;
    this.update({
      status: "retrying",
      error: message,
      attempt: this.state.attempt,
      nextRetryMs: delay,
      since: 0,
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

  /** Hand one encoded chunk to the source. Dropped when not live. */
  push(bytes: Uint8Array) {
    if (this.state.status !== "live" || !this.writer) {
      this.update({ droppedBytes: this.state.droppedBytes + bytes.byteLength });
      return;
    }
    this.writer.write(bytes);
    this.update({ sentBytes: this.state.sentBytes + bytes.byteLength });
  }

  setMetadata(text: string) {
    this.metadata = text;
    window.signalpath?.stream?.metadata(text);
  }

  /** The title a fresh connection will announce. */
  getMetadata(): string {
    return this.metadata;
  }

  async stop(silent = false): Promise<void> {
    this.stopped = true;
    this.attemptId += 1;
    this.clearTimers();
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
      });
    }
  }

  private clearTimers() {
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
    if (this.countdownTimer !== null) window.clearInterval(this.countdownTimer);
    this.retryTimer = null;
    this.countdownTimer = null;
  }
}
