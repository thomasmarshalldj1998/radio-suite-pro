import { Button } from "@/components/ui/button";
import {
  useAckAlarm,
  useAckAllAlarms,
  useAlarms,
  useClearAlarms,
} from "@/lib/backend/hooks";
import type { AlarmRecord, AlarmSeverity } from "@/lib/backend/types";
import { cn } from "@/lib/utils";
import { format } from "date-fns";
import { CheckCheck, Download, ShieldAlert, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

const SEVERITY_STYLE: Record<AlarmSeverity, string> = {
  critical: "border-destructive/40 bg-destructive/10 text-destructive",
  warning: "border-amber-400/40 bg-amber-400/10 text-amber-300",
  info: "border-signal/30 bg-signal/10 text-signal",
};

function toCsv(rows: AlarmRecord[]): string {
  const head = "at,iso,severity,kind,source,title,detail,acknowledged";
  const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const body = rows.map((r) =>
    [
      r.at,
      new Date(r.at).toISOString(),
      r.severity,
      r.kind,
      r.source ?? "console",
      r.title,
      r.detail ?? "",
      r.ackAt ? new Date(r.ackAt).toISOString() : "",
    ]
      .map(esc)
      .join(","),
  );
  return [head, ...body].join("\n");
}

/**
 * ALARM HISTORY — the durable record.
 *
 * The console's tolerance watchdog (peak, clip, loudness, correlation,
 * overmodulation, dead air, failover, RDS) writes every event through the
 * backend binding, so the history survives reloads, station reporting adds
 * remote events into the same list, and each row can be acknowledged.
 */
export function AlarmHistory({ className }: { className?: string }) {
  const alarms = useAlarms();
  const ackAlarm = useAckAlarm();
  const ackAll = useAckAllAlarms();
  const clearAlarms = useClearAlarms();
  const [onlyOpen, setOnlyOpen] = useState(false);

  const rows = useMemo(() => {
    const list = alarms ?? [];
    const filtered = onlyOpen ? list.filter((a) => a.ackAt === undefined) : list;
    return filtered.slice(0, 100);
  }, [alarms, onlyOpen]);

  const openCount = (alarms ?? []).filter((a) => a.ackAt === undefined).length;

  const exportCsv = () => {
    const blob = new Blob([toCsv(alarms ?? [])], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `signalpath-alarms-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success("Alarm history exported");
  };

  return (
    <div className={cn("space-y-3", className)}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Alarm history</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Durable record of every tolerance breach and failover event —
            {openCount === 0
              ? " nothing outstanding."
              : ` ${openCount} awaiting acknowledgement.`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex cursor-pointer items-center gap-2 text-[10px] font-semibold tracking-[0.1em] text-muted-foreground uppercase">
            <input
              type="checkbox"
              checked={onlyOpen}
              onChange={(e) => setOnlyOpen(e.target.checked)}
              className="size-3.5 cursor-pointer accent-[var(--signal)]"
            />
            Open only
          </label>
          <Button
            size="sm"
            variant="secondary"
            className="cursor-pointer"
            disabled={openCount === 0}
            onClick={() => {
              void ackAll().then(() => toast.success("All alarms acknowledged"));
            }}
          >
            <CheckCheck className="size-3.5" /> Ack all
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="cursor-pointer"
            disabled={(alarms?.length ?? 0) === 0}
            onClick={exportCsv}
          >
            <Download className="size-3.5" /> CSV
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="cursor-pointer text-destructive hover:text-destructive"
            disabled={(alarms?.length ?? 0) === 0}
            onClick={() => {
              void clearAlarms().then(() => toast.success("Alarm history cleared"));
            }}
          >
            <Trash2 className="size-3.5" /> Clear
          </Button>
        </div>
      </div>

      <div className="card-layer overflow-hidden rounded-xl border border-border/70 bg-card">
        {alarms === undefined ? (
          <div className="space-y-2 p-4">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-10 animate-pulse rounded-md bg-muted" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 py-12 text-center">
            <ShieldAlert className="size-6 text-muted-foreground/60" />
            <p className="text-sm font-medium">No alarms recorded</p>
            <p className="max-w-sm text-xs text-muted-foreground">
              Breaches of the true-peak ceiling, loudness tolerance, stereo
              correlation, FM deviation and the dead-air watchdog land here and
              stay here until you clear them.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border/60 text-left text-[10px] font-semibold tracking-[0.1em] text-muted-foreground uppercase">
                  <th className="px-4 py-2.5 font-semibold">Time</th>
                  <th className="px-4 py-2.5 font-semibold">Severity</th>
                  <th className="px-4 py-2.5 font-semibold">Event</th>
                  <th className="hidden px-4 py-2.5 font-semibold lg:table-cell">
                    Detail
                  </th>
                  <th className="hidden px-4 py-2.5 font-semibold sm:table-cell">
                    Source
                  </th>
                  <th className="px-4 py-2.5 font-semibold" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {rows.map((a) => (
                  <tr
                    key={a._id}
                    className={cn(
                      "transition-colors hover:bg-muted/40",
                      a.ackAt !== undefined && "opacity-55",
                    )}
                  >
                    <td className="text-readout px-4 py-2.5 text-xs whitespace-nowrap text-muted-foreground">
                      {format(new Date(a.at), "MMM d · HH:mm:ss")}
                    </td>
                    <td className="px-4 py-2.5">
                      <span
                        className={cn(
                          "inline-flex rounded-md border px-1.5 py-0.5 text-[10px] font-semibold tracking-wide uppercase",
                          SEVERITY_STYLE[a.severity] ?? SEVERITY_STYLE.info,
                        )}
                      >
                        {a.severity}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-[13px] font-medium">
                      {a.title}
                      <span className="ml-2 text-[10px] tracking-wide text-muted-foreground uppercase">
                        {a.kind}
                      </span>
                    </td>
                    <td className="hidden max-w-md px-4 py-2.5 text-xs text-muted-foreground lg:table-cell">
                      {a.detail ?? "—"}
                    </td>
                    <td className="hidden px-4 py-2.5 text-xs text-muted-foreground sm:table-cell">
                      {a.source ?? "console"}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      {a.ackAt === undefined ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 cursor-pointer px-2 text-[11px]"
                          onClick={() => void ackAlarm(a._id)}
                        >
                          Ack
                        </Button>
                      ) : (
                        <span className="text-readout text-[10px] text-muted-foreground">
                          ack {format(new Date(a.ackAt), "HH:mm")}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
