import { useEffect, useState } from "react";
import {
  AlertTriangle,
  Check,
  Play,
  RefreshCw,
  Server,
  Square,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ModuleCard } from "@/components/console/ModuleCard";
import {
  BackendError,
  backend,
  type CodecStatus,
  type LiveMetrics,
} from "@/lib/backend-bridge";
import { cn } from "@/lib/utils";

const CODEC_ORDER = ["MP3 (LAME)", "AAC (FDK)", "Opus", "FLAC"];

const STATUS_STYLE: Record<
  CodecStatus["status"],
  { label: string; chip: string; led: string }
> = {
  available: {
    label: "Native",
    chip: "border-signal/40 bg-signal/10 text-signal",
    led: "led-on",
  },
  fallback: {
    label: "CLI",
    chip: "border-meter-warn/40 bg-meter-warn/10 text-meter-warn",
    led: "led-warn",
  },
  unavailable: {
    label: "Missing",
    chip: "border-meter-hot/40 bg-meter-hot/10 text-meter-hot",
    led: "led-hot",
  },
  unchecked: {
    label: "Probing",
    chip: "border-border/60 bg-muted/40 text-muted-foreground",
    led: "",
  },
};

function CodecRow({ info }: { info: CodecStatus }) {
  const style = STATUS_STYLE[info.status] ?? STATUS_STYLE.unchecked;
  const detail = info.library ?? info.cli ?? "not installed";
  return (
    <div
      className="flex min-w-0 items-center gap-2 rounded-lg border border-border/60 bg-muted/30 px-2.5 py-2"
      title={info.note}
    >
      <span className={cn("led size-1.5 shrink-0", style.led)} aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5">
          <span className="truncate text-[11px] font-semibold text-foreground/90">
            {info.name}
          </span>
          <span
            className={cn(
              "shrink-0 rounded border px-1 py-px text-[8px] font-bold tracking-[0.12em] uppercase",
              style.chip,
            )}
          >
            {style.label}
          </span>
        </div>
        <p className="text-readout mt-0.5 truncate text-[9px] text-muted-foreground">
          {detail}
        </p>
      </div>
      {info.status === "unavailable" ? (
        <X className="size-3.5 shrink-0 text-meter-hot" aria-hidden />
      ) : (
        <Check className="size-3.5 shrink-0 text-signal" aria-hidden />
      )}
    </div>
  );
}

function pcm16(left: Float32Array, right: Float32Array): Uint8Array {
  const n = Math.min(left.length, right.length);
  const out = new Int16Array(n * 2);
  for (let i = 0; i < n; i += 1) {
    const l = Math.max(-32768, Math.min(32767, Math.round(left[i] * 32767)));
    const r = Math.max(-32768, Math.min(32767, Math.round(right[i] * 32767)));
    out[i * 2] = l;
    out[i * 2 + 1] = r;
  }
  return new Uint8Array(out.buffer);
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-border/50 bg-background/40 px-2 py-1.5">
      <div className="text-[8px] font-semibold tracking-[0.14em] text-muted-foreground uppercase">
        {label}
      </div>
      <div className="text-readout mt-0.5 text-[11px] text-foreground/90">{value}</div>
    </div>
  );
}

