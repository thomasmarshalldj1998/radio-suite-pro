/**
 * v3.0 psychoacoustic panels — appended AFTER existing cards, never moved.
 *
 * House style: panel > header + divide rows of CtrlRow (Label → control →
 * monospace right-aligned value). Each block carries a Live/Stored dot:
 * Live = the engine applies it today; Stored = parameter-complete with
 * engine DSP arriving in staged rollout (enabling it is a deliberate no-op,
 * never a silent fake).
 */
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { CtrlRow, Seg } from "@/components/console/controls";
import { getEngine, type MeterSnapshot } from "@/lib/audio/engine";
import {
  formatDb,
  formatHz,
  type ProcessorParams,
} from "@/lib/audio/params";
import {
  PSY_STATUS,
  perceptualMetrics,
  type ArtifactMode,
  type CodecTarget,
  type DitherType,
  type KneeShape,
  type LatencyMode,
  type StabWindow,
} from "@/lib/audio/psycho";
import { cn } from "@/lib/utils";

type SetP = React.Dispatch<React.SetStateAction<ProcessorParams>>;

export const LIN_EQ_FREQS = [
  31, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000,
] as const;
const COH_LABELS = ["<120", "120–500", "500–2k", "2–8k", ">8k"] as const;

/** Live meter snapshot @ 500 ms for the quality/perceptual readouts. */
function usePsySnap(): MeterSnapshot | null {
  const [snap, setSnap] = useState<MeterSnapshot | null>(null);
  useEffect(() => {
    const id = window.setInterval(() => {
      try {
        setSnap({ ...getEngine().snapshot() });
      } catch {
        /* engine not up yet */
      }
    }, 500);
    return () => window.clearInterval(id);
  }, []);
  return snap;
}

/** Monospace right-aligned value, 2 dp — the console number format. */
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
        "w-24 shrink-0 text-right font-mono text-[11px] text-foreground tabular-nums",
        className,
      )}
    >
      {children}
    </span>
  );
}

function PSlider({
  min,
  max,
  step,
  value,
  onChange,
  aria,
}: {
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (v: number) => void;
  aria: string;
}) {
  return (
    <Slider
      min={min}
      max={max}
      step={step}
      value={[value]}
      onValueChange={([v]) => onChange(v)}
      aria-label={aria}
      className="min-w-24 flex-1"
    />
  );
}

function OnOff({
  aria,
  on,
  onChange,
}: {
  aria: string;
  on: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <Seg
      ariaLabel={aria}
      value={on ? "on" : "bypass"}
      options={[
        { value: "on", label: "On" },
        { value: "bypass", label: "Bypass" },
      ]}
      onChange={(v) => onChange(v === "on")}
    />
  );
}

