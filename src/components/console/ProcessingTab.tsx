import { Knob } from "@/components/console/Knob";
import { Fader } from "@/components/console/Fader";
import { ModuleCard } from "@/components/console/ModuleCard";
import { CtrlRow, Seg, Val } from "@/components/console/controls";
import { StereoLevelMeter } from "@/components/console/Meters";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { getEngine, type MeterSnapshot } from "@/lib/audio/engine";
import {
  DEQ_LABELS,
  MB_LABELS,
  formatDb,
  formatHz,
  type DeqBands,
  type MultibandBands,
  type ProcessorParams,
} from "@/lib/audio/params";
import { cn } from "@/lib/utils";
import { Volume2, VolumeX, Zap } from "lucide-react";
import { useEffect, useState } from "react";

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
/** ms → seconds, 2 dp (spec: time constants shown in seconds). */
const secs = (ms: number) => `${(ms / 1000).toFixed(2)} s`;
/** Exciter insert level in dB (engine blend = mix% · 0.5). */
const harmDb = (mix: number) => (20 * Math.log10(Math.max((mix / 100) * 0.5, 1e-6)))
  .toFixed(2)
  .replace("-", "−");

/**
 * PROCESSING — wideband AGC, 6-band dynamic compression, dynamic EQ and the
 * composite limiter per the broadcast console layout, plus the equalizer and
 * output/monitor strip.
 */
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

  const eqFlat = () =>
    setParams((prev) => ({
      ...prev,
      eq: { ...prev.eq, bands: prev.eq.bands.map((b) => ({ ...b, gainDb: 0 })) },
    }));

  const ceilingPct = (Math.pow(10, params.limiter.ceilingDb / 20) * 100).toFixed(2);
  const truePeak = snap?.truePeak ?? -70;
  const peakOver =
    (snap?.powered ?? false) && truePeak > params.limiter.ceilingDb + 0.05;
  const preUs = Math.round(params.limiter.attackMs * 1000);
  const preStandard = preUs === 1000 ? "uk" : preUs === 500 ? "us" : "custom";

  return (
    <div className="grid gap-4 xl:grid-cols-12">
      {/* ── wideband AGC ── */}
      <ModuleCard
        className="xl:col-span-4"
        title="Wideband AGC"
        subtitle="Program leveller · loudness rider"
        enabled={params.agc.on}
        onToggle={() => setParams((p) => ({ ...p, agc: { ...p.agc, on: !p.agc.on } }))}
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
              onChange={(v) => setParams((p) => ({ ...p, agc: { ...p.agc, attackMs: v } }))}
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
              onChange={(v) => setParams((p) => ({ ...p, agc: { ...p.agc, releaseMs: v } }))}
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
              +{params.rider.maxRideDb.toFixed(2)} / −{params.rider.maxRideDb.toFixed(2)} dB
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
            <Val>
              {params.rider.on
                ? `${sgn(snap?.riderDb ?? 0)} dB`
                : "off"}
            </Val>
          </CtrlRow>
          <CtrlRow label="AGC GR">
            <Val className="min-w-0">−{(snap?.gr.agc ?? 0).toFixed(2)} dB</Val>
          </CtrlRow>
        </div>
      </ModuleCard>

      {/* ── 6-band dynamic compression ── */}
      <ModuleCard
        className="xl:col-span-8"
        title="6-band dynamic compression"
        subtitle="LR4 crossovers · per-band threshold dynamics"
        enabled={params.multiband.on}
        onToggle={() =>
          setParams((p) => ({ ...p, multiband: { ...p.multiband, on: !p.multiband.on } }))
        }
      >
        <div className="divide-y divide-border/60 rounded border border-border/60">
          {MB_LABELS.map((label, i) => {
            const band = params.multiband.bands[i];
            return (
              <CtrlRow key={label} label={label}>
                <SliderRow
                  className="max-w-md"
                  min={-50}
                  max={0}
                  step={0.5}
                  value={band.thresholdDb}
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
                  label={`${label} threshold`}
                />
                <Val className="min-w-16">
                  <span className="text-[9px] text-panel-mut">THRESH </span>
                  {sgn(band.thresholdDb)} dB
                </Val>
                <Val className="min-w-14">
                  <span className="text-[9px] text-panel-mut">GR </span>
                  −{(snap?.gr.bands[i] ?? 0).toFixed(2)}
                </Val>
              </CtrlRow>
            );
          })}
        </div>
        <p className="mt-3 text-[10px] leading-4 text-muted-foreground">
          One threshold per band — ratio, timing and makeup ride with the
          loaded preset. Sustained GR over 6 dB on a band means its threshold
          is working too hard.
        </p>
      </ModuleCard>

      {/* ── dynamic EQ ── */}
      <ModuleCard
        className="xl:col-span-7"
        title="Dynamic EQ"
        subtitle="5 level-detected subtractive bands · cut only"
        enabled={params.deq.on}
        onToggle={() => setParams((p) => ({ ...p, deq: { ...p.deq, on: !p.deq.on } }))}
        right={
          <span className="hidden text-[10px] text-muted-foreground sm:inline">
            {DEQ_LABELS.join(" · ")}
          </span>
        }
      >
        <div className="divide-y divide-border/60 rounded border border-border/60">
          {params.deq.bands.map((band, i) => (
            <CtrlRow key={`${band.freqHz}-${i}`} label={formatHz(band.freqHz)}>
              <SliderRow
                className="max-w-40"
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
              <Val>−{band.maxCutDb.toFixed(2)} dB</Val>
              <span className="text-[9px] font-semibold tracking-[0.1em] text-muted-foreground uppercase">
                Q
              </span>
              <SliderRow
                className="max-w-20"
                min={0.3}
                max={4}
                step={0.1}
                value={band.q}
                onChange={(v) =>
                  setParams((p) => ({
                    ...p,
                    deq: {
                      ...p.deq,
                      bands: p.deq.bands.map((b, j) => (j === i ? { ...b, q: v } : b)) as DeqBands,
                    },
                  }))
                }
                label={`Band ${i + 1} Q`}
              />
              <Val className="min-w-10">{band.q.toFixed(2)}</Val>
            </CtrlRow>
          ))}
        </div>
        <p className="mt-3 text-[10px] leading-4 text-muted-foreground">
          {DEQ_LABELS.slice(0, 2).join(", ")} and{" "}
          {DEQ_LABELS.slice(2).join(", ")} — cut only, never boost, so the
          detector can only ever clean the program up.
        </p>
      </ModuleCard>

      {/* ── composite limit ── */}
      <ModuleCard
        className="xl:col-span-5"
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
                setParams((p) => ({ ...p, limiter: { ...p.limiter, attackMs: v / 1000 } }))
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
                setParams((p) => ({ ...p, limiter: { ...p.limiter, on: v === "on" } }))
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
                setParams((p) => ({ ...p, limiter: { ...p.limiter, ceilingDb: v } }))
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
                setParams((p) => ({ ...p, exciter: { ...p.exciter, on: v === "on" } }))
              }
            />
            <SliderRow
              className="max-w-24"
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
              {snap?.powered ? `${truePeak.toFixed(2).replace("-", "−")} dBTP` : "―"}
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
            <Val className="min-w-0">−{(snap?.gr.limiter ?? 0).toFixed(2)} dB</Val>
          </CtrlRow>
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

      {/* ── equalizer ── */}
      <ModuleCard
        className="xl:col-span-8"
        title="6-band equalizer"
        subtitle="Shelving ends · peaking mids"
        enabled={params.eq.on}
        onToggle={() => setParams((p) => ({ ...p, eq: { ...p.eq, on: !p.eq.on } }))}
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
        <div className="flex justify-between gap-2 overflow-x-auto pb-1">
          {params.eq.bands.map((band, i) => (
            <Fader
              key={band.freq}
              label={formatHz(band.freq)}
              value={band.gainDb}
              min={-15}
              max={15}
              step={0.5}
              accent={Math.abs(band.gainDb) > 0.05}
              format={(v) => `${v > 0 ? "+" : ""}${v.toFixed(2)}`}
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
      </ModuleCard>

      {/* ── stereo & output ── */}
      <ModuleCard
        className="xl:col-span-4"
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
            {monitorMuted ? <VolumeX className="size-3.5" /> : <Volume2 className="size-3.5" />}
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
          <StereoLevelMeter kind="out" height={132} />
        </div>
      </ModuleCard>
    </div>
  );
}

/* ── inline horizontal slider used inside control rows ──────────────────── */

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
      className={cn("w-40", className)}
      min={min}
      max={max}
      step={step}
      value={[value]}
      onValueChange={(v) => onChange(v[0])}
      aria-label={label}
    />
  );
}