export function BackendPanel() {
  const [connected, setConnected] = useState<boolean | null>(null);
  const [codecs, setCodecs] = useState<Record<string, CodecStatus> | null>(null);
  const [metrics, setMetrics] = useState<LiveMetrics | null>(null);
  const [mount, setMount] = useState("/stream");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [feed, setFeed] = useState<"idle" | "active" | "unavailable">("idle");

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const ok = await backend.checkConnection();
      if (!alive) return;
      setConnected(ok);
      const next = ok ? await backend.getCodecStatus() : null;
      if (!alive) return;
      setCodecs(next);
    };
    void load();
    const id = window.setInterval(() => void load(), 5000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [refreshKey]);

  useEffect(() => {
    if (connected !== true) {
      setMetrics(null);
      return;
    }
    // Matches the requested 5 Hz meter cadence; the chained timer prevents
    // a slow bridge from stacking polls.
    return backend.subscribeMetrics(setMetrics, 200);
  }, [connected]);

  const live = Boolean(metrics && metrics.stream_status !== "idle");

  // While a Python session is live, mirror the processed programme into it
  // from the same PCM tap the WASM encoders use. The tap is muted and only
  // exists for the duration of the session.
  useEffect(() => {
    if (!live || connected !== true) {
      setFeed("idle");
      return;
    }
    let cancelled = false;
    let detach: (() => void) | undefined;
    let busy = false;
    void (async () => {
      try {
        const { attachPcmTap } = await import("@/lib/audio/js-encoder");
        detach = await attachPcmTap((left, right) => {
          if (busy) return;
          busy = true;
          void backend
            .feedPcm(pcm16(left, right))
            .catch(() => undefined)
            .finally(() => {
              busy = false;
            });
        });
        if (cancelled) {
          detach();
          return;
        }
        setFeed("active");
      } catch {
        if (!cancelled) setFeed("unavailable");
      }
    })();
    return () => {
      cancelled = true;
      detach?.();
    };
  }, [live, connected]);

  const run = async (action: "start" | "stop") => {
    setBusy(true);
    setError(null);
    try {
      const next =
        action === "start"
          ? await backend.startStream({ mount: mount || "/stream" })
          : await backend.stopStream();
      setMetrics(next);
      setConnected(true);
    } catch (err) {
      setError(err instanceof BackendError ? err.message : "Bridge request failed");
    } finally {
      setBusy(false);
    }
  };

  const uploadKbps = metrics?.bitrate_kbps ?? 0;

  return (
    <ModuleCard
      className="xl:col-span-12"
      title="Encoder backend"
      subtitle="Native codec bridge · Python encoder session · console audio path unchanged"
      right={
        <Button
          size="sm"
          variant="ghost"
          className="h-7 cursor-pointer px-2 text-[10px] text-muted-foreground"
          onClick={() => setRefreshKey((n) => n + 1)}
          aria-label="Re-probe codec backends"
        >
          <RefreshCw className="size-3.5" />
          Probe
        </Button>
      }
    >
      <div className="grid gap-3">
        <div className="flex flex-wrap items-center gap-2 text-[10px]">
          <span
            className={cn(
              "led size-1.5",
              connected === true ? "led-on" : connected === false ? "led-hot" : "",
            )}
            aria-hidden
          />
          <span className="font-semibold tracking-[0.12em] uppercase">
            {connected === true
              ? "Bridge online"
              : connected === false
                ? "Bridge offline"
                : "Checking bridge"}
          </span>
          <span className="text-readout text-muted-foreground">
            {backend.baseUrl}
          </span>
          <span className="ml-auto flex items-center gap-1.5 text-muted-foreground">
            <Server className="size-3.5" aria-hidden />
            {connected === true
              ? "Native session available"
              : "Console continues on WASM / MediaRecorder"}
          </span>
        </div>

        {connected === false && (
          <div className="flex items-start gap-2 rounded-lg border border-meter-warn/30 bg-meter-warn/[0.06] px-3 py-2 text-[10px] text-muted-foreground">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-meter-warn" aria-hidden />
            <div className="min-w-0">
              <p className="text-foreground/90">Start the encoder bridge to use native codecs.</p>
              <code className="text-readout mt-0.5 block truncate text-[9px] text-muted-foreground">
                uvicorn api_bridge:app --host 127.0.0.1 --port 8000
              </code>
            </div>
          </div>
        )}

        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          {codecs
            ? CODEC_ORDER.filter((name) => codecs[name]).map((name) => (
                <CodecRow key={name} info={codecs[name]} />
              ))
            : CODEC_ORDER.map((name) => (
                <div
                  key={name}
                  className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/20 px-2.5 py-2 opacity-60"
                >
                  <span className="led size-1.5" aria-hidden />
                  <span className="text-[11px] text-muted-foreground">{name}</span>
                  <span className="text-readout ml-auto text-[9px]">—</span>
                </div>
              ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5">
            <span className="text-[9px] font-semibold tracking-[0.14em] text-muted-foreground uppercase">
              Mount
            </span>
            <input
              value={mount}
              onChange={(e) => setMount(e.target.value)}
              spellCheck={false}
              className="text-readout h-8 w-32 rounded border border-border/70 bg-input px-2 text-[11px] text-foreground outline-none focus:border-signal/60"
              aria-label="Stream mount point"
            />
          </label>
          <Button
            size="sm"
            className="h-8 cursor-pointer text-[10px] tracking-wide uppercase"
            onClick={() => void run("start")}
            disabled={busy || connected === false || live}
          >
            <Play className="size-3.5" />
            Start encoder
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-8 cursor-pointer text-[10px] tracking-wide uppercase"
            onClick={() => void run("stop")}
            disabled={busy || !live}
          >
            <Square className="size-3.5" />
            Stop
          </Button>
          <span
            className={cn(
              "text-readout ml-auto rounded border px-2 py-1 text-[9px] font-bold tracking-[0.14em] uppercase",
              live
                ? "border-signal/40 bg-signal/10 text-signal"
                : "border-border/60 bg-muted/30 text-muted-foreground",
            )}
          >
            {metrics?.stream_status ?? (connected ? "idle" : "offline")}
          </span>
        </div>

        {live && (
          <div className="flex flex-wrap items-center gap-2 text-[9px] text-muted-foreground">
            <span className="font-semibold tracking-[0.14em] uppercase">PCM feed</span>
            <span
              className={cn(
                "rounded border px-1.5 py-0.5 font-bold tracking-[0.1em] uppercase",
                feed === "active"
                  ? "border-signal/40 bg-signal/10 text-signal"
                  : "border-meter-warn/40 bg-meter-warn/10 text-meter-warn",
              )}
            >
              {feed === "active"
                ? "streaming"
                : feed === "unavailable"
                  ? "console audio offline"
                  : "opening tap"}
            </span>
            <span>Live programme is mirrored from the console's PCM tap.</span>
          </div>
        )}

        {live && metrics && (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-6">
            <Stat label="Mount" value={metrics.active_mount ?? "—"} />
            <Stat label="Codec" value={`${metrics.codec ?? "—"} · ${metrics.profile ?? "—"}`} />
            <Stat label="Uplink" value={`${uploadKbps.toFixed(1)} kbps`} />
            <Stat label="Latency" value={`${metrics.latency_ms.toFixed(0)} ms`} />
            <Stat label="Frames" value={String(metrics.frames)} />
            <Stat
              label="Bridge LUFS"
              value={
                metrics.lufs_integrated === null
                  ? "no PCM"
                  : metrics.lufs_integrated.toFixed(1)
              }
            />
          </div>
        )}

        {error && (
          <p className="flex items-center gap-1.5 text-[10px] text-meter-hot">
            <AlertTriangle className="size-3.5" aria-hidden />
            {error}
          </p>
        )}
      </div>
    </ModuleCard>
  );
}
