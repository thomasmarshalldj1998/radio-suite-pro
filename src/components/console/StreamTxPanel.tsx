import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ModuleCard } from "@/components/console/ModuleCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { getEngine } from "@/lib/audio/engine";
import {
  FORMATS,
  StreamEncoder,
  codecById,
  formatBytes,
  formatProfile,
  formatTiming,
  formatUptime,
  isCodecSupported,
  jsFormatFor,
  mountUrl,
  type BroadcastFormat,
  type EncoderStats,
} from "@/lib/audio/encoder";
import { JsStreamEncoder } from "@/lib/audio/js-encoder";
import { MpxStreamEncoder } from "@/lib/audio/fm";
import { FmPanel } from "@/components/console/FmPanel";
import { MpxLinkPanel } from "@/components/console/MpxLinkPanel";
import {
  IDLE_TX,
  STREAM_METAINT,
  StreamClient,
  isStreamableContainer,
  streamTitle,
  type StreamClientState,
} from "@/lib/audio/stream-client";
import {
  getRuntime,
  patchRuntime,
  subscribeRuntime,
} from "@/lib/audio/runtime";
import {
  EMPTY_SLOT,
  isConfigured,
  seedOutputIfEmpty,
  setLiveOutput,
  updateOutput,
  useOutputs,
  type MountForm,
} from "@/lib/audio/outputs";
import {
  useMount,
  usePushLog,
  useSaveMount,
  useSetNowPlaying,
} from "@/lib/backend/hooks";
import type { ProcessorParams } from "@/lib/audio/params";
import { DEFAULT_ADVANCED } from "@/lib/audio/advanced";

const BITRATES = [48, 64, 96, 128, 160, 192, 256, 320];

/** Event-handler timestamp; kept out of the component body for lint purity. */
const wallClock = (): number => Date.now();
const SECONDARY_KEY = "signalpath.secondary.v1";

interface SecondaryConfig {
  enabled: boolean;
  server: string;
  port: number;
  mount: string;
  username: string;
  password: string;
}

const EMPTY_SECONDARY: SecondaryConfig = {
  enabled: false,
  server: "",
  port: 8000,
  mount: "/backup",
  username: "source",
  password: "",
};

function loadSecondary(): SecondaryConfig {
  try {
    const raw = localStorage.getItem(SECONDARY_KEY);
    if (!raw) return { ...EMPTY_SECONDARY };
    return { ...EMPTY_SECONDARY, ...(JSON.parse(raw) as Partial<SecondaryConfig>) };
  } catch {
    return { ...EMPTY_SECONDARY };
  }
}

/** Panel status per the v3.1 encoder spec. */
type PanelState = "optimising" | "active" | "underflow" | "failed";

function panelState(tx: StreamClientState, onAir: boolean): {
  state: PanelState;
  glyph: string;
  label: string;
  tone: string;
} {
  if (!onAir) {
    return { state: "optimising", glyph: "●", label: "Optimising", tone: "text-panel-mut" };
  }
  if (tx.status === "offline" || tx.transport === "none") {
    return { state: "failed", glyph: "✗", label: "Failed", tone: "text-meter-hot" };
  }
  if (tx.warning || tx.status === "retrying") {
    return { state: "underflow", glyph: "⚠", label: "Underflow", tone: "text-amber-led" };
  }
  if (tx.status === "live") {
    return { state: "active", glyph: "●", label: "Active", tone: "text-meter-ok" };
  }
  return { state: "optimising", glyph: "●", label: "Optimising", tone: "text-amber-led" };
}

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
    <label className={cn("flex flex-col gap-1", className)}>
      <span className="text-[9px] font-semibold tracking-[0.14em] text-panel-mut uppercase">
        {label}
      </span>
      {children}
    </label>
  );
}

