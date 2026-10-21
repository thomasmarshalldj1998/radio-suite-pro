/**
 * SignalPath console ↔ Python encoder bridge.
 *
 * The Python process owns the native codec session (`api_bridge.py`); the
 * console keeps its Web Audio chain and meters. This client is deliberately
 * additive: every call times out, every failure returns null/throws a typed
 * `BackendError`, and no state is written unless the bridge answered. When the
 * bridge is offline the console keeps working exactly as before.
 *
 * The base URL comes from `VITE_ENCODER_API` (default http://localhost:8000/api)
 * so a desktop build can point at a bridge on the station LAN.
 */

export type CodecState = "available" | "fallback" | "unavailable" | "unchecked";
export type CodecMode = "native" | "cli" | "none";

export interface CodecStatus {
  name: string;
  status: CodecState;
  mode: CodecMode;
  /** Alias kept for the original UI contract (same value as `mode`). */
  path?: CodecMode;
  library: string | null;
  cli: string | null;
  version: string | null;
  note: string;
}

export interface LiveMetrics {
  stream_status: "live" | "connecting" | "idle" | "error";
  active_mount: string | null;
  uptime_seconds: number;
  dropped_frames: number;
  codec: string | null;
  profile: string | null;
  bitrate_kbps: number;
  target_bitrate_kbps?: number;
  latency_ms: number;
  frames: number;
  bytes_in: number;
  bytes_out: number;
  /** Measured by the bridge from fed PCM; null until audio is fed. */
  input_level_db: number | null;
  output_level_db: number | null;
  lufs_integrated: number | null;
  true_peak_db: number | null;
  lra: number | null;
  source: "python";
}

export interface DspParam {
  value: number | string | boolean;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  options?: string[];
}

export interface DspModule {
  id: string;
  name: string;
  category: string;
  bypassed: boolean;
  params: Record<string, DspParam>;
}

export interface PerfMetrics {
  realtime_factor: number;
  cpu_dsp_pct: number;
  block_size: number;
  latency_ms: number;
  dropped_blocks: number;
  state: "live" | "lagging" | "offline";
  modules: number;
  measured_at: number;
}

export interface StartOptions {
  mount: string;
  codec?: string;
  bitrate_kbps?: number;
  profile?: string;
  sample_rate?: number;
}

export class BackendError extends Error {
  readonly status: number;
  readonly detail: string;

  constructor(status: number, detail: string) {
    super(detail);
    this.name = "BackendError";
    this.status = status;
    this.detail = detail;
  }
}

const ENV = (import.meta as ImportMeta & {
  env?: Record<string, string | undefined>;
}).env;
const DEFAULT_BASE = ENV?.VITE_ENCODER_API ?? "http://localhost:8000/api";

export class SignalPathBackend {
  readonly baseUrl: string;
  private connected: boolean | null = null;
  private readonly listeners = new Set<(connected: boolean) => void>();

  constructor(baseUrl: string = DEFAULT_BASE) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  get isConnected(): boolean | null {
    return this.connected;
  }

  subscribeConnection(cb: (connected: boolean) => void): () => void {
    this.listeners.add(cb);
    cb(this.connected === true);
    return () => {
      this.listeners.delete(cb);
    };
  }

  private setConnected(value: boolean) {
    if (this.connected === value) return;
    this.connected = value;
    for (const cb of this.listeners) cb(value);
  }

