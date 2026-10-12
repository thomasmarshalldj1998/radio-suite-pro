import { Brand } from "@/components/Brand";
import { LogoDropdown } from "@/components/LogoDropdown";
import { Knob } from "@/components/console/Knob";
import { Fader } from "@/components/console/Fader";
import { ModuleCard } from "@/components/console/ModuleCard";
import { EncoderPanel } from "@/components/console/EncoderPanel";
import { LogPanel } from "@/components/console/LogPanel";
import { PresetPanel } from "@/components/console/PresetPanel";
import {
  CorrelationMeter,
  GainReductionMeter,
  LoudnessMeter,
  StereoLevelMeter,
} from "@/components/console/Meters";
import { SourceModule } from "@/components/console/SourceModule";
import { SpectrumCanvas } from "@/components/console/Spectrum";
import { Button } from "@/components/ui/button";
import { getEngine, type MeterSnapshot } from "@/lib/audio/engine";
import {
  BAND_LABELS,
  DEFAULT_PARAMS,
  LUFS_TARGET,
  coerceParams,
  cloneParams,
  formatDb,
  formatHz,
  type BandCompParams,
  type ProcessorParams,
} from "@/lib/audio/params";
import { getRuntime, subscribeRuntime } from "@/lib/audio/runtime";
import { cn } from "@/lib/utils";
import {
  Activity,
  AudioLines,
  Bookmark,
  Mic2,
  Power,
  RadioTower,
  ScrollText,
  SlidersHorizontal,
  Volume2,
  VolumeX,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

const STORAGE_KEY = "signalpath.params.v1";
type TabId = "console" | "encoder" | "presets" | "log";

const TABS: { id: TabId; label: string; icon: React.ReactNode }[] = [
  { id: "console", label: "Console", icon: <SlidersHorizontal className="size-3.5" /> },
  { id: "encoder", label: "Encoder", icon: <RadioTower className="size-3.5" /> },
  { id: "presets", label: "Presets", icon: <Bookmark className="size-3.5" /> },
  { id: "log", label: "Log", icon: <ScrollText className="size-3.5" /> },
];

/* ── chain overview (live stage states) ─────────────────────────────────── */

function useMeterSnapshot(intervalMs = 120): MeterSnapshot | null {
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

function ChainOverview() {
  const snap = useMeterSnapshot(150);
  const stages: { name: string; on?: boolean }[] = [
    { name: "HPF", on: true },
    { name: "EQ", on: true },
    { name: "Multiband" },
    { name: "AGC" },
    { name: "Limiter" },
  ];
  return (
    <div className="panel rounded-lg p-3">
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-2">
        <span className="rounded-md bg-white/8 px-2 py-1 text-[10px] font-semibold tracking-wider text-panel-fg uppercase">
          Source
        </span>
        {stages.map((stage) => (
          <span key={stage.name} className="flex items-center gap-1.5">
            <span className="text-panel-mut">→</span>
            <span className="flex items-center gap-1.5 rounded-md bg-white/6 px-2 py-1 text-[10px] font-semibold tracking-wider text-panel-fg uppercase">
              <span className={cn("led size-1.5", (stage.on ?? true) ? "led-on" : undefined)} />
              {stage.name}
            </span>
          </span>
        ))}
        <span className="flex items-center gap-1.5">
          <span className="text-panel-mut">→</span>
          <span className="rounded-md bg-signal/20 px-2 py-1 text-[10px] font-semibold tracking-wider text-signal uppercase">
            To encoder
          </span>
        </span>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2">
        {[
          { label: "Multiband GR", value: Math.max(snap?.gr.low ?? 0, snap?.gr.mid ?? 0, snap?.gr.high ?? 0) },
          { label: "AGC GR", value: snap?.gr.agc ?? 0 },
          { label: "Limiter GR", value: snap?.gr.limiter ?? 0 },
        ].map((s) => (
          <div key={s.label} className="panel-well rounded-md px-2 py-1.5">
            <p className="text-[8px] font-semibold tracking-[0.12em] text-panel-mut uppercase">
              {s.label}
            </p>
            <p className="text-readout mt-0.5 text-xs font-medium text-panel-fg">
              −{s.value.toFixed(1)} dB
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── main dashboard ─────────────────────────────────────────────────────── */

export default function Dashboard() {
  const engine = getEngine();
  const [params, setParams] = useState<ProcessorParams>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return coerceParams(JSON.parse(raw));
    } catch {
      /* fall through to defaults */
    }
    return cloneParams(DEFAULT_PARAMS);
  });
  const [tab, setTab] = useState<TabId>("console");
  const [powered, setPowered] = useState(false);
  const [powerBusy, setPowerBusy] = useState(false);
  const [sampleRate, setSampleRate] = useState(0);
  const [monitorMuted, setMonitorMuted] = useState(false);
  const [onAir, setOnAir] = useState(() => getRuntime().onAir);

  // persistence + engine sync
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(params));
    } catch {
      /* storage may be unavailable */
    }
  }, [params]);
  useEffect(() => {
    engine.apply(params);
  }, [params, engine]);
  useEffect(
    () =>
      engine.subscribe((s) => {
        setPowered((prev) => (prev === s.powered ? prev : s.powered));
      }),
    [engine],
  );
  useEffect(
    () =>
      subscribeRuntime(() => {
        const rt = getRuntime();
        setOnAir((prev) => (prev === rt.onAir ? prev : rt.onAir));
      }),
    [],
  );

  const togglePower = useCallback(async () => {
    if (engine.powered) {
      engine.powerOff();
      return;
    }
    setPowerBusy(true);
    try {
      await engine.powerOn();
      engine.apply(params);
      setSampleRate(engine.sampleRate);
    } catch {
      toast.error("The audio engine could not start in this browser.");
    } finally {
      setPowerBusy(false);
    }
  }, [engine, params]);

  const applyPreset = useCallback(
    (p: ProcessorParams) => setParams(coerceParams(p)),
    [],
  );

  const eqReset = () =>
    setParams((prev) => ({
      ...prev,
      eq: {
        ...prev.eq,
        bands: prev.eq.bands.map((b) => ({ ...b, gainDb: 0 })),
      },
    }));

  return (
    <div className="min-h-screen bg-background">
      {/* ── chrome ── */}
      <header className="sticky top-0 z-40 border-b border-border/70 bg-background/85 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-[1560px] items-center gap-3 px-4">
          <Brand size={28} />
          <span className="hidden text-xs text-muted-foreground lg:inline">
            Broadcast processor suite
          </span>

          <div className="ml-auto flex items-center gap-2.5">
            {sampleRate > 0 && (
              <span className="text-readout hidden text-[11px] text-muted-foreground sm:inline">
                {(sampleRate / 1000).toFixed(1)} kHz
              </span>
            )}
            <span
              className={cn(
                "flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-bold tracking-[0.14em] uppercase",
                onAir
                  ? "bg-signal text-signal-fg animate-pulse-live"
                  : "border border-border/70 text-muted-foreground",
              )}
            >
              <RadioTower className="size-3" />
              {onAir ? "On air" : "Off air"}
            </span>
            <Button
              size="sm"
              variant={powered ? "default" : "outline"}
              onClick={() => void togglePower()}
              disabled={powerBusy}
              className={cn(
                "h-8 gap-1.5 text-[11px] font-semibold tracking-wide uppercase",
                powered && "bg-meter-ok text-background hover:bg-meter-ok/90",
              )}
            >
              <Power className={cn("size-3.5", powered && "animate-pulse-live")} />
              {powerBusy ? "Starting" : powered ? "Engine live" : "Start engine"}
            </Button>
            <LogoDropdown />
          </div>
        </div>

        <nav className="mx-auto flex max-w-[1560px] gap-1 px-4 pb-2">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={cn(
                "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
                tab === t.id
                  ? "bg-foreground text-background"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              {t.icon}
              {t.label}
            </button>
          ))}
        </nav>
      </header>

      {/* ── body ── */}
      <main className="mx-auto max-w-[1560px] px-4 py-5">
        {tab === "console" && (
          <div className="grid gap-4 xl:grid-cols-12">
            <div className="xl:col-span-4">
              <SourceModule params={params} setParams={setParams} />
            </div>

            <ModuleCard
              className="xl:col-span-5"
              title="Spectrum"
              subtitle="Ghost = input · lit = processed output"
              right={
                <span className="text-readout hidden text-[10px] text-muted-foreground sm:inline">
                  FFT {engine.fftSize} · log 20 Hz–20 kHz
                </span>
              }
            >
              <SpectrumCanvas mode="live" height={222} />
              <div className="mt-3 grid grid-cols-3 gap-2">
                {[
                  { label: "Sample rate", value: sampleRate ? `${(sampleRate / 1000).toFixed(1)} kHz` : "—" },
                  { label: "Monitor", value: monitorMuted ? "muted" : `${params.monitorDb.toFixed(1)} dB` },
                  { label: "Chain", value: powered ? "running" : "idle" },
                ].map((s) => (
                  <div key={s.label} className="rounded-md bg-muted/60 px-2.5 py-1.5">
                    <p className="text-[9px] font-semibold tracking-[0.1em] text-muted-foreground uppercase">
                      {s.label}
                    </p>
                    <p className="text-readout mt-0.5 text-[11px] font-medium">{s.value}</p>
                  </div>
                ))}
              </div>
            </ModuleCard>

            <ModuleCard
              className="xl:col-span-3"
              title="Master"
              subtitle="Output trim & monitoring"
            >
              <div className="flex items-start justify-around gap-2">
                <Knob
                  label="Output"
                  value={params.outputGainDb}
                  min={-24}
                  max={24}
                  step={0.5}
                  bipolar
                  format={(v) => formatDb(v)}
                  onChange={(v) => setParams((p) => ({ ...p, outputGainDb: v }))}
                  onReset={() => setParams((p) => ({ ...p, outputGainDb: 0 }))}
                />
                <Knob
                  label="Monitor"
                  value={params.monitorDb}
                  min={-60}
                  max={0}
                  step={0.5}
                  format={(v) => formatDb(v)}
                  onChange={(v) => {
                    setParams((p) => ({ ...p, monitorDb: v }));
                    if (!monitorMuted) engine.setMonitorDb(v);
                  }}
                  onReset={() => setParams((p) => ({ ...p, monitorDb: -6 }))}
                />
              </div>
              <div className="mt-4 flex gap-2">
                <Button
                  size="sm"
                  variant={monitorMuted ? "default" : "outline"}
                  className="h-8 flex-1 text-[11px]"
                  onClick={() => {
                    const next = !monitorMuted;
                    setMonitorMuted(next);
                    engine.setMonitorMuted(next);
                  }}
                >
                  {monitorMuted ? <VolumeX className="mr-1.5 size-3.5" /> : <Volume2 className="mr-1.5 size-3.5" />}
                  {monitorMuted ? "Muted" : "Monitor"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 flex-1 text-[11px]"
                  onPointerDown={() => engine.duck()}
                >
                  <Zap className="mr-1.5 size-3.5" />
                  Duck
                </Button>
              </div>
              <div className="mt-4 flex justify-center">
                <StereoLevelMeter kind="out" height={150} />
              </div>
            </ModuleCard>

            {/* ── EQ ── */}
            <ModuleCard
              className="xl:col-span-4"
              title="Equalizer"
              subtitle="6-band · shelving ends, peaking mids"
              enabled={params.eq.on}
              onToggle={() =>
                setParams((p) => ({ ...p, eq: { ...p.eq, on: !p.eq.on } }))
              }
              right={
                <Button size="sm" variant="ghost" className="h-7 text-[10px]" onClick={eqReset}>
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
                          bands: p.eq.bands.map((b, j) =>
                            j === i ? { ...b, gainDb: v } : b,
                          ),
                        },
                      }))
                    }
                  />
                ))}
              </div>
              <p className="mt-2 text-center text-[10px] text-muted-foreground">
                ±15 dB · drag faders, double-click a knob for reset anywhere in the rack
              </p>
            </ModuleCard>

            {/* ── multiband ── */}
            <ModuleCard
              className="xl:col-span-5"
              title="Multiband compressor"
              subtitle="3 bands · LR4 crossovers · per-band dynamics"
              enabled={params.multiband.on}
              onToggle={() =>
                setParams((p) => ({ ...p, multiband: { ...p.multiband, on: !p.multiband.on } }))
              }
            >
              <div className="mb-3 flex items-end gap-4">
                <Knob
                  label="Lo / X"
                  size={40}
                  value={params.multiband.xoverLowHz}
                  min={60}
                  max={240}
                  step={5}
                  format={(v) => formatHz(v)}
                  onChange={(v) =>
                    setParams((p) => ({ ...p, multiband: { ...p.multiband, xoverLowHz: v } }))
                  }
                />
                <Knob
                  label="X / Hi"
                  size={40}
                  value={params.multiband.xoverHighHz}
                  min={2000}
                  max={9000}
                  step={100}
                  format={(v) => formatHz(v)}
                  onChange={(v) =>
                    setParams((p) => ({ ...p, multiband: { ...p.multiband, xoverHighHz: v } }))
                  }
                />
                <p className="pb-1 text-[10px] leading-4 text-muted-foreground">
                  Crossovers split the program into band-limited lanes so bass
                  transients never pump the midrange.
                </p>
              </div>

              <div className="grid grid-cols-[4.5rem_repeat(3,minmax(0,1fr))] items-center gap-x-2 gap-y-2.5">
                <span />
                {BAND_LABELS.map((label, i) => (
                  <div key={label} className="text-center">
                    <p className="text-[10px] font-semibold tracking-[0.12em] text-foreground/80 uppercase">
                      {label}
                    </p>
                    <p className="text-[9px] text-muted-foreground">
                      {i === 0
                        ? `20–${formatHz(params.multiband.xoverLowHz)}`
                        : i === 1
                          ? `${formatHz(params.multiband.xoverLowHz)}–${formatHz(params.multiband.xoverHighHz)}`
                          : `${formatHz(params.multiband.xoverHighHz)}–20k`}
                    </p>
                  </div>
                ))}

                {(
                  [
                    { key: "thresholdDb" as const, label: "Thresh", min: -50, max: 0, step: 0.5, bipolar: true, fmt: (v: number) => formatDb(v) },
                    { key: "ratio" as const, label: "Ratio", min: 1, max: 12, step: 0.1, bipolar: false, fmt: (v: number) => `${v.toFixed(1)}:1` },
                    { key: "attackMs" as const, label: "Attack", min: 0.1, max: 200, step: 0.1, bipolar: false, fmt: (v: number) => `${v < 10 ? v.toFixed(1) : Math.round(v)} ms` },
                    { key: "releaseMs" as const, label: "Release", min: 10, max: 1000, step: 5, bipolar: false, fmt: (v: number) => `${Math.round(v)} ms` },
                    { key: "makeupDb" as const, label: "Makeup", min: -6, max: 12, step: 0.5, bipolar: true, fmt: (v: number) => formatDb(v, 1) },
                  ]
                ).map((row) => (
                  <RowWithKnobs key={row.key} label={row.label}>
                    {params.multiband.bands.map((band, i) => (
                      <Knob
                        key={i}
                        label=""
                        size={44}
                        value={band[row.key]}
                        min={row.min}
                        max={row.max}
                        step={row.step}
                        bipolar={row.bipolar}
                        format={row.fmt}
                        onChange={(v) =>
                          setParams((p) => ({
                            ...p,
                            multiband: {
                              ...p.multiband,
                              bands: p.multiband.bands.map((b, j) =>
                                j === i
                                  ? ({ ...b, [row.key]: v } as BandCompParams)
                                  : b,
                              ) as [BandCompParams, BandCompParams, BandCompParams],
                            },
                          }))
                        }
                        onReset={() =>
                          setParams((p) => ({
                            ...p,
                            multiband: {
                              ...p.multiband,
                              bands: p.multiband.bands.map((b, j) =>
                                j === i
                                  ? { ...b, [row.key]: DEFAULT_PARAMS.multiband.bands[i][row.key] }
                                  : b,
                              ) as [BandCompParams, BandCompParams, BandCompParams],
                            },
                          }))
                        }
                      />
                    ))}
                  </RowWithKnobs>
                ))}

                <span className="text-[9px] font-semibold tracking-[0.1em] text-muted-foreground uppercase">
                  GR
                </span>
                <MultibandGR />
              </div>
            </ModuleCard>

            {/* ── metering ── */}
            <div className="flex flex-col gap-4 xl:col-span-3">
              <LoudnessMeter target={LUFS_TARGET} />
              <div className="panel rounded-xl p-3">
                <p className="mb-2 text-[9px] font-semibold tracking-[0.14em] text-panel-mut uppercase">
                  Stereo correlation
                </p>
                <CorrelationMeter />
              </div>
            </div>

            {/* ── AGC ── */}
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
                    format={(v) => formatDb(v)}
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
                    format={(v) => formatDb(v)}
                    onChange={(v) => setParams((p) => ({ ...p, agc: { ...p.agc, makeupDb: v } }))}
                  />
                </div>
                <AgcGR />
              </div>
            </ModuleCard>

            {/* ── limiter ── */}
            <ModuleCard
              className="xl:col-span-3"
              title="Limiter"
              subtitle="Brickwall · 20:1 · hard knee"
              enabled={params.limiter.on}
              onToggle={() =>
                setParams((p) => ({ ...p, limiter: { ...p.limiter, on: !p.limiter.on } }))
              }
            >
              <div className="flex items-start justify-between gap-3">
                <div className="grid flex-1 grid-cols-2 gap-x-2 gap-y-3">
                  <Knob
                    label="Ceiling"
                    size={46}
                    accent
                    value={params.limiter.ceilingDb}
                    min={-6}
                    max={0}
                    step={0.1}
                    format={(v) => formatDb(v)}
                    onChange={(v) => setParams((p) => ({ ...p, limiter: { ...p.limiter, ceilingDb: v } }))}
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
                </div>
                <LimiterGR />
              </div>
              <p className="mt-3 text-[10px] leading-4 text-muted-foreground">
                Holds program peaks under {formatDb(params.limiter.ceilingDb)} before the
                encoder — watch true peak in the loudness panel.
              </p>
            </ModuleCard>

            {/* ── signal path ── */}
            <ModuleCard
              className="xl:col-span-5"
              title="Signal path"
              subtitle="Live stage states & gain reduction"
            >
              <ChainOverview />
              <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                {[
                  { icon: <Mic2 className="size-3.5" />, label: "Sources", value: "Mic · Gen · File" },
                  { icon: <AudioLines className="size-3.5" />, label: "Processing", value: "6 EQ · 3-band" },
                  { icon: <Activity className="size-3.5" />, label: "Metering", value: "BS.1770 · dBTP" },
                ].map((s) => (
                  <div key={s.label} className="rounded-lg bg-muted/60 px-2 py-2.5">
                    <span className="mx-auto mb-1 flex size-6 items-center justify-center rounded-md bg-background text-foreground/70">
                      {s.icon}
                    </span>
                    <p className="text-[9px] font-semibold tracking-[0.1em] text-muted-foreground uppercase">
                      {s.label}
                    </p>
                    <p className="mt-0.5 text-[10px] font-medium">{s.value}</p>
                  </div>
                ))}
              </div>
            </ModuleCard>
          </div>
        )}

        {tab === "encoder" && <EncoderPanel />}
        {tab === "presets" && (
          <PresetPanel params={params} onApply={applyPreset} />
        )}
        {tab === "log" && <LogPanel />}
      </main>
    </div>
  );
}

/* ── small layout helpers for the multiband matrix ──────────────────────── */

function RowWithKnobs({
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
      <div className="col-span-3 flex justify-around">{children}</div>
    </>
  );
}

function MultibandGR() {
  const snap = useMeterSnapshot(150);
  return (
    <div className="col-span-3 flex justify-around">
      {(
        [
          { v: snap?.gr.low ?? 0, label: "Low" },
          { v: snap?.gr.mid ?? 0, label: "Mid" },
          { v: snap?.gr.high ?? 0, label: "High" },
        ] as const
      ).map((b) => (
        <GainReductionMeter key={b.label} get={() => b.v} height={92} width={8} label={b.label} />
      ))}
    </div>
  );
}

function AgcGR() {
  const snap = useMeterSnapshot(150);
  return <GainReductionMeter get={() => snap?.gr.agc ?? 0} height={150} width={10} label="AGC" />;
}

function LimiterGR() {
  const snap = useMeterSnapshot(150);
  return (
    <GainReductionMeter get={() => snap?.gr.limiter ?? 0} height={150} width={10} label="LIMIT" />
  );
}