function PsyBlock({
  module,
  title,
  subtitle,
  children,
}: {
  module: keyof typeof PSY_STATUS;
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  const live = PSY_STATUS[module] === "live";
  return (
    <div className="panel rounded-lg p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
          <h2 className="text-[11px] font-semibold tracking-[0.12em] text-foreground/90 uppercase">
            {title}
          </h2>
          <p className="text-[9px] text-muted-foreground">{subtitle}</p>
        </div>
        <span
          title={
            live
              ? "Live — applied by the engine"
              : "Stored — parameter layer, engine DSP in staged rollout"
          }
          className={cn(
            "rounded border px-2 py-1 text-[8px] font-bold tracking-[0.16em] uppercase",
            live
              ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-300"
              : "border-border/60 bg-muted/20 text-muted-foreground",
          )}
        >
          {live ? "● Live" : "○ Stored"}
        </span>
      </div>
      <div className="divide-y divide-border/60 rounded border border-border/60">
        {children}
      </div>
    </div>
  );
}

/* ── PREAMP · restoration & perceptual repair ─────────────────────────── */

export function PsyPreamp({
  params,
  setParams,
}: {
  params: ProcessorParams;
  setParams: SetP;
}) {
  const psy = params.psy;
  const snap = usePsySnap();
  const crest =
    snap && snap.lufsS > -70
      ? snap.samplePeakDb - snap.lufsS
      : Number.NaN;
  return (
    <>
      <PsyBlock
        module="declipper"
        title="Restoration"
        subtitle="Declip · dehum · artifact repair · clock · crosstalk"
      >
        <CtrlRow label="Declipper">
          <OnOff
            aria="Adaptive declipper"
            on={psy.declipper.on}
            onChange={(v) =>
              setParams((p) => ({
                ...p,
                psy: { ...p.psy, declipper: { ...p.psy.declipper, on: v } },
              }))
            }
          />
          <PSlider
            min={0}
            max={100}
            step={1}
            value={psy.declipper.sensitivity}
            onChange={(v) =>
              setParams((p) => ({
                ...p,
                psy: {
                  ...p.psy,
                  declipper: { ...p.psy.declipper, sensitivity: v },
                },
              }))
            }
            aria="Declipper sensitivity"
          />
          <Num>{psy.declipper.sensitivity.toFixed(0)} / 100</Num>
        </CtrlRow>
        <CtrlRow label="Reconstruct">
          <PSlider
            min={0}
            max={100}
            step={1}
            value={psy.declipper.reconstruct}
            onChange={(v) =>
              setParams((p) => ({
                ...p,
                psy: {
                  ...p.psy,
                  declipper: { ...p.psy.declipper, reconstruct: v },
                },
              }))
            }
            aria="Declipper reconstruction"
          />
          <Num>{psy.declipper.reconstruct.toFixed(0)} / 100 · 4×</Num>
        </CtrlRow>
        <CtrlRow label="Dehummer">
          <OnOff
            aria="Spectral dehummer"
            on={psy.dehummer.on}
            onChange={(v) =>
              setParams((p) => ({
                ...p,
                psy: { ...p.psy, dehummer: { ...p.psy.dehummer, on: v } },
              }))
            }
          />
          <Seg
            ariaLabel="Hum frequency"
            value={String(psy.dehummer.freqHz)}
            options={["50", "60", "100", "120"].map((f) => ({
              value: f,
              label: `${f}Hz`,
            }))}
            onChange={(v) =>
              setParams((p) => ({
                ...p,
                psy: {
                  ...p.psy,
                  dehummer: {
                    ...p.psy.dehummer,
                    freqHz: Number(v) as 50 | 60 | 100 | 120,
                  },
                },
              }))
            }
          />
          <PSlider
            min={2}
            max={8}
            step={1}
            value={psy.dehummer.harmonics}
            onChange={(v) =>
              setParams((p) => ({
                ...p,
                psy: {
                  ...p.psy,
                  dehummer: { ...p.psy.dehummer, harmonics: v },
                },
              }))
            }
            aria="Hum harmonics"
          />
          <Num>
            {psy.dehummer.harmonics.toFixed(0)} harm ·{" "}
            {psy.dehummer.depth.toFixed(0)}%
          </Num>
        </CtrlRow>
        <CtrlRow label="Hum depth">
          <PSlider
            min={0}
            max={100}
            step={1}
            value={psy.dehummer.depth}
            onChange={(v) =>
              setParams((p) => ({
                ...p,
                psy: { ...p.psy, dehummer: { ...p.psy.dehummer, depth: v } },
              }))
            }
            aria="Dehummer depth"
          />
          <Num>{psy.dehummer.depth.toFixed(0)}%</Num>
        </CtrlRow>
        <CtrlRow label="Artifact">
          <Seg
            ariaLabel="Artifact suppressor mode"
            value={psy.artifact.mode}
            options={(
              ["off", "light", "medium", "heavy", "auto"] as ArtifactMode[]
            ).map((m) => ({
              value: m,
              label: m === "off" ? "Off" : m[0].toUpperCase() + m.slice(1),
            }))}
            onChange={(v) =>
              setParams((p) => ({
                ...p,
                psy: {
                  ...p.psy,
                  artifact: { ...p.psy.artifact, mode: v as ArtifactMode },
                },
              }))
            }
          />
          <PSlider
            min={0}
            max={100}
            step={1}
            value={psy.artifact.smooth}
            onChange={(v) =>
              setParams((p) => ({
                ...p,
                psy: {
                  ...p.psy,
                  artifact: { ...p.psy.artifact, smooth: v },
                },
              }))
            }
            aria="Artifact smoothing"
          />
          <Num>MP3/AAC · {psy.artifact.smooth.toFixed(0)}%</Num>
        </CtrlRow>
        <CtrlRow label="Clock">
          <Seg
            ariaLabel="Clock lock mode"
            value={psy.clockLock}
            options={[
              { value: "auto", label: "Auto" },
              { value: "manual", label: "Manual" },
            ]}
            onChange={(v) =>
              setParams((p) => ({
                ...p,
                psy: { ...p.psy, clockLock: v as "auto" | "manual" },
              }))
            }
          />
          <span className="flex items-center gap-2 text-[10px] text-muted-foreground">
            <Switch
              checked={psy.clockDrift}
              onCheckedChange={(v) =>
                setParams((p) => ({ ...p, psy: { ...p.psy, clockDrift: v } }))
              }
              aria-label="Drift correction"
            />
            Drift corr
          </span>
          <Num>
            {snap ? `${snap.perf.driftMs.toFixed(2)} ms` : "—"}
          </Num>
        </CtrlRow>
        <CtrlRow label="X-talk L→R">
          <OnOff
            aria="Crosstalk cancellation"
            on={psy.xtalk.on}
            onChange={(v) =>
              setParams((p) => ({
                ...p,
                psy: { ...p.psy, xtalk: { ...p.psy.xtalk, on: v } },
              }))
            }
          />
          <PSlider
            min={-80}
            max={-20}
            step={1}
            value={psy.xtalk.lrDb}
            onChange={(v) =>
              setParams((p) => ({
                ...p,
                psy: { ...p.psy, xtalk: { ...p.psy.xtalk, lrDb: v } },
              }))
            }
            aria="L to R bleed"
          />
          <Num>{formatDb(psy.xtalk.lrDb)}</Num>
        </CtrlRow>
        <CtrlRow label="X-talk R→L">
          <PSlider
            min={-80}
            max={-20}
            step={1}
            value={psy.xtalk.rlDb}
            onChange={(v) =>
              setParams((p) => ({
                ...p,
                psy: { ...p.psy, xtalk: { ...p.psy.xtalk, rlDb: v } },
              }))
            }
            aria="R to L bleed"
          />
          <Num>{formatDb(psy.xtalk.rlDb)}</Num>
        </CtrlRow>
      </PsyBlock>
      <PsyBlock
        module="declipper"
        title="Restoration monitor"
        subtitle="Live detector feed · repair params stored above"
      >
        <CtrlRow label="Input peak">
          <Num>
            {snap
              ? formatDb(Math.max(snap.inPeakL, snap.inPeakR))
              : "—"}
          </Num>
        </CtrlRow>
        <CtrlRow label="Crest">
          <Num>
            {Number.isFinite(crest) ? `${crest.toFixed(2)} dB` : "—"}
          </Num>
        </CtrlRow>
        <CtrlRow label="Coherence">
          <Num>{snap ? snap.correlation.toFixed(2) : "—"}</Num>
        </CtrlRow>
        <CtrlRow label="Clip events">
          <Num>{snap ? snap.clipEvents.toFixed(0) : "—"}</Num>
        </CtrlRow>
        <CtrlRow label="Last clip">
          <Num>
            {snap && snap.clipAt > 0
              ? new Date(snap.clipAt).toLocaleTimeString()
              : "none"}
          </Num>
        </CtrlRow>
      </PsyBlock>
      <PsyBlock
        module="clock"
        title="Input quality"
        subtitle="Live meters · crest · coherence · clock"
      >
        <CtrlRow label="Crest">
          <Num>{Number.isFinite(crest) ? `${crest.toFixed(2)} dB` : "—"}</Num>
        </CtrlRow>
        <CtrlRow label="Coherence">
          <Num>{snap ? snap.correlation.toFixed(2) : "—"}</Num>
        </CtrlRow>
        <CtrlRow label="Clock drift">
          <Num>{snap ? `${snap.perf.driftMs.toFixed(2)} ms` : "—"}</Num>
        </CtrlRow>
        <CtrlRow label="Underruns">
          <Num>{snap ? snap.perf.stalls.toFixed(0) : "—"}</Num>
        </CtrlRow>
        <CtrlRow label="Codec damage">
          <Num>— / 100</Num>
        </CtrlRow>
      </PsyBlock>
    </>
  );
}

/* ── AGC · natural dynamics & energy shaping ──────────────────────────── */

export function PsyAgc({
  params,
  setParams,
}: {
  params: ProcessorParams;
  setParams: SetP;
}) {
  const psy = params.psy;
  return (
    <>
      <PsyBlock
        module="dualAgc"
        title="Dual-speed AGC"
        subtitle="Fast + slow followers · link"
      >
        <CtrlRow label="Dual AGC">
          <OnOff
            aria="Dual-speed AGC"
            on={psy.dualAgc.on}
            onChange={(v) =>
              setParams((p) => ({
                ...p,
                psy: { ...p.psy, dualAgc: { ...p.psy.dualAgc, on: v } },
              }))
            }
          />
          <PSlider
            min={1}
            max={30}
            step={1}
            value={psy.dualAgc.fastAttackMs}
            onChange={(v) =>
              setParams((p) => ({
                ...p,
                psy: {
                  ...p.psy,
                  dualAgc: { ...p.psy.dualAgc, fastAttackMs: v },
                },
              }))
            }
            aria="Fast attack"
          />
          <Num>{psy.dualAgc.fastAttackMs.toFixed(0)} ms</Num>
        </CtrlRow>
        <CtrlRow label="Slow attack">
          <PSlider
            min={30}
            max={500}
            step={5}
            value={psy.dualAgc.slowAttackMs}
            onChange={(v) =>
              setParams((p) => ({
                ...p,
                psy: {
                  ...p.psy,
                  dualAgc: { ...p.psy.dualAgc, slowAttackMs: v },
                },
              }))
            }
            aria="Slow attack"
          />
          <Num>{psy.dualAgc.slowAttackMs.toFixed(0)} ms</Num>
        </CtrlRow>
        <CtrlRow label="Link">
          <PSlider
            min={0}
            max={100}
            step={1}
            value={psy.dualAgc.link}
            onChange={(v) =>
              setParams((p) => ({
                ...p,
                psy: { ...p.psy, dualAgc: { ...p.psy.dualAgc, link: v } },
              }))
            }
            aria="Fast/slow link"
          />
          <Num>{psy.dualAgc.link.toFixed(0)}%</Num>
        </CtrlRow>
      </PsyBlock>
      <PsyBlock
        module="vocal"
        title="Vocal anchor & energy"
        subtitle="300 Hz–3 kHz presence · bass/treble balance"
      >
        <CtrlRow label="Anchor">
          <OnOff
            aria="Vocal anchor"
            on={psy.vocal.on}
            onChange={(v) =>
              setParams((p) => ({
                ...p,
                psy: { ...p.psy, vocal: { ...p.psy.vocal, on: v } },
              }))
            }
          />
          <PSlider
            min={0}
            max={100}
            step={1}
            value={psy.vocal.preserve}
            onChange={(v) =>
              setParams((p) => ({
                ...p,
                psy: { ...p.psy, vocal: { ...p.psy.vocal, preserve: v } },
              }))
            }
            aria="Vocal preserve"
          />
          <Num>{psy.vocal.preserve.toFixed(0)}%</Num>
        </CtrlRow>
        <CtrlRow label="Separation">
          <PSlider
            min={0}
            max={100}
            step={1}
            value={psy.vocal.separation}
            onChange={(v) =>
              setParams((p) => ({
                ...p,
                psy: { ...p.psy, vocal: { ...p.psy.vocal, separation: v } },
              }))
            }
            aria="Vocal separation"
          />
          <Num>{psy.vocal.separation.toFixed(0)}%</Num>
        </CtrlRow>
        <CtrlRow label="Bass shift">
          <OnOff
            aria="Energy balance"
            on={psy.energy.on}
            onChange={(v) =>
              setParams((p) => ({
                ...p,
                psy: { ...p.psy, energy: { ...p.psy.energy, on: v } },
              }))
            }
          />
          <PSlider
            min={-3}
            max={3}
            step={0.1}
            value={psy.energy.bassDb}
            onChange={(v) =>
              setParams((p) => ({
                ...p,
                psy: { ...p.psy, energy: { ...p.psy.energy, bassDb: v } },
              }))
            }
            aria="Bass shift"
          />
          <Num>{formatDb(psy.energy.bassDb)}</Num>
        </CtrlRow>
        <CtrlRow label="Treble shift">
          <PSlider
            min={-3}
            max={3}
            step={0.1}
            value={psy.energy.trebleDb}
            onChange={(v) =>
              setParams((p) => ({
                ...p,
                psy: { ...p.psy, energy: { ...p.psy.energy, trebleDb: v } },
              }))
            }
            aria="Treble shift"
          />
          <Num>{formatDb(psy.energy.trebleDb)}</Num>
        </CtrlRow>
        <CtrlRow label="Auto-comp">
          <span className="flex items-center gap-2 text-[10px] text-muted-foreground">
            <Switch
              checked={psy.energy.autoComp}
              onCheckedChange={(v) =>
                setParams((p) => ({
                  ...p,
                  psy: { ...p.psy, energy: { ...p.psy.energy, autoComp: v } },
                }))
              }
              aria-label="Energy auto-compensate"
            />
            {psy.energy.autoComp ? "On" : "Off"}
          </span>
          <Num>±3.00 dB</Num>
        </CtrlRow>
      </PsyBlock>
      <PsyBlock
        module="density"
        title="Density & stabilizer"
        subtitle="Dynamic density · long-window loudness lock"
      >
        <CtrlRow label="Density">
          <OnOff
            aria="Dynamic density"
            on={psy.density.on}
            onChange={(v) =>
              setParams((p) => ({
                ...p,
                psy: { ...p.psy, density: { ...p.psy.density, on: v } },
              }))
            }
          />
          <PSlider
            min={0}
            max={100}
            step={1}
            value={psy.density.density}
            onChange={(v) =>
              setParams((p) => ({
                ...p,
                psy: { ...p.psy, density: { ...p.psy.density, density: v } },
              }))
            }
            aria="Dynamic density"
          />
          <Num>{psy.density.density.toFixed(0)}%</Num>
        </CtrlRow>
        <CtrlRow label="Openness">
          <PSlider
            min={0}
            max={100}
            step={1}
            value={psy.density.openness}
            onChange={(v) =>
              setParams((p) => ({
                ...p,
                psy: { ...p.psy, density: { ...p.psy.density, openness: v } },
              }))
            }
            aria="Transient openness"
          />
          <Num>{psy.density.openness.toFixed(0)}%</Num>
        </CtrlRow>
        <CtrlRow label="Stabilizer">
          <OnOff
            aria="Loudness stabilizer"
            on={psy.loudStab.on}
            onChange={(v) =>
              setParams((p) => ({
                ...p,
                psy: { ...p.psy, loudStab: { ...p.psy.loudStab, on: v } },
              }))
            }
          />
          <Seg
            ariaLabel="Stabilizer window"
            value={psy.loudStab.window}
            options={(["10s", "30s", "2min", "5min"] as StabWindow[]).map(
              (w) => ({ value: w, label: w }),
            )}
            onChange={(v) =>
              setParams((p) => ({
                ...p,
                psy: {
                  ...p.psy,
                  loudStab: { ...p.psy.loudStab, window: v as StabWindow },
                },
              }))
            }
          />
          <Num>±3.00 dB</Num>
        </CtrlRow>
        <CtrlRow label="Fatigue warn">
          <PSlider
            min={50}
            max={95}
            step={1}
            value={psy.fatigueWarn}
            onChange={(v) =>
              setParams((p) => ({ ...p, psy: { ...p.psy, fatigueWarn: v } }))
            }
            aria="Fatigue warning threshold"
          />
          <Num>{psy.fatigueWarn.toFixed(0)} / 100</Num>
        </CtrlRow>
      </PsyBlock>
    </>
  );
}

/* ── EQ · perceptual & linear-phase ───────────────────────────────────── */

export function PsyEq({
  params,
  setParams,
}: {
  params: ProcessorParams;
  setParams: SetP;
}) {
  const psy = params.psy;
  const dev =
    psy.matchEq.captured !== null
      ? Math.max(
          ...psy.linEq.bands.map((b, i) =>
            Math.abs(b.gainDb - (psy.matchEq.captured?.[i] ?? 0)),
          ),
        )
      : null;
  return (
    <>
      <PsyBlock
        module="tilt"
        title="Spectral tilt · LIVE"
        subtitle="Pivot 1 kHz · split ±slope/2 across shelves"
      >
        <CtrlRow label="Tilt">
          <OnOff
            aria="Spectral tilt"
            on={psy.tilt.on}
            onChange={(v) =>
              setParams((p) => ({
                ...p,
                psy: { ...p.psy, tilt: { ...p.psy.tilt, on: v } },
              }))
            }
          />
          <PSlider
            min={-3}
            max={3}
            step={0.1}
            value={psy.tilt.slopeDb}
            onChange={(v) =>
              setParams((p) => ({
                ...p,
                psy: { ...p.psy, tilt: { ...p.psy.tilt, slopeDb: v } },
              }))
            }
            aria="Tilt slope"
          />
          <Num>{formatDb(psy.tilt.slopeDb)}</Num>
        </CtrlRow>
        <CtrlRow label="Pre-emph">
          <Seg
            ariaLabel="Pre-emphasis select"
            value={psy.preEmphasis}
            options={[
              { value: "off", label: "Off" },
              { value: "50", label: "50µs" },
              { value: "75", label: "75µs" },
              { value: "j17", label: "J17" },
              { value: "flat", label: "Flat" },
            ]}
            onChange={(v) =>
              setParams((p) => ({
                ...p,
                psy: {
                  ...p.psy,
                  preEmphasis: v as PsyPreEmph,
                },
              }))
            }
          />
          <Num>stored</Num>
        </CtrlRow>
      </PsyBlock>
      <PsyBlock
        module="linEq"
        title="Linear-phase 10-band"
        subtitle="31 Hz–16 kHz · Q 0.4–4.0 · ±12 dB"
      >
        <CtrlRow label="Lin EQ">
          <OnOff
            aria="Linear-phase EQ"
            on={psy.linEq.on}
            onChange={(v) =>
              setParams((p) => ({
                ...p,
                psy: { ...p.psy, linEq: { ...p.psy.linEq, on: v } },
              }))
            }
          />
          <Num>10 bands</Num>
        </CtrlRow>
        {psy.linEq.bands.map((b, i) => (
          <CtrlRow key={LIN_EQ_FREQS[i]} label={formatHz(LIN_EQ_FREQS[i])}>
            <PSlider
              min={-12}
              max={12}
              step={0.1}
              value={b.gainDb}
              onChange={(v) =>
                setParams((p) => ({
                  ...p,
                  psy: {
                    ...p.psy,
                    linEq: {
                      ...p.psy.linEq,
                      bands: p.psy.linEq.bands.map((x, j) =>
                        j === i ? { ...x, gainDb: v } : x,
                      ),
                    },
                  },
                }))
              }
              aria={`Linear EQ ${LIN_EQ_FREQS[i]} Hz gain`}
            />
            <PSlider
              min={0.4}
              max={4}
              step={0.1}
              value={b.q}
              onChange={(v) =>
                setParams((p) => ({
                  ...p,
                  psy: {
                    ...p.psy,
                    linEq: {
                      ...p.psy.linEq,
                      bands: p.psy.linEq.bands.map((x, j) =>
                        j === i ? { ...x, q: v } : x,
                      ),
                    },
                  },
                }))
              }
              aria={`Linear EQ ${LIN_EQ_FREQS[i]} Hz Q`}
            />
            <Num>
              {formatDb(b.gainDb)} · Q{b.q.toFixed(1)}
            </Num>
          </CtrlRow>
        ))}
      </PsyBlock>
      <PsyBlock
        module="dynEq"
        title="Dynamic & matching EQ"
        subtitle="Per-band dynamics · capture-to-match"
      >
        <CtrlRow label="Dyn EQ">
          <OnOff
            aria="Dynamic EQ"
            on={psy.dynEq.on}
            onChange={(v) =>
              setParams((p) => ({
                ...p,
                psy: { ...p.psy, dynEq: { ...p.psy.dynEq, on: v } },
              }))
            }
          />
          <PSlider
            min={-40}
            max={0}
            step={0.5}
            value={psy.dynEq.thresholdDb}
            onChange={(v) =>
              setParams((p) => ({
                ...p,
                psy: { ...p.psy, dynEq: { ...p.psy.dynEq, thresholdDb: v } },
              }))
            }
            aria="Dynamic EQ threshold"
          />
          <Num>{formatDb(psy.dynEq.thresholdDb)}</Num>
        </CtrlRow>
        <CtrlRow label="Ratio">
          <PSlider
            min={1}
            max={4}
            step={0.1}
            value={psy.dynEq.ratio}
            onChange={(v) =>
              setParams((p) => ({
                ...p,
                psy: { ...p.psy, dynEq: { ...p.psy.dynEq, ratio: v } },
              }))
            }
            aria="Dynamic EQ ratio"
          />
          <Num>{psy.dynEq.ratio.toFixed(1)}:1</Num>
        </CtrlRow>
        <CtrlRow label="Dyn time">
          <PSlider
            min={5}
            max={50}
            step={1}
            value={psy.dynEq.attackMs}
            onChange={(v) =>
              setParams((p) => ({
                ...p,
                psy: { ...p.psy, dynEq: { ...p.psy.dynEq, attackMs: v } },
              }))
            }
            aria="Dynamic EQ attack"
          />
          <PSlider
            min={20}
            max={200}
            step={5}
            value={psy.dynEq.releaseMs}
            onChange={(v) =>
              setParams((p) => ({
                ...p,
                psy: { ...p.psy, dynEq: { ...p.psy.dynEq, releaseMs: v } },
              }))
            }
            aria="Dynamic EQ release"
          />
          <Num>
            {psy.dynEq.attackMs.toFixed(0)}/{psy.dynEq.releaseMs.toFixed(0)} ms
          </Num>
        </CtrlRow>
        <CtrlRow label="Match EQ">
          <OnOff
            aria="Matching EQ"
            on={psy.matchEq.on}
            onChange={(v) =>
              setParams((p) => ({
                ...p,
                psy: { ...p.psy, matchEq: { ...p.psy.matchEq, on: v } },
              }))
            }
          />
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              setParams((p) => ({
                ...p,
                psy: {
                  ...p.psy,
                  matchEq: {
                    ...p.psy.matchEq,
                    captured: p.psy.linEq.bands.map((b) => b.gainDb),
                  },
                },
              }))
            }
          >
            Capture reference
          </Button>
          <Num>
            {dev === null
              ? "no ref"
              : `Δ${dev.toFixed(2)} / ±${psy.matchEq.toleranceDb.toFixed(1)}`}
          </Num>
        </CtrlRow>
      </PsyBlock>
    </>
  );
}

