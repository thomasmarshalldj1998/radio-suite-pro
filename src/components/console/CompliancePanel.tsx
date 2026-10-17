import { ModuleCard } from "@/components/console/ModuleCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  complianceCsv,
  complianceFilename,
  complianceHtml,
  complianceReport,
  getCompliance,
  MPX_LIMIT_DBR,
  MPX_WINDOW_SECONDS,
  resetCompliance,
  setComplianceTargets,
  subscribeCompliance,
} from "@/lib/audio/compliance";
import { cn } from "@/lib/utils";
import { Download, FileText, RotateCcw } from "lucide-react";
import { useSyncExternalStore } from "react";
import { toast } from "sonner";

function download(name: string, body: string, type: string) {
  const blob = new Blob([body], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * COMPLIANCE — the station's own record.
 *
 * Programme loudness per ITU-R BS.1770-4 / EBU R128 (gated integrated, LRA,
 * true peak) and multiplex power per ITU-R BS.412-9 clause 2.5.1 (60 s mean
 * square of the complete multiplex against a ±19 kHz-peak sine = 0 dBr).
 */
export function CompliancePanel({ className }: { className?: string }) {
  const state = useSyncExternalStore(subscribeCompliance, getCompliance);
  const report = complianceReport();
  const t = state.targets;

  const lufsBar =
    state.lufsI === null
      ? null
      : Math.max(
          0,
          Math.min(100, ((state.lufsI + 30) / 30) * 100),
        );
  const targetMark = Math.max(
    0,
    Math.min(100, ((t.lufsTarget + 30) / 30) * 100),
  );
  const mpxPct = state.mpxActive
    ? Math.max(0, Math.min(100, ((state.mpxPowerDbr + 20) / 32) * 100))
    : 0;
  const mpxLimitMark = Math.max(
    0,
    Math.min(100, ((t.mpxLimitDbr + 20) / 32) * 100),
  );

  const exportCsv = () => {
    const r = complianceReport();
    download(`${complianceFilename(r)}.csv`, complianceCsv(r), "text/csv");
    toast.success("Compliance record exported (CSV)");
  };
  const exportHtml = () => {
    const r = complianceReport();
    download(`${complianceFilename(r)}.html`, complianceHtml(r), "text/html");
    toast.success("Printable record exported — open it and print to PDF");
  };

  return (
    <ModuleCard
      className={className}
      title="Compliance record"
      subtitle="BS.1770 loudness · BS.412 multiplex power · exportable for the licence file"
      right={
        <span
          className={cn(
            "rounded border px-2 py-0.5 text-[10px] font-semibold tracking-[0.1em] uppercase",
            report.pass
              ? "border-meter-ok/45 bg-meter-ok/12 text-meter-ok"
              : "border-destructive/40 bg-destructive/10 text-destructive",
          )}
        >
          {report.pass ? "Within limits" : "Outside limits"}
        </span>
      }
    >
      {/* ── integrated loudness against the target ── */}
      <div className="panel-well rounded-md px-3 py-2.5">
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-[9px] font-semibold tracking-[0.14em] text-panel-mut uppercase">
            Integrated loudness · BS.1770-4
          </p>
          <span className="text-readout text-sm font-semibold text-white">
            {state.lufsI === null
              ? "measuring"
              : `${state.lufsI.toFixed(1).replace("-", "−")} LUFS`}
            <span className="ml-2 text-[10px] font-normal text-panel-mut">
              target {t.lufsTarget.toFixed(1)} ± {t.lufsTolerance.toFixed(1)}
            </span>
          </span>
        </div>
        <div className="relative mt-2 h-2 overflow-hidden rounded-full bg-input">
          <div
            className="h-full rounded-full bg-signal transition-[width] duration-300"
            style={{ width: `${lufsBar ?? 0}%` }}
          />
          <span
            className="absolute top-0 h-2 w-0.5 bg-white/80"
            style={{ left: `${targetMark}%` }}
            title={`Target ${t.lufsTarget} LUFS`}
          />
        </div>
        <p className="mt-1.5 text-[9px] text-panel-mut">
          {state.lra === null
            ? "Loudness range: measuring"
            : `LRA ${state.lra.toFixed(1)} LU`}{" "}
          · short-term {state.lufsS.toFixed(1).replace("-", "−")} LUFS · worst
          excursion {state.worstLufsDeviation.toFixed(1)} LU (
          {(state.outOfToleranceMs / 1000).toFixed(0)} s outside tolerance)
        </p>
      </div>

      {/* ── BS.412 multiplex power ── */}
      <div className="panel-well mt-3 rounded-md px-3 py-2.5">
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-[9px] font-semibold tracking-[0.14em] text-panel-mut uppercase">
            Multiplex power · BS.412 ({MPX_WINDOW_SECONDS} s)
          </p>
          <span className="text-readout text-sm font-semibold text-white">
            {state.mpxActive
              ? `${state.mpxWorstDbr.toFixed(2).replace("-", "−")} dBr`
              : "FM off"}
            <span className="ml-2 text-[10px] font-normal text-panel-mut">
              limit {t.mpxLimitDbr.toFixed(1)} dBr
            </span>
          </span>
        </div>
        <div className="relative mt-2 h-2 overflow-hidden rounded-full bg-input">
          <div
            className={cn(
              "h-full rounded-full transition-[width] duration-300",
              state.mpxPowerDbr > t.mpxLimitDbr ? "bg-meter-hot" : "bg-meter-ok",
            )}
            style={{ width: `${mpxPct}%` }}
          />
          <span
            className="absolute top-0 h-2 w-0.5 bg-white/80"
            style={{ left: `${mpxLimitMark}%` }}
            title={`Limit ${t.mpxLimitDbr} dBr`}
          />
        </div>
        <p className="mt-1.5 text-[9px] text-panel-mut">
          {state.mpxActive
            ? `now ${state.mpxPowerDbr.toFixed(2)} dBr over a ${state.mpxWindowSeconds.toFixed(0)} s window · ${(state.mpxOverLimitMs / 1000).toFixed(0)} s above the limit this session`
            : "Engage the FM module to measure the composite"}
          {" · "}0 dBr = a sine at ±19 kHz peak deviation
        </p>
      </div>

      {/* ── peaks + duration ── */}
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[
          {
            label: "True peak",
            value: `${state.maxTruePeakDb.toFixed(2).replace("-", "−")} dBTP`,
            sub: `≤ ${t.truePeakCeilingDb.toFixed(2)}`,
          },
          {
            label: "Sample peak",
            value: `${state.maxSamplePeakDb.toFixed(2).replace("-", "−")} dBFS`,
            sub: "≤ 0.00",
          },
          {
            label: "Measurement",
            value: `${(state.measureMs / 1000).toFixed(0)} s`,
            sub: "gated programme",
          },
          {
            label: "Session",
            value:
              report.durationMs === 0
                ? "—"
                : `${(report.durationMs / 60000).toFixed(1)} min`,
            sub: "since reset",
          },
        ].map((s) => (
          <div key={s.label} className="panel-well rounded-md px-2.5 py-2">
            <p className="text-[9px] font-semibold tracking-[0.1em] text-panel-mut uppercase">
              {s.label}
            </p>
            <p className="text-readout mt-1 truncate text-[13px] font-medium text-white">
              {s.value}
            </p>
            <p className="mt-0.5 text-[8px] text-panel-mut">{s.sub}</p>
          </div>
        ))}
      </div>

      {/* ── targets ── */}
      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        <label className="flex items-center justify-between gap-2 rounded-md border border-border/60 px-3 py-2">
          <span className="text-[9px] font-semibold tracking-[0.1em] text-panel-mut uppercase">
            LUFS target
          </span>
          <Input
            type="number"
            step={0.5}
            value={t.lufsTarget}
            onChange={(e) => setComplianceTargets({ lufsTarget: Number(e.target.value) })}
            className="h-7 w-20 text-[11px]"
            aria-label="Loudness target in LUFS"
          />
        </label>
        <label className="flex items-center justify-between gap-2 rounded-md border border-border/60 px-3 py-2">
          <span className="text-[9px] font-semibold tracking-[0.1em] text-panel-mut uppercase">
            Tolerance (LU)
          </span>
          <Input
            type="number"
            step={0.1}
            value={t.lufsTolerance}
            onChange={(e) =>
              setComplianceTargets({ lufsTolerance: Number(e.target.value) })
            }
            className="h-7 w-20 text-[11px]"
            aria-label="Loudness tolerance in LU"
          />
        </label>
        <label className="flex items-center justify-between gap-2 rounded-md border border-border/60 px-3 py-2">
          <span className="text-[9px] font-semibold tracking-[0.1em] text-panel-mut uppercase">
            MPX limit (dBr)
          </span>
          <Input
            type="number"
            step={0.5}
            value={t.mpxLimitDbr}
            onChange={(e) => setComplianceTargets({ mpxLimitDbr: Number(e.target.value) })}
            className="h-7 w-20 text-[11px]"
            aria-label="Multiplex power limit in dBr"
          />
        </label>
      </div>
      <p className="mt-1.5 text-[9px] text-panel-mut">
        BS.412-9 sets the limit at {MPX_LIMIT_DBR} dBr; only raise it if your
        regulator allows a looser multiplex-power limit.
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button size="sm" className="cursor-pointer" onClick={exportHtml}>
          <FileText className="size-3.5" /> Printable record
        </Button>
        <Button
          size="sm"
          variant="secondary"
          className="cursor-pointer"
          onClick={exportCsv}
        >
          <Download className="size-3.5" /> CSV
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="cursor-pointer"
          onClick={() => {
            resetCompliance();
            toast.success("Compliance session reset");
          }}
        >
          <RotateCcw className="size-3.5" /> Reset session
        </Button>
        <span className="text-[10px] text-muted-foreground">
          {state.startedAt === 0
            ? "Nothing measured yet"
            : `Session started ${new Date(state.startedAt).toLocaleTimeString()}`}
        </span>
      </div>
    </ModuleCard>
  );
}
