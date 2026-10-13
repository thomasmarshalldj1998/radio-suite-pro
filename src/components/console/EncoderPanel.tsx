import { StereoLevelMeter } from "@/components/console/Meters";
import { ModuleCard } from "@/components/console/ModuleCard";
import { api } from "@/convex/_generated/api";
import { getEngine } from "@/lib/audio/engine";
import {
  CODECS,
  codecById,
  formatBytes,
  formatUptime,
  isCodecSupported,
  mountUrl,
  OUTPUTS,
  probeEndpoint,
  supportedCodecs,
  StreamEncoder,
  type EncoderStats,
  type OutputProfile,
  type ProbeResult,
} from "@/lib/audio/encoder";
import {
  addTake,
  getRuntime,
  nextTakeId,
  patchRuntime,
  subscribeRuntime,
} from "@/lib/audio/runtime";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useMutation, useQuery } from "convex/react";
import {
  CheckCircle2,
  Download,
  Radio,
  Send,
  Server,
  Square,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

interface MountForm {
  name: string;
  protocol: string;
  server: string;
  port: number;
  mount: string;
  username: string;
  password: string;
  codec: string;
  bitrateKbps: number;
  sampleRateKhz: number;
  channels: string;
}

const DEFAULT_FORM: MountForm = {
  name: "My Station",
  protocol: "icecast2",
  server: "stream.example.com",
  port: 8000,
  mount: "/live",
  username: "source",
  password: "",
  codec: "opus",
  bitrateKbps: 128,
  sampleRateKhz: 48,
  channels: "stereo",
};

const BITRATES = [64, 96, 128, 160, 192, 256, 320];

function Field({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <Label className="text-[10px] font-semibold tracking-[0.1em] text-muted-foreground uppercase">
        {label}
      </Label>
      {children}
    </div>
  );
}

export function EncoderPanel() {
  const engine = getEngine();
  const mountDoc = useQuery(api.stations.getMount);
  const logEntries = useQuery(api.stations.listLog, { limit: 5 });
  const saveMount = useMutation(api.stations.saveMount);
  const setNowPlaying = useMutation(api.stations.setNowPlaying);
  const pushLog = useMutation(api.stations.pushLog);

  const [form, setForm] = useState<MountForm>(DEFAULT_FORM);
  const [npTitle, setNpTitle] = useState("");
  const [npArtist, setNpArtist] = useState("");
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [probing, setProbing] = useState(false);
  const [saving, setSaving] = useState(false);
  const loadedRef = useRef(false);

  // live runtime state (ON AIR survives tab switches)
  const [rt, setRt] = useState(() => ({
    onAir: getRuntime().onAir,
    stats: getRuntime().stats,
    startedAt: getRuntime().startedAt,
    takes: getRuntime().takes,
  }));
  useEffect(
    () =>
      subscribeRuntime(() => {
        const r = getRuntime();
        setRt({
          onAir: r.onAir,
          stats: r.stats,
          startedAt: r.startedAt,
          takes: r.takes,
        });
      }),
    [],
  );
  // 1 Hz uptime ticker while on air (setState only from the interval callback)
  const [liveUptimeMs, setLiveUptimeMs] = useState(0);
  useEffect(() => {
    if (!rt.onAir) return;
    const id = window.setInterval(
      () => setLiveUptimeMs(Date.now() - getRuntime().startedAt),
      1000,
    );
    return () => window.clearInterval(id);
  }, [rt.onAir]);

  useEffect(() => {
    if (mountDoc && !loadedRef.current) {
      loadedRef.current = true;
      setForm({
        name: mountDoc.name,
        protocol: mountDoc.protocol,
        server: mountDoc.server,
        port: mountDoc.port,
        mount: mountDoc.mount,
        username: mountDoc.username,
        password: mountDoc.password,
        codec: mountDoc.codec,
        bitrateKbps: mountDoc.bitrateKbps,
        sampleRateKhz: mountDoc.sampleRateKhz,
        channels: mountDoc.channels,
      });
      setNpTitle(mountDoc.nowPlayingTitle ?? "");
      setNpArtist(mountDoc.nowPlayingArtist ?? "");
    }
  }, [mountDoc]);

  const supported = supportedCodecs();
  const currentCodec = codecById(form.codec);
  const url = mountUrl(form);
  const uptime = rt.onAir ? liveUptimeMs : rt.stats.elapsedMs;

  const persistConfig = async (log = false) => {
    setSaving(true);
    try {
      await saveMount({ ...form });
      if (log) {
        await pushLog({
          kind: "config",
          title: "Mount configuration saved",
          detail: url,
        });
      }
      toast.success("Mount configuration saved");
    } catch {
      toast.error("Could not save configuration");
    } finally {
      setSaving(false);
    }
  };

  const connect = async () => {
    if (rt.onAir) return;
    if (!isCodecSupported(currentCodec.mimeType)) {
      toast.error(`${currentCodec.label} is not supported in this browser`);
      return;
    }
    try {
      if (!engine.powered) await engine.powerOn();
      const stream = engine.getStream();
      if (!stream) throw new Error("No program bus available");
      const encoder = new StreamEncoder(stream, {
        mimeType: currentCodec.mimeType,
        bitsPerSecond: form.bitrateKbps * 1000,
      });
      encoder.onStats = (stats: EncoderStats) => patchRuntime({ stats });
      encoder.start(1000);
      patchRuntime({
        encoder,
        onAir: true,
        startedAt: Date.now(),
        stats: { bytes: 0, elapsedMs: 0, kbps: 0, chunks: 0 },
      });
      void saveMount({ ...form });
      void pushLog({
        kind: "session",
        title: `ON AIR — ${form.name}`,
        detail: `${currentCodec.label} ${form.bitrateKbps} kbps → ${url}`,
      });
      toast.success("You are on air", { description: url });
    } catch (err) {
      toast.error("Could not start the encoder", {
        description: err instanceof Error ? err.message : undefined,
      });
    }
  };

  const disconnect = async () => {
    const runtime = getRuntime();
    if (!runtime.encoder) {
      patchRuntime({ onAir: false });
      return;
    }
    const pre = runtime.encoder.stats();
    const blob = await runtime.encoder.stop();
    addTake({
      id: nextTakeId(),
      name: `${form.name} · ${new Date().toLocaleTimeString()}`,
      url: URL.createObjectURL(blob),
      ext: currentCodec.ext,
      bytes: blob.size || pre.bytes,
      durationMs: pre.elapsedMs,
      at: Date.now(),
    });
    patchRuntime({ encoder: null, onAir: false });
    void pushLog({
      kind: "session",
      title: `OFF AIR — ${form.name}`,
      detail: `${formatBytes(pre.bytes)} encoded over ${formatUptime(pre.elapsedMs)}`,
    });
    toast.success("Broadcast stopped", {
      description: "The take was saved to the library below.",
    });
  };

  const runProbe = async () => {
    setProbing(true);
    const result = await probeEndpoint(url);
    setProbe(result);
    setProbing(false);
    if (result.ok) {
      toast.success(`Endpoint reachable in ${result.ms} ms`, { description: url });
    } else {
      toast.error("Endpoint unreachable", { description: result.note });
    }
  };

  /** Punch up one of the eight house outputs. */
  const selectOutput = (o: OutputProfile) => {
    const codec = codecById(o.codecId);
    if (!isCodecSupported(codec.mimeType)) {
      toast.error(`${codec.label} is not supported in this browser`);
      return;
    }
    setForm((f) => ({
      ...f,
      codec: o.codecId,
      bitrateKbps: o.bitrateKbps,
      channels: o.channels,
    }));
    toast.success(`${o.label} punched up`, {
      description: `${codec.label} · ${o.bitrateKbps} kbps · ${o.channels}`,
    });
  };

  const sendNowPlaying = async () => {
    if (!npTitle.trim()) {
      toast.error("Enter a title first");
      return;
    }
    try {
      await setNowPlaying({
        title: npTitle.trim(),
        artist: npArtist.trim() || undefined,
      });
      toast.success("Metadata sent to listeners");
    } catch {
      toast.error("Could not send metadata");
    }
  };

  const lastMetadata = logEntries?.find((e) => e.kind === "metadata");

  return (
    <div className="grid gap-4 lg:grid-cols-12">
      {/* ── output matrix: eight house renditions ── */}
      <ModuleCard
        className="lg:col-span-12"
        title="Output renditions"
        subtitle="Punch up any of the eight house outputs — sets codec, bitrate and channels"
        bodyClassName="p-0"
        right={
          <span className="hidden text-[10px] text-muted-foreground sm:inline">
            {OUTPUTS.filter((o) => isCodecSupported(codecById(o.codecId).mimeType)).length}
            /{OUTPUTS.length} available in this browser
          </span>
        }
      >
        <div className="overflow-x-auto px-4 pb-4">
          <table className="w-full min-w-[46rem] text-sm">
            <thead>
              <tr className="border-b border-border/60 text-left text-[10px] font-semibold tracking-[0.1em] text-muted-foreground uppercase">
                <th className="py-2.5 pr-3 font-semibold">Output</th>
                <th className="py-2.5 pr-3 font-semibold">Codec</th>
                <th className="py-2.5 pr-3 font-semibold">Bitrate</th>
                <th className="py-2.5 pr-3 font-semibold">Channels</th>
                <th className="py-2.5 pr-3 font-semibold">Support</th>
                <th className="py-2.5 pr-3 font-semibold">Use</th>
                <th className="py-2.5 font-semibold" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border/50">
              {OUTPUTS.map((o) => {
                const codec = codecById(o.codecId);
                const ok = isCodecSupported(codec.mimeType);
                const active =
                  form.codec === o.codecId &&
                  form.bitrateKbps === o.bitrateKbps &&
                  form.channels === o.channels;
                return (
                  <tr
                    key={o.id}
                    className={cn(
                      "transition-colors hover:bg-muted/40",
                      active && "bg-signal/5",
                    )}
                  >
                    <td className="py-2.5 pr-3 text-[13px] font-medium whitespace-nowrap">
                      <span className="flex items-center gap-2">
                        <span
                          className={cn("led size-1.5", active ? "led-hot" : undefined)}
                        />
                        {o.label}
                      </span>
                    </td>
                    <td className="py-2.5 pr-3 text-xs whitespace-nowrap">{codec.label}</td>
                    <td className="text-readout py-2.5 pr-3 text-xs whitespace-nowrap">
                      {o.bitrateKbps} kbps
                    </td>
                    <td className="py-2.5 pr-3 text-xs capitalize whitespace-nowrap">
                      {o.channels}
                    </td>
                    <td className="py-2.5 pr-3">
                      <span
                        className={cn(
                          "inline-flex items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-[10px] font-semibold tracking-wide uppercase",
                          ok
                            ? "border-meter-ok/30 bg-meter-ok/10 text-meter-ok"
                            : "border-border/70 text-muted-foreground",
                        )}
                      >
                        {ok ? "Ready" : "Unsupported"}
                      </span>
                    </td>
                    <td className="py-2.5 pr-3 text-xs whitespace-nowrap text-muted-foreground">
                      {o.use}
                    </td>
                    <td className="py-2.5 text-right">
                      <Button
                        size="sm"
                        variant={active ? "default" : "outline"}
                        className="h-7 cursor-pointer text-[11px]"
                        disabled={!ok || rt.onAir}
                        onClick={() => selectOutput(o)}
                      >
                        {active ? "Active" : "Select"}
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </ModuleCard>

      {/* ── mount configuration ── */}
      <ModuleCard
        className="lg:col-span-7"
        title="Mount configuration"
        subtitle="Source endpoint your encoder connects to"
        right={
          <span className="hidden items-center gap-1.5 text-[10px] text-muted-foreground sm:flex">
            <Server className="size-3.5" />
            {form.protocol === "icecast2" ? "Icecast 2" : "Shoutcast"}
          </span>
        }
      >
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Field label="Station name" className="col-span-2 sm:col-span-3">
            <Input
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              className="h-9"
            />
          </Field>
          <Field label="Protocol">
            <Select
              value={form.protocol}
              onValueChange={(v) => setForm((f) => ({ ...f, protocol: v }))}
            >
              <SelectTrigger className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="icecast2">Icecast 2</SelectItem>
                <SelectItem value="shoutcast">Shoutcast</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Server host">
            <Input
              value={form.server}
              onChange={(e) => setForm((f) => ({ ...f, server: e.target.value }))}
              className="h-9"
              placeholder="stream.example.com"
            />
          </Field>
          <Field label="Port">
            <Input
              type="number"
              value={form.port}
              onChange={(e) =>
                setForm((f) => ({ ...f, port: Number(e.target.value) || 0 }))
              }
              className="h-9"
            />
          </Field>
          <Field label="Mount point">
            <Input
              value={form.mount}
              onChange={(e) => setForm((f) => ({ ...f, mount: e.target.value }))}
              className="h-9 font-mono text-xs"
              placeholder="/live"
            />
          </Field>
          <Field label="Source user">
            <Input
              value={form.username}
              onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))}
              className="h-9"
            />
          </Field>
          <Field label="Password">
            <Input
              type="password"
              value={form.password}
              onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
              className="h-9"
              autoComplete="off"
            />
          </Field>

          <div className="col-span-2 my-1 border-t border-border/60 sm:col-span-3" />

          <Field label="Codec">
            <Select
              value={form.codec}
              onValueChange={(v) => setForm((f) => ({ ...f, codec: v }))}
            >
              <SelectTrigger className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CODECS.map((c) => {
                  const ok = isCodecSupported(c.mimeType);
                  return (
                    <SelectItem key={c.id} value={c.id} disabled={!ok}>
                      {c.label}
                      {!ok && " — unsupported"}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Bitrate">
            <Select
              value={String(form.bitrateKbps)}
              onValueChange={(v) => setForm((f) => ({ ...f, bitrateKbps: Number(v) }))}
            >
              <SelectTrigger className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {BITRATES.map((b) => (
                  <SelectItem key={b} value={String(b)}>
                    {b} kbps
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Sample rate">
            <Select
              value={String(form.sampleRateKhz)}
              onValueChange={(v) => setForm((f) => ({ ...f, sampleRateKhz: Number(v) }))}
            >
              <SelectTrigger className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="48">48 kHz</SelectItem>
                <SelectItem value="44.1">44.1 kHz</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Channels">
            <Select
              value={form.channels}
              onValueChange={(v) => setForm((f) => ({ ...f, channels: v }))}
            >
              <SelectTrigger className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="stereo">Stereo</SelectItem>
                <SelectItem value="mono">Mono</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <div className="col-span-2 flex items-end gap-2 sm:col-span-2">
            <Button
              className="h-9 flex-1"
              onClick={() => void persistConfig(true)}
              disabled={saving}
            >
              Save configuration
            </Button>
            <Button
              variant="outline"
              className="h-9"
              onClick={() => void runProbe()}
              disabled={probing}
            >
              {probing ? "Probing…" : "Probe"}
            </Button>
          </div>
        </div>

        <div className="mt-4 rounded-lg border border-border/60 bg-muted/50 p-3">
          <p className="text-[10px] font-semibold tracking-[0.1em] text-muted-foreground uppercase">
            Endpoint
          </p>
          <p className="text-readout mt-1 text-xs break-all text-foreground/90">{url}</p>
          {supported.length > 0 && (
            <p className="mt-2 text-[10px] text-muted-foreground">
              Browser encoders available here:{" "}
              {supported.map((c) => c.label).join(" · ")}
            </p>
          )}
          {probe && (
            <p
              className={cn(
                "mt-2 flex items-center gap-1.5 text-[11px]",
                probe.ok ? "text-meter-ok" : "text-destructive",
              )}
            >
              <CheckCircle2 className="size-3.5" />
              {probe.ok ? `Reachable · ${probe.ms} ms` : probe.note}
            </p>
          )}
        </div>
      </ModuleCard>

      {/* ── on-air control ── */}
      <div className="flex flex-col gap-4 lg:col-span-5">
        <div className="panel rounded-xl p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <span
                className={cn(
                  "led",
                  rt.onAir ? "led-hot animate-pulse-live" : undefined,
                )}
              />
              <span className="text-[11px] font-semibold tracking-[0.18em] text-panel-mut uppercase">
                Stream encoder
              </span>
            </div>
            <span
              className={cn(
                "rounded-full px-2.5 py-1 text-[10px] font-bold tracking-[0.16em] uppercase",
                rt.onAir
                  ? "bg-signal text-signal-fg animate-pulse-live"
                  : "bg-white/10 text-panel-mut",
              )}
            >
              {rt.onAir ? "On air" : "Off air"}
            </span>
          </div>

          <div className="mt-4 grid grid-cols-4 gap-2">
            {[
              { label: "Uptime", value: formatUptime(uptime) },
              {
                label: "Measured",
                value: rt.onAir ? `${rt.stats.kbps.toFixed(0)}` : "—",
                sub: "kbps",
              },
              { label: "Target", value: String(form.bitrateKbps), sub: "kbps" },
              { label: "Sent", value: formatBytes(rt.stats.bytes) },
            ].map((s) => (
              <div key={s.label} className="panel-well rounded-md px-2 py-2">
                <p className="text-[8px] font-semibold tracking-[0.12em] text-panel-mut uppercase">
                  {s.label}
                </p>
                <p className="text-readout mt-1 text-sm font-medium text-panel-fg">
                  {s.value}
                  {s.sub && (
                    <span className="ml-0.5 text-[8px] text-panel-mut">{s.sub}</span>
                  )}
                </p>
              </div>
            ))}
          </div>

          <Button
            className={cn(
              "mt-4 h-11 w-full text-sm font-bold tracking-[0.14em] uppercase",
              rt.onAir
                ? "bg-white/10 text-panel-fg hover:bg-white/20"
                : "bg-signal text-signal-fg hover:bg-signal-strong",
            )}
            onClick={() => (rt.onAir ? void disconnect() : void connect())}
          >
            {rt.onAir ? (
              <>
                <Square className="mr-2 size-3.5" /> Stop broadcast
              </>
            ) : (
              <>
                <Radio className="mr-2 size-4" /> Go on air
              </>
            )}
          </Button>
          <p className="mt-2 text-center text-[10px] text-panel-mut">
            {rt.onAir
              ? `Encoding ${currentCodec.label} @ ${form.bitrateKbps} kbps → ${url}`
              : "The encoder keeps running across tabs until you stop it."}
          </p>
        </div>

        {/* ── now playing ── */}
        <ModuleCard
          title="Now playing"
          subtitle="ICY metadata pushed to every listener"
          right={
            <span className="text-[10px] text-muted-foreground">
              {mountDoc?.nowPlayingTitle
                ? `${mountDoc.nowPlayingArtist ?? ""} ${mountDoc.nowPlayingArtist ? "·" : ""} ${mountDoc.nowPlayingTitle}`
                : "no metadata set"}
            </span>
          }
        >
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="flex-1">
              <Field label="Title">
                <Input
                  value={npTitle}
                  onChange={(e) => setNpTitle(e.target.value)}
                  placeholder="Midnight Drive"
                  className="h-9"
                />
              </Field>
            </div>
            <div className="flex-1">
              <Field label="Artist">
                <Input
                  value={npArtist}
                  onChange={(e) => setNpArtist(e.target.value)}
                  placeholder="Nova Waves"
                  className="h-9"
                />
              </Field>
            </div>
            <Button className="h-9 shrink-0" onClick={() => void sendNowPlaying()}>
              <Send className="mr-1.5 size-3.5" />
              Send
            </Button>
          </div>
          {lastMetadata && (
            <p className="mt-3 text-[11px] text-muted-foreground">
              Last sent: <span className="text-foreground/80">{lastMetadata.title}</span>
            </p>
          )}
        </ModuleCard>
      </div>

      {/* ── takes ── */}
      <ModuleCard
        className="lg:col-span-12"
        title="Recorded takes"
        subtitle="Every completed broadcast is downloadable here"
        bodyClassName="p-0"
        right={
          <div className="hidden sm:block">
            <StereoLevelMeter kind="out" height={54} />
          </div>
        }
      >
        {rt.takes.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">
            No takes yet — stop a broadcast and the encoded file appears here.
          </p>
        ) : (
          <ul className="divide-y divide-border/60">
            {rt.takes.map((take) => (
              <li key={take.id} className="flex items-center gap-4 px-4 py-3">
                <span className="flex size-8 items-center justify-center rounded-md bg-signal/10 text-signal">
                  <Radio className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{form.name} broadcast</p>
                  <p className="text-[11px] text-muted-foreground">
                    {formatBytes(take.bytes)} · {formatUptime(take.durationMs)} ·{" "}
                    {new Date(take.at).toLocaleTimeString()}
                  </p>
                </div>
                <a
                  href={take.url}
                  download={`${form.name.replace(/\s+/g, "-").toLowerCase()}-${take.id}.${take.ext}`}
                  className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border/70 px-3 text-xs font-medium text-foreground/90 transition-colors hover:bg-accent"
                >
                  <Download className="size-3.5" />
                  Download
                </a>
              </li>
            ))}
          </ul>
        )}
      </ModuleCard>
    </div>
  );
}
