/**
 * Icecast / SHOUTcast source connection.
 *
 * The renderer can encode audio but it cannot *send* it: a browser `PUT` with
 * an `Authorization` header trips a CORS preflight that Icecast does not
 * answer, so a web build can never open a source socket. The desktop shell
 * can, so this module owns one long-lived HTTP request and the renderer feeds
 * it encoded chunks over IPC.
 *
 * Keyed for live audio, not for file transfer: if the socket backs up, frames
 * are dropped rather than queued. A listener would rather lose 200 ms than
 * hear the programme drift a minute behind the clock.
 *
 * Kept free of Electron imports so a test script can drive it against a real
 * loopback HTTP server.
 */
const http = require("node:http");
const https = require("node:https");

/** Beyond this much unflushed data the socket is not keeping up: drop. */
const MAX_BACKLOG_BYTES = 2 * 1024 * 1024;

/** How long to wait for the server's response line before giving up. */
const CONNECT_TIMEOUT_MS = 8000;

/**
 * Build the source request target.
 * Icecast sources live at `/<mount>`; SHOUTcast v1 accepts the same PUT on
 * its stream port, so only the scheme/port handling differs here.
 */
function resolveTarget(cfg) {
  if (!cfg || typeof cfg !== "object") throw new Error("no stream config");
  const host = typeof cfg.server === "string" ? cfg.server.trim() : "";
  if (!host || /[\s/]/.test(host)) throw new Error("invalid stream host");
  const port = Number(cfg.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("invalid stream port");
  }
  const secure =
    cfg.secure === true ||
    cfg.protocol === "https" ||
    cfg.protocol === "icecasts" ||
    port === 443;
  const raw = typeof cfg.mount === "string" ? cfg.mount.trim() : "";
  const path = `/${raw.replace(/^\/+/, "") || "stream"}`;
  return { host, port, secure, path };
}

class StreamSource {
  /**
   * @param {object} [handlers]
   * @param {(state: {status: string, sent: number, dropped: number, error: string | null}) => void} [handlers.onState]
   */
  constructor(handlers = {}) {
    this.onState = handlers.onState || null;
    /** @type {import("node:http").ClientRequest | null} */
    this.req = null;
    this.status = "idle";
    this.error = null;
    this.sent = 0;
    this.dropped = 0;
    this.metaint = 0;
    this.metaPending = 0;
    this.metadata = "";
    this.openedAt = 0;
    this.timer = null;
    this.target = null;
    this.generation = 0;
  }

  emit(status, error = this.error) {
    if (status) this.status = status;
    this.error = error;
    this.onState?.({
      status: this.status,
      sent: this.sent,
      dropped: this.dropped,
      error: this.error,
    });
  }

