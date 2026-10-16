import { Seg } from "@/components/console/controls";
import { SegmentBar } from "@/components/console/Meters";
import {
  getAlarms,
  subscribeAlarms,
} from "@/lib/audio/alarms";
import { getEngine, type MeterSnapshot } from "@/lib/audio/engine";
import { isConfigured, useOutputs } from "@/lib/audio/outputs";
import type { ProcessorParams } from "@/lib/audio/params";
import { getRuntime, subscribeRuntime } from "@/lib/audio/runtime";
import { cn } from "@/lib/utils";
import { RotateCcw } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";

/* Meter-bridge palette — LED hardware colours on the ultra-dark deck. */
const LED = {
  cyan: "#22d3ee",
  blue: "#4a90e2",
  red: "#ff3b30",
  green: "#4cd964",
  amber: "#ffcc00",
};

const METER_CFG_KEY = "signalpath.meterbar.v1";
type HoldCfg = "off" | "1.5" | "3";
type FallCfg = "slow" | "fast";

function useBridgeSnapshot(intervalMs = 150): MeterSnapshot {
  const [s, setS] = useState(() => getEngine().snapshot());
  useEffect(() => {
    let last = 0;
    return getEngine().subscribe((snap) => {
      const now = performance.now();
      if (now - last >= intervalMs) {
        last = now;
        setS(snap);
      }
    });
  }, [intervalMs]);
  return s;
}

/** One vertical LED bar with its live numeric readout above the bar. */
function Bar({
  caption,
  numeric,
  numericTone = "text-panel-fg",
  get,
  min,
  max,
  zone,
  fromTop = false,
  holdMs,
  decay = 22,
  width = 22,
  height = 76,
}: {
  caption: string;
  numeric: string;
  numericTone?: string;
  get: () => number;
  min: number;
  max: number;
  zone: (db: number) => string;
  fromTop?: boolean;
  holdMs: number;
  decay?: number;
  width?: number;
  height?: number;
}) {
  return (
    <div className="flex shrink-0 flex-col items-center gap-1">
      <span
        className={cn(
          "text-readout text-[10px] leading-none font-semibold tabular-nums",
          numericTone,
        )}
      >
        {numeric}
      </span>
      <div
        className="panel-well rounded-[4px] px-[5px] py-1"
        style={{ width }}
      >
        <SegmentBar
          get={get}
          minDb={min}
          maxDb={max}
          height={height}
          fromTop={fromTop}
          zone={zone}
          decay={decay}
          holdMs={holdMs}
        />
      </div>
      <span className="text-[7px] leading-none font-bold tracking-[0.12em] whitespace-nowrap text-panel-mut uppercase">
        {caption}
      </span>
    </div>
  );
}

function DeckDivider() {
  return (
    <div aria-hidden className="hidden h-[118px] w-px shrink-0 bg-rack-line sm:block" />
  );
}

const fmtPeak = (v: number) =>
  v <= -69.5 ? "−∞" : v.toFixed(1).replace("-", "−");
const fmtGr = (v: number) => `−${Math.max(0, v).toFixed(1)}`;

/**
 * METER BRIDGE — the fixed full-width LED deck: input peaks, AGC and
 * enhancer activity, six multiband GR bars, loudness/limiter/bass
 * reduction, plus the integrated-loudness readout cluster and the
 * station status cluster. Every bar is a real engine measurement.
 */
