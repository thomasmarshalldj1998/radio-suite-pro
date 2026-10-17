import { FailoverCard } from "@/components/console/FailoverCard";
import { ModuleCard } from "@/components/console/ModuleCard";
import { SourceModule } from "@/components/console/SourceModule";
import { SpectrumCanvas } from "@/components/console/Spectrum";
import { StereoLevelMeter } from "@/components/console/Meters";
import type { SignalMode } from "@/lib/audio/engine";
import { getEngine, type MeterSnapshot } from "@/lib/audio/engine";
import type { ProcessorParams } from "@/lib/audio/params";
import { formatDb, formatHz } from "@/lib/audio/params";
import { cn } from "@/lib/utils";
import { useEffect, useState } from "react";

function useSnap(intervalMs = 150): MeterSnapshot {
  const [snap, setSnap] = useState<MeterSnapshot>(() => getEngine().snapshot());
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

const fmtPeak = (db: number) => (db <= -99 ? "−∞" : db.toFixed(2).replace("-", "−"));

/**
 * INPUT — program source & preamp, test generator with dual-channel metering,
 * and input analysis ahead of the processing chain.
 */
export function InputTab({
  params,
  setParams,
}: {
  params: ProcessorParams;
  setParams: React.Dispatch<React.SetStateAction<ProcessorParams>>;
}) {
  const engine = getEngine();
  const snap = useSnap();
  const powered = snap.powered;

  const [source, setSourceState] = useState(engine.sourceKind);
  const [genOn, setGenOn] = useState(engine.generatorOn);
  const [mode, setMode] = useState<SignalMode>(engine.signalMode);
  useEffect(
    () =>
      engine.subscribe(() => {
        setSourceState((p) => (p === engine.sourceKind ? p : engine.sourceKind));
        setGenOn((p) => (p === engine.generatorOn ? p : engine.generatorOn));
        setMode((p) => (p === engine.signalMode ? p : engine.signalMode));
      }),
    [engine],
  );

  const sourceDetail =
    engine.sourceKind === "mic"
      ? engine.micStatus === "on"
        ? engine.micLabel || "Input device"
        : engine.micStatus === "arming"
          ? "Requesting access…"
          : engine.micStatus === "error"
            ? "Microphone blocked"
            : "No input armed"
      : engine.sourceKind === "signal"
        ? genOn
          ? mode === "tone"
            ? "1 kHz tone · −18 dBFS"
            : "Pink noise · −18 dBFS"
          : "Generator off"
        : engine.fileName || "No file loaded";

  const setGen = (m: SignalMode) => {
    if (engine.sourceKind !== "signal") {
      engine.setSource("signal");
      setSourceState("signal");
    }
    void engine.setSignalMode(m);
    setMode(m);
    setGenOn(true);
  };

  const genOff = () => {
    engine.stopSignalSource();
    setGenOn(false);
  };

  const genBtn = (label: string, active: boolean, onClick: () => void) => (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "rounded border px-3 py-2 text-[11px] font-semibold tracking-[0.1em] uppercase transition-colors",
        active
          ? "border-signal bg-signal/15 text-signal"
          : "border-border/70 text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      {label}
    </button>
  );

  return (
    <div className="grid gap-4 xl:grid-cols-12">
      {/* ── program source & preamp ── */}
      <div className="xl:col-span-7">
        <SourceModule params={params} setParams={setParams} />
      </div>

      {/* ── test generator + dual-channel meters ── */}
      <ModuleCard
        className="xl:col-span-5"
        title="Test generator"
        subtitle="Reference tones · −18 dBFS · L/R input meters"
      >
        <div className="flex flex-wrap gap-2">
          {genBtn(
            "1 kHz −18 dBFS",
            source === "signal" && genOn && mode === "tone",
            () => setGen("tone"),
          )}
          {genBtn(
            "Pink −18 dBFS",
            source === "signal" && genOn && mode === "pink",
            () => setGen("pink"),
          )}
          {genBtn("Gen off", source === "signal" && !genOn, genOff)}
        </div>

        <div className="mt-4 flex items-end justify-between gap-4">
          <div className="min-w-0 flex-1">
            <p className="text-[9px] font-semibold tracking-[0.14em] text-panel-mut uppercase">
              Program bus
            </p>
            <p className="mt-1 truncate text-xs font-medium text-panel-fg">
              {sourceDetail}
            </p>
            <div className="panel-well mt-3 rounded px-2.5 py-2">
              <p className="text-[9px] font-semibold tracking-[0.14em] text-panel-mut uppercase">
                LUFS
              </p>
              <p className="text-readout mt-0.5 text-xl leading-none font-semibold text-white">
                {powered ? snap.lufsIn.toFixed(2).replace("-", "−") : "―"}
                <span className="ml-1 text-[10px] font-normal text-panel-mut">
                  LUFS
                </span>
              </p>
            </div>
          </div>
          <StereoLevelMeter kind="in" height={224} />
        </div>
      </ModuleCard>

      {/* ── dead-air protection ── */}
      <FailoverCard className="xl:col-span-12" />

      {/* ── input analysis ── */}
      <ModuleCard
        className="xl:col-span-12"
        title="Input analysis"
        subtitle="Ghost = input spectrum · lit = chain output"
        right={
          <span className="text-readout hidden text-[10px] text-panel-mut sm:inline">
            FFT {engine.fftSize} · log 20 Hz–20 kHz
          </span>
        }
      >
        <SpectrumCanvas mode="live" height={180} />

        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          {[
            { label: "Source", value: sourceDetail },
            {
              label: "Sample rate",
              value: powered ? `${(engine.sampleRate / 1000).toFixed(2)} kHz` : "—",
            },
            { label: "Engine", value: powered ? "Running" : "Idle — start the engine" },
            { label: "Input L", value: fmtPeak(snap.inPeakL) },
            { label: "Input R", value: fmtPeak(snap.inPeakR) },
            { label: "Clip", value: snap.clipIn ? "OVER" : "clean" },
          ].map((s) => (
            <div key={s.label} className="panel-well rounded-md px-2.5 py-1.5">
              <p className="text-[9px] font-semibold tracking-[0.1em] text-panel-mut uppercase">
                {s.label}
              </p>
              <p
                className={cn(
                  "text-readout mt-0.5 truncate text-[11px] font-medium",
                  s.label === "Clip" && snap.clipIn ? "text-meter-hot" : "text-white",
                )}
              >
                {s.value}
              </p>
            </div>
          ))}
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
          <span
            className={cn(
              "flex items-center gap-1.5 rounded-md border px-2 py-1",
              params.hpf.on
                ? "border-signal/30 bg-signal/10 text-signal"
                : "border-border/70",
            )}
          >
            <span className={cn("led size-1.5", params.hpf.on && "led-on")} />
            HPF {params.hpf.on ? formatHz(params.hpf.freqHz) : "off"}
          </span>
          <button
            type="button"
            onClick={() =>
              setParams((p) => ({
                ...p,
                phase: { ...p.phase, on: !p.phase.on },
              }))
            }
            aria-pressed={params.phase.on}
            aria-label="Phase rotator (4-stage allpass)"
            className={cn(
              "flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1 transition-colors",
              params.phase.on
                ? "border-signal/30 bg-signal/10 text-signal"
                : "border-border/70 text-muted-foreground hover:text-foreground",
            )}
          >
            <span className={cn("led size-1.5", params.phase.on && "led-on")} />
            Phase rot{" "}
            {params.phase.on
              ? `4-stage · ${params.phase.mode === "auto" ? "auto" : `${params.phase.freqHz.toFixed(2)} Hz`}`
              : "bypassed"}
          </button>
          <span className="rounded-md border border-border/70 px-2 py-1">
            Gate {params.gate.on ? `${params.gate.thresholdDb.toFixed(2).replace("-", "−")} dB` : "bypassed"}
          </span>
          <span className="rounded-md border border-border/70 px-2 py-1">
            Preamplifier {formatDb(params.inputGainDb)}
          </span>
          <span className="rounded-md border border-border/70 px-2 py-1">
            Mic processing: echo cancellation, noise suppression and AGC all
            disabled — the chain is the only processor.
          </span>
        </div>
      </ModuleCard>
    </div>
  );
}
