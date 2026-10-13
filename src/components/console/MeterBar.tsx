import {
  BandGrBar,
  GainReductionMeter,
  StereoLevelMeter,
} from "@/components/console/Meters";
import { getEngine } from "@/lib/audio/engine";
import { LUFS_TARGET } from "@/lib/audio/params";
import { cn } from "@/lib/utils";
import { useEffect, useState } from "react";

/** Compact numeric readout that ticks with the engine snapshot. */
function Stat({
  label,
  value,
  unit,
  tone = "fg",
}: {
  label: string;
  value: string;
  unit?: string;
  tone?: "fg" | "ok" | "warn" | "hot";
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[8px] leading-none font-semibold tracking-[0.14em] text-panel-mut uppercase">
        {label}
      </span>
      <span
        className={cn(
          "text-readout text-[12px] leading-none font-semibold",
          tone === "fg" && "text-panel-fg",
          tone === "ok" && "text-meter-ok",
          tone === "warn" && "text-meter-warn",
          tone === "hot" && "text-meter-hot",
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

/**
 * METER BAR — the always-visible StereoTool-style metering strip: stereo
 * input/output bars, loudness, limiter GR and stereo correlation, refreshed
 * from the engine at 150 ms while the canvas bars run at frame rate.
 */
export function MeterBar() {
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

  const powered = s.powered;
  const lufsDelta = s.lufsM - LUFS_TARGET;

  return (
    <div className="border-b border-rack-line bg-[#15181d]">
      <div className="mx-auto flex max-w-[1560px] flex-wrap items-center gap-x-5 gap-y-2 px-4 py-2">
        <div className="flex items-center gap-2">
          <span className="text-[8px] font-bold tracking-[0.16em] text-panel-mut uppercase">
            In
          </span>
          <StereoLevelMeter kind="in" height={40} />
        </div>

        <div className="h-9 w-px bg-rack-line" />

        <div className="flex items-center gap-2">
          <span className="text-[8px] font-bold tracking-[0.16em] text-panel-mut uppercase">
            Out
          </span>
          <StereoLevelMeter kind="out" height={40} />
        </div>

        <div className="h-9 w-px bg-rack-line" />

        <Stat
          label="Loudness"
          value={powered ? fmt(s.lufsM) : "—"}
          unit="LUFS"
          tone={
            !powered
              ? "fg"
              : Math.abs(lufsDelta) <= 1
                ? "ok"
                : Math.abs(lufsDelta) <= 3
                  ? "warn"
                  : "hot"
          }
        />
        <Stat
          label="Target"
          value={LUFS_TARGET.toFixed(2)}
          unit="LU"
        />

        <div className="h-9 w-px bg-rack-line" />

        <div className="flex items-center gap-2">
          <span className="text-[8px] font-bold tracking-[0.16em] text-panel-mut uppercase">
            Lim GR
          </span>
          <GainReductionMeter
            get={() => getEngine().snapshot().gr.limiter}
            maxDb={18}
            height={34}
            width={8}
          />
        </div>

        <div className="h-9 w-px bg-rack-line" />

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

        <div className="ml-auto flex items-center gap-5">
          <Stat
            label="True peak"
            value={powered ? fmt(s.truePeak) : "—"}
            unit="dBTP"
            tone={powered && s.truePeak > -1 ? "hot" : "fg"}
          />
          <Stat
            label="Corr"
            value={powered ? s.correlation.toFixed(2).replace("-", "−") : "—"}
            tone={
              !powered
                ? "fg"
                : s.correlation < 0
                  ? "hot"
                  : s.correlation < 0.3
                    ? "warn"
                    : "ok"
            }
          />
          <Stat
            label="Clip"
            value={s.clipIn || s.clipOut ? "OVER" : "clean"}
            tone={s.clipIn || s.clipOut ? "hot" : "ok"}
          />
        </div>
      </div>
    </div>
  );
}
