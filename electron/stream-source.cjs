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
const CONNECT_TIMEOUT_MS = 5000;
/**
 * A server that answers only once it has heard the source (SHOUTcast-style,
 * and some Icecast front-ends behind a proxy) needs the handshake to stay open
 * while frames are flowing. The wait is therefore re-armed by progress, under
 * an absolute cap so a silent or black-holed endpoint still fails cleanly.
 */
const HANDSHAKE_IDLE_MS = 3000;
const HANDSHAKE_MAX_MS = 15_000;
/** How long a preflight probe waits for the mount's verdict. */
const PROBE_TIMEOUT_MS = 6000;

/**
 * Plain-English reading of a source refusal. The status code alone is what the
 * operator needs: 401 is credentials, 403 is the mount, 404 is the name.
 */
function describeRefusal(status, body) {
  const detail = String(body || "").replace(/\s+/g, " ").trim().slice(0, 160);
  const reason =
    {
      400: "the server rejected the source request (400)",
      401: "the server refused the source credentials (401) — check the user and password",
      403: "the mount refused the source (403) — it is already in use, or this user may not take it",
      404: "the mountpoint was not found (404) — enable it on the server or correct the mount name",
    }[status] || `the server answered ${status}`;
  return detail ? `${reason} · ${detail}` : reason;
}

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
    this.handshakeDeadline = 0;
  }

  /**
   * Re-arm the handshake timer. Called at connect and on every frame written
   * while the verdict is still outstanding, so progress keeps the wait alive
   * and silence still fails at the idle interval. Never past the hard cap.
   */
  armHandshake(ms) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const req = this.req;
    if (!req) return;
    const generation = this.generation;
    const left = this.handshakeDeadline - Date.now();
    if (left <= 0) {
      req.destroy(new Error("timed out waiting for the server"));
      return;
    }
    this.timer = setTimeout(() => {
      if (generation !== this.generation) return;
      req.destroy(new Error("timed out waiting for the server"));
    }, Math.min(ms, left));
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
      this.handshakeDeadline = Date.now() + HANDSHAKE_MAX_MS;
      this.armHandshake(CONNECT_TIMEOUT_MS);

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

  /**
   * Write one encoded chunk. Dropped while offline or when the socket lags.
   *
   * Frames are accepted during the handshake too: a server that answers only
   * after hearing the source would otherwise deadlock — the renderer waits for
   * a verdict it never gets, and the 5 s timer turns every attempt into a
   * retry. Writing while connecting is what makes that server answer at all.
   */
  write(bytes) {
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    const wantsFrames = this.status === "live" || this.status === "connecting";
    if (!this.req || !wantsFrames || buf.length === 0) {
      this.dropped += buf.length;
      return;
    }
    if (this.status === "connecting") this.armHandshake(HANDSHAKE_IDLE_MS);
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

  /**
   * Preflight: open one source connection purely to read the server's verdict,
   * then close it. Used before Start, so a refused mount is reported as a
   * reason (credentials, mount in use, wrong name) instead of as an endless
   * reconnect the operator has to guess at.
   *
   * Never touches the live session: it has its own request, its own timeout
   * and no state of its own on the instance.
   */
  probe(cfg) {
    if (this.status === "live") {
      return Promise.resolve({
        ok: false,
        status: 0,
        error: "a source is already live from this console — stop it before probing",
      });
    }
    let target;
    try {
      target = resolveTarget(cfg);
    } catch (err) {
      return Promise.resolve({
        ok: false,
        status: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    const auth = Buffer.from(
      `${cfg.username || "source"}:${cfg.password || ""}`,
    ).toString("base64");
    const headers = {
      Authorization: `Basic ${auth}`,
      "Content-Type": cfg.contentType || "audio/mpeg",
      "User-Agent": "Signalpath/2.0 (+https://signalpath.app)",
      "Ice-Name": cfg.name || "Signalpath",
      "Ice-Public": "0",
      Accept: "*/*",
      Connection: "close",
    };
    if (cfg.bitrateKbps > 0) headers["Ice-Bitrate"] = String(cfg.bitrateKbps);

    return new Promise((resolve) => {
      let settled = false;
      let timer = null;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        timer = null;
        try {
          req.destroy();
        } catch {
          /* already gone */
        }
        resolve(result);
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
        resolve({ ok: false, status: 0, error: err instanceof Error ? err.message : String(err) });
        return;
      }
      req.on("socket", (socket) => socket.setNoDelay(true));
      req.on("response", (res) => {
        const status = res.statusCode || 0;
        if (status === 200) {
          finish({ ok: true, status, error: null });
          return;
        }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (part) => {
          if (body.length < 400) body += part;
        });
        res.on("end", () => finish({ ok: false, status, error: describeRefusal(status, body) }));
        res.resume();
      });
      req.on("error", (err) =>
        finish({ ok: false, status: 0, error: err instanceof Error ? err.message : String(err) }),
      );
      timer = setTimeout(
        () => finish({ ok: false, status: 0, error: "the server did not answer within 6 s" }),
        PROBE_TIMEOUT_MS,
      );
      req.flushHeaders();
      req.end();
    });
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

module.exports = { StreamSource, resolveTarget, describeRefusal, MAX_BACKLOG_BYTES };