type PsyPreEmph = ProcessorParams["psy"]["preEmphasis"];

/* ── STEREO · psychoacoustic imaging ──────────────────────────────────── */

export function PsyStereo({
  params,
  setParams,
}: {
  params: ProcessorParams;
  setParams: SetP;
}) {
  const psy = params.psy;
  return (
    <>
      <PsyBlock
        module="cohWidth"
        title="5-band coherence width"
        subtitle="Per-octave width · correlation guard"
      >
        <CtrlRow label="Coherence">
          <OnOff
            aria="Coherence width"
            on={psy.cohWidth.on}
            onChange={(v) =>
              setParams((p) => ({
                ...p,
                psy: { ...p.psy, cohWidth: { ...p.psy.cohWidth, on: v } },
              }))
            }
          />
          <PSlider
            min={0.9}
            max={1}
            step={0.01}
            value={psy.cohWidth.corrGuard}
            onChange={(v) =>
              setParams((p) => ({
                ...p,
                psy: {
                  ...p.psy,
                  cohWidth: { ...p.psy.cohWidth, corrGuard: v },
                },
              }))
            }
            aria="Correlation guard"
          />
          <Num>guard {psy.cohWidth.corrGuard.toFixed(2)}</Num>
        </CtrlRow>
        {psy.cohWidth.bands.map((w, i) => (
          <CtrlRow key={COH_LABELS[i]} label={COH_LABELS[i]}>
            <PSlider
              min={0.8}
              max={1.5}
              step={0.01}
              value={w}
              onChange={(v) =>
                setParams((p) => ({
                  ...p,
                  psy: {
                    ...p.psy,
                    cohWidth: {
                      ...p.psy.cohWidth,
                      bands: p.psy.cohWidth.bands.map((x, j) =>
                        j === i ? v : x,
                      ) as [number, number, number, number, number],
                    },
                  },
                }))
              }
              aria={`Coherence band ${COH_LABELS[i]}`}
            />
            <Num>{w.toFixed(2)}×</Num>
          </CtrlRow>
        ))}
      </PsyBlock>
      <PsyBlock
        module="bassSynth"
        title="Bass synthesis & alignment"
        subtitle="Immersive fundamental · L/R time-phase"
      >
        <CtrlRow label="Bass synth">
          <OnOff
            aria="Immersive bass synthesis"
            on={psy.bassSynth.on}
            onChange={(v) =>
              setParams((p) => ({
                ...p,
                psy: { ...p.psy, bassSynth: { ...p.psy.bassSynth, on: v } },
              }))
            }
          />
          <PSlider
            min={60}
            max={100}
            step={1}
            value={psy.bassSynth.fundHz}
            onChange={(v) =>
              setParams((p) => ({
                ...p,
                psy: {
                  ...p.psy,
                  bassSynth: { ...p.psy.bassSynth, fundHz: v },
                },
              }))
            }
            aria="Bass fundamental"
          />
          <Num>{formatHz(psy.bassSynth.fundHz)}</Num>
        </CtrlRow>
        <CtrlRow label="Harmonics">
          <PSlider
            min={0}
            max={30}
            step={1}
            value={psy.bassSynth.harmMix}
            onChange={(v) =>
              setParams((p) => ({
                ...p,
                psy: {
                  ...p.psy,
                  bassSynth: { ...p.psy.bassSynth, harmMix: v },
                },
              }))
            }
            aria="Harmonic mix"
          />
          <Num>{psy.bassSynth.harmMix.toFixed(0)}%</Num>
        </CtrlRow>
        <CtrlRow label="Align">
          <OnOff
            aria="Phase and time alignment"
            on={psy.align.on}
            onChange={(v) =>
              setParams((p) => ({
                ...p,
                psy: { ...p.psy, align: { ...p.psy.align, on: v } },
              }))
            }
          />
          <PSlider
            min={-5}
            max={5}
            step={0.1}
            value={psy.align.offsetMs}
            onChange={(v) =>
              setParams((p) => ({
                ...p,
                psy: { ...p.psy, align: { ...p.psy.align, offsetMs: v } },
              }))
            }
            aria="L/R offset"
          />
          <Num>{psy.align.offsetMs.toFixed(1)} ms</Num>
        </CtrlRow>
        <CtrlRow label="Rotate">
          <PSlider
            min={-180}
            max={180}
            step={1}
            value={psy.align.rotateDeg}
            onChange={(v) =>
              setParams((p) => ({
                ...p,
                psy: { ...p.psy, align: { ...p.psy.align, rotateDeg: v } },
              }))
            }
            aria="Phase rotate"
          />
          <Num>{psy.align.rotateDeg.toFixed(0)}°</Num>
        </CtrlRow>
      </PsyBlock>
      <PsyBlock
        module="msTrim"
        title="M/S matrix trim"
        subtitle="Mid/side balance · side HPF"
      >
        <CtrlRow label="M/S trim">
          <OnOff
            aria="M/S matrix trim"
            on={psy.msTrim.on}
            onChange={(v) =>
              setParams((p) => ({
                ...p,
                psy: { ...p.psy, msTrim: { ...p.psy.msTrim, on: v } },
              }))
            }
          />
          <PSlider
            min={-3}
            max={3}
            step={0.1}
            value={psy.msTrim.midDb}
            onChange={(v) =>
              setParams((p) => ({
                ...p,
                psy: { ...p.psy, msTrim: { ...p.psy.msTrim, midDb: v } },
              }))
            }
            aria="Mid trim"
          />
          <Num>M {formatDb(psy.msTrim.midDb)}</Num>
        </CtrlRow>
        <CtrlRow label="Side trim">
          <PSlider
            min={-6}
            max={6}
            step={0.1}
            value={psy.msTrim.sideDb}
            onChange={(v) =>
              setParams((p) => ({
                ...p,
                psy: { ...p.psy, msTrim: { ...p.psy.msTrim, sideDb: v } },
              }))
            }
            aria="Side trim"
          />
          <PSlider
            min={200}
            max={2000}
            step={10}
            value={psy.msTrim.sideHpfHz}
            onChange={(v) =>
              setParams((p) => ({
                ...p,
                psy: { ...p.psy, msTrim: { ...p.psy.msTrim, sideHpfHz: v } },
              }))
            }
            aria="Side HPF"
          />
          <Num>
            S {formatDb(psy.msTrim.sideDb)} · {formatHz(psy.msTrim.sideHpfHz)}
          </Num>
        </CtrlRow>
      </PsyBlock>
    </>
  );
}

