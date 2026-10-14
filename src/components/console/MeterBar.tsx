import {
  BandGrBar,
  GainReductionMeter,
  StereoLevelMeter,
  TermTip,
} from "@/components/console/Meters";
import { Seg } from "@/components/console/controls";
import { getEngine } from "@/lib/audio/engine";
import { cn } from "@/lib/utils";
import { RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";

const METER_CFG_KEY = "signalpath.meterbar.v1";
type HoldCfg = "off" | "1.5" | "3";
type FallCfg = "slow" | "fast";
interface MeterCfg {
  hold: HoldCfg;
  fall: FallCfg;
}

/** Compact numeric readout that ticks with the engine snapshot. */
function Stat({
  label,
  value,
  unit,
  tone = "fg",
  tip,
}: {
  label: string;
  value: string;
  unit?: string;
  tone?: "fg" | "ok" | "warn" | "hot" | "info";
  tip?: { term: string; definition: string };
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="flex items-center gap-1 text-[8px] leading-none font-semibold tracking-[0.14em] text-panel-mut uppercase">
        {label}
        {tip && <TermTip term={tip.term} definition={tip.definition} />}
      </span>
      <span
        className={cn(
          "text-readout text-[12px] leading-none font-semibold",
          tone === "fg" && "text-panel-fg",
          tone === "ok" && "text-meter-ok",
          tone === "warn" && "text-meter-warn",
          tone === "hot" && "text-meter-hot",
          tone === "info" && "text-signal",
        )}
      >
        {value}
        {unit && (
          <span className="ml-0.5 text-[8px] font-normal text-panel-mut">
            {unit}
          </span>
        )}
      </span>
    </div>
  );
}

const fmt = (v: number) => (v <= -69.5 ? "−∞" : v.toFixed(2).replace("-", "−"));
const fmtMmSs = (ms: number) => {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
};

/**
 * METER BAR — the always-visible broadcast metering section: stereo I/O
 * meters with configurable peak-hold, the loudness panel (integrated with
 * target delta, short-term, momentary, LRA, true/sample peak, measurement
 * duration and reset) and limiter/multiband gain reduction with peaks.
 * All values are real engine measurements — nothing here is simulated.
 */
export function MeterBar({ targetLufs }: { targetLufs: number }) {
  const [s, setS] = useState(() => getEngine().snapshot());
  useEffect(() => {
    let last = 0;
    return getEngine().subscribe((snap) => {
      const now = performance.now();
      if (now - last >= 150) {
        last = now;
        setS(snap);
      }
    });
  }, []);

  const [cfg, setCfg] = useState<MeterCfg>(() => {
    try {
      const raw = localStorage.getItem(METER_CFG_KEY);
      if (raw) return { hold: "1.5", fall: "slow", ...(JSON.parse(raw) as object) };
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

  const powered = s.powered;
  const lufsI = s.lufsI;
  const delta = lufsI !== null ? lufsI - targetLufs : null;
  const deltaTone =
    delta === null
      ? "fg"
      : Math.abs(delta) <= 1
        ? "ok"
        : delta > 1
          ? "warn"
          : "info";
  const deltaLabel =
    delta === null
      ? "—"
      : `${delta >= 0 ? "+" : "−"}${Math.abs(delta).toFixed(1)} LU`;
  const deltaWord =
    delta === null
      ? ""
      : Math.abs(delta) <= 1
        ? "near target"
        : delta > 1
          ? "above target"
          : "below target";
  const tpOver = powered && s.truePeak > -1 + 0.05;

  return (
    <div className="border-b border-rack-line bg-[#15181d]">
      <div className="mx-auto flex max-w-[1560px] flex-wrap items-center gap-x-5 gap-y-3 px-4 py-2.5">
        {/* ── input meters ── */}
        <div className="flex items-center gap-2">
          <span className="text-[8px] font-bold tracking-[0.16em] text-panel-mut uppercase">
            In
          </span>
          <StereoLevelMeter
            kind="in"
            height={40}
            holdMs={holdMs}
            decay={decay}
            showState
          />
        </div>

        <div className="hidden h-16 w-px bg-rack-line sm:block" />

        {/* ── output meters ── */}
        <div className="flex items-center gap-2">
          <span className="text-[8px] font-bold tracking-[0.16em] text-panel-mut uppercase">
            Out
          </span>
          <StereoLevelMeter
            kind="out"
            height={40}
            holdMs={holdMs}
            decay={decay}
            showState
          />
        </div>

        <div className="hidden h-16 w-px bg-rack-line sm:block" />

        {/* ── loudness panel ── */}
        <div className="status-plate flex min-w-[268px] flex-1 flex-wrap items-end gap-x-6 gap-y-2 rounded-lg px-3.5 py-2">
          <div>
            <div className="flex items-center gap-1.5">
              <span className="text-[8px] font-bold tracking-[0.16em] text-panel-mut uppercase">
                Integrated
              </span>
              <TermTip
                term="LUFS-I"
                definition="Gated integrated loudness of the whole measurement so far (BS.1770-4). Shown as Measuring until enough programme has passed."
              />
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
            <p className="text-readout mt-0.5 text-[26px] leading-none font-semibold text-white">
              {!powered ? (
                <span className="text-panel-mut">—</span>
              ) : lufsI === null ? (
                <span className="text-[15px] font-medium text-panel-mut">
                  Measuring…
                </span>
              ) : (
                <>
                  {fmt(lufsI)}
                  <span className="ml-1.5 text-[11px] font-normal text-panel-mut">
                    LUFS-I
                  </span>
                </>
              )}
            </p>
          </div>

          {/* target deviation — neutral semantics, never "louder is better" */}
          <div className="flex flex-col gap-0.5">
            <span className="flex items-center gap-1 text-[8px] leading-none font-semibold tracking-[0.14em] text-panel-mut uppercase">
              vs target
              <TermTip
                term="Target"
                definition="Configured loudness target (rider target in Processing → AGC). The difference is measured integrated loudness minus this target."
              />
            </span>
            <span
              className={cn(
                "flex items-center gap-1.5 rounded border px-1.5 py-1 text-[12px] leading-none font-semibold",
                deltaTone === "ok" &&
                  "border-meter-ok/40 bg-meter-ok/10 text-meter-ok",
                deltaTone === "warn" &&
                  "border-meter-warn/40 bg-meter-warn/10 text-meter-warn",
                deltaTone === "info" &&
                  "border-signal/40 bg-signal/10 text-signal",
                deltaTone === "fg" && "border-border/70 text-panel-mut",
              )}
            >
              <span className="text-readout">{deltaLabel}</span>
              {deltaWord && (
                <span className="text-[8px] font-medium tracking-wide uppercase opacity-80">
                  {deltaWord}
                </span>
              )}
            </span>
          </div>

          <div className="flex flex-wrap items-end gap-x-5 gap-y-2">
            <Stat
              label="LUFS-S"
              value={powered ? fmt(s.lufsS) : "—"}
              unit="LUFS"
              tip={{
                term: "LUFS-S",
                definition:
                  "Short-term loudness — a 3-second sliding window, good for following section-to-section level.",
              }}
            />
            <Stat
              label="LUFS-M"
              value={powered ? fmt(s.lufsM) : "—"}
              unit="LUFS"
              tip={{
                term: "LUFS-M",
                definition:
                  "Momentary loudness — a 400 ms sliding window, fast enough to see hits and pauses.",
              }}
            />
            <Stat
              label="LRA"
              value={
                !powered
                  ? "—"
                  : s.lra === null
                    ? "Measuring"
                    : s.lra.toFixed(1)
              }
              unit={s.lra !== null && powered ? "LU" : undefined}
              tip={{
                term: "LRA",
                definition:
                  "Loudness range (EBU Tech 3342) — the spread between quiet and loud parts of the programme. Null until enough short-term data is measured.",
              }}
            />
            <Stat
              label="Target"
              value={targetLufs.toFixed(2).replace("-", "−")}
              unit="LU"
            />
            <Stat
              label="Measured"
              value={powered ? fmtMmSs(s.measureMs) : "—"}
              tip={{
                term: "Duration",
                definition:
                  "Powered measurement time since the last reset (reset also happens automatically at engine start).",
              }}
            />
            <Stat
              label="True peak"
              value={powered ? fmt(s.truePeak) : "—"}
              unit="dBTP"
              tone={tpOver ? "hot" : "fg"}
              tip={{
                term: "dBTP",
                definition:
                  "Decibels true peak — inter-sample peak measured 4× oversampled; the ceiling the limiter promises.",
              }}
            />
            <Stat
              label="Sample pk"
              value={powered ? fmt(s.samplePeakDb) : "—"}
              unit="dBFS"
              tip={{
                term: "dBFS",
                definition:
                  "Decibels relative to full scale — sample peak levels; 0 dBFS is the digital maximum.",
              }}
            />
          </div>
        </div>

        {/* ── gain reduction ── */}
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <span className="flex items-center gap-1 text-[8px] font-bold tracking-[0.16em] text-panel-mut uppercase">
              Lim GR
              <TermTip
                term="GR"
                definition="Gain reduction — how many dB the stage is turning the signal down right now. PK is the recent peak."
              />
            </span>
            <GainReductionMeter
              get={() => getEngine().snapshot().gr.limiter}
              maxDb={18}
              height={34}
              width={8}
            />
          </div>

          <div className="flex items-center gap-2">
            <span className="text-[8px] font-bold tracking-[0.16em] text-panel-mut uppercase">
              MB GR
            </span>
            <div className="flex items-end gap-[3px]">
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <BandGrBar
                  key={i}
                  get={() => getEngine().snapshot().gr.bands[i] ?? 0}
                  maxDb={15}
                  height={30}
                />
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <span
              className={cn(
                "flex items-center gap-1.5 rounded border px-2 py-1 text-[9px] font-bold tracking-[0.12em] uppercase",
                s.clipOut || tpOver
                  ? "animate-alarm border-meter-hot/50 bg-meter-hot/15 text-meter-hot"
                  : "border-border/70 text-panel-mut",
              )}
            >
              <span
                className={cn(
                  "led size-1.5",
                  (s.clipOut || tpOver) && "led-hot",
                )}
                aria-hidden
              />
              {s.clipOut ? "Output clip" : tpOver ? "True peak over" : "Clean"}
            </span>
            <span
              className={cn(
                "flex items-center gap-1.5 rounded border px-2 py-1 text-[9px] font-bold tracking-[0.12em] uppercase",
                s.clipIn
                  ? "border-meter-hot/50 bg-meter-hot/10 text-meter-hot"
                  : "border-border/70 text-panel-mut",
              )}
            >
              <span
                className={cn("led size-1.5", s.clipIn && "led-hot")}
                aria-hidden
              />
              {s.clipIn ? "Input clip" : "Input clean"}
            </span>
          </div>
        </div>

        {/* ── meter configuration (desktop) ── */}
        <div className="ml-auto hidden items-center gap-2 lg:flex">
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
    </div>
  );
}
