/**
 * Monitor route readout for the console header.
 *
 * The header already says whether programme is on air, but not whether any
 * of it reaches a speaker: the meters tap the programme bus, upstream of the
 * monitor stage, so a muted monitor or a monitor routed into a virtual cable
 * looks identical to a healthy console until someone walks out to the rack.
 * This shows the three values that decide it — the monitor bus gain as the
 * node really holds it, the resulting speaker level, and the endpoint the
 * context renders to.
 */
import { useEffect, useState } from "react";
import { getEngine, type MeterSnapshot } from "@/lib/audio/engine";
import { formatDb } from "@/lib/audio/params";
import { cn } from "@/lib/utils";

const SILENT_DB = -99;

export function MonitorReadout() {
  const engine = getEngine();
  const [snap, setSnap] = useState<MeterSnapshot>(() => engine.snapshot());

  useEffect(() => {
    const off = engine.subscribe(() => setSnap(engine.snapshot()));
    return off;
  }, [engine]);

  // Read on every render: the bus value moves with the mute, the level and
  // the sink, none of which are part of the metering snapshot.
  const route = engine.monitorState;
  const programmeDb = Math.max(snap.outPeakL, snap.outPeakR);
  const live = snap.powered && programmeDb > -60;
  const speakerDb = programmeDb + route.gainDb;
  // Before power-on there is no bus to be muted — the readout shows a dash,
  // not an alarm.
  const muted = snap.powered && (route.muted || route.gainDb === -Infinity);

  const monitorText = !snap.powered ? "—" : muted ? "Muted" : formatDb(route.gainDb, 1);
  const levelText =
    !snap.powered || !live || muted || speakerDb <= SILENT_DB
      ? "—"
      : formatDb(speakerDb, 1);

  return (
    <span
      className={cn(
        "hidden items-center gap-3 rounded-lg border px-3 py-1.5 lg:flex",
        muted
          ? "border-meter-warn/45 bg-meter-warn/10"
          : "border-rack-line bg-white/[0.02]",
      )}
      title={
        muted
          ? `Monitor bus muted — programme is metered but not heard. Sink: ${route.sinkLabel}`
          : `Monitor bus ${snap.powered ? formatDb(route.gainDb, 1) : "off"} into “${route.sinkLabel}”`
      }
      aria-label="Monitor output"
    >
      <span
        className={cn(
          "led size-1.5 shrink-0",
          muted ? "led-hot" : live ? "led-on" : "",
        )}
        aria-hidden
      />

      <span className="flex flex-col gap-1">
        <span className="text-[8px] leading-none font-semibold tracking-[0.16em] text-rack-mut uppercase">
          Monitor
        </span>
        <span
          className={cn(
            "text-readout text-[12px] font-semibold tabular-nums",
            muted ? "text-meter-warn" : "text-white",
          )}
        >
          {monitorText}
        </span>
      </span>

      <span className="flex flex-col gap-1">
        <span className="text-[8px] leading-none font-semibold tracking-[0.16em] text-rack-mut uppercase">
          Speakers
        </span>
        <span className="text-readout text-[12px] font-semibold text-white tabular-nums">
          {levelText}
        </span>
      </span>

      <span className="hidden max-w-28 flex-col gap-1 xl:flex">
        <span className="text-[8px] leading-none font-semibold tracking-[0.16em] text-rack-mut uppercase">
          Sink
        </span>
        <span className="truncate text-[11px] font-semibold text-rack-fg">
          {route.sinkLabel}
        </span>
      </span>
    </span>
  );
}