  private async request<T>(
    path: string,
    init?: RequestInit,
    timeoutMs = 2500,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          ...(init?.headers ?? {}),
        },
      });
      const text = await res.text();
      let body: unknown = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = null;
      }
      if (!res.ok) {
        const detail =
          body && typeof body === "object" && "detail" in body
            ? String((body as { detail: unknown }).detail)
            : `HTTP ${res.status}`;
        throw new BackendError(res.status, detail);
      }
      this.setConnected(true);
      return body as T;
    } catch (err) {
      this.setConnected(false);
      if (err instanceof BackendError) throw err;
      throw new BackendError(
        0,
        err instanceof Error && err.name === "AbortError"
          ? "Bridge timed out"
          : "Bridge unreachable",
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async checkConnection(): Promise<boolean> {
    try {
      await this.request<{ ok: boolean }>("/health", undefined, 1200);
      return true;
    } catch {
      return false;
    }
  }

  async getCodecStatus(): Promise<Record<string, CodecStatus> | null> {
    try {
      const data = await this.request<{ codecs: Record<string, CodecStatus> }>(
        "/status/codecs",
      );
      return data.codecs;
    } catch {
      return null;
    }
  }

  async getLiveMetrics(): Promise<LiveMetrics | null> {
    try {
      return await this.request<LiveMetrics>("/status/live");
    } catch {
      return null;
    }
  }

  /**
   * Full DSP chain control plane. These calls are additive: an offline
   * bridge returns null/false and the console keeps its WASM path.
   */
  async getModules(): Promise<{
    modules: DspModule[];
    presets: string[];
  } | null> {
    try {
      return await this.request<{ modules: DspModule[]; presets: string[] }>(
        "/dsp/modules",
        undefined,
        3000,
      );
    } catch {
      return null;
    }
  }

  async setValue(
    module: string,
    param: string,
    value: number | string | boolean,
  ): Promise<boolean> {
    try {
      await this.request("/dsp/set-value", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ module, param, value }),
      });
      return true;
    } catch {
      return false;
    }
  }

  async loadPreset(name: string, morphTime = 2): Promise<boolean> {
    try {
      await this.request("/dsp/load-preset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, morph_time: morphTime }),
      });
      return true;
    } catch {
      return false;
    }
  }

  async getPerfStatus(): Promise<PerfMetrics | null> {
    try {
      return await this.request<PerfMetrics>("/status/performance", undefined, 5000);
    } catch {
      return null;
    }
  }

  async setBlockSize(blockSize: 1024 | 2048): Promise<boolean> {
    try {
      await this.request("/dsp/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ block_size: blockSize }),
      });
      return true;
    } catch {
      return false;
    }
  }

  /** Chained 1 s perf poll — no request stacking on a slow bridge. */
  subscribePerf(
    cb: (metrics: PerfMetrics | null) => void,
    intervalMs = 1000,
  ): () => void {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (stopped) return;
      const metrics = await this.getPerfStatus();
      if (stopped) return;
      cb(metrics);
      timer = setTimeout(tick, intervalMs);
    };
    void tick();
    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }

  async startStream(options: StartOptions | string): Promise<LiveMetrics> {
    const opts = typeof options === "string" ? { mount: options } : options;
    const body = await this.request<{ ok: boolean; status: LiveMetrics }>(
      "/control/start-stream",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          codec: "aac",
          bitrate_kbps: 64,
          profile: "he-aacv2",
          ...opts,
        }),
      },
      5000,
    );
    return body.status;
  }

  async stopStream(): Promise<LiveMetrics> {
    const body = await this.request<{ ok: boolean; status: LiveMetrics }>(
      "/control/stop-stream",
      { method: "POST" },
      5000,
    );
    return body.status;
  }

  /**
   * Send one interleaved s16le stereo chunk. Only called while a Python
   * session is live, so an unused bridge never sees console audio.
   */
  async feedPcm(pcm: Uint8Array): Promise<{ bytes_out: number; frames: number }> {
    return this.request<{ ok: boolean; bytes_out: number; frames: number }>(
      "/control/feed",
      {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: pcm.buffer as ArrayBuffer,
      },
      5000,
    );
  }

  /**
   * Poll the bridge. Uses a chained timer rather than `setInterval` so a slow
   * response cannot stack requests, and stops cleanly when the caller leaves
   * the panel.
   */
  subscribeMetrics(
    cb: (metrics: LiveMetrics | null) => void,
    intervalMs = 200,
  ): () => void {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (stopped) return;
      const metrics = await this.getLiveMetrics();
      if (stopped) return;
      cb(metrics);
      timer = setTimeout(tick, intervalMs);
    };
    void tick();
    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }
}

export const backend = new SignalPathBackend();
