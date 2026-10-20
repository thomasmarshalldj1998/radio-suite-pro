import { EncoderPanel } from "@/components/console/EncoderPanel";
import { BandGrBar, StereoLevelMeter, GainReductionMeter } from "@/components/console/Meters";
import { Fader } from "@/components/console/Fader";
import {
  DigitalCtrl,
  TransferCurve,
  compCurve,
  limitCurve,
} from "@/components/console/DigitalCtrl";
import { densityProfile } from "@/lib/audio/tools";
import { SpectrumCanvas } from "@/components/console/Spectrum";
import { CtrlRow, Seg, Val } from "@/components/console/controls";
import {
  PsyAgc,
  PsyEq,
  PsyLimiter,
  PsyMultiband,
  PsyOutput,
  PsyPreamp,
  PsyStereo,
  PsyStream,
} from "@/components/console/PsyPanels";
import {
  ComplianceSuite,
  LevelingSuite,
  Limiter31Suite,
  PrecisionEqSuite,
  PsychoSuite,
  RestorationSuite,
  SpatialSuite,
} from "@/components/console/AdvancedPanels";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { getEngine, type MeterSnapshot } from "@/lib/audio/engine";
import {
  DEQ_LABELS,
  HPF_DEFAULT_SLOPE,
  HPF_SLOPES,
  HPF_STANDARD_HZ,
  MB_LABELS,
  agcFast,
  eqBandOn,
  formatDb,
  formatHz,
  limiterClipper,
  limiterProgram,
  type AgcFastParams,
  type DeqBands,
  type EqBand,
  type EqBandType,
  type HpfSlope,
  type MultibandBands,
  type MultibandSplits,
  type ProcessorParams,
} from "@/lib/audio/params";
import { cn } from "@/lib/utils";
import { ChevronDown, Volume2, VolumeX, Zap } from "lucide-react";
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

/** Band shape chips for the per-band EQ editor. */
const EQ_BAND_TYPES: { value: EqBandType; label: string }[] = [
  { value: "peaking", label: "Peak" },
  { value: "lowshelf", label: "Lo-sh" },
  { value: "highshelf", label: "Hi-sh" },
  { value: "lowpass", label: "Lo-pass" },
  { value: "highpass", label: "Hi-pass" },
  { value: "notch", label: "Notch" },
];

/** Two-letter badge for the band strip. */
const EQ_TYPE_BADGE: Record<EqBandType, string> = {
  peaking: "PK",
  lowshelf: "LS",
  highshelf: "HS",
  lowpass: "LP",
  highpass: "HP",
  notch: "NO",
};

/** Q travel is logarithmic: 0.4 (broad) → 8.0 (sharp). */
const Q_MIN = 0.4;
const Q_MAX = 8;
const qToPos = (q: number) => Math.log(Math.min(Q_MAX, Math.max(Q_MIN, q)));
const posToQ = (pos: number) => Number(Math.exp(pos).toFixed(3));
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

/**
 * Compact live gain-reduction readout for a chain-block header. Self-
 * subscribes to the engine so only this chip re-renders on meter ticks.
 */
