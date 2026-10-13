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
import { getRuntime, subscribeRuntime } from "@/lib/audio/runtime";
import { cn } from "@/lib/utils";
import {
  Activity,
  AudioLines,
  Bookmark,
  Power,
  RadioTower,
  SlidersHorizontal,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

const STORAGE_KEY = "signalpath.params.v2";
const LEGACY_STORAGE_KEY = "signalpath.params.v1";

type TabId = "input" | "processing" | "encoder" | "presets" | "telemetry";

const TABS: { id: TabId; label: string; icon: React.ReactNode }[] = [
  { id: "input", label: "Input", icon: <AudioLines className="size-3.5" /> },
  {
    id: "processing",
    label: "Processing",
    icon: <SlidersHorizontal className="size-3.5" />,
  },
  { id: "encoder", label: "Encoder", icon: <RadioTower className="size-3.5" /> },
  { id: "presets", label: "Presets", icon: <Bookmark className="size-3.5" /> },
  { id: "telemetry", label: "Telemetry", icon: <Activity className="size-3.5" /> },
];

/**
 * Broadcast console shell — dark rack chrome with the ON-AIR rail, chain
 * (preset) display and the five rack sections: Input, Processing, Encoder,
 * Presets and Telemetry.
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
  const [powered, setPowered] = useState(false);
  const [powerBusy, setPowerBusy] = useState(false);
  const [sampleRate, setSampleRate] = useState(0);
  const [onAir, setOnAir] = useState(() => getRuntime().onAir);
  const [activePreset, setActivePreset] = useState("Broadcast Standard FM");

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
  useEffect(
    () =>
      engine.subscribe((s) => {
        setPowered((prev) => (prev === s.powered ? prev : s.powered));
      }),
    [engine],
  );
  useEffect(
    () =>
      subscribeRuntime(() => {
        const rt = getRuntime();
        setOnAir((prev) => (prev === rt.onAir ? prev : rt.onAir));
      }),
    [],
  );

  const togglePower = useCallback(async () => {
    if (engine.powered) {
      engine.powerOff();
      return;
    }
    setPowerBusy(true);
    try {
      await engine.powerOn();
      engine.apply(params);
      setSampleRate(engine.sampleRate);
    } catch {
      toast.error("The audio engine could not start in this browser.");
    } finally {
      setPowerBusy(false);
    }
  }, [engine, params]);

  const applyPreset = useCallback((p: ProcessorParams, name: string) => {
    setParams(coerceParams(p));
    setActivePreset(name);
  }, []);

  return (
    <div className="dark rack-surface min-h-screen text-foreground">
      {/* ── chrome ── */}
      <header className="rack-rail sticky top-0 z-40">
        <div className="mx-auto flex h-14 max-w-[1560px] items-center gap-3 px-4">
          <Brand size={26} />
          <span className="hidden text-xs text-rack-mut lg:inline">
            Broadcast processor suite
          </span>

          <div className="ml-auto flex items-center gap-2.5">
            {/* chain (active preset) display */}
            <span className="hidden items-center gap-2 rounded-md border border-rack-line bg-white/[0.04] px-2.5 py-1 md:flex">
              <span className="text-[9px] font-semibold tracking-[0.14em] text-rack-mut uppercase">
                Chain
              </span>
              <span className="text-[11px] font-semibold text-rack-fg">
                {activePreset}
              </span>
            </span>
            {sampleRate > 0 && (
              <span className="text-readout hidden text-[11px] text-rack-mut sm:inline">
                {(sampleRate / 1000).toFixed(1)} kHz
              </span>
            )}
            <span
              className={cn(
                "flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-bold tracking-[0.14em] uppercase",
                onAir
                  ? "bg-signal text-signal-fg animate-pulse-live"
                  : "border border-rack-line text-rack-mut",
              )}
            >
              <RadioTower className="size-3" />
              {onAir ? "On air" : "Off air"}
            </span>
            <Button
              size="sm"
              variant={powered ? "default" : "outline"}
              onClick={() => void togglePower()}
              disabled={powerBusy}
              className={cn(
                "h-8 cursor-pointer gap-1.5 text-[11px] font-semibold tracking-wide uppercase",
                powered && "bg-meter-ok text-background hover:bg-meter-ok/90",
              )}
            >
              <Power className={cn("size-3.5", powered && "animate-pulse-live")} />
              {powerBusy ? "Starting" : powered ? "Engine live" : "Start engine"}
            </Button>
            <LogoDropdown />
          </div>
        </div>

        <nav className="border-t border-rack-line/70">
          <div className="mx-auto flex max-w-[1560px] gap-1 overflow-x-auto px-4 py-2">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className={cn(
                  "flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-3 py-1.5 text-[11px] font-semibold tracking-[0.1em] uppercase transition-colors",
                  tab === t.id
                    ? "bg-signal text-signal-fg"
                    : "text-rack-mut hover:bg-white/5 hover:text-rack-fg",
                )}
              >
                {t.icon}
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
          <PresetPanel params={params} onApply={applyPreset} />
        )}
        {tab === "telemetry" && <TelemetryTab />}
      </main>
    </div>
  );
}
