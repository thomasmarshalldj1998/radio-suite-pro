import { getEngine, type MeterSnapshot } from "@/lib/audio/engine";
import { getFm, subscribeFm, type FmSnapshot } from "@/lib/audio/fm";
import { formatDb, type ProcessorParams } from "@/lib/audio/params";
import { getRuntime, subscribeRuntime } from "@/lib/audio/runtime";
import { getOutputs, isConfigured } from "@/lib/audio/outputs";
import { cn } from "@/lib/utils";
import { useEffect, useState } from "react";

export type FlowTarget = "input" | "processing" | "encoder";

interface Stage {
  id: string;
  name: string;
  /** Short configuration summary (always known — from real params). */
  detail: string;
  /** Whether the stage is in circuit (real engine params). */
  enabled: boolean;
  /** Measured gain reduction in dB — null when the engine is not running. */
  grDb: number | null;
  /** Measured signal activity — only true with live engine data. */
  active: boolean;
  /** Measured warning (clip / true-peak / stalled TX / probe error). */
  warn: boolean;
  target: FlowTarget;
}

const grMax = (arr: number[]) => arr.reduce((m, v) => Math.max(m, v), 0);

/**
 * SIGNAL PATH — Input → Preamp → EQ → Dyn-EQ → AGC → Multiband → Limiter →
 * Output → Stream TX. The AGC leveller sits ahead of the multiband stage
 * so its leveled output is the multiband input reference. Configuration
 * status always comes from the real
 * params; activity and gain reduction are only shown while the engine is
 * actually running, so a lit stage always means measured signal.
 */