/* ── MULTIBAND · perceptual crossover & dynamics ──────────────────────── */

export function PsyMultiband({
  params,
  setParams,
}: {
  params: ProcessorParams;
  setParams: SetP;
}) {
  const psy = params.psy;
  return (
    <>
      <PsyBlock
        module="maskComp"
        title="Masking compression"
        subtitle="24 critical bands · 20 ms temporal window"
      >
        <CtrlRow label="Mask comp">
          <OnOff
            aria="Perceptual masking compression"
            on={psy.maskComp.on}
            onChange={(v) =>
              setParams((p) => ({
                ...p,
                psy: { ...p.psy, maskComp: { ...p.psy.maskComp, on: v } },
              }))
            }
          />
          <PSlider
            min={0}
            max={100}
            step={1}
            value={psy.maskComp.strength}
            onChange={(v) =>
              setParams((p) => ({
                ...p,
                psy: {
                  ...p.psy,
                  maskComp: { ...p.psy.maskComp, strength: v },
                },
              }))
            }
            aria="Mask strength"
          />
          <Num>{psy.maskComp.strength.toFixed(0)}%</Num>
        </CtrlRow>
        <CtrlRow label="Transient">
          <PSlider
            min={0}
            max={100}
            step={1}
            value={psy.maskComp.transient}
            onChange={(v) =>
              setParams((p) => ({
                ...p,
                psy: {
                  ...p.psy,
                  maskComp: { ...p.psy.maskComp, transient: v },
                },
              }))
            }
            aria="Transient preserve"
          />
          <Num>floor −35.00 dB</Num>
        </CtrlRow>
        <CtrlRow label="Lin x-over">
          <span className="flex items-center gap-2 text-[10px] text-muted-foreground">
            <Switch
              checked={psy.linXover}
              onCheckedChange={(v) =>
                setParams((p) => ({ ...p, psy: { ...p.psy, linXover: v } }))
              }
              aria-label="Linear-phase crossover"
            />
            {psy.linXover ? "On" : "Off"}
          </span>
          <Num>200/900/3.5k/8k · 24 dB</Num>
        </CtrlRow>
      </PsyBlock>
      <PsyBlock
        module="antiPump"
        title="Anti-pump & transients"
        subtitle="Inter-band damping · bass-trigger suppress"
      >
        <CtrlRow label="Anti-pump">
          <OnOff
            aria="Anti-pump logic"
            on={psy.antiPump.on}
            onChange={(v) =>
              setParams((p) => ({
                ...p,
                psy: { ...p.psy, antiPump: { ...p.psy.antiPump, on: v } },
              }))
            }
          />
          <PSlider
            min={0}
            max={100}
            step={1}
            value={psy.antiPump.damping}
            onChange={(v) =>
              setParams((p) => ({
                ...p,
                psy: {
                  ...p.psy,
                  antiPump: { ...p.psy.antiPump, damping: v },
                },
              }))
            }
            aria="Release damping"
          />
          <Num>{psy.antiPump.damping.toFixed(0)}%</Num>
        </CtrlRow>
        <CtrlRow label="Bass supp">
          <PSlider
            min={0}
            max={100}
            step={1}
            value={psy.antiPump.bassSuppress}
            onChange={(v) =>
              setParams((p) => ({
                ...p,
                psy: {
                  ...p.psy,
                  antiPump: { ...p.psy.antiPump, bassSuppress: v },
                },
              }))
            }
            aria="Bass trigger suppress"
          />
          <Num>{psy.antiPump.bassSuppress.toFixed(0)}%</Num>
        </CtrlRow>
        <CtrlRow label="Trans emph">
          <OnOff
            aria="Transient emphasis"
            on={psy.transEmph.on}
            onChange={(v) =>
              setParams((p) => ({
                ...p,
                psy: { ...p.psy, transEmph: { ...p.psy.transEmph, on: v } },
              }))
            }
          />
          <PSlider
            min={1}
            max={10}
            step={0.5}
            value={psy.transEmph.windowMs}
            onChange={(v) =>
              setParams((p) => ({
                ...p,
                psy: {
                  ...p.psy,
                  transEmph: { ...p.psy.transEmph, windowMs: v },
                },
              }))
            }
            aria="Attack window"
          />
          <Num>{psy.transEmph.windowMs.toFixed(1)} ms</Num>
        </CtrlRow>
        <CtrlRow label="Knee">
          <Seg
            ariaLabel="Knee shape"
            value={psy.kneeShape}
            options={(["hard", "soft", "adaptive"] as KneeShape[]).map((k) => ({
              value: k,
              label: k[0].toUpperCase() + k.slice(1),
            }))}
            onChange={(v) =>
              setParams((p) => ({
                ...p,
                psy: { ...p.psy, kneeShape: v as KneeShape },
              }))
            }
          />
          <PSlider
            min={0}
            max={100}
            step={1}
            value={psy.kneeAmount}
            onChange={(v) =>
              setParams((p) => ({ ...p, psy: { ...p.psy, kneeAmount: v } }))
            }
            aria="Knee amount"
          />
          <Num>{psy.kneeAmount.toFixed(0)}%</Num>
        </CtrlRow>
      </PsyBlock>
    </>
  );
}

