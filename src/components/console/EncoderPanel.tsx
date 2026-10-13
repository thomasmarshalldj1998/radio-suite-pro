import { StereoLevelMeter } from "@/components/console/Meters";
import { ModuleCard } from "@/components/console/ModuleCard";
import { api } from "@/convex/_generated/api";
import { getEngine } from "@/lib/audio/engine";
import {
  CODECS,
  codecById,
  formatBytes,
  FORMATS,
  formatProfile,
  formatUptime,
  isCodecSupported,
  jsFormatFor,
  mountUrl,
  probeEndpoint,
  supportedCodecs,
  StreamEncoder,
  type EncoderStats,
  type ProbeResult,
} from "@/lib/audio/encoder";
import { JsStreamEncoder } from "@/lib/audio/js-encoder";
import {
  EMPTY_SLOT,
  OUTPUT_COUNT,
  isConfigured,
  outputStatus,
  seedOutputIfEmpty,
  setLiveOutput,
  setProbes,
  updateOutput,
  useOutputs,
  type MountForm,
} from "@/lib/audio/outputs";
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
  RotateCw,
  Send,
  Server,
  Square,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

const BITRATES = [48, 64, 96, 128, 160, 192, 256, 320];

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

  const { slots, liveSlot } = useOutputs();
  const [sel, setSel] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const form = slots[sel] ?? EMPTY_SLOT;
  const setForm = (updater: (prev: MountForm) => MountForm) =>
    updateOutput(sel, updater);
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
      const seeded: MountForm = {
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
        targetFormat: mountDoc.targetFormat ?? "",
      };
      seedOutputIfEmpty(seeded);
      setNpTitle(mountDoc.nowPlayingTitle ?? "");
      setNpArtist(mountDoc.nowPlayingArtist ?? "");
    }
  }, [mountDoc]);

  const supported = supportedCodecs();
  const currentCodec = codecById(form.codec);
  const url = isConfigured(form) ? mountUrl(form) : "";
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
    if (!isConfigured(form)) {
      toast.error("Select and configure an output first");
      return;
    }
    const targetFmt = FORMATS.find((f) => formatProfile(f) === form.targetFormat);
    const jsFmt = targetFmt ? jsFormatFor(targetFmt.id) : null;
    if (!jsFmt && !isCodecSupported(currentCodec.mimeType)) {
      toast.error(`${currentCodec.label} is not supported in this browser`);
      return;
    }
    try {
      if (!engine.powered) await engine.powerOn();
      setLiveOutput(sel);

      // WASM-backed formats (MP3 / FLAC / Ogg Vorbis / HE-AAC v2) encode in a
      // worker straight off the program bus — no MediaRecorder involved
      if (jsFmt && targetFmt) {
        const enc = new JsStreamEncoder({
          format: jsFmt,
          sampleRate: engine.sampleRate || 48000,
          channels: 2,
          bitrateKbps: form.bitrateKbps || 128,
        });
        enc.onStats = (stats: EncoderStats) => patchRuntime({ stats });
        await enc.start();
        patchRuntime({
          encoder: enc,
          onAir: true,
          startedAt: Date.now(),
          stats: { bytes: 0, elapsedMs: 0, kbps: 0, chunks: 0 },
        });
        void saveMount({ ...form });
        void pushLog({
          kind: "session",
          title: `ON AIR — ${form.name}`,
          detail: `${targetFmt.label} · WASM encoder @ ${(engine.sampleRate / 1000).toFixed(1)} kHz → ${url}`,
        });
        toast.success("You are on air", {
          description: `${targetFmt.label} · encoded natively at ${(engine.sampleRate / 1000).toFixed(1)} kHz`,
        });
        return;
      }

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
      ext: runtime.encoder.ext || currentCodec.ext,
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
    if (!isConfigured(form)) {
      toast.error("Select and configure an output first");
      return;
    }
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

  /** RETRY ALL — probe every configured output endpoint in the matrix. */
  const retryAll = async () => {
    const targets = slots
      .map((s, i) => ({ s, i }))
      .filter(({ s }) => s.server);
    if (targets.length === 0) {
      toast.error("No configured outputs to retry");
      return;
    }
    setRetrying(true);
    const next: Record<number, ProbeResult> = {};
    for (const { s, i } of targets) next[i] = await probeEndpoint(mountUrl(s));
    setProbes(next);
    setRetrying(false);
    const ok = targets.filter(({ i }) => next[i].ok).length;
    if (ok === targets.length) {
      toast.success(`${ok}/${targets.length} endpoints reachable`);
    } else {
      toast.error(`${targets.length - ok}/${targets.length} endpoints unreachable`);
    }
  };

  /** EXPORT CONFIG — download the full 8-output matrix as JSON. */
  const exportConfig = () => {
    const payload = {
      exportedAt: new Date().toISOString(),
      outputs: slots.map((s, i) => ({
        output: i + 1,
        name: s.name || null,
        configured: isConfigured(s),
        protocol: s.protocol || null,
        endpoint: s.server
          ? `${s.protocol || "icecast2"}://${s.server}:${s.port}${s.mount}`
          : null,
        codec: s.codec,
        bitrateKbps: s.bitrateKbps || null,
        sampleRateKhz: s.sampleRateKhz,
        channels: s.channels,
        targetFormat: s.targetFormat || null,
      })),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const u = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = u;
    a.download = `signalpath-outputs-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(u);
    toast.success("Output configuration exported");
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
      {/* ── output matrix: 8 broadcast outputs ── */}
      <ModuleCard
        className="lg:col-span-6"
        title="Outputs 1–4"
        subtitle="Click a row to edit it in the mount configuration below"
        bodyClassName="p-0"
      >
        <OutputTable slots={slots} from={0} sel={sel} onSelect={setSel} />
      </ModuleCard>
      <ModuleCard
        className="lg:col-span-6"
        title="Outputs 5–8"
        subtitle="Per-output status: ready · on air · reachable"
        bodyClassName="p-0"
      >
        <OutputTable slots={slots} from={4} sel={sel} onSelect={setSel} />
      </ModuleCard>
      <div className="flex flex-wrap items-center gap-2 lg:col-span-12">
        <Button
          size="sm"
          variant="outline"
          className="h-8 cursor-pointer text-[11px] tracking-wide uppercase"
          onClick={() => void retryAll()}
          disabled={retrying}
        >
          <RotateCw className="size-3.5" />
          {retrying ? "Retrying…" : "Retry all"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-8 cursor-pointer text-[11px] tracking-wide uppercase"
          onClick={() => void disconnect()}
        >
          <Square className="size-3.5" />
          Stop all
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-8 cursor-pointer text-[11px] tracking-wide uppercase"
          onClick={exportConfig}
        >
          <Download className="size-3.5" />
          Export config
        </Button>
        <span className="ml-auto hidden text-[10px] text-muted-foreground sm:inline">
          {slots.filter(isConfigured).length}/{OUTPUT_COUNT} outputs configured
          {rt.onAir ? ` · broadcasting output ${liveSlot + 1}` : ""}
        </span>
      </div>

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
          </p>            <p className="text-readout mt-1 text-xs break-all text-foreground/90">
              {url || "— select a configured output —"}
            </p>
          {form.targetFormat && (
            <p className="mt-2 text-[10px] text-muted-foreground">
              Target profile:{" "}
              <span className="text-foreground/80">{form.targetFormat}</span>
            </p>
          )}
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

      {/* ── stream TX transmitter ── */}
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
                Stream TX
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

          {/* transmitter identity: what this TX is broadcasting */}
          <div className="panel-well mt-3 rounded-md px-2.5 py-2">
            <p className="text-[8px] font-semibold tracking-[0.12em] text-panel-mut uppercase">
              Transmitting
            </p>
            <p className="mt-0.5 truncate text-sm font-semibold text-white">
              {form.name || "— no output selected —"}
            </p>
            <p className="text-readout mt-0.5 truncate text-[10px] text-panel-mut">
              {url || "—"}
              {rt.onAir ? ` · ${currentCodec.label} · ${form.channels}` : ""}
            </p>
          </div>

          <div className="mt-3 grid grid-cols-4 gap-2">
            {[
              { label: "Uptime", value: formatUptime(uptime) },
              {
                label: "Measured",
                value: rt.onAir ? `${rt.stats.kbps.toFixed(2)}` : "—",
                sub: "kbps",
              },
              {
                label: "Target",
                value: form.bitrateKbps ? String(form.bitrateKbps) : "—",
                sub: form.bitrateKbps ? "kbps" : undefined,
              },
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

/* ── 8-output status matrix ─────────────────────────────────────────────── */

function OutputTable({
  slots,
  from,
  sel,
  onSelect,
}: {
  slots: MountForm[];
  from: number;
  sel: number;
  onSelect: (i: number) => void;
}) {
  return (
    <div className="px-4 pb-4">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border/60 text-left text-[10px] font-semibold tracking-[0.1em] text-muted-foreground uppercase">
            <th className="w-8 py-2 pr-2 font-semibold">#</th>
            <th className="py-2 pr-3 font-semibold">Name</th>
            <th className="py-2 pr-3 font-semibold">Proto</th>
            <th className="py-2 pr-3 font-semibold">Bitrate</th>
            <th className="py-2 font-semibold">Status</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/50">
          {slots.slice(from, from + 4).map((s, k) => {
            const i = from + k;
            const configured = isConfigured(s);
            const st = outputStatus(i);
            return (
              <tr
                key={i}
                onClick={() => onSelect(i)}
                className={cn(
                  "cursor-pointer transition-colors",
                  sel === i ? "bg-signal/10" : "hover:bg-muted/40",
                )}
              >
                <td className="py-2.5 pr-2">
                  <span
                    className={cn(
                      "text-readout text-[11px] font-medium",
                      sel === i ? "text-signal" : "text-muted-foreground",
                    )}
                  >
                    {i + 1}
                  </span>
                </td>
                <td className="min-w-0 py-2 pr-3">
                  <p className="truncate text-[13px] font-medium text-white">
                    {configured ? s.name || "Untitled output" : "―"}
                  </p>
                  {configured && (
                    <p className="truncate text-[9px] text-muted-foreground">
                      {s.server}
                      {s.port ? `:${s.port}` : ""}
                      {s.mount}
                    </p>
                  )}
                </td>
                <td className="py-2 pr-3 text-xs whitespace-nowrap">
                  {!configured ? (
                    "―"
                  ) : s.protocol === "shoutcast" ? (
                    "Shoutcast"
                  ) : (
                    "Icecast 2"
                  )}
                </td>
                <td className="text-readout py-2 pr-3 text-xs whitespace-nowrap">
                  {configured && s.bitrateKbps > 0
                    ? `${s.bitrateKbps} kbps`
                    : "―"}
                </td>
                <td className="py-2">
                  {st.kind === "empty" ? (
                    <span className="text-muted-foreground">―</span>
                  ) : st.kind === "onair" ? (
                    <span className="rounded bg-[#ff3b30] px-1.5 py-0.5 text-[9px] font-bold tracking-[0.12em] text-white uppercase">
                      On air
                    </span>
                  ) : st.kind === "ok" ? (
                    <span className="rounded border border-meter-ok/30 bg-meter-ok/10 px-1.5 py-0.5 text-[9px] font-semibold tracking-[0.12em] text-meter-ok uppercase">
                      {st.label}
                    </span>
                  ) : st.kind === "error" ? (
                    <span className="rounded border border-meter-hot/30 bg-meter-hot/10 px-1.5 py-0.5 text-[9px] font-semibold tracking-[0.12em] text-meter-hot uppercase">
                      Error
                    </span>
                  ) : (
                    <span className="rounded border border-border/70 px-1.5 py-0.5 text-[9px] font-semibold tracking-[0.12em] text-muted-foreground uppercase">
                      Ready
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
