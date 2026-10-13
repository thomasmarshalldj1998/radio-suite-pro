import { Brand } from "@/components/Brand";
import { LogoDropdown } from "@/components/LogoDropdown";
import { EncoderPanel } from "@/components/console/EncoderPanel";
import { InputTab } from "@/components/console/InputTab";
import { PresetPanel } from "@/components/console/PresetPanel";
import { ProcessingTab } from "@/components/console/ProcessingTab";
import { TelemetryTab } from "@/components/console/TelemetryTab";
import { Button } from "@/components/ui/button";
import { getEngine } from "@/lib/audio/engine";
import {
  DEFAULT_PARAMS,
  cloneParams,
  coerceParams,
  type ProcessorParams,
} from "@/lib/audio/params";
import { getRuntime } from "@/lib/audio/runtime";
import { cn } from "@/lib/utils";
import { Power } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

const STORAGE_KEY = "signalpath.params.v2";
const LEGACY_STORAGE_KEY = "signalpath.params.v1";

type TabId = "input" | "processing" | "encoder" | "presets" | "telemetry";

const TABS: { id: TabId; label: string }[] = [
  { id: "input", label: "Input" },
  { id: "processing", label: "Processing" },
  { id: "encoder", label: "Encoder" },
  { id: "presets", label: "Presets" },
  { id: "telemetry", label: "Telemetry" },
];

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
  cpu: number | null;
  uptimeMs: number;
  clock: string;
}

const HUD_OFF: Hud = {
  powered: false,
  onAir: false,
  alarm: false,
  cpu: null,
  uptimeMs: 0,
  clock: "",
};

/**
 * Broadcast console shell — deep-charcoal rack with the status badge,
 * centered preset display, engine transport, CPU/uptime/clock HUD and the
 * five workflow sections: INPUT → PROCESSING → ENCODER → PRESETS → TELEMETRY.
 */