/* ── LIMITER · 3-stage perceptual limiting ────────────────────────────── */

export function PsyLimiter({
  params,
  setParams,
}: {
  params: ProcessorParams;
  setParams: SetP;
}) {
  const st = params.psy.limStages;
  return (
    <PsyBlock
      module="limStages"
      title="Perceptual stages"
      subtitle="Fast peak · masking density · true-peak/composite"
    >
      <CtrlRow label="Stage 1">
        <OnOff
          aria="Fast peak limiter stage"
          on={st.fastOn}
          onChange={(v) =>
            setParams((p) => ({
              ...p,
              psy: {
                ...p.psy,
                limStages: { ...p.psy.limStages, fastOn: v },
              },
            }))
          }
        />
        <PSlider
          min={0.5}
          max={5}
          step={0.1}
          value={st.lookaheadMs}
          onChange={(v) =>
            setParams((p) => ({
              ...p,
              psy: {
                ...p.psy,
                limStages: { ...p.psy.limStages, lookaheadMs: v },
              },
            }))
          }
          aria="Lookahead"
        />
        <Num>{st.lookaheadMs.toFixed(1)} ms</Num>
      </CtrlRow>
      <CtrlRow label="S1 ceiling">
        <PSlider
          min={-3}
          max={-0.1}
          step={0.1}
          value={st.ceilingDb}
          onChange={(v) =>
            setParams((p) => ({
              ...p,
              psy: {
                ...p.psy,
                limStages: { ...p.psy.limStages, ceilingDb: v },
              },
            }))
          }
          aria="Stage 1 ceiling"
        />
        <PSlider
          min={1}
          max={10}
          step={0.5}
          value={st.attackMs}
          onChange={(v) =>
            setParams((p) => ({
              ...p,
              psy: {
                ...p.psy,
                limStages: { ...p.psy.limStages, attackMs: v },
              },
            }))
          }
          aria="Stage 1 attack"
        />
        <Num>
          {formatDb(st.ceilingDb)} · {st.attackMs.toFixed(1)} ms
        </Num>
      </CtrlRow>
      <CtrlRow label="Stage 2">
        <span className="flex items-center gap-2 text-[10px] text-muted-foreground">
          <Switch
            checked={st.maskOn}
            onCheckedChange={(v) =>
              setParams((p) => ({
                ...p,
                psy: { ...p.psy, limStages: { ...p.psy.limStages, maskOn: v } },
              }))
            }
            aria-label="Masking density limiter"
          />
          {st.maskOn ? "On" : "Off"}
        </span>
        <Num>mask util —%</Num>
      </CtrlRow>
      <CtrlRow label="Stage 3">
        <Seg
          ariaLabel="True-peak oversampling"
          value={String(st.tpOversample)}
          options={["2", "8", "16"].map((o) => ({ value: o, label: `${o}×` }))}
          onChange={(v) =>
            setParams((p) => ({
              ...p,
              psy: {
                ...p.psy,
                limStages: {
                  ...p.psy.limStages,
                  tpOversample: Number(v) as 2 | 8 | 16,
                },
              },
            }))
          }
        />
        <span className="flex items-center gap-2 text-[10px] text-muted-foreground">
          <Switch
            checked={st.ispOn}
            onCheckedChange={(v) =>
              setParams((p) => ({
                ...p,
                psy: { ...p.psy, limStages: { ...p.psy.limStages, ispOn: v } },
              }))
            }
            aria-label="Inter-sample peak elimination"
          />
          ISP
        </span>
        <Num>pilot/RDS safe</Num>
      </CtrlRow>
      <CtrlRow label="Composite">
        <span className="flex items-center gap-2 text-[10px] text-muted-foreground">
          <Switch
            checked={st.compositeProtect}
            onCheckedChange={(v) =>
              setParams((p) => ({
                ...p,
                psy: {
                  ...p.psy,
                  limStages: { ...p.psy.limStages, compositeProtect: v },
                },
              }))
            }
            aria-label="FM composite protection"
          />
          SM.1268
        </span>
        <PSlider
          min={0}
          max={100}
          step={1}
          value={st.multipath}
          onChange={(v) =>
            setParams((p) => ({
              ...p,
              psy: {
                ...p.psy,
                limStages: { ...p.psy.limStages, multipath: v },
              },
            }))
          }
          aria="Multipath reduction"
        />
        <Num>{st.multipath.toFixed(0)}%</Num>
      </CtrlRow>
      <CtrlRow label="Soft/hard">
        <PSlider
          min={0}
          max={100}
          step={1}
          value={st.blend}
          onChange={(v) =>
            setParams((p) => ({
              ...p,
              psy: { ...p.psy, limStages: { ...p.psy.limStages, blend: v } },
            }))
          }
          aria="Soft hard blend"
        />
        <Num>{st.blend.toFixed(0)}%</Num>
      </CtrlRow>
    </PsyBlock>
  );
}

