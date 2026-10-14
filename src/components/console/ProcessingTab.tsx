import { BandGrBar, StereoLevelMeter, GainReductionMeter } from "@/components/console/Meters";
import { Fader } from "@/components/console/Fader";
import { Knob } from "@/components/console/Knob";
import { SpectrumCanvas } from "@/components/console/Spectrum";
import { CtrlRow, Seg, Val } from "@/components/console/controls";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { getEngine, type MeterSnapshot } from "@/lib/audio/engine";
import {
  DEQ_LABELS,
  MB_LABELS,
  formatDb,
  formatHz,
  type DeqBands,
  type MultibandBands,
  type MultibandSplits,
  type ProcessorParams,
} from "@/lib/audio/params";
import { cn } from "@/lib/utils";
import { Volume2, VolumeX, Zap } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

function useMeterSnapshot(intervalMs = 150): MeterSnapshot | null {
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

/** Signed 2-dp value with typographic minus. */
const sgn = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(2).replace("-", "−")}`;
/** ms → seconds, 2 dp. */
const secs = (ms: number) => `${(ms / 1000).toFixed(2)} s`;
/** Exciter insert level in dB (engine blend = mix% · 0.5). */
const harmDb = (mix: number) =>
  (
    20 *
    Math.log10(Math.max((mix / 100) * 0.5, 1e-6))
  )
    .toFixed(2)
    .replace("-", "−");

/** Human band edge for the multiband strip (last edge is the Nyquist). */
function bandRange(i: number, splits: MultibandSplits): string {
  const lo = i === 0 ? 20 : splits[i - 1];
  const hi = i === splits.length ? 20000 : splits[i];
  const fmtEdge = (hz: number) =>
    hz >= 1000 ? `${(hz / 1000).toFixed(hz % 1000 === 0 ? 0 : 1)}k` : `${hz}`;
  return `${fmtEdge(lo)}–${fmtEdge(hi)}`;
}

/* ── chain block: numbered StereoTool-style processing stage ────────────── */

function ChainBlock({
  index,
  title,
  subtitle,
  enabled,
  onToggle,
  right,
  wide = false,
  children,
}: {
  index: number;
  title: string;
  subtitle?: string;
  enabled?: boolean;
  onToggle?: () => void;
  right?: ReactNode;
  wide?: boolean;
  children: ReactNode;
}) {
  const bypassed = enabled === false;
  return (
    <section
      className={cn(
        "card-layer flex min-w-[300px] flex-1 flex-col rounded-xl border bg-card transition-colors",
        bypassed ? "border-border/50" : "border-border/70",
        wide && "min-w-[460px]",
      )}
    >
      <header
        className={cn(
          "flex items-center gap-2.5 border-b px-3 py-2.5 transition-colors",
          bypassed ? "border-border/40 bg-muted/30" : "border-border/60",
        )}
      >
        <span
          className={cn(
            "text-readout flex size-6 shrink-0 items-center justify-center rounded border border-rack-line bg-[#121417] text-[11px] font-bold transition-colors",
            bypassed ? "text-panel-mut" : "text-signal",
          )}
        >
          {String(index).padStart(2, "0")}
        </span>
        <div className="min-w-0 flex-1">
          <h3
            className={cn(
              "truncate text-[11px] font-semibold tracking-[0.12em] uppercase",
              bypassed ? "text-muted-foreground" : "text-foreground/90",
            )}
          >
            {title}
          </h3>
          {subtitle && (
            <p className="truncate text-[9px] text-muted-foreground">
              {subtitle}
            </p>
          )}
        </div>
        {bypassed && (
          <span className="rounded border border-amber-led/40 bg-amber-led/10 px-1.5 py-0.5 text-[8px] font-bold tracking-[0.14em] text-amber-led uppercase">
            Bypass
          </span>
        )}
        {right}
        {enabled !== undefined && onToggle && (
          <Switch
            checked={enabled}
            onCheckedChange={onToggle}
            aria-label={`${enabled ? "Bypass" : "Enable"} ${title}`}
            className="cursor-pointer"
          />
        )}
      </header>
      <div
        className={cn(
          "flex-1 p-3 transition-opacity",
          bypassed && "opacity-55",
        )}
      >
        {children}
      </div>
    </section>
  );
}

/** Signal-flow arrow between chain blocks. */
function ChainArrow() {
  return (
    <span
      aria-hidden
      className="hidden shrink-0 self-center text-[10px] text-rack-mut 2xl:flex"
    >
      ▶
    </span>
  );
}

/** Compact labelled horizontal slider row. */
function SliderRow({
  min,
  max,
  step,
  value,
  onChange,
  label,
  className,
}: {
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (v: number) => void;
  label: string;
  className?: string;
}) {
  return (
    <Slider
      className={cn("w-32", className)}
      min={min}
      max={max}
      step={step}
      value={[value]}
      onValueChange={(v) => onChange(v[0])}
      aria-label={label}
    />
  );
}

/**
 * PROCESSING — the chain laid out left-to-right in signal order the way a
 * StereoTool page reads: Equalizer → Dynamic EQ → Multiband → AGC →
 * Composite limit → Stereo & output, each a numbered stage with its own
 * bypass LED. The multiband stage uses one threshold fader + live GR bar
 * per band.
 */
export function ProcessingTab({
  params,
  setParams,
  compare,
  setCompare,
}: {
  params: ProcessorParams;
  setParams: React.Dispatch<React.SetStateAction<ProcessorParams>>;
  /** A/B: true = monitoring the unprocessed source (chain bypassed). */
  compare: boolean;
  setCompare: (v: boolean) => void;
}) {
  const engine = getEngine();
  const snap = useMeterSnapshot();
  const [monitorMuted, setMonitorMuted] = useState(false);

  const eqFlat = () =>
    setParams((prev) => ({
      ...prev,
      eq: { ...prev.eq, bands: prev.eq.bands.map((b) => ({ ...b, gainDb: 0 })) },
    }));

  const ceilingPct = (Math.pow(10, params.limiter.ceilingDb / 20) * 100).toFixed(2);
  const truePeak = snap?.truePeak ?? -70;
  const riderDb = snap?.riderDb ?? 0;
  const peakOver =
    (snap?.powered ?? false) && truePeak > params.limiter.ceilingDb + 0.05;
  const preUs = Math.round(params.limiter.attackMs * 1000);
  const preStandard = preUs === 1000 ? "uk" : preUs === 500 ? "us" : "custom";

  return (
    <div className="flex flex-col gap-4">
      {/* ── signal path breadcrumb ── */}
      <div className="panel flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg px-3 py-2 text-[9px] font-semibold tracking-[0.14em] text-panel-mut uppercase">
        <span className="text-panel-fg">In</span>
        {["Eq", "Dyn-eq", "Multiband", "AGC", "Limit", "Stereo"].map((s, i) => (
          <span key={s} className="flex items-center gap-2">
            <span aria-hidden>▶</span>
            <span
              className={cn(
                i === 2 ? "text-signal" : "text-panel-mut",
              )}
            >
              {s}
            </span>
          </span>
        ))}
        <span aria-hidden>▶</span>
        <span className="text-panel-fg">Out</span>
        <span className="ml-auto flex items-center gap-2 pl-3">
          {compare && (
            <span className="rounded border border-amber-led/45 bg-amber-led/10 px-2 py-1 text-[8px] font-bold tracking-[0.16em] text-amber-led uppercase">
              Source · chain bypassed · guard armed
            </span>
          )}
          <Seg
            ariaLabel="Processed versus source compare"
            value={compare ? "source" : "processed"}
            options={[
              { value: "processed", label: "Processed" },
              { value: "source", label: "Source" },
            ]}
            onChange={(v) => setCompare(v === "source")}
          />
        </span>
      </div>

      {/* ── composite response analyzer ── */}
      <div className="panel rounded-lg p-3">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
          <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
            <h2 className="text-[11px] font-semibold tracking-[0.12em] text-foreground/90 uppercase">
              Composite response
            </h2>
            <p className="text-[9px] text-muted-foreground">
              HPF + 6-band EQ curve · LR4 crossover map · live spectrum
            </p>
          </div>
          <div className="flex items-center gap-3 text-[9px] text-panel-mut">
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-0.5 w-4 rounded bg-[#60a5fa]" />
              EQ response
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-2.5 w-0 border-l border-dashed border-[#4a90e2]" />
              Crossovers
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-2.5 w-4 rounded-sm bg-[#ef5b2b]/60" />
              Spectrum
            </span>
          </div>
        </div>
        <SpectrumCanvas
          mode="live"
          height={210}
          eq={params.eq}
          hpf={params.hpf}
          splits={params.multiband.splitsHz}
        />
        <p className="mt-2 text-[10px] leading-4 text-muted-foreground">
          The blue trace is the static HPF + EQ response in dB (±15 scale);
          dashed verticals are the{" "}
          <span className="text-readout text-foreground/80">
            {params.multiband.on ? "active" : "configured"}
          </span>{" "}
          multiband crossover points. Dynamic-EQ and compression are
          level-dependent and aren't drawn.
        </p>
      </div>

      {/* ── the chain ── */}
      <div className="flex flex-wrap items-stretch gap-3">
        {/* 00 — input stage */}
        <ChainBlock
          index={0}
          title="Input stage"
          subtitle="Trim · HPF · phase · gate"
        >
          <div className="divide-y divide-border/60 rounded border border-border/60">
            <CtrlRow label="Trim">
              <SliderRow
                min={-24}
                max={24}
                step={0.5}
                value={params.inputGainDb}
                onChange={(v) =>
                  setParams((p) => ({ ...p, inputGainDb: v }))
                }
                label="Input trim"
              />
              <Val>{formatDb(params.inputGainDb)}</Val>
            </CtrlRow>
            <CtrlRow label="HPF">
              <Seg
                ariaLabel="High-pass filter"
                value={params.hpf.on ? "on" : "bypass"}
                options={[
                  { value: "on", label: "On" },
                  { value: "bypass", label: "Bypass" },
                ]}
                onChange={(v) =>
                  setParams((p) => ({ ...p, hpf: { ...p.hpf, on: v === "on" } }))
                }
              />
              <SliderRow
                min={20}
                max={300}
                step={5}
                value={params.hpf.freqHz}
                onChange={(v) =>
                  setParams((p) => ({ ...p, hpf: { ...p.hpf, freqHz: v } }))
                }
                label="HPF frequency"
              />
              <Val>{formatHz(params.hpf.freqHz)}</Val>
            </CtrlRow>
            <CtrlRow label="Phase rot">
              <Seg
                ariaLabel="Phase rotation"
                value={params.phase.mode}
                options={[
                  { value: "auto", label: "Auto" },
                  { value: "manual", label: "Manual" },
                ]}
                onChange={(v) =>
                  setParams((p) => ({
                    ...p,
                    phase: { ...p.phase, mode: v as "auto" | "manual" },
                  }))
                }
              />
              <Val>
                {params.phase.mode === "auto"
                  ? "300 Hz voice"
                  : formatHz(params.phase.freqHz)}
              </Val>
            </CtrlRow>
            <CtrlRow label="Gate">
              <Seg
                ariaLabel="Silence gate"
                value={params.gate.on ? "on" : "bypass"}
                options={[
                  { value: "on", label: "On" },
                  { value: "bypass", label: "Bypass" },
                ]}
                onChange={(v) =>
                  setParams((p) => ({
                    ...p,
                    gate: { ...p.gate, on: v === "on" },
                  }))
                }
              />
              <SliderRow
                min={-70}
                max={-30}
                step={0.5}
                value={params.gate.thresholdDb}
                onChange={(v) =>
                  setParams((p) => ({
                    ...p,
                    gate: { ...p.gate, thresholdDb: v },
                  }))
                }
                label="Gate threshold"
              />
              <Val>{sgn(params.gate.thresholdDb)} dB</Val>
            </CtrlRow>
            <CtrlRow label="Hold">
              <SliderRow
                min={100}
                max={2000}
                step={50}
                value={params.gate.holdMs}
                onChange={(v) =>
                  setParams((p) => ({ ...p, gate: { ...p.gate, holdMs: v } }))
                }
                label="Gate hold"
              />
              <Val>{secs(params.gate.holdMs)}</Val>
            </CtrlRow>
          </div>
        </ChainBlock>

        <ChainArrow />

        {/* 01 — equalizer */}
        <ChainBlock
          index={1}
          title="Equalizer"
          subtitle="6-band · shelving ends"
          enabled={params.eq.on}
          onToggle={() =>
            setParams((p) => ({ ...p, eq: { ...p.eq, on: !p.eq.on } }))
          }
          right={
            <Button
              size="sm"
              variant="ghost"
              className="h-7 cursor-pointer text-[10px]"
              onClick={eqFlat}
            >
              Flat
            </Button>
          }
        >
          <div className="flex justify-between gap-1.5 overflow-x-auto pb-1">
            {params.eq.bands.map((band, i) => (
              <div key={band.freq} className="flex w-10 shrink-0 flex-col items-center">
                <Fader
                  label={formatHz(band.freq)}
                  value={band.gainDb}
                  min={-15}
                  max={15}
                  step={0.5}
                  height={112}
                  accent={Math.abs(band.gainDb) > 0.05}
                  format={(v) => `${v > 0 ? "+" : ""}${v.toFixed(2)}`}
                  onChange={(v) =>
                    setParams((p) => ({
                      ...p,
                      eq: {
                        ...p.eq,
                        bands: p.eq.bands.map((b, j) =>
                          j === i ? { ...b, gainDb: v } : b,
                        ),
                      },
                    }))
                  }
                />
                <span className="text-[8px] font-semibold tracking-wider text-panel-mut uppercase">
                  {band.type === "peaking" ? "PK" : band.type === "lowshelf" ? "LS" : "HS"}{' '}
                  Q{band.q.toFixed(2)}
                </span>
              </div>
            ))}
          </div>
        </ChainBlock>

        <ChainArrow />

        {/* 02 — dynamic EQ */}
        <ChainBlock
          index={2}
          title="Dynamic EQ"
          subtitle={DEQ_LABELS.join(" · ")}
          enabled={params.deq.on}
          onToggle={() =>
            setParams((p) => ({ ...p, deq: { ...p.deq, on: !p.deq.on } }))
          }
        >
          <div className="divide-y divide-border/60 rounded border border-border/60">
            {params.deq.bands.map((band, i) => (
              <CtrlRow key={`${band.freqHz}-${i}`} label={formatHz(band.freqHz)}>
                <SliderRow
                  className="max-w-28"
                  min={0}
                  max={20}
                  step={0.5}
                  value={band.maxCutDb}
                  onChange={(v) =>
                    setParams((p) => ({
                      ...p,
                      deq: {
                        ...p.deq,
                        bands: p.deq.bands.map((b, j) =>
                          j === i ? { ...b, maxCutDb: v } : b,
                        ) as DeqBands,
                      },
                    }))
                  }
                  label={`Band ${i + 1} cut`}
                />
                <Val>−{band.maxCutDb.toFixed(2)}</Val>
                <span className="text-[9px] font-semibold tracking-[0.1em] text-muted-foreground uppercase">
                  Q
                </span>
                <SliderRow
                  className="max-w-16"
                  min={0.3}
                  max={4}
                  step={0.1}
                  value={band.q}
                  onChange={(v) =>
                    setParams((p) => ({
                      ...p,
                      deq: {
                        ...p.deq,
                        bands: p.deq.bands.map((b, j) =>
                          j === i ? { ...b, q: v } : b,
                        ) as DeqBands,
                      },
                    }))
                  }
                  label={`Band ${i + 1} Q`}
                />
                <Val className="min-w-9">{band.q.toFixed(2)}</Val>
              </CtrlRow>
            ))}
          </div>
        </ChainBlock>

        <ChainArrow />

        {/* 03 — multiband compressor */}
        <ChainBlock
          index={3}
          title="Multiband"
          subtitle="6-band · LR4 crossovers · per-band threshold"
          wide
          enabled={params.multiband.on}
          onToggle={() =>
            setParams((p) => ({
              ...p,
              multiband: { ...p.multiband, on: !p.multiband.on },
            }))
          }
        >
          <div className="flex items-start justify-between gap-1 overflow-x-auto pb-1">
            {MB_LABELS.map((label, i) => {
              const band = params.multiband.bands[i];
              return (
                <div
                  key={label}
                  className="flex w-14 shrink-0 flex-col items-center gap-1"
                >
                  <span className="text-readout text-[10px] font-semibold text-white">
                    {sgn(band.thresholdDb)}
                  </span>
                  <Fader
                    label="thr"
                    value={band.thresholdDb}
                    min={-50}
                    max={0}
                    step={0.5}
                    height={112}
                    ticks={false}
                    format={() => ""}
                    onChange={(v) =>
                      setParams((p) => ({
                        ...p,
                        multiband: {
                          ...p.multiband,
                          bands: p.multiband.bands.map((b, j) =>
                            j === i ? { ...b, thresholdDb: v } : b,
                          ) as MultibandBands,
                        },
                      }))
                    }
                  />
                  <BandGrBar
                    get={() => getEngine().snapshot().gr.bands[i] ?? 0}
                    maxDb={15}
                    height={40}
                  />
                  <span className="text-[9px] font-semibold tracking-[0.06em] text-foreground/80 uppercase">
                    {label}
                  </span>
                  <span className="text-readout text-[8px] text-panel-mut">
                    {bandRange(i, params.multiband.splitsHz)}
                  </span>
                  <span className="text-readout text-[8px] text-panel-mut">
                    AT {band.attackMs.toFixed(2)} · RL {band.releaseMs.toFixed(2)}
                  </span>
                  <span className="text-readout text-[8px] text-signal/80">
                    R{band.ratio.toFixed(2)} · MK {band.makeupDb.toFixed(2)}
                  </span>
                </div>
              );
            })}
          </div>
          <p className="mt-2 text-[10px] leading-4 text-muted-foreground">
            One threshold per band — ratio, timing and makeup ride with the
            loaded preset. Sustained GR over 6 dB on a band means its
            threshold is working too hard.
          </p>
        </ChainBlock>

        <ChainArrow />

        {/* 04 — program AGC */}
        <ChainBlock
          index={4}
          title="AGC"
          subtitle="Program leveller · loudness rider"
          enabled={params.agc.on}
          onToggle={() =>
            setParams((p) => ({ ...p, agc: { ...p.agc, on: !p.agc.on } }))
          }
          right={
            <Seg
              ariaLabel="Loudness rider"
              value={params.rider.on ? "on" : "bypass"}
              options={[
                { value: "on", label: "Rider on" },
                { value: "bypass", label: "Bypass" },
              ]}
              onChange={(v) =>
                setParams((p) => ({ ...p, rider: { ...p.rider, on: v === "on" } }))
              }
            />
          }
        >
          <div className="divide-y divide-border/60 rounded border border-border/60">
            <CtrlRow label="Attack">
              <SliderRow
                min={10}
                max={500}
                step={10}
                value={params.agc.attackMs}
                onChange={(v) =>
                  setParams((p) => ({ ...p, agc: { ...p.agc, attackMs: v } }))
                }
                label="AGC attack"
              />
              <Val>{secs(params.agc.attackMs)}</Val>
            </CtrlRow>
            <CtrlRow label="Release">
              <SliderRow
                min={50}
                max={3000}
                step={50}
                value={params.agc.releaseMs}
                onChange={(v) =>
                  setParams((p) => ({ ...p, agc: { ...p.agc, releaseMs: v } }))
                }
                label="AGC release"
              />
              <Val>{secs(params.agc.releaseMs)}</Val>
            </CtrlRow>
            <CtrlRow label="Target">
              <SliderRow
                min={-32}
                max={-14}
                step={0.5}
                value={params.rider.targetLufs}
                onChange={(v) =>
                  setParams((p) => ({ ...p, rider: { ...p.rider, targetLufs: v } }))
                }
                label="Loudness target"
              />
              <Val>{sgn(params.rider.targetLufs)} LUFS</Val>
            </CtrlRow>
            <CtrlRow label="Max">
              <SliderRow
                min={0}
                max={16}
                step={0.5}
                value={params.rider.maxRideDb}
                onChange={(v) =>
                  setParams((p) => ({ ...p, rider: { ...p.rider, maxRideDb: v } }))
                }
                label="Max ride"
              />
              <Val>
                +{params.rider.maxRideDb.toFixed(2)} / −
                {params.rider.maxRideDb.toFixed(2)} dB
              </Val>
            </CtrlRow>
            <CtrlRow label="Gate">
              <SliderRow
                min={-70}
                max={-40}
                step={0.5}
                value={params.rider.gateDb}
                onChange={(v) =>
                  setParams((p) => ({ ...p, rider: { ...p.rider, gateDb: v } }))
                }
                label="Rider silence gate"
              />
              <Val>{sgn(params.rider.gateDb)} dB</Val>
            </CtrlRow>
            <CtrlRow label="Ride">
              <Seg
                ariaLabel="Rider speed"
                value={params.rider.speed}
                options={[
                  { value: "fast", label: "Fast" },
                  { value: "slow", label: "Slow" },
                ]}
                onChange={(speed) =>
                  setParams((p) => ({
                    ...p,
                    rider: { ...p.rider, speed: speed as "fast" | "slow" },
                  }))
                }
              />
              <Val>{params.rider.on ? `${sgn(snap?.riderDb ?? 0)} dB` : "off"}</Val>
            </CtrlRow>
            <CtrlRow label="Ride bar">
              <div className="panel-well relative h-2 w-32 overflow-hidden rounded-full">
                <span className="absolute inset-y-0 left-1/2 w-px bg-white/20" />
                <span
                  className="absolute inset-y-0 bg-signal transition-all duration-150"
                  style={
                    params.rider.on
                      ? riderDb <= 0
                        ? { left: `${50 + (riderDb / Math.max(params.rider.maxRideDb, 1)) * 50}%`, width: `${Math.min(50, (-riderDb / Math.max(params.rider.maxRideDb, 1)) * 50)}%` }
                        : { left: "50%", width: `${Math.min(50, (riderDb / Math.max(params.rider.maxRideDb, 1)) * 50)}%`, background: "#4cd964" }
                      : { left: "50%", width: "0%" }
                  }
                />
              </div>
              <Val className="min-w-0">
                ±{params.rider.maxRideDb.toFixed(2)} dB
              </Val>
            </CtrlRow>
            <CtrlRow label="GR">
              <GainReductionMeter
                get={() => getEngine().snapshot().gr.agc}
                maxDb={15}
                height={30}
                width={8}
              />
            </CtrlRow>
          </div>
        </ChainBlock>

        <ChainArrow />

        {/* 05 — composite limiter */}
        <ChainBlock
          index={5}
          title="Composite limit"
          subtitle="Pre-delay · clip stage · ceiling guard"
        >
          <div className="divide-y divide-border/60 rounded border border-border/60">
            <CtrlRow label="Pre">
              <SliderRow
                min={10}
                max={2000}
                step={10}
                value={params.limiter.attackMs * 1000}
                onChange={(v) =>
                  setParams((p) => ({
                    ...p,
                    limiter: { ...p.limiter, attackMs: v / 1000 },
                  }))
                }
                label="Composite pre-delay"
              />
              <Val>{preUs.toFixed(2)} µs</Val>
              <Seg
                ariaLabel="Pre-delay standard"
                value={preStandard}
                options={[
                  { value: "uk", label: "UK" },
                  { value: "us", label: "US" },
                ]}
                onChange={(v) =>
                  setParams((p) => ({
                    ...p,
                    limiter: { ...p.limiter, attackMs: v === "uk" ? 1 : 0.5 },
                  }))
                }
              />
            </CtrlRow>
            <CtrlRow label="Comp clip">
              <Seg
                ariaLabel="Composite clip stage"
                value={params.limiter.on ? "on" : "bypass"}
                options={[
                  { value: "on", label: "On" },
                  { value: "bypass", label: "Bypass" },
                ]}
                onChange={(v) =>
                  setParams((p) => ({
                    ...p,
                    limiter: { ...p.limiter, on: v === "on" },
                  }))
                }
              />
              <Val>{params.limiter.on ? "armed" : "bypassed"}</Val>
            </CtrlRow>
            <CtrlRow label="Ceil">
              <SliderRow
                min={-6}
                max={0}
                step={0.1}
                value={params.limiter.ceilingDb}
                onChange={(v) =>
                  setParams((p) => ({
                    ...p,
                    limiter: { ...p.limiter, ceilingDb: v },
                  }))
                }
                label="Ceiling"
              />
              <Val>{ceilingPct} %</Val>
            </CtrlRow>
            <CtrlRow label="Harm">
              <Seg
                ariaLabel="Harmonic exciter"
                value={params.exciter.on ? "on" : "bypass"}
                options={[
                  { value: "on", label: "On" },
                  { value: "bypass", label: "Bypass" },
                ]}
                onChange={(v) =>
                  setParams((p) => ({
                    ...p,
                    exciter: { ...p.exciter, on: v === "on" },
                  }))
                }
              />
              <SliderRow
                className="max-w-20"
                min={0}
                max={12}
                step={0.5}
                value={params.exciter.mix}
                onChange={(v) =>
                  setParams((p) => ({ ...p, exciter: { ...p.exciter, mix: v } }))
                }
                label="Harmonic level"
              />
              <Val>{harmDb(params.exciter.mix)} dB</Val>
            </CtrlRow>
            <CtrlRow label="True pk">
              <Val className={cn(peakOver && "text-meter-hot")}>
                {snap?.powered
                  ? `${truePeak.toFixed(2).replace("-", "−")} dBTP`
                  : "―"}
              </Val>
              <span
                className={cn(
                  "led size-1.5",
                  snap?.powered ? (peakOver ? "led-hot" : "led-on") : undefined,
                )}
                aria-hidden
              />
            </CtrlRow>
            <CtrlRow label="Limit GR">
              <GainReductionMeter
                get={() => getEngine().snapshot().gr.limiter}
                maxDb={18}
                height={30}
                width={8}
              />
            </CtrlRow>
          </div>
          <p className="mt-2 text-[10px] leading-4 text-muted-foreground">
            The fast peak stage does the lifting; a 4×-oversampled per-sample
            soft-clip guard downstream of the output trim makes{" "}
            <span className="text-readout text-foreground/80">
              {formatDb(params.limiter.ceilingDb)}
            </span>{" "}
            a hard promise on the composite bus.
          </p>
        </ChainBlock>

        <ChainArrow />

        {/* 06 — stereo & output */}
        <ChainBlock
          index={6}
          title="Stereo & output"
          subtitle="Width · trim · monitor"
        >
          <div className="flex items-start justify-around gap-2">
            <Knob
              label="Width"
              size={52}
              bipolar
              value={params.stereo.width}
              min={0.5}
              max={2}
              step={0.01}
              format={(v) => `×${v.toFixed(2)}`}
              onChange={(v) => setParams((p) => ({ ...p, stereo: { width: v } }))}
              onReset={() => setParams((p) => ({ ...p, stereo: { width: 1 } }))}
            />
            <Knob
              label="Trim"
              size={52}
              bipolar
              value={params.outputGainDb}
              min={-24}
              max={24}
              step={0.5}
              format={formatDb}
              onChange={(v) => setParams((p) => ({ ...p, outputGainDb: v }))}
              onReset={() => setParams((p) => ({ ...p, outputGainDb: 0 }))}
            />
            <Knob
              label="Monitor"
              size={52}
              value={params.monitorDb}
              min={-60}
              max={0}
              step={0.5}
              format={formatDb}
              onChange={(v) => {
                setParams((p) => ({ ...p, monitorDb: v }));
                if (!monitorMuted) engine.setMonitorDb(v);
              }}
              onReset={() => setParams((p) => ({ ...p, monitorDb: -6 }))}
            />
          </div>

          <div className="mt-3 grid grid-cols-2 gap-2">
            <Button
              size="sm"
              variant={monitorMuted ? "default" : "outline"}
              className="h-8 cursor-pointer text-[10px]"
              onClick={() => {
                const next = !monitorMuted;
                setMonitorMuted(next);
                engine.setMonitorMuted(next);
              }}
            >
              {monitorMuted ? (
                <VolumeX className="size-3.5" />
              ) : (
                <Volume2 className="size-3.5" />
              )}
              {monitorMuted ? "Muted" : "Listen"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-8 cursor-pointer text-[10px]"
              onPointerDown={() => engine.duck()}
            >
              <Zap className="size-3.5" />
              Duck
            </Button>
          </div>

          <div className="panel-well mt-2 rounded px-2.5 py-1.5">
            <p className="text-[8px] font-semibold tracking-[0.12em] text-panel-mut uppercase">
              Correlation
            </p>
            <p className="text-readout mt-0.5 text-[11px] font-medium text-white">
              {(snap?.correlation ?? 1).toFixed(2)}
              <span className="ml-2 text-[9px] text-panel-mut">
                {params.stereo.width > 1.4
                  ? "wide — watch multipath"
                  : params.stereo.width < 0.8
                    ? "collapsing toward mono"
                    : "healthy"}
              </span>
            </p>
          </div>

          <div className="mt-2 flex justify-center">
            <StereoLevelMeter kind="out" height={120} />
          </div>
        </ChainBlock>
      </div>
    </div>
  );
}
