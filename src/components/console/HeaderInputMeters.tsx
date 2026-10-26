/**
 * Always-visible stereo input meters for the console header.
 *
 * The meter bridge shows L/R too, but it is pinned below the header and only
 * on the console page. An operator working in presets, stations or telemetry
 * still needs to know whether the source is present and whether either
 * channel is about to clip, so the same two measurements (post-trim,
 * pre-processing) are repeated here in a compact form.
 */
import { getEngine, type MeterSnapshot } from "@/lib/audio/engine";
import { cn } from "@/lib/utils";
import { useEffect, useState } from "react";

const MIN_DB = -60;

const fmtDb = (db: number, powered: boolean) => {
  if (!powered) return "—";
  if (!Number.isFinite(db) || db <= -59.95) return "−∞";
  return db.toFixed(1).replace("-", "−");
};

const tone = (db: number) =>
  db >= -3 ? "bg-meter-hot" : db >= -6 ? "bg-meter-warn" : "bg-meter-ok";

export function HeaderInputMeters() {
  const engine = getEngine();
  const [snap, setSnap] = useState<MeterSnapshot>(() => engine.snapshot());

  useEffect(() => {
    let last = 0;
    return engine.subscribe((next) => {
      const now = performance.now();
      if (now - last < 120) return;
      last = now;
      setSnap(next);
    });
  }, [engine]);

  const powered = snap.powered;
  const rows = [
    { label: "L", db: snap.inPeakL },
    { label: "R", db: snap.inPeakR },
  ];

  return (
    <span
      className="hidden items-center gap-3 rounded-lg border border-rack-line bg-white/[0.02] px-3 py-1.5 xl:flex"
      title="Stereo input meters — post-trim, pre-processing, peak per channel"
      aria-label={`Stereo input meters — left ${fmtDb(snap.inPeakL, powered)} dBFS, right ${fmtDb(snap.inPeakR, powered)} dBFS`}
    >
      <span className="flex flex-col gap-1">
        <span className="text-[8px] leading-none font-semibold tracking-[0.16em] text-rack-mut uppercase">
          Input
        </span>
        <span className="flex items-center gap-1">
          <span
            className={cn("led size-1.5", powered && snap.clipIn && "led-hot")}
            aria-hidden
          />
          <span className="text-[8px] leading-none font-bold tracking-[0.12em] text-panel-mut uppercase">
            L/R
          </span>
        </span>
      </span>

      <span className="flex flex-col gap-1">
        {rows.map((row) => {
          const level = Math.max(0, Math.min(1, (row.db - MIN_DB) / -MIN_DB));
          return (
            <span key={row.label} className="flex items-center gap-1.5">
              <span className="w-2 text-[8px] leading-none font-bold text-panel-mut">
                {row.label}
              </span>
              <span className="h-1.5 w-16 overflow-hidden rounded-full bg-input">
                <span
                  className={cn(
                    "block h-full rounded-full transition-[width] duration-100",
                    powered ? tone(row.db) : "bg-white/15",
                  )}
                  style={{ width: `${powered ? level * 100 : 0}%` }}
                />
              </span>
              <span
                className={cn(
                  "text-readout w-8 text-right text-[9px] leading-none font-semibold tabular-nums",
                  powered ? "text-white" : "text-panel-mut",
                )}
              >
                {fmtDb(row.db, powered)}
              </span>
            </span>
          );
        })}
      </span>
    </span>
  );
}