/* ── OUTPUT · dither & compliance ─────────────────────────────────────── */

export function PsyOutput({
  params,
  setParams,
}: {
  params: ProcessorParams;
  setParams: SetP;
}) {
  const psy = params.psy;
  return (
    <>
      <PsyBlock
        module="latency"
        title="Latency profile · LIVE"
        subtitle="Guard oversampling · preset-persisted, wins on apply"
      >
        <CtrlRow label="Latency">
          <Seg
            ariaLabel="Latency profile"
            value={psy.latency}
            options={(["low", "balanced", "max"] as LatencyMode[]).map((m) => ({
              value: m,
              label:
                m === "low"
                  ? "Low <10ms"
                  : m === "balanced"
                    ? "Balanced 32ms"
                    : "Max 96ms",
            }))}
            onChange={(v) =>
              setParams((p) => ({
                ...p,
                psy: { ...p.psy, latency: v as LatencyMode },
              }))
            }
          />
          <Num>{psy.latency === "low" ? "2×" : "4×"} guard</Num>
        </CtrlRow>
      </PsyBlock>
      <PsyBlock
        module="dither"
        title="Mastering dither"
        subtitle="TPDF/RPDF/weighted · 16/24/32-bit"
      >
        <CtrlRow label="Dither">
          <OnOff
            aria="Mastering dither"
            on={psy.dither.on}
            onChange={(v) =>
              setParams((p) => ({
                ...p,
                psy: { ...p.psy, dither: { ...p.psy.dither, on: v } },
              }))
            }
          />
          <Seg
            ariaLabel="Dither type"
            value={psy.dither.type}
            options={[
              { value: "tpdf", label: "TPDF" },
              { value: "rpdf", label: "RPDF" },
              { value: "weighted", label: "Weighted" },
            ]}
            onChange={(v) =>
              setParams((p) => ({
                ...p,
                psy: {
                  ...p.psy,
                  dither: { ...p.psy.dither, type: v as DitherType },
                },
              }))
            }
          />
          <Seg
            ariaLabel="Bit depth"
            value={String(psy.dither.bits)}
            options={["16", "24", "32"].map((b) => ({ value: b, label: `${b}b` }))}
            onChange={(v) =>
              setParams((p) => ({
                ...p,
                psy: {
                  ...p.psy,
                  dither: { ...p.psy.dither, bits: Number(v) as 16 | 24 | 32 },
                },
              }))
            }
          />
          <Num>−110.00 dB</Num>
        </CtrlRow>
      </PsyBlock>
      <PsyBlock
        module="loudLock"
        title="Loudness lock & guard"
        subtitle="Preset target recall · true-peak ceiling"
      >
        <CtrlRow label="Lock">
          <OnOff
            aria="Preset loudness lock"
            on={psy.loudLock.on}
            onChange={(v) =>
              setParams((p) => ({
                ...p,
                psy: { ...p.psy, loudLock: { ...p.psy.loudLock, on: v } },
              }))
            }
          />
          <Seg
            ariaLabel="Lock target"
            value={String(psy.loudLock.targetLufs)}
            options={["-14", "-16", "-18", "-23"].map((t) => ({
              value: t,
              label: `${t} LUFS`,
            }))}
            onChange={(v) =>
              setParams((p) => ({
                ...p,
                psy: {
                  ...p.psy,
                  loudLock: {
                    ...p.psy.loudLock,
                    targetLufs: Number(v) as -14 | -16 | -18 | -23,
                  },
                },
              }))
            }
          />
          <Num>gate {formatDb(psy.loudLock.gateDb)}</Num>
        </CtrlRow>
        <CtrlRow label="TP guard">
          <Seg
            ariaLabel="True-peak ceiling"
            value={String(psy.tpCeilingDb)}
            options={["-0.1", "-0.5", "-1", "-2"].map((t) => ({
              value: t,
              label: `${t}dB`,
            }))}
            onChange={(v) =>
              setParams((p) => ({
                ...p,
                psy: {
                  ...p.psy,
                  tpCeilingDb: Number(v) as -0.1 | -0.5 | -1.0 | -2.0,
                },
              }))
            }
          />
          <Num>8× os · {formatDb(psy.tpCeilingDb)}</Num>
        </CtrlRow>
      </PsyBlock>
    </>
  );
}

