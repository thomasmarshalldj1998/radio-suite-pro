/**
 * One UDP endpoint for the composite-over-IP link.
 *
 * A link is a plain UDP socket: datagrams arrive on `listenPort`, go out to
 * `host:port`. Nothing here knows about MPX packets — the framing, the CRC and
 * the sequence numbers live in the renderer's link layer; this file only moves
 * bytes and counts what it moved.
 *
 * Kept free of Electron imports so the exact same code path can be driven from
 * a test script over real loopback sockets.
 */
const dgram = require("node:dgram");

/** Largest payload a single UDP datagram can carry over IPv4. */
const MAX_DATAGRAM = 65507;

/**
 * Receive buffer we aim the kernel at: 512 KiB, about 1.3 s of composite at
 * 3.07 Mbit/s — enough to ride out a scheduling hiccup, far too little to
 * queue up a latency tail.
 */
const RECV_BUFFER_BYTES = 512 * 1024;

/**
 * Floor for the correction loop below. Below ~170 ms of composite the buffer
 * stops absorbing hiccups at all, and asking for an even smaller one can only
 * trade latency for dropouts.
 */
const MIN_RECV_BUFFER_BYTES = 64 * 1024;

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) return null;
  return port;
}

function parseHost(value) {
  if (typeof value !== "string") return null;
  const host = value.trim();
  if (host.length === 0 || host.length > 255) return null;
  // hostnames, dotted quads and IPv6 literals; reject anything with spaces
  if (!/^[0-9a-zA-Z.:_-]+$/.test(host)) return null;
  return host;
}

class UdpEndpoint {
  /**
   * @param {object} [options]
   * @param {(bytes: Uint8Array, rinfo: object) => void} [options.onData]
   * @param {(message: string) => void} [options.onError]
   * @param {number} [options.recvBufferBytes]
   */
  constructor(options = {}) {
    this.onData = options.onData || null;
    this.onError = options.onError || null;
    // The TARGET, not the granted size — `open()` replaces it with whatever
    // the kernel actually hands over (see setReceiveBuffer).
    this.recvBufferBytes = options.recvBufferBytes || RECV_BUFFER_BYTES;
    /** @type {import("node:dgram").Socket | null} */
    this.socket = null;
    this.boundPort = 0;
    this.listenHost = "0.0.0.0";
    this.target = null;
    this.sent = 0;
    this.sentBytes = 0;
    this.received = 0;
    this.receivedBytes = 0;
    this.dropped = 0;
    this.lastError = null;
    this.openedAt = 0;
  }

  get open() {
    return this.socket !== null;
  }

