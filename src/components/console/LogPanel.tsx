import { api } from "@/convex/_generated/api";
import { cn } from "@/lib/utils";
import { useQuery } from "convex/react";
import { format } from "date-fns";
import { ScrollText } from "lucide-react";

const KIND_STYLE: Record<string, string> = {
  session: "border-signal/30 bg-signal/10 text-signal",
  metadata: "border-meter-ok/30 bg-meter-ok/10 text-meter-ok",
  config: "border-border/70 bg-muted text-foreground/70",
  preset: "border-chart-3/40 bg-chart-3/10 text-chart-3",
};

export function LogPanel() {
  const entries = useQuery(api.stations.listLog, { limit: 100 });

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Broadcast log</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Sessions, metadata pushes, configuration changes and preset activity.
        </p>
      </div>

      <div className="card-layer overflow-hidden rounded-xl border border-border/70 bg-card">
        {entries === undefined ? (
          <div className="space-y-2 p-4">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-10 animate-pulse rounded-md bg-muted" />
            ))}
          </div>
        ) : entries.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 py-14 text-center">
            <ScrollText className="size-6 text-muted-foreground/60" />
            <p className="text-sm font-medium">No activity yet</p>
            <p className="max-w-sm text-xs text-muted-foreground">
              Go on air, push metadata or apply a preset — every event is stamped
              here for your station records.
            </p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border/60 text-left text-[10px] font-semibold tracking-[0.1em] text-muted-foreground uppercase">
                <th className="px-4 py-2.5 font-semibold">Time</th>
                <th className="px-4 py-2.5 font-semibold">Type</th>
                <th className="px-4 py-2.5 font-semibold">Event</th>
                <th className="hidden px-4 py-2.5 font-semibold sm:table-cell">
                  Detail
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/50">
              {entries.map((e) => (
                <tr key={e._id} className="transition-colors hover:bg-muted/40">
                  <td className="text-readout px-4 py-2.5 text-xs whitespace-nowrap text-muted-foreground">
                    {format(new Date(e.at), "MMM d · HH:mm:ss")}
                  </td>
                  <td className="px-4 py-2.5">
                    <span
                      className={cn(
                        "inline-flex rounded-md border px-1.5 py-0.5 text-[10px] font-semibold tracking-wide uppercase",
                        KIND_STYLE[e.kind] ?? KIND_STYLE.config,
                      )}
                    >
                      {e.kind}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-[13px] font-medium">{e.title}</td>
                  <td className="hidden max-w-md truncate px-4 py-2.5 text-xs text-muted-foreground sm:table-cell">
                    {e.detail ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Showing the latest {entries?.length ?? 0} entries.
      </p>
    </div>
  );
}