  /**
   * Open the source connection.
   * @returns {Promise<{ ok: boolean, error?: string, sent?: number }>}
   */
  open(cfg) {
    this.close();
    let target;
    try {
      target = resolveTarget(cfg);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.emit("offline", message);
      return Promise.resolve({ ok: false, error: message });
    }
    this.target = target;
    this.metaint = Number.isFinite(cfg.metaint) && cfg.metaint > 0
      ? Math.max(1024, Math.floor(cfg.metaint))
      : 0;
    this.metaPending = 0;
    this.sent = 0;
    this.dropped = 0;
    if (typeof cfg.metadata === "string") this.metadata = cfg.metadata;

    const generation = ++this.generation;
    const auth = Buffer.from(
      `${cfg.username || "source"}:${cfg.password || ""}`,
    ).toString("base64");
    const headers = {
      Authorization: `Basic ${auth}`,
      "Content-Type": cfg.contentType || "audio/mpeg",
      "User-Agent": "Signalpath/2.0 (+https://signalpath.app)",
      "Ice-Name": cfg.name || "Signalpath",
      "Ice-Description": cfg.description || "Signalpath broadcast stream",
      "Ice-Genre": cfg.genre || "various",
      "Ice-Public": "0",
      Accept: "*/*",
      Connection: "keep-alive",
    };
    if (cfg.bitrateKbps > 0) headers["Ice-Bitrate"] = String(cfg.bitrateKbps);
    if (this.metaint) headers["icy-metaint"] = String(this.metaint);

    this.emit("connecting", null);

    return new Promise((resolve) => {
      let settled = false;
      const settle = (ok, error) => {
        if (settled) return;
        settled = true;
        resolve({ ok, error, sent: this.sent });
      };

      let req;
      try {
        req = (target.secure ? https : http).request({
          method: "PUT",
          host: target.host,
          port: target.port,
          path: target.path,
          headers,
          agent: false,
          rejectUnauthorized: false,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.emit("offline", message);
        settle(false, message);
        return;
      }
      this.req = req;
      // Live audio: Nagle would batch frames and add latency, and an idle
      // source socket is dropped by some servers without TCP keep-alive.
      req.on("socket", (socket) => {
        socket.setNoDelay(true);
        socket.setKeepAlive(true, 30_000);
      });
      this.timer = setTimeout(() => {
        if (generation !== this.generation) return;
        req.destroy(new Error("timed out waiting for the server"));
      }, CONNECT_TIMEOUT_MS);

      req.on("response", (res) => {
        if (generation !== this.generation) return;
        clearTimeout(this.timer);
        this.timer = null;
        if (res.statusCode === 200) {
          res.resume();
          this.openedAt = Date.now();
          this.emit("live", null);
          settle(true, undefined);
          return;
        }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (part) => {
          if (body.length < 400) body += part;
        });
        res.on("end", () => {
          const detail = `${res.statusCode} ${res.statusMessage || ""}`.trim();
          const reason = body.trim().slice(0, 200);
          const message = reason ? `${detail} — ${reason}` : detail;
          this.emit("offline", message);
          settle(false, message);
        });
      });

      req.on("error", (err) => {
        if (generation !== this.generation) return;
        clearTimeout(this.timer);
        this.timer = null;
        const message = err instanceof Error ? err.message : String(err);
        this.emit("offline", message);
        settle(false, message);
      });

      req.on("close", () => {
        if (generation !== this.generation) return;
        clearTimeout(this.timer);
        this.timer = null;
        if (this.status === "live") this.emit("offline", "the server closed the connection");
        settle(false, this.error);
      });

      req.flushHeaders();
    });
  }

  /** Write one encoded chunk. Dropped while offline or when the socket lags. */
  write(bytes) {
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    if (!this.req || this.status !== "live" || buf.length === 0) {
      this.dropped += buf.length;
      return;
    }
    if (this.req.writableLength > MAX_BACKLOG_BYTES) {
      this.dropped += buf.length;
      return;
    }
    if (!this.metaint) {
      this.req.write(buf);
      this.sent += buf.length;
      return;
    }
    // Interleave ICY metadata frames: exactly `metaint` audio bytes, then one
    // length byte and a 16-byte-padded payload, then the next block.
    // Both pieces of one chunk go out as a single write — one syscall per
    // chunk instead of one per audio segment and metadata block.
    const out = [];
    let offset = 0;
    while (offset < buf.length) {
      const room = this.metaint - (this.sent % this.metaint);
      const take = Math.min(room, buf.length - offset);
      out.push(buf.subarray(offset, offset + take));
      this.sent += take;
      offset += take;
      if (this.sent % this.metaint === 0) out.push(this.metadataBlock());
    }
    this.req.write(out.length === 1 ? out[0] : Buffer.concat(out));
  }

  metadataBlock() {
    const text = `StreamTitle='${this.metadata.replace(/'/g, "’").slice(0, 250)}';`;
    const raw = Buffer.from(text, "utf8");
    const frames = Math.ceil(raw.length / 16);
    const payload = Buffer.alloc(1 + frames * 16);
    payload[0] = frames;
    raw.copy(payload, 1);
    return payload;
  }

  /** Queue a "Artist - Title" line for the next metadata frame. */
  setMetadata(text) {
    this.metadata = typeof text === "string" ? text : "";
  }

  stats() {
    return {
      status: this.status,
      sent: this.sent,
      dropped: this.dropped,
      uptimeMs: this.openedAt ? Date.now() - this.openedAt : 0,
      error: this.error,
    };
  }

  close() {
    this.generation += 1;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const req = this.req;
    this.req = null;
    if (req) {
      req.removeAllListeners("close");
      req.on("error", () => {
        /* shutting down */
      });
      // End, then destroy only once the request has actually flushed. Calling
      // destroy() straight after end() throws away buffered audio, which on a
      // live source means the last seconds never reach the server.
      try {
        req.end(() => {
          try {
            req.destroy();
          } catch {
            /* already destroyed */
          }
        });
      } catch {
        try {
          req.destroy();
        } catch {
          /* already destroyed */
        }
      }
    }
    if (this.status !== "idle") this.emit("ended", null);
    return true;
  }
}

module.exports = { StreamSource, resolveTarget, MAX_BACKLOG_BYTES };
