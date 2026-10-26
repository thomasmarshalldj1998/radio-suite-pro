/**
 * Aircheck recorder — capture of the processed programme bus.
 *
 * The recorder taps the engine's program MediaStream (post-limiter, the same
 * bus the stream encoder and the monitor hear), so the aircheck is a truthful
 * record of what went out: AGC, multiband, limiter, on-air delay and all.
 *
 * It lives at module scope, like the broadcast runtime, so leaving the console
 * tab (or switching tabs inside it) never stops a capture in progress. Takes
 * are kept in memory as Blob URLs, capped in number and duration: an aircheck
 * is an operational convenience, not a logging system, and unbounded capture
 * would eventually cost the audio tab its memory.
 */

export interface AircheckTake {
  id: string;
  name: string;
  /** Object URL for the take. Revoked when the take is dropped. */
  url: string;
  mime: string;
  ext: string;
  bytes: number;
  durationMs: number;
  at: number;
}

export interface AircheckState {
  recording: boolean;
  /** performance.now() of the capture start (0 when idle). */
  startedAt: number;
  elapsedMs: number;
  bytes: number;
  takes: AircheckTake[];
  error: string | null;
  supported: boolean;
}

/** Newest-first list kept in memory. */
const MAX_TAKES = 6;
/** Hard bound on one capture: 3 h of Opus at 128 kbps ≈ 170 MB. */
export const MAX_AIRCHECK_MS = 3 * 60 * 60 * 1000;
/** Hard bound even if a codec disagrees with the bitrate estimate. */
const MAX_AIRCHECK_BYTES = 400 * 1024 * 1024;
/** Chunk interval — shorter than the UI poll, so size/elapsed stay live. */
const TIMESLICE_MS = 2000;
const BITS_PER_SECOND = 128_000;

function supported(): boolean {
  return typeof MediaRecorder !== "undefined" && typeof MediaStream !== "undefined";
}

/** First container this browser can encode, best first. */
function pickMime(): string {
  if (!supported()) return "";
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
  ];
  for (const mime of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(mime)) return mime;
    } catch {
      /* isTypeSupported can throw on locked-down browsers */
    }
  }
  return "";
}

function extensionFor(mime: string): string {
  if (mime.includes("mp4")) return "m4a";
  if (mime.includes("ogg")) return "ogg";
  return "webm";
}

