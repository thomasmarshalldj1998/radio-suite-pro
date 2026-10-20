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

export interface OutputProfile {
  id: string;
  label: string;
  codecId: string;
  bitrateKbps: number;
  channels: string;
  use: string;
}

/**
 * The station delivery matrix. Browsers can only *encode* a handful of
 * formats with MediaRecorder (Opus, and AAC-LC where the platform ships an
 * encoder); MP3, HE-AAC v2, Vorbis, FLAC and HLS have no browser encoders,
 * so those profiles are relay targets: the mount config records the intent
 * and a transcoder relay consumes the local proxy stream.
 */
export interface BroadcastFormat {
  id: string;
  label: string;
  bitrateKbps: number;
  /** Optional upper bound for adaptive profiles (HLS). */
  bitrateMaxKbps?: number;
  sampleRateKhz: number;
  channels: string;
  /** Ordered candidate MIME types MediaRecorder may be able to record. */
  mimes: string[];
  ext: string;
  use: string;
}

export const FORMATS: BroadcastFormat[] = [
  {
    id: "mp3-320",
    label: "MP3 @ 320 kbps",
    bitrateKbps: 320,
    sampleRateKhz: 44.1,
    channels: "Stereo",
    mimes: ["audio/mpeg"],
    ext: "mp3",
    use: "Highest-quality MP3 stream / archive",
  },
  {
    id: "aac-lc-192",
    label: "AAC-LC @ 192 kbps",
    bitrateKbps: 192,
    sampleRateKhz: 44.1,
    channels: "Stereo",
    mimes: ["audio/mp4;codecs=mp4a.40.2"],
    ext: "m4a",
    use: "Premium AAC feed",
  },
  {
    id: "aac-lc-128",
    label: "AAC-LC @ 128 kbps",
    bitrateKbps: 128,
    sampleRateKhz: 44.1,
    channels: "Stereo",
    mimes: ["audio/mp4;codecs=mp4a.40.2"],
    ext: "m4a",
    use: "Standard AAC stream",
  },
  {
    id: "heaac2-64",
    label: "HE-AAC v2 @ 64 kbps",
    bitrateKbps: 64,
    sampleRateKhz: 44.1,
    channels: "Stereo",
    mimes: [],
    ext: "m4a",
    use: "Low-bandwidth AAC+ (SBR+PS)",
  },
  {
    id: "heaac2-48",
    label: "HE-AAC v2 @ 48 kbps",
    bitrateKbps: 48,
    sampleRateKhz: 44.1,
    channels: "Stereo",
    mimes: [],
    ext: "m4a",
    use: "Minimum-bandwidth AAC+ mobile feed",
  },
  {
    id: "mp3-192",
    label: "MP3 @ 192 kbps",
    bitrateKbps: 192,
    sampleRateKhz: 44.1,
    channels: "Stereo",
    mimes: ["audio/mpeg"],
    ext: "mp3",
    use: "Wide-compatibility MP3 stereo",
  },
  {
    id: "mp3-128",
    label: "MP3 @ 128 kbps",
    bitrateKbps: 128,
    sampleRateKhz: 44.1,
    channels: "Joint Stereo",
    mimes: ["audio/mpeg"],
    ext: "mp3",
    use: "Classic 128 kbps internet-radio default",
  },
  {
    id: "mp3-64",
    label: "MP3 @ 64 kbps",
    bitrateKbps: 64,
    sampleRateKhz: 44.1,
    channels: "Mono / Joint Stereo",
    mimes: ["audio/mpeg"],
    ext: "mp3",
    use: "Talk radio / weak-network fallback",
  },
  {
    id: "opus-96",
    label: "Ogg Opus @ 96 kbps",
    bitrateKbps: 96,
    sampleRateKhz: 48,
    channels: "Stereo",
    mimes: ["audio/ogg;codecs=opus", "audio/webm;codecs=opus"],
    ext: "ogg",
    use: "Icecast2 native Opus mount",
  },
  {
    id: "vorbis-128",
    label: "Ogg Vorbis @ 128 kbps",
    bitrateKbps: 128,
    sampleRateKhz: 44.1,
    channels: "Stereo",
    mimes: ["audio/ogg;codecs=vorbis"],
    ext: "ogg",
    use: "Legacy Icecast2 Vorbis mount",
  },
  {
    id: "flac-16",
    label: "FLAC @ Lossless",
    bitrateKbps: 0,
    sampleRateKhz: 44.1,
    channels: "16-bit Stereo",
    mimes: ["audio/flac"],
    ext: "flac",
    use: "Lossless archive master",
  },
  {
    id: "hls-abr",
    label: "HLS Adaptive Multi-Bitrate",
    bitrateKbps: 64,
    bitrateMaxKbps: 192,
    sampleRateKhz: 44.1,
    channels: "Stereo",
    mimes: [],
    ext: "m3u8",
    use: "AAC ladder manifest (64–192 kbps)",
  },
  {
    id: "mpx-flac-192",
    label: "MPX over IP (FLAC)",
    bitrateKbps: 0,
    sampleRateKhz: 192,
    channels: "Mono composite",
    mimes: [],
    ext: "flac",
    use: "Composite feed to a distant FM exciter / STL",
  },
];

export interface FormatSupport {
  /** True when this browser can record the format directly. */
  ready: boolean;
  /** The MIME type that worked, when ready. */
  mime: string | null;
  note: string;
}