/* ── STREAM TX · codec pre-shaping & metadata ─────────────────────────── */

export function PsyStream({
  params,
  setParams,
}: {
  params: ProcessorParams;
  setParams: SetP;
}) {
  const psy = params.psy;
  return (
    <PsyBlock
      module="codecPre"
      title="Codec pre-shaping"
      subtitle="Codec-matched curve · metadata cadence"
    >
      <CtrlRow label="Pre-shape">
        <OnOff
          aria="Codec pre-optimization"
          on={psy.codecPre.on}
          onChange={(v) =>
            setParams((p) => ({
              ...p,
              psy: { ...p.psy, codecPre: { ...p.psy.codecPre, on: v } },
            }))
          }
        />
        <Seg
          ariaLabel="Codec target"
          value={psy.codecPre.target}
          options={(["auto", "mp3", "heaac", "opus"] as CodecTarget[]).map(
            (c) => ({
              value: c,
              label: c === "heaac" ? "HE-AAC" : c[0].toUpperCase() + c.slice(1),
            }),
          )}
          onChange={(v) =>
            setParams((p) => ({
              ...p,
              psy: {
                ...p.psy,
                codecPre: { ...p.psy.codecPre, target: v as CodecTarget },
              },
            }))
          }
        />
        <Num>adapt lowpass</Num>
      </CtrlRow>
      <CtrlRow label="HF preserve">
        <PSlider
          min={0}
          max={100}
          step={1}
          value={psy.codecPre.hfPreserve}
          onChange={(v) =>
            setParams((p) => ({
              ...p,
              psy: {
                ...p.psy,
                codecPre: { ...p.psy.codecPre, hfPreserve: v },
              },
            }))
          }
          aria="HF preserve"
        />
        <Num>{psy.codecPre.hfPreserve.toFixed(0)}%</Num>
      </CtrlRow>
      <CtrlRow label="Meta int">
        <PSlider
          min={1}
          max={30}
          step={1}
          value={psy.metaIntervalS}
          onChange={(v) =>
            setParams((p) => ({ ...p, psy: { ...p.psy, metaIntervalS: v } }))
          }
          aria="Metadata interval"
        />
        <Seg
          ariaLabel="Metadata encoding"
          value={psy.metaEncoding}
          options={[
            { value: "utf8", label: "UTF-8" },
            { value: "latin1", label: "Latin-1" },
          ]}
          onChange={(v) =>
            setParams((p) => ({
              ...p,
              psy: { ...p.psy, metaEncoding: v as "utf8" | "latin1" },
            }))
          }
        />
        <Num>{psy.metaIntervalS.toFixed(0)} s</Num>
      </CtrlRow>
    </PsyBlock>
  );
}

