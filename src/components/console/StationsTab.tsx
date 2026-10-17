import { AlarmHistory } from "@/components/console/AlarmHistory";
import { ModuleCard } from "@/components/console/ModuleCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  useRegisterStation,
  useRemoveStation,
  useStations,
} from "@/lib/backend/hooks";
import type { StationRecord } from "@/lib/backend/types";
import {
  getReporting,
  reportEndpoint,
  resetReportingCounters,
  sendStationReport,
  setReportingConfig,
  subscribeReporting,
} from "@/lib/audio/reporting";
import { getEngine } from "@/lib/audio/engine";
import { getRuntime } from "@/lib/audio/runtime";
import { cn } from "@/lib/utils";
import { formatDistanceToNowStrict } from "date-fns";
import { Copy, Network, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";

/** Convex exposes the HTTP surface on the `.convex.site` host. */
function defaultEndpoint(): string {
  const cloud = import.meta.env.VITE_CONVEX_URL as string | undefined;
  if (!cloud) return "";
  return cloud.replace(".convex.cloud", ".convex.site");
}

function newToken(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID().replace(/-/g, "");
  return `tk${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

async function copy(text: string, label: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${label} copied`);
  } catch {
    toast.error("Clipboard blocked — copy it manually");
  }
}

function statusOf(station: StationRecord): {
  label: string;
  tone: string;
  led: string;
} {
  const age = Date.now() - station.lastSeenAt;
  if (station.lastSeenAt === 0)
    return { label: "Never reported", tone: "text-muted-foreground", led: "" };
  const stale = age > 120_000;
  if (stale)
    return {
      label: `Offline · ${formatDistanceToNowStrict(station.lastSeenAt)} ago`,
      tone: "text-destructive",
      led: "led-hot",
    };
  if ((station.openAlarms ?? 0) > 0)
    return {
      label: `On air · ${station.openAlarms} alarm${station.openAlarms === 1 ? "" : "s"}`,
      tone: "text-meter-warn",
      led: "led-warn animate-pulse-live",
    };
  return { label: "Healthy", tone: "text-meter-ok", led: "led-on" };
}

/**
 * NETWORK — the multi-station console.
 *
 * Desks running the standalone app report telemetry and alarms to this
 * deployment with a station token (POST /station-report); signed-in consoles
 * report through the normal binding. Either way every station lands in one
 * list with the same alarm history, so a studio can watch the whole group.
 */
