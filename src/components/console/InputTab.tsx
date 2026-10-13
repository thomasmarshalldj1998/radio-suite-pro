import { ModuleCard } from "@/components/console/ModuleCard";
import { SourceModule } from "@/components/console/SourceModule";
import { SpectrumCanvas } from "@/components/console/Spectrum";
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

const fmtPeak = (db: number) => (db <= -99 ? "−∞" : db.toFixed(1).replace("-", "−"));

/**
 * INPUT — program source, preamp, test generator and input metering ahead of
 * the processing chain.
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
        ? engine.signalMode === "tone"
          ? "1 kHz tone · −18 dBFS"
          : "Pink noise · −18 dBFS"
        : engine.fileName || "No file loaded";

  return (
    <div className="grid gap-4 xl:grid-cols-12">
      {/* source, preamp, generator */}
      <div className="xl:col-span-5">
        <SourceModule params={params} setParams={setParams} />
      </div>

      {/* input analysis */}
      <ModuleCard
        className="xl:col-span-7"
        title="Input analysis"
        subtitle="Ghost = input spectrum · lit = chain output"
        right={
          <span className="text-readout hidden text-[10px] text-panel-mut sm:inline">
            FFT {engine.fftSize} · log 20 Hz–20 kHz
          </span>
        }
      >
        <SpectrumCanvas mode="live" height={216} />

        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
          {[
            { label: "Source", value: sourceDetail },
            { label: "Sample rate", value: powered ? `${(snap.powered ? engine.sampleRate / 1000 : 0).toFixed(1)} kHz` : "—" },
            { label: "Engine", value: powered ? "Running" : "Idle — start the engine" },
            { label: "Input L", value: fmtPeak(snap.inPeakL) },
            { label: "Input R", value: fmtPeak(snap.inPeakR) },
            {
              label: "Clip",
              value: snap.clipIn ? "OVER" : "clean",
            },
          ].map((s) => (
            <div key={s.label} className="panel-well rounded-md px-2.5 py-1.5">
              <p className="text-[9px] font-semibold tracking-[0.1em] text-panel-mut uppercase">
                {s.label}
              </p>
              <p
                className={cn(
                  "text-readout mt-0.5 truncate text-[11px] font-medium",
                  s.label === "Clip" && snap.clipIn
                    ? "text-meter-hot"
                    : "text-panel-fg",
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
