import { useCallback, useEffect, useState } from "react";
import { ModuleCard } from "@/components/console/ModuleCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { getEngine, type MeterSnapshot } from "@/lib/audio/engine";
import {
  DEFAULT_ADVANCED,
  MS_BANDS,
  classifyProgram,
  type AdvancedParams,
} from "@/lib/audio/advanced";
import {
  complianceState,
  complianceTarget,
  loudnessStandard,
} from "@/lib/audio/loudness";
import type { ProcessorParams } from "@/lib/audio/params";
import { cn } from "@/lib/utils";

/* ── control schema (one row per control, 44 px) ───────────────────────── */

type Opt = { value: string; label: string };

type Ctrl =
  | { t: "head"; label: string }
  | { t: "toggle"; label: string; path: string; hint?: string }
  | {
      t: "slider";
      label: string;
      path: string;
      min: number;
      max: number;
      step: number;
      dec?: number;
      unit?: string;
    }
  | { t: "select"; label: string; path: string; options: Opt[] }
  | { t: "text"; label: string; path: string; placeholder?: string }
  | { t: "readout"; label: string; value: (p: ProcessorParams, s: MeterSnapshot) => string };

const N = (
  label: string,
  path: string,
  min: number,
  max: number,
  step = 1,
  dec = 0,
  unit = "",
): Ctrl => ({ t: "slider", label, path, min, max, step, dec, unit });
const T = (label: string, path: string): Ctrl => ({ t: "toggle", label, path });
const E = (label: string, path: string, options: Opt[]): Ctrl => ({
  t: "select",
  label,
  path,
  options,
});
const TXT = (label: string, path: string, placeholder = ""): Ctrl => ({
  t: "text",
  label,
  path,
  placeholder,
});
const RO = (
  label: string,
  value: (p: ProcessorParams, s: MeterSnapshot) => string,
): Ctrl => ({ t: "readout", label, value });
const H = (label: string): Ctrl => ({ t: "head", label });

/* ── path helpers ──────────────────────────────────────────────────────── */

function getAt(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc && typeof acc === "object") return (acc as Record<string, unknown>)[key];
    return undefined;
  }, obj);
}

function setAt<T>(obj: T, path: string, value: unknown): T {
  const keys = path.split(".");
  const clone = Array.isArray(obj) ? [...obj] : { ...(obj as object) };
  let target = clone as Record<string, unknown>;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    const next = target[key];
    const copy = Array.isArray(next) ? [...next] : { ...(next as object) };
    target[key] = copy;
    target = copy as Record<string, unknown>;
  }
  target[keys[keys.length - 1]] = value;
  return clone as T;
}

const STANDARD_OPTS: Opt[] = ["ebu", "atsc", "r128s1", "spotify", "apple"].map(
  (id) => ({ value: id, label: loudnessStandard(id as never).label }),
);

/** Nearest ancestor module with an `on` flag — drives the dimmed state. */
function moduleOn(adv: AdvancedParams, path: string): boolean | null {
  const parts = path.split(".").slice(0, -1);
  while (parts.length > 0) {
    const value = getAt(adv, [...parts, "on"].join("."));
    if (typeof value === "boolean") return value;
    parts.pop();
  }
  return null;
}

function useSnap(ms = 250): MeterSnapshot {
  const [snap, setSnap] = useState<MeterSnapshot>(() => getEngine().snapshot());
  useEffect(() => {
    let last = 0;
    return getEngine().subscribe((s) => {
      const now = performance.now();
      if (now - last >= ms) {
        last = now;
        setSnap(s);
      }
    });
  }, [ms]);
  return snap;
}

/* ── renderer ──────────────────────────────────────────────────────────── */