function stamp(at = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ` +
    `${pad(at.getHours())}-${pad(at.getMinutes())}-${pad(at.getSeconds())}`
  );
}

class AircheckRecorder {
  private rec: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private chunks: Blob[] = [];
  private mime = "";
  private bytes = 0;
  private startedAt = 0;
  private ticker = 0;
  private seq = 0;
  private stopPromise: Promise<AircheckTake | null> | null = null;
  private resolveStop: ((take: AircheckTake | null) => void) | null = null;
  private listeners = new Set<() => void>();
  private state: AircheckState = {
    recording: false,
    startedAt: 0,
    elapsedMs: 0,
    bytes: 0,
    takes: [],
    error: null,
    supported: supported(),
  };

  getState = (): AircheckState => this.state;

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  };

  private emit(patch: Partial<AircheckState> = {}) {
    this.state = { ...this.state, ...patch };
    for (const cb of this.listeners) cb();
  }

  private publishClock() {
    if (!this.rec || this.rec.state !== "recording") return;
    this.emit({
      elapsedMs: performance.now() - this.startedAt,
      bytes: this.bytes,
    });
  }

  /**
   * Start capturing a stream. Returns a message on refusal so the panel can
   * say why (unsupported codec, dead bus) instead of silently doing nothing.
   */
  start(stream: MediaStream | null): { ok: boolean; reason?: string } {
    if (!supported()) {
      this.emit({ error: "This browser has no MediaRecorder — aircheck is unavailable." });
      return { ok: false, reason: "MediaRecorder unavailable" };
    }
    if (this.rec) return { ok: false, reason: "Already recording" };
    if (!stream || !stream.getAudioTracks().some((t) => t.readyState === "live")) {
      const reason = "No live programme bus — start the engine first.";
      this.emit({ error: reason });
      return { ok: false, reason };
    }

    const mime = pickMime();
    let rec: MediaRecorder;
    try {
      rec = mime
        ? new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: BITS_PER_SECOND })
        : new MediaRecorder(stream, { audioBitsPerSecond: BITS_PER_SECOND });
    } catch (err) {
      const reason =
        err instanceof Error && err.message
          ? `Recorder refused: ${err.message}`
          : "The browser refused to open a recorder.";
      this.emit({ error: reason });
      return { ok: false, reason };
    }

    this.rec = rec;
    this.stream = stream;
    this.chunks = [];
    this.bytes = 0;
    this.mime = rec.mimeType || mime || "audio/webm";
    this.startedAt = performance.now();

    rec.ondataavailable = (event) => {
      if (!event.data || event.data.size === 0) return;
      this.chunks.push(event.data);
      this.bytes += event.data.size;
      this.publishClock();
      if (this.bytes >= MAX_AIRCHECK_BYTES) this.finish();
    };
    rec.onerror = () => {
      this.emit({ error: "The recorder stopped on a media error." });
      this.finish();
    };
    rec.onstop = () => this.finish();

    // A capture must end with the bus, not linger as a dead recorder.
    for (const track of stream.getAudioTracks()) {
      track.addEventListener("ended", this.onTrackEnded, { once: true });
    }

    try {
      rec.start(TIMESLICE_MS);
    } catch (err) {
      this.cleanupTracks();
      this.rec = null;
      this.stream = null;
      this.chunks = [];
      this.bytes = 0;
      this.startedAt = 0;
      const reason =
        err instanceof Error && err.message ? err.message : "Recorder failed to start.";
      this.emit({ error: reason, recording: false, bytes: 0, elapsedMs: 0 });
      return { ok: false, reason };
    }

    this.ticker = window.setInterval(() => {
      this.publishClock();
      if (performance.now() - this.startedAt >= MAX_AIRCHECK_MS) this.finish();
    }, 500);

    this.emit({
      recording: true,
      startedAt: this.startedAt,
      elapsedMs: 0,
      bytes: 0,
      error: null,
    });
    return { ok: true };
  }

  /** Stop and resolve the finished take (null when nothing was captured). */
  stop(): Promise<AircheckTake | null> {
    if (!this.rec) return Promise.resolve(null);
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = new Promise<AircheckTake | null>((resolve) => {
      this.resolveStop = resolve;
    });
    this.finish();
    return this.stopPromise;
  }

  private onTrackEnded = () => {
    this.finish();
  };

  private finish() {
    const rec = this.rec;
    if (!rec) return;
    if (this.ticker) {
      window.clearInterval(this.ticker);
      this.ticker = 0;
    }
    if (rec.state !== "inactive") {
      try {
        rec.requestData();
      } catch {
        /* not recording */
      }
      try {
        rec.stop();
      } catch {
        /* already stopping */
      }
      return; // onstop finalises, so the last chunk is included
    }
    this.finalise();
  }

  private finalise() {
    const durationMs = this.startedAt ? performance.now() - this.startedAt : 0;
    const blob = new Blob(this.chunks, { type: this.mime });
    const mime = this.mime;
    const ext = extensionFor(mime);
    const take: AircheckTake | null =
      blob.size > 0
        ? {
            id: `aircheck-${Date.now()}-${++this.seq}`,
            name: `Signalpath aircheck ${stamp()}.${ext}`,
            url: URL.createObjectURL(blob),
            mime,
            ext,
            bytes: blob.size,
            durationMs,
            at: Date.now(),
          }
        : null;

    this.cleanupTracks();
    this.rec = null;
    this.stream = null;
    this.chunks = [];
    this.bytes = 0;
    this.startedAt = 0;
    this.mime = "";

    const takes = take ? [take, ...this.state.takes] : this.state.takes;
    while (takes.length > MAX_TAKES) {
      const dropped = takes.pop();
      if (dropped) URL.revokeObjectURL(dropped.url);
    }
    this.emit({
      recording: false,
      startedAt: 0,
      elapsedMs: 0,
      bytes: 0,
      takes,
      error: !take && !this.state.error ? "The capture produced no audio." : this.state.error,
    });

    this.resolveStop?.(take);
    this.resolveStop = null;
    this.stopPromise = null;
  }

  private cleanupTracks() {
    for (const track of this.stream?.getAudioTracks() ?? []) {
      track.removeEventListener("ended", this.onTrackEnded);
    }
  }

  /** Drop one take and release its blob URL. */
  remove(id: string) {
    const next: AircheckTake[] = [];
    for (const take of this.state.takes) {
      if (take.id === id) URL.revokeObjectURL(take.url);
      else next.push(take);
    }
    this.emit({ takes: next });
  }

  clearError() {
    if (this.state.error) this.emit({ error: null });
  }
}

/** Module-scope singleton: a capture survives tab switches inside the console. */
export const aircheck = new AircheckRecorder();

/** Human byte size for the capture readout. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
