import { LogPanel } from "@/components/console/LogPanel";
import { LoudnessHistory } from "@/components/console/LoudnessHistory";
import { CorrelationMeter, LoudnessMeter } from "@/components/console/Meters";
import { ModuleCard } from "@/components/console/ModuleCard";
import { Button } from "@/components/ui/button";
import {
  clearAlarms,
  getAlarms,
  subscribeAlarms,
  type AlarmKind,
} from "@/lib/audio/alarms";
import { getEngine, type MeterSnapshot } from "@/lib/audio/engine";
import { formatBytes, formatUptime } from "@/lib/audio/encoder";
import {
  outputStatus,
  useOutputs,
  type OutputStatusKind,
} from "@/lib/audio/outputs";
import { LUFS_TARGET, TRUE_PEAK_TARGET } from "@/lib/audio/params";
import { getRuntime, subscribeRuntime } from "@/lib/audio/runtime";
import { cn } from "@/lib/utils";
import { Switch } from "@/components/ui/switch";
import { Antenna } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";

function useMeterSnapshot(intervalMs = 200): MeterSnapshot | null {
  const [snap, setSnap] = useState<MeterSnapshot | null>(null);
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

const fmt2 = (v: number) => v.toFixed(2).replace("-", "−");

/* ── big compliance metric card ─────────────────────────────────────────── */

function MetricCard({
  label,
  value,
  unit,
  ok,
}: {
  label: string;
  value: string;
  unit: string;
  ok: boolean | null;
}) {
  return (
    <div className="panel rounded-lg p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[9px] font-semibold tracking-[0.16em] text-panel-mut uppercase">
          {label}
        </p>
        <span
          className={cn(
            "led size-1.5",
            ok === true && "led-on",
            ok === false && "led-hot",
          )}
          aria-hidden
        />
      </div>
      <p className="text-readout mt-2 text-3xl leading-none font-semibold text-white">
        {value}
        <span className="ml-1.5 text-xs font-normal text-panel-mut">{unit}</span>
      </p>
    </div>
  );
}

/* ── one band gain-reduction row ────────────────────────────────────────── */

function GrCell({ index, value }: { index: number; value: number }) {
  const pct = Math.min(100, Math.max(0, (value / 12) * 100));
  return (
    <div className="panel-well flex items-center gap-2 rounded px-2.5 py-2">
      <span className="text-readout text-[10px] text-panel-mut">[{index}]</span>
      <span className="block h-1.5 min-w-8 flex-1 overflow-hidden rounded-full bg-input">
        <span
          className="block h-full rounded-full bg-meter-warn transition-[width] duration-150"
          style={{ width: `${pct}%` }}
        />
      </span>
      <span className="text-readout w-14 text-right text-[11px] text-white">
        −{value.toFixed(2)}
      </span>
    </div>
  );
}

const ALARM_STYLE: Record<AlarmKind, { led: string; chip: string }> = {
  peak: {
    led: "led-hot",
    chip: "border-meter-hot/40 bg-meter-hot/10 text-meter-hot",
  },
  clip: {
    led: "led-hot",
    chip: "border-meter-hot/40 bg-meter-hot/10 text-meter-hot",
  },
  loudness: {
    led: "led-warn",
    chip: "border-meter-warn/40 bg-meter-warn/10 text-meter-warn",
  },
  correlation: {
    led: "led-warn",
    chip: "border-meter-warn/40 bg-meter-warn/10 text-meter-warn",
  },
  mod: {
    led: "led-hot",
    chip: "border-meter-hot/40 bg-meter-hot/10 text-meter-hot",
  },
};

/* ── automatic tolerance alarms ────────────────────────────── */

function AlarmHistory() {
  const events = useSyncExternalStore(subscribeAlarms, getAlarms);
  return (
    <ModuleCard
      className="xl:col-span-12"
      title="Alarm history"
      subtitle="Automatic tolerance watch · true peak · clipping · loudness drift · phase · FM deviation"
      right={
        events.length > 0 ? (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 cursor-pointer text-[10px]"
            onClick={clearAlarms}
          >
            Clear
          </Button>
        ) : (
          <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <span className="led led-on size-1.5" />
            quiet
          </span>
        )
      }
    >
      {events.length === 0 ? (
        <div className="flex items-center gap-2.5 rounded-lg border border-border/60 bg-muted/40 px-3 py-3">
          <span className="led led-on size-1.5 shrink-0" />
          <p className="text-[11px] text-muted-foreground">
            No alarms this session — the chain is inside its peak, loudness
            and phase tolerances.
          </p>
        </div>
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2">
          {events.slice(0, 8).map((e) => {
            const st = ALARM_STYLE[e.kind];
            return (
              <li
                key={e.id}
                className={cn("rounded-md border px-2.5 py-2", st.chip)}
              >
                <div className="flex items-center gap-2">
                  <span
                    className={cn("led size-1.5 shrink-0", st.led)}
                    aria-hidden
                  />
                  <span className="truncate text-[11px] font-semibold">
                    {e.title}
                  </span>
                  <span className="text-readout ml-auto shrink-0 text-[9px] opacity-70">
                    {new Date(e.at).toLocaleTimeString()}
                  </span>
                </div>
                <p className="mt-0.5 truncate pl-4 text-[10px] opacity-80">
                  {e.detail}
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </ModuleCard>
  );
}

const statusCls = (kind: OutputStatusKind) =>
  kind === "onair"
    ? "font-bold text-[#ff3b30]"
    : kind === "ok"
      ? "text-meter-ok"
      : kind === "error"
        ? "text-meter-hot"
        : kind === "ready"
          ? "text-white"
          : "text-panel-mut";

/**
 * TELEMETRY — compliance monitoring, band reduction, stream status and the
 * station's event log.
 */
export function TelemetryTab({
  onConfigureStream,
}: {
  /** Jump to the Stream TX page (wired to the console tab state). */
  onConfigureStream?: () => void;
}) {
  const snap = useMeterSnapshot();
  const { slots } = useOutputs();

  const [rt, setRt] = useState(() => ({
    onAir: getRuntime().onAir,
    stats: getRuntime().stats,
  }));
  useEffect(
    () =>
      subscribeRuntime(() => {
        const r = getRuntime();
        setRt({ onAir: r.onAir, stats: r.stats });
      }),
    [],
  );
  const [liveUptimeMs, setLiveUptimeMs] = useState(0);
  useEffect(() => {
    if (!rt.onAir) return;
    const id = window.setInterval(
      () => setLiveUptimeMs(Date.now() - getRuntime().startedAt),
      1000,
    );
    return () => window.clearInterval(id);
  }, [rt.onAir]);

  // low-latency profile (persisted; applied to the engine's ceiling guard)
  const [lowLatency, setLowLatencyState] = useState(() => {
    try {
      return localStorage.getItem("signalpath.lowlatency.v1") === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    getEngine().setLowLatency(lowLatency);
  }, [lowLatency]);
  const setLowLatency = (v: boolean) => {
    setLowLatencyState(v);
    getEngine().setLowLatency(v);
    try {
      localStorage.setItem("signalpath.lowlatency.v1", v ? "1" : "0");
    } catch {
      /* storage may be unavailable */
    }
  };

  const powered = snap?.powered ?? false;
  const lufsS = snap?.lufsS ?? -70;
  const loudnessDelta = lufsS - LUFS_TARGET;
  const loudnessOk = powered ? Math.abs(loudnessDelta) <= 1 : null;
  const truePeak = snap?.truePeak ?? -70;
  const peakLimitOk = powered ? truePeak <= TRUE_PEAK_TARGET + 0.05 : null;
  const clipOk = powered ? !(snap?.clipOut ?? false) : null;
  const corr = snap?.correlation ?? 1;
  const corrOk = powered ? corr > 0.1 : null;
  const cpu = powered
    ? Math.min(100, Math.round(((snap?.perf.frameMs ?? 0) / 16.7) * 100))
    : null;
  const uptime = rt.onAir ? liveUptimeMs : rt.stats.elapsedMs;

  return (
    <div className="grid gap-4 xl:grid-cols-12">
      {/* ── compliance monitoring ── */}
      <ModuleCard
        className="xl:col-span-12"
        title="Compliance monitoring"
        subtitle="EBU R128 · ITU-R BS.1770-4 metering on the composite bus"
        right={
          <span className="text-readout hidden text-[10px] text-muted-foreground sm:inline">
            Target {LUFS_TARGET.toFixed(2)} LUFS · ceiling{" "}
            {TRUE_PEAK_TARGET.toFixed(2)} dBTP
          </span>
        }
      >
        <div className="grid gap-3 sm:grid-cols-3">
          <MetricCard
            label="Input LUFS"
            value={powered ? fmt2(snap?.lufsIn ?? -70) : "―"}
            unit="LUFS"
            ok={powered}
          />
          <MetricCard
            label="Output LUFS"
            value={powered ? fmt2(lufsS) : "―"}
            unit="LUFS"
            ok={loudnessOk}
          />
          <MetricCard
            label="Peak limit"
            value={powered ? fmt2(truePeak) : "―"}
            unit="dBTP"
            ok={peakLimitOk}
          />
        </div>

        <div className="mt-3">
          <LoudnessMeter target={LUFS_TARGET} />
        </div>

        <div className="mt-3">
          <p className="mb-1 flex items-center justify-between text-[9px] font-semibold tracking-[0.14em] text-panel-mut uppercase">
            <span>Short-term loudness history</span>
            <span className="text-readout">15 min window · 1 Hz</span>
          </p>
          <LoudnessHistory minutes={15} />
        </div>

        <div className="mt-3 grid gap-2 sm:grid-cols-3">
          <div className="panel-well flex items-center justify-between gap-3 rounded-md px-2.5 py-1.5">
            <span className="text-[9px] font-semibold tracking-[0.12em] text-panel-mut uppercase">
              Loudness vs target
            </span>
            <span className="text-readout text-[11px] text-white">
              {powered
                ? `${loudnessDelta >= 0 ? "+" : "−"}${Math.abs(loudnessDelta).toFixed(2)} LU`
                : "—"}
            </span>
          </div>
          <div className="panel-well flex items-center justify-between gap-3 rounded-md px-2.5 py-1.5">
            <span className="text-[9px] font-semibold tracking-[0.12em] text-panel-mut uppercase">
              Correlation
            </span>
            <span
              className={cn(
                "text-readout text-[11px]",
                corrOk === false ? "text-meter-hot" : "text-white",
              )}
            >
              {powered ? corr.toFixed(2) : "—"}
            </span>
          </div>
          <div className="panel-well flex items-center justify-between gap-3 rounded-md px-2.5 py-1.5">
            <span className="text-[9px] font-semibold tracking-[0.12em] text-panel-mut uppercase">
              Output clipping
            </span>
            <span
              className={cn(
                "text-readout text-[11px]",
                clipOk === false ? "text-meter-hot" : "text-white",
              )}
            >
              {powered ? (clipOk ? "clean" : "OVER") : "—"}
            </span>
          </div>
        </div>

        <div className="mt-3">
          <CorrelationMeter />
        </div>
      </ModuleCard>

      {/* ── band reduction ── */}
      <ModuleCard
        className="xl:col-span-5"
        title="Band reduction"
        subtitle="Gain reduction in dB · deepest first"
        right={
          <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <span className={cn("led size-1.5", powered && "led-on")} />
            {powered ? "live" : "idle"}
          </span>
        }
      >
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {(snap?.gr.bands ?? [0, 0, 0, 0, 0, 0]).map((gr, i) => (
            <GrCell key={i} index={i + 1} value={gr} />
          ))}
        </div>

        <div className="mt-3 grid grid-cols-3 gap-2">
          {[
            { label: "Dyn EQ", value: Math.max(0, ...(snap?.gr.deq ?? [0])) },
            { label: "AGC", value: snap?.gr.agc ?? 0 },
            { label: "Limit", value: snap?.gr.limiter ?? 0 },
          ].map((s) => (
            <div key={s.label} className="panel-well rounded px-2.5 py-2">
              <p className="text-[8px] font-semibold tracking-[0.12em] text-panel-mut uppercase">
                {s.label}
              </p>
              <p className="text-readout mt-0.5 text-[13px] font-medium text-white">
                −{s.value.toFixed(2)}
                <span className="ml-0.5 text-[8px] text-panel-mut">dB</span>
              </p>
            </div>
          ))}
        </div>
        <p className="mt-3 text-[10px] leading-4 text-muted-foreground">
          Sustained GR over 6 dB on one band means its threshold or makeup is
          working too hard — pull makeup before raising thresholds.
        </p>
      </ModuleCard>

      {/* ── stream status ── */}
      <ModuleCard
        className="xl:col-span-7"
        title="Stream status"
        subtitle="All eight outputs · engine load"
        right={
          <span
            className={cn(
              "rounded-full px-2.5 py-1 text-[10px] font-bold tracking-[0.16em] uppercase",
              rt.onAir
                ? "bg-[#ff3b30] text-white animate-pulse-live"
                : "bg-white/10 text-muted-foreground",
            )}
          >
            {rt.onAir ? "On air" : "Off air"}
          </span>
        }
      >
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {Array.from({ length: 8 }, (_, i) => {
            const st = outputStatus(i);
            return (
              <div
                key={i}
                className="panel-well flex items-center justify-between gap-3 rounded px-2.5 py-2"
              >
                <span className="text-readout text-[10px] text-panel-mut">
                  {i + 1}
                  <span className="text-panel-mut">:</span>
                </span>
                <span
                  className={cn(
                    "text-[11px] font-semibold tracking-wide uppercase",
                    statusCls(st.kind),
                  )}
                >
                  {st.label}
                </span>
              </div>
            );
          })}
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2">
          <div className="panel-well rounded px-2.5 py-2">
            <p className="text-[8px] font-semibold tracking-[0.12em] text-panel-mut uppercase">
              CPU
            </p>
            <p className="text-readout mt-0.5 text-[15px] font-medium text-white">
              {cpu === null ? "―" : `${cpu}`}
              <span className="ml-0.5 text-[9px] text-panel-mut">%</span>
            </p>
          </div>
          <div className="panel-well rounded px-2.5 py-2">
            <p className="text-[8px] font-semibold tracking-[0.12em] text-panel-mut uppercase">
              Uptime
            </p>
            <p className="text-readout mt-0.5 text-[15px] font-medium text-white">
              {formatUptime(uptime)}
            </p>
          </div>
        </div>
        <p className="mt-2 text-[10px] text-muted-foreground">
          {slots.filter((s) => s.server || s.name).length}/8 outputs configured
          · {rt.onAir ? `sending ${rt.stats.kbps.toFixed(2)} kbps` : "encoder idle"}
          {" · "}
          {formatBytes(rt.stats.bytes)} sent this session
        </p>
        {!rt.onAir && onConfigureStream && (
          <Button
            size="sm"
            variant="outline"
            onClick={onConfigureStream}
            className="mt-3 h-9 cursor-pointer gap-1.5 text-[11px] font-semibold tracking-[0.1em] uppercase"
          >
            <Antenna className="size-3.5" />
            Configure Stream
          </Button>
        )}
      </ModuleCard>

      {/* ── automatic alarms ── */}
      <AlarmHistory />

      {/* ── system health ── */}
      <ModuleCard
        className="xl:col-span-12"
        title="System health"
        subtitle="Audio-thread latency & stability"
        right={
          <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
            {snap?.perf.throttled ? "adaptive throttle ON" : "full rate"}
          </span>
        }
      >
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          {[
            {
              label: "Base latency",
              value: powered ? `${snap?.perf.baseLatencyMs.toFixed(2)} ms` : "—",
              sub: "graph → device",
            },
            {
              label: "Output latency",
              value: powered ? `${snap?.perf.outputLatencyMs.toFixed(2)} ms` : "—",
              sub: "to speaker/DAC",
            },
            {
              label: "Main-thread frame",
              value: powered ? `${snap?.perf.frameMs.toFixed(2)} ms` : "—",
              sub: "meter loop cost",
            },
            {
              label: "Clock drift",
              value: powered
                ? `${(snap?.perf.driftMs ?? 0) >= 0 ? "+" : "−"}${Math.abs(snap?.perf.driftMs ?? 0).toFixed(2)} ms/s`
                : "—",
              sub: "negative = glitches",
            },
            {
              label: "Guard profile",
              value: lowLatency ? "2× · low latency" : "4× · full quality",
              sub: "oversampling",
            },
            {
              label: "Meter loop",
              value: snap?.perf.throttled ? "adaptive · ½ rate" : "adaptive · full",
              sub: "self-tuning",
            },
          ].map((s) => (
            <div key={s.label} className="panel-well rounded-md px-2.5 py-2">
              <p className="text-[9px] font-semibold tracking-[0.1em] text-panel-mut uppercase">
                {s.label}
              </p>
              <p className="text-readout mt-1 truncate text-[13px] font-medium text-white">
                {s.value}
              </p>
              <p className="mt-0.5 text-[8px] text-panel-mut">{s.sub}</p>
            </div>
          ))}
        </div>

        <div className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-muted/40 px-3 py-2.5">
          <div className="min-w-0">
            <p className="text-xs font-medium">Low-latency profile</p>
            <p className="mt-0.5 text-[10px] leading-4 text-muted-foreground">
              Drops the ceiling guard from 4× to 2× oversampling — a touch less
              true-peak margin for the smallest possible graph delay.
            </p>
          </div>
          <label className="flex shrink-0 cursor-pointer items-center gap-2.5">
            <span className="text-[10px] font-semibold tracking-[0.12em] text-muted-foreground uppercase">
              {lowLatency ? "Low latency" : "Full quality"}
            </span>
            <Switch
              checked={lowLatency}
              onCheckedChange={(v) => setLowLatency(v)}
              aria-label="Low-latency profile"
            />
          </label>
        </div>
      </ModuleCard>

      {/* ── event log ── */}
      <div className="xl:col-span-12">
        <LogPanel />
      </div>
    </div>
  );
}

