import { Knob } from "@/components/console/Knob";
import { Fader } from "@/components/console/Fader";
import { ModuleCard } from "@/components/console/ModuleCard";
import {
  GainReductionMeter,
  StereoLevelMeter,
} from "@/components/console/Meters";
import { Button } from "@/components/ui/button";
import { getEngine, type MeterSnapshot } from "@/lib/audio/engine";
import {
  DEFAULT_PARAMS,
  DEFAULT_SPLITS,
  DEQ_LABELS,
  MB_LABELS,
  formatDb,
  formatHz,
  type BandCompParams,
  type DeqBand,
  type MultibandBands,
  type MultibandSplits,
  type ProcessorParams,
} from "@/lib/audio/params";
import { cn } from "@/lib/utils";
import { Volume2, VolumeX, Zap } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

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

const SPLIT_RANGES: [number, number][] = [
  [60, 300],
  [200, 800],
  [800, 3000],
  [2500, 7000],
  [6000, 14000],
];

const MB_ROWS = [
  {
    key: "thresholdDb" as const,
    label: "Thresh",
    min: -50,
    max: 0,
    step: 0.5,
    bipolar: true,
    fmt: (v: number) => formatDb(v),
  },
  {
    key: "ratio" as const,
    label: "Ratio",
    min: 1,
    max: 12,
    step: 0.1,
    bipolar: false,
    fmt: (v: number) => `${v.toFixed(1)}:1`,
  },
  {
    key: "attackMs" as const,
    label: "Attack",
    min: 0.5,
    max: 200,
    step: 0.5,
    bipolar: false,
    fmt: (v: number) => `${v < 10 ? v.toFixed(1) : Math.round(v)} ms`,
  },
  {
    key: "releaseMs" as const,
    label: "Release",
    min: 10,
    max: 1000,
    step: 5,
    bipolar: false,
    fmt: (v: number) => `${Math.round(v)} ms`,
  },
  {
    key: "makeupDb" as const,
    label: "Makeup",
    min: -6,
    max: 12,
    step: 0.5,
    bipolar: true,
    fmt: (v: number) => formatDb(v),
  },
] as const;

const bandRange = (i: number, splits: MultibandSplits): string =>
  i === 0
    ? `20–${formatHz(splits[0])}`
    : i === MB_LABELS.length - 1
      ? `${formatHz(splits[4])}–20k`
      : `${formatHz(splits[i - 1])}–${formatHz(splits[i])}`;

/* ── processing tab ─────────────────────────────────────────────────────── */

