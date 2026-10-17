import { useEffect, useState } from "react";
import { getEngine, type MeterSnapshot } from "@/lib/audio/engine";
import { cn } from "@/lib/utils";

interface Stage {
  key: string;
  label: string;
  /** Bypass state from the applied chain; null = always in circuit. */
  on: boolean | null;
  /** Live readout; null = state only (no honest measurement exists). */
  level: string | null;
  live: boolean;
}

/**
 * TMAUDIO ENGINE — the actual processing chain, read from the applied
 * params and the live metering snapshot. Every stage shows ACTIVE/BYPASS
 * plus a processing level only where a real measurement exists; stages
 * with no honest telemetry show state alone, never invented numbers.
 */
export function EngineChain() {
  const [, force] = useState(0);
  useEffect(() => getEngine().subscribe(() => force((n) => n + 1)), []);
  const engine = getEngine();
  const p = engine.appliedParams;
  const s: MeterSnapshot = engine.snapshot();
  const live = s.powered && Math.max(s.outPeakL, s.outPeakR) > -60;

  const db = (v: number) =>
    `${v <= -99 ? "−∞" : v.toFixed(1).replace("-", "−")} dB`;
  const gr = (v: number) =>
    `${v > 0.05 ? v.toFixed(1).replace("-", "−") : "0.0"} dB GR`;

  const stages: Stage[] = [
    {
      key: "input",
      label: "Input",
      on: null,
      level: s.powered ? db(Math.max(s.inPeakL, s.inPeakR)) : null,
      live,
    },
    {
      key: "gate",
      label: "Gate",
      on: p ? p.gate.on : null,
      level: null,
      live: false,
    },
    {
      key: "hpf",
      label: "HPF · Phase",
      on: p ? p.hpf.on || p.phase.on : null,
      level: null,
      live: false,
    },
    {
      key: "eq",
      label: "EQ",
      on: p ? p.eq.on : null,
      level: null,
      live: false,
    },
    {
      key: "deq",
      label: "Dyn-EQ",
      on: p ? p.deq.on : null,
      level:
        s.powered && p?.deq.on
          ? gr(Math.max(0, ...s.gr.deq))
          : null,
      live,
    },
    {
      key: "exciter",
      label: "Exciter",
      on: p ? p.exciter.on : null,
      level: null,
      live: false,
    },
    {
      key: "agc",
      label: "AGC",
      on: p ? p.agc.on : null,
      level: s.powered && p?.agc.on ? gr(s.gr.agc) : null,
      live,
    },
    {
      key: "mb",
      label: "Multiband",
      on: p ? p.multiband.on : null,
      level:
        s.powered && p?.multiband.on
          ? gr(Math.max(0, ...s.gr.bands))
          : null,
      live,
    },
    {
      key: "rider",
      label: "Rider",
      on: p ? p.rider.on : null,
      level:
        s.powered && p?.rider.on
          ? `${s.riderDb >= 0 ? "+" : "−"}${Math.abs(s.riderDb).toFixed(1)} dB`
          : null,
      live,
    },
    {
      key: "deess",
      label: "De-esser",
      on: p ? p.deess.on : null,
      level: s.powered && p?.deess.on ? gr(s.deessCut) : null,
      live,
    },
    {
      key: "limiter",
      label: "Limiter",
      on: p ? p.limiter.on : null,
      level: s.powered && p?.limiter.on ? gr(s.gr.limiter) : null,
      live,
    },
    {
      key: "width",
      label: "Stereo",
      on: null,
      level: p ? `×${p.stereo.width.toFixed(2)}` : null,
      live: false,
    },
    {
      key: "output",
      label: "Output",
      on: null,
      level: s.powered
        ? `${db(Math.max(s.outPeakL, s.outPeakR))} · ${s.truePeak <= -99 ? "−∞" : s.truePeak.toFixed(1).replace("-", "−")} dBTP`
        : null,
      live,
    },
  ];

  return (
    <div
      className="scrollbar-slim flex items-stretch gap-1 overflow-x-auto"
      role="list"
      aria-label="Processing chain"
    >
      {stages.map((st, i) => (
        <div key={st.key} className="flex shrink-0 items-stretch gap-1">
          <div
            role="listitem"
            className={cn(
              "flex w-28 flex-col justify-between gap-1.5 rounded-md border px-2 py-2",
              st.on === false
                ? "border-border/50 bg-muted/20 opacity-60"
                : "border-border/70 bg-card",
            )}
          >
            <p className="flex items-center gap-1.5 text-[9px] font-bold tracking-[0.1em] text-foreground/90 uppercase">
              <span
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  st.on === false
                    ? "bg-panel-mut"
                    : st.live
                      ? "led led-on animate-pulse-live"
                      : "bg-meter-ok/70",
                )}
                aria-hidden
              />
              {st.label}
            </p>
            <p
              className={cn(
                "text-[8px] font-bold tracking-[0.14em] uppercase",
                st.on === false ? "text-panel-mut" : "text-meter-ok",
              )}
            >
              {st.on === null ? "In circuit" : st.on ? "Active" : "Bypass"}
            </p>
            <p className="text-readout min-h-4 text-[10px] text-white">
              {st.level ?? <span className="text-panel-mut">—</span>}
            </p>
          </div>
          {i < stages.length - 1 && (
            <span
              aria-hidden
              className={cn(
                "self-center text-[10px]",
                live ? "animate-pulse-live text-signal" : "text-panel-mut",
              )}
            >
              →
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