/* ── TELEMETRY · perceptual dashboard + advisor ───────────────────────── */

export function PerceptualBar({ params }: { params: ProcessorParams }) {
  const snap = usePsySnap();
  const m = snap
    ? perceptualMetrics(snap, params.density, params.exciter.mix / 100)
    : null;
  const warn = params.psy.fatigueWarn;
  const cell = (label: string, value: string, hot = false) => (
    <div className="flex min-w-0 flex-col items-end">
      <span className="text-[8px] font-bold tracking-[0.16em] text-muted-foreground uppercase">
        {label}
      </span>
      <span
        className={cn(
          "font-mono text-[13px] tabular-nums",
          hot ? "text-amber-400" : "text-foreground",
        )}
      >
        {value}
      </span>
    </div>
  );
  return (
    <div className="panel rounded-lg p-3">
      <div className="mb-2 flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
        <h2 className="text-[11px] font-semibold tracking-[0.12em] text-foreground/90 uppercase">
          Perceptual dashboard
        </h2>
        <p className="text-[9px] text-muted-foreground">
          House estimates from live meters — not standardized metrics
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        {cell("Fatigue", m ? `${m.fatigue.toFixed(0)}` : "—", !!m && m.fatigue >= warn)}
        {cell("Clarity", m ? `${m.clarity.toFixed(0)}` : "—")}
        {cell("Coherence", m ? `${m.coherence.toFixed(0)}` : "—")}
        {cell("Crest", m ? `${m.crestDb.toFixed(2)} dB` : "—")}
        {cell(
          "LRA",
          snap?.lra !== null && snap?.lra !== undefined
            ? `${snap.lra.toFixed(2)} LU`
            : "—",
        )}
        {cell(
          "Integrated",
          snap?.lufsI !== null && snap?.lufsI !== undefined
            ? `${snap.lufsI.toFixed(2)} LUFS`
            : "—",
        )}
        {cell(
          "Source",
          m
            ? `${m.sourceGuess.kind} ${m.sourceGuess.confidence.toFixed(0)}%`
            : "—",
        )}
      </div>
    </div>
  );
}

export function AdvisorStrip({ params }: { params: ProcessorParams }) {
  const snap = usePsySnap();
  const m = snap
    ? perceptualMetrics(snap, params.density, params.exciter.mix / 100)
    : null;
  const risk =
    !snap || !m
      ? "—"
      : snap.truePeak > params.limiter.ceilingDb - 0.1
        ? "RED — peak at ceiling"
        : snap.truePeak > params.limiter.ceilingDb - 1
          ? "YELLOW — headroom < 1 dB"
          : "GREEN — headroom ok";
  const riskClass = risk.startsWith("RED")
    ? "text-red-400"
    : risk.startsWith("YELLOW")
      ? "text-amber-400"
      : "text-emerald-300";
  return (
    <div className="panel rounded-lg p-3">
      <div className="mb-2 flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
        <h2 className="text-[11px] font-semibold tracking-[0.12em] text-foreground/90 uppercase">
          Advisor
        </h2>
        <p className="text-[9px] text-muted-foreground">
          Heuristic guidance — verify by ear
        </p>
      </div>
      <div className="flex flex-col gap-1 text-[11px]">
        <div className="flex items-center justify-between gap-3">
          <span className="text-muted-foreground">Source detect</span>
          <span className="font-mono tabular-nums">
            {m
              ? `${m.sourceGuess.kind} · ${m.sourceGuess.confidence.toFixed(0)}% conf`
              : "—"}
          </span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-muted-foreground">Clipping risk</span>
          <span className={cn("font-mono font-bold tabular-nums", riskClass)}>
            {risk}
          </span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-muted-foreground">Fatigue</span>
          <span className="font-mono tabular-nums">
            {m
              ? `${m.fatigue.toFixed(0)} / warn ${params.psy.fatigueWarn.toFixed(0)}`
              : "—"}
          </span>
        </div>
      </div>
    </div>
  );
}