function Stat({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div className="rounded border border-rack-line/70 bg-rack-2/60 px-3 py-2">
      <p className="text-[9px] tracking-[0.14em] text-panel-mut uppercase">{label}</p>
      <p className="text-readout mt-1 text-right text-sm font-semibold text-white">
        {value}
        {unit && <span className="ml-1 text-[10px] text-panel-mut">{unit}</span>}
      </p>
    </div>
  );
}

/**
 * Start a source socket for an encoder that is already producing bytes.
 * A second client (simulcast) receives the same chunks.
 */
function openSource({
  encoder,
  mime,
  label,
  form,
  url,
  title,
  log,
  extra,
}: {
  encoder: { onChunk: ((bytes: Uint8Array) => void) | null };
  mime: string;
  label: string;
  form: MountForm;
  url: string;
  title: string;
  log: (entry: {
    kind: "session" | "error";
    title: string;
    detail?: string;
  }) => Promise<unknown>;
  extra?: StreamClient | null;  }): StreamClient | null {
  if (!isStreamableContainer(mime)) {
    toast.warning("Uplink skipped — this container can't be a source", {
      description: "Pick MP3, Ogg/Opus, AAC or FLAC to go live.",
    });
    void extra?.stop();
    patchRuntime({ tx: { ...getRuntime().tx, status: "offline", transport: "none" } });
    return null;
  }
  const client = new StreamClient();
  let lastStatus = "";
  client.onState = (s: StreamClientState) => {
    patchRuntime({ tx: s });
    if (s.status === lastStatus) return;
    lastStatus = s.status;
    if (s.status === "live") {
      void log({
        kind: "session",
        title: `Source connected — ${form.name}`,
        detail: `${label} → ${url}`,
      });
    } else if (s.status === "retrying") {
      void log({
        kind: "error",
        title: "Source connection lost — retrying",
        detail: s.error ?? "unknown error",
      });
    }
  };
  encoder.onChunk = (bytes) => {
    client.push(bytes);
    extra?.push(bytes);
  };
  if (title) client.setMetadata(title);
  void client.start({
    protocol: form.protocol,
    server: form.server,
    port: form.port,
    mount: form.mount,
    backupMount: form.backupMount || undefined,
    username: form.username || "source",
    password: form.password,
    contentType: mime,
    metaint: STREAM_METAINT,
    name: form.name || "Signalpath",
    bitrateKbps: form.bitrateKbps,
    secure: /^https/i.test(form.protocol) || form.port === 443,
  });
  return client;
}