export function MeterBridge({
  params,
  activePreset,
  dirty = false,
  onConfigureStream,
}: {
  params: ProcessorParams;
  activePreset: string;
  dirty?: boolean;
  onConfigureStream?: () => void;
}) {
  const s = useBridgeSnapshot();
  const powered = s.powered;

  const [cfg, setCfg] = useState<{ hold: HoldCfg; fall: FallCfg }>(() => {
    try {
      const raw = localStorage.getItem(METER_CFG_KEY);
      if (raw)
        return { hold: "1.5", fall: "slow", ...(JSON.parse(raw) as object) };
    } catch {
      /* fall through to defaults */
    }
    return { hold: "1.5", fall: "slow" };
  });
  useEffect(() => {
    try {
      localStorage.setItem(METER_CFG_KEY, JSON.stringify(cfg));
    } catch {
      /* storage may be unavailable */
    }
  }, [cfg]);
  const holdMs = cfg.hold === "off" ? 0 : cfg.hold === "1.5" ? 1500 : 3000;
  const decay = cfg.fall === "fast" ? 40 : 22;

  const [rt, setRt] = useState(() => ({
    onAir: getRuntime().onAir,
    kbps: getRuntime().stats.kbps,
  }));
  useEffect(
    () =>
      subscribeRuntime(() => {
        const r = getRuntime();
        setRt({ onAir: r.onAir, kbps: r.stats.kbps });
      }),
    [],
  );
  const { slots } = useOutputs();
  const configuredIdx = slots.findIndex(isConfigured);
  const alarms = useSyncExternalStore(subscribeAlarms, getAlarms);
  const latestAlarm = alarms[0];

  const engine = getEngine();
  const lufsI = s.lufsI;
  const delta = lufsI !== null ? lufsI - params.rider.targetLufs : null;
  const tpOver = powered && s.truePeak > params.limiter.ceilingDb + 0.05;
  const exciterMix = params.exciter.on ? params.exciter.mix : 0;

  return (
    <div className="border-b border-rack-line bg-[#0b0d11]">
      {/* deck label strip — phones/tablets where the sidebar is hidden */}
      <div className="rack-rail flex items-center justify-between gap-3 px-3 py-1.5 sm:px-4 lg:hidden">
        <span className="flex items-center gap-2 text-[9px] font-bold tracking-[0.22em] text-panel-mut uppercase">
          <span
            className={cn("led size-1.5", powered && "led-on")}
            aria-hidden
          />
          Meter bridge
        </span>
        <span className="text-[9px] font-semibold tracking-[0.14em] text-panel-mut uppercase">
          {powered ? "Live" : "Engine off"}
        </span>
      </div>

      <div className="scrollbar-slim overflow-x-auto">
        {/* centred meter row on every breakpoint: phones wrap into centred
            rows; sm+ keeps one row that safe-centres when it fits and
            stays fully scrollable when it overflows */}
        <div className="mx-auto flex w-full max-w-[1560px] flex-wrap items-stretch justify-center gap-x-4 gap-y-3 px-3 py-2.5 sm:w-max sm:min-w-full sm:flex-nowrap sm:px-4 sm:[justify-content:safe_center]">
          {/* ── input peaks ── */}
          <div className="flex shrink-0 items-start gap-2">
            <span className="flex flex-col items-center gap-1.5 pt-1">
              <span
                className={cn("led size-1.5", powered && s.clipIn && "led-hot")}
                aria-hidden
              />
              <span className="text-[8px] font-bold tracking-[0.16em] text-panel-mut uppercase">
                In
              </span>
            </span>
            <Bar
              caption="L"
              numeric={powered ? fmtPeak(s.inPeakL) : "—"}
              get={() => engine.snapshot().inPeakL}
              min={-60}
              max={0}
              zone={(db) =>
                db >= -3
                  ? LED.red
                  : db >= -6
                    ? LED.amber
                    : db >= -20
                      ? LED.green
                      : "#59616e"
              }
              holdMs={holdMs} decay={decay}
            />
            <Bar
              caption="R"
              numeric={powered ? fmtPeak(s.inPeakR) : "—"}
              get={() => engine.snapshot().inPeakR}
              min={-60}
              max={0}
              zone={(db) =>
                db >= -3
                  ? LED.red
                  : db >= -6
                    ? LED.amber
                    : db >= -20
                      ? LED.green
                      : "#59616e"
              }
              holdMs={holdMs} decay={decay}
            />
          </div>

          <DeckDivider />

          {/* ── AGC + enhancer ── */}
          <div className="flex shrink-0 items-start gap-2.5">
            <Bar
              caption="AGC"
              numeric={powered ? fmtGr(s.gr.agc) : "—"}
              get={() => -Math.max(0, engine.snapshot().gr.agc)}
              min={-15}
              max={0}
              zone={() => LED.cyan}
              fromTop
              holdMs={holdMs} decay={decay}
            />
            <Bar
              caption="ENH"
              numeric={params.exciter.on ? `${params.exciter.mix.toFixed(1)}` : "off"}
              numericTone={params.exciter.on ? "text-cyan-400" : undefined}
              get={() => exciterMix}
              min={0}
              max={12}
              zone={(db) => (db >= 9 ? LED.red : LED.cyan)}
              holdMs={0}
            />
          </div>

          <DeckDivider />

          {/* ── multiband GR (6 bands, blue) ── */}
          <div className="flex shrink-0 items-start gap-[5px]">
            {["SUB", "BASS", "L-MID", "H-MID", "PRES", "AIR"].map((cap, i) => (
              <Bar
                key={cap}
                caption={cap}
                numeric={
                  powered ? fmtGr(s.gr.bands[i] ?? 0) : "—"
                }
                get={() => -Math.max(0, engine.snapshot().gr.bands[i] ?? 0)}
                min={-15}
                max={0}
                zone={() => LED.blue}
                fromTop
                holdMs={holdMs} decay={decay}
                width={20}
              />
            ))}
          </div>

          <DeckDivider />

          {/* ── loudness / limiter / bass ── */}
          <div className="flex shrink-0 items-start gap-2.5">
            <Bar
              caption="LOUD"
              numeric={
                powered
                  ? `${s.riderDb >= 0 ? "+" : "−"}${Math.abs(s.riderDb).toFixed(1)}`
                  : "—"
              }
              get={() => -Math.min(12, Math.abs(engine.snapshot().riderDb))}
              min={-12}
              max={0}
              zone={(db) =>
                db >= -1 ? LED.green : db >= -3 ? LED.amber : LED.red
              }
              fromTop
              holdMs={holdMs} decay={decay}
            />
            <Bar
              caption="LIM"
              numeric={powered ? fmtGr(s.gr.limiter) : "—"}
              numericTone={
                powered && (s.clipOut || tpOver)
                  ? "text-meter-hot"
                  : undefined
              }
              get={() => -Math.max(0, engine.snapshot().gr.limiter)}
              min={-18}
              max={0}
              zone={() => LED.red}
              fromTop
              holdMs={holdMs} decay={decay}
            />
            <Bar
              caption="BASS"
              numeric={powered ? fmtGr(s.gr.bands[0] ?? 0) : "—"}
              get={() => -Math.max(0, engine.snapshot().gr.bands[0] ?? 0)}
              min={-15}
              max={0}
              zone={() => LED.blue}
              fromTop
              holdMs={holdMs} decay={decay}
            />
          </div>

          <DeckDivider />

          {/* ── loudness readout cluster ── */}
          <div className="flex w-full min-w-[228px] items-end justify-center gap-x-5 gap-y-2 rounded-lg px-1 py-0.5 sm:w-auto sm:flex-none">
            <div>
              <div className="flex items-center gap-1.5">
                <span className="text-[8px] font-bold tracking-[0.16em] text-panel-mut uppercase">
                  Integrated
                </span>
                <button
                  type="button"
                  onClick={() => getEngine().resetLoudness()}
                  className="cursor-pointer rounded p-1 text-panel-mut transition-colors hover:bg-white/5 hover:text-panel-fg"
                  aria-label="Reset loudness measurement"
                  title="Reset measurement"
                >
                  <RotateCcw className="size-3" />
                </button>
              </div>
              <p className="text-readout mt-0.5 text-[24px] leading-none font-semibold text-white">
                {!powered ? (
                  <span className="text-panel-mut">—</span>
                ) : lufsI === null ? (
                  <span className="text-[13px] font-medium text-panel-mut">
                    Measuring…
                  </span>
                ) : (
                  <>
                    {lufsI.toFixed(1).replace("-", "−")}
                    <span className="ml-1.5 text-[10px] font-normal text-panel-mut">
                      LUFS
                    </span>
                  </>
                )}
              </p>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="text-[8px] leading-none font-semibold tracking-[0.14em] text-panel-mut uppercase">
                vs target
              </span>
              <span
                className={cn(
                  "rounded border px-1.5 py-1 text-[12px] leading-none font-semibold",
                  delta === null && "border-border/70 text-panel-mut",
                  delta !== null &&
                    Math.abs(delta) <= 1 &&
                    "border-meter-ok/40 bg-meter-ok/10 text-meter-ok",
                  delta !== null &&
                    delta > 1 &&
                    "border-meter-warn/40 bg-meter-warn/10 text-meter-warn",
                  delta !== null &&
                    delta < -1 &&
                    "border-signal/40 bg-signal/10 text-signal",
                )}
              >
                <span className="text-readout">
                  {delta === null
                    ? "—"
                    : `${delta >= 0 ? "+" : "−"}${Math.abs(delta).toFixed(1)} LU`}
                </span>
              </span>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="text-[8px] leading-none font-semibold tracking-[0.14em] text-panel-mut uppercase">
                True peak
              </span>
              <span
                className={cn(
                  "text-readout text-[12px] leading-none font-semibold",
                  tpOver ? "text-meter-hot" : "text-panel-fg",
                )}
              >
                {powered ? `${s.truePeak.toFixed(1).replace("-", "−")}` : "—"}
                <span className="ml-0.5 text-[8px] font-normal text-panel-mut">
                  dBTP
                </span>
              </span>
            </div>
            <div className="ml-auto hidden items-center gap-2 xl:flex">
              <span className="text-[8px] font-semibold tracking-[0.14em] text-panel-mut uppercase">
                Hold
              </span>
              <Seg
                ariaLabel="Peak hold duration"
                value={cfg.hold}
                options={[
                  { value: "off", label: "Off" },
                  { value: "1.5", label: "1.5s" },
                  { value: "3", label: "3s" },
                ]}
                onChange={(hold) => setCfg((c) => ({ ...c, hold }))}
              />
              <span className="text-[8px] font-semibold tracking-[0.14em] text-panel-mut uppercase">
                Fall
              </span>
              <Seg
                ariaLabel="Peak fall speed"
                value={cfg.fall}
                options={[
                  { value: "slow", label: "Slow" },
                  { value: "fast", label: "Fast" },
                ]}
                onChange={(fall) => setCfg((c) => ({ ...c, fall }))}
              />
            </div>
          </div>

          {/* ── station status cluster ── */}
          <div className="flex w-44 shrink-0 flex-col justify-center gap-1.5 rounded-lg border border-rack-line bg-white/[0.02] px-2.5 py-2">
            <p
              className="truncate text-[11px] leading-4 font-semibold text-white"
              title={activePreset}
            >
              {activePreset}
              {dirty && <span className="ml-1.5 text-amber-led">•</span>}
            </p>
            <p
              className={cn(
                "flex items-center gap-1.5 text-[9px] font-bold tracking-[0.12em] uppercase",
                rt.onAir ? "text-[#ff3b30]" : "text-panel-mut",
              )}
            >
              <span
                className={cn(
                  "led size-1.5",
                  rt.onAir && "led-hot animate-pulse-live",
                )}
                aria-hidden
              />
              {rt.onAir
                ? `${rt.kbps.toFixed(1)} kbps on air`
                : configuredIdx >= 0
                  ? "TX ready"
                  : "No output"}
            </p>
            {!rt.onAir && onConfigureStream && (
              <button
                type="button"
                onClick={onConfigureStream}
                className="cursor-pointer rounded border border-signal/40 bg-signal/10 px-2 py-1 text-left text-[9px] font-bold tracking-[0.12em] text-signal uppercase transition-colors hover:bg-signal/20"
              >
                Configure stream
              </button>
            )}
            <p
              className={cn(
                "truncate text-[9px]",
                latestAlarm ? "text-meter-warn" : "text-panel-mut",
              )}
              title={latestAlarm ? latestAlarm.title : "No alarms"}
            >
              {latestAlarm ? `⚠ ${latestAlarm.title}` : "All tolerances holding"}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
