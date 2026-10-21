import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Check,
  Copy,
  Cpu,
  Download,
  Gauge,
  Loader2,
  RefreshCw,
  Save,
  Server,
  SlidersHorizontal,
  Upload,
  Zap,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ModuleCard } from "@/components/console/ModuleCard";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import {
  backend,
  type DspModule,
  type DspParam,
  type PerfMetrics,
} from "@/lib/backend-bridge";
import {
  CHAIN_CATEGORIES,
  FALLBACK_MODULES,
  PRESET_ENABLES,
  PUBLIC_PRESETS,
  applyPresetOffline,
} from "@/lib/dsp-catalog";
import { cn } from "@/lib/utils";

type SnapshotSlot = "A" | "B" | "C" | "D";
const SNAPSHOT_SLOTS: SnapshotSlot[] = ["A", "B", "C", "D"];
const USER_PRESET_KEY = "signalpath.fullchain.user";

function cloneModules(modules: DspModule[]): DspModule[] {
  return modules.map((module) => ({
    ...module,
    params: Object.fromEntries(
      Object.entries(module.params).map(([key, param]) => [
        key,
        { ...param, options: param.options ? [...param.options] : undefined },
      ]),
    ),
  }));
}

function normalizedParam(param: DspParam): number {
  if (typeof param.value !== "number") return 0;
  const min = param.min ?? 0;
  const max = param.max ?? 100;
  return max === min ? 0 : ((param.value - min) / (max - min)) * 100;
}

function formatParam(param: DspParam): string {
  if (typeof param.value === "boolean") return param.value ? "on" : "off";
  if (typeof param.value === "number") {
    const digits = Math.abs(param.value) >= 100 ? 0 : param.step && param.step < 0.1 ? 2 : 1;
    return `${param.value.toFixed(digits)}${param.unit ? ` ${param.unit}` : ""}`;
  }
  return String(param.value);
}

function ParamControl({
  moduleId,
  name,
  param,
  onChange,
  onCommit,
}: {
  moduleId: string;
  name: string;
  param: DspParam;
  onChange: (value: number | string | boolean) => void;
  onCommit: (value: number | string | boolean) => void;
}) {
  const id = `${moduleId}-${name}`;
  if (param.options) {
    return (
      <label htmlFor={id} className="flex items-center justify-between gap-3">
        <span className="truncate text-[9px] tracking-[0.08em] text-muted-foreground uppercase">
          {name.replace(/_/g, " ")}
        </span>
        <select
          id={id}
          value={String(param.value)}
          onChange={(e) => onCommit(e.target.value)}
          className="text-readout h-6 max-w-[115px] cursor-pointer rounded border border-border/70 bg-input px-1.5 text-[10px] text-foreground outline-none focus:border-signal/60"
        >
          {param.options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>
    );
  }
  if (typeof param.value === "boolean") {
    return (
      <div className="flex items-center justify-between gap-3">
        <span className="text-[9px] tracking-[0.08em] text-muted-foreground uppercase">
          {name.replace(/_/g, " ")}
        </span>
        <Switch
          checked={param.value}
          onCheckedChange={(checked) => onCommit(checked)}
          aria-label={`${name} ${param.value ? "off" : "on"}`}
          className="cursor-pointer"
        />
      </div>
    );
  }
  const min = param.min ?? 0;
  const max = param.max ?? 100;
  const step = param.step ?? 1;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-[9px] tracking-[0.08em] text-muted-foreground uppercase">
          {name.replace(/_/g, " ")}
        </span>
        <span className="text-readout shrink-0 text-[9px] text-foreground/80">
          {formatParam(param)}
        </span>
      </div>
      <Slider
        value={[Number(param.value)]}
        min={min}
        max={max}
        step={step}
        onValueChange={(values) => onChange(values[0])}
        onValueCommit={(values) => onCommit(values[0])}
        className="mt-1"
        aria-label={`${name} for ${moduleId}`}
      />
    </div>
  );
}

