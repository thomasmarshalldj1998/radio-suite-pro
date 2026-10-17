/**
 * COMPACT VIEW — single-screen broadcast overview in the spirit of a Falcon
 * D7 compact page: sources, processing, outputs, ITU loudness, monitor,
 * system status, source levels, loudness radar and distribution.
 *
 * Every number is live engine state — no simulated meters. Anything this
 * build cannot measure (GPI/GPO hardware, temperature probes) is omitted,
 * not faked.
 */
import { useEffect, useRef, useState } from "react";
import { Slider } from "@/components/ui/slider";
import {
  BandGrBar,
  GainReductionMeter,
  LoudnessMeter,
  StereoLevelMeter,
} from "@/components/console/Meters";
import { getEngine, type MeterSnapshot } from "@/lib/audio/engine";
import { getFailover } from "@/lib/audio/failover";
import { getLink } from "@/lib/audio/mpxlink-runtime";
import { getOutputs, isConfigured } from "@/lib/audio/outputs";
import { getRuntime } from "@/lib/audio/runtime";
import { formatDb, type ProcessorParams } from "@/lib/audio/params";
import { MB_SHORT_LABELS } from "@/lib/audio/params";
import { cn } from "@/lib/utils";

type SetP = React.Dispatch<React.SetStateAction<ProcessorParams>>;

