import { Brand } from "@/components/Brand";
import { LogoDropdown } from "@/components/LogoDropdown";
import { EncoderPanel } from "@/components/console/EncoderPanel";
import { InputTab } from "@/components/console/InputTab";
import { MeterBar } from "@/components/console/MeterBar";
import { PresetPanel } from "@/components/console/PresetPanel";
import { ProcessingTab } from "@/components/console/ProcessingTab";
import { SignalFlow } from "@/components/console/SignalFlow";
import { TelemetryTab } from "@/components/console/TelemetryTab";
import { Button } from "@/components/ui/button";
import {
  useConnectionState,
  usePushLog,
} from "@/lib/backend/hooks";
import {
  fireAlarm,
  getAlarms,
  subscribeAlarms,
} from "@/lib/audio/alarms";
import { getEngine } from "@/lib/audio/engine";
import { getFm, stopFm, syncFm } from "@/lib/audio/fm";
import { getOutputs, isConfigured, useOutputs } from "@/lib/audio/outputs";
import {
  DEFAULT_PARAMS,
  cloneParams,
  coerceParams,
  sourceParams,
  type ProcessorParams,
} from "@/lib/audio/params";
import { getRuntime, subscribeRuntime } from "@/lib/audio/runtime";
import { cn } from "@/lib/utils";
import { APP_NAME, APP_VERSION } from "@/lib/version";
import {
  Activity,
  Antenna,
  Mic,
  Power,
  RotateCcw,
  SlidersHorizontal,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { toast } from "sonner";

const STORAGE_KEY = "signalpath.params.v2";
const LEGACY_STORAGE_KEY = "signalpath.params.v1";
const START_TIMEOUT_MS = 12_000;

type TabId = "input" | "processing" | "encoder" | "presets" | "telemetry";

const TABS: { id: TabId; label: string; icon: LucideIcon; hint: string }[] = [
  { id: "input", label: "Input", icon: Mic, hint: "Source · preamp · analysis" },
  {
    id: "processing",
    label: "Processing",
    icon: SlidersHorizontal,
    hint: "EQ → Dyn-EQ → MB → AGC → Limit",
  },
  {
    id: "encoder",
    label: "Stream TX",
    icon: Antenna,
    hint: "Transmitter · mounts · metadata",
  },
  { id: "presets", label: "Presets", icon: Sparkles, hint: "Station presets · library" },
  { id: "telemetry", label: "Telemetry", icon: Activity, hint: "Compliance · diagnostics · health" },
];

/**
 * Engine lifecycle — derived from the actual engine plus the start request
 * in flight. "starting" is the user's request; "running" only appears once
 * engine.powered confirms the graph is up. Degraded = running with measured
 * problems (clip, adaptive throttling, clock drift).
 */
type EnginePhase = "offline" | "starting" | "running" | "degraded" | "error";

const PHASE_META: Record<
  EnginePhase,
  { label: string; chip: string; led: string }
> = {
  offline: {
    label: "Offline",
    chip: "border border-rack-line text-rack-mut",
    led: "",
  },
  starting: {
    label: "Starting…",
    chip: "border border-meter-warn/50 bg-meter-warn/10 text-meter-warn",
    led: "led-warn animate-pulse-live",
  },
  running: {
    label: "Running",
    chip: "border border-meter-ok/45 bg-meter-ok/12 text-meter-ok",
    led: "led-on",
  },
  degraded: {
    label: "Degraded",
    chip: "border border-meter-warn/50 bg-meter-warn/12 text-meter-warn",
    led: "led-warn",
  },
  error: {
    label: "Error",
    chip: "animate-alarm bg-[#ff3b30] text-white",
    led: "led-hot",
  },
};

/** hh:mm:ss uptime formatter (hours may exceed 24). */
function formatHms(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

interface Hud {
  powered: boolean;
  onAir: boolean;
  alarm: boolean;
  degraded: boolean;
  audioLive: boolean;
  cpu: number | null;
  uptimeMs: number;
  clock: string;
  sourceLabel: string;
  destLabel: string;
}

const HUD_OFF: Hud = {
  powered: false,
  onAir: false,
  alarm: false,
  degraded: false,
  audioLive: false,
  cpu: null,
  uptimeMs: 0,
  clock: "",
  sourceLabel: "Signal generator",
  destLabel: "No output",
};

function PhaseBadge({ phase }: { phase: EnginePhase }) {
  const meta = PHASE_META[phase];
  return (
    <span
      className={cn(
        "flex items-center gap-2 rounded px-2.5 py-1 text-[10px] font-bold tracking-[0.16em] uppercase",
        meta.chip,
      )}
      aria-live="polite"
    >
      <span className={cn("led size-1.5", meta.led)} aria-hidden />
      {meta.label}
    </span>
  );
}

/* ── quick operational summary (a few seconds to read the station) ─────── */

function QuickStatus({
  phase,
  params,
  activePreset,
  dirty,
  engineError,
}: {
  phase: EnginePhase;
  params: ProcessorParams;
  activePreset: string;
  dirty: boolean;
  engineError: string | null;
}) {
  const [s, setS] = useState(() => getEngine().snapshot());
  const [fm, setFm] = useState(() => getFm());
  useEffect(() => {
    let last = 0;
    return getEngine().subscribe((snap) => {
      const now = performance.now();
      if (now - last >= 500) {
        last = now;
        setS(snap);
        setFm(getFm());
      }
    });
  }, []);

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

  const { slots, liveSlot } = useOutputs();
  const configuredIdx = slots.findIndex(isConfigured);
  const alarms = useSyncExternalStore(subscribeAlarms, getAlarms);

  const powered = s.powered;
  const target = params.rider.targetLufs;
  const loudVal = s.lufsI ?? (powered ? s.lufsS : null);
  const delta = loudVal !== null ? loudVal - target : null;
  const inLive = powered && Math.max(s.inPeakL, s.inPeakR) > -60;
  const outLive = powered && Math.max(s.outPeakL, s.outPeakR) > -60;
  const tpOver = powered && s.truePeak > -1 + 0.05;
  const fmt = (v: number) => v.toFixed(1).replace("-", "−");

  const cells: {
    label: string;
    value: string;
    sub?: string;
    tone?: "ok" | "warn" | "hot" | "info" | "fg";
    led?: "on" | "warn" | "hot" | "";
  }[] = [
    {
      label: "Engine",
      value: PHASE_META[phase].label,
      sub: powered
        ? `${(getEngine().sampleRate / 1000).toFixed(1)} kHz graph`
        : "graph down",
      tone:
        phase === "running"
          ? "ok"
          : phase === "error"
            ? "hot"
            : phase === "offline"
              ? "fg"
              : "warn",
      led: phase === "running" ? "on" : phase === "error" ? "hot" : phase === "offline" ? "" : "warn",
    },
    {
      label: "Input",
      value: !powered ? "—" : s.clipIn ? "CLIP" : inLive ? "Signal" : "No signal",
      sub: params.hpf.on ? `HPF on · trim ${params.inputGainDb.toFixed(1)} dB` : "HPF off",
      tone: s.clipIn && powered ? "hot" : inLive ? "ok" : "fg",
      led: s.clipIn && powered ? "hot" : inLive ? "on" : "",
    },
    {
      label: "Output",
      value: !powered ? "—" : s.clipOut ? "CLIP" : outLive ? "Signal" : "No signal",
      sub: `ceiling ${params.limiter.ceilingDb.toFixed(2).replace("-", "−")} dBTP`,
      tone: s.clipOut && powered ? "hot" : outLive ? "ok" : "fg",
      led: s.clipOut && powered ? "hot" : outLive ? "on" : "",
    },
    {
      label: loudVal === null ? "Loudness" : `Loudness ${s.lufsI !== null ? "I" : "S"}`,
      value: loudVal === null ? "Measuring" : `${fmt(loudVal)} LUFS`,
      sub:
        delta === null
          ? `target ${target.toFixed(1)} LU`
          : `${delta >= 0 ? "+" : "−"}${Math.abs(delta).toFixed(1)} LU vs ${target.toFixed(1)} target`,
      tone:
        delta === null
          ? "fg"
          : Math.abs(delta) <= 1
            ? "ok"
            : delta > 1
              ? "warn"
              : "info",
    },
    {
      label: "True peak",
      value: powered ? `${fmt(s.truePeak)} dBTP` : "—",
      sub: tpOver ? "over ceiling" : "within ceiling",
      tone: tpOver ? "hot" : "fg",
      led: tpOver ? "hot" : "",
    },
    {
      label: "Modulation",
      value: params.fm.on
        ? `${(fm.stats?.modPct ?? 0).toFixed(0)} %MOD`
        : "—",
      sub: params.fm.on
        ? fm.stats?.sustainedOver
          ? `over ${fm.stats.alarmPct}% for 5 s — reduce drive`
          : `${fm.stats?.ceilingPct.toFixed(0) ?? "100"}% ceiling · ${params.fm.emphasis === "off" ? "flat" : `${params.fm.emphasis} µs`}`
        : "FM branch bypassed",
      tone: !params.fm.on
        ? "fg"
        : fm.stats?.sustainedOver
          ? "hot"
          : "ok",
      led: !params.fm.on ? "" : fm.stats?.sustainedOver ? "hot" : "on",
    },
    {
      label: "Preset",
      value: activePreset,
      sub: dirty ? "modified — not reloaded" : "matches engine",
      tone: dirty ? "warn" : "fg",
      led: dirty ? "warn" : "on",
    },
    {
      label: "Stream",
      value: rt.onAir
        ? `${rt.kbps.toFixed(1)} kbps`
        : configuredIdx >= 0
          ? "Ready"
          : "Not configured",
      sub:
        rt.onAir && liveSlot >= 0
          ? `output ${liveSlot + 1} on air`
          : configuredIdx >= 0
            ? `output ${configuredIdx + 1} idle`
            : "open Stream TX to configure",
      tone: rt.onAir ? "hot" : configuredIdx >= 0 ? "ok" : "fg",
      led: rt.onAir ? "hot" : configuredIdx >= 0 ? "on" : "",
    },
    {
      label: "Warnings",
      value: engineError
        ? "Engine error"
        : alarms.length > 0
          ? alarms[0].title
          : "None",
      sub: engineError
        ? engineError.slice(0, 60)
        : alarms.length > 0
          ? new Date(alarms[0].at).toLocaleTimeString()
          : "all tolerances holding",
      tone: engineError ? "hot" : alarms.length > 0 ? "warn" : "ok",
      led: engineError ? "hot" : alarms.length > 0 ? "warn" : "on",
    },
  ];

  return (
    <section aria-label="Quick status" className="grid grid-cols-2 gap-2 sm:grid-cols-4 2xl:grid-cols-8">
      {cells.map((c) => (
        <div
          key={c.label}
          className="status-plate min-w-0 rounded-lg px-3 py-2"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-[8px] font-bold tracking-[0.16em] text-panel-mut uppercase">
              {c.label}
            </span>
            <span
              className={cn(
                "led size-1.5 shrink-0",
                c.led === "on" && "led-on",
                c.led === "warn" && "led-warn",
                c.led === "hot" && "led-hot",
              )}
              aria-hidden
            />
          </div>
          <p
            className={cn(
              "mt-1 truncate text-[13px] leading-4 font-semibold",
              c.tone === "ok" && "text-meter-ok",
              c.tone === "warn" && "text-meter-warn",
              c.tone === "hot" && "text-meter-hot",
              c.tone === "info" && "text-signal",
              (c.tone === "fg" || !c.tone) && "text-white",
            )}
            title={c.value}
          >
            {c.value}
          </p>
          {c.sub && (
            <p className="mt-0.5 truncate text-[9px] text-panel-mut" title={c.sub}>
              {c.sub}
            </p>
          )}
        </div>
      ))}
    </section>
  );
}

/* ── footer status bar ─────────────────────────────────────────────────── */

function StatusFooter({
  phase,
  conn,
}: {
  phase: EnginePhase;
  conn: string;
}) {
  const alarms = useSyncExternalStore(subscribeAlarms, getAlarms);
  return (
    <footer className="safe-bottom mt-4 border-t border-rack-line bg-[#15181d]">
      <div className="mx-auto flex max-w-[1560px] flex-wrap items-center justify-between gap-x-5 gap-y-1 px-4 py-3 text-[10px] text-rack-mut">
        <span className="flex items-center gap-2">
          <span className="font-semibold text-foreground/80">{APP_NAME}</span>
          <span className="text-readout">v{APP_VERSION}</span>
          <span className="hidden sm:inline">
            · 6-band LR4 airchain · BS.1770-4 metering
          </span>
        </span>
        <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="flex items-center gap-1.5">
            <span
              className={cn(
                "led size-1.5",
                (conn === "connected" || conn === "local") && "led-on",
                conn === "connecting" && "led-warn",
              )}
              aria-hidden
            />
            {conn === "local" ? "Local storage" : `API ${conn}`}
          </span>
          <span>Engine {PHASE_META[phase].label.toLowerCase()}</span>
          <span>
            {alarms.length} alarm{alarms.length === 1 ? "" : "s"} this session
          </span>
        </span>
      </div>
    </footer>
  );
}

/**
 * Broadcast console shell — deep-charcoal rack: engine header with the
 * lifecycle state machine, always-on metering strip, quick status,
 * signal-path map, the five workflow sections and a status footer.
 */
export default function Dashboard() {
  const engine = getEngine();
  const connState = useConnectionState();
  const pushLog = usePushLog();
  const [params, setParams] = useState<ProcessorParams>(() => {
    try {
      const raw =
        localStorage.getItem(STORAGE_KEY) ??
        localStorage.getItem(LEGACY_STORAGE_KEY);
      if (raw) return coerceParams(JSON.parse(raw));
    } catch {
      /* fall through to defaults */
    }
    return cloneParams(DEFAULT_PARAMS);
  });
  const [tab, setTab] = useState<TabId>("input");
  const [powerBusy, setPowerBusy] = useState(false);
  const [engineError, setEngineError] = useState<string | null>(null);
  const [activePreset, setActivePreset] = useState("Omnia · General");
  /** A/B compare: true = monitoring the unprocessed source (chain bypassed). */
  const [compare, setCompare] = useState(false);

  // preset baseline (what REVERT restores) + engine power timestamp
  const [baseline, setBaseline] = useState<{ params: ProcessorParams; name: string }>(
    () => ({
      params: cloneParams(DEFAULT_PARAMS),
      name: "Omnia · General",
    }),
  );
  const poweredAtRef = useRef(0);
  const powerBusyRef = useRef(false);
  const alarmCondRef = useRef({ driftSince: 0, corrSince: 0 });
  const paramsRef = useRef(params);
  useEffect(() => {
    paramsRef.current = params;
  }, [params]);

  // displayed controls vs the loaded preset snapshot
  const dirty = JSON.stringify(params) !== JSON.stringify(baseline.params);

  // ── HUD: engine state, CPU, uptime, source/destination, clock @ 500 ms ──
  const [hud, setHud] = useState<Hud>(() => ({
    ...HUD_OFF,
    clock: new Date().toLocaleTimeString(),
  }));
  useEffect(() => {
    const tick = () => {
      const snap = engine.snapshot();
      const rt = getRuntime();
      const powered = engine.powered;
      if (powered && poweredAtRef.current === 0) poweredAtRef.current = Date.now();
      if (!powered) poweredAtRef.current = 0;
      const p = paramsRef.current;

      // ── automatic tolerance alarms (throttled per kind) ──
      if (powered) {
        const now = Date.now();
        const cond = alarmCondRef.current;
        if (snap.truePeak > p.limiter.ceilingDb + 0.1) {
          fireAlarm(
            "peak",
            "True peak over ceiling",
            `${snap.truePeak.toFixed(2)} dBTP exceeds the ${p.limiter.ceilingDb.toFixed(2)} dBTP ceiling`,
          );
        }
        if (snap.clipOut) {
          fireAlarm(
            "clip",
            "Output clipping",
            "A composite-bus sample was clipped above the ceiling guard",
          );
        }
        const programPresent = snap.lufsS > -70 && snap.lufsIn > -55;
        if (
          programPresent &&
          Math.abs(snap.lufsS - p.rider.targetLufs) > 4
        ) {
          if (cond.driftSince === 0) cond.driftSince = now;
          else if (now - cond.driftSince > 15_000) {
            fireAlarm(
              "loudness",
              "Loudness out of tolerance",
              `${snap.lufsS.toFixed(1)} LUFS against the ${p.rider.targetLufs.toFixed(1)} LUFS target for 15 s`,
            );
          }
        } else cond.driftSince = 0;
        if (snap.correlation < 0) {
          if (cond.corrSince === 0) cond.corrSince = now;
          else if (now - cond.corrSince > 5_000) {
            fireAlarm(
              "correlation",
              "Negative stereo correlation",
              `Correlation ${snap.correlation.toFixed(2)} for 5 s — mono compatibility at risk`,
            );
          }
        } else cond.corrSince = 0;
        // sustained FM overmodulation (composite demand over the alarm
        // threshold for ≥5 s — reported by the MPX generator itself)
        const fmSnap = getFm();
        if (p.fm.on && fmSnap.stats?.sustainedOver) {
          fireAlarm(
            "mod",
            "FM overmodulation",
            `Composite demand ${fmSnap.stats.modPct.toFixed(0)}% held over the ${fmSnap.stats.alarmPct}% threshold for 5 s`,
          );
        }
      }

      // source / destination labels (real engine + output matrix state)
      const sourceLabel =
        engine.sourceKind === "mic"
          ? engine.micLabel || "Microphone"
          : engine.sourceKind === "file"
            ? engine.fileName || "File"
            : engine.generatorOn
              ? engine.signalMode === "tone"
                ? "1 kHz tone"
                : "Pink noise"
              : "Signal generator";
      const outs = getOutputs();
      const cfgIdx = outs.slots.findIndex(isConfigured);
      const live = outs.liveSlot >= 0 ? outs.slots[outs.liveSlot] : undefined;
      const destLabel = rt.onAir
        ? `TX ${outs.liveSlot + 1} · ${live?.name || live?.server || "on air"}`
        : cfgIdx >= 0
          ? `TX ${cfgIdx + 1} ready`
          : "No output configured";

      setHud({
        powered,
        onAir: rt.onAir,
        alarm:
          rt.onAir &&
          (snap.clipOut || snap.truePeak > p.limiter.ceilingDb + 0.1),
        degraded:
          powered &&
          (snap.perf.throttled ||
            snap.perf.driftMs < -4 ||
            snap.clipOut ||
            snap.truePeak > p.limiter.ceilingDb + 0.2),
        audioLive:
          powered && Math.max(snap.outPeakL, snap.outPeakR) > -60,
        cpu: powered
          ? Math.min(100, Math.round((snap.perf.frameMs / 16.7) * 100))
          : null,
        uptimeMs: poweredAtRef.current ? Date.now() - poweredAtRef.current : 0,
        clock: new Date().toLocaleTimeString(),
        sourceLabel,
        destLabel,
      });
    };
    tick();
    const id = window.setInterval(tick, 500);
    return () => window.clearInterval(id);
  }, [engine]);

  // persistence + engine sync
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(params));
    } catch {
      /* storage may be unavailable */
    }
  }, [params]);
  useEffect(() => {
    engine.apply(compare ? sourceParams(params) : params);
    // the FM branch taps the program bus — keep the MPX generator in step
    syncFm(params.fm);
  }, [params, engine, compare]);

  const phase: EnginePhase = powerBusy
    ? "starting"
    : engineError && !engine.powered
      ? "error"
      : engine.powered
        ? hud.degraded
          ? "degraded"
          : "running"
        : "offline";

  const logSession = useCallback(
    (title: string, detail: string) => {
      void pushLog({ kind: "session", title, detail }).catch(() => {
        /* log is best-effort */
      });
    },
    [pushLog],
  );

  // refs so startEngine stays stable while reading live values
  const compareRef = useRef(compare);
  const activePresetRef = useRef(activePreset);
  useEffect(() => {
    compareRef.current = compare;
  }, [compare]);
  useEffect(() => {
    activePresetRef.current = activePreset;
  }, [activePreset]);

  /**
   * START — duplicate-request protected, timed out with a useful message,
   * and honest about partial startup: "starting" is the request, "running"
   * only after engine.powered confirms it.
   */
  const startEngine = useCallback(
    async (reason: "start" | "restart" = "start") => {
      if (powerBusyRef.current) return;
      if (reason === "restart" && engine.powered) {
        engine.powerOff();
        stopFm();
        poweredAtRef.current = 0;
        logSession("Engine stopped", "Restart requested by operator");
      }
      if (engine.powered) return; // duplicate-start protection
      powerBusyRef.current = true;
      setPowerBusy(true);
      setEngineError(null);
      const startPromise = engine.powerOn();
      startPromise.catch(() => {
        /* surfaced through the race below */
      });
      let timeoutHandle = 0;
      try {
        await Promise.race([
          startPromise,
          new Promise<never>((_, reject) => {
            timeoutHandle = window.setTimeout(
              () =>
                reject(
                  new Error(
                    `Engine did not respond within ${START_TIMEOUT_MS / 1000} seconds`,
                  ),
                ),
              START_TIMEOUT_MS,
            );
          }),
        ]);
        engine.apply(compareRef.current ? sourceParams(paramsRef.current) : paramsRef.current);
        syncFm(paramsRef.current.fm);
        poweredAtRef.current = Date.now();
        logSession(
          reason === "restart" ? "Engine restarted" : "Engine started",
          `${engine.sampleRate ? `${(engine.sampleRate / 1000).toFixed(1)} kHz · ` : ""}preset “${activePresetRef.current}”`,
        );
      } catch (err) {
        window.clearTimeout(timeoutHandle);
        if (engine.powered) {
          // partial startup: the graph came up just after the deadline
          engine.apply(compareRef.current ? sourceParams(paramsRef.current) : paramsRef.current);
          poweredAtRef.current = Date.now();
          setEngineError(null);
          logSession("Engine started", "Came up after start timeout");
        } else {
          const message =
            err instanceof Error && err.message
              ? err.message
              : "The audio engine could not start in this browser.";
          setEngineError(message);
          toast.error(
            reason === "restart"
              ? "Engine restart failed"
              : "Engine failed to start",
            { description: message },
          );
        }
      } finally {
        window.clearTimeout(timeoutHandle);
        powerBusyRef.current = false;
        setPowerBusy(false);
      }
    },
    [engine, logSession],
  );

  const stopEngine = useCallback(() => {
    if (powerBusyRef.current || !engine.powered) return;
    engine.powerOff();
    stopFm();
    poweredAtRef.current = 0;
    setEngineError(null);
    logSession(
      "Engine stopped",
      `Chain taken off monitor · preset “${activePresetRef.current}”`,
    );
  }, [engine, logSession]);

  const applyPreset = useCallback((p: ProcessorParams, name: string) => {
    const coerced = coerceParams(p);
    setParams(coerced);
    setActivePreset(name);
    setBaseline({ params: cloneParams(coerced), name });
  }, []);

  /** REVERT — restore the chain to the last loaded preset snapshot. */
  const revertPreset = useCallback(() => {
    setParams(cloneParams(baseline.params));
    setActivePreset(baseline.name);
    toast.success(`Reverted to ${baseline.name}`);
  }, [baseline]);

  // header height drives the sticky page rail offset (resizes with wrap)
  const headerRef = useRef<HTMLElement>(null);
  const [headerH, setHeaderH] = useState(168);
  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeaderH(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div className="dark rack-surface flex min-h-screen flex-col text-foreground">
      {/* ── engine header ── */}
      <header ref={headerRef} className="engine-plate sticky top-0 z-40">
        <div className="mx-auto flex max-w-[1560px] flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2.5 sm:px-4">
          {/* left: logo + engine phase */}
          <div className="flex shrink-0 items-center gap-3">
            <Brand size={26} />
            <PhaseBadge phase={phase} />
          </div>

          {/* center: active preset plate + source → destination */}
          <div className="order-3 min-w-0 flex-1 basis-full text-center sm:order-none sm:basis-auto">
            <div className="preset-plate mx-auto inline-flex max-w-full flex-col rounded-lg px-3 py-1">
              <p className="hidden text-[8px] font-semibold tracking-[0.2em] text-panel-mut uppercase sm:block">
                Active preset
              </p>
              <p className="flex min-w-0 items-center justify-center gap-2 text-lg leading-6 font-semibold text-white">
                <span className="truncate">{activePreset}</span>
                {dirty && (
                  <span className="shrink-0 rounded border border-amber-led/40 bg-amber-led/10 px-1.5 py-0.5 text-[8px] font-bold tracking-[0.12em] text-amber-led uppercase">
                    Modified
                  </span>
                )}
              </p>
              <p
                className="hidden truncate text-[9px] text-rack-mut sm:block"
                title={`${hud.sourceLabel} → ${hud.destLabel}`}
              >
                {hud.sourceLabel} <span aria-hidden>→</span> {hud.destLabel}
              </p>
            </div>
          </div>

          {/* right: transport, live indicator, diagnostics, HUD */}
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
            {hud.powered && (
              <span
                className={cn(
                  "flex items-center gap-1.5 rounded border px-2 py-1.5 text-[9px] font-bold tracking-[0.16em] uppercase",
                  hud.audioLive
                    ? "border-meter-ok/45 bg-meter-ok/10 text-meter-ok"
                    : "border-border/70 text-panel-mut",
                  hud.alarm && "border-meter-hot/50 bg-meter-hot/10 text-meter-hot",
                )}
                title={
                  hud.audioLive
                    ? "Live audio is flowing through the chain"
                    : "Engine running — no signal on the output"
                }
              >
                <span
                  className={cn(
                    "led size-1.5",
                    hud.audioLive && "led-on animate-pulse-live",
                    hud.alarm && "led-hot",
                  )}
                  aria-hidden
                />
                {hud.alarm ? "Over limit" : hud.audioLive ? "Audio live" : "Running"}
                <span className="hidden text-readout font-medium sm:inline">
                  {formatHms(hud.uptimeMs)}
                </span>
              </span>
            )}

            {hud.powered ? (
              <Button
                size="sm"
                variant="outline"
                onClick={stopEngine}
                disabled={powerBusy}
                aria-label="Stop the audio engine"
                className="h-9 cursor-pointer gap-1.5 px-2.5 text-[11px] font-semibold tracking-[0.1em] uppercase sm:px-3"
              >
                <Power className="size-3.5" />
                Stop
              </Button>
            ) : (
              <Button
                size="sm"
                variant="default"
                onClick={() => void startEngine("start")}
                disabled={powerBusy}
                aria-label="Start the audio engine"
                className="h-9 cursor-pointer gap-1.5 px-2.5 text-[11px] font-semibold tracking-[0.1em] uppercase sm:px-3"
              >
                <Power className="size-3.5" />
                {/* phones keep the transport on one row — icon + short label */}
                <span className="hidden sm:inline">
                  {powerBusy ? "Starting…" : "Start engine"}
                </span>
                <span className="sm:hidden">
                  {powerBusy ? "Starting" : "Start"}
                </span>
              </Button>
            )}

            {(hud.powered || phase === "error") && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => void startEngine("restart")}
                disabled={powerBusy}
                title="Stop and start the audio engine"
                aria-label="Restart the audio engine"
                className="h-9 cursor-pointer gap-1.5 px-2.5 text-[11px] font-semibold tracking-[0.1em] uppercase sm:px-3"
              >
                <RotateCcw className="size-3.5" />
                <span className="hidden sm:inline">Restart</span>
              </Button>
            )}

            <Button
              size="sm"
              variant="ghost"
              onClick={() => setTab("telemetry")}
              title="Open diagnostics"
              aria-label="Open diagnostics"
              className="h-9 w-9 cursor-pointer px-0 text-rack-mut hover:text-white"
            >
              <Activity className="size-4" />
            </Button>

            {/* CPU + uptime + clock (desktop) */}
            <span className="hidden flex-col gap-1 xl:flex">
              <span className="text-[8px] leading-none font-semibold tracking-[0.16em] text-rack-mut uppercase">
                CPU
              </span>
              <span className="flex items-center gap-1.5">
                <span className="block h-1.5 w-12 overflow-hidden rounded-full bg-input">
                  <span
                    className="block h-full rounded-full bg-signal transition-[width] duration-500"
                    style={{ width: `${hud.cpu ?? 0}%` }}
                  />
                </span>
                <span className="text-readout text-[11px] text-white">
                  {hud.cpu === null ? "––" : String(hud.cpu).padStart(2, "0")}%
                </span>
              </span>
            </span>
            <span className="hidden flex-col gap-1 xl:flex">
              <span className="text-[8px] leading-none font-semibold tracking-[0.16em] text-rack-mut uppercase">
                Uptime
              </span>
              <span className="text-readout text-[11px] text-white">
                {formatHms(hud.uptimeMs)}
              </span>
            </span>
            <span className="hidden flex-col gap-1 lg:flex">
              <span className="text-[8px] leading-none font-semibold tracking-[0.16em] text-rack-mut uppercase">
                System
              </span>
              <span className="text-readout text-[11px] text-white">
                {hud.clock}
              </span>
            </span>

            <LogoDropdown />
          </div>
        </div>
      </header>

      {/* ── always-on metering section — pinned under the header on ≥lg ── */}
      <div style={{ top: headerH }} className="relative z-30 lg:sticky">
        <MeterBar targetLufs={params.rider.targetLufs} />
      </div>

      {/* ── quick status + signal path (visible on every page) ── */}
      <div className="mx-auto w-full max-w-[1560px] px-3 pt-3 sm:px-4">
        <QuickStatus
          phase={phase}
          params={params}
          activePreset={activePreset}
          dirty={dirty}
          engineError={engineError}
        />
        <SignalFlow params={params} onSelect={(t) => setTab(t)} />
      </div>

      {/* ── body: left page rail + page ── */}
      <div className="mx-auto flex w-full max-w-[1560px] flex-1 items-start">
        {/* page navigation rail */}
        <nav
          aria-label="Console pages"
          style={{ top: headerH + 12 }}
          className="sticky hidden w-52 shrink-0 self-start border-r border-rack-line pt-4 pb-8 lg:block"
        >
          <p className="px-4 pb-2 text-[9px] font-semibold tracking-[0.2em] text-rack-mut uppercase">
            Pages
          </p>
          <ul className="flex flex-col gap-0.5 px-2">
            {TABS.map((t) => {
              const Icon = t.icon;
              const active = tab === t.id;
              return (
                <li key={t.id}>
                  <button
                    type="button"
                    onClick={() => setTab(t.id)}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "group flex w-full cursor-pointer items-start gap-2.5 rounded px-2.5 py-2 text-left transition-colors",
                      active
                        ? "bg-signal/12 text-signal"
                        : "text-rack-mut hover:bg-white/5 hover:text-rack-fg",
                    )}
                  >
                    <Icon className="mt-0.5 size-4 shrink-0" />
                    <span className="min-w-0">
                      <span className="block text-[11px] font-semibold tracking-[0.12em] uppercase">
                        {t.label}
                      </span>
                      <span className="mt-0.5 block truncate text-[9px] leading-3.5 text-rack-mut group-hover:text-rack-fg">
                        {t.hint}
                      </span>
                    </span>
                    {active && (
                      <span className="mt-1.5 ml-auto size-1.5 shrink-0 rounded-full bg-signal shadow-[0_0_8px_rgba(74,144,226,0.8)]" />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>

          <div className="mt-4 mx-2 rounded border border-rack-line bg-[#15181d] px-3 py-2.5">
            <p className="text-[9px] font-semibold tracking-[0.16em] text-rack-mut uppercase">
              Chain status
            </p>
            <p className="mt-1.5 flex items-center gap-2 text-[11px] font-semibold text-white">
              <span
                className={cn(
                  "led size-1.5",
                  phase === "running" && "led-on",
                  phase === "degraded" && "led-warn",
                  phase === "starting" && "led-warn animate-pulse-live",
                  phase === "error" && "led-hot",
                )}
                aria-hidden
              />
              {PHASE_META[phase].label}
            </p>
            <p className="mt-1 truncate text-[10px] text-rack-mut">
              {activePreset}
            </p>
            <p className="text-readout mt-1 text-[9px] text-rack-mut/80">
              {hud.powered && engine.sampleRate
                ? `${(engine.sampleRate / 1000).toFixed(1)} kHz`
                : "—"}{" "}
              · 6-band LR4 · 4× guard
            </p>
          </div>
        </nav>

        {/* mobile page tabs (rail hidden below lg) — one scrollable row */}
        <div className="min-w-0 flex-1 px-3 py-4 sm:px-4">
          <div className="scrollbar-slim -mx-3 mb-4 flex gap-1 overflow-x-auto px-3 pb-1 sm:-mx-4 sm:px-4 lg:hidden">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className={cn(
                  "min-h-11 shrink-0 cursor-pointer rounded px-3 py-2.5 text-[11px] font-semibold tracking-[0.12em] uppercase transition-colors",
                  tab === t.id
                    ? "bg-signal text-signal-fg"
                    : "text-rack-mut hover:bg-white/5 hover:text-rack-fg",
                )}
                aria-current={tab === t.id ? "page" : undefined}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div key={tab} className="tab-enter">
            {tab === "input" && <InputTab params={params} setParams={setParams} />}
            {tab === "processing" && (
              <ProcessingTab
                params={params}
                setParams={setParams}
                compare={compare}
                setCompare={setCompare}
              />
            )}
            {tab === "encoder" && (
              <EncoderPanel params={params} setParams={setParams} />
            )}
            {tab === "presets" && (
              <PresetPanel
                params={params}
                activeName={activePreset}
                dirty={dirty}
                onApply={applyPreset}
                onRevert={revertPreset}
              />
            )}
            {tab === "telemetry" && <TelemetryTab />}
          </div>
        </div>
      </div>

      <StatusFooter
        phase={phase}
        conn={
          connState === "connected"
            ? "connected"
            : connState === "connecting"
              ? "reconnecting"
              : connState === "local"
                ? "local"
                : "offline"
        }
      />
    </div>
  );
}
