import { LogPanel } from "@/components/console/LogPanel";
import {
  CorrelationMeter,
  GainReductionMeter,
  LoudnessMeter,
} from "@/components/console/Meters";
import { ModuleCard } from "@/components/console/ModuleCard";
import { api } from "@/convex/_generated/api";
import { getEngine, type MeterSnapshot } from "@/lib/audio/engine";
import {
  codecById,
  formatBytes,
  formatUptime,
} from "@/lib/audio/encoder";
import { getRuntime, subscribeRuntime } from "@/lib/audio/runtime";
import {
  DEQ_LABELS,
  LUFS_TARGET,
  MB_LABELS,
  TRUE_PEAK_TARGET,
} from "@/lib/audio/params";
import { cn } from "@/lib/utils";
import { useQuery } from "convex/react";
import { Activity, CheckCircle2, RadioTower, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";

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

function StatusChip({
  label,
  value,
  ok,
}: {
  label: string;
  value: string;
  ok: boolean | null;
}) {
  return (
    <div className="panel-well flex items-center justify-between gap-3 rounded-md px-2.5 py-1.5">
      <span className="text-[9px] font-semibold tracking-[0.12em] text-panel-mut uppercase">
        {label}
      </span>
      <span className="flex items-center gap-1.5">
        <span
          className={cn(
            "led size-1.5",
            ok === true ? "led-on" : ok === false ? "led-hot" : undefined,
          )}
        />
        <span
          className={cn(
            "text-readout text-[11px] font-medium",
            ok === false ? "text-meter-hot" : "text-panel-fg",
          )}
        >
          {value}
        </span>
      </span>
    </div>
  );
}

/**
 * TELEMETRY — compliance readout, band gain reduction, stream status and the
 * station's event log.
 */
export function TelemetryTab() {
  const snap = useMeterSnapshot();
  const mount = useQuery(api.stations.getMount);

  const [rt, setRt] = useState(() => ({
    onAir: getRuntime().onAir,
    stats: getRuntime().stats,
    takes: getRuntime().takes.length,
  }));
  useEffect(
    () =>
      subscribeRuntime(() => {
        const r = getRuntime();
        setRt({ onAir: r.onAir, stats: r.stats, takes: r.takes.length });
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

  const powered = snap?.powered ?? false;
  const lufsS = snap?.lufsS ?? -70;
  const loudnessDelta = lufsS - LUFS_TARGET;
  const loudnessOk = powered ? Math.abs(loudnessDelta) <= 1 : null;
  const truePeakOk = powered ? (snap?.truePeak ?? -70) <= TRUE_PEAK_TARGET + 0.05 : null;
  const clipOk = powered ? !(snap?.clipOut ?? false) : null;
  const corr = snap?.correlation ?? 1;
  const corrOk = powered ? corr > 0.1 : null;

  const codec = mount ? codecById(mount.codec) : null;
  const uptime = rt.onAir ? liveUptimeMs : rt.stats.elapsedMs;

  const stages: { name: string; on: boolean }[] = [
    { name: "Source", on: powered },
    { name: "HPF", on: powered },
    { name: "EQ", on: powered },
    { name: "Dyn EQ", on: powered },
    { name: "6-band", on: powered },
    { name: "AGC", on: powered },
    { name: "Limiter", on: powered },
    { name: "Guard", on: powered },
    { name: "Encoder", on: rt.onAir },
  ];

  return (
    <div className="grid gap-4 xl:grid-cols-12">
      {/* ── compliance ── */}
      <ModuleCard
        className="xl:col-span-7"
        title="Loudness compliance"
        subtitle="EBU R128 · ITU-R BS.1770-4 metering on the composite bus"
        right={
          <span className="text-readout hidden text-[10px] text-muted-foreground sm:inline">
            Target {LUFS_TARGET} LUFS · ceiling {TRUE_PEAK_TARGET} dBTP
          </span>
        }
      >
        <LoudnessMeter target={LUFS_TARGET} />
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <StatusChip
            label="Loudness (short-term)"
            value={
              powered
                ? `${loudnessDelta >= 0 ? "+" : "−"}${Math.abs(loudnessDelta).toFixed(1)} LU`
                : "—"
            }
            ok={loudnessOk}
          />
          <StatusChip
            label="True peak"
            value={powered ? `${(snap?.truePeak ?? -70).toFixed(1)} dBTP` : "—"}
            ok={truePeakOk}
          />
          <StatusChip
            label="Stereo correlation"
            value={powered ? corr.toFixed(2) : "—"}
            ok={corrOk}
          />
          <StatusChip
            label="Output clipping"
            value={powered ? (clipOk ? "clean" : "OVER") : "—"}
            ok={clipOk}
          />
        </div>
        <div className="mt-3">
          <p className="mb-1.5 text-[9px] font-semibold tracking-[0.14em] text-panel-mut uppercase">
            Phase display
          </p>
          <CorrelationMeter />
        </div>
      </ModuleCard>

      {/* ── band gain reduction ── */}
      <ModuleCard
        className="xl:col-span-5"
        title="Gain reduction"
        subtitle="Live GR across the chain, deepest first"
        right={
          <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <Activity className="size-3.5" />
            {powered ? "live" : "idle"}
          </span>
        }
      >
        <div>
          <p className="mb-2 text-[9px] font-semibold tracking-[0.14em] text-panel-mut uppercase">
            6-band compressor
          </p>
          <div className="panel-well flex flex-wrap items-center justify-around gap-2 rounded-md px-2 py-2.5">
            {MB_LABELS.map((label, i) => (
              <GainReductionMeter
                key={label}
                get={() => snap?.gr.bands[i] ?? 0}
                height={104}
                width={7}
                label={label}
              />
            ))}
          </div>
        </div>

        <div className="mt-3">
          <p className="mb-2 text-[9px] font-semibold tracking-[0.14em] text-panel-mut uppercase">
            Dynamic EQ cut
          </p>
          <div className="panel-well flex items-center justify-around gap-2 rounded-md px-2 py-2.5">
            {DEQ_LABELS.map((label, i) => (
              <GainReductionMeter
                key={label}
                get={() => snap?.gr.deq[i] ?? 0}
                height={72}
                width={7}
                label={label}
              />
            ))}
            <GainReductionMeter
              get={() => snap?.gr.agc ?? 0}
              height={72}
              width={7}
              label="AGC"
            />
            <GainReductionMeter
              get={() => snap?.gr.limiter ?? 0}
              height={72}
              width={7}
              label="Limit"
            />
          </div>
        </div>

        <p className="mt-3 text-[10px] leading-4 text-muted-foreground">
          Sustained GR over 6 dB on one band means its threshold or makeup is
          working too hard — pull makeup before raising thresholds.
        </p>
      </ModuleCard>

      {/* ── signal path ── */}
      <ModuleCard
        className="xl:col-span-7"
        title="Signal path"
        subtitle="Stage-by-stage chain state"
      >
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-2">
          {stages.map((stage, i) => (
            <span key={stage.name} className="flex items-center gap-1.5">
              {i > 0 && <span className="text-panel-mut">→</span>}
              <span
                className={cn(
                  "flex items-center gap-1.5 rounded-md px-2 py-1 text-[10px] font-semibold tracking-wider uppercase",
                  stage.name === "Encoder"
                    ? stage.on
                      ? "bg-signal/20 text-signal"
                      : "bg-white/6 text-panel-mut"
                    : "bg-white/6 text-panel-fg",
                )}
              >
                <span className={cn("led size-1.5", stage.on ? "led-on" : undefined)} />
                {stage.name}
              </span>
            </span>
          ))}
        </div>
        <div className="mt-3 grid grid-cols-3 gap-2">
          {[
            {
              label: "Deepest band GR",
              value: `−${Math.max(0, ...(snap?.gr.bands ?? [0])).toFixed(1)} dB`,
            },
            { label: "AGC GR", value: `−${(snap?.gr.agc ?? 0).toFixed(1)} dB` },
            {
              label: "Limiter GR",
              value: `−${(snap?.gr.limiter ?? 0).toFixed(1)} dB`,
            },
          ].map((s) => (
            <div key={s.label} className="panel-well rounded-md px-2 py-1.5">
              <p className="text-[8px] font-semibold tracking-[0.12em] text-panel-mut uppercase">
                {s.label}
              </p>
              <p className="text-readout mt-0.5 text-xs font-medium text-panel-fg">
                {s.value}
              </p>
            </div>
          ))}
        </div>
      </ModuleCard>

      {/* ── stream status ── */}
      <ModuleCard
        className="xl:col-span-5"
        title="Stream status"
        subtitle="Encoder telemetry from the broadcast runtime"
        right={
          <span
            className={cn(
              "rounded-full px-2.5 py-1 text-[10px] font-bold tracking-[0.16em] uppercase",
              rt.onAir
                ? "bg-signal text-signal-fg animate-pulse-live"
                : "bg-white/10 text-muted-foreground",
            )}
          >
            {rt.onAir ? "On air" : "Off air"}
          </span>
        }
      >
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {[
            { label: "Uptime", value: formatUptime(uptime) },
            {
              label: "Measured",
              value: rt.onAir ? rt.stats.kbps.toFixed(0) : "—",
              sub: "kbps",
            },
            {
              label: "Target",
              value: mount ? String(mount.bitrateKbps) : "—",
              sub: mount ? "kbps" : undefined,
            },
            { label: "Sent", value: formatBytes(rt.stats.bytes) },
            { label: "Codec", value: codec?.label ?? "—" },
            { label: "Takes", value: String(rt.takes) },
          ].map((s) => (
            <div key={s.label} className="panel-well rounded-md px-2 py-2">
              <p className="text-[8px] font-semibold tracking-[0.12em] text-panel-mut uppercase">
                {s.label}
              </p>
              <p className="text-readout mt-1 truncate text-sm font-medium text-panel-fg">
                {s.value}
                {s.sub && (
                  <span className="ml-0.5 text-[8px] text-panel-mut">{s.sub}</span>
                )}
              </p>
            </div>
          ))}
        </div>

        <div className="mt-3 rounded-lg border border-border/60 bg-muted/40 p-3">
          <div className="flex items-center gap-2">
            {rt.onAir ? (
              <CheckCircle2 className="size-3.5 text-meter-ok" />
            ) : (
              <RadioTower className="size-3.5 text-muted-foreground" />
            )}
            <p className="text-xs font-medium">
              {rt.onAir
                ? `Encoding to ${mount ? `${mount.protocol === "shoutcast" ? "Shoutcast" : "Icecast2"} · ${mount.server}:${mount.port}${mount.mount}` : "configured mount"}`
                : "Encoder idle — start a broadcast from the Encoder tab."}
            </p>
          </div>
          {mount?.nowPlayingTitle && (
            <p className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <TriangleAlert className="size-3 text-signal" />
              Now playing:{" "}
              <span className="text-foreground/80">
                {mount.nowPlayingArtist
                  ? `${mount.nowPlayingArtist} — ${mount.nowPlayingTitle}`
                  : mount.nowPlayingTitle}
              </span>
            </p>
          )}
        </div>
      </ModuleCard>

      {/* ── event log ── */}
      <div className="xl:col-span-12">
        <LogPanel />
      </div>
    </div>
  );
}