export function StationsTab() {
  const stations = useStations();
  const registerStation = useRegisterStation();
  const removeStation = useRemoveStation();
  const reporting = useSyncExternalStore(subscribeReporting, getReporting);

  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [created, setCreated] = useState<{ name: string; token: string } | null>(null);
  const [endpointDraft, setEndpointDraft] = useState(
    reporting.config.endpoint || defaultEndpoint(),
  );
  const [tokenDraft, setTokenDraft] = useState(reporting.config.token);

  useEffect(() => {
    if (!reporting.config.endpoint && defaultEndpoint()) {
      setReportingConfig({ endpoint: defaultEndpoint() });
      setEndpointDraft(defaultEndpoint());
    }
  }, [reporting.config.endpoint]);

  const register = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error("Give the station a name");
      return;
    }
    const token = newToken();
    try {
      await registerStation({ name: trimmed, token, note: note.trim() || undefined });
      setCreated({ name: trimmed, token });
      setName("");
      setNote("");
      toast.success(`${trimmed} registered — copy its token into the desk's Network tab`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not register the station");
    }
  };

  const sendTest = async () => {
    const snap = getEngine().snapshot();
    const rt = getRuntime();
    const res = await sendStationReport({
      onAir: rt.onAir,
      lufs: snap.lufsI ?? undefined,
      truePeakDb: snap.truePeak,
      openAlarms: 0,
    });
    if (res.ok) toast.success("Test report delivered");
    else toast.error(res.error ?? "Report failed");
  };

  const endpoint = reportEndpoint(reporting.config.endpoint);

  return (
    <div className="grid gap-4">
      {/* ── station registry ── */}
      <ModuleCard
        title="Station registry"
        subtitle="Register each desk once, then paste its token into that desk's reporting agent"
        right={
          <span className="flex items-center gap-1.5 text-[10px] tracking-[0.1em] text-panel-mut uppercase">
            <Network className="size-3.5" />
            {stations?.length ?? 0} station{(stations?.length ?? 0) === 1 ? "" : "s"}
          </span>
        }
      >
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-40 flex-1">
            <label className="text-[9px] font-semibold tracking-[0.14em] text-panel-mut uppercase">
              Station name
            </label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Studio A · Bristol"
              className="mt-1 h-8 text-[12px]"
            />
          </div>
          <div className="min-w-40 flex-1">
            <label className="text-[9px] font-semibold tracking-[0.14em] text-panel-mut uppercase">
              Note (optional)
            </label>
            <Input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="FM 96.4 · 50 µs"
              className="mt-1 h-8 text-[12px]"
            />
          </div>
          <Button size="sm" className="cursor-pointer" onClick={() => void register()}>
            <Plus className="size-3.5" /> Register
          </Button>
        </div>

        {created && (
          <div className="panel-well mt-3 rounded-md px-3 py-2.5">
            <p className="text-[9px] font-semibold tracking-[0.14em] text-panel-mut uppercase">
              {created.name} · feed these into the desk
            </p>
            <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_auto]">
              <code className="text-readout block truncate rounded border border-border/70 bg-input px-2 py-1.5 text-[11px] text-white">
                {created.token}
              </code>
              <Button
                size="sm"
                variant="secondary"
                className="cursor-pointer"
                onClick={() => void copy(created.token, "Token")}
              >
                <Copy className="size-3.5" /> Token
              </Button>
            </div>
            <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_auto]">
              <code className="text-readout block truncate rounded border border-border/70 bg-input px-2 py-1.5 text-[11px] text-white">
                {endpoint || "Set the deployment site URL below"}
              </code>
              <Button
                size="sm"
                variant="secondary"
                className="cursor-pointer"
                disabled={!endpoint}
                onClick={() => void copy(endpoint, "Endpoint")}
              >
                <Copy className="size-3.5" /> Endpoint
              </Button>
            </div>
          </div>
        )}

        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border/60 text-left text-[10px] font-semibold tracking-[0.1em] text-muted-foreground uppercase">
                <th className="px-3 py-2 font-semibold">Station</th>
                <th className="px-3 py-2 font-semibold">Status</th>
                <th className="hidden px-3 py-2 font-semibold md:table-cell">Preset</th>
                <th className="hidden px-3 py-2 font-semibold sm:table-cell">LUFS</th>
                <th className="hidden px-3 py-2 font-semibold sm:table-cell">True peak</th>
                <th className="hidden px-3 py-2 font-semibold lg:table-cell">MPX</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border/50">
              {(stations ?? []).map((s) => {
                const st = statusOf(s);
                return (
                  <tr key={s._id} className="transition-colors hover:bg-muted/40">
                    <td className="px-3 py-2.5">
                      <p className="text-[13px] font-medium">{s.name}</p>
                      <p className="text-[10px] text-muted-foreground">
                        {s.note ?? s.stationId}
                        {s.version ? ` · v${s.version}` : ""}
                      </p>
                    </td>
                    <td className="px-3 py-2.5">
                      <span className={cn("flex items-center gap-1.5 text-xs", st.tone)}>
                        <span className={cn("led size-1.5", st.led)} />
                        {st.label}
                      </span>
                    </td>
                    <td className="hidden px-3 py-2.5 text-xs md:table-cell">
                      {s.presetName ?? "—"}
                    </td>
                    <td className="text-readout hidden px-3 py-2.5 text-xs sm:table-cell">
                      {s.lufs === undefined ? "—" : s.lufs.toFixed(1)}
                    </td>
                    <td className="text-readout hidden px-3 py-2.5 text-xs sm:table-cell">
                      {s.truePeakDb === undefined ? "—" : `${s.truePeakDb.toFixed(2)} dBTP`}
                    </td>
                    <td className="text-readout hidden px-3 py-2.5 text-xs lg:table-cell">
                      {s.modPct === undefined ? "—" : `${s.modPct.toFixed(0)} %`}
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 cursor-pointer px-2 text-[11px] text-destructive hover:text-destructive"
                        onClick={() => {
                          void removeStation(s._id).then(() =>
                            toast.success(`${s.name} removed`),
                          );
                        }}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </td>
                  </tr>
                );
              })}
              {(stations ?? []).length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-10 text-center">
                    <p className="text-sm font-medium">No stations reporting yet</p>
                    <p className="mx-auto mt-1 max-w-md text-xs text-muted-foreground">
                      Register this console, then fill the endpoint and token into
                      the reporting agent below (or into a remote desk's Network
                      tab). Reports arrive every few seconds and alarms land in
                      the history underneath.
                    </p>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </ModuleCard>

      {/* ── reporting agent (this device) ── */}
      <ModuleCard
        title="Reporting agent"
        subtitle="Push this console's health to the group console over the station token"
        enabled={reporting.config.enabled}
        onToggle={() => setReportingConfig({ enabled: !reporting.config.enabled })}
        right={
          reporting.lastOk === null ? (
            <span className="text-readout text-[10px] text-panel-mut">idle</span>
          ) : (
            <span
              className={cn(
                "text-readout text-[10px]",
                reporting.lastOk ? "text-meter-ok" : "text-destructive",
              )}
            >
              {reporting.lastOk ? "last report OK" : reporting.lastError}
            </span>
          )
        }
      >
        <div className="grid gap-2 sm:grid-cols-2">
          <div>
            <label className="text-[9px] font-semibold tracking-[0.14em] text-panel-mut uppercase">
              Deployment endpoint
            </label>
            <Input
              value={endpointDraft}
              onChange={(e) => setEndpointDraft(e.target.value)}
              onBlur={() => setReportingConfig({ endpoint: endpointDraft })}
              placeholder="https://your-deployment.convex.site"
              className="mt-1 h-8 text-[12px]"
            />
          </div>
          <div>
            <label className="text-[9px] font-semibold tracking-[0.14em] text-panel-mut uppercase">
              Station token
            </label>
            <Input
              value={tokenDraft}
              onChange={(e) => setTokenDraft(e.target.value)}
              onBlur={() => setReportingConfig({ token: tokenDraft.trim() })}
              placeholder="paste the token from the registry"
              className="mt-1 h-8 text-[12px]"
            />
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-[10px] font-semibold tracking-[0.1em] text-muted-foreground uppercase">
            Heartbeat
            <Input
              aria-label="Heartbeat interval in seconds"
              type="number"
              min={5}
              max={300}
              step={5}
              value={Math.round(reporting.config.intervalMs / 1000)}
              onChange={(e) =>
                setReportingConfig({
                  intervalMs: Math.round(Math.max(5, Number(e.target.value)) * 1000),
                })
              }
              className="h-7 w-20 text-[11px]"
            />
            s
          </label>
          <span className="text-readout text-[10px] text-panel-mut">
            {reporting.sent} sent · {reporting.failed} failed ·{" "}
            {reporting.pending} alarm{reporting.pending === 1 ? "" : "s"} queued
          </span>
          <Button
            size="sm"
            variant="secondary"
            className="cursor-pointer"
            onClick={() => void sendTest()}
          >
            <RefreshCw className="size-3.5" /> Send test report
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="cursor-pointer"
            onClick={() => {
              resetReportingCounters();
              toast.success("Reporting counters reset");
            }}
          >
            Reset counters
          </Button>
          <span className="flex items-center gap-2 text-[10px] text-muted-foreground">
            <Switch
              checked={reporting.config.enabled}
              onCheckedChange={(v) => setReportingConfig({ enabled: v })}
              aria-label="Station reporting"
            />
            {reporting.config.enabled ? "Reporting" : "Off"}
          </span>
        </div>
      </ModuleCard>

      <AlarmHistory />
    </div>
  );
}