function toCfg(modules: DspModule[]): string {
  const lines = [
    "# SignalPath Full Chain — exported config",
    "[Current]",
    "description = Console export",
    "",
  ];
  for (const module of modules) {
    lines.push(`${module.id}.enabled = ${module.bypassed ? "false" : "true"}`);
    for (const [name, param] of Object.entries(module.params)) {
      if (typeof param.value === "string" && param.value === "") continue;
      lines.push(`${module.id}.${name} = ${String(param.value)}`);
    }
  }
  return lines.join("\n") + "\n";
}

function parseCfg(text: string): DspModule[] | null {
  try {
    const data = JSON.parse(text) as { modules?: DspModule[] };
    if (Array.isArray(data.modules)) return data.modules;
  } catch {
    /* plain INI follows */
  }
  const modules = cloneModules(FALLBACK_MODULES);
  const byId = new Map(modules.map((module) => [module.id, module]));
  let section = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    if (line.startsWith("[") && line.endsWith("]")) {
      section = line.slice(1, -1);
      continue;
    }
    if (section && section.toLowerCase() !== "current") continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    const dot = key.indexOf(".");
    if (dot < 0) continue;
    const stage = key.slice(0, dot);
    const param = key.slice(dot + 1);
    const module = byId.get(stage);
    if (!module) continue;
    if (param === "enabled") {
      module.bypassed = value.toLowerCase() !== "true";
      continue;
    }
    const def = module.params[param];
    if (!def) continue;
    if (def.options) {
      if (def.options.includes(value)) def.value = value;
    } else if (typeof def.value === "boolean") {
      def.value = value.toLowerCase() === "true";
    } else {
      const num = Number(value);
      if (Number.isFinite(num)) {
        def.value = Math.min(def.max ?? num, Math.max(def.min ?? num, num));
      }
    }
  }
  return modules;
}

