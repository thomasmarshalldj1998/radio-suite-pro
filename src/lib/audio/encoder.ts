/**
 * Live stream encoder wrapper.
 *
 * The processed program bus is captured as a MediaStream and encoded with the
 * browser's production codecs (Opus / AAC-LC) via MediaRecorder. Chunks are
 * measured as they leave the encoder so the UI can display a true measured
 * bitrate rather than the nominal target. The same chunk stream can be POSTed
 * to an Icecast2 source endpoint (`PUT/POST /mount`) from a relay.
 */

export interface CodecOption {
  id: string;
  label: string;
  mimeType: string;
  ext: string;
  note: string;
}

export const CODECS: CodecOption[] = [
  {
    id: "opus",
    label: "Opus",
    mimeType: "audio/webm;codecs=opus",
    ext: "webm",
    note: "48 kHz · lowest latency · recommended",
  },
  {
    id: "aac",
    label: "AAC-LC",
    mimeType: "audio/mp4;codecs=mp4a.40.2",
    ext: "m4a",
    note: "Mobile-friendly · universal hardware decode",
  },
  {
    id: "vorbis",
    label: "Opus (Ogg)",
    mimeType: "audio/ogg;codecs=opus",
    ext: "ogg",
    note: "Icecast2 native container",
  },
  {
    id: "webm",
    label: "WebM (auto)",
    mimeType: "audio/webm",
    ext: "webm",
    note: "Browser default audio profile",
  },
];

export function isRecorderSupported(): boolean {
  return typeof MediaRecorder !== "undefined";
}

export function isCodecSupported(mimeType: string): boolean {
  return isRecorderSupported() && MediaRecorder.isTypeSupported(mimeType);
}

export function supportedCodecs(): CodecOption[] {
  return CODECS.filter((c) => isCodecSupported(c.mimeType));
}

export function codecById(id: string): CodecOption {
  return CODECS.find((c) => c.id === id) ?? CODECS[0];
}

export interface EncoderStats {
  bytes: number;
  elapsedMs: number;
  kbps: number;
  chunks: number;
}

export class StreamEncoder {
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private startedAt = 0;
  private totalBytes = 0;
  private chunkCount = 0;
  private smoothedKbps = 0;
  private mime = "";

  onStats: ((stats: EncoderStats) => void) | null = null;

  private stream: MediaStream;
  private opts: { mimeType: string; bitsPerSecond: number };

  constructor(stream: MediaStream, opts: { mimeType: string; bitsPerSecond: number }) {
    this.stream = stream;
    this.opts = opts;
  }

  get running(): boolean {
    return this.recorder?.state === "recording";
  }

  start(timesliceMs = 1000) {
    if (this.running || !isRecorderSupported()) return;
    this.mime = this.opts.mimeType;
    this.chunks = [];
    this.totalBytes = 0;
    this.chunkCount = 0;
    this.smoothedKbps = 0;
    this.recorder = new MediaRecorder(this.stream, {
      mimeType: this.mime,
      audioBitsPerSecond: this.opts.bitsPerSecond,
    });
    this.recorder.ondataavailable = (event) => {
      if (!event.data || event.data.size === 0) return;
      this.chunks.push(event.data);
      this.totalBytes += event.data.size;
      this.chunkCount += 1;
      const instantKbps = (event.data.size * 8) / (timesliceMs / 1000) / 1000;
      this.smoothedKbps =
        this.smoothedKbps === 0
          ? instantKbps
          : this.smoothedKbps * 0.7 + instantKbps * 0.3;
      this.onStats?.(this.stats());
    };
    this.startedAt = performance.now();
    this.recorder.start(timesliceMs);
    this.onStats?.(this.stats());
  }

  stats(): EncoderStats {
    return {
      bytes: this.totalBytes,
      elapsedMs: this.running ? performance.now() - this.startedAt : 0,
      kbps: this.smoothedKbps,
      chunks: this.chunkCount,
    };
  }

  /** Stop recording and resolve the encoded take. */
  stop(): Promise<Blob> {
    return new Promise((resolve) => {
      const rec = this.recorder;
      if (!rec || rec.state === "inactive") {
        resolve(new Blob([], { type: this.mime || "audio/webm" }));
        return;
      }
      rec.onstop = () => {
        const blob = new Blob(this.chunks, { type: this.mime });
        this.chunks = [];
        this.recorder = null;
        resolve(blob);
      };
      rec.stop();
    });
  }
}

export interface ProbeResult {
  ok: boolean;
  ms: number | null;
  note: string;
}

/**
 * Reachability probe for the mount endpoint. Browsers force opaque
 * (`no-cors`) responses for cross-origin stream servers — a resolved promise
 * still proves the host answered TCP/TLS, which is what an operator needs
 * before going on air.
 */
export async function probeEndpoint(
  url: string,
  timeoutMs = 4000,
): Promise<ProbeResult> {
  const started = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetch(url, {
      mode: "no-cors",
      cache: "no-store",
      signal: controller.signal,
    });
    return {
      ok: true,
      ms: Math.round(performance.now() - started),
      note: "Host answered the connection.",
    };
  } catch (err) {
    const message =
      err instanceof DOMException && err.name === "AbortError"
        ? `No answer within ${Math.round(timeoutMs / 1000)}s`
        : err instanceof TypeError
          ? "Unreachable — check host, port and network."
          : err instanceof Error
            ? err.message
            : "Connection failed.";
    return { ok: false, ms: null, note: message };
  } finally {
    clearTimeout(timer);
  }
}

/** Build the source-endpoint URL from a mount config. */
export function mountUrl(cfg: {
  protocol: string;
  server: string;
  port: number;
  mount: string;
}): string {
  const scheme = cfg.protocol === "shoutcast" ? "http" : "http";
  const mount = cfg.mount.startsWith("/") ? cfg.mount : `/${cfg.mount}`;
  return `${scheme}://${cfg.server}:${cfg.port}${mount}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatUptime(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = m.toString().padStart(2, "0");
  const ss = s.toString().padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
