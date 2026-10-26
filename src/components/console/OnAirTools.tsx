import { ModuleCard } from "@/components/console/ModuleCard";
import { CtrlRow, Val } from "@/components/console/controls";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { usePushLog } from "@/lib/backend/hooks";
import { aircheck, MAX_AIRCHECK_MS, formatBytes, type AircheckState } from "@/lib/audio/aircheck";
import { getEngine, type MeterSnapshot } from "@/lib/audio/engine";
import type { ProcessorParams } from "@/lib/audio/params";
import { cn } from "@/lib/utils";
import { CircleStop, Download, Mic, RadioTower, RotateCcw, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

const AIR_DELAY_MIN_S = 1;
const AIR_DELAY_MAX_S = 12;

function useSnap(intervalMs = 150): MeterSnapshot {
  const [snap, setSnap] = useState<MeterSnapshot>(() => getEngine().snapshot());
  useEffect(() => {
    let last = 0;
    return getEngine().subscribe((s) => {
      const now = performance.now();
      if (now - last >= intervalMs) {
        last = now;
        setSnap(s);
      }
    });
  }, [intervalMs]);
  return snap;
}

function useAircheck(): AircheckState {
  const [state, setState] = useState<AircheckState>(() => aircheck.getState());
  useEffect(() => aircheck.subscribe(() => setState(aircheck.getState())), []);
  return state;
}

const clock = (ms: number) => {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mmss = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return h > 0 ? `${h}:${mmss}` : mmss;
};

const secondsLabel = (v: number) => `${v.toFixed(1)} s`;

/**
 * ON AIR — the live-operations half of the processor: the broadcast delay
 * (profanity delay) with its DUMP control, and the aircheck recorder.
 *
 * The delay is a real stage in the audio graph, not a monitor-only effect: it
 * sits after the failover crossfade and ahead of every processing module, so
 * the stream encoder, the monitor and the FM branch all carry the same delayed
 * programme and a dump cuts the offending seconds from all of them at once.
 */
export function OnAirTools({
  params,
  setParams,
}: {
  params: ProcessorParams;
  setParams: React.Dispatch<React.SetStateAction<ProcessorParams>>;
}) {
  const engine = getEngine();
  const snap = useSnap();
  const check = useAircheck();
  const pushLog = usePushLog();

  const delay = snap.delay;
  const engaged = params.delay.on;
  const delaySeconds = params.delay.seconds;
  const running = snap.powered;
  const rebuildPct =
    delay.live && delay.seconds > 0
      ? Math.min(100, Math.max(0, 100 - (delay.rebuildMs / (delay.seconds * 1000)) * 100))
      : 100;

  const dump = () => {
    if (!engine.dumpDelay()) {
      toast.error("Nothing to dump", {
        description: "The broadcast delay is bypassed or the engine is stopped.",
      });
      return;
    }
    toast.success("Programme dumped", {
      description: `${delay.seconds.toFixed(1)} s cut · the delay re-arms behind the dump.`,
    });
    void pushLog({
      kind: "session",
      title: "Programme dumped",
      detail: `Broadcast delay · ${delay.seconds.toFixed(1)} s cut from air`,
    }).catch(() => {
      /* the log is best-effort */
    });
  };

  const startAircheck = () => {
    const res = aircheck.start(engine.getStream());
    if (!res.ok) {
      toast.error("Aircheck could not start", { description: res.reason });
      return;
    }
    toast.message("Aircheck recording", {
      description: "Capturing the processed programme bus.",
    });
    void pushLog({
      kind: "session",
      title: "Aircheck started",
      detail: "Capturing the post-limiter programme bus",
    }).catch(() => {
      /* best-effort */
    });
  };

  const stopAircheck = async () => {
    const take = await aircheck.stop();
    if (take) {
      toast.success("Aircheck saved", {
        description: `${clock(take.durationMs)} · ${formatBytes(take.bytes)}`,
      });
      void pushLog({
        kind: "session",
        title: "Aircheck saved",
        detail: `${clock(take.durationMs)} · ${formatBytes(take.bytes)}`,
      }).catch(() => {
        /* best-effort */
      });
    } else {
      toast.error("Aircheck produced no audio");
    }
  };

  return (
    <div className="grid min-w-0 gap-4 xl:grid-cols-12">
      {/* ── broadcast delay ─────────────────────────────────────────────── */}
      <div className="min-w-0 xl:col-span-7">
        <ModuleCard
          title="Broadcast Delay"
          subtitle="Profanity delay · dump without a gap, click or pitch shift"
          enabled={engaged}
          onToggle={() => setParams((p) => ({ ...p, delay: { ...p.delay, on: !p.delay.on } }))}
          right={
            <span
              className={cn(
                "rounded border px-2 py-1 text-[9px] font-bold tracking-[0.14em] uppercase",
                !engaged
                  ? "border-border/70 text-muted-foreground"
                  : !running
                    ? "border-border/70 text-amber-led"
                    : delay.live
                      ? "border-amber-led/50 text-amber-led"
                      : "border-meter-ok/40 text-meter-ok",
              )}
            >
              {!engaged
                ? "Bypassed"
                : !running
                  ? "Standby"
                  : delay.live
                    ? "Rebuilding"
                    : "Delayed"}
            </span>
          }
        >
          <div className="flex flex-col gap-4">
            {/* status readout */}
            <div className="rounded-lg border border-border/60 bg-muted/30 px-4 py-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div className="flex items-baseline gap-3">
                  <span className="text-readout text-3xl font-semibold tracking-tight text-foreground">
                    {engaged ? delaySeconds.toFixed(1) : "—"}
                    <span className="ml-1 text-base font-medium text-muted-foreground">s</span>
                  </span>
                  <span className="text-[10px] font-semibold tracking-[0.14em] text-muted-foreground uppercase">
                    {!engaged
                      ? "Programme is live — delay bypassed"
                      : !running
                        ? "Armed for the next start"
                        : delay.live
                          ? `Live · ${clock(delay.rebuildMs)} until delayed`
                          : "Programme is behind real time"}
                  </span>
                </div>
                {delay.dumps > 0 && (
                  <span className="text-readout text-[11px] text-muted-foreground">
                    <RotateCcw className="mr-1 inline size-3" aria-hidden />
                    {delay.dumps} dump{delay.dumps === 1 ? "" : "s"} this session
                  </span>
                )}
              </div>

              <div className="mt-3 flex items-center gap-3">
                <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-input">
                  <div
                    className={cn(
                      "h-full rounded-full transition-[width] duration-300",
                      delay.live ? "bg-amber-led" : "bg-meter-ok",
                    )}
                    style={{ width: `${engaged && running ? rebuildPct : 0}%` }}
                  />
                </div>
                <span className="text-readout w-24 shrink-0 text-right text-[10px] tracking-[0.08em] text-muted-foreground uppercase">
                  {!engaged || !running
                    ? "Line idle"
                    : delay.live
                      ? "Rebuilding"
                      : "Line armed"}
                </span>
              </div>
            </div>

            <CtrlRow label="Delay time">
              <div className="flex items-center gap-3">
                <Slider
                  className="w-40"
                  min={AIR_DELAY_MIN_S}
                  max={AIR_DELAY_MAX_S}
                  step={0.5}
                  value={[params.delay.seconds]}
                  onValueChange={(v) =>
                    setParams((p) => ({ ...p, delay: { ...p.delay, seconds: v[0] } }))
                  }
                  aria-label="Broadcast delay time"
                />
                <Val>{secondsLabel(params.delay.seconds)}</Val>
              </div>
            </CtrlRow>

            <div className="flex flex-col gap-3 rounded-lg border border-destructive/30 bg-destructive/[0.06] p-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="text-[11px] font-semibold tracking-[0.1em] text-foreground uppercase">
                  Dump
                </p>
                <p className="mt-1 text-[10px] leading-4 text-muted-foreground">
                  Cuts the last {engaged ? delaySeconds.toFixed(1) : "—"} s from air in one
                  8 ms crossfade. The line then re-arms at true speed — no gap, no
                  pitch shift, and both the stream and monitor follow.
                </p>
              </div>
              <Button
                type="button"
                variant="destructive"
                onClick={dump}
                disabled={!engaged || !delay.on || !running}
                className="h-11 shrink-0 cursor-pointer px-6 text-[12px] font-bold tracking-[0.16em] uppercase"
              >
                Dump
              </Button>
            </div>

            <p className="text-[10px] leading-4 text-muted-foreground">
              The delay sits ahead of the chain: programme reaching the encoder, the
              FM branch and the monitor is the same delayed audio. Arm it before the
              show — the line needs one delay-length of programme to fill before the
              full time is available.
            </p>
          </div>
        </ModuleCard>
      </div>

      {/* ── aircheck ────────────────────────────────────────────────────── */}
      <div className="min-w-0 xl:col-span-5">
        <ModuleCard
          title="Aircheck"
          subtitle="Processed programme capture · post-limiter, post-delay"
          right={
            <span
              className={cn(
                "flex items-center gap-1.5 text-[9px] font-bold tracking-[0.14em] uppercase",
                check.recording ? "text-destructive" : "text-muted-foreground",
              )}
            >
              <span
                className={cn(
                  "size-2 rounded-full",
                  check.recording ? "animate-pulse bg-destructive" : "bg-muted-foreground/40",
                )}
                aria-hidden
              />
              {check.recording ? "Rec" : "Idle"}
            </span>
          }
        >
          <div className="flex flex-col gap-4">
            <div className="flex items-center justify-between rounded-lg border border-border/60 bg-muted/30 px-4 py-3">
              <div>
                <p className="text-readout text-2xl font-semibold text-foreground">
                  {clock(check.elapsedMs)}
                </p>
                <p className="mt-0.5 text-[10px] tracking-[0.1em] text-muted-foreground uppercase">
                  {check.recording ? formatBytes(check.bytes) : "Ready"}
                </p>
              </div>
              <span
                className={cn(
                  "rounded border px-2 py-1 text-[9px] font-bold tracking-[0.14em] uppercase",
                  check.recording
                    ? "border-destructive/50 text-destructive"
                    : "border-border/70 text-muted-foreground",
                )}
              >
                {check.recording ? "Capturing" : "Standby"}
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="sm"
                onClick={startAircheck}
                disabled={check.recording || !snap.powered || !check.supported}
                className="cursor-pointer gap-1.5"
              >
                <Mic className="size-3.5" />
                Start capture
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void stopAircheck()}
                disabled={!check.recording}
                className="cursor-pointer gap-1.5"
              >
                <CircleStop className="size-3.5" />
                Stop &amp; save
              </Button>
              <span className="text-readout ml-auto text-[10px] text-muted-foreground">
                ≤ {clock(MAX_AIRCHECK_MS)} per take
              </span>
            </div>

            {check.error && (
              <p className="rounded border border-amber-led/40 bg-amber-led/10 px-3 py-2 text-[10px] leading-4 text-amber-led">
                {check.error}
              </p>
            )}

            {check.takes.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border/70 px-4 py-6 text-center">
                <RadioTower className="mx-auto size-5 text-muted-foreground/60" aria-hidden />
                <p className="mt-2 text-[11px] text-muted-foreground">
                  No captures yet. An aircheck records exactly what the chain puts out,
                  including the on-air delay.
                </p>
              </div>
            ) : (
              <ul className="flex flex-col divide-y divide-border/60 overflow-hidden rounded-lg border border-border/60">
                {check.takes.map((take) => (
                  <li key={take.id} className="flex items-center gap-2 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[11px] font-medium text-foreground">
                        {take.name}
                      </p>
                      <p className="text-readout mt-0.5 text-[10px] text-muted-foreground">
                        {clock(take.durationMs)} · {formatBytes(take.bytes)}
                      </p>
                    </div>
                    <a
                      href={take.url}
                      download={take.name}
                      className="flex size-8 items-center justify-center rounded border border-border/70 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                      aria-label={`Download ${take.name}`}
                      title="Download"
                    >
                      <Download className="size-3.5" />
                    </a>
                    <button
                      type="button"
                      onClick={() => aircheck.remove(take.id)}
                      className="flex size-8 cursor-pointer items-center justify-center rounded border border-border/70 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                      aria-label={`Delete ${take.name}`}
                      title="Delete"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <p className="text-[10px] leading-4 text-muted-foreground">
              Captures are held in memory for this session only — download anything you
              need to keep. The recorder taps the program bus, so it keeps running while
              you move between console pages.
            </p>
          </div>
        </ModuleCard>
      </div>
    </div>
  );
}