function AdvancedCard({
  title,
  subtitle,
  rows,
  params,
  setParams,
}: {
  title: string;
  subtitle: string;
  rows: Ctrl[];
  params: ProcessorParams;
  setParams: React.Dispatch<React.SetStateAction<ProcessorParams>>;
}) {
  const snap = useSnap();
  const adv: AdvancedParams = params.advanced ?? DEFAULT_ADVANCED;
  const patch = useCallback(
    (path: string, value: unknown) => {
      setParams((prev) => {
        const current = prev.advanced ?? DEFAULT_ADVANCED;
        // Selects hand back strings; numeric fields must stay numbers so the
        // engine never compares or multiplies a string.
        const before = getAt(current, path);
        const next =
          typeof before === "number" && typeof value === "string" && value.trim() !== ""
            ? Number(value)
            : value;
        return { ...prev, advanced: setAt(current, path, next) };
      });
    },
    [setParams],
  );

  return (
    <ModuleCard title={title} subtitle={subtitle}>
      <div className="overflow-hidden rounded-lg border border-border/60">
        {rows.map((row, i) => {
          if (row.t === "head") {
            return (
              <div
                key={`head-${i}`}
                className="flex h-9 items-center justify-between border-y border-border/50 bg-white/[0.025] px-3 first:border-t-0"
              >
                <span className="text-[9px] font-bold tracking-[0.16em] text-signal uppercase">
                  {row.label}
                </span>
              </div>
            );
          }
          const path = row.t === "readout" ? "" : row.path;
          const raw = path ? getAt(adv, path) : undefined;
          const disabled =
            row.t !== "readout" &&
            path !== "" &&
            moduleOn(adv, path) === false &&
            !path.endsWith(".on");
          const valueText =
            row.t === "slider"
              ? `${Number(raw ?? 0).toFixed(row.dec ?? 0).replace("-", "−")}${row.unit ?? ""}`
              : row.t === "select"
                ? (row.options.find((o) => o.value === raw)?.label ?? String(raw ?? "—"))
                : row.t === "toggle"
                  ? raw
                    ? "On"
                    : "Off"
                  : row.t === "readout"
                    ? row.value(params, snap)
                    : "";
          return (
            <div
              key={`${path || "readout"}-${i}`}
              className={cn(
                "flex h-11 items-center gap-3 border-b border-border/40 px-3 last:border-b-0",
                disabled && "opacity-45",
              )}
            >
              <span className="w-32 shrink-0 truncate text-[10px] font-medium text-muted-foreground">
                {row.label}
              </span>
              <div className="flex min-w-0 flex-1 items-center gap-2">
                {row.t === "toggle" && (
                  <button
                    type="button"
                    role="switch"
                    aria-checked={Boolean(raw)}
                    aria-label={row.label}
                    onClick={() => patch(row.path, !raw)}
                    className={cn(
                      "relative h-5 w-9 cursor-pointer rounded-sm border transition-colors",
                      raw
                        ? "border-signal/70 bg-signal/30"
                        : "border-border/70 bg-input",
                    )}
                  >
                    <span
                      className={cn(
                        "absolute top-0.5 size-3.5 rounded-[1px] transition-all",
                        raw
                          ? "left-[18px] bg-signal shadow-[0_0_8px_rgba(34,211,238,0.55)]"
                          : "left-0.5 bg-muted-foreground",
                      )}
                    />
                  </button>
                )}
                {row.t === "slider" && (
                  <Slider
                    className="w-full max-w-[260px]"
                    min={row.min}
                    max={row.max}
                    step={row.step}
                    value={[Number(raw ?? row.min)]}
                    onValueChange={(v) => patch(row.path, v[0])}
                    aria-label={row.label}
                  />
                )}
                {row.t === "select" && (
                  <Select value={String(raw ?? row.options[0].value)} onValueChange={(v) => patch(row.path, v)}>
                    <SelectTrigger className="h-8 w-[180px]" aria-label={row.label}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {row.options.map((o) => (
                        <SelectItem key={o.value} value={o.value}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                {row.t === "text" && (
                  <Input
                    value={String(raw ?? "")}
                    onChange={(e) => patch(row.path, e.target.value)}
                    placeholder={row.placeholder}
                    aria-label={row.label}
                    className="h-8 max-w-[240px] text-xs"
                  />
                )}
              </div>
              <span className="text-readout w-[92px] shrink-0 truncate text-right text-[11px] font-semibold text-foreground/85 tabular-nums">
                {valueText}
              </span>
            </div>
          );
        })}
      </div>
    </ModuleCard>
  );
}

type PanelProps = {
  params: ProcessorParams;
  setParams: React.Dispatch<React.SetStateAction<ProcessorParams>>;
};

/* ── 1 · restoration ───────────────────────────────────────────────────── */

const restorationRows: Ctrl[] = [
  H("Spectral adaptive noise reduction"),
  T("Noise reduction", "restoration.nr.on"),
  E("Mode", "restoration.nr.mode", [
    { value: "light", label: "Light" },
    { value: "medium", label: "Medium" },
    { value: "heavy", label: "Heavy" },
  ]),
  E("Learn", "restoration.nr.learn", [
    { value: "hold", label: "Hold" },
    { value: "continuous", label: "Continuous" },
  ]),
  N("Attenuation", "restoration.nr.attenuationDb", 0, 24, 1, 0, " dB"),
  E("Floor track", "restoration.nr.floorTrack", [
    { value: "slow", label: "Slow" },
    { value: "normal", label: "Normal" },
    { value: "fast", label: "Fast" },
  ]),
  N("Transient protect", "restoration.nr.transientProtect", 0, 100, 1, 0, " %"),
  H("Impulse & peak restoration"),
  T("Impulse restore", "restoration.impulse.on"),
  N("Sensitivity", "restoration.impulse.sensitivity", 0, 100, 1, 0, " %"),
  N("Reconstruct", "restoration.impulse.reconstruct", 0, 100, 1, 0, " %"),
  E("Oversample", "restoration.impulse.oversample", [
    { value: "4", label: "4×" },
    { value: "8", label: "8×" },
  ]),
  N("Clip threshold", "restoration.impulse.clipThresholdDb", -3, 0, 0.1, 2, " dB"),
  H("Phase linearisation"),
  T("Phase linear", "restoration.phaseLin.on"),
  E("Correction", "restoration.phaseLin.correction", [
    { value: "off", label: "Off" },
    { value: "narrow", label: "Narrow" },
    { value: "medium", label: "Medium" },
    { value: "wide", label: "Wide" },
  ]),
  N("Range from", "restoration.phaseLin.minHz", 20, 200, 1, 0, " Hz"),
  N("Range to", "restoration.phaseLin.maxHz", 100, 500, 1, 0, " Hz"),
  T("Phase monitor", "restoration.phaseLin.monitor"),
  H("Sample-rate converter"),
  T("SRC", "restoration.src.on"),
  E("Target", "restoration.src.target", [
    { value: "auto", label: "Auto" },
    { value: "44.1", label: "44.1" },
    { value: "48", label: "48" },
    { value: "88.2", label: "88.2" },
    { value: "96", label: "96" },
  ]),
  N("Attenuation", "restoration.src.attenuationDb", 60, 160, 1, 0, " dB"),
  E("Dither", "restoration.src.dither", [
    { value: "tpdf", label: "TPDF" },
    { value: "none", label: "None" },
  ]),
  E("Lock", "restoration.src.lock", [
    { value: "auto", label: "Auto" },
    { value: "manual", label: "Manual" },
  ]),
  H("Dynamic range recovery"),
  T("DRR", "restoration.drr.on"),
  N("Expansion", "restoration.drr.expansion", 0, 100, 1, 0, " %"),
  N("Time const", "restoration.drr.timeS", 1, 10, 0.5, 1, " s"),
  N("Crest target", "restoration.drr.crestTargetDb", 6, 14, 1, 0, " dB"),
  N("Depth preserve", "restoration.drr.depthPreserve", 0, 100, 1, 0, " %"),
  H("Selective harmonic generation"),
  T("Harmonics", "restoration.harmonics.on"),
  N("Even", "restoration.harmonics.even", 0, 30, 1, 0, " %"),
  N("Odd", "restoration.harmonics.odd", 0, 30, 1, 0, " %"),
  E("Band", "restoration.harmonics.band", [
    { value: "low", label: "Low" },
    { value: "mid", label: "Mid" },
    { value: "high", label: "High" },
  ]),
  N("Drive", "restoration.harmonics.drive", 0, 100, 1, 0, " %"),
  N("Mix", "restoration.harmonics.mix", 0, 15, 1, 0, " %"),
  H("DC offset & subsonic"),
  T("DC / subsonic", "restoration.dc.on"),
  E("HPF", "restoration.dc.hpfHz", [
    { value: "15", label: "15 Hz" },
    { value: "20", label: "20 Hz" },
    { value: "30", label: "30 Hz" },
    { value: "0", label: "Brickwall" },
  ]),
  E("DC remove", "restoration.dc.dcRemove", [
    { value: "auto", label: "Auto" },
    { value: "manual", label: "Manual" },
  ]),
  E("Phase", "restoration.dc.phase", [
    { value: "linear", label: "Linear" },
    { value: "minimum", label: "Minimum" },
  ]),
  H("Interference rejection"),
  T("Interference", "restoration.interference.on"),
  E("Mains", "restoration.interference.mains", [
    { value: "50", label: "50 Hz" },
    { value: "60", label: "60 Hz" },
  ]),
  T("2nd–8th track", "restoration.interference.harmonics"),
  T("RF blanking", "restoration.interference.rfBlanking"),
  N("De-pop sens", "restoration.interference.dePopSens", 0, 100, 1, 0, " %"),
  H("Input calibration"),
  T("Calibration", "restoration.calibration.on"),
  N("Offset", "restoration.calibration.offsetDb", -6, 6, 0.1, 2, " dB"),
  T("Recall lock", "restoration.calibration.recallLock"),
  E("Auto-null ref", "restoration.calibration.autoNull", [
    { value: "-18", label: "−18 dBFS" },
    { value: "-20", label: "−20 dBFS" },
    { value: "-24", label: "−24 dBFS" },
  ]),
];

export function RestorationSuite(props: PanelProps) {
  return (
    <AdvancedCard
      title="Restoration suite"
      subtitle="Noise · impulse · phase · SRC · DRR · harmonics — all bypassed by default"
      rows={restorationRows}
      {...props}
    />
  );
}

/* ── 2 · intelligent leveling ──────────────────────────────────────────── */

const levelingRows: Ctrl[] = [
  H("Multi-profile AGC"),
  T("Profile levelling", "leveling.agcProfile.on"),
  E("Profile", "leveling.agcProfile.profile", [
    { value: "auto", label: "Auto" },
    { value: "music", label: "Music" },
    { value: "speech", label: "Speech" },
  ]),
  N("Detect sensitivity", "leveling.agcProfile.sensitivity", 0, 100, 1, 0, " %"),
  N("Switch delay", "leveling.agcProfile.switchDelayS", 0, 5, 0.5, 1, " s"),
  N("Music attack", "leveling.agcProfile.music.attackMs", 10, 50, 1, 0, " ms"),
  N("Music release", "leveling.agcProfile.music.releaseMs", 200, 1000, 10, 0, " ms"),
  N("Speech attack", "leveling.agcProfile.speech.attackMs", 1, 10, 0.5, 1, " ms"),
  N("Speech release", "leveling.agcProfile.speech.releaseMs", 50, 200, 5, 0, " ms"),
  H("Lookahead gate"),
  T("Lookahead gate", "leveling.gate.on"),
  N("Lookahead", "leveling.gate.lookaheadMs", 10, 50, 1, 0, " ms"),
  N("Open", "leveling.gate.openDb", -60, -20, 1, 0, " dB"),
  N("Close", "leveling.gate.closeDb", -65, -25, 1, 0, " dB"),
  N("Hold", "leveling.gate.holdMs", 0, 2000, 10, 0, " ms"),
  N("Hysteresis", "leveling.gate.hysteresisDb", 1, 6, 0.5, 1, " dB"),
  E("Release curve", "leveling.gate.curve", [
    { value: "linear", label: "Linear" },
    { value: "log", label: "Log" },
    { value: "exponential", label: "Exponential" },
  ]),
  H("Crest factor manager"),
  T("Crest manager", "leveling.crest.on"),
  N("Target", "leveling.crest.targetDb", 6, 14, 1, 0, " dB"),
  E("Response", "leveling.crest.response", [
    { value: "fast", label: "Fast" },
    { value: "medium", label: "Medium" },
    { value: "slow", label: "Slow" },
  ]),
  T("Hard limit", "leveling.crest.hardLimit"),
  H("Long-term drift corrector"),
  T("Drift corrector", "leveling.drift.on"),
  E("Window", "leveling.drift.windowH", [
    { value: "1", label: "1 h" },
    { value: "6", label: "6 h" },
    { value: "12", label: "12 h" },
    { value: "24", label: "24 h" },
  ]),
  E("Range", "leveling.drift.rangeDb", [
    { value: "1", label: "±1.0 dB" },
    { value: "2", label: "±2.0 dB" },
    { value: "3", label: "±3.0 dB" },
  ]),
  E("Rate", "leveling.drift.rate", [
    { value: "slow", label: "Slow" },
    { value: "normal", label: "Normal" },
    { value: "fast", label: "Fast" },
  ]),
  H("Dual-anchor leveling"),
  T("Dual anchor", "leveling.dualAnchor.on"),
  E("Loudness target", "leveling.dualAnchor.lufsTarget", [
    { value: "-14", label: "−14 LUFS" },
    { value: "-16", label: "−16 LUFS" },
    { value: "-18", label: "−18 LUFS" },
    { value: "-23", label: "−23 LUFS" },
  ]),
  E("Density target", "leveling.dualAnchor.densityTargetDb", [
    { value: "-20", label: "−20 dB" },
    { value: "-18", label: "−18 dB" },
    { value: "-16", label: "−16 dB" },
    { value: "-14", label: "−14 dB" },
  ]),
  N("Balance", "leveling.dualAnchor.balance", 0, 100, 1, 0, " %"),
  H("Per-band transient shaper"),
  T("Transient shaper", "leveling.transient.on"),
  E("Band", "leveling.transient.band", [
    { value: "all", label: "All" },
    { value: "low", label: "Low" },
    { value: "mid", label: "Mid" },
    { value: "high", label: "High" },
  ]),
  N("Attack", "leveling.transient.attack", -100, 100, 1, 0, " %"),
  N("Sustain", "leveling.transient.sustain", -100, 100, 1, 0, " %"),
  N("Range", "leveling.transient.rangeMs", 1, 10, 1, 0, " ms"),
  H("Independent peak / RMS targeting"),
  T("Peak/RMS target", "leveling.peakRms.on"),
  N("Peak ceiling", "leveling.peakRms.peakCeilingDb", -6, 0, 0.1, 2, " dB"),
  N("RMS energy", "leveling.peakRms.rmsTargetDb", -30, -8, 0.5, 1, " dB"),
  N("Link", "leveling.peakRms.link", 0, 100, 1, 0, " %"),
  H("Release-shape curves"),
  T("Release shape", "leveling.releaseShape.on"),
  E("Curve", "leveling.releaseShape.curve", [
    { value: "natural", label: "Natural" },
    { value: "opto", label: "Opto" },
    { value: "program", label: "Program" },
    { value: "linear", label: "Linear" },
  ]),
  N("Hold before decay", "leveling.releaseShape.holdMs", 0, 500, 5, 0, " ms"),
  N("Density in release", "leveling.releaseShape.density", 0, 100, 1, 0, " %"),
  H("Deep silence handling"),
  T("Silence handling", "leveling.silence.on"),
  T("Freeze gain", "leveling.silence.freezeGain"),
  N("Lock time", "leveling.silence.lockS", 0, 30, 1, 0, " s"),
  N("Resume ramp", "leveling.silence.resumeRampMs", 10, 1000, 10, 0, " ms"),
  N("Noise floor fill", "leveling.silence.noiseFill", 0, 100, 1, 0, " %"),
];

export function LevelingSuite(props: PanelProps) {
  return (
    <AdvancedCard
      title="Intelligent leveling"
      subtitle="Profiles · lookahead gate · crest · drift · dual anchor · transients"
      rows={levelingRows}
      {...props}
    />
  );
}

/* ── 3 · compliance ────────────────────────────────────────────────────── */

const complianceRows: Ctrl[] = [
  H("Dual-protocol loudness"),
  T("Dual protocol", "compliance.dual.on"),
  E("Standard A", "compliance.dual.standardA", STANDARD_OPTS),
  E("Standard B", "compliance.dual.standardB", STANDARD_OPTS),
  RO("A · integrated", (p, s) =>
    s.lufsI === null ? "—" : `${s.lufsI.toFixed(2).replace("-", "−")} LUFS`,
  ),
  RO("A · verdict", (p, s) => {
    const t = complianceTarget({
      ...p,
      loudness: {
        ...p.loudness,
        standard: (p.advanced ?? DEFAULT_ADVANCED).compliance.dual.standardA,
      },
    });
    return complianceState(s.lufsI, s.truePeak, t).toUpperCase();
  }),
  RO("B · verdict", (p, s) => {
    const t = complianceTarget({
      ...p,
      loudness: {
        ...p.loudness,
        standard: (p.advanced ?? DEFAULT_ADVANCED).compliance.dual.standardB,
      },
    });
    return complianceState(s.lufsI, s.truePeak, t).toUpperCase();
  }),
  H("Loudness range control"),
  T("LRA control", "compliance.lra.on"),
  E("Target", "compliance.lra.targetLu", [
    { value: "4", label: "4 LU" },
    { value: "6", label: "6 LU" },
    { value: "8", label: "8 LU" },
    { value: "10", label: "10 LU" },
  ]),
  E("Mode", "compliance.lra.mode", [
    { value: "compress", label: "Compress" },
    { value: "expand", label: "Expand" },
  ]),
  E("Response", "compliance.lra.response", [
    { value: "fast", label: "Fast" },
    { value: "medium", label: "Medium" },
    { value: "slow", label: "Slow" },
  ]),
  N("Preserve quiet", "compliance.lra.preserveQuiet", 0, 100, 1, 0, " %"),
  RO("Measured LRA", (p, s) => (s.lra === null ? "—" : `${s.lra.toFixed(1)} LU`)),
  H("True-peak meter"),
  T("True-peak hold", "compliance.truePeak.on"),
  E("Oversampling", "compliance.truePeak.factor", [
    { value: "8", label: "8×" },
    { value: "16", label: "16×" },
    { value: "32", label: "32×" },
  ]),
  E("Ceiling", "compliance.truePeak.ceilingDb", [
    { value: "-0.1", label: "−0.1 dB" },
    { value: "-0.5", label: "−0.5 dB" },
    { value: "-1", label: "−1.0 dB" },
    { value: "-2", label: "−2.0 dB" },
  ]),
  N("Hold time", "compliance.truePeak.holdS", 1, 5, 1, 0, " s"),
  RO("True peak", (p, s) => `${s.truePeak.toFixed(2).replace("-", "−")} dBTP`),
  H("Compliance logging"),
  T("Compliance log", "compliance.log.on"),
  E("Interval", "compliance.log.intervalMin", [
    { value: "1", label: "1 min" },
    { value: "5", label: "5 min" },
    { value: "15", label: "15 min" },
    { value: "60", label: "1 h" },
  ]),
  T("CSV export", "compliance.log.exportCsv"),
  E("Auto-save", "compliance.log.autoSave", [
    { value: "daily", label: "Daily" },
    { value: "weekly", label: "Weekly" },
  ]),
  H("Spectral-weighted gate"),
  T("Weighted gate", "compliance.gate.on"),
  E("Threshold", "compliance.gate.thresholdDb", [
    { value: "-10", label: "−10 dB" },
    { value: "-20", label: "−20 dB" },
    { value: "-30", label: "−30 dB" },
  ]),
  T("K-weighted", "compliance.gate.kWeighted"),
  T("Ignore low freq", "compliance.gate.ignoreLowFreq"),
  T("Ignore noise", "compliance.gate.ignoreNoise"),
  T("Ignore gaps", "compliance.gate.ignoreGaps"),
  H("L/R channel matching"),
  T("Channel match", "compliance.channelMatch.on"),
  E("Level match", "compliance.channelMatch.levelMode", [
    { value: "auto", label: "Auto" },
    { value: "manual", label: "Manual" },
  ]),
  N("Level trim", "compliance.channelMatch.levelTrimDb", -1, 1, 0.1, 2, " dB"),
  E("Phase match", "compliance.channelMatch.phaseMode", [
    { value: "auto", label: "Auto" },
    { value: "manual", label: "Manual" },
  ]),
  N("Phase trim", "compliance.channelMatch.phaseTrimDeg", -5, 5, 0.5, 1, "°"),
  RO("Correlation", (p, s) => s.correlation.toFixed(2)),
];

export function ComplianceSuite(props: PanelProps) {
  return (
    <AdvancedCard
      title="Compliance engine"
      subtitle="Dual protocol · LRA · true peak · logging · gate · channel match"
      rows={complianceRows}
      {...props}
    />
  );
}

/* ── 4 · spatial ───────────────────────────────────────────────────────── */

const spatialRows: Ctrl[] = [
  H("Stereo diffusion"),
  T("Diffusion", "spatial.diffusion.on"),
  N("Width", "spatial.diffusion.width", 0, 100, 1, 0, " %"),
  N("Decorrelation", "spatial.diffusion.decorrelation", 0, 100, 1, 0, " %"),
  N("Frequency", "spatial.diffusion.freqHz", 200, 2000, 10, 0, " Hz"),
  T("Mono safe", "spatial.diffusion.monoSafe"),
  H("Bass spatial alignment"),
  T("Bass alignment", "spatial.bassAlign.on"),
  E("Lock freq", "spatial.bassAlign.lockHz", [
    { value: "80", label: "80 Hz" },
    { value: "100", label: "100 Hz" },
    { value: "120", label: "120 Hz" },
  ]),
  N("Coherence", "spatial.bassAlign.coherence", 0, 100, 1, 0, " %"),
  T("Mono check", "spatial.bassAlign.monoCheck"),
  E("Phase corr", "spatial.bassAlign.phaseCorr", [
    { value: "auto", label: "Auto" },
    { value: "manual", label: "Manual" },
  ]),
  H("Stereo signature match"),
  T("Signature match", "spatial.signature.on"),
  N("Tolerance", "spatial.signature.toleranceDb", 0.1, 1, 0.1, 1, " dB"),
  N("Smooth", "spatial.signature.smooth", 0, 100, 1, 0, " %"),
  RO("Reference", (p) =>
    (p.advanced ?? DEFAULT_ADVANCED).spatial.signature.capturedAt
      ? "Captured"
      : "Not captured",
  ),
  H("Correlation preservation"),
  T("Correlation guard", "spatial.correlation.on"),
  N("Min correlation", "spatial.correlation.minCorrelation", 0.7, 1, 0.01, 2),
  N("Auto-narrow", "spatial.correlation.autoNarrow", 0, 100, 1, 0, " %"),
  E("Alert", "spatial.correlation.alert", [
    { value: "visual", label: "Visual" },
    { value: "audio", label: "Audio" },
  ]),
  H("Headroom allocation"),
  T("Headroom alloc", "spatial.headroom.on"),
  N("Centre protect", "spatial.headroom.centreProtect", 0, 100, 1, 0, " %"),
  N("Side headroom", "spatial.headroom.sideHeadroom", 0, 100, 1, 0, " %"),
  N("Imbalance allow", "spatial.headroom.imbalanceDb", 0, 3, 0.1, 1, " dB"),
  T("Auto redistribute", "spatial.headroom.autoRedistribute"),
  RO("Live correlation", (p, s) => s.correlation.toFixed(2)),
  H("True mono fold & centre lift"),
  T("Mono fold", "spatial.monoFold.on"),
  E("Fold", "spatial.monoFold.fold", [
    { value: "sum", label: "Sum" },
    { value: "phase", label: "Phase-align" },
  ]),
  N("Centre lift", "spatial.monoFold.centreLiftDb", 0, 6, 0.1, 2, " dB"),
  N("Low anchor", "spatial.monoFold.lowAnchorHz", 60, 120, 5, 0, " Hz"),
  T("Collapse warning", "spatial.monoFold.collapseWarning"),
  H("Time & phase scope calibration"),
  T("Scope calibration", "spatial.scopeCal.on"),
  N("L/R offset", "spatial.scopeCal.lrOffsetMs", -5, 5, 0.1, 2, " ms"),
  N("Rotate", "spatial.scopeCal.rotateDeg", -180, 180, 1, 0, "°"),
  T("Group delay display", "spatial.scopeCal.groupDelay"),
  T("Phase rotate detect", "spatial.scopeCal.phaseDetect"),
  H("Stereo enhance — ambience"),
  T("Ambience recovery", "spatial.ambience.on"),
  N("Early reflection", "spatial.ambience.earlyLift", 0, 100, 1, 0, " %"),
  N("Reverb tail", "spatial.ambience.tailRecover", 0, 100, 1, 0, " %"),
  T("No colouration", "spatial.ambience.noColouration"),
];

export function SpatialSuite(props: PanelProps) {
  const [band, setBand] = useState(4);
  const adv = props.params.advanced ?? DEFAULT_ADVANCED;
  return (
    <div className="grid gap-4">
      <ModuleCard
        title="Mid/side EQ — per band"
        subtitle="Ten centres · independent mid and side gain · neutral at 0 dB"
      >
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-[9px] font-semibold tracking-[0.14em] text-muted-foreground uppercase">
              Band
            </span>
            <Select value={String(band)} onValueChange={(v) => setBand(Number(v))}>
              <SelectTrigger className="h-8 w-[120px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MS_BANDS.map((f, i) => (
                  <SelectItem key={f} value={String(i)}>
                    {f >= 1000 ? `${f / 1000}k` : f} Hz
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label className="flex flex-1 flex-col gap-1">
            <span className="text-[9px] font-semibold tracking-[0.14em] text-muted-foreground uppercase">
              Mid {adv.spatial.msEq.bands[band]?.midDb.toFixed(2)} dB
            </span>
            <Slider
              min={-6}
              max={6}
              step={0.1}
              value={[adv.spatial.msEq.bands[band]?.midDb ?? 0]}
              onValueChange={(v) =>
                props.setParams((p) => {
                  const a = p.advanced ?? DEFAULT_ADVANCED;
                  const bands = a.spatial.msEq.bands.map((b, i) =>
                    i === band ? { ...b, midDb: v[0] } : b,
                  );
                  return { ...p, advanced: setAt(a, "spatial.msEq.bands", bands) };
                })
              }
              aria-label="Mid band gain"
            />
          </label>
          <label className="flex flex-1 flex-col gap-1">
            <span className="text-[9px] font-semibold tracking-[0.14em] text-muted-foreground uppercase">
              Side {adv.spatial.msEq.bands[band]?.sideDb.toFixed(2)} dB
            </span>
            <Slider
              min={-6}
              max={6}
              step={0.1}
              value={[adv.spatial.msEq.bands[band]?.sideDb ?? 0]}
              onValueChange={(v) =>
                props.setParams((p) => {
                  const a = p.advanced ?? DEFAULT_ADVANCED;
                  const bands = a.spatial.msEq.bands.map((b, i) =>
                    i === band ? { ...b, sideDb: v[0] } : b,
                  );
                  return { ...p, advanced: setAt(a, "spatial.msEq.bands", bands) };
                })
              }
              aria-label="Side band gain"
            />
          </label>
          <label className="flex w-28 flex-col gap-1">
            <span className="text-[9px] font-semibold tracking-[0.14em] text-muted-foreground uppercase">
              Q {adv.spatial.msEq.bands[band]?.q.toFixed(2)}
            </span>
            <Slider
              min={0.5}
              max={3}
              step={0.1}
              value={[adv.spatial.msEq.bands[band]?.q ?? 1]}
              onValueChange={(v) =>
                props.setParams((p) => {
                  const a = p.advanced ?? DEFAULT_ADVANCED;
                  const bands = a.spatial.msEq.bands.map((b, i) =>
                    i === band ? { ...b, q: v[0] } : b,
                  );
                  return { ...p, advanced: setAt(a, "spatial.msEq.bands", bands) };
                })
              }
              aria-label="Band Q"
            />
          </label>
          <Button
            size="sm"
            variant="outline"
            className="h-8"
            onClick={() =>
              props.setParams((p) => ({
                ...p,
                advanced: setAt(
                  p.advanced ?? DEFAULT_ADVANCED,
                  "spatial.msEq.bands",
                  DEFAULT_ADVANCED.spatial.msEq.bands,
                ),
              }))
            }
          >
            Reset bands
          </Button>
          <button
            type="button"
            onClick={() =>
              props.setParams((p) => {
                const a = p.advanced ?? DEFAULT_ADVANCED;
                return {
                  ...p,
                  advanced: setAt(
                    a,
                    "spatial.msEq.on",
                    !a.spatial.msEq.on,
                  ) as AdvancedParams,
                };
              })
            }
            className={cn(
              "h-8 rounded-sm border px-3 text-[10px] font-semibold tracking-[0.1em] uppercase",
              adv.spatial.msEq.on
                ? "border-signal/60 bg-signal/15 text-signal"
                : "border-border/70 text-muted-foreground",
            )}
          >
            {adv.spatial.msEq.on ? "M/S EQ on" : "M/S EQ off"}
          </button>
        </div>
      </ModuleCard>
      <AdvancedCard
        title="Spatial suite"
        subtitle="Diffusion · bass alignment · signature · correlation guard · headroom"
        rows={spatialRows}
        {...props}
      />
    </div>
  );
}

/* ── 5 · precision EQ ──────────────────────────────────────────────────── */

const eqRows: Ctrl[] = [
  H("Multi-band dynamic EQ"),
  T("Dynamic EQ", "eq.dynamic.on"),
  E("Bands", "eq.dynamic.bands", [
    { value: "4", label: "4" },
    { value: "6", label: "6" },
    { value: "8", label: "8" },
  ]),
  N("Q", "eq.dynamic.q", 0.7, 3, 0.1, 2),
  N("Threshold", "eq.dynamic.thresholdDb", -40, 0, 1, 0, " dB"),
  N("Range", "eq.dynamic.rangeDb", 0, 6, 0.1, 1, " dB"),
  N("Attack", "eq.dynamic.attackMs", 5, 50, 1, 0, " ms"),
  N("Release", "eq.dynamic.releaseMs", 20, 300, 5, 0, " ms"),
  E("Mode", "eq.dynamic.mode", [
    { value: "compress", label: "Compress" },
    { value: "expand", label: "Expand" },
  ]),
  H("Linear-phase crossover"),
  T("Crossover", "eq.crossover.on"),
  E("Order", "eq.crossover.order", [{ value: "24", label: "24 dB/oct" }]),
  E("Type", "eq.crossover.type", [
    { value: "linear", label: "Linear" },
    { value: "minimum", label: "Minimum" },
  ]),
  E("Phase dispersion", "eq.crossover.phase", [
    { value: "zero", label: "Zero" },
    { value: "low", label: "Low" },
    { value: "normal", label: "Normal" },
  ]),
  H("Spectral balance"),
  T("Spectral balance", "eq.spectral.on"),
  N("Shift", "eq.spectral.shift", 0, 100, 1, 0, " %"),
  N("Density limit", "eq.spectral.densityLimit", 0, 100, 1, 0, " %"),
  N("Midrange protect", "eq.spectral.midrangeProtect", 0, 100, 1, 0, " %"),
  N("Decay", "eq.spectral.decayS", 0.5, 5, 0.1, 1, " s"),
  H("Presence & brilliance"),
  T("Presence", "eq.presence.on"),
  N("Presence gain", "eq.presence.presenceGainDb", -6, 6, 0.1, 2, " dB"),
  N("Presence width", "eq.presence.presenceWidth", 0.5, 3, 0.1, 2),
  E("Presence mode", "eq.presence.presenceMode", [
    { value: "natural", label: "Natural" },
    { value: "sharp", label: "Sharp" },
  ]),
  N("Brilliance gain", "eq.presence.brillianceGainDb", -6, 6, 0.1, 2, " dB"),
  E("Air type", "eq.presence.airType", [
    { value: "smooth", label: "Smooth" },
    { value: "sparkle", label: "Sparkle" },
    { value: "open", label: "Open" },
  ]),
  H("Dual-band de-esser"),
  T("Dual de-ess", "eq.deess.on"),
  N("Band 1", "eq.deess.band1.freqHz", 4000, 7000, 100, 0, " Hz"),
  N("Band 1 sens", "eq.deess.band1.sensitivity", 0, 100, 1, 0, " %"),
  N("Band 1 suppress", "eq.deess.band1.suppress", 0, 100, 1, 0, " %"),
  N("Band 2", "eq.deess.band2.freqHz", 7000, 12000, 100, 0, " Hz"),
  N("Band 2 sens", "eq.deess.band2.sensitivity", 0, 100, 1, 0, " %"),
  N("Band 2 suppress", "eq.deess.band2.suppress", 0, 100, 1, 0, " %"),
  T("Monitor sibilance", "eq.deess.monitor"),
  E("Release", "eq.deess.release", [
    { value: "fast", label: "Fast" },
    { value: "slow", label: "Slow" },
  ]),
  H("Adaptive notches"),
  T("Notch filters", "eq.notch.on"),
  N("Notch 1 freq", "eq.notch.notch1.freqHz", 40, 18000, 10, 0, " Hz"),
  N("Notch 1 width", "eq.notch.notch1.widthOct", 0.05, 4, 0.05, 2, " oct"),
  T("Notch 1 track", "eq.notch.notch1.autoTrack"),
  N("Notch 2 freq", "eq.notch.notch2.freqHz", 40, 18000, 10, 0, " Hz"),
  N("Notch 2 width", "eq.notch.notch2.widthOct", 0.05, 4, 0.05, 2, " oct"),
  T("Notch 2 track", "eq.notch.notch2.autoTrack"),
  T("Leakage detect", "eq.notch.leakageDetect"),
  H("Shelving & tilt linearisation"),
  T("Shelves/tilt", "eq.shelves.on"),
  E("Analog shelf", "eq.shelves.analog", [
    { value: "a", label: "A · Warm" },
    { value: "b", label: "B · Neutral" },
    { value: "c", label: "C · Tight" },
  ]),
  N("Digital tilt", "eq.shelves.tiltDb", -3, 3, 0.1, 2, " dB"),
  T("Compensate Q", "eq.shelves.compensateQ"),
  H("Variable-Q peak / dip"),
  T("Variable Q", "eq.variableQ.on"),
  N("Band (1–10)", "eq.variableQ.band", 1, 10, 1, 0),
  N("Q", "eq.variableQ.q", 0.4, 7, 0.1, 2),
  E("Shape", "eq.variableQ.shape", [
    { value: "bell", label: "Bell" },
    { value: "highShelf", label: "High shelf" },
    { value: "lowShelf", label: "Low shelf" },
    { value: "notch", label: "Notch" },
  ]),
  N("Gain", "eq.variableQ.gainDb", -15, 15, 0.1, 2, " dB"),
  H("Low-mid mud gate"),
  T("Mud gate", "eq.mudGate.on"),
  N("Freq", "eq.mudGate.freqHz", 200, 400, 5, 0, " Hz"),
  N("Density limit", "eq.mudGate.density", 0, 100, 1, 0, " %"),
  E("Release", "eq.mudGate.release", [
    { value: "fast", label: "Fast" },
    { value: "slow", label: "Slow" },
  ]),
  N("Keep warmth", "eq.mudGate.keepWarmth", 0, 100, 1, 0, " %"),
  H("Air band"),
  T("Air band", "eq.air.on"),
  E("Corner", "eq.air.corner", [
    { value: "12", label: "12 kHz" },
    { value: "16", label: "16 kHz" },
    { value: "20", label: "20 kHz" },
  ]),
  E("Slope", "eq.air.slope", [
    { value: "6", label: "6 dB/oct" },
    { value: "12", label: "12 dB/oct" },
  ]),
  N("Sparkle", "eq.air.sparkle", 0, 100, 1, 0, " %"),
  T("No sibilance boost", "eq.air.noSibilance"),
];

export function PrecisionEqSuite(props: PanelProps) {
  return (
    <AdvancedCard
      title="Precision EQ"
      subtitle="Dynamic EQ · crossover · spectral balance · presence · de-ess · notches"
      rows={eqRows}
      {...props}
    />
  );
}

/* ── 6 · limiter suite ─────────────────────────────────────────────────── */

const limiterRows: Ctrl[] = [
  H("Variable-window lookahead"),
  T("Variable window", "limiter.window.on"),
  N("Fast window", "limiter.window.fastMs", 0.5, 2, 0.1, 1, " ms"),
  N("Ceiling", "limiter.window.ceilingDb", -0.5, 0, 0.1, 1, " dB"),
  N("Density window", "limiter.window.densityMs", 5, 20, 1, 0, " ms"),
  E("Blending", "limiter.window.blend", [
    { value: "auto", label: "Auto" },
    { value: "manual", label: "Manual" },
  ]),
  N("Attack", "limiter.window.attackMs", 0.1, 5, 0.1, 1, " ms"),
  E("Release", "limiter.window.release", [
    { value: "adaptive", label: "Adaptive" },
    { value: "fixed", label: "Fixed" },
  ]),
  N("Density ctrl", "limiter.window.density", 0, 100, 1, 0, " %"),
  H("Harmonic profile clipping"),
  T("Harmonic clipping", "limiter.harmonics.on"),
  N("Even mix", "limiter.harmonics.even", 0, 100, 1, 0, " %"),
  N("Odd mix", "limiter.harmonics.odd", 0, 100, 1, 0, " %"),
  N("Saturation", "limiter.harmonics.saturation", 0, 50, 1, 0, " %"),
  E("Tone", "limiter.harmonics.tone", [
    { value: "warm", label: "Warm" },
    { value: "balanced", label: "Balanced" },
    { value: "tight", label: "Tight" },
  ]),
  E("Oversample", "limiter.harmonics.oversample", [
    { value: "2", label: "2×" },
    { value: "4", label: "4×" },
    { value: "8", label: "8×" },
  ]),
  T("ISP removal", "limiter.harmonics.ispRemoval"),
  H("FM composite MPX"),
  T("MPX processing", "limiter.mpx.on"),
  N("Pilot", "limiter.mpx.pilotLevelPct", 6, 9, 0.5, 1, " %"),
  T("RDS protect", "limiter.mpx.rdsProtect"),
  T("Stokkemask", "limiter.mpx.stokkemask"),
  E("Mask", "limiter.mpx.maskKhz", [
    { value: "15", label: "15 kHz" },
    { value: "30", label: "30 kHz" },
    { value: "50", label: "50 kHz" },
  ]),
  T("MPX clipper", "limiter.mpx.clipper"),
  N("Multipath reduce", "limiter.mpx.multipath", 0, 100, 1, 0, " %"),
  H("Pre-emphasis correction"),
  T("Pre-emph fix", "limiter.preEmph.on"),
  E("Curve", "limiter.preEmph.curve", [
    { value: "50", label: "50 µs" },
    { value: "75", label: "75 µs" },
    { value: "j17", label: "J17" },
    { value: "flat", label: "Flat" },
  ]),
  E("Apply", "limiter.preEmph.apply", [
    { value: "before", label: "Before limit" },
    { value: "after", label: "After limit" },
  ]),
  N("Compensate HF", "limiter.preEmph.compensateHf", 0, 100, 1, 0, " %"),
  H("Codec pre-shaping"),
  T("Codec shaping", "limiter.codec.on"),
  E("Target", "limiter.codec.target", [
    { value: "auto", label: "Auto" },
    { value: "mp3", label: "MP3" },
    { value: "aac", label: "AAC" },
    { value: "opus", label: "Opus" },
  ]),
  E("Bitrate", "limiter.codec.bitrate", [
    { value: "auto", label: "Auto" },
    { value: "manual", label: "Manual" },
  ]),
  N("Low-pass", "limiter.codec.lowpassHz", 8000, 20000, 100, 0, " Hz"),
  N("HF preserve", "limiter.codec.hfPreserve", 0, 100, 1, 0, " %"),
  H("Undershoot correction"),
  T("Undershoot fix", "limiter.undershoot.on"),
  N("Depth", "limiter.undershoot.depth", 0, 100, 1, 0, " %"),
  E("Recovery", "limiter.undershoot.recovery", [
    { value: "fast", label: "Fast" },
    { value: "normal", label: "Normal" },
  ]),
  N("Window", "limiter.undershoot.windowMs", 1, 5, 1, 0, " ms"),
  H("Multi-stage bypass & solo"),
  T("Stage control", "limiter.stageSolo.on"),
  T("Bypass stage 1", "limiter.stageSolo.bypass1"),
  T("Bypass stage 2", "limiter.stageSolo.bypass2"),
  T("Bypass stage 3", "limiter.stageSolo.bypass3"),
  E("Solo mode", "limiter.stageSolo.solo", [
    { value: "off", label: "Off" },
    { value: "1", label: "Stage 1" },
    { value: "2", label: "Stage 2" },
    { value: "3", label: "Stage 3" },
  ]),
  E("Compare", "limiter.stageSolo.compare", [
    { value: "A", label: "A" },
    { value: "B", label: "B" },
    { value: "C", label: "C" },
    { value: "D", label: "D" },
  ]),
  RO("Snapshots", (p) =>
    `${(p.advanced ?? DEFAULT_ADVANCED).limiter.stageSolo.snapshots} × recall`,
  ),
  H("ISP ceiling safety margin"),
  T("ISP guard", "limiter.isp.on"),
  N("Hard guard", "limiter.isp.guardDb", -3, -0.1, 0.1, 2, " dB"),
  E("Oversample", "limiter.isp.oversample", [
    { value: "16", label: "16×" },
    { value: "32", label: "32×" },
  ]),
  T("Post-encode predict", "limiter.isp.postEncodePredict"),
  H("Bit-depth & format"),
  T("Bit depth", "limiter.bitDepth.on"),
  E("Depth", "limiter.bitDepth.depth", [
    { value: "16", label: "16-bit" },
    { value: "24", label: "24-bit" },
    { value: "32", label: "32-float" },
  ]),
  T("Dither per output", "limiter.bitDepth.ditherPerOutput"),
  T("Auto-apply on source", "limiter.bitDepth.autoApply"),
  H("Output mute / dim / sleep"),
  T("Output management", "limiter.output.on"),
  E("Dim level", "limiter.output.dim", [
    { value: "-10", label: "−10 dB" },
    { value: "-20", label: "−20 dB" },
    { value: "-30", label: "−30 dB" },
  ]),
  N("Fade time", "limiter.output.fadeS", 0, 5, 0.5, 1, " s"),
  N("Auto-sleep", "limiter.output.autoSleepS", 5, 60, 5, 0, " s"),
  T("Wake on signal", "limiter.output.wakeOnSignal"),
];

export function Limiter31Suite(props: PanelProps) {
  return (
    <AdvancedCard
      title="Multi-stage limiter"
      subtitle="Variable window · harmonic clipping · MPX · pre-emph · codec · undershoot"
      rows={limiterRows}
      {...props}
    />
  );
}

/* ── 7 · system intelligence ───────────────────────────────────────────── */

const intelligenceRows: Ctrl[] = [
  H("Source detection & preset switching"),
  T("Auto source", "intelligence.autoSource.on"),
  N("Confidence", "intelligence.autoSource.confidence", 0, 100, 1, 0, " %"),
  N("Switch delay", "intelligence.autoSource.switchDelayS", 0, 10, 0.5, 1, " s"),
  TXT("Music preset", "intelligence.autoSource.musicPreset"),
  TXT("Speech preset", "intelligence.autoSource.speechPreset"),
  TXT("Quiet preset", "intelligence.autoSource.quietPreset"),
  TXT("Loud preset", "intelligence.autoSource.loudPreset"),
  RO("Detected", (p, s) =>
    classifyProgram(s.lufsS, s.truePeak - s.lufsS).toUpperCase(),
  ),
  H("Preset morphing"),
  T("Morphing", "intelligence.morph.on"),
  N("Transition", "intelligence.morph.transitionS", 0, 10, 0.5, 1, " s"),
  E("Crossfade", "intelligence.morph.curve", [
    { value: "linear", label: "Linear" },
    { value: "smooth", label: "Smooth" },
  ]),
  N("History steps", "intelligence.morph.history", 20, 100, 10, 0),
  T("Auto-save", "intelligence.morph.autoSave"),
  H("Gain staging assistant"),
  T("Gain staging", "intelligence.gainStaging.on"),
  N("Warn below", "intelligence.gainStaging.warnDb", 1, 6, 0.5, 1, " dB"),
  N("Critical below", "intelligence.gainStaging.criticalDb", 0.5, 3, 0.5, 1, " dB"),
  T("Auto-trim", "intelligence.gainStaging.autoTrim"),
  RO("Peak headroom", (p, s) => `${(p.limiter.ceilingDb - s.truePeak).toFixed(2)} dB`),
  RO("Limiter GR", (p, s) => `${s.gr.limiter.toFixed(2)} dB`),
  H("Safety watchdog"),
  T("Safety bypass", "intelligence.safety.on"),
  T("Hang detect", "intelligence.safety.hangDetect"),
  N("Timeout", "intelligence.safety.timeoutS", 1, 5, 0.5, 1, " s"),
  E("Action", "intelligence.safety.action", [
    { value: "mute", label: "Mute" },
    { value: "bypass", label: "Bypass" },
    { value: "relay", label: "Relay" },
  ]),
  E("Relay", "intelligence.safety.relay", [
    { value: "nc", label: "NC" },
    { value: "no", label: "NO" },
  ]),
  E("Fail-safe", "intelligence.safety.failSafe", [
    { value: "last", label: "Last" },
    { value: "flat", label: "Flat" },
    { value: "mute", label: "Mute" },
  ]),
  RO("Stalls", (p, s) => String(s.perf.stalls)),
  H("Remote control"),
  T("Remote API", "intelligence.remote.on"),
  E("Protocol", "intelligence.remote.protocol", [
    { value: "osc", label: "OSC" },
    { value: "ws", label: "WebSocket" },
    { value: "both", label: "OSC + WS" },
  ]),
  N("Port", "intelligence.remote.port", 1024, 65535, 1, 0),
  E("Auth", "intelligence.remote.auth", [
    { value: "password", label: "Password" },
    { value: "token", label: "Token" },
  ]),
  TXT("Token", "intelligence.remote.token", "••••••••"),
  H("System health"),
  T("Health dashboard", "intelligence.health.on"),
  RO("Latency", (p, s) =>
    `${(s.perf.baseLatencyMs + s.perf.outputLatencyMs).toFixed(0)} ms`,
  ),
  RO("CPU per frame", (p, s) => `${s.perf.frameMs.toFixed(2)} ms`),
  RO("Clock drift", (p, s) => `${s.perf.driftMs.toFixed(1)} ms`),
  RO("Uptime", (p, s) => `${(s.measureMs / 60000).toFixed(1)} min`),
  H("Auto-save & session restore"),
  T("Auto-save", "intelligence.autosave.on"),
  E("Interval", "intelligence.autosave.intervalMin", [
    { value: "1", label: "1 min" },
    { value: "5", label: "5 min" },
    { value: "15", label: "15 min" },
    { value: "30", label: "30 min" },
  ]),
  T("Restore on start", "intelligence.autosave.restoreOnStart"),
  T("Backup on save", "intelligence.autosave.backup"),
  T("Versioned snapshots", "intelligence.autosave.versioned"),
  H("Hardware integration"),
  T("Hardware", "intelligence.hardware.on"),
  T("MIDI in/out", "intelligence.hardware.midi"),
  T("Learn CC", "intelligence.hardware.learnCC"),
  T("MMC control", "intelligence.hardware.mmc"),
  T("GPIO tally", "intelligence.hardware.gpio"),
  E("Display protocol", "intelligence.hardware.display", [
    { value: "scpi", label: "SCPI" },
    { value: "serial", label: "Serial" },
  ]),
  H("Multi-user & permissions"),
  T("Multi-user", "intelligence.users.on"),
  E("Role", "intelligence.users.role", [
    { value: "operator", label: "Operator" },
    { value: "engineer", label: "Engineer" },
    { value: "admin", label: "Admin" },
  ]),
  T("Lock tabs", "intelligence.users.lockTabs"),
  T("Preset protect", "intelligence.users.presetProtect"),
  T("Log changes", "intelligence.users.logChanges"),
  H("Redundancy & failover"),
  T("Redundancy", "intelligence.redundancy.on"),
  T("Auto-switch input", "intelligence.redundancy.autoSwitch"),
  T("Silence detect", "intelligence.redundancy.silenceDetect"),
  N("Cross-fade", "intelligence.redundancy.crossfadeS", 0, 5, 0.5, 1, " s"),
  T("Dual-engine sync", "intelligence.redundancy.dualEngine"),
  T("Mirror output", "intelligence.redundancy.mirror"),
  H("Update & diagnostics"),
  T("Updates & diagnostics", "intelligence.updates.on"),
  T("Check for updates", "intelligence.updates.check"),
  T("Changelog", "intelligence.updates.changelog"),
  T("Verify install", "intelligence.updates.verifyInstall"),
  T("Clear cache", "intelligence.updates.clearCache"),
  T("Export system info", "intelligence.updates.exportInfo"),
  T("Benchmark DSP load", "intelligence.updates.benchmark"),
  T("Latency test", "intelligence.updates.latencyTest"),
  T("Loopback check", "intelligence.updates.loopback"),
];

export function IntelligenceSuite(props: PanelProps) {
  return (
    <AdvancedCard
      title="System intelligence"
      subtitle="Auto source · morphing · gain staging · watchdog · remote · health"
      rows={intelligenceRows}
      {...props}
    />
  );
}

/* ── 8 · psychoacoustic processing ─────────────────────────────────────── */

const psychoRows: Ctrl[] = [
  H("Perceptual masking limiter"),
  T("Masking limiter", "psycho.masking.on"),
  RO("Bands", () => "24 critical"),
  N("Temporal window", "psycho.masking.windowMs", 5, 50, 1, 0, " ms"),
  N("Distortion floor", "psycho.masking.distortionFloorDb", -60, -20, 1, 0, " dB"),
  N("Mask strength", "psycho.masking.strength", 0, 100, 1, 0, " %"),
  H("Adaptive perceptual reconstruction"),
  T("APR", "psycho.apr.on"),
  E("Mode", "psycho.apr.mode", [
    { value: "light", label: "Light" },
    { value: "medium", label: "Medium" },
    { value: "heavy", label: "Heavy" },
    { value: "auto", label: "Auto" },
  ]),
  N("Harmonic regen", "psycho.apr.harmonicRegen", 0, 60, 1, 0, " %"),
  N("Transient restore", "psycho.apr.transientRestore", 0, 100, 1, 0, " %"),
  H("Fatigue index & listener comfort"),
  T("Fatigue monitor", "psycho.fatigue.on"),
  RO("Fatigue now", (p, s) =>
    `${Math.max(0, Math.min(100, 55 + (s.lufsS + 14) * 4)).toFixed(1)} / 100`,
  ),
  N("Warning threshold", "psycho.fatigue.threshold", 50, 100, 1, 0),
  N("Auto-ease", "psycho.fatigue.autoEase", 0, 100, 1, 0, " %"),
  H("Spectral loudness balance"),
  T("Spectral balance", "psycho.spectralBalance.on"),
  N("Perceptual tilt", "psycho.spectralBalance.tiltDb", -2, 2, 0.1, 2, " dB"),
  E("Equal-loudness", "psycho.spectralBalance.contour", [
    { value: "40", label: "40 phon" },
    { value: "60", label: "60 phon" },
    { value: "80", label: "80 phon" },
  ]),
  N("Smooth", "psycho.spectralBalance.smooth", 0, 100, 1, 0, " %"),
  H("Sibilance & harshness psycho-control"),
  T("Harshness control", "psycho.harshness.on"),
  N("Ear-model detect", "psycho.harshness.detectMaxHz", 2000, 16000, 500, 0, " Hz"),
  T("Pre-mask", "psycho.harshness.preMask"),
  N("Gentle suppress", "psycho.harshness.suppress", 0, 100, 1, 0, " %"),
  H("Low-frequency perceptual alignment"),
  T("Low alignment", "psycho.lowAlign.on"),
  N("Bass-body balance", "psycho.lowAlign.bassBodyHz", 60, 200, 5, 0, " Hz"),
  N("Kick anchor", "psycho.lowAlign.kickAnchorHz", 60, 90, 5, 0, " Hz"),
  N("Warmth zone", "psycho.lowAlign.warmthHz", 200, 400, 5, 0, " Hz"),
  T("Bleed protect", "psycho.lowAlign.bleedProtect"),
];

export function PsychoSuite(props: PanelProps) {
  return (
    <AdvancedCard
      title="Psychoacoustic processing"
      subtitle="Masking · APR · fatigue · contours · harshness · low-frequency alignment"
      rows={psychoRows}
      {...props}
    />
  );
}

/* ── 9 · preset, telemetry & logging system ────────────────────────────── */

const presetRows: Ctrl[] = [
  H("Preset management"),
  T("Folders / categories", "presets.folders"),
  T("Search / filter", "presets.search"),
  T("Lock / protect", "presets.lock"),
  T("Read-only", "presets.readOnly"),
  T("Factory / user split", "presets.factoryUser"),
  T("Import / export .spreset", "presets.importExport"),
  TXT("Version tag", "presets.version", "3.1"),
  TXT("Author", "presets.author", "Signalpath"),
  TXT("Notes", "presets.notes", "Session notes"),
  H("A/B/C/D compare"),
  T("Compare system", "presets.compare"),
  T("Overlay meter graphs", "presets.overlay"),
  RO("Slots", () => "4 parallel · A/B/C/D"),
  H("Meter hold & snapshot"),
  T("Meter hold", "presets.meterHold"),
  T("Freeze display", "presets.freeze"),
  T("Save image/PDF", "presets.saveImage"),
  H("Stream health & event log"),
  T("Stream health log", "presets.streamHealth"),
  T("Email alert", "presets.emailAlert"),
  TXT("Webhook", "presets.webhook", "https://…"),
  H("Loudness compliance report"),
  T("Daily summary", "presets.dailySummary"),
  T("Weekly compliance %", "presets.weeklyCompliance"),
  E("Platform preset", "presets.platform", [
    { value: "youtube", label: "YouTube" },
    { value: "spotify", label: "Spotify" },
    { value: "appleMusic", label: "Apple Music" },
    { value: "alexa", label: "Alexa" },
    { value: "fm", label: "FM" },
    { value: "dab", label: "DAB" },
  ]),
];

export function PresetSystemSuite(props: PanelProps) {
  return (
    <AdvancedCard
      title="Preset & telemetry system"
      subtitle="Library · A/B/C/D · meter hold · stream health · compliance reports"
      rows={presetRows}
      {...props}
    />
  );
}