  /**
   * Bind the listening socket and set the send target.
   * @param {{ listenPort?: number, listenHost?: string, host: string, port: number }} args
   * @returns {Promise<number>} the bound port (useful when listenPort is 0)
   */
  open(args) {
    if (this.socket) return Promise.resolve(this.boundPort);
    const listenPort = parsePort(args.listenPort ?? 0);
    const listenHost = parseHost(args.listenHost ?? "0.0.0.0");
    if (listenPort === null) return Promise.reject(new Error("invalid listen port"));
    if (!listenHost) return Promise.reject(new Error("invalid listen address"));
    const host = parseHost(args.host);
    const port = parsePort(args.port);
    if (!host) return Promise.reject(new Error("invalid target host"));
    if (port === null || port === 0) return Promise.reject(new Error("invalid target port"));

    const socket = dgram.createSocket({ type: "udp4", reuseAddr: false });
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        socket.close();
        this.socket = null;
        this.lastError = `${err.code || "EIO"}: ${err.message}`;
        reject(new Error(this.lastError));
      };
      socket.once("error", fail);
      socket.on("message", (msg) => {
        this.received += 1;
        this.receivedBytes += msg.length;
        // Copy out of Node's pooled buffer so the bytes survive the callback.
        const bytes = new Uint8Array(msg.length);
        bytes.set(msg);
        this.onData?.(bytes, null);
      });
      socket.bind({ address: listenHost, port: listenPort, exclusive: true }, () => {
        if (settled) return;
        settled = true;
        socket.removeListener("error", fail);
        socket.on("error", (err) => {
          this.lastError = `${err.code || "EIO"}: ${err.message}`;
          this.onError?.(this.lastError);
        });
        this.recvBufferBytes = this.setReceiveBuffer(socket);
        this.socket = socket;
        this.boundPort = socket.address().port;
        this.listenHost = listenHost;
        this.target = { host, port };
        this.openedAt = Date.now();
        resolve(this.boundPort);
      });
    });
  }

  /**
   * Set the receive buffer and return what the kernel actually granted.
   *
   * The granted size is the one that matters, and it is not the requested one:
   * Linux silently doubles every SO_RCVBUF request and then reports the
   * doubled value, so asking for 512 KiB there yields 1 MiB — 2.7 s of
   * composite sitting in the kernel, exactly the latency tail this cap exists
   * to prevent (it is what failed the release workflow's verify step on
   * ubuntu-latest, where rmem_max is large enough to honour the doubling).
   *
   * So: ask, read back, and scale the request by the overshoot until the
   * granted size lands on the target. Linux settles in two passes, macOS and
   * Windows in one, and a platform that refuses to shrink is left at its last
   * granted size so the console and the verify suite report the truth instead
   * of a cap that was never applied.
   *
   * @param {{ setRecvBufferSize(bytes: number): void, getRecvBufferSize(): number }} socket
   * @returns {number} bytes the kernel actually holds for this socket
   */
  setReceiveBuffer(socket) {
    const target = this.recvBufferBytes || RECV_BUFFER_BYTES;
    let requested = target;
    let granted = target;
    for (let pass = 0; pass < 3; pass++) {
      try {
        socket.setRecvBufferSize(requested);
        granted = socket.getRecvBufferSize();
      } catch {
        // platform capped it or will not report — keep the last known size
        break;
      }
      if (!(granted > 0)) break;
      if (granted <= target) return granted;
      if (requested <= MIN_RECV_BUFFER_BYTES) break;
      // Proportional correction: exact where the kernel doubles the request,
      // converging anyway where it merely rounds it up.
      const scaled = Math.floor((requested * target) / granted);
      requested = Math.max(
        MIN_RECV_BUFFER_BYTES,
        Math.min(requested - 1, scaled),
      );
    }
    return granted;
  }

  /** @param {string} host @param {number} port */
  setTarget(host, port) {
    const h = parseHost(host);
    const p = parsePort(port);
    if (!h || p === null || p === 0) throw new Error("invalid target");
    this.target = { host: h, port: p };
  }

  /**
   * Send one datagram. Returns false when the socket is closed, no target is
   * set, or the payload cannot fit in a datagram.
   * @param {Uint8Array} bytes
   */
  send(bytes) {
    if (!this.socket || !this.target) return false;
    if (bytes.length === 0 || bytes.length > MAX_DATAGRAM) {
      this.dropped += 1;
      this.lastError = `datagram of ${bytes.length} bytes does not fit in a UDP packet`;
      return false;
    }
    this.socket.send(bytes, 0, bytes.length, this.target.port, this.target.host, (err) => {
      if (err) {
        this.dropped += 1;
        this.lastError = `${err.code || "EIO"}: ${err.message}`;
        this.onError?.(this.lastError);
      }
    });
    this.sent += 1;
    this.sentBytes += bytes.length;
    return true;
  }

  close() {
    const socket = this.socket;
    this.socket = null;
    this.target = null;
    this.boundPort = 0;
    if (!socket) return;
    try {
      socket.close();
    } catch {
      // already closed
    }
  }

  snapshot() {
    return {
      open: this.open,
      boundPort: this.boundPort,
      /** Milliseconds of composite the kernel can hold at 3.07 Mbit/s. */
      bufferMs: Math.round(((this.recvBufferBytes * 8) / 3072000) * 1000),
      listenHost: this.listenHost,
      target: this.target,
      sent: this.sent,
      sentBytes: this.sentBytes,
      received: this.received,
      receivedBytes: this.receivedBytes,
      dropped: this.dropped,
      lastError: this.lastError,
    };
  }
}

module.exports = { UdpEndpoint, MAX_DATAGRAM, parseHost, parsePort };