export function SignalFlow({
  params,
  onSelect,
}: {
  params: ProcessorParams;
  onSelect: (t: FlowTarget) => void;
}) {
  const [snap, setSnap] = useState<MeterSnapshot>(() => getEngine().snapshot());
  useEffect(() => {
    let last = 0;
    return getEngine().subscribe((s) => {
      const now = performance.now();
      if (now - last >= 200) {
        last = now;
        setSnap(s);
      }
    });
  }, []);

  const [onAir, setOnAir] = useState(getRuntime().onAir);
  useEffect(
    () => subscribeRuntime(() => setOnAir(getRuntime().onAir)),
    [],
  );

  const [fmSnap, setFmSnap] = useState<FmSnapshot>(() => getFm());
  useEffect(() => subscribeFm(() => setFmSnap(getFm())), []);

  const s = snap;
  const powered = s.powered;
  const engine = getEngine();
  const sourceLabel =
    engine.sourceKind === "mic"
      ? engine.micLabel || "Microphone"
      : engine.sourceKind === "file"
        ? engine.fileName || "File"
        : engine.generatorOn
          ? engine.signalMode === "tone"
            ? "1 kHz tone"
            : "Pink noise"
          : "Signal gen off";
  const inActive = powered && Math.max(s.inPeakL, s.inPeakR) > -60;
  const outActive = powered && Math.max(s.outPeakL, s.outPeakR) > -60;
  const configured = getOutputs().slots.some(isConfigured);
  const rt = getRuntime();

  const stages: Stage[] = [
    {
      id: "in",
      name: "Input",
      detail: sourceLabel,
      enabled: true,
      grDb: null,
      active: inActive,
      warn: powered && s.clipIn,
      target: "input",
    },
    {
      id: "pre",
      name: "Preamp",
      detail: formatDb(params.inputGainDb),
      enabled: true,
      grDb: null,
      active: inActive,
      warn: false,
      target: "input",
    },
    {
      id: "eq",
      name: "EQ",
      detail: params.eq.on ? "6-band tone" : "in circuit",
      enabled: params.eq.on,
      grDb: null,
      active: powered && params.eq.on,
      warn: false,
      target: "processing",
    },
    {
      id: "deq",
      name: "Dyn-EQ",
      detail: "5-band dynamic",
      enabled: params.deq.on,
      grDb: powered ? Math.max(0, grMax(s.gr.deq)) : null,
      active: powered && params.deq.on && grMax(s.gr.deq) > 0.1,
      warn: false,
      target: "processing",
    },
    {
      id: "agc",
      name: "AGC",
      detail: params.rider.on ? "leveller + rider" : "leveller",
      enabled: params.agc.on,
      grDb: powered ? s.gr.agc : null,
      active: powered && params.agc.on && s.gr.agc > 0.1,
      warn: false,
      target: "processing",
    },
    {
      id: "mb",
      name: "Multiband",
      detail: "6-band · LR4",
      enabled: params.multiband.on,
      grDb: powered ? grMax(s.gr.bands) : null,
      active: powered && params.multiband.on && grMax(s.gr.bands) > 0.1,
      warn: false,
      target: "processing",
    },
    {
      id: "lim",
      name: "Limiter",
      detail: `${params.limiter.ceilingDb.toFixed(2).replace("-", "−")} dBTP`,
      enabled: params.limiter.on,
      grDb: powered ? s.gr.limiter : null,
      active: powered && params.limiter.on && s.gr.limiter > 0.1,
      warn:
        powered &&
        (s.clipOut || s.truePeak > params.limiter.ceilingDb + 0.05),
      target: "processing",
    },
    {
      id: "out",
      name: "Output",
      detail: formatDb(params.outputGainDb),
      enabled: true,
      grDb: null,
      active: outActive,
      warn: false,
      target: "processing",
    },
    {
      id: "fm",
      name: "FM MPX",
      detail: params.fm.on
        ? `${params.fm.emphasis === "off" ? "flat" : `${params.fm.emphasis} µs`} · ${(fmSnap.stats?.modPct ?? 0).toFixed(0)}% mod`
        : "bypassed",
      enabled: params.fm.on,
      grDb: null,
      active: powered && params.fm.on && (fmSnap.stats?.modPct ?? 0) > 1,
      warn: params.fm.on && (fmSnap.stats?.sustainedOver ?? false),
      target: "encoder",
    },
    {
      id: "tx",
      name: "Stream TX",
      detail: onAir
        ? `${rt.stats.kbps.toFixed(1)} kbps`
        : configured
          ? "configured · idle"
          : "no output",
      enabled: onAir || configured,
      grDb: null,
      active: onAir && rt.stats.kbps > 0,
      warn: onAir && rt.stats.kbps <= 0,
      target: "encoder",
    },
  ];

  return (
    <section
      aria-label="Signal path"
      className="panel mt-3 rounded-lg px-3 py-2.5"
    >
      <div className="mb-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <div className="flex items-baseline gap-2.5">
          <h2 className="text-[10px] font-bold tracking-[0.16em] text-foreground/90 uppercase">
            Signal path
          </h2>
          <p className="text-[9px] text-muted-foreground">
            Input → preamp → chain → limiter → output → transmitter
          </p>
        </div>
        <span
          className={cn(
            "flex items-center gap-1.5 rounded border px-2 py-0.5 text-[9px] font-semibold tracking-[0.1em] uppercase",
            powered
              ? "border-meter-ok/40 bg-meter-ok/10 text-meter-ok"
              : "border-border/70 text-panel-mut",
          )}
        >
          <span className={cn("led size-1.5", powered && "led-on")} aria-hidden />
          {powered ? "Measured live" : "Config only — engine off"}
        </span>
      </div>

      <div className="scrollbar-slim flex items-stretch gap-1.5 overflow-x-auto pb-1">
        {stages.map((st, i) => (
          <div key={st.id} className="flex shrink-0 items-stretch gap-1.5">
            <button
              type="button"
              onClick={() => onSelect(st.target)}
              title={`Open ${st.name} settings`}
              className={cn(
                "min-w-[104px] flex-1 rounded-md border px-2.5 py-1.5 text-left transition-colors",
                st.warn
                  ? "border-meter-hot/60 bg-meter-hot/10"
                  : st.enabled
                    ? "border-border/70 bg-card hover:border-signal/60 hover:bg-signal/5"
                    : "border-border/50 bg-muted/30 opacity-70 hover:opacity-100",
              )}
            >
              <span className="flex items-center gap-1.5">
                <span
                  className={cn(
                    "led size-1.5 shrink-0",
                    st.warn
                      ? "led-hot"
                      : st.active
                        ? "led-on"
                        : st.enabled && "led-warn",
                  )}
                  aria-hidden
                />
                <span className="truncate text-[10px] font-bold tracking-[0.08em] text-foreground uppercase">
                  {st.name}
                </span>
              </span>
              <span className="mt-0.5 block truncate text-[9px] text-muted-foreground">
                {st.detail}
              </span>
              <span className="mt-1 flex items-center gap-1">
                <span
                  className={cn(
                    "rounded px-1 py-0.5 text-[8px] font-bold tracking-wider uppercase",
                    st.enabled
                      ? "bg-signal/15 text-signal"
                      : "bg-amber-led/15 text-amber-led",
                  )}
                >
                  {st.enabled ? "On" : "Bypass"}
                </span>
                {st.grDb !== null && (
                  <span className="text-readout rounded bg-meter-warn/15 px-1 py-0.5 text-[8px] font-bold text-meter-warn">
                    −{st.grDb.toFixed(1)} dB
                  </span>
                )}
                {st.grDb === null && powered && st.active && (
                  <span className="rounded bg-meter-ok/15 px-1 py-0.5 text-[8px] font-bold text-meter-ok">
                    SIG
                  </span>
                )}
                {!powered && (
                  <span className="rounded bg-white/5 px-1 py-0.5 text-[8px] font-medium text-panel-mut">
                    idle
                  </span>
                )}
              </span>
            </button>
            {i < stages.length - 1 && (
              <span
                aria-hidden
                className="self-center text-[9px] text-rack-mut/70"
              >
                ▸
              </span>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