function useLiveSnap(intervalMs = 500): MeterSnapshot | null {
  const [snap, setSnap] = useState<MeterSnapshot | null>(null);
  useEffect(() => {
    const id = window.setInterval(() => {
      try {
        setSnap({ ...getEngine().snapshot() });
      } catch {
        /* engine not up yet */
      }
    }, intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return snap;
}

function useClock(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

function Card({
  title,
  right,
  children,
  className,
}: {
  title: string;
  right?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("panel flex min-w-0 flex-col rounded-lg p-3", className)}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-[10px] font-bold tracking-[0.18em] text-foreground/90 uppercase">
          {title}
        </h2>
        {right}
      </div>
      {children}
    </div>
  );
}

function Num({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "font-mono text-[11px] text-foreground tabular-nums",
        className,
      )}
    >
      {children}
    </span>
  );
}

function Dot({ on, label }: { on: boolean; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span
        className={cn(
          "led size-1.5",
          on ? "led-on" : undefined,
        )}
        aria-hidden
      />
      <span className="text-[9px] font-semibold tracking-[0.1em] text-muted-foreground uppercase">
        {label}
      </span>
    </span>
  );
}

/* ── short-term history shared by radar + histogram ───────────────────── */

const HIST_N = 240;

function useStHistory(): number[] {
  const [samples, setSamples] = useState<number[]>([]);
  useEffect(
    () =>
      getEngine().subscribe((s) => {
        if (!s.powered || s.lufsS <= -70) return;
        setSamples((prev) => {
          const last = prev[prev.length - 1];
          if (
            prev.length > 0 &&
            prev.length >= HIST_N &&
            Math.abs(s.lufsS - (last ?? 0)) <= 0.01
          )
            return prev;
          const next = prev.length >= HIST_N ? prev.slice(1) : prev;
          return [...next, s.lufsS];
        });
      }),
    [],
  );
  return samples;
}

function Radar({ data, current }: { data: number[]; current: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    const cx = w / 2;
    const cy = h / 2;
    const R = Math.min(w, h) / 2 - 8;
    const rOf = (lufs: number) =>
      Math.max(0.06, Math.min(1, (lufs + 30) / 30)) * R;

    // rings + spokes
    ctx.strokeStyle = "rgba(38,42,53,0.95)";
    ctx.lineWidth = 1;
    for (const f of [0.25, 0.5, 0.75, 1]) {
      ctx.beginPath();
      ctx.arc(cx, cy, R * f, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.font = "7px ui-monospace, monospace";
    ctx.fillStyle = "#6b7280";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2 - Math.PI / 2;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * R * 0.12, cy + Math.sin(a) * R * 0.12);
      ctx.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
      ctx.stroke();
      ctx.fillText(
        String(i).padStart(2, "0"),
        cx + Math.cos(a) * (R + 6),
        cy + Math.sin(a) * (R + 6),
      );
    }

    // short-term trace around the dial (newest at top, clockwise)
    if (data.length > 1) {
      ctx.beginPath();
      data.forEach((v, i) => {
        const a =
          (i / Math.max(data.length - 1, 1)) * Math.PI * 2 - Math.PI / 2;
        const r = rOf(v);
        const x = cx + Math.cos(a) * r;
        const y = cy + Math.sin(a) * r;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.closePath();
      ctx.fillStyle = "rgba(245,165,36,0.14)";
      ctx.fill();
      ctx.strokeStyle = "#f5a524";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    // current needle
    if (Number.isFinite(current) && current > -70) {
      const r = rOf(current);
      ctx.strokeStyle = "#2dd4bf";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx, cy - r);
      ctx.stroke();
      ctx.fillStyle = "#2dd4bf";
      ctx.beginPath();
      ctx.arc(cx, cy - r, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }, [data, current]);

  return <canvas ref={ref} className="h-[168px] w-full" />;
}

function Histogram({ data }: { data: number[] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    const LO = -30;
    const HI = 6;
    const BINS = 24;
    const bins = new Array<number>(BINS).fill(0);
    for (const v of data) {
      const b = Math.min(
        BINS - 1,
        Math.max(0, Math.floor(((v - LO) / (HI - LO)) * BINS)),
      );
      bins[b] += 1;
    }
    const peak = Math.max(1, ...bins);
    const padB = 14;
    const bw = w / BINS;
    ctx.font = "7px ui-monospace, monospace";
    ctx.fillStyle = "#6b7280";
    ctx.textAlign = "center";
    for (let i = 0; i < BINS; i++) {
      const bh = (bins[i] / peak) * (h - padB - 4);
      const hot = bins[i] === peak && data.length > 8;
      ctx.fillStyle = hot ? "#ef4444" : "rgba(245,165,36,0.8)";
      ctx.fillRect(i * bw + 1, h - padB - bh, bw - 2, bh);
      if (i % 6 === 0) {
        ctx.fillStyle = "#6b7280";
        ctx.fillText(`${Math.round(LO + (i / BINS) * (HI - LO))}`, i * bw + bw / 2, h - 4);
      }
    }
  }, [data]);

  return <canvas ref={ref} className="h-[120px] w-full" />;
}

/* ── the compact page ─────────────────────────────────────────────────── */

export function CompactView({
  params,
  setParams,
  presetName,
}: {
  params: ProcessorParams;
  setParams: SetP;
  presetName: string;
}) {
  const snap = useLiveSnap();
  const now = useClock();
  const stHist = useStHistory();
  const [upNow, setUpNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setUpNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const engine = getEngine();
  const fo = getFailover();
  const link = getLink();
  const outs = getOutputs();
  const rt = getRuntime();

  const powered = snap?.powered ?? false;
  const peakOver =
    powered && (snap?.truePeak ?? -70) > params.limiter.ceilingDb + 0.05;
  const sysOk =
    powered &&
    !(snap?.clipOut ?? false) &&
    !peakOver &&
    (snap?.perf.stalls ?? 0) === 0;
  const cpu = powered
    ? Math.min(99, Math.round(((snap?.perf.frameMs ?? 0) / 16.7) * 100))
    : 0;
  const uptimeMs = rt.onAir ? upNow - rt.startedAt : rt.stats.elapsedMs;

  const srcLabel =
    engine.sourceKind === "mic"
      ? (engine.micLabel || "Microphone")
      : engine.sourceKind === "file"
        ? (engine.fileName || "File")
        : engine.generatorOn
          ? (engine.signalMode === "tone" ? "1 kHz tone" : "Pink noise")
          : "Signal generator";
  const srcLive = powered && (snap ? Math.max(snap.inPeakL, snap.inPeakR) : -70) > -60;
  const cfgSlots = outs.slots
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => isConfigured(s));

  const up2 = (v: number) =>
    Number.isFinite(v) ? v.toFixed(2).replace("-", "−") : "—";

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {/* header */}
      <div className="panel flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg px-3 py-2">
        <span className="text-[13px] font-bold tracking-wide text-foreground">
          {presetName}
        </span>
        <span className="rounded-full border border-border/60 bg-muted/30 px-3 py-0.5 text-[9px] font-bold tracking-[0.18em] text-foreground uppercase">
          Compact view
        </span>
        {rt.onAir && (
          <span className="rounded border border-red-400/50 bg-red-400/10 px-2 py-0.5 text-[9px] font-bold tracking-[0.18em] text-red-300 uppercase">
            On air
          </span>
        )}
        <span className="ml-auto font-mono text-[12px] text-muted-foreground tabular-nums">
          {now.toLocaleTimeString()} · {now.toLocaleDateString()}
        </span>
      </div>

      {/* row 1: sources · processing · outputs */}
      <div className="grid min-w-0 gap-3 xl:grid-cols-12">
        <Card
          title="Audio selector"
          className="xl:col-span-3"
          right={
            <span className="text-[9px] font-semibold tracking-[0.1em] text-muted-foreground uppercase">
              {fo.active ? "Standby on air" : engine.sourceKind}
            </span>
          }
        >
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2 rounded border border-border/60 px-2 py-1.5">
              <div className="flex min-w-0 flex-col">
                <span className="text-[8px] font-bold tracking-[0.16em] text-muted-foreground uppercase">
                  First source
                </span>
                <span className="truncate text-[11px] font-semibold text-foreground">
                  {srcLabel}
                </span>
              </div>
              <span
                className={cn(
                  "rounded px-1.5 py-0.5 text-[8px] font-bold tracking-[0.14em] uppercase",
                  srcLive
                    ? "border border-emerald-400/40 bg-emerald-400/10 text-emerald-300"
                    : "border border-amber-400/40 bg-amber-400/10 text-amber-300",
                )}
              >
                {srcLive ? "OK" : "Silent"}
              </span>
            </div>
            <div className="flex items-center justify-between gap-2 rounded border border-border/60 px-2 py-1.5">
              <div className="flex min-w-0 flex-col">
                <span className="text-[8px] font-bold tracking-[0.16em] text-muted-foreground uppercase">
                  Standby
                </span>
                <span className="truncate text-[11px] font-semibold text-foreground">
                  {fo.loaded ? "Standby armed" : "None loaded"}
                </span>
              </div>
              <span
                className={cn(
                  "rounded px-1.5 py-0.5 text-[8px] font-bold tracking-[0.14em] uppercase",
                  fo.active
                    ? "border border-red-400/50 bg-red-400/10 text-red-300"
                    : fo.loaded
                      ? "border border-emerald-400/40 bg-emerald-400/10 text-emerald-300"
                      : "border border-border/60 text-muted-foreground",
                )}
              >
                {fo.active ? "On air" : fo.loaded ? "Armed" : "Empty"}
              </span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[9px] font-semibold tracking-[0.1em] text-muted-foreground uppercase">
                Failover mode
              </span>
              <Num>
                {fo.active ? "Auto" : fo.config.enabled ? "Armed" : "Manual"}
              </Num>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[9px] font-semibold tracking-[0.1em] text-muted-foreground uppercase">
                Generator
              </span>
              <Num>{engine.generatorOn ? "On" : "Off"}</Num>
            </div>
            <StereoLevelMeter kind="in" height={64} showState />
          </div>
        </Card>

        <Card title="Processing & effects" className="xl:col-span-5">
          <div className="flex flex-wrap items-start justify-around gap-3">
            <div className="flex flex-col items-center gap-1">
              <GainReductionMeter
                get={() => getEngine().snapshot().gr.agc}
                maxDb={15}
                height={72}
                width={10}
              />
              <span className="text-[8px] font-bold tracking-[0.14em] text-muted-foreground uppercase">
                AGC {params.agc.on ? "" : "· off"}
              </span>
            </div>
            <div className="flex flex-col items-center gap-1">
              <div className="flex items-end gap-1">
                {(snap?.gr.bands ?? []).map((_, i) => (
                  <BandGrBar
                    key={MB_SHORT_LABELS[i] ?? i}
                    get={() => getEngine().snapshot().gr.bands[i] ?? 0}
                    maxDb={15}
                    height={72}
                    label={MB_SHORT_LABELS[i] ?? `${i + 1}`}
                  />
                ))}
              </div>
              <span className="text-[8px] font-bold tracking-[0.14em] text-muted-foreground uppercase">
                Multiband {params.multiband.on ? "gated" : "· off"}
              </span>
            </div>
            <div className="flex flex-col items-center gap-1">
              <GainReductionMeter
                get={() => getEngine().snapshot().gr.limiter}
                maxDb={18}
                height={72}
                width={10}
              />
              <span className="text-[8px] font-bold tracking-[0.14em] text-muted-foreground uppercase">
                Limiter {params.limiter.on ? "" : "· off"}
              </span>
            </div>
            <div className="flex min-w-28 flex-col gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[9px] text-muted-foreground">Density</span>
                <Num>{params.density.toFixed(1)}</Num>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-[9px] text-muted-foreground">Exciter</span>
                <Num>{params.exciter.mix.toFixed(0)}%</Num>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-[9px] text-muted-foreground">De-ess</span>
                <Num>{up2(snap?.deessCut ?? 0)} dB</Num>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-[9px] text-muted-foreground">Rider</span>
                <Num>{up2(snap?.riderDb ?? 0)} dB</Num>
              </div>
            </div>
          </div>
        </Card>

        <Card
          title="Audio outputs"
          className="xl:col-span-2"
          right={
            <Num className={cn(peakOver && "text-red-400")}>
              pk {up2(snap?.truePeak ?? Number.NaN)} dBTp
            </Num>
          }
        >
          <div className="flex items-start justify-around gap-2">
            <StereoLevelMeter kind="out" height={108} />
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              {cfgSlots.length === 0 && (
                <span className="text-[10px] text-muted-foreground">
                  No output configured
                </span>
              )}
              {cfgSlots.slice(0, 3).map(({ s, i }) => (
                <div
                  key={i}
                  className="flex items-center justify-between gap-2 rounded border border-border/60 px-1.5 py-1"
                >
                  <span className="truncate text-[10px] font-semibold text-foreground">
                    {s.name || s.server || `TX ${i + 1}`}
                  </span>
                  {rt.onAir && outs.liveSlot === i && (
                    <span className="shrink-0 rounded bg-emerald-400/15 px-1 py-px text-[8px] font-bold text-emerald-300 uppercase">
                      On air
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        </Card>

        <Card title="Loudness · ITU 1770" className="xl:col-span-2">
          <div className="flex items-start justify-around gap-2">
            <LoudnessMeter target={params.rider.targetLufs} />
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-3">
                <span className="text-[9px] text-muted-foreground">M</span>
                <Num>{up2(snap?.lufsM ?? Number.NaN)} LU</Num>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-[9px] text-muted-foreground">ST</span>
                <Num>{up2(snap?.lufsS ?? Number.NaN)} LU</Num>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-[9px] text-muted-foreground">LT</span>
                <Num>
                  {snap?.lufsI !== null && snap?.lufsI !== undefined
                    ? up2(snap.lufsI)
                    : "—"}{" "}
                  LU
                </Num>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-[9px] text-muted-foreground">T.PK</span>
                <Num className={cn(peakOver && "text-red-400")}>
                  {up2(snap?.truePeak ?? Number.NaN)} dBTp
                </Num>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-[9px] text-muted-foreground">THR</span>
                <Num>{formatDb(params.limiter.ceilingDb)}</Num>
              </div>
            </div>
          </div>
        </Card>
      </div>

      {/* status bar */}
      <div className="panel flex flex-wrap items-center gap-x-5 gap-y-1.5 rounded-lg px-3 py-2">
        <span
          className={cn(
            "rounded px-2 py-0.5 text-[9px] font-bold tracking-[0.16em] uppercase",
            !powered
              ? "border border-border/60 text-muted-foreground"
              : sysOk
                ? "border border-emerald-400/40 bg-emerald-400/10 text-emerald-300"
                : "border border-amber-400/40 bg-amber-400/10 text-amber-300",
          )}
        >
          {!powered ? "Standby" : sysOk ? "System OK" : "Check"}
        </span>
        <Dot on={rt.onAir} label="TX" />
        <Dot on={link.transporting} label={link.transport === "none" ? "Link idle" : `Link ${link.transport}`} />
        <span className="ml-auto flex items-center gap-4 font-mono text-[11px] text-muted-foreground tabular-nums">
          <span>CPU {cpu}%</span>
          <span>
            UP{" "}
            {uptimeMs > 0
              ? `${Math.floor(uptimeMs / 3600000)}h${String(Math.floor((uptimeMs / 60000) % 60)).padStart(2, "0")}`
              : "—"}
          </span>
          <span>BUF {rt.stats.chunks}</span>
        </span>
      </div>

      {/* row 2: monitor · sources level · radar · histogram */}
      <div className="grid min-w-0 gap-3 xl:grid-cols-12">
        <Card title="Monitor" className="xl:col-span-3">
          <div className="flex items-center gap-3">
            <StereoLevelMeter kind="out" height={72} />
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <Slider
                min={-60}
                max={0}
                step={0.5}
                value={[params.monitorDb]}
                onValueChange={([v]) => {
                  setParams((p) => ({ ...p, monitorDb: v }));
                  engine.setMonitorDb(v);
                }}
                aria-label="Monitor volume"
              />
              <div className="flex items-center justify-between">
                <Num>{formatDb(params.monitorDb)}</Num>
                <span className="text-[9px] font-semibold tracking-[0.1em] text-muted-foreground uppercase">
                  {params.stereo.width > 1.01
                    ? `Wide ×${params.stereo.width.toFixed(2)}`
                    : "Stereo"}
                </span>
              </div>
            </div>
          </div>
        </Card>

        <Card title="Sources level" className="xl:col-span-3">
          <div className="flex items-end justify-around gap-2">
            <div className="flex flex-col items-center gap-1">
              <StereoLevelMeter kind="in" height={96} />
              <span className="max-w-20 truncate text-[8px] font-bold tracking-[0.1em] text-muted-foreground uppercase">
                Input
              </span>
              <Num className="text-[10px]">
                {up2(snap ? Math.max(snap.inPeakL, snap.inPeakR) : Number.NaN)}
              </Num>
            </div>
            <div className="flex flex-col items-center gap-1">
              <StereoLevelMeter kind="out" height={96} />
              <span className="max-w-20 truncate text-[8px] font-bold tracking-[0.1em] text-muted-foreground uppercase">
                Output
              </span>
              <Num className="text-[10px]">
                {up2(snap ? Math.max(snap.outPeakL, snap.outPeakR) : Number.NaN)}
              </Num>
            </div>
            <div className="flex h-[96px] flex-col items-center justify-center gap-1 rounded border border-border/60 px-3">
              <span className="text-[8px] font-bold tracking-[0.1em] text-muted-foreground uppercase">
                Standby
              </span>
              <Num className="text-[10px]">
                {fo.active ? "ON AIR" : fo.loaded ? "ARMED" : "EMPTY"}
              </Num>
              <span className="text-[8px] font-bold tracking-[0.1em] text-muted-foreground uppercase">
                Gen
              </span>
              <Num className="text-[10px]">
                {engine.generatorOn ? "ON" : "OFF"}
              </Num>
            </div>
          </div>
        </Card>

        <Card
          title="Loudness radar"
          className="xl:col-span-3"
          right={
            <Num>
              ST{" "}
              {snap && snap.lufsS > -70 ? up2(snap.lufsS) : "—"} LU
            </Num>
          }
        >
          <Radar
            data={stHist}
            current={snap?.lufsS ?? Number.NaN}
          />
          <p className="mt-1 text-center text-[8px] text-muted-foreground">
            240-sample short-term orbit · needle = now
          </p>
        </Card>

        <Card
          title="Loudness distribution"
          className="xl:col-span-3"
          right={<Num>{stHist.length} samples</Num>}
        >
          <Histogram data={stHist} />
          <p className="mt-1 text-center text-[8px] text-muted-foreground">
            Short-term histogram −30…+6 LU · red = modal bin
          </p>
        </Card>
      </div>
    </div>
  );
}