export default function Dashboard() {
  const engine = getEngine();
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
  const [activePreset, setActivePreset] = useState("Broadcast Standard FM");

  // preset baseline (what REVERT restores) + engine power timestamp
  const baselineRef = useRef<{ params: ProcessorParams; name: string }>({
    params: cloneParams(DEFAULT_PARAMS),
    name: "Broadcast Standard FM",
  });
  const poweredAtRef = useRef(0);
  const paramsRef = useRef(params);
  useEffect(() => {
    paramsRef.current = params;
  }, [params]);

  // ── HUD: status, CPU, uptime and system clock refresh every 500 ms ──
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
      setHud({
        powered,
        onAir: rt.onAir,
        alarm:
          rt.onAir &&
          (snap.clipOut || snap.truePeak > p.limiter.ceilingDb + 0.1),
        cpu: powered
          ? Math.min(100, Math.round((snap.perf.frameMs / 16.7) * 100))
          : null,
        uptimeMs: poweredAtRef.current ? Date.now() - poweredAtRef.current : 0,
        clock: new Date().toLocaleTimeString(),
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
    engine.apply(params);
  }, [params, engine]);

  const togglePower = useCallback(async () => {
    if (engine.powered) {
      engine.powerOff();
      return;
    }
    setPowerBusy(true);
    try {
      await engine.powerOn();
      engine.apply(params);
      poweredAtRef.current = Date.now();
    } catch {
      toast.error("The audio engine could not start in this browser.");
    } finally {
      setPowerBusy(false);
    }
  }, [engine, params]);

  const applyPreset = useCallback((p: ProcessorParams, name: string) => {
    const coerced = coerceParams(p);
    setParams(coerced);
    setActivePreset(name);
    baselineRef.current = { params: cloneParams(coerced), name };
  }, []);

  /** REVERT — restore the chain to the last loaded preset snapshot. */
  const revertPreset = useCallback(() => {
    setParams(cloneParams(baselineRef.current.params));
    setActivePreset(baselineRef.current.name);
    toast.success(`Reverted to ${baselineRef.current.name}`);
  }, []);

  const status = !hud.powered
    ? "offline"
    : hud.onAir
      ? "onair"
      : "standby";

  return (
    <div className="dark rack-surface min-h-screen text-foreground">
      {/* ── chrome ── */}
      <header className="rack-rail sticky top-0 z-40">
        <div className="mx-auto flex h-16 max-w-[1560px] items-center gap-4 px-4">
          {/* left: logo + status badge */}
          <div className="flex shrink-0 items-center gap-3">
            <Brand size={26} />
            <span
              className={cn(
                "flex items-center gap-2 rounded px-2.5 py-1 text-[10px] font-bold tracking-[0.16em] uppercase",
                status === "offline" &&
                  "border border-rack-line text-rack-mut",
                status === "standby" &&
                  "border border-[#ffcc00]/45 bg-[#ffcc00]/10 text-[#ffcc00]",
                status === "onair" &&
                  (hud.alarm
                    ? "animate-alarm bg-[#ff3b30] text-white"
                    : "bg-[#ff3b30] text-white"),
              )}
              aria-live="polite"
            >
              <span
                className={cn(
                  "led size-1.5",
                  status === "standby" && "led-warn",
                  status === "onair" && "led-hot",
                )}
              />
              {status === "offline"
                ? "Offline"
                : status === "onair"
                  ? "On air"
                  : "Standby"}
            </span>
          </div>

          {/* center: active preset display */}
          <div className="min-w-0 flex-1 text-center">
            <p className="text-[9px] font-semibold tracking-[0.22em] text-rack-mut uppercase">
              Active preset
            </p>
            <p className="truncate text-xl leading-7 font-semibold tracking-tight text-white">
              {activePreset}
            </p>
          </div>

          {/* right: engine transport + HUD */}
          <div className="flex shrink-0 items-center gap-3">
            <Button
              size="sm"
              variant={hud.powered ? "default" : "outline"}
              onClick={() => void togglePower()}
              disabled={powerBusy}
              className={cn(
                "h-8 cursor-pointer gap-1.5 text-[11px] font-semibold tracking-[0.1em] uppercase",
                hud.powered &&
                  "border-transparent bg-[#4cd964] text-[#0d1f12] hover:bg-[#4cd964]/90",
              )}
            >
              <Power className="size-3.5" />
              {powerBusy
                ? "Starting"
                : hud.powered
                  ? "Stop engine"
                  : "Start engine"}
            </Button>

            {/* CPU meter */}
            <span className="hidden flex-col gap-1 md:flex">
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

            {/* uptime */}
            <span className="hidden flex-col gap-1 md:flex">
              <span className="text-[8px] leading-none font-semibold tracking-[0.16em] text-rack-mut uppercase">
                Uptime
              </span>
              <span className="text-readout text-[11px] text-white">
                {formatHms(hud.uptimeMs)}
              </span>
            </span>

            {/* system clock */}
            <span className="hidden flex-col gap-1 sm:flex">
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

        {/* ── workflow tab bar ── */}
        <nav className="border-t border-rack-line">
          <div className="mx-auto flex max-w-[1560px] gap-1 overflow-x-auto px-4 py-1.5">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className={cn(
                  "shrink-0 cursor-pointer rounded px-4 py-2 text-[11px] font-semibold tracking-[0.14em] uppercase transition-colors",
                  tab === t.id
                    ? "bg-signal text-signal-fg shadow-[0_0_14px_-4px_rgba(74,144,226,0.7)]"
                    : "text-rack-mut hover:bg-white/5 hover:text-rack-fg",
                )}
                aria-current={tab === t.id ? "page" : undefined}
              >
                {t.label}
              </button>
            ))}
          </div>
        </nav>
      </header>

      {/* ── body ── */}
      <main className="mx-auto max-w-[1560px] px-4 py-5">
        {tab === "input" && <InputTab params={params} setParams={setParams} />}
        {tab === "processing" && (
          <ProcessingTab params={params} setParams={setParams} />
        )}
        {tab === "encoder" && <EncoderPanel />}
        {tab === "presets" && (
          <PresetPanel
            params={params}
            activeName={activePreset}
            onApply={applyPreset}
            onRevert={revertPreset}
          />
        )}
        {tab === "telemetry" && <TelemetryTab />}
      </main>
    </div>
  );
}
