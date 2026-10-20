import { Brand } from "@/components/Brand";
import { LogoDropdown } from "@/components/LogoDropdown";
import { ConsoleSidebar } from "@/components/console/ConsoleSidebar";
import { InputTab } from "@/components/console/InputTab";
import { MeterBridge } from "@/components/console/MeterBridge";
import { PresetPanel } from "@/components/console/PresetPanel";
import {
  ProcessingTab,
  type DspSection,
} from "@/components/console/ProcessingTab";
import { TelemetryTab } from "@/components/console/TelemetryTab";
import { CompactView } from "@/components/console/CompactView";
import { Button } from "@/components/ui/button";
import {
  useAlarms,
  useConnectionState,
  useMount,
  usePushAlarm,
  usePushLog,
  useSchedules,
} from "@/lib/backend/hooks";
import type { ScheduleRecord } from "@/lib/backend/types";
import { ScheduleCard } from "@/components/console/ScheduleCard";
import { StationsTab } from "@/components/console/StationsTab";
import {
  ALARM_SEVERITY,
  fireAlarm as fireSessionAlarm,
  getAlarms,
  subscribeAlarms,
  type AlarmKind,
} from "@/lib/audio/alarms";
import { getEngine } from "@/lib/audio/engine";
import { getFm, stopFm, syncFm } from "@/lib/audio/fm";
import { getOutputs, isConfigured } from "@/lib/audio/outputs";
import { evaluateLinkHealth } from "@/lib/audio/linkwatch";
import { getLink } from "@/lib/audio/mpxlink-runtime";
import {
  DEFAULT_PARAMS,
  cloneParams,
  coerceParams,
  sourceParams,
  type ProcessorParams,
} from "@/lib/audio/params";
import { sampleLoudness, sampleMpxPower } from "@/lib/audio/compliance";
import { rdsAscii } from "@/lib/audio/mpx";
import { evaluateFailover, getFailover } from "@/lib/audio/failover";
import { maybeReport, queueRemoteAlarm } from "@/lib/audio/reporting";
import { resolveActiveSchedule } from "@/lib/audio/scheduler";
import { getRuntime } from "@/lib/audio/runtime";
import { cn } from "@/lib/utils";
import { APP_NAME, APP_VERSION } from "@/lib/version";
import {
  Activity,
  Gauge,
  LayoutDashboard,
  Power,
  Radio,
  RotateCcw,
  SlidersHorizontal,
  Sparkles,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from "react";
import { toast } from "sonner";

const STORAGE_KEY = "signalpath.params.v2";
const LEGACY_STORAGE_KEY = "signalpath.params.v1";
const START_TIMEOUT_MS = 12_000;

export type TabId =
  | "overview"
  | "compact"
  | "dsp"
  | "presets"
  | "stations"
  | "telemetry";

const TABS: { id: TabId; label: string; icon: LucideIcon; hint: string }[] = [
  {
    id: "overview",
    label: "Overview",
    icon: LayoutDashboard,
    hint: "Source · preamp · analysis",
  },
  {
    id: "dsp",
    label: "DSP",
    icon: SlidersHorizontal,
    hint: "Preamp → AGC → MB → Limit · TX",
  },
  { id: "presets", label: "Presets", icon: Sparkles, hint: "Station presets · library" },
  {
    id: "stations",
    label: "Network",
    icon: Radio,
    hint: "Group console · stations · alarms",
  },
  { id: "telemetry", label: "Telemetry", icon: Activity, hint: "Compliance · diagnostics · health" },
  { id: "compact", label: "Compact", icon: Gauge, hint: "Single-screen broadcast overview" },
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
  const pushAlarm = usePushAlarm();
  const durableAlarms = useAlarms();
  const schedules = useSchedules();

  /**
   * One alarm path. The session tolerance feed still gates the per-kind
   * cooldown, and the same event then goes to the durable history and — when
   * the reporting agent is on — onto the group console, so a 3 a.m. breach is
   * still there after a reload.
   */
  const fireAlarm = useCallback(
    (kind: AlarmKind, title: string, detail: string) => {
      if (!fireSessionAlarm(kind, title, detail)) return;
      const severity = ALARM_SEVERITY[kind];
      // the durable write is best-effort: a half-initialised backend binding
      // (stale HMR module, torn-down provider) must never break the HUD tick
      if (typeof pushAlarm === "function") {
        void pushAlarm({ kind, severity, title, detail });
      }
      queueRemoteAlarm({ kind, severity, title, detail, at: Date.now() });
    },
    [pushAlarm],
  );
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
  const [tab, setTab] = useState<TabId>("dsp");
  const [dspSection, setDspSection] = useState<DspSection>("preamp");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [powerBusy, setPowerBusy] = useState(false);
  const [engineError, setEngineError] = useState<string | null>(null);
  const [activePreset, setActivePreset] = useState("Omnia · General");
  /** A/B compare: true = monitoring the unprocessed source (chain bypassed). */
  const [compare, setCompare] = useState(false);
  /**
   * Reference match: the processed loudness stashed at the Source flip plus
   * the live match readout (original / processed / applied trim). While
   * comparing, the HUD tick trims the bypassed source to the stashed
   * processed loudness so the A/B compares tone, not level.
   */
  const procRef = useRef<{ lufs: number; tp: number } | null>(null);
  const matchKeyRef = useRef("");
  const [match, setMatch] = useState<{
    orig: number;
    proc: number;
    trim: number;
    silent: boolean;
  } | null>(null);

  // preset baseline (what REVERT restores) + engine power timestamp
  const [baseline, setBaseline] = useState<{ params: ProcessorParams; name: string }>(
    () => ({
      params: cloneParams(DEFAULT_PARAMS),
      name: "Omnia · General",
    }),
  );
  const poweredAtRef = useRef(0);
  const powerBusyRef = useRef(false);
  const alarmCondRef = useRef({ driftSince: 0, corrSince: 0, rdsStall: 0 });
  /** Epoch ms of the last clock-stall alarm already reported. */
  const glitchAtRef = useRef(0);
  const paramsRef = useRef(params);
  const openAlarmsRef = useRef(0);
  useEffect(() => {
    paramsRef.current = params;
  }, [params]);
  useEffect(() => {
    openAlarmsRef.current = (durableAlarms ?? []).filter(
      (a) => a.ackAt === undefined,
    ).length;
  }, [durableAlarms]);

  /**
   * RDS metadata ingest — with the encoder set to follow now-playing, the
   * station's title and artist are folded into radio-text and pushed onto the
   * 57 kHz subcarrier as soon as they change. The text goes through the
   * single-byte fold here, so what the receiver shows is what the operator
   * sees in the panel.
   */
  const mountDoc = useMount();
  const npTitle = mountDoc?.nowPlayingTitle ?? "";
  const npArtist = mountDoc?.nowPlayingArtist ?? "";
  const rtAuto = params.fm.mpx.rdsRtAuto;
  useEffect(() => {
    if (!rtAuto) return;
    const text = rdsAscii(npArtist ? `${npArtist} - ${npTitle}` : npTitle);
    if (!text) return;
    setParams((prev) =>
      prev.fm.mpx.rdsRt === text
        ? prev
        : { ...prev, fm: { ...prev.fm, mpx: { ...prev.fm.mpx, rdsRt: text } } },
    );
  }, [npTitle, npArtist, rtAuto]);

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

        // ── audio-thread starvation: lost render time is lost audio ──
        if (snap.perf.stalls > 0 && snap.perf.glitchAt > glitchAtRef.current) {
          glitchAtRef.current = snap.perf.glitchAt;
          fireAlarm(
            "glitch",
            "Audio thread starved",
            `The graph lost ${Math.abs(snap.perf.driftMs).toFixed(1)} ms of audio per second — the render thread missed its deadline (${snap.perf.stalls} episode${snap.perf.stalls === 1 ? "" : "s"} this session)`,
          );
        }

        // ── pilot + RDS integrity: the subcarrier is on, is data moving? ──
        const mpx = p.fm.mpx;
        if (p.fm.on && mpx.on) {
          if (mpx.pilotPct <= 0) {
            fireAlarm(
              "pilot",
              "No 19 kHz pilot",
              "The stereo pilot is at 0 % — receivers cannot lock and fall back to mono",
            );
          }
          if (mpx.rdsPct <= 0) {
            cond.rdsStall = 0;
            fireAlarm(
              "rds",
              "RDS subcarrier muted",
              "The RDS encoder is engaged but the 57 kHz subcarrier is at 0 % — PI, PS and RadioText are not on air",
            );
          } else {
            if (!/^[0-9a-fA-F]{4}$/.test(mpx.rdsPi.trim())) {
              fireAlarm(
                "rds",
                "Programme identification invalid",
                `"${mpx.rdsPi}" is not four hex digits — the encoder is sending the 0xC479 fallback`,
              );
            }
            const stats = fmSnap.stats;
            // the generator's group counter resets every tick, so four zero
            // ticks in a row (~2 s) means the encoder is not emitting
            if (stats && stats.rdsGroups === 0) {
              cond.rdsStall += 1;
              if (cond.rdsStall >= 4) {
                fireAlarm(
                  "rds",
                  "RDS encoder stalled",
                  `No groups emitted for ${(cond.rdsStall * 0.5).toFixed(1)} s while the subcarrier runs at ${mpx.rdsPct.toFixed(1)} %`,
                );
              }
            } else {
              cond.rdsStall = 0;
            }
          }
        }
      }

      // ── composite-over-IP: path switches, a dead pair, a receiver that
      // never locks. The link runs independently of the engine's power state,
      // so this is evaluated every tick, not only when the chain is up.
      for (const alert of evaluateLinkHealth(getLink(), Date.now())) {
        fireAlarm("link", alert.title, alert.detail);
      }

      // ── dead-air watchdog → standby take-over / automatic return ──
      // A suspended AudioContext freezes every analyser at zero — that is an
      // asleep output, not dead programme, so the watchdog pauses with it.
      const ctxRunning = engine.ctx?.state === "running";
      const foEvent = evaluateFailover(snap.srcLevelDb, powered && ctxRunning);
      const fo = getFailover();
      if (foEvent) {
        fireAlarm(
          "failover",
          foEvent.type === "takeover"
            ? `Standby source on air after ${(foEvent.deadMs / 1000).toFixed(1)} s`
            : "Programme restored — returned from standby",
          foEvent.type === "takeover"
            ? `Programme sat below ${fo.config.thresholdDb} dBFS for ${(foEvent.deadMs / 1000).toFixed(1)} s; the standby source was cross-faded in automatically`
            : `Programme stayed healthy for ${Math.round(fo.config.returnMs / 1000)} s, so the chain returned to the live feed`,
        );
      } else if (
        ctxRunning &&
        !fo.active &&
        fo.deadMs > Math.max(fo.config.holdMs, 3000)
      ) {
        fireAlarm(
          "silence",
          "Dead air",
          `Programme below ${fo.config.thresholdDb} dBFS for ${(fo.deadMs / 1000).toFixed(0)} s${
            fo.loaded ? "" : " — no standby source armed"
          }`,
        );
      }

      // ── reference match: while monitoring Source, trim the bypassed feed
      // to the processed loudness stashed at the flip. lufsIn meters the
      // input pre-chain, so it stays a valid original-loudness reference in
      // compare mode; on silence the last trim is held, never wound up. ──
      if (powered && compareRef.current && procRef.current) {
        const proc = procRef.current;
        const orig = snap.lufsIn;
        if (orig > -69 && proc.lufs > -70) {
          const trim = Math.min(12, Math.max(-12, proc.lufs - orig));
          engine.setCompareMatchDb(trim);
          const key = `${orig.toFixed(1)}|${proc.lufs.toFixed(1)}|${trim.toFixed(1)}`;
          if (key !== matchKeyRef.current) {
            matchKeyRef.current = key;
            setMatch({ orig, proc: proc.lufs, trim, silent: false });
          }
        } else if (matchKeyRef.current !== "silent") {
          matchKeyRef.current = "silent";
          setMatch({ orig: -70, proc: proc.lufs, trim: 0, silent: true });
        }
      }

      // ── compliance: BS.1770 loudness + BS.412 multiplex power ──
      sampleLoudness({
        powered,
        lufsM: snap.lufsM,
        lufsS: snap.lufsS,
        lufsI: snap.lufsI,
        lra: snap.lra,
        truePeak: snap.truePeak,
        samplePeakDb: snap.samplePeakDb,
        measureMs: snap.measureMs,
        targets: {
          lufsTarget: p.rider.targetLufs,
          truePeakCeilingDb: p.limiter.ceilingDb,
        },
      });
      const fmStats = getFm().stats;
      sampleMpxPower(fmStats?.powerDbr, fmStats?.powerWindowSeconds ?? 0);

      // ── station reporting agent (heartbeat + queued remote alarms) ──
      maybeReport({
        onAir: rt.onAir,
        presetName: activePresetRef.current,
        lufs: snap.lufsI ?? undefined,
        truePeakDb: snap.truePeak,
        modPct: getFm().stats?.modPct,
        openAlarms: openAlarmsRef.current,
      });

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
          fo.active ||
          (rt.onAir && (snap.clipOut || snap.truePeak > p.limiter.ceilingDb + 0.1)),
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
  }, [engine, fireAlarm]);

  // reference-match stash: capture the processed loudness once, on the
  // false→true flip only (re-stashing mid-compare would capture the source
  // itself). Powering the chain off mid-compare also releases the trim.
  const comparePrevRef = useRef(false);
  useEffect(() => {
    if (compare && !comparePrevRef.current) {
      const s = engine.snapshot();
      procRef.current = s.lufsS > -70 ? { lufs: s.lufsS, tp: s.truePeak } : null;
      matchKeyRef.current = "";
      setMatch(null);
    }
    if (!compare && comparePrevRef.current) {
      procRef.current = null;
      matchKeyRef.current = "";
      setMatch(null);
      engine.setCompareMatchDb(0);
    }
    comparePrevRef.current = compare;
  }, [compare, engine]);

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

  /**
   * Cold boot: bring the graph up on load so the saved input/output devices
   * initialise without hunting for Start. Silent on failure (autoplay policy
   * may hold the context suspended until the first click) — the Start button
   * path is unchanged, and any gesture resumes the context.
   */
  useEffect(() => {
    // Deferred past first paint so the HUD renders before the graph build.
    const boot = window.setTimeout(() => {
      void startEngine();
    }, 0);
    const kick = () => {
      void engine.ctx?.resume();
    };
    window.addEventListener("pointerdown", kick);
    window.addEventListener("keydown", kick);
    return () => {
      window.clearTimeout(boot);
      window.removeEventListener("pointerdown", kick);
      window.removeEventListener("keydown", kick);
    };
  }, [engine, startEngine]);

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

  // ── dayparting: apply the scheduled slot when the clock moves into it ──
  const activeSlotRef = useRef<string | null>(null);
  useEffect(() => {
    const check = () => {
      const slot = resolveActiveSchedule(
        schedules as ScheduleRecord[] | undefined,
      );
      const id = slot?._id ?? null;
      if (id === activeSlotRef.current) return;
      activeSlotRef.current = id;
      if (!slot) return;
      applyPreset(coerceParams(slot.params as ProcessorParams), slot.presetName);
      toast.message(`Dayparting · ${slot.name}`, {
        description: `Applied “${slot.presetName}”`,
      });
      void pushLog({
        kind: "preset",
        title: `Dayparting applied ${slot.presetName}`,
        detail: `Slot “${slot.name}” on air`, 
      });
    };
    check();
    const id = window.setInterval(check, 20_000);
    return () => window.clearInterval(id);
  }, [schedules, applyPreset, pushLog]);

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
        <div className="mx-auto flex max-w-[1560px] flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2 sm:gap-x-4 sm:gap-y-2 sm:px-4 sm:py-2.5">
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
                  <span className="shrink-0 rounded-md border border-amber-led/40 bg-amber-led/10 px-2 py-1 text-[9px] font-bold tracking-[0.12em] text-amber-led uppercase">
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
                {hud.alarm && (
                  <TriangleAlert className="size-3.5" aria-hidden />
                )}
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
                className="h-9 cursor-pointer gap-1.5 border-signal bg-signal px-2.5 text-[11px] font-bold tracking-[0.1em] text-signal-fg uppercase shadow-[0_0_18px_rgba(229,169,59,0.4)] hover:bg-signal-strong sm:px-3"
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
                className="h-9 cursor-pointer gap-1.5 border-rack-line px-2.5 text-[11px] font-semibold tracking-[0.1em] text-rack-mut uppercase hover:text-rack-fg sm:px-3"
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

            {/* CPU · uptime · system — one grouped cluster, values over labels */}
            <span className="hidden items-center gap-4 rounded-lg border border-rack-line bg-white/[0.02] px-3 py-1.5 lg:flex">
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
                  <span className="text-readout text-[12px] font-semibold text-white">
                    {hud.cpu === null ? "––" : String(hud.cpu).padStart(2, "0")}
                    %
                  </span>
                </span>
              </span>
              <span className="hidden flex-col gap-1 xl:flex">
                <span className="text-[8px] leading-none font-semibold tracking-[0.16em] text-rack-mut uppercase">
                  Uptime
                </span>
                <span className="text-readout text-[12px] font-semibold text-white">
                  {formatHms(hud.uptimeMs)}
                </span>
              </span>
              <span className="flex flex-col gap-1">
                <span className="text-[8px] leading-none font-semibold tracking-[0.16em] text-rack-mut uppercase">
                  System
                </span>
                <span className="text-readout text-[12px] font-semibold text-white">
                  {hud.clock}
                </span>
              </span>
            </span>

            <LogoDropdown />
          </div>
        </div>
      </header>

      {/* ── always-on metering section — pinned under the header on ≥lg.
          The header offset must only apply while sticky: on phones this
          wrapper is `relative`, where an inline `top` would shift the whole
          strip down and leave an empty band under the header. */}
      <div
        style={
          { "--header-h": `${headerH}px` } as CSSProperties
        }
        className="relative z-30 lg:sticky lg:top-[var(--header-h)]"
      >
        <MeterBridge
          params={params}
          activePreset={activePreset}
          dirty={dirty}
          onDensity={(v) => setParams((p) => ({ ...p, density: v }))}
          onConfigureStream={() => {
            setTab("dsp");
            setDspSection("stream");
          }}
        />
      </div>



      {/* ── body: left page rail + page ── */}
      <div className="mx-auto flex w-full max-w-[1560px] flex-1 items-start">
        {/* station sidebar (desktop — collapsible, sticky under the header) */}
        <ConsoleSidebar
          tab={tab}
          items={TABS}
          onSelect={setTab}
          phaseLabel={PHASE_META[phase].label}
          phaseLed={
            phase === "running"
              ? "led-on"
              : phase === "degraded"
                ? "led-warn"
                : phase === "starting"
                  ? "led-warn animate-pulse-live"
                  : phase === "error"
                    ? "led-hot"
                    : ""
          }
          activePreset={activePreset}
          dirty={dirty}
          error={phase === "error" ? (engineError ?? "Engine failed to start") : null}
          top={headerH + 12}
          collapsed={sidebarCollapsed}
          onToggleCollapsed={() => setSidebarCollapsed((c) => !c)}
        />

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
            {tab === "overview" && (
              <InputTab params={params} setParams={setParams} />
            )}
            {tab === "dsp" && (
              <ProcessingTab
                params={params}
                setParams={setParams}
                compare={compare}
                setCompare={setCompare}
                match={match}
                section={dspSection}
                onSectionChange={setDspSection}
              />
            )}
            {tab === "presets" && (
              <div className="grid gap-4">
                <PresetPanel
                  params={params}
                  activeName={activePreset}
                  dirty={dirty}
                  onApply={applyPreset}
                  onRevert={revertPreset}
                  onPreview={(p) => setParams(coerceParams(p))}
                />
                <ScheduleCard params={params} activeName={activePreset} />
              </div>
            )}
            {tab === "compact" && (
              <CompactView
                params={params}
                setParams={setParams}
                presetName={activePreset}
              />
            )}
            {tab === "stations" && <StationsTab />}
            {tab === "telemetry" && (
              <TelemetryTab
                params={params}
                setParams={setParams}
                presetName={activePreset}
                onConfigureStream={() => {
                  setTab("dsp");
                  setDspSection("stream");
                }}
              />
            )}
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
