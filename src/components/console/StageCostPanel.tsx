import { useState } from "react";
import { Activity, ChevronDown, ChevronUp, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { PerfMetrics, PerfStage } from "@/lib/backend-bridge";
import { cn } from "@/lib/utils";

function stageMs(ms: number): string {
  return ms < 0.01 ? "<0.01 ms" : `${ms.toFixed(2)} ms`;
}

function stageTone(pct: number): string {
  if (pct >= 10) return "bg-meter-hot";
  if (pct >= 5) return "bg-meter-warn";
  return "bg-signal";
}

/**
 * Per-stage cost table from the Python probe. Bars are scaled to the slowest
 * stage, so the shape of the chain is readable at a glance; the readout keeps
 * the absolute milliseconds and share of the block budget.
 */
export function StageCostPanel({
  perf,
  probing,
  onProbe,
}: {
  perf: PerfMetrics | null;
  probing: boolean;
  onProbe: () => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const stages: PerfStage[] = perf?.stages ?? [];
  if (!perf || stages.length === 0) return null;

  const slowest = Math.max(...stages.map((stage) => stage.ms), 1e-6);
  const blockMs =
    perf.block_time_ms ?? stages.reduce((sum, stage) => sum + stage.ms, 0);
  // A 1024-sample block at 48 kHz is 21.3 ms of audio: that is the deadline.
  const budgetMs = perf.block_size / 48;
  const visible = showAll ? stages : stages.slice(0, 8);
  const overBudget = blockMs > budgetMs;

  return (
    <section className="card-layer grid gap-3 rounded-xl border border-border/70 bg-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex items-center gap-1.5 text-[9px] font-semibold tracking-[0.14em] text-muted-foreground uppercase">
          <Activity className="size-3.5" aria-hidden />
          Stage cost
        </span>
        <span
          className={cn(
            "text-readout rounded border px-2 py-0.5 text-[10px] font-bold",
            overBudget
              ? "border-meter-warn/40 bg-meter-warn/10 text-meter-warn"
              : "border-meter-ok/40 bg-meter-ok/10 text-meter-ok",
          )}
          title="Measured block time against the block's own audio duration"
        >
          {blockMs.toFixed(1)} ms / {budgetMs.toFixed(1)} ms budget
        </span>
        <span className="text-readout rounded border border-border/60 px-2 py-0.5 text-[9px] text-muted-foreground">
          {stages.length} stages · all forced on
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          {stages.length > 8 && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 cursor-pointer px-2 text-[10px]"
              onClick={() => setShowAll((value) => !value)}
            >
              {showAll ? (
                <ChevronUp className="size-3.5" />
              ) : (
                <ChevronDown className="size-3.5" />
              )}
              {showAll ? "Top 8" : `All ${stages.length}`}
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            className="h-7 cursor-pointer px-2 text-[10px]"
            onClick={onProbe}
            disabled={probing}
            title="Re-measure every stage on the Python host"
          >
            <RefreshCw className={cn("size-3.5", probing && "animate-spin")} />
            Re-measure
          </Button>
        </div>
      </div>

      <ul className="grid gap-1">
        {visible.map((stage) => (
          <li key={stage.id} className="flex items-center gap-3">
            <div className="min-w-0 shrink-0 sm:w-44">
              <p className="truncate text-[10px] font-medium text-foreground/90">
                {stage.name}
              </p>
              <p className="truncate text-[8px] tracking-[0.1em] text-muted-foreground uppercase">
                {stage.category}
              </p>
            </div>
            <div className="hidden h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted/40 sm:block">
              <div
                className={cn("h-full rounded-full", stageTone(stage.pct))}
                style={{
                  width: `${Math.max(2, (stage.ms / slowest) * 100)}%`,
                }}
              />
            </div>
            <span className="text-readout ml-auto shrink-0 text-right text-[9px] text-muted-foreground">
              <span className="text-foreground/85">{stageMs(stage.ms)}</span>
              {" · "}
              {stage.pct < 1 ? "<1" : stage.pct.toFixed(0)}%
            </span>
          </li>
        ))}
      </ul>

      <p className="border-t border-border/50 pt-2 text-[9px] leading-relaxed text-muted-foreground">
        Measured on the Python host with every stage enabled, averaged over five
        blocks. Bars are relative to the slowest stage ({stages[0].name},{" "}
        {stages[0].ms.toFixed(2)} ms). Red is ≥10% of the block, amber ≥5%.
      </p>
    </section>
  );
}