function downloadText(name: string, text: string) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function FullChainTab() {
  const [modules, setModules] = useState<DspModule[]>(() => cloneModules(FALLBACK_MODULES));
  const [presets, setPresets] = useState<string[]>([...PUBLIC_PRESETS]);
  const [online, setOnline] = useState<boolean | null>(null);
  const [perf, setPerf] = useState<PerfMetrics | null>(null);
  const [preset, setPreset] = useState("Reference-Flat");
  const [morph, setMorph] = useState(2);
  const [blockSize, setBlockSize] = useState<1024 | 2048>(1024);
  const [busy, setBusy] = useState<string | null>(null);
  const [snapshots, setSnapshots] = useState<
    Record<SnapshotSlot, DspModule[] | null>
  >({ A: null, B: null, C: null, D: null });
  const [activeSnapshot, setActiveSnapshot] = useState<SnapshotSlot | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = async () => {
    const data = await backend.getModules();
    if (!data) {
      setOnline(false);
      return false;
    }
    const remote = data.modules.map((module) => ({
      ...module,
      params: Object.fromEntries(
        Object.entries(module.params).map(([key, param]) => [key, { ...param }]),
      ),
    }));
    setModules(remote);
    setPresets(data.presets.length ? data.presets : [...PUBLIC_PRESETS]);
    setOnline(true);
    return true;
  };

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const ok = await refresh();
      if (!alive) return;
      if (!ok) setOnline(false);
    };
    void load();
    const timer = window.setInterval(() => void load(), 15_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
    // refresh is intentionally scoped to the tab lifetime
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (online !== true) {
      setPerf(null);
      return;
    }
    return backend.subscribePerf((next) => {
      setPerf(next);
      if (next) setBlockSize(next.block_size === 2048 ? 2048 : 1024);
    });
  }, [online]);

  const grouped = useMemo(
    () =>
      CHAIN_CATEGORIES.map((category) => ({
        category,
        items: modules.filter((module) => module.category === category),
      })).filter((group) => group.items.length > 0),
    [modules],
  );
  const activeCount = modules.filter((module) => !module.bypassed).length;

  const updateParamLocal = (
    moduleId: string,
    paramName: string,
    value: number | string | boolean,
  ) => {
    setModules((prev) =>
      prev.map((module) =>
        module.id === moduleId
          ? {
              ...module,
              params: {
                ...module.params,
                [paramName]: { ...module.params[paramName], value },
              },
            }
          : module,
      ),
    );
    setActiveSnapshot(null);
  };

  const commitParam = (
    moduleId: string,
    paramName: string,
    value: number | string | boolean,
  ) => {
    updateParamLocal(moduleId, paramName, value);
    if (online) void backend.setValue(moduleId, paramName, value);
  };

  const toggleModule = (module: DspModule) => {
    const bypassed = !module.bypassed;
    setModules((prev) =>
      prev.map((item) =>
        item.id === module.id ? { ...item, bypassed } : item,
      ),
    );
    setActiveSnapshot(null);
    if (online) void backend.setValue(module.id, "bypassed", bypassed);
  };

  const applyModules = (next: DspModule[]) => {
    setModules(next);
    setActiveSnapshot(null);
    if (!online) return;
    for (const module of next) {
      void backend.setValue(module.id, "bypassed", module.bypassed);
      for (const [param, spec] of Object.entries(module.params)) {
        void backend.setValue(module.id, param, spec.value);
      }
    }
  };

  const loadPreset = async (name: string) => {
    setBusy("preset");
    setPreset(name);
    try {
      if (online) {
        const ok = await backend.loadPreset(name, morph);
        if (ok) {
          await refresh();
          toast.success(`Preset loaded · ${name}`, {
            description: `${morph}s morph · ${online ? "Python chain" : "Web Audio"}`,
          });
        } else {
          toast.error("Preset could not be loaded");
        }
      } else {
        applyModules(applyPresetOffline(name, modules));
        toast.success(`Preset loaded locally · ${name}`, {
          description: "Python bridge offline — values staged for the WASM path",
        });
      }
    } finally {
      setBusy(null);
    }
  };

  const capture = (slot: SnapshotSlot) => {
    setSnapshots((prev) => ({ ...prev, [slot]: cloneModules(modules) }));
    toast.success(`Snapshot ${slot} captured`);
  };

  const recall = (slot: SnapshotSlot) => {
    const snapshot = snapshots[slot];
    if (!snapshot) {
      capture(slot);
      return;
    }
    applyModules(cloneModules(snapshot));
    setActiveSnapshot(slot);
    toast.message(`Snapshot ${slot} recalled`);
  };

  const saveUser = () => {
    try {
      localStorage.setItem(USER_PRESET_KEY, toCfg(modules));
      toast.success("Chain saved locally");
    } catch {
      toast.error("Local storage is unavailable");
    }
  };

  const loadUser = () => {
    try {
      const raw = localStorage.getItem(USER_PRESET_KEY);
      if (!raw) {
        toast.message("No saved chain yet");
        return;
      }
      const next = parseCfg(raw);
      if (!next) {
        toast.error("Saved chain could not be parsed");
        return;
      }
      applyModules(next);
      toast.success("Saved chain loaded");
    } catch {
      toast.error("Saved chain could not be loaded");
    }
  };

  const copyConfig = async () => {
    try {
      await navigator.clipboard.writeText(toCfg(modules));
      toast.success("Chain config copied");
    } catch {
      toast.error("Clipboard is unavailable");
    }
  };

  const saveFile = () => {
    downloadText("signalpath_full_chain_presets.cfg", toCfg(modules));
    toast.success("Config exported");
  };

  const importFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const next = parseCfg(await file.text());
      if (!next) {
        toast.error("Unsupported config file");
        return;
      }
      applyModules(next);
      toast.success(`Imported ${file.name}`);
    } catch {
      toast.error("Config import failed");
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const changeBlockSize = async (size: 1024 | 2048) => {
    setBlockSize(size);
    if (online) {
      const ok = await backend.setBlockSize(size);
      if (!ok) toast.error("Block size could not be changed");
    }
  };

  const perfTone =
    perf === null
      ? "offline"
      : perf.realtime_factor >= 1
        ? "ok"
        : "warn";
  const perfText = !online
    ? "🔴 Offline"
    : perf === null
      ? "⏳ Measuring"
      : perf.realtime_factor >= 1
        ? `✅ ${perf.realtime_factor.toFixed(2)}× Realtime`
        : `⚠ ${perf.realtime_factor.toFixed(2)}× — Lagging`;

  return (
    <div className="grid gap-4">
      {/* ── bridge / performance strip ───────────────────────────────── */}
      <section className="card-layer flex flex-wrap items-center gap-3 rounded-xl border border-border/70 bg-card px-4 py-3">
        <span
          className={cn(
            "led shrink-0",
            online === true ? "led-on" : online === false ? "led-hot" : "led-warn",
          )}
          aria-hidden
        />
        <div className="min-w-0">
          <p className="text-[10px] font-bold tracking-[0.16em] text-foreground/90 uppercase">
            {online === true
              ? "Python DSP control plane online"
              : online === false
                ? "Python bridge offline"
                : "Checking Python bridge"}
          </p>
          <p className="mt-0.5 text-[9px] text-muted-foreground">
            {activeCount} of {modules.length} modules active · presets and
            parameter values persist while the bridge is online
          </p>
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <span
            className={cn(
              "text-readout flex items-center gap-1.5 rounded border px-2.5 py-1.5 text-[10px] font-bold tracking-[0.08em]",
              perfTone === "ok"
                ? "border-meter-ok/40 bg-meter-ok/10 text-meter-ok"
                : perfTone === "warn"
                  ? "border-meter-warn/40 bg-meter-warn/10 text-meter-warn"
                  : "border-border/60 bg-muted/30 text-muted-foreground",
            )}
            title="Measured on the Python host with every DSP stage enabled"
          >
            <Gauge className="size-3.5" aria-hidden />
            {perfText}
          </span>
          {perf && (
            <>
              <span className="text-readout rounded border border-border/60 px-2 py-1.5 text-[9px] text-muted-foreground">
                CPU {perf.cpu_dsp_pct.toFixed(0)}%
              </span>
              <span className="text-readout rounded border border-border/60 px-2 py-1.5 text-[9px] text-muted-foreground">
                {perf.latency_ms.toFixed(1)} ms
              </span>
              <span className="text-readout rounded border border-border/60 px-2 py-1.5 text-[9px] text-muted-foreground">
                {perf.modules} stages
              </span>
            </>
          )}
          <label className="flex items-center gap-1.5">
            <span className="text-[8px] font-semibold tracking-[0.12em] text-muted-foreground uppercase">
              Block
            </span>
            <select
              className="text-readout h-7 cursor-pointer rounded border border-border/70 bg-input px-1.5 text-[10px] text-foreground"
              value={blockSize}
              onChange={(e) => void changeBlockSize(Number(e.target.value) === 2048 ? 2048 : 1024)}
              aria-label="DSP block size"
            >
              <option value={1024}>1024</option>
              <option value={2048}>2048</option>
            </select>
          </label>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 cursor-pointer px-2 text-[10px]"
            onClick={() => void refresh()}
            aria-label="Refresh DSP chain"
          >
            <RefreshCw className="size-3.5" />
            Probe
          </Button>
        </div>
      </section>

      {online === false && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-meter-warn/35 bg-meter-warn/[0.06] px-4 py-3 text-[10px] text-muted-foreground">
          <AlertTriangle className="size-4 shrink-0 text-meter-warn" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="font-semibold text-foreground/90">
              ⚠ Using Web Audio — start the Python backend for the full DSP chain
            </p>
            <code className="text-readout mt-1 block truncate text-[9px]">
              python3 -m uvicorn api_bridge:app --host 127.0.0.1 --port 8000
            </code>
          </div>
          <span className="rounded border border-meter-warn/40 bg-meter-warn/10 px-2 py-1 text-[9px] font-bold tracking-[0.12em] text-meter-warn uppercase">
            WASM path active
          </span>
        </div>
      )}
      {online === true && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-meter-ok/35 bg-meter-ok/[0.06] px-4 py-3 text-[10px] text-muted-foreground">
          <Zap className="size-4 shrink-0 text-meter-ok" aria-hidden />
          <p className="min-w-0 flex-1">
            <span className="font-semibold text-foreground/90">
              ✅ Python engine online — full 43-stage control is available.
            </span>{" "}
            The console audio path stays on Web Audio until the native engine is selected.
          </p>
          <span className="rounded border border-meter-ok/40 bg-meter-ok/10 px-2 py-1 text-[9px] font-bold tracking-[0.12em] text-meter-ok uppercase">
            Control plane
          </span>
        </div>
      )}

      {/* ── preset / compare bar ─────────────────────────────────────── */}
      <section className="card-layer grid gap-3 rounded-xl border border-border/70 bg-card p-4">
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex min-w-[180px] flex-1 flex-col gap-1">
            <span className="text-[8px] font-semibold tracking-[0.14em] text-muted-foreground uppercase">
              Preset
            </span>
            <select
              className="h-8 cursor-pointer rounded border border-border/70 bg-input px-2 text-[11px] text-foreground"
              value={preset}
              onChange={(e) => setPreset(e.target.value)}
              aria-label="Full chain preset"
            >
              {presets.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <Button
            size="sm"
            className="h-8 cursor-pointer text-[10px] tracking-wide uppercase"
            onClick={() => void loadPreset(preset)}
            disabled={busy !== null}
          >
            {busy === "preset" ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Upload className="size-3.5" />
            )}
            Load
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-8 cursor-pointer text-[10px] tracking-wide uppercase"
            onClick={saveUser}
          >
            <Save className="size-3.5" />
            Save
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-8 cursor-pointer text-[10px] tracking-wide uppercase"
            onClick={loadUser}
          >
            <Upload className="size-3.5" />
            Load saved
          </Button>
          <label className="flex flex-col gap-1">
            <span className="text-[8px] font-semibold tracking-[0.14em] text-muted-foreground uppercase">
              Morph
            </span>
            <select
              className="h-8 cursor-pointer rounded border border-border/70 bg-input px-2 text-[10px] text-foreground"
              value={morph}
              onChange={(e) => setMorph(Number(e.target.value))}
              aria-label="Preset morph time"
            >
              {[1, 2, 3, 4, 5].map((seconds) => (
                <option key={seconds} value={seconds}>
                  {seconds}s
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-border/50 pt-3">
          <span className="flex items-center gap-1.5 text-[9px] font-semibold tracking-[0.14em] text-muted-foreground uppercase">
            <SlidersHorizontal className="size-3.5" aria-hidden />
            Compare
          </span>
          {SNAPSHOT_SLOTS.map((slot) => (
            <Button
              key={slot}
              size="sm"
              variant={activeSnapshot === slot ? "default" : "outline"}
              className="h-7 min-w-8 cursor-pointer px-2 text-[10px] font-bold"
              onClick={() => recall(slot)}
              onDoubleClick={() => capture(slot)}
              title={
                snapshots[slot]
                  ? `Recall snapshot ${slot} (double-click to recapture)`
                  : `Capture ${slot}`
              }
            >
              {slot}
              {snapshots[slot] && <Check className="size-3" aria-hidden />}
            </Button>
          ))}
          <span className="text-[9px] text-muted-foreground">
            Click a slot to recall · double-click to capture
          </span>
          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            <Button
              size="sm"
              variant="outline"
              className="h-7 cursor-pointer px-2 text-[9px] uppercase"
              onClick={() => void copyConfig()}
            >
              <Copy className="size-3" />
              Copy Config
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 cursor-pointer px-2 text-[9px] uppercase"
              onClick={saveFile}
            >
              <Download className="size-3" />
              Save File
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 cursor-pointer px-2 text-[9px] uppercase"
              onClick={() => fileRef.current?.click()}
            >
              <Upload className="size-3" />
              Load File
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept=".cfg,.ini,.json,.txt"
              className="hidden"
              onChange={(e) => void importFile(e.target.files?.[0])}
            />
          </div>
        </div>
      </section>

      {/* ── module sections ──────────────────────────────────────────── */}
      {grouped.map((group, index) => {
        const active = group.items.filter((module) => !module.bypassed).length;
        return (
          <section key={group.category} className="grid gap-3">
            <header className="flex flex-wrap items-baseline gap-2 border-b border-border/60 pb-2">
              <span className="text-readout text-[9px] text-muted-foreground">
                {String(index + 1).padStart(2, "0")}
              </span>
              <h3 className="text-[11px] font-semibold tracking-[0.14em] text-foreground/90 uppercase">
                {group.category}
              </h3>
              <span className="text-[9px] text-muted-foreground">
                {group.items.length} modules · {active} active
              </span>
              {group.category === "Input Conditioning" && (
                <span className="ml-auto flex items-center gap-1.5 text-[9px] text-muted-foreground">
                  <Activity className="size-3 text-meter-ok" aria-hidden />
                  Host clock locked · 48 kHz
                </span>
              )}
              {group.category === "Protection & Output" && (
                <span className="ml-auto flex items-center gap-1.5 text-[9px] text-muted-foreground">
                  <Cpu className="size-3 text-signal" aria-hidden />
                  final safety stages
                </span>
              )}
            </header>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {group.items.map((module) => {
                const params = Object.entries(module.params);
                return (
                  <ModuleCard
                    key={module.id}
                    title={module.name}
                    subtitle={module.id}
                    enabled={!module.bypassed}
                    onToggle={() => toggleModule(module)}
                    right={
                      <span
                        className={cn(
                          "text-readout shrink-0 rounded border px-1.5 py-1 text-[8px] font-bold tracking-[0.12em] uppercase",
                          module.bypassed
                            ? "border-border/60 bg-muted/30 text-muted-foreground"
                            : "border-signal/40 bg-signal/10 text-signal",
                        )}
                      >
                        {module.bypassed ? "Bypass" : "Active"}
                      </span>
                    }
                    bodyClassName="grid gap-2.5"
                  >
                    {params.length ? (
                      params.map(([name, param]) => (
                        <ParamControl
                          key={name}
                          moduleId={module.id}
                          name={name}
                          param={param}
                          onChange={(value) => updateParamLocal(module.id, name, value)}
                          onCommit={(value) => commitParam(module.id, name, value)}
                        />
                      ))
                    ) : (
                      <p className="text-[10px] text-muted-foreground">
                        No exposed parameters.
                      </p>
                    )}
                    <div className="mt-1 flex items-center gap-2">
                      <span
                        className={cn(
                          "h-1 flex-1 overflow-hidden rounded-full bg-input",
                          module.bypassed && "opacity-40",
                        )}
                      >
                        <span
                          className="block h-full rounded-full bg-signal/70"
                          style={{
                            width: module.bypassed
                              ? "0%"
                              : `${Math.max(4, Math.min(100, normalizedParam(params[0]?.[1] ?? { value: 0 })))}%`,
                          }}
                        />
                      </span>
                      <span className="text-readout text-[8px] text-muted-foreground uppercase">
                        {module.bypassed ? "—" : "armed"}
                      </span>
                    </div>
                  </ModuleCard>
                );
              })}
            </div>
          </section>
        );
      })}

      {/* ── footer presets ───────────────────────────────────────────── */}
      <section className="card-layer rounded-xl border border-border/70 bg-card p-4">
        <div className="mb-3 flex items-center gap-2">
          <Server className="size-3.5 text-signal" aria-hidden />
          <h3 className="text-[10px] font-bold tracking-[0.16em] text-foreground/90 uppercase">
            Presets
          </h3>
          <span className="ml-auto text-[9px] text-muted-foreground">
            DSP values only · servers, mounts and auth untouched
          </span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {PUBLIC_PRESETS.slice(0, 6).map((name) => (
            <Button
              key={name}
              size="sm"
              variant={preset === name ? "default" : "outline"}
              className="h-7 cursor-pointer px-2 text-[9px] tracking-wide uppercase"
              onClick={() => void loadPreset(name)}
            >
              {name}
            </Button>
          ))}
        </div>
      </section>
    </div>
  );
}
