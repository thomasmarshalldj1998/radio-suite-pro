import { ModuleCard } from "@/components/console/ModuleCard";
import { CtrlRow, Val } from "@/components/console/controls";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { getEngine } from "@/lib/audio/engine";
import {
  armBackupFile,
  disarmBackup,
  getFailover,
  returnToProgram,
  setFailoverConfig,
  subscribeFailover,
  takeOver,
  tuneFailover,
} from "@/lib/audio/failover";
import { cn } from "@/lib/utils";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { AlertTriangle, Radio, ShieldCheck, Wand2 } from "lucide-react";

/** Live programme level, throttled to 4 Hz — enough for a status strip. */
function useSourceLevel(): { levelDb: number; powered: boolean } {
  const [snap, setSnap] = useState(() => getEngine().snapshot());
  useEffect(() => {
    let last = 0;
    return getEngine().subscribe((s) => {
      const now = performance.now();
      if (now - last >= 250) {
        last = now;
        setSnap(s);
      }
    });
  }, []);
  return { levelDb: snap.srcLevelDb, powered: snap.powered };
}

const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/**
 * DEAD-AIR PROTECTION — programme-loss watchdog with a standby source.
 *
 * Detection reads the pre-gate programme level in the engine; the watchdog
 * (src/lib/audio/failover.ts) owns the hold/return timing and cross-fades the
 * chain. Manual take-over always wins and holds until the operator returns.
 */