function GrChip({ label, get }: { label: string; get: () => number }) {
  const [db, setDb] = useState(0);
  useEffect(() => {
    let last = 0;
    return getEngine().subscribe(() => {
      const now = performance.now();
      if (now - last < 120) return;
      last = now;
      const v = Math.max(0, get());
      setDb((p) => (Math.abs(p - v) < 0.15 ? p : v));
    });
  }, [get]);
  const active = db >= 0.15;
  return (
    <span
      title={`Live ${label} gain reduction (dB)`}
      className={cn(
        "text-readout hidden shrink-0 rounded border px-1.5 py-0.5 text-[9px] font-semibold tabular-nums sm:inline-flex",
        active
          ? "border-amber-led/40 bg-amber-led/10 text-amber-led"
          : "border-rack-line text-panel-mut",
      )}
    >
      {label} {active ? `−${db.toFixed(1)}` : "0.0"} dB
    </span>
  );
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
  gr,
  children,
}: {
  index: number;
  title: string;
  subtitle?: string;
  enabled?: boolean;
  onToggle?: () => void;
  right?: ReactNode;
  wide?: boolean;
  /** Live gain-reduction readout shown in the header (self-subscribing). */
  gr?: { label: string; get: () => number };
  children: ReactNode;
}) {
  const bypassed = enabled === false;
  // Open on desktop; collapsed on phones so the chain states read at a glance.
  const [open, setOpen] = useState(
    () => typeof window === "undefined" || window.innerWidth >= 768,
  );
  return (
    <section
      className={cn(
        "card-layer flex min-w-[min(300px,100%)] flex-1 flex-col rounded-xl border bg-card transition-colors",
        bypassed ? "border-border/50" : "border-border/70",
        wide && "min-w-[min(460px,100%)]",
      )}
    >
      <header
        className={cn(
          // phones: the stage title owns the first row and the bypass/GR/
          // switch cluster wraps underneath; ≥sm returns to one inline strip
          "flex flex-wrap items-center gap-2.5 border-b px-3 py-2.5 transition-colors",
          bypassed ? "border-border/40 bg-muted/30" : "border-border/60",
        )}
      >
        <div className="flex w-full min-w-0 items-center gap-2.5 sm:w-auto sm:flex-1">
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
        </div>
        {bypassed && (
          <span className="rounded border border-amber-led/40 bg-amber-led/10 px-1.5 py-0.5 text-[8px] font-bold tracking-[0.14em] text-amber-led uppercase">
            Bypass
          </span>
        )}
        {gr && <GrChip label={gr.label} get={gr.get} />}
        {right}
        {enabled !== undefined && onToggle && (
          <Switch
            checked={enabled}
            onCheckedChange={onToggle}
            aria-label={`${enabled ? "Bypass" : "Enable"} ${title}`}
            className="cursor-pointer"
          />
        )}
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-label={`${open ? "Collapse" : "Expand"} ${title}`}
          className="flex size-9 shrink-0 cursor-pointer items-center justify-center rounded border border-rack-line text-panel-mut transition-colors hover:border-signal/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-signal/60 focus-visible:outline-none"
        >
          <ChevronDown
            className={cn(
              "size-3.5 transition-transform duration-200",
              !open && "-rotate-90",
            )}
          />
        </button>
      </header>
      <div
        className={cn(
          "flex-1 p-3 transition-opacity",
          bypassed && "opacity-55",
          !open && "hidden",
        )}
      >
        {children}
      </div>
    </section>
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

/** DSP console section (sub-navigation tab). */
export type DspSection =
  | "preamp"
  | "agc"
  | "eq"
  | "stereo"
  | "multiband"
  | "limiter"
  | "output"
  | "stream";

/** Tab groups mirror the signal path: shape → squeeze → deliver. */
const DSP_SECTION_GROUPS: { id: DspSection; label: string }[][] = [
  [
    { id: "preamp", label: "Preamp" },
    { id: "agc", label: "AGC" },
    { id: "eq", label: "EQ" },
    { id: "stereo", label: "Stereo" },
  ],
  [
    { id: "multiband", label: "Multiband" },
    { id: "limiter", label: "Limiter" },
    { id: "output", label: "Output" },
  ],
  [{ id: "stream", label: "Stream TX" }],
];

/**
 * PROCESSING — the DSP console: one sub-navigation section renders at a
 * time in signal order (Preamp → AGC → EQ → Stereo → Multiband → Limiter
 * → Output → Stream TX), each a set of numbered stage cards with its own
 * bypass LED. The multiband stage uses one threshold fader + live GR bar
 * per band.
 */
export function ProcessingTab({
  params,
  setParams,
  compare,
  setCompare,
  match,
  section,
  onSectionChange,
}: {
  params: ProcessorParams;
  setParams: React.Dispatch<React.SetStateAction<ProcessorParams>>;
  /** A/B: true = monitoring the unprocessed source (chain bypassed). */
  compare: boolean;
  setCompare: (v: boolean) => void;
  /**
   * Reference match: live level-matched A/B readout (original / processed /
   * applied trim), or a silent flag while the source meters nothing.
   */
  match: { orig: number; proc: number; trim: number; silent: boolean } | null;
  /** Active DSP section — controlled by the console shell (deep-linkable). */
  section: DspSection;
  onSectionChange: (s: DspSection) => void;
}) {
  const engine = getEngine();
  const snap = useMeterSnapshot();
  const [monitorMuted, setMonitorMuted] = useState(false);
  const [outputs, setOutputs] = useState(engine.outputDevices);
  const [outputId, setOutputId] = useState(engine.outputDeviceId);
  useEffect(
    () =>
      engine.subscribe(() => {
        setOutputs((p) => (p === engine.outputDevices ? p : engine.outputDevices));
        setOutputId((p) => (p === engine.outputDeviceId ? p : engine.outputDeviceId));
      }),
    [engine],
  );

  /** Band selected for the detail editor under the fader strip. */
  const [eqBand, setEqBand] = useState(0);

  const eqFlat = () =>
    setParams((prev) => ({
      ...prev,
      eq: { ...prev.eq, bands: prev.eq.bands.map((b) => ({ ...b, gainDb: 0 })) },
    }));

  const patchEqBand = (index: number, patch: Partial<EqBand>) =>
    setParams((prev) => ({
      ...prev,
      eq: {
        ...prev.eq,
        bands: prev.eq.bands.map((b, j) =>
          j === index ? { ...b, ...patch } : b,
        ),
      },
    }));

  const fast = agcFast(params.agc);
  const patchFast = (patch: Partial<AgcFastParams>) =>
    setParams((p) => ({
      ...p,
      agc: { ...p.agc, fast: { ...agcFast(p.agc), ...patch } },
    }));
  const clip = limiterClipper(params.limiter);
  const patchClipper = (patch: Partial<typeof clip>) =>
    setParams((p) => ({
      ...p,
      limiter: { ...p.limiter, clipper: { ...limiterClipper(p.limiter), ...patch } },
    }));
  const prog = limiterProgram(params.limiter);
  const patchProgram = (patch: Partial<typeof prog>) =>
    setParams((p) => ({
      ...p,
      limiter: {
        ...p.limiter,
        program: { ...limiterProgram(p.limiter), ...patch },
      },
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
      {/* ── DSP sub-navigation ── */}
      <div className="panel flex flex-wrap items-center gap-2 rounded-lg px-2 py-1.5">
        <div
          role="tablist"
          aria-label="DSP sections"
          className="scrollbar-slim flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
        >
          {DSP_SECTION_GROUPS.map((group, gi) => (
            <span key={gi} className="flex shrink-0 items-center gap-1">
              {gi > 0 && (
                <span
                  aria-hidden
                  className="mx-1.5 h-5 w-px shrink-0 bg-rack-line"
                />
              )}
              {group.map((t) => {
                const active = section === t.id;
                return (
                  <button
                    key={t.id}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => onSectionChange(t.id)}
                    className={cn(
                      "shrink-0 cursor-pointer rounded-md px-3 py-2 text-[11px] tracking-[0.12em] uppercase transition-colors",
                      active
                        ? "bg-signal/15 font-extrabold text-signal shadow-[inset_0_-2px_0_0_var(--color-signal)]"
                        : "font-semibold text-rack-mut hover:bg-white/5 hover:text-rack-fg",
                    )}
                  >
                    {t.label}
                  </button>
                );
              })}
            </span>
          ))}
        </div>
        <span className="ml-auto flex items-center gap-2 pl-3">
          {compare && (
            <span className="rounded border border-amber-led/45 bg-amber-led/10 px-2 py-1 text-[8px] font-bold tracking-[0.16em] text-amber-led uppercase">
              {match?.silent
                ? "Source · silent — match held"
                : "Source · chain bypassed · guard armed"}
            </span>
          )}
          {compare && match && !match.silent && (
            <span
              className="rounded border border-emerald-400/40 bg-emerald-400/10 px-2 py-1 text-[8px] font-bold tracking-[0.16em] text-emerald-300 uppercase"
              title={`Bypassed source trimmed ${match.trim >= 0 ? "+" : ""}${match.trim.toFixed(1)} dB to the processed loudness — the A/B compares tone, not level`}>
              Matched {match.trim >= 0 ? "+" : ""}
              {match.trim.toFixed(1)} dB · SRC {match.orig.toFixed(1)} / PROC{" "}
              {match.proc.toFixed(1)} LUFS
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

      {/* ── composite response analyzer (EQ section) ── */}
      {section === "eq" && (
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
              <span className="inline-block h-0.5 w-4 rounded bg-[#2fb5b5]" />
              EQ response
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-2.5 w-0 border-l border-dashed border-[#2fb5b5]" />
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
      )}

      {/* ── the chain (one DSP section renders at a time) ── */}
      <div className="flex flex-wrap items-stretch gap-3">
        {section === "preamp" && (
          <>
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
                step={1}
                value={params.hpf.freqHz}
                onChange={(v) =>
                  setParams((p) => ({ ...p, hpf: { ...p.hpf, freqHz: v } }))
                }
                label="HPF frequency"
              />
              <Val>{formatHz(params.hpf.freqHz)}</Val>
            </CtrlRow>
            <CtrlRow label="Slope">
              <Seg
                ariaLabel="High-pass steepness"
                value={String(params.hpf.slope ?? HPF_DEFAULT_SLOPE)}
                options={HPF_SLOPES.map((s) => ({
                  value: String(s),
                  label: `${s} dB`,
                }))}
                onChange={(v) =>
                  setParams((p) => ({
                    ...p,
                    hpf: { ...p.hpf, slope: Number(v) as HpfSlope },
                  }))
                }
              />
              <Val>{params.hpf.on ? "butterworth" : "bypassed"}</Val>
            </CtrlRow>
            <CtrlRow label="Std points">
              {HPF_STANDARD_HZ.map((hz) => {
                const active = params.hpf.freqHz === hz;
                return (
                  <button
                    key={hz}
                    type="button"
                    onClick={() =>
                      setParams((p) => ({
                        ...p,
                        hpf: { ...p.hpf, freqHz: hz, on: true },
                      }))
                    }
                    aria-pressed={active}
                    title={`Set the high-pass to the ${hz} Hz broadcast point`}
                    className={cn(
                      "cursor-pointer rounded border px-2 py-1 text-[9px] font-semibold tracking-[0.08em] uppercase transition-colors",
                      active
                        ? "border-signal/60 bg-signal/15 text-signal"
                        : "border-border/70 text-muted-foreground hover:bg-accent hover:text-foreground",
                    )}
                  >
                    {hz}
                  </button>
                );
              })}
            </CtrlRow>
            <CtrlRow label="Phase rot">
              <Seg
                ariaLabel="Phase rotator — 4-stage allpass cascade"
                value={!params.phase.on ? "bypass" : params.phase.mode}
                options={[
                  { value: "auto", label: "Auto" },
                  { value: "manual", label: "Manual" },
                  { value: "bypass", label: "Bypass" },
                ]}
                onChange={(v) =>
                  setParams((p) => ({
                    ...p,
                    phase:
                      v === "bypass"
                        ? { ...p.phase, on: false }
                        : { ...p.phase, on: true, mode: v as "auto" | "manual" },
                  }))
                }
              />
              <Val>
                {!params.phase.on
                  ? "bypassed"
                  : params.phase.mode === "auto"
                    ? "300 Hz · 4 stages"
                    : `${formatHz(params.phase.freqHz)} · 4 stages`}
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
          <TransferCurve
            title="Gate transfer"
            subtitle={`Opens at ${sgn(params.gate.thresholdDb)} dB · dot ≈ live input`}
            curve={(x) =>
              !params.gate.on || x >= params.gate.thresholdDb ? x : -60
            }
            inputDb={
              snap ? Math.max(snap.inPeakL, snap.inPeakR) : Number.NaN
            }
            grDb={0}
            live={snap?.powered ?? false}
          />
        </ChainBlock>
          </>
        )}
        {section === "eq" && (
          <>
        {/* 01 — equalizer */}
        <ChainBlock
          index={1}
          title="Equalizer"
          subtitle="6-band parametric · per-band shape & bypass"
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
            {params.eq.bands.map((band, i) => {
              const bandOn = eqBandOn(band);
              const selected = eqBand === i;
              return (
                <div
                  key={i}
                  className={cn(
                    "flex w-10 shrink-0 flex-col items-center rounded pt-1 transition-opacity",
                    !bandOn && "opacity-45",
                  )}
                >
                  <Fader
                    label={formatHz(band.freq)}
                    value={band.gainDb}
                    min={-15}
                    max={15}
                    step={0.5}
                    height={112}
                    accent={bandOn && Math.abs(band.gainDb) > 0.05}
                    format={(v) => `${v > 0 ? "+" : ""}${v.toFixed(2)}`}
                    onChange={(v) => patchEqBand(i, { gainDb: v })}
                  />
                  <button
                    type="button"
                    onClick={() => setEqBand(i)}
                    aria-pressed={selected}
                    title={`Band ${i + 1} — ${band.type} · Q ${band.q.toFixed(2)}${bandOn ? "" : " · bypassed"}`}
                    className={cn(
                      "w-full cursor-pointer rounded px-0.5 py-0.5 text-[8px] leading-3 font-semibold tracking-wider uppercase transition-colors",
                      selected
                        ? "bg-signal/15 text-signal"
                        : "text-panel-mut hover:bg-white/5 hover:text-foreground",
                    )}
                  >
                    {EQ_TYPE_BADGE[band.type]}
                    <br />Q{band.q.toFixed(2)}
                  </button>
                </div>
              );
            })}
          </div>

          {/* per-band editor — the strip above sets level, this sets shape */}
          <div className="mt-2 divide-y divide-border/60 rounded border border-border/60">
            <CtrlRow label={`Band ${eqBand + 1} shape`}>
              <Seg
                ariaLabel={`Band ${eqBand + 1} in circuit`}
                value={eqBandOn(params.eq.bands[eqBand]) ? "on" : "bypass"}
                options={[
                  { value: "on", label: "On" },
                  { value: "bypass", label: "Bypass" },
                ]}
                onChange={(v) => patchEqBand(eqBand, { on: v === "on" })}
              />
              <Seg
                ariaLabel={`Band ${eqBand + 1} filter type`}
                value={params.eq.bands[eqBand].type}
                options={EQ_BAND_TYPES.map((t) => ({
                  value: t.value,
                  label: t.label,
                }))}
                onChange={(v) =>
                  patchEqBand(eqBand, { type: v as EqBandType })
                }
              />
            </CtrlRow>
            <CtrlRow label="Frequency">
              <SliderRow
                min={20}
                max={20000}
                step={1}
                value={params.eq.bands[eqBand].freq}
                onChange={(v) => patchEqBand(eqBand, { freq: v })}
                label={`Band ${eqBand + 1} frequency`}
              />
              <Val>{formatHz(params.eq.bands[eqBand].freq)}</Val>
            </CtrlRow>
            <CtrlRow label="Q">
              <SliderRow
                min={qToPos(Q_MIN)}
                max={qToPos(Q_MAX)}
                step={0.01}
                value={qToPos(params.eq.bands[eqBand].q)}
                onChange={(v) => patchEqBand(eqBand, { q: posToQ(v) })}
                label={`Band ${eqBand + 1} Q`}
              />
              <Val>Q {params.eq.bands[eqBand].q.toFixed(2)}</Val>
            </CtrlRow>
            <CtrlRow label="Gain">
              <SliderRow
                min={-15}
                max={15}
                step={0.5}
                value={params.eq.bands[eqBand].gainDb}
                onChange={(v) => patchEqBand(eqBand, { gainDb: v })}
                label={`Band ${eqBand + 1} gain`}
              />
              <Val>
                {params.eq.bands[eqBand].type === "lowpass" ||
                params.eq.bands[eqBand].type === "highpass" ||
                params.eq.bands[eqBand].type === "notch"
                  ? "n/a"
                  : formatDb(params.eq.bands[eqBand].gainDb)}
              </Val>
            </CtrlRow>
          </div>
          <p className="mt-2 text-[10px] leading-4 text-muted-foreground">
            Every band can be a peak, shelf, low/high-pass or notch. Gain is
            inert for the pass/notch shapes — they cut by frequency, not level.
            Q runs 0.4 (broad) to 8.0 (sharp); 1.4–3.0 is the broadcast vocal
            sweet spot.
          </p>
        </ChainBlock>

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
          </>
        )}
        {section === "agc" && (
          <>
        {/* 03 — program AGC (pre-multiband leveller) */}
        <ChainBlock
          index={3}
          title="AGC"
          subtitle="Dual window · fast peak + slow leveller · rider"
          gr={{ label: "AGC", get: () => getEngine().snapshot().gr.agc }}
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
            <CtrlRow label="Fast peak">
              <Seg
                ariaLabel="Fast peak window"
                value={fast.on ? "on" : "bypass"}
                options={[
                  { value: "on", label: "On" },
                  { value: "bypass", label: "Bypass" },
                ]}
                onChange={(v) => patchFast({ on: v === "on" })}
              />
              <GainReductionMeter
                get={() => getEngine().snapshot().gr.agcFast}
                maxDb={9}
                height={22}
                width={6}
              />
              <Val>{fast.on ? `peak ${formatDb(fast.thresholdDb)}` : "bypassed"}</Val>
            </CtrlRow>
            <CtrlRow label="Fast thr">
              <SliderRow
                min={-40}
                max={0}
                step={0.5}
                value={fast.thresholdDb}
                onChange={(v) => patchFast({ thresholdDb: v })}
                label="Fast peak threshold"
              />
              <Val>{formatDb(fast.thresholdDb)}</Val>
            </CtrlRow>
            <CtrlRow label="Fast ratio">
              <SliderRow
                min={1}
                max={20}
                step={0.5}
                value={fast.ratio}
                onChange={(v) => patchFast({ ratio: v })}
                label="Fast peak ratio"
              />
              <Val>{fast.ratio.toFixed(1)}:1</Val>
            </CtrlRow>
            <CtrlRow label="Fast atk">
              <SliderRow
                min={0.5}
                max={50}
                step={0.5}
                value={fast.attackMs}
                onChange={(v) => patchFast({ attackMs: v })}
                label="Fast peak attack"
              />
              <Val>{fast.attackMs.toFixed(1)} ms</Val>
            </CtrlRow>
            <CtrlRow label="Fast rel">
              <SliderRow
                min={20}
                max={1500}
                step={10}
                value={fast.releaseMs}
                onChange={(v) => patchFast({ releaseMs: v })}
                label="Fast peak release"
              />
              <Val>{secs(fast.releaseMs)}</Val>
            </CtrlRow>
            <CtrlRow label="Lev thr">
              <SliderRow
                min={-40}
                max={0}
                step={0.5}
                value={params.agc.thresholdDb}
                onChange={(v) =>
                  setParams((p) => ({ ...p, agc: { ...p.agc, thresholdDb: v } }))
                }
                label="Leveller threshold"
              />
              <Val>{formatDb(params.agc.thresholdDb)}</Val>
            </CtrlRow>
            <CtrlRow label="Lev ratio">
              <SliderRow
                min={1}
                max={20}
                step={0.5}
                value={params.agc.ratio}
                onChange={(v) =>
                  setParams((p) => ({ ...p, agc: { ...p.agc, ratio: v } }))
                }
                label="Leveller ratio"
              />
              <Val>{params.agc.ratio.toFixed(1)}:1</Val>
            </CtrlRow>
            <CtrlRow label="Slow atk">
              <SliderRow
                min={30}
                max={800}
                step={10}
                value={params.agc.attackMs}
                onChange={(v) =>
                  setParams((p) => ({ ...p, agc: { ...p.agc, attackMs: v } }))
                }
                label="AGC attack"
              />
              <Val>{secs(params.agc.attackMs)}</Val>
            </CtrlRow>
            <CtrlRow label="Slow rel">
              <SliderRow
                min={100}
                max={15000}
                step={100}
                value={params.agc.releaseMs}
                onChange={(v) =>
                  setParams((p) => ({ ...p, agc: { ...p.agc, releaseMs: v } }))
                }
                label="AGC release"
              />
              <Val>{secs(params.agc.releaseMs)}</Val>
            </CtrlRow>
            <CtrlRow label="Window">
              <SliderRow
                min={0}
                max={9}
                step={0.5}
                value={params.agc.windowDb}
                onChange={(v) =>
                  setParams((p) => ({ ...p, agc: { ...p.agc, windowDb: v } }))
                }
                label="AGC window gate"
              />
              <Val>
                {params.agc.windowDb > 0
                  ? `±${(params.agc.windowDb / 2).toFixed(1)} dB`
                  : "off"}
              </Val>
              {snap?.powered && snap.agcWindow.frozen && (
                <span className="rounded border border-signal/40 bg-signal/10 px-1.5 py-0.5 text-[9px] font-bold tracking-[0.1em] text-signal uppercase">
                  Hold
                </span>
              )}
            </CtrlRow>
            <CtrlRow label="Target">
              <Seg
                ariaLabel="Streaming loudness standard"
                value={[-14, -16, -23].includes(params.rider.targetLufs) ? String(params.rider.targetLufs) : "custom"}
                options={[
                  { value: "-14", label: "−14 AES71" },
                  { value: "-16", label: "−16" },
                  { value: "-23", label: "−23 R128" },
                  { value: "custom", label: "Custom" },
                ]}
                onChange={(v) => {
                  if (v === "custom") return;
                  const t = Number(v);
                  setParams((p) => ({ ...p, rider: { ...p.rider, targetLufs: t } }));
                }}
              />
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
            <CtrlRow label="Speech">
              <Seg
                ariaLabel="Auto-speech sensing"
                value={params.agc.speechSense ? "on" : "bypass"}
                options={[
                  { value: "on", label: "On" },
                  { value: "bypass", label: "Bypass" },
                ]}
                onChange={(v) =>
                  setParams((p) => ({
                    ...p,
                    agc: { ...p.agc, speechSense: v === "on" },
                  }))
                }
              />
              <span className="text-[10px] text-muted-foreground">
                {snap?.speechFast
                  ? "Mic speech — fast envelopes"
                  : "Mic programme halves AGC/MB timing"}
              </span>
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
          <TransferCurve
            title="AGC transfer"
            subtitle="Exact curve from threshold/ratio/knee · dot ≈ live"
            curve={compCurve(
              params.agc.thresholdDb,
              params.agc.ratio,
              params.agc.kneeDb,
            )}
            inputDb={
              snap ? Math.max(snap.inPeakL, snap.inPeakR) : Number.NaN
            }
            grDb={snap?.gr.agc ?? 0}
            live={snap?.powered ?? false}
          />
          <p className="mt-2 text-[10px] leading-4 text-muted-foreground">
            Two windows: the fast peak stage (short release) catches
            transients above its own threshold, then the slow leveller rides
            the programme toward the target. Because both thresholds are
            independent, turning the fast window up never changes the
            long-term level the leveller settles on.
          </p>
        </ChainBlock>
          </>
        )}
        {section === "multiband" && (
          <>
        {/* 04 — multiband compressor (driven by the leveled AGC output) */}
        <ChainBlock
          index={4}
          title="Multiband"
          subtitle="6-band · LR4 crossovers · per-band threshold"
          wide
          gr={{
            label: "MB",
            get: () => Math.max(0, ...getEngine().snapshot().gr.bands),
          }}
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
          </>
        )}
        {section === "limiter" && (
          <>
        {/* 05 — de-esser, ahead of the limiter */}
        <ChainBlock
          index={5}
          title="De-esser"
          subtitle="Dynamic sibilance control · 5–10 kHz"
          enabled={params.deess.on}
          onToggle={() =>
            setParams((p) => ({
              ...p,
              deess: { ...p.deess, on: !p.deess.on },
            }))
          }
          gr={{ label: "DE-ESS", get: () => getEngine().snapshot().deessCut }}
          right={
            <span className="text-readout text-[10px] text-panel-mut">
              {formatHz(params.deess.freqHz)}
            </span>
          }
        >
          <div className="divide-y divide-border/60 rounded border border-border/60">
            <CtrlRow label="Tune">
              <SliderRow
                min={5000}
                max={10000}
                step={250}
                value={params.deess.freqHz}
                onChange={(v) =>
                  setParams((p) => ({ ...p, deess: { ...p.deess, freqHz: v } }))
                }
                label="De-esser frequency"
              />
              <Val>{formatHz(params.deess.freqHz)}</Val>
            </CtrlRow>
            <CtrlRow label="Depth">
              <SliderRow
                min={0}
                max={12}
                step={0.5}
                value={params.deess.maxCutDb}
                onChange={(v) =>
                  setParams((p) => ({ ...p, deess: { ...p.deess, maxCutDb: v } }))
                }
                label="Maximum de-esser cut"
              />
              <Val>−{params.deess.maxCutDb.toFixed(1)} dB</Val>
            </CtrlRow>
            <CtrlRow label="Thr">
              <SliderRow
                min={-40}
                max={-6}
                step={1}
                value={params.deess.thresholdDb}
                onChange={(v) =>
                  setParams((p) => ({
                    ...p,
                    deess: { ...p.deess, thresholdDb: v },
                  }))
                }
                label="De-esser threshold"
              />
              <Val>{formatDb(params.deess.thresholdDb, 0)}</Val>
            </CtrlRow>
            <CtrlRow label="Release">
              <SliderRow
                min={20}
                max={200}
                step={10}
                value={params.deess.releaseMs}
                onChange={(v) =>
                  setParams((p) => ({
                    ...p,
                    deess: { ...p.deess, releaseMs: v },
                  }))
                }
                label="De-esser release"
              />
              <Val>{params.deess.releaseMs.toFixed(0)} ms</Val>
            </CtrlRow>
            <CtrlRow label="Cut">
              <Val className={cn((snap?.deessCut ?? 0) > 0.1 && "text-signal")}>
                {snap?.powered ? `−${(snap.deessCut ?? 0).toFixed(1)} dB` : "―"}
              </Val>
            </CtrlRow>
          </div>
          <p className="mt-2 text-[10px] leading-4 text-muted-foreground">
            A fast band detector cuts only the sibilance band, and it sits
            ahead of the limiter so the final stage is never asked to absorb
            esses it should not have seen.
          </p>
        </ChainBlock>

        {/* 06 — composite limiter */}
        <ChainBlock
          index={6}
          title="Composite limit"
          subtitle="Pre-delay · clip stage · ceiling guard"
          enabled={params.limiter.on}
          onToggle={() =>
            setParams((p) => ({
              ...p,
              limiter: { ...p.limiter, on: !p.limiter.on },
            }))
          }
          gr={{ label: "LIM", get: () => getEngine().snapshot().gr.limiter }}
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
            <CtrlRow label="Clipper">
              <Seg
                ariaLabel="Soft clipper ahead of the limiter"
                value={clip.on ? "on" : "bypass"}
                options={[
                  { value: "on", label: "On" },
                  { value: "bypass", label: "Bypass" },
                ]}
                onChange={(v) => patchClipper({ on: v === "on" })}
              />
              <SliderRow
                min={-6}
                max={0}
                step={0.1}
                value={clip.thresholdDb}
                onChange={(v) => patchClipper({ thresholdDb: v })}
                label="Clipper threshold"
              />
              <Val>{formatDb(clip.thresholdDb)}</Val>
            </CtrlRow>
            <CtrlRow label="Clip mix">
              <SliderRow
                min={0}
                max={100}
                step={5}
                value={clip.mix}
                onChange={(v) => patchClipper({ mix: v })}
                label="Clipper mix"
              />
              <Val>{clip.mix.toFixed(0)} %</Val>
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
            <CtrlRow label="Program">
              <Seg
                ariaLabel="Program limiter stage"
                value={prog.on ? "on" : "bypass"}
                options={[
                  { value: "on", label: "On" },
                  { value: "bypass", label: "Bypass" },
                ]}
                onChange={(v) => patchProgram({ on: v === "on" })}
              />
              <SliderRow
                min={-4}
                max={0}
                step={0.1}
                value={prog.ceilingDb}
                onChange={(v) => patchProgram({ ceilingDb: v })}
                label="Program limiter ceiling"
              />
              <Val>{formatDb(prog.ceilingDb)}</Val>
              <SliderRow
                min={60}
                max={800}
                step={20}
                value={prog.releaseMs}
                onChange={(v) => patchProgram({ releaseMs: v })}
                label="Program limiter release"
              />
              <Val>{prog.releaseMs.toFixed(0)} ms</Val>
            </CtrlRow>
            <CtrlRow label="Adaptive">
              <Seg
                ariaLabel="Adaptive limiter release"
                value={params.limiter.adaptive ? "on" : "off"}
                options={[
                  { value: "on", label: "On" },
                  { value: "off", label: "Fixed" },
                ]}
                onChange={(v) =>
                  setParams((p) => ({
                    ...p,
                    limiter: { ...p.limiter, adaptive: v === "on" },
                  }))
                }
              />
              <span className="text-[9px] font-semibold tracking-[0.1em] text-muted-foreground uppercase">
                Hold
              </span>
              <SliderRow
                min={0}
                max={200}
                step={10}
                value={params.limiter.holdMs ?? 0}
                onChange={(v) =>
                  setParams((p) => ({
                    ...p,
                    limiter: { ...p.limiter, holdMs: v },
                  }))
                }
                label="Limiter hold"
              />
              <Val>{(params.limiter.holdMs ?? 0).toFixed(0)} ms</Val>
            </CtrlRow>
            <CtrlRow label="True-pk os">
              <Seg
                ariaLabel="True-peak oversampling"
                value={String(params.limiter.truePeakX ?? 4)}
                options={[
                  { value: "2", label: "2×" },
                  { value: "4", label: "4×" },
                  { value: "8", label: "8×" },
                ]}
                onChange={(v) =>
                  setParams((p) => ({
                    ...p,
                    limiter: {
                      ...p.limiter,
                      truePeakX: Number(v) as 2 | 4 | 8,
                    },
                  }))
                }
              />
              <span className="text-[10px] text-muted-foreground">
                8× resolves the crests a lossy encoder rebuilds
              </span>
            </CtrlRow>
            <CtrlRow label="Engine">
              <Seg
                ariaLabel="Peak limiter engine"
                value={params.limiter.engine === "native" ? "native" : "worklet"}
                options={[
                  { value: "worklet", label: "Worklet" },
                  { value: "native", label: "Native" },
                ]}
                onChange={(v) =>
                  setParams((p) => ({
                    ...p,
                    limiter: {
                      ...p.limiter,
                      engine: v === "native" ? "native" : "worklet",
                    },
                  }))
                }
              />
              <span className="text-[10px] text-muted-foreground">
                {params.limiter.engine === "native"
                  ? "Browser compressor · no added latency"
                  : snap?.powered && snap.limiterEngine === "native"
                    ? "Worklet unavailable · running native"
                    : "Lookahead brickwall · audio thread"}
              </span>
              <span
                className={cn(
                  "led size-1.5",
                  snap?.powered
                    ? snap.limiterEngine === "worklet"
                      ? "led-on"
                      : "led-warn"
                    : undefined,
                )}
                aria-hidden
              />
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
          <TransferCurve
            title="Limiter transfer"
            subtitle={`Drive ${params.limiter.on ? `+${densityProfile(params.density).driveDb.toFixed(2)}` : "+0.00"} dB into ceiling · dot ≈ live`}
            curve={limitCurve(
              params.limiter.on
                ? densityProfile(params.density).driveDb
                : 0,
              params.limiter.ceilingDb,
            )}
            inputDb={
              snap
                ? Math.max(snap.outPeakL, snap.outPeakR) +
                  (snap.gr.limiter ?? 0)
                : Number.NaN
            }
            grDb={snap?.gr.limiter ?? 0}
            live={snap?.powered ?? false}
          />
          <p className="mt-2 text-[10px] leading-4 text-muted-foreground">
            The soft clipper shaves transients before the peak limiter so the
            limiter itself moves less; a 4×-oversampled per-sample soft-clip
            guard downstream of the output trim makes{" "}
            <span className="text-readout text-foreground/80">
              {formatDb(params.limiter.ceilingDb)}
            </span>{" "}
            a hard promise on the composite bus.
          </p>
        </ChainBlock>
          </>
        )}
        {section === "stereo" && (
          <>
        {/* 06 — density & enhancement */}
        <ChainBlock
          index={7}
          title="Density & enhancement"
          subtitle="Harmonic exciter · mix"
          enabled={params.exciter.on}
          onToggle={() =>
            setParams((p) => ({
              ...p,
              exciter: { ...p.exciter, on: !p.exciter.on },
            }))
          }
        >
          <div className="divide-y divide-border/60 rounded border border-border/60">
            <CtrlRow label="Exciter">
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
              <Val>{params.exciter.on ? "armed" : "bypassed"}</Val>
            </CtrlRow>
            <CtrlRow label="Mix">
              <SliderRow
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
          </div>
          <p className="mt-2 text-[10px] leading-4 text-muted-foreground">
            The exciter regenerates controlled harmonic density for the top
            octave. Mix is the engine blend, shown here as its insert level —
            bypass returns a clean, uncoloured high end.
          </p>
        </ChainBlock>

        {/* 07 — stereo image */}
        <ChainBlock
          index={8}
          title="Stereo image"
          subtitle="Width · correlation"
        >
          <div className="flex items-start justify-around gap-2">
            <DigitalCtrl
              label="Width"
              bipolar
              value={params.stereo.width}
              min={0.5}
              max={2}
              step={0.01}
              format={(v) => `×${v.toFixed(2)}`}
              onChange={(v) =>
                setParams((p) => ({ ...p, stereo: { ...p.stereo, width: v } }))
              }
              onReset={() =>
                setParams((p) => ({ ...p, stereo: { ...p.stereo, width: 1 } }))
              }
            />
          </div>

          <div className="panel-well mt-2 rounded px-2.5 py-1.5">
            <p className="text-[8px] font-semibold tracking-[0.12em] text-panel-mut uppercase">
              Correlation · L/R balance
            </p>
            <p className="text-readout mt-0.5 text-[11px] font-medium text-white">
              {(snap?.correlation ?? 1).toFixed(2)}
              <span className="ml-2 text-[9px] text-panel-mut">
                L {snap == null || snap.outPeakL <= -99 ? "−∞" : snap.outPeakL.toFixed(1)} · R{" "}
                {snap == null || snap.outPeakR <= -99 ? "−∞" : snap.outPeakR.toFixed(1)}
              </span>
            </p>
            <p className="mt-1 flex items-center gap-1.5 text-[9px]">
              <span
                className={cn(
                  "rounded border px-1.5 py-0.5 text-[8px] font-bold tracking-[0.1em] uppercase",
                  (snap?.correlation ?? 1) < 0
                    ? "border-meter-hot/50 bg-meter-hot/10 text-meter-hot"
                    : (snap?.correlation ?? 1) < 0.5
                      ? "border-meter-warn/50 bg-meter-warn/10 text-meter-warn"
                      : "border-meter-ok/40 bg-meter-ok/10 text-meter-ok",
                )}
              >
                {(snap?.correlation ?? 1) < 0
                  ? "Phase risk"
                  : (snap?.correlation ?? 1) < 0.5
                    ? "Wide"
                    : "Mono safe"}
              </span>
              <span className="text-panel-mut">
                {params.stereo.width > 1.4
                  ? "wide — watch multipath"
                  : params.stereo.width < 0.8
                    ? "collapsing toward mono"
                    : "measured on the output bus"}
              </span>
            </p>
          </div>

          <div className="mt-2 divide-y divide-border/60 rounded-lg border border-border/60 bg-card">
            <CtrlRow label="Low-end mono">
              <Slider
                className="w-28"
                min={0}
                max={300}
                step={5}
                value={[params.stereo.lowMonoHz]}
                onValueChange={(v) =>
                  setParams((p) => ({
                    ...p,
                    stereo: { ...p.stereo, lowMonoHz: v[0] },
                  }))
                }
                aria-label="Low-end mono crossover"
              />
              <Val>
                {params.stereo.lowMonoHz > 0
                  ? `${params.stereo.lowMonoHz} Hz`
                  : "Off"}
              </Val>
            </CtrlRow>
          </div>
          <p className="mt-1.5 text-[10px] leading-4 text-muted-foreground">
            Bass below the crossover folds to mono — centred subs for FM,
            clubs and phones. 0 Hz disables.
          </p>
        </ChainBlock>
          </>
        )}
        {section === "output" && (
          <>
        {/* 08 — output & monitor */}
        <ChainBlock
          index={9}
          title="Output & monitor"
          subtitle="Trim · monitor · out meter"
        >
          <div className="flex items-start justify-around gap-2">
            <DigitalCtrl
              label="Trim"
              bipolar
              value={params.outputGainDb}
              min={-24}
              max={24}
              step={0.5}
              format={formatDb}
              onChange={(v) => setParams((p) => ({ ...p, outputGainDb: v }))}
              onReset={() => setParams((p) => ({ ...p, outputGainDb: 0 }))}
            />
            <DigitalCtrl
              label="Monitor"
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

          <select
            className="mt-2 h-8 w-full cursor-pointer truncate rounded border border-border/60 bg-card px-1.5 text-[11px] text-foreground"
            value={outputId}
            aria-label="Monitor output device"
            title="Monitor output — which speakers or headphones you hear"
            onFocus={() => void engine.refreshDevices()}
            onChange={(e) => {
              setOutputId(e.target.value);
              engine.setOutputDevice(e.target.value);
            }}
          >
            <option value="">System default output</option>
            {outputs
              .filter((d) => d.id)
              .map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
          </select>

          <div className="mt-2 flex justify-center">
            <StereoLevelMeter kind="out" height={120} />
          </div>
        </ChainBlock>
          </>
        )}
        {section === "stream" && (
          <div className="min-w-0 flex-1">
            <EncoderPanel params={params} setParams={setParams} />
          </div>
        )}
        {/* v3.0 psychoacoustics — appended after existing cards; nothing above moved */}
        {section === "preamp" && (
          <PsyPreamp params={params} setParams={setParams} />
        )}
        {section === "agc" && <PsyAgc params={params} setParams={setParams} />}
        {section === "eq" && <PsyEq params={params} setParams={setParams} />}
        {section === "stereo" && (
          <PsyStereo params={params} setParams={setParams} />
        )}
        {section === "multiband" && (
          <PsyMultiband params={params} setParams={setParams} />
        )}
        {section === "limiter" && (
          <PsyLimiter params={params} setParams={setParams} />
        )}
        {section === "output" && (
          <PsyOutput params={params} setParams={setParams} />
        )}
        {section === "stream" && (
          <PsyStream params={params} setParams={setParams} />
        )}
        {/* v3.1 Advanced Processing Suite — appended after the v3.0 cards;
            every module ships bypassed/neutral, nothing above moved. */}
        {section === "preamp" && (
          <RestorationSuite params={params} setParams={setParams} />
        )}
        {section === "agc" && (
          <LevelingSuite params={params} setParams={setParams} />
        )}
        {section === "eq" && (
          <PrecisionEqSuite params={params} setParams={setParams} />
        )}
        {section === "stereo" && (
          <SpatialSuite params={params} setParams={setParams} />
        )}
        {section === "limiter" && (
          <Limiter31Suite params={params} setParams={setParams} />
        )}
        {section === "limiter" && (
          <PsychoSuite params={params} setParams={setParams} />
        )}
        {section === "output" && (
          <ComplianceSuite params={params} setParams={setParams} />
        )}
      </div>
    </div>
  );
}