/** Probe whether the browser can record a delivery-matrix format. */
export function formatSupport(f: BroadcastFormat): FormatSupport {
  // MPX over IP encodes the FM composite at 192 kHz in the WASM worker —
  // available whenever the FM branch can run
  if (f.id === "mpx-flac-192") {
    return {
      ready: true,
      mime: null,
      note: "Composite FLAC · requires the FM module",
    };
  }
  // WASM-backed formats (MP3 / FLAC / Ogg Vorbis / Ogg Opus / AAC-LC /
  // HE-AAC v2) encode in the worker — the same path connect() routes them
  // through — regardless of what MediaRecorder offers
  if (jsFormatFor(f.id)) {
    return { ready: true, mime: null, note: "Encodes in-browser (WASM)" };
  }
  for (const mime of f.mimes) {
    if (isCodecSupported(mime)) {
      return { ready: true, mime, note: "Records in this browser" };
    }
  }
  return f.mimes.length === 0
    ? { ready: false, mime: null, note: "No browser encoder — relay target" }
    : {
        ready: false,
        mime: null,
        note: "This browser can't encode it — relay target",
      };
}

/** Full profile string for the mount config, e.g. “MP3 @ 128 kbps (44.1 kHz, Joint Stereo)”. */
export function formatProfile(f: BroadcastFormat): string {
  if (f.id === "hls-abr") {
    return `HLS Adaptive Multi-Bitrate (${f.bitrateKbps}–${f.bitrateMaxKbps} kbps AAC Manifest)`;
  }
  if (f.id === "mpx-flac-192") {
    return "MPX over IP @ Lossless (192.0 kHz, Mono composite)";
  }
  const rate = f.bitrateMaxKbps
    ? `${f.bitrateKbps}–${f.bitrateMaxKbps} kbps`
    : f.bitrateKbps > 0
      ? `${f.bitrateKbps} kbps`
      : "Lossless";
  return `${f.label.split(" @")[0]} @ ${rate} (${f.sampleRateKhz.toFixed(1)} kHz, ${f.channels})`;
}

export interface EncoderStats {
  bytes: number;
  elapsedMs: number;
  kbps: number;
  chunks: number;
}

/** Anything the broadcast runtime can run: MediaRecorder or a WASM encoder. */
export interface ProgramEncoder {
  running: boolean;
  onStats: ((stats: EncoderStats) => void) | null;
  /**
   * Encoded container bytes as they leave the encoder, in order. The stream
   * client pushes these straight to a source socket, so this is the only
   * bridge between "encoded" and "on air".
   */
  onChunk?: ((bytes: Uint8Array) => void) | null;
  start(timesliceMs?: number): void | Promise<void>;
  stats(): EncoderStats;
  stop(): Promise<Blob>;
  /** Container extension for downloaded takes. */
  readonly ext?: string;
}

/** WASM-backed capture formats (see js-encoder.ts + encoder.worker.ts). */
export type JsFormat = "mp3" | "flac" | "ogg" | "aac" | "aac-lc" | "opus";

/** Delivery-matrix formats that encode in-browser via the WASM workers. */
export const JS_ENCODED: Record<string, JsFormat> = {
  "opus-96": "opus",
  "mp3-320": "mp3",
  "mp3-192": "mp3",
  "mp3-128": "mp3",
  "mp3-64": "mp3",
  "aac-lc-192": "aac-lc",
  "aac-lc-128": "aac-lc",
  "vorbis-128": "ogg",
  "flac-16": "flac",
  "heaac2-64": "aac",
  "heaac2-48": "aac",
};

export function jsFormatFor(formatId: string): JsFormat | null {
  return JS_ENCODED[formatId] ?? null;
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
  onChunk: ((bytes: Uint8Array) => void) | null = null;
  /** Serialises Blob→bytes conversion so chunk order is never scrambled. */
  private chunkChain: Promise<void> = Promise.resolve();

  private stream: MediaStream;
  private opts: { mimeType: string; bitsPerSecond: number };

  constructor(stream: MediaStream, opts: { mimeType: string; bitsPerSecond: number }) {
    this.stream = stream;
    this.opts = opts;
  }

  get running(): boolean {
    return this.recorder?.state === "recording";
  }

  /** Container extension derived from the recorder MIME. */
  get ext(): string {
    if (this.mime.includes("mpeg")) return "mp3";
    if (this.mime.includes("flac")) return "flac";
    if (this.mime.includes("ogg")) return "ogg";
    if (this.mime.includes("mp4") || this.mime.includes("aac")) return "m4a";
    return "webm";
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
      const blob = event.data;
      if (this.onChunk) {
        const emit = this.onChunk;
        this.chunkChain = this.chunkChain.then(async () => {
          try {
            emit(new Uint8Array(await blob.arrayBuffer()));
          } catch {
            /* the take still records even if the upload path fails */
          }
        });
      }
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

/**
 * Build the source-endpoint URL from a mount config.
 *
 * Icecast and SHOUTcast both take `PUT /<mount>` on the port they were told
 * to listen on; only the scheme differs, and that follows the protocol field
 * (https / icecasts imply TLS) or an explicit 443. An empty port falls back to
 * the scheme's default rather than rendering `:0`.
 */
export function mountUrl(cfg: {
  protocol: string;
  server: string;
  port: number;
  mount: string;
}): string {
  const secure = /^(https|icecasts)$/i.test(cfg.protocol) || cfg.port === 443;
  const scheme = secure ? "https" : "http";
  const port = cfg.port > 0 ? cfg.port : secure ? 443 : 8000;
  const raw = (cfg.mount || "stream").trim();
  const mount = raw.startsWith("/") ? raw : `/${raw}`;
  return `${scheme}://${cfg.server}:${port}${mount}`;
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