export function FailoverCard({ className }: { className?: string }) {
  const state = useSyncExternalStore(subscribeFailover, getFailover);
  const { levelDb, powered } = useSourceLevel();
  const fileRef = useRef<HTMLInputElement>(null);
  const cfg = state.config;
  const dead = powered && levelDb < cfg.thresholdDb;

  const thresholdPct = Math.max(0, Math.min(100, ((levelDb + 72) / 72) * 100));
  const thresholdMark = Math.max(0, Math.min(100, ((cfg.thresholdDb + 72) / 72) * 100));

  return (
    <ModuleCard
      className={className}
      title="Dead-air protection"
      subtitle="Programme-loss watchdog · standby source · automatic return"
      enabled={cfg.enabled}
      onToggle={() => setFailoverConfig({ enabled: !cfg.enabled })}
      right={
        <span
          className={cn(
            "text-readout rounded border px-2 py-0.5 text-[10px] font-semibold tracking-[0.1em] uppercase",
            state.active
              ? "border-meter-warn/50 bg-meter-warn/15 text-meter-warn"
              : state.loaded
                ? "border-meter-ok/40 bg-meter-ok/10 text-meter-ok"
                : "border-border/70 text-muted-foreground",
          )}
        >
          {state.active ? "On standby" : state.loaded ? "Armed" : "No standby"}
        </span>
      }
    >
      {/* ── programme level against the threshold ── */}
      <div className="panel-well rounded-md px-3 py-2.5">
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-[9px] font-semibold tracking-[0.14em] text-panel-mut uppercase">
            Programme level · pre-gate
          </p>
          <span className="flex items-baseline gap-2">
            {state.deadMs > 0 && (
              <span className="text-readout text-[10px] text-meter-warn">
                dead {secs(state.deadMs)}
              </span>
            )}
            <span
              className={cn(
                "text-readout text-sm font-semibold",
                dead ? "text-meter-hot" : "text-white",
              )}
            >
              {powered ? `${levelDb.toFixed(1).replace("-", "−")} dBFS` : "―"}
            </span>
          </span>
        </div>
        <div className="relative mt-2 h-2 overflow-hidden rounded-full bg-input">
          <div
            className={cn(
              "h-full rounded-full transition-[width] duration-150",
              dead ? "bg-meter-hot" : "bg-signal",
            )}
            style={{ width: `${thresholdPct}%` }}
          />
          <span
            title={`Threshold ${cfg.thresholdDb} dBFS`}
            className="absolute top-0 h-2 w-0.5 bg-white/80"
            style={{ left: `${thresholdMark}%` }}
          />
        </div>
        <p className="mt-1.5 text-[9px] text-panel-mut">
          Take-over below {cfg.thresholdDb} dBFS for {secs(cfg.holdMs)} · return
          after {secs(cfg.returnMs)} healthy · cross-fade {cfg.fadeMs} ms
        </p>
      </div>

      {/* ── standby source ── */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input
          ref={fileRef}
          type="file"
          accept="audio/*"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file) return;
            if (!getEngine().powered) {
              toast.error("Start the engine first — the standby source is armed on the live graph");
              return;
            }
            armBackupFile(file);
            toast.success(`Standby armed · ${file.name}`);
          }}
        />
        <Button
          size="sm"
          variant="secondary"
          className="cursor-pointer"
          onClick={() => fileRef.current?.click()}
        >
          {state.loaded ? "Replace standby file" : "Arm standby file"}
        </Button>
        {state.loaded && (
          <Button
            size="sm"
            variant="ghost"
            className="cursor-pointer"
            onClick={() => {
              disarmBackup();
              toast.success("Standby source unloaded");
            }}
          >
            Unload
          </Button>
        )}
        <span className="text-readout min-w-0 flex-1 truncate text-[10px] text-panel-mut">
          {state.name ?? "Any file the platform can decode · loops while on air"}
        </span>
      </div>

      {/* ── manual control ── */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          className="cursor-pointer"
          disabled={!state.loaded || state.active}
          onClick={() => {
            if (takeOver()) toast.message("Standby source on air");
          }}
        >
          <Radio className="size-3.5" /> Take standby
        </Button>
        <Button
          size="sm"
          variant="secondary"
          className="cursor-pointer"
          disabled={!state.active}
          onClick={() => {
            if (returnToProgram()) toast.success("Returned to programme");
          }}
        >
          <ShieldCheck className="size-3.5" /> Return to programme
        </Button>
        {state.since > 0 && (
          <span className="text-readout text-[10px] text-panel-mut">
            on standby {secs(Date.now() - state.since)} · {state.trigger}
          </span>
        )}
      </div>

      {/* ── timing ── */}
      <div className="mt-3 divide-y divide-border/50 rounded-md border border-border/60">
        <CtrlRow label="Take-over">
          <span className="text-[10px] text-muted-foreground">below</span>
          <Input
            aria-label="Dead-air threshold in dBFS"
            type="number"
            min={-90}
            max={-6}
            step={1}
            value={cfg.thresholdDb}
            onChange={(e) => setFailoverConfig({ thresholdDb: Number(e.target.value) })}
            className="h-7 w-20 text-[11px]"
          />
          <span className="text-[10px] text-muted-foreground">dBFS for</span>
          <Input
            aria-label="Hold time in seconds"
            type="number"
            min={0.5}
            max={60}
            step={0.5}
            value={cfg.holdMs / 1000}
            onChange={(e) =>
              setFailoverConfig({
                holdMs: Math.round(Math.max(0.5, Number(e.target.value)) * 1000),
              })
            }
            className="h-7 w-20 text-[11px]"
          />
          <Val>s</Val>
        </CtrlRow>
        <CtrlRow label="Auto-tune">
          <span className="min-w-0 flex-1 text-[10px] text-muted-foreground sm:text-right">
            {state.floorDb !== null
              ? `Programme floor ${state.floorDb.toFixed(1).replace("-", "−")} dBFS · threshold 10 dB below`
              : "Measures live programme, then sets threshold and timings"}
          </span>
          <Button
            size="sm"
            variant="secondary"
            className="cursor-pointer"
            disabled={!powered}
            onClick={() => {
              const tuned = tuneFailover();
              if (!tuned.ok) {
                toast.error("Could not tune failover", { description: tuned.reason });
                return;
              }
              toast.success("Failover tuned", {
                description: `Threshold ${tuned.thresholdDb.toFixed(1)} dBFS · hold ${(tuned.holdMs / 1000).toFixed(1)} s · return ${(tuned.returnMs / 1000).toFixed(1)} s`,
              });
            }}
          >
            <Wand2 className="size-3.5" /> Tune failover
          </Button>
        </CtrlRow>
        <CtrlRow label="Return">
          <span className="text-[10px] text-muted-foreground">after</span>
          <Input
            aria-label="Return time in seconds"
            type="number"
            min={1}
            max={120}
            step={1}
            value={cfg.returnMs / 1000}
            onChange={(e) =>
              setFailoverConfig({
                returnMs: Math.round(Math.max(1, Number(e.target.value)) * 1000),
              })
            }
            className="h-7 w-20 text-[11px]"
          />
          <span className="text-[10px] text-muted-foreground">
            s of healthy programme · fade
          </span>
          <Input
            aria-label="Cross-fade in milliseconds"
            type="number"
            min={20}
            max={3000}
            step={10}
            value={cfg.fadeMs}
            onChange={(e) =>
              setFailoverConfig({ fadeMs: Math.round(Number(e.target.value)) })
            }
            className="h-7 w-20 text-[11px]"
          />
          <Val>ms</Val>
        </CtrlRow>
      </div>

      <div className="mt-3 flex items-center justify-between gap-3">
        <p className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <AlertTriangle className="size-3 text-meter-warn" />
          {state.lastEvent ?? "Idle — arm a standby file to enable take-over"}
          {state.takes > 0 && ` · ${state.takes} automatic take-over${state.takes === 1 ? "" : "s"} this session`}
        </p>
        <label className="flex shrink-0 cursor-pointer items-center gap-2.5">
          <span className="text-[10px] font-semibold tracking-[0.12em] text-muted-foreground uppercase">
            Watchdog
          </span>
          <Switch
            checked={cfg.enabled}
            onCheckedChange={(v) => setFailoverConfig({ enabled: v })}
            aria-label="Dead-air watchdog"
          />
        </label>
      </div>
    </ModuleCard>
  );
}