export function ProcessingTab({
  params,
  setParams,
}: {
  params: ProcessorParams;
  setParams: React.Dispatch<React.SetStateAction<ProcessorParams>>;
}) {
  const engine = getEngine();
  const snap = useMeterSnapshot();
  const [monitorMuted, setMonitorMuted] = useState(false);

  const setMbBand = useCallback(
    (i: number, key: keyof BandCompParams, v: number) =>
      setParams((p) => ({
        ...p,
        multiband: {
          ...p.multiband,
          bands: p.multiband.bands.map((b, j) =>
            j === i ? { ...b, [key]: v } : b,
          ) as MultibandBands,
        },
      })),
    [setParams],
  );

  const setSplit = useCallback(
    (i: number, v: number) =>
      setParams((p) => ({
        ...p,
        multiband: {
          ...p.multiband,
          splitsHz: p.multiband.splitsHz.map((s, j) =>
            j === i ? v : s,
          ) as MultibandSplits,
        },
      })),
    [setParams],
  );

  const setDeqBand = useCallback(
    (i: number, key: keyof DeqBand, v: number) =>
      setParams((p) => ({
        ...p,
        deq: {
          ...p.deq,
          bands: p.deq.bands.map((b, j) =>
            j === i ? { ...b, [key]: v } : b,
          ) as ProcessorParams["deq"]["bands"],
        },
      })),
    [setParams],
  );

  const eqFlat = () =>
    setParams((prev) => ({
      ...prev,
      eq: { ...prev.eq, bands: prev.eq.bands.map((b) => ({ ...b, gainDb: 0 })) },
    }));

  return (
    <div className="grid gap-4 xl:grid-cols-12">
      {/* ── equalizer ── */}
      <ModuleCard
        className="xl:col-span-5"
        title="Equalizer"
        subtitle="6-band · shelving ends, peaking mids"
        enabled={params.eq.on}
        onToggle={() => setParams((p) => ({ ...p, eq: { ...p.eq, on: !p.eq.on } }))}
        right={
          <Button size="sm" variant="ghost" className="h-7 text-[10px] cursor-pointer" onClick={eqFlat}>
            Flat
          </Button>
        }
      >
        <div className="flex justify-between gap-1 overflow-x-auto pb-1">
          {params.eq.bands.map((band, i) => (
            <Fader
              key={band.freq}
              label={formatHz(band.freq)}
              value={band.gainDb}
              min={-15}
              max={15}
              step={0.5}
              accent={Math.abs(band.gainDb) > 0.05}
              format={(v) => `${v > 0 ? "+" : ""}${v.toFixed(1)}`}
              onChange={(v) =>
                setParams((p) => ({
                  ...p,
                  eq: {
                    ...p.eq,
                    bands: p.eq.bands.map((b, j) => (j === i ? { ...b, gainDb: v } : b)),
                  },
                }))
              }
            />
          ))}
        </div>
        <p className="mt-2 text-center text-[10px] text-muted-foreground">
          ±15 dB · double-click a control anywhere in the rack to reset it
        </p>
      </ModuleCard>

      {/* ── dynamic EQ ── */}
      <ModuleCard
        className="xl:col-span-7"
        title="Dynamic EQ"
        subtitle="3 subtractive bands · level-detected cut only"
        enabled={params.deq.on}
        onToggle={() =>
          setParams((p) => ({ ...p, deq: { ...p.deq, on: !p.deq.on } }))
        }
        right={
          <span className="hidden text-[10px] text-muted-foreground sm:inline">
            Cut engages only above each threshold
          </span>
        }
      >
        <div className="grid gap-3 sm:grid-cols-3">
          {params.deq.bands.map((band, i) => (
            <div
              key={i}
              className="flex flex-col items-center gap-2.5 rounded-lg border border-border/60 bg-muted/30 px-2 py-3"
            >
              <div className="text-center">
                <p className="text-[10px] font-semibold tracking-[0.12em] text-foreground/80 uppercase">
                  {DEQ_LABELS[i]}
                </p>
                <p className="text-readout mt-0.5 text-[10px] text-muted-foreground">
                  {formatHz(band.freqHz)}
                </p>
              </div>
              <div className="flex flex-wrap justify-center gap-x-2 gap-y-1">
                <Knob
                  label="Freq"
                  size={40}
                  value={band.freqHz}
                  min={40}
                  max={14000}
                  step={10}
                  format={formatHz}
                  onChange={(v) => setDeqBand(i, "freqHz", v)}
                  onReset={() => setDeqBand(i, "freqHz", DEFAULT_PARAMS.deq.bands[i].freqHz)}
                />
                <Knob
                  label="Thresh"
                  size={40}
                  bipolar
                  value={band.thresholdDb}
                  min={-50}
                  max={0}
                  step={0.5}
                  format={formatDb}
                  onChange={(v) => setDeqBand(i, "thresholdDb", v)}
                  onReset={() => setDeqBand(i, "thresholdDb", DEFAULT_PARAMS.deq.bands[i].thresholdDb)}
                />
                <Knob
                  label="Max cut"
                  size={40}
                  accent
                  value={band.maxCutDb}
                  min={0}
                  max={12}
                  step={0.5}
                  format={(v) => formatDb(v)}
                  onChange={(v) => setDeqBand(i, "maxCutDb", v)}
                  onReset={() => setDeqBand(i, "maxCutDb", DEFAULT_PARAMS.deq.bands[i].maxCutDb)}
                />
                <Knob
                  label="Attack"
                  size={40}
                  value={band.attackMs}
                  min={1}
                  max={100}
                  step={1}
                  format={(v) => `${Math.round(v)} ms`}
                  onChange={(v) => setDeqBand(i, "attackMs", v)}
                  onReset={() => setDeqBand(i, "attackMs", DEFAULT_PARAMS.deq.bands[i].attackMs)}
                />
                <Knob
                  label="Release"
                  size={40}
                  value={band.releaseMs}
                  min={20}
                  max={800}
                  step={10}
                  format={(v) => `${Math.round(v)} ms`}
                  onChange={(v) => setDeqBand(i, "releaseMs", v)}
                  onReset={() => setDeqBand(i, "releaseMs", DEFAULT_PARAMS.deq.bands[i].releaseMs)}
                />
              </div>
              <div className="panel-well w-full rounded-md px-2 py-1 text-center">
                <p className="text-[8px] font-semibold tracking-[0.12em] text-panel-mut uppercase">
                  Live cut
                </p>
                <p className="text-readout text-[11px] font-medium text-panel-fg">
                  {params.deq.on ? `−${(snap?.gr.deq[i] ?? 0).toFixed(1)} dB` : "bypassed"}
                </p>
              </div>
            </div>
          ))}
        </div>
        <p className="mt-3 text-[10px] leading-4 text-muted-foreground">
          Each band watches its own level and ducks itself when it pokes over
          the threshold — mud control, harshness taming and de-essing without
          touching the rest of the program.
        </p>
      </ModuleCard>

      {/* ── 6-band multiband compressor ── */}
      <ModuleCard
        className="xl:col-span-8"
        title="Multiband compressor"
        subtitle="6 bands · LR4 crossovers · per-band dynamics"
        enabled={params.multiband.on}
        onToggle={() =>
          setParams((p) => ({ ...p, multiband: { ...p.multiband, on: !p.multiband.on } }))
        }
      >
        <div className="mb-3 flex flex-wrap items-end gap-3">
          {SPLIT_RANGES.map(([min, max], i) => (
            <Knob
              key={i}
              label={`X${i + 1}`}
              size={40}
              value={params.multiband.splitsHz[i]}
              min={min}
              max={max}
              step={5}
              format={formatHz}
              onChange={(v) => setSplit(i, v)}
              onReset={() => setSplit(i, DEFAULT_SPLITS[i])}
            />
          ))}
          <p className="pb-1 max-w-[16rem] text-[10px] leading-4 text-muted-foreground">
            Five crossover points split the program into six band-limited
            lanes so bass transients never pump the midrange.
          </p>
        </div>

        <div className="overflow-x-auto pb-1">
          <div className="grid min-w-[46rem] grid-cols-[4rem_repeat(6,minmax(0,1fr))] items-center gap-x-2 gap-y-2.5">
            <span />
            {MB_LABELS.map((label, i) => (
              <div key={label} className="text-center">
                <p className="text-[10px] font-semibold tracking-[0.12em] text-foreground/80 uppercase">
                  {label}
                </p>
                <p className="text-[9px] text-muted-foreground">
                  {bandRange(i, params.multiband.splitsHz)}
                </p>
              </div>
            ))}

            {MB_ROWS.map((row) => (
              <FragmentRow key={row.key} label={row.label}>
                {params.multiband.bands.map((band, i) => (
                  <Knob
                    key={i}
                    label=""
                    size={40}
                    value={band[row.key]}
                    min={row.min}
                    max={row.max}
                    step={row.step}
                    bipolar={row.bipolar}
                    format={row.fmt}
                    onChange={(v) => setMbBand(i, row.key, v)}
                    onReset={() => setMbBand(i, row.key, DEFAULT_PARAMS.multiband.bands[i][row.key])}
                  />
                ))}
              </FragmentRow>
            ))}

            <span className="text-[9px] font-semibold tracking-[0.1em] text-muted-foreground uppercase">
              GR
            </span>
            <div className="col-span-6 flex justify-around">
              {MB_LABELS.map((label, i) => (
                <GainReductionMeter
                  key={label}
                  get={() => snap?.gr.bands[i] ?? 0}
                  height={84}
                  width={7}
                  label={label}
                />
              ))}
            </div>
          </div>
        </div>
      </ModuleCard>

      {/* ── program AGC ── */}
      <ModuleCard
        className="xl:col-span-4"
        title="Program AGC"
        subtitle="Wideband leveller ahead of the limiter"
        enabled={params.agc.on}
        onToggle={() => setParams((p) => ({ ...p, agc: { ...p.agc, on: !p.agc.on } }))}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="grid flex-1 grid-cols-3 gap-x-2 gap-y-3">
            <Knob
              label="Thresh"
              size={44}
              bipolar
              value={params.agc.thresholdDb}
              min={-40}
              max={0}
              step={0.5}
              format={formatDb}
              onChange={(v) => setParams((p) => ({ ...p, agc: { ...p.agc, thresholdDb: v } }))}
            />
            <Knob
              label="Ratio"
              size={44}
              value={params.agc.ratio}
              min={1}
              max={10}
              step={0.1}
              format={(v) => `${v.toFixed(1)}:1`}
              onChange={(v) => setParams((p) => ({ ...p, agc: { ...p.agc, ratio: v } }))}
            />
            <Knob
              label="Knee"
              size={44}
              value={params.agc.kneeDb}
              min={0}
              max={24}
              step={0.5}
              format={(v) => formatDb(v, 0)}
              onChange={(v) => setParams((p) => ({ ...p, agc: { ...p.agc, kneeDb: v } }))}
            />
            <Knob
              label="Attack"
              size={44}
              value={params.agc.attackMs}
              min={0.5}
              max={200}
              step={0.5}
              format={(v) => `${v < 10 ? v.toFixed(1) : Math.round(v)} ms`}
              onChange={(v) => setParams((p) => ({ ...p, agc: { ...p.agc, attackMs: v } }))}
            />
            <Knob
              label="Release"
              size={44}
              value={params.agc.releaseMs}
              min={50}
              max={2000}
              step={10}
              format={(v) => `${Math.round(v)} ms`}
              onChange={(v) => setParams((p) => ({ ...p, agc: { ...p.agc, releaseMs: v } }))}
            />
            <Knob
              label="Makeup"
              size={44}
              bipolar
              value={params.agc.makeupDb}
              min={-6}
              max={18}
              step={0.5}
              format={formatDb}
              onChange={(v) => setParams((p) => ({ ...p, agc: { ...p.agc, makeupDb: v } }))}
            />
          </div>
          <GainReductionMeter get={() => snap?.gr.agc ?? 0} height={150} width={10} label="AGC" />
        </div>
      </ModuleCard>

      {/* ── composite limiter ── */}
      <ModuleCard
        className="xl:col-span-5"
        title="Composite limiter"
        subtitle="Fast peak stage + per-sample ceiling guard"
        enabled={params.limiter.on}
        onToggle={() =>
          setParams((p) => ({ ...p, limiter: { ...p.limiter, on: !p.limiter.on } }))
        }
        right={
          <span className="hidden items-center gap-1.5 text-[10px] text-muted-foreground sm:flex">
            <span className={cn("led size-1.5", params.limiter.on ? "led-on" : undefined)} />
            Guard {params.limiter.on ? "armed" : "off"}
          </span>
        }
      >
        <div className="flex items-start justify-between gap-3">
          <div className="grid flex-1 grid-cols-3 gap-x-2 gap-y-3">
            <Knob
              label="Ceiling"
              size={46}
              accent
              value={params.limiter.ceilingDb}
              min={-6}
              max={0}
              step={0.1}
              format={formatDb}
              onChange={(v) => setParams((p) => ({ ...p, limiter: { ...p.limiter, ceilingDb: v } }))}
            />
            <Knob
              label="Attack"
              size={46}
              value={params.limiter.attackMs}
              min={0.1}
              max={20}
              step={0.1}
              format={(v) => `${v.toFixed(1)} ms`}
              onChange={(v) => setParams((p) => ({ ...p, limiter: { ...p.limiter, attackMs: v } }))}
            />
            <Knob
              label="Release"
              size={46}
              value={params.limiter.releaseMs}
              min={10}
              max={500}
              step={5}
              format={(v) => `${Math.round(v)} ms`}
              onChange={(v) => setParams((p) => ({ ...p, limiter: { ...p.limiter, releaseMs: v } }))}
            />
          </div>
          <GainReductionMeter get={() => snap?.gr.limiter ?? 0} height={110} width={10} label="LIMIT" />
        </div>
        <p className="mt-3 text-[10px] leading-4 text-muted-foreground">
          The fast peak stage does the lifting; a 4×-oversampled per-sample
          soft-clip guard downstream of the output trim makes{" "}
          <span className="text-readout text-foreground/80">
            {formatDb(params.limiter.ceilingDb)}
          </span>{" "}
          a hard promise on the composite bus.
        </p>
      </ModuleCard>

      {/* ── output & monitoring ── */}
      <ModuleCard
        className="xl:col-span-2"
        title="Output"
        subtitle="Trim & monitor"
      >
        <div className="flex flex-col items-center gap-4">
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
          <div className="flex w-full gap-2">
            <Button
              size="sm"
              variant={monitorMuted ? "default" : "outline"}
              className="h-8 flex-1 text-[10px] cursor-pointer"
              onClick={() => {
                const next = !monitorMuted;
                setMonitorMuted(next);
                engine.setMonitorMuted(next);
              }}
            >
              {monitorMuted ? <VolumeX className="mr-1 size-3.5" /> : <Volume2 className="mr-1 size-3.5" />}
              {monitorMuted ? "Muted" : "Listen"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-8 flex-1 text-[10px] cursor-pointer"
              onPointerDown={() => engine.duck()}
            >
              <Zap className="mr-1 size-3.5" />
              Duck
            </Button>
          </div>
          <StereoLevelMeter kind="out" height={140} />
        </div>
      </ModuleCard>
    </div>
  );
}

/* ── row helper for the multiband matrix ────────────────────────────────── */

function FragmentRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <>
      <span className="self-center text-[9px] font-semibold tracking-[0.1em] text-muted-foreground uppercase">
        {label}
      </span>
      <div className="col-span-6 flex justify-around">{children}</div>
    </>
  );
}