export function StreamTxPanel({
  params,
  setParams,
}: {
  params: ProcessorParams;
  setParams: React.Dispatch<React.SetStateAction<ProcessorParams>>;
}) {
  const engine = getEngine();
  const mountDoc = useMount();
  const saveMount = useSaveMount();
  const setNowPlaying = useSetNowPlaying();
  const pushLog = usePushLog();
  const { slots, liveSlot } = useOutputs();

  const [selected, setSelected] = useState(0);
  const [secondary, setSecondary] = useState<SecondaryConfig>(loadSecondary);
  const [advanced, setAdvanced] = useState(false);
  const [npTitle, setNpTitle] = useState("");
  const [npArtist, setNpArtist] = useState("");
  const [saving, setSaving] = useState(false);
  const [meter, setMeter] = useState({
    fill: 0,
    frameMs: 0,
    lufs: -70,
    peak: -70,
    bufferMs: 0,
    drops: 0,
  });
  const [rt, setRt] = useState(() => ({
    onAir: getRuntime().onAir,
    stats: getRuntime().stats,
    tx: getRuntime().tx,
    tx2: getRuntime().tx2,
    connects: getRuntime().connects,
    lastError: getRuntime().lastError,
  }));
  const lastMetaRef = useRef("");
  const loadedRef = useRef(false);
  /** Guards against a double Start while the first connection is opening. */
  const startingRef = useRef(false);
  // While on air the panel stays on the live slot; before/after it edits the
  // operator's selected slot from the saved matrix.
  const sel = rt.onAir && liveSlot >= 0 ? liveSlot : selected;
  const form = slots[sel] ?? EMPTY_SLOT;
  const setForm = (updater: (prev: MountForm) => MountForm) => updateOutput(sel, updater);

  useEffect(
    () =>
      subscribeRuntime(() => {
        const r = getRuntime();
        setRt({
          onAir: r.onAir,
          stats: r.stats,
          tx: r.tx,
          tx2: r.tx2,
          connects: r.connects,
          lastError: r.lastError,
        });
      }),
    [],
  );

  useEffect(() => {
    if (mountDoc && !loadedRef.current) {
      loadedRef.current = true;
      seedOutputIfEmpty({
        ...EMPTY_SLOT,
        name: mountDoc.name,
        protocol: mountDoc.protocol,
        server: mountDoc.server,
        port: mountDoc.port,
        mount: mountDoc.mount,
        backupMount: mountDoc.backupMount ?? "",
        username: mountDoc.username,
        password: mountDoc.password,
        codec: mountDoc.codec,
        bitrateKbps: mountDoc.bitrateKbps,
        sampleRateKhz: mountDoc.sampleRateKhz,
        channels: mountDoc.channels,
        targetFormat: mountDoc.targetFormat ?? "",
      });
      setNpTitle(mountDoc.nowPlayingTitle ?? "");
      setNpArtist(mountDoc.nowPlayingArtist ?? "");
    }
  }, [mountDoc]);

  useEffect(() => {
    const id = window.setInterval(() => {
      const r = getRuntime();
      const settings = r.source?.getTxSettings();
      const ceiling = Math.max(3000, (settings?.bufferMs ?? 500) * 3);
      const snap = getEngine().snapshot();
      setMeter({
        fill: r.onAir ? Math.max(0, Math.min(100, (r.tx.bufferedMs / ceiling) * 100)) : 0,
        frameMs: snap.perf.frameMs,
        lufs: snap.lufsS,
        peak: snap.truePeak,
        bufferMs: r.tx.bufferedMs,
        drops: r.tx.protectedBytes + r.tx.droppedBytes,
      });
    }, 500);
    return () => window.clearInterval(id);
  }, []);

  const activeFmt: BroadcastFormat | undefined = FORMATS.find(
    (f) => formatProfile(f) === form.targetFormat,
  );
  const codec = codecById(form.codec);
  const url = isConfigured(form) ? mountUrl(form) : "";
  const status = panelState(rt.tx, rt.onAir);

  const saveSecondary = (next: SecondaryConfig) => {
    setSecondary(next);
    try {
      localStorage.setItem(SECONDARY_KEY, JSON.stringify(next));
    } catch {
      /* storage unavailable */
    }
  };

  const pickProfile = (id: string) => {
    const f = FORMATS.find((x) => x.id === id);
    if (!f) return;
    setForm((prev) => ({
      ...prev,
      bitrateKbps: f.bitrateKbps > 0 ? f.bitrateKbps : prev.bitrateKbps,
      sampleRateKhz: f.sampleRateKhz,
      channels: f.channels.toLowerCase().includes("mono") ? "mono" : "stereo",
      targetFormat: formatProfile(f),
    }));
  };

  /** Auto/Off/Flat pre-shape maps onto the delivery codec filter. */
  const setPreShape = (mode: "auto" | "off" | "flat") => {
    const target =
      activeFmt?.id.startsWith("mp3")
        ? "mp3"
        : activeFmt?.id.startsWith("aac") || activeFmt?.id.startsWith("heaac")
          ? "aac"
          : "opus";
    setParams((p) => {
      const adv = p.advanced ?? DEFAULT_ADVANCED;
      return {
        ...p,
        advanced: {
          ...adv,
          limiter: {
            ...adv.limiter,
            codec: {
              ...adv.limiter.codec,
              on: mode !== "off",
              target,
              lowpassHz: mode === "flat" ? 20000 : 16000,
              hfPreserve: mode === "flat" ? 100 : 50,
            },
          },
        },
      };
    });
    toast.success(`Pre-shape · ${mode}`, {
      description:
        mode === "auto"
          ? "Rolls HF and protects the voice band for this codec/bitrate."
          : mode === "flat"
            ? "Full-band pre-shape — no extra HF roll-off."
            : "Codec pre-shaping bypassed.",
    });
  };

  const connect = async () => {
    if (rt.onAir || startingRef.current) return;
    startingRef.current = true;
    if (!isConfigured(form)) {
      toast.error("Configure the primary stream first");
      return;
    }
    const jsFmt = activeFmt ? jsFormatFor(activeFmt.id) : null;
    const mpxFmt = activeFmt?.id === "mpx-flac-192";
    if (!jsFmt && !mpxFmt && !isCodecSupported(codec.mimeType)) {
      toast.error(`${codec.label} is not supported in this browser`);
      return;
    }
    const secondaryReady =
      secondary.enabled && secondary.server.trim().length > 0;
    let encoder: StreamEncoder | JsStreamEncoder | MpxStreamEncoder | null = null;
    let mirror: StreamClient | null = null;
    try {
      if (!engine.powered) await engine.powerOn();
      setLiveOutput(sel);
      engine.setStreamBitrate(form.bitrateKbps);

      const title = lastMetaRef.current || streamTitle(npArtist, npTitle);
      // The mirror needs the *same encoded bytes*, so its container type is
      // the primary encoder's MIME, not the profile's file extension.
      const openMirror = (mime: string): StreamClient | null => {
        if (!secondaryReady) return null;
        const mirror = new StreamClient();
        mirror.onState = (s) => patchRuntime({ tx2: s });
        if (title) mirror.setMetadata(title);
        void mirror.start({
          protocol: form.protocol,
          server: secondary.server.trim(),
          port: secondary.port,
          mount: secondary.mount,
          username: secondary.username || "source",
          password: secondary.password,
          contentType: mime,
          metaint: STREAM_METAINT,
          name: `${form.name || "Signalpath"} (secondary)`,
          bitrateKbps: form.bitrateKbps,
          secure: /^https/i.test(form.protocol) || secondary.port === 443,
        });
        return mirror;
      };
      if (jsFmt && activeFmt) {
        const enc = new JsStreamEncoder({
          format: jsFmt,
          sampleRate: engine.sampleRate || 48000,
          channels: 2,
          bitrateKbps: form.bitrateKbps || 128,
        });
        enc.onStats = (stats: EncoderStats) => patchRuntime({ stats });
        await enc.start();
        encoder = enc;
        mirror = openMirror(enc.mime);
        const source = openSource({
          encoder: enc,
          mime: enc.mime,
          label: activeFmt.label,
          form,
          url,
          title,
          log: pushLog,
          extra: mirror,
        });
        if (!source) throw new Error("This codec cannot be sent as a live source");
        patchRuntime({ source });
      } else if (mpxFmt && activeFmt) {
        if (!params.fm.on) throw new Error("Engage the FM module first — the composite feed lives there");
        const enc = new MpxStreamEncoder();
        enc.onStats = (stats: EncoderStats) => patchRuntime({ stats });
        await enc.start();
        encoder = enc;
        mirror = openMirror("audio/flac");
        const source = openSource({
          encoder: enc,
          mime: "audio/flac",
          label: activeFmt.label,
          form,
          url,
          title,
          log: pushLog,
          extra: mirror,
        });
        if (!source) throw new Error("The MPX composite cannot be sent as a live source");
        patchRuntime({ source });
      } else {
        const stream = engine.getStream();
        if (!stream) throw new Error("No program bus available");
        const enc = new StreamEncoder(stream, {
          mimeType: codec.mimeType,
          bitsPerSecond: form.bitrateKbps * 1000,
        });
        enc.onStats = (stats: EncoderStats) => patchRuntime({ stats });
        enc.start(1000);
        encoder = enc;
        mirror = openMirror(codec.mimeType);
        const source = openSource({
          encoder: enc,
          mime: codec.mimeType,
          label: codec.label,
          form,
          url,
          title,
          log: pushLog,
          extra: mirror,
        });
        if (!source) throw new Error("This browser codec cannot be sent as a live source");
        patchRuntime({ source });
      }

      patchRuntime({
        encoder,
        source2: mirror,
        onAir: true,
        startedAt: wallClock(),
        stats: { bytes: 0, elapsedMs: 0, kbps: 0, chunks: 0 },
        connects: rt.connects + 1,
        lastError: null,
      });
      void saveMount({ ...form });
      void pushLog({
        kind: "session",
        title: `ON AIR — ${form.name}`,
        detail: `${activeFmt?.label ?? codec.label} ${form.bitrateKbps} kbps → ${url}${
          mirror ? ` · secondary ${secondary.server}:${secondary.port}${secondary.mount}` : ""
        }`,
      });
      toast.success("You are on air", { description: url });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      void encoder?.stop().catch(() => undefined);
      getRuntime().source?.stop().catch(() => undefined);
      void mirror?.stop().catch(() => undefined);
      getRuntime().source2?.stop().catch(() => undefined);
      patchRuntime({
        onAir: false,
        encoder: null,
        source: null,
        source2: null,
        tx: { ...IDLE_TX },
        tx2: { ...IDLE_TX },
        lastError: { message, at: wallClock() },
      });
      engine.setStreamBitrate(null);
      toast.error("Could not start the encoder", { description: message });
    } finally {
      startingRef.current = false;
    }
  };

  const disconnect = async () => {
    const runtime = getRuntime();
    await runtime.source?.stop();
    await runtime.source2?.stop();
    await runtime.encoder?.stop().catch(() => undefined);
    patchRuntime({
      onAir: false,
      encoder: null,
      source: null,
      source2: null,
      tx: { ...IDLE_TX },
      tx2: { ...IDLE_TX },
      lastError: null,
    });
    engine.setStreamBitrate(null);
    toast.success("Broadcast stopped");
  };

  const sendMetadata = async () => {
    if (!npTitle.trim()) {
      toast.error("Enter a title first");
      return;
    }
    try {
      await setNowPlaying(npTitle.trim(), npArtist.trim() || undefined);
      lastMetaRef.current = streamTitle(npArtist, npTitle);
      getRuntime().source?.setMetadata(lastMetaRef.current);
      getRuntime().source2?.setMetadata(lastMetaRef.current);
      toast.success("Metadata sent to listeners");
    } catch {
      toast.error("Could not save metadata");
    }
  };

  const persist = async () => {
    setSaving(true);
    try {
      await saveMount({ ...form });
      toast.success("Configuration saved");
    } catch {
      toast.error("Could not save configuration");
    } finally {
      setSaving(false);
    }
  };

  const resetForm = () => {
    if (!mountDoc) {
      setForm(() => ({ ...EMPTY_SLOT }));
    } else {
      setForm(() => ({
        ...EMPTY_SLOT,
        name: mountDoc.name ?? "",
        protocol: mountDoc.protocol ?? "icecast2",
        server: mountDoc.server ?? "",
        port: mountDoc.port ?? 8000,
        mount: mountDoc.mount ?? "",
        backupMount: mountDoc.backupMount ?? "",
        username: mountDoc.username ?? "",
        password: mountDoc.password ?? "",
        codec: mountDoc.codec ?? "opus",
        bitrateKbps: mountDoc.bitrateKbps ?? 128,
        sampleRateKhz: mountDoc.sampleRateKhz ?? 48,
        channels: mountDoc.channels ?? "stereo",
        targetFormat: mountDoc.targetFormat ?? "",
      }));
    }
    toast.success("Form reset to the saved mount");
  };

  const exportXspf = () => {
    if (!url) {
      toast.error("Configure a stream first");
      return;
    }
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<playlist version="1" xmlns="http://xspf.org/ns/0/">
  <title>${form.name || "Signalpath"}</title>
  <trackList>
    <track>
      <title>${npTitle || form.name || "Live stream"}</title>
      <creator>${npArtist || form.name || "Signalpath"}</creator>
      <location>${url}</location>
    </track>
  </trackList>
</playlist>`;
    const blob = new Blob([xml], { type: "application/xspf+xml" });
    const href = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = href;
    a.download = `${(form.name || "signalpath").replace(/\s+/g, "-").toLowerCase()}.xspf`;
    a.click();
    URL.revokeObjectURL(href);
    toast.success("XSPF playlist exported");
  };

  const copyLink = async () => {
    if (!url) {
      toast.error("Configure a stream first");
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Stream URL copied");
    } catch {
      toast.error("Clipboard unavailable", { description: url });
    }
  };

  const timing = activeFmt ? formatTiming(activeFmt) : null;
  const secondaryReady = secondary.enabled && secondary.server.trim().length > 0;
  const secondaryStatus = panelState(rt.tx2, rt.onAir && secondaryReady);

  return (
    <div className="grid gap-4 xl:grid-cols-12">
      {/* ── 1 · primary ─────────────────────────────────────────────── */}
      <ModuleCard
        className="xl:col-span-5"
        title="Primary stream"
        subtitle="Source endpoint · codec · pre-shape"
        right={
          <span className={cn("text-readout text-[11px] font-bold tracking-wide", status.tone)}>
            {status.glyph} {status.label}
          </span>
        }
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label="Output slot" className="col-span-2">
            <Select
              value={String(sel)}
              onValueChange={(v) => {
                if (!rt.onAir) setSelected(Number(v));
              }}
            >
              <SelectTrigger className="h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {slots.map((s, i) => (
                  <SelectItem key={i} value={String(i)}>
                    {`${i + 1} · ${s.name || s.mount || "empty slot"}`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Codec" className="col-span-2">
            <Select
              value={form.targetFormat}
              onValueChange={(v) => {
                const f = FORMATS.find((x) => formatProfile(x) === v);
                if (f) pickProfile(f.id);
              }}
            >
              <SelectTrigger className="h-8">
                <SelectValue placeholder="Choose a profile" />
              </SelectTrigger>
              <SelectContent>
                {FORMATS.map((f) => (
                  <SelectItem key={f.id} value={formatProfile(f)}>
                    {f.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Bitrate">
            <Select
              value={String(form.bitrateKbps)}
              onValueChange={(v) => setForm((f) => ({ ...f, bitrateKbps: Number(v) }))}
            >
              <SelectTrigger className="h-8">
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
              <SelectTrigger className="h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="48">48 kHz</SelectItem>
                <SelectItem value="44.1">44.1 kHz</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Pre-shape">
            <Select
              defaultValue="auto"
              onValueChange={(v) => setPreShape(v as "auto" | "off" | "flat")}
            >
              <SelectTrigger className="h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">Auto</SelectItem>
                <SelectItem value="flat">Flat</SelectItem>
                <SelectItem value="off">Off</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Mount">
            <Input
              value={form.mount}
              onChange={(e) => setForm((f) => ({ ...f, mount: e.target.value }))}
              className="h-8 font-mono"
            />
          </Field>
          <Field label="Server" className="col-span-2">
            <div className="grid grid-cols-[1fr_88px] gap-2">
              <Input
                value={form.server}
                onChange={(e) => setForm((f) => ({ ...f, server: e.target.value }))}
                className="h-8 font-mono"
                placeholder="stream.example.com"
              />
              <Input
                value={form.port}
                onChange={(e) => setForm((f) => ({ ...f, port: Number(e.target.value) }))}
                className="text-readout h-8 text-right font-mono"
                inputMode="numeric"
              />
            </div>
          </Field>
          <Field label="User">
            <Input
              value={form.username}
              onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))}
              className="h-8 font-mono"
            />
          </Field>
          <Field label="Password">
            <Input
              type="password"
              value={form.password}
              onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
              className="h-8 font-mono"
            />
          </Field>
          <Field label="Now playing · title" className="col-span-2">
            <div className="grid grid-cols-[1fr_auto] gap-2">
              <Input
                value={npTitle}
                onChange={(e) => setNpTitle(e.target.value)}
                className="h-8"
                placeholder="Track title"
              />
              <Button size="sm" variant="secondary" className="h-8" onClick={() => void sendMetadata()}>
                Send
              </Button>
            </div>
          </Field>
          <Field label="Artist" className="col-span-2">
            <Input
              value={npArtist}
              onChange={(e) => setNpArtist(e.target.value)}
              className="h-8"
              placeholder="Artist"
            />
          </Field>
        </div>
        {activeFmt && (
          <p className="text-readout mt-2 text-[10px] text-panel-mut">
            {timing
              ? `Latency ~${timing.latencyMs} ms · lookahead ${timing.lookaheadMs} ms · ${activeFmt.use}`
              : `Relay profile · ${activeFmt.use}`}
          </p>
        )}
        <div className="mt-3 flex gap-2">
          <Button
            className="h-9 flex-1 text-xs font-bold tracking-[0.12em] uppercase"
            onClick={() => void (rt.onAir ? disconnect() : connect())}
          >
            {rt.onAir ? "Stop" : "Start"}
          </Button>
          <Button
            variant="secondary"
            className="h-9"
            onClick={() => void persist()}
            disabled={saving}
          >
            Save
          </Button>
        </div>
        {rt.lastError && (
          <p className="mt-2 text-[10px] text-meter-hot">{rt.lastError.message}</p>
        )}
      </ModuleCard>

      {/* ── 2 · secondary ───────────────────────────────────────────── */}
      <ModuleCard
        className="xl:col-span-3"
        title="Secondary stream"
        subtitle="Simulcast mirror · independent mount"
        right={
          <Switch
            checked={secondary.enabled}
            onCheckedChange={(v) => saveSecondary({ ...secondary, enabled: v })}
            aria-label="Enable secondary simulcast"
          />
        }
      >
        <div className="grid gap-3">
          <Field label="Server">
            <Input
              value={secondary.server}
              onChange={(e) => saveSecondary({ ...secondary, server: e.target.value })}
              className="h-8 font-mono"
              placeholder="backup.example.com"
            />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Port">
              <Input
                value={secondary.port}
                onChange={(e) => saveSecondary({ ...secondary, port: Number(e.target.value) })}
                className="text-readout h-8 text-right font-mono"
                inputMode="numeric"
              />
            </Field>
            <Field label="Mount">
              <Input
                value={secondary.mount}
                onChange={(e) => saveSecondary({ ...secondary, mount: e.target.value })}
                className="h-8 font-mono"
              />
            </Field>
          </div>
          <Field label="User">
            <Input
              value={secondary.username}
              onChange={(e) => saveSecondary({ ...secondary, username: e.target.value })}
              className="h-8 font-mono"
            />
          </Field>
          <Field label="Password">
            <Input
              type="password"
              value={secondary.password}
              onChange={(e) => saveSecondary({ ...secondary, password: e.target.value })}
              className="h-8 font-mono"
            />
          </Field>
          <p className="text-[10px] leading-4 text-panel-mut">
            Mirror uses the primary encoder and codec; both sockets reconnect
            independently. Set the server above and enable it before Start.
          </p>
          <p className={cn("text-readout text-right text-[11px] font-bold", secondaryStatus.tone)}>
            {secondaryStatus.glyph} {secondaryStatus.label}
          </p>
        </div>
      </ModuleCard>

      {/* ── 3 · metrics ─────────────────────────────────────────────── */}
      <ModuleCard className="xl:col-span-4" title="Metrics" subtitle="Measured at the send buffer">
        <div className="grid grid-cols-2 gap-2">
          <Stat label="Actual bitrate" value={rt.onAir ? rt.stats.kbps.toFixed(1) : "—"} unit="kbps" />
          <Stat label="Buffer" value={`${meter.fill.toFixed(0)}%`} unit={`${meter.bufferMs.toFixed(0)} ms`} />
          <Stat label="Dropped" value={formatBytes(meter.drops)} />
          <Stat label="Uptime" value={rt.onAir ? formatUptime(rt.stats.elapsedMs) : "—"} />
          <Stat label="LUFS-S" value={meter.lufs.toFixed(1)} unit="LUFS" />
          <Stat label="True peak" value={meter.peak.toFixed(1)} unit="dBTP" />
        </div>
        <div className="mt-2 flex items-center justify-between">
          <span className="text-[10px] text-panel-mut">
            CPU callback <span className="text-readout text-white">{meter.frameMs.toFixed(2)} ms</span>
          </span>
          <Button size="sm" variant="ghost" className="h-6 text-[10px]" onClick={() => setAdvanced((v) => !v)}>
            {advanced ? "Hide advanced" : "Advanced"}
          </Button>
        </div>
        {advanced && (
          <div className="mt-2 space-y-1 rounded border border-rack-line/60 bg-rack-2/50 p-2 text-[10px]">
            {[
              ["Reservoir", "codec-managed"],
              ["CRC", activeFmt?.id.startsWith("mp3") ? "on" : "codec-defined"],
              ["Padding", "codec-managed"],
              ["Pre-emphasis", params.fm.emphasis === "off" ? "off" : `${params.fm.emphasis} µs`],
              ["Delay", timing ? `${timing.latencyMs} ms` : "—"],
              ["Lookahead", timing ? `${timing.lookaheadMs} ms` : "—"],
              ["TX pre-buffer", "400 ms"],
            ].map(([k, v]) => (
              <div key={k} className="flex items-baseline justify-between gap-3">
                <span className="text-panel-mut uppercase">{k}</span>
                <span className="text-readout text-white">{v}</span>
              </div>
            ))}
          </div>
        )}
      </ModuleCard>

      {/* ── bottom bar ──────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2 rounded border border-rack-line/70 bg-rack-3/80 px-3 py-2 xl:col-span-12">
        <Button size="sm" variant="secondary" onClick={() => void persist()} disabled={saving}>
          Save preset
        </Button>
        <Button size="sm" variant="secondary" onClick={() => void persist()} disabled={saving}>
          Apply
        </Button>
        <Button size="sm" variant="secondary" onClick={resetForm}>
          Reset
        </Button>
        <Button size="sm" variant="secondary" onClick={exportXspf}>
          Export XSPF
        </Button>
        <Button size="sm" variant="secondary" onClick={() => void copyLink()}>
          Copy link
        </Button>
        <span className="text-readout ml-auto truncate text-[10px] text-panel-mut">{url || "no stream URL yet"}</span>
      </div>

      {/* FM / MPX stay reachable after the layout change — the MPX profile
          cannot be started without them. Collapsed so the three cards stay
          the primary workflow. */}
      <details className="rounded border border-rack-line/70 bg-rack-3/70 xl:col-span-12">
        <summary className="cursor-pointer px-3 py-2 text-[10px] font-semibold tracking-[0.16em] text-panel-mut uppercase">
          FM / MPX transmission tools
        </summary>
        <div className="space-y-4 border-t border-rack-line/60 p-3">
          <FmPanel
            fm={params.fm}
            onChange={(next) => setParams((prev) => ({ ...prev, fm: next }))}
          />
          <MpxLinkPanel fm={params.fm} />
        </div>
      </details>
    </div>
  );
}
