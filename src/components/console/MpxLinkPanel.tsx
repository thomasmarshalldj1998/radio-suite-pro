/**
 * Composite-over-IP panel — the 192 kHz MPX signal as a packet stream.
 *
 * The sender frames the composite of the FM branch into numbered packets
 * (28-byte header, CRC-32, 16-bit PCM payload) and meters exactly what goes
 * out. On the desktop build the stream leaves through two real UDP sockets and
 * whatever arrives on them is decoded straight back into the receiver; without
 * a socket the same packets loop back locally, so the console behaves the same
 * either way. Receive mode runs the other half: two independent paths land in
 * two jitter buffers, the healthy one feeds the splice, and a damaged link is
 * replaced without the composite ever going silent.
 *
 * Receive mode also decodes what the splice releases: the station name and
 * RadioText come off the 57 kHz subcarrier and left/right off the 38 kHz one,
 * so the panel reports content that arrived, not content that was sent.
 *
 * The self-test drives the whole path — framer, network model, jitter buffers,
 * splice — with a deterministic clock on a deliberately damaged primary, so the
 * receiver can be shown recovering rather than described.
 */
import { ModuleCard } from "@/components/console/ModuleCard";
import { CtrlRow, Seg, Val } from "@/components/console/controls";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  MPX_LINK_FRAME_SAMPLES,
  MPX_LINK_HEADER_BYTES,
  type LinkHealth,
} from "@/lib/audio/mpxlink";
import {
  LINK_RATE,
  armLink,
  connectUdp,
  disarmLink,
  disconnectUdp,
  forceLink,
  getLink,
  runLinkSelfTest,
  setReceiveMode,
  subscribeLink,
  tickLink,
  type SelfTestReport,
} from "@/lib/audio/mpxlink-runtime";
import type { FmParams } from "@/lib/audio/params";
import type { MpxCodec } from "@/lib/audio/mpxlink";
import {
  getUdp,
  setUdpConfig,
  subscribeUdp,
  type EndpointState,
  type UdpConfig,
} from "@/lib/audio/udp";
import { cn } from "@/lib/utils";
import { useEffect, useState, useSyncExternalStore } from "react";

/** Composite rate the link runs at, in kHz (192 kHz stereo composite mono sum). */
const COMPOSITE_KHZ = 192;

function formatKbps(kbps: number): string {
  if (!Number.isFinite(kbps) || kbps <= 0) return "—";
  return kbps >= 1000 ? `${(kbps / 1000).toFixed(2)} Mbit/s` : `${kbps.toFixed(0)} kbit/s`;
}

function formatMs(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  return `${ms.toFixed(0)} ms`;
}

/** Text mirror of the socket settings, so a half-typed port never commits. */
interface UdpDraft {
  hostA: string;
  portA: string;
  listenA: string;
  hostB: string;
  portB: string;
  listenB: string;
}

const toDraft = (config: UdpConfig): UdpDraft => ({
  hostA: config.hostA,
  portA: String(config.portA),
  listenA: String(config.listenA),
  hostB: config.hostB,
  portB: String(config.portB),
  listenB: String(config.listenB),
});

/** Map a path's field patch onto the A/B draft keys. */
const prefixA = (patch: { host?: string; port?: string; listen?: string }) => ({
  ...(patch.host !== undefined ? { hostA: patch.host } : {}),
  ...(patch.port !== undefined ? { portA: patch.port } : {}),
  ...(patch.listen !== undefined ? { listenA: patch.listen } : {}),
});
const prefixB = (patch: { host?: string; port?: string; listen?: string }) => ({
  ...(patch.host !== undefined ? { hostB: patch.host } : {}),
  ...(patch.port !== undefined ? { portB: patch.port } : {}),
  ...(patch.listen !== undefined ? { listenB: patch.listen } : {}),
});

function udpPathsLabel(endpoints: EndpointState[]): string {
  const open = endpoints.filter((e) => e.open).length;
  return open === 2 ? "both paths" : open === 1 ? "one path" : "no path";
}

const fromDraft = (draft: UdpDraft): UdpConfig => ({
  hostA: draft.hostA,
  portA: Number(draft.portA),
  listenA: Number(draft.listenA),
  hostB: draft.hostB,
  portB: Number(draft.portB),
  listenB: Number(draft.listenB),
});

/** One path: where its datagrams go, where it listens, what the socket says. */
function PathRow({
  label,
  host,
  port,
  listen,
  onChange,
  onCommit,
  disabled,
  endpoint,
}: {
  label: string;
  host: string;
  port: string;
  listen: string;
  onChange: (patch: { host?: string; port?: string; listen?: string }) => void;
  onCommit: () => void;
  disabled: boolean;
  endpoint: EndpointState;
}) {
  const field =
    "text-readout h-6 rounded border border-border/70 bg-background/60 px-1.5 text-[10px] " +
    "focus-visible:ring-1 focus-visible:ring-signal/60 focus-visible:outline-none " +
    "disabled:cursor-not-allowed disabled:opacity-60";
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5">
        <span className="text-muted-foreground w-9 shrink-0 text-[9px] font-semibold tracking-[0.08em] uppercase">
          {label}
        </span>
        <Input
          value={host}
          disabled={disabled}
          onChange={(e) => onChange({ host: e.target.value })}
          onBlur={onCommit}
          onKeyDown={(e) => {
            if (e.key === "Enter") onCommit();
          }}
          className={cn(field, "min-w-0 flex-1")}
          aria-label={`${label} destination host`}
        />
        <Input
          value={port}
          disabled={disabled}
          inputMode="numeric"
          onChange={(e) => onChange({ port: e.target.value })}
          onBlur={onCommit}
          onKeyDown={(e) => {
            if (e.key === "Enter") onCommit();
          }}
          className={cn(field, "w-12 shrink-0 text-center")}
          aria-label={`${label} destination port`}
        />
      </div>
      <div className="flex items-center gap-1.5 pl-10">
        <span className="text-muted-foreground text-[9px]">listen</span>
        <Input
          value={listen}
          disabled={disabled}
          inputMode="numeric"
          onChange={(e) => onChange({ listen: e.target.value })}
          onBlur={onCommit}
          onKeyDown={(e) => {
            if (e.key === "Enter") onCommit();
          }}
          className={cn(field, "w-12 shrink-0 text-center")}
          aria-label={`${label} listen port`}
        />
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-[9px]",
            endpoint.error ? "text-meter-hot" : "text-muted-foreground",
          )}
          title={endpoint.error ?? undefined}
        >
          {endpoint.error
            ? endpoint.error
            : endpoint.open
              ? `:${endpoint.boundPort} · ${endpoint.sent} out · ${endpoint.received} in`
              : "closed"}
        </span>
      </div>
    </div>
  );
}

/** A small dBFS bar for one decoded leg. */
function LevelBar({ label, rms }: { label: string; rms: number }) {
  const db = rms > 1e-6 ? 20 * Math.log10(rms) : -60;
  const pct = Math.max(0, Math.min(1, (db + 60) / 60));
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-muted-foreground w-2 shrink-0 text-[9px]">{label}</span>
      <span className="relative h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-border/50">
        <span
          className="bg-signal absolute inset-y-0 left-0 rounded-full"
          style={{ width: `${pct * 100}%` }}
        />
      </span>
      <span className="text-readout w-9 shrink-0 text-right text-[9px]">{db.toFixed(0)} dB</span>
    </div>
  );
}

function LinkRow({ label, health, live }: { label: string; health: LinkHealth; live: boolean }) {
  const degraded = health.lossPct > 0.5 || health.jitterMs > 20;
  return (
    <div
      className={cn(
        "rounded border px-2.5 py-2 transition-colors",
        live
          ? "border-signal/50 bg-signal/5"
          : "border-border/60 bg-card/40",
      )}
    >
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "led size-1.5",
            health.alive && "led-on",
            health.alive && degraded && "bg-meter-warn",
          )}
          aria-hidden
        />
        <span className="text-[10px] font-semibold tracking-[0.1em] uppercase">{label}</span>
        {live && (
          <span className="text-signal ml-auto text-[9px] font-semibold tracking-[0.08em] uppercase">
            on air
          </span>
        )}
        {!live && health.alive && (
          <span className="text-muted-foreground ml-auto text-[9px] tracking-[0.08em] uppercase">
            standby
          </span>
        )}
        {!health.alive && (
          <span className="text-muted-foreground ml-auto text-[9px] tracking-[0.08em] uppercase">
            {health.received > 0 ? "stale" : "no signal"}
          </span>
        )}
      </div>
      <dl className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[9px]">
        <dt className="text-muted-foreground">Loss</dt>
        <dd
          className={cn(
            "text-readout text-right",
            health.lossPct > 1.5 ? "text-meter-hot" : health.lossPct > 0.5 ? "text-meter-warn" : undefined,
          )}
        >
          {health.received > 0 ? `${health.lossPct.toFixed(2)} %` : "—"}
        </dd>
        <dt className="text-muted-foreground">Jitter</dt>
        <dd className="text-readout text-right">{health.received > 0 ? formatMs(health.jitterMs) : "—"}</dd>
        <dt className="text-muted-foreground">Buffer</dt>
        <dd className="text-readout text-right">{health.received > 0 ? formatMs(health.depthMs) : "—"}</dd>
        <dt className="text-muted-foreground">Concealed</dt>
        <dd className="text-readout text-right">
          {health.concealed} <span className="text-muted-foreground">of {health.received}</span>
        </dd>
      </dl>
    </div>
  );
}

function SelfTestBlock({ report }: { report: SelfTestReport }) {
  const rows: [string, string][] = [
    ["Frames", `${report.frames}`],
    [
      "Damaged path",
      `${report.faulted.lossPct.toFixed(1)} % lost · ${report.faulted.reordered} late · ${report.faulted.duplicated} dup`,
    ],
    ["Switches", `${report.splices}`],
    ["Concealed", `${report.received.concealed}`],
    ["Serving link", report.active === 0 ? "A" : "B"],
  ];
  return (
    <div className="rounded border border-border/60 bg-card/40 p-2.5">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-muted-foreground text-[10px] font-semibold tracking-[0.1em] uppercase">
          Link self-test
        </span>
        <span
          className={cn(
            "text-[9px] font-semibold tracking-[0.08em] uppercase",
            report.splices > 0 && report.active === 1 ? "text-meter-ok" : "text-muted-foreground",
          )}
        >
          {report.splices > 0 && report.active === 1 ? "passed" : "no splice"}
        </span>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[9px]">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="text-readout truncate text-right">{v}</dd>
          </div>
        ))}
      </dl>
      <p className="text-muted-foreground mt-1.5 text-[9px] leading-3.5">{report.verdict}</p>
    </div>
  );
}

export function MpxLinkPanel({ fm }: { fm: FmParams }) {
  const link = useSyncExternalStore(subscribeLink, getLink, getLink);
  const udp = useSyncExternalStore(subscribeUdp, getUdp, getUdp);
  const [draft, setDraft] = useState<UdpDraft>(() => toDraft(getUdp().config));
  const [busy, setBusy] = useState(false);

  const commit = () => {
    setUdpConfig(fromDraft(draft));
    // the config coerces out-of-range values back; show what was accepted
    setDraft(toDraft(getUdp().config));
  };

  // Receiver servo: drain the splice at a steady rate while receive mode runs.
  useEffect(() => {
    if (!link.armed || !link.receive) return;
    const id = window.setInterval(() => tickLink(), 100);
    return () => window.clearInterval(id);
  }, [link.armed, link.receive]);

  const setCodec = (codec: MpxCodec | "off") => {
    if (codec === "off") {
      if (udp.open) void disconnectUdp();
      disarmLink(fm);
    } else if (link.armed) {
      disarmLink(fm);
      armLink(fm, codec);
    } else armLink(fm, codec);
  };

  const toggleTransport = async (want: "loop" | "udp") => {
    if (want === "loop") {
      if (udp.open) await disconnectUdp();
      return;
    }
    if (!udp.available || busy) return;
    setBusy(true);
    try {
      await connectUdp(fm);
    } finally {
      setBusy(false);
    }
  };

  const packetMs = (MPX_LINK_FRAME_SAMPLES / (COMPOSITE_KHZ * 1000)) * 1000;
  const payloadBytes = MPX_LINK_FRAME_SAMPLES * 2;
  const rawKbps = (payloadBytes * 8 * LINK_RATE) / 1000;

  return (
    <ModuleCard
      title="Composite over IP"
      subtitle={`${COMPOSITE_KHZ} kHz MPX · dual link · hitless splice`}
      enabled={link.armed}
      onToggle={() => setCodec(link.armed ? "off" : "raw")}
    >
      <div className="grid gap-4 lg:grid-cols-12">
        {/* ── send / receive configuration ── */}
        <div className="lg:col-span-7">
          <div className="divide-y divide-border/50 rounded border border-border/60 bg-card/30">
            <CtrlRow label="Payload">
              <Seg
                value={link.armed ? "raw" : "off"}
                options={[
                  { value: "off", label: "Off" },
                  { value: "raw", label: "PCM 16" },
                ]}
                onChange={setCodec}
                ariaLabel="Composite link payload format"
              />
              <Val>{link.armed ? `${formatKbps(link.kbps)} /path` : "idle"}</Val>
            </CtrlRow>
            <CtrlRow label="Receive">
              <Seg
                value={link.receive ? "on" : "off"}
                options={[
                  { value: "off", label: "Off" },
                  { value: "on", label: "On" },
                ]}
                onChange={(v) => setReceiveMode(v === "on")}
                ariaLabel="Composite link receive mode"
              />
              <Val>{link.receive ? `link ${link.active === 0 ? "A" : "B"}` : "monitor only"}</Val>
            </CtrlRow>
            <CtrlRow label="Path">
              <Seg
                value={link.forced === null ? "auto" : link.forced === 0 ? "a" : "b"}
                options={[
                  { value: "auto", label: "Auto" },
                  { value: "a", label: "A" },
                  { value: "b", label: "B" },
                ]}
                onChange={(v) => forceLink(v === "auto" ? null : v === "a" ? 0 : 1)}
                ariaLabel="Composite link path"
              />
              <Button
                size="sm"
                variant="outline"
                className="h-6 cursor-pointer px-2 text-[9px] tracking-wide uppercase"
                onClick={() => runLinkSelfTest()}
              >
                Run self-test
              </Button>
            </CtrlRow>
          </div>

          {/* ── transport: where the packets actually go ── */}
          <div className="mt-3 rounded border border-border/60 bg-card/30">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/50 px-3 py-2">
              <span className="text-muted-foreground text-[10px] font-semibold tracking-[0.1em] uppercase">
                Transport
              </span>
              <div className="flex items-center gap-2">
                {busy && (
                  <span className="text-muted-foreground text-[9px] tracking-[0.08em] uppercase">
                    opening…
                  </span>
                )}
                <Seg
                  value={udp.open ? "udp" : "loop"}
                  options={[
                    { value: "loop", label: "Local" },
                    { value: "udp", label: "UDP" },
                  ]}
                  onChange={(v) => void toggleTransport(v)}
                  ariaLabel="Composite link transport"
                />
              </div>
            </div>
            {udp.available ? (
              <div className="grid gap-2.5 p-3 sm:grid-cols-2">
                <PathRow
                  label="A"
                  host={draft.hostA}
                  port={draft.portA}
                  listen={draft.listenA}
                  disabled={udp.open || busy}
                  endpoint={udp.endpoints[0]}
                  onChange={(patch) => setDraft((d) => ({ ...d, ...prefixA(patch) }))}
                  onCommit={commit}
                />
                <PathRow
                  label="B"
                  host={draft.hostB}
                  port={draft.portB}
                  listen={draft.listenB}
                  disabled={udp.open || busy}
                  endpoint={udp.endpoints[1]}
                  onChange={(patch) => setDraft((d) => ({ ...d, ...prefixB(patch) }))}
                  onCommit={commit}
                />
              </div>
            ) : (
              <p className="text-muted-foreground px-3 py-2 text-[9px] leading-3.5">
                UDP sockets live in the desktop app — the browser build can only loop the framer
                back into its own receiver.
              </p>
            )}
            {udp.open && (
              <p className="text-muted-foreground border-t border-border/50 px-3 py-1.5 text-[9px]">
                {udp.packetsSent} packets on {udpPathsLabel(udp.endpoints)} · {udp.packetsReceived}{" "}
                received
                {udp.invalid > 0 ? ` · ${udp.invalid} rejected` : ""}
                {udp.kbps > 0 ? ` · ${formatKbps(udp.kbps)}` : ""}
              </p>
            )}
          </div>

          <div className="mt-3 grid gap-2 text-[9px] text-muted-foreground sm:grid-cols-2">
            <p className="leading-3.5">
              {!fm.on
                ? "The FM exciter is off — there is no composite to frame. Switch the exciter on to feed the link."
                : link.armed
                  ? link.transport === "udp"
                    ? `On the wire — ${link.packets} packets per path, ${formatKbps(link.kbps)} each.`
                    : `Loopback — ${link.packets} packets framed and fed back into the local receiver.`
                  : "Off — the composite stays inside the console."}
            </p>
            <p className="leading-3.5">
              {MPX_LINK_FRAME_SAMPLES} samples a packet · {packetMs.toFixed(2)} ms ·{" "}
              {MPX_LINK_HEADER_BYTES} B header · {LINK_RATE.toFixed(1)} packets/s · 16-bit PCM needs{" "}
              {rawKbps.toFixed(0)} kbit/s per path. A datagram is {payloadBytes + MPX_LINK_HEADER_BYTES}{" "}
              B, so links under a ~2300 B MTU fragment it.
            </p>
          </div>

          {link.splices.length > 0 && (
            <div className="mt-3">
              <span className="text-muted-foreground mb-1 block text-[10px] font-semibold tracking-[0.1em] uppercase">
                Recent switches
              </span>
              <ul className="flex flex-col gap-1 text-[9px]">
                {link.splices.map((s, i) => (
                  <li key={i} className="flex items-baseline gap-2">
                    <span className="text-readout text-signal w-16 shrink-0">
                      {s.from === s.to ? "hold" : `${s.from === 0 ? "A" : "B"} → ${s.to === 0 ? "A" : "B"}`}
                    </span>
                    <span className="text-muted-foreground truncate">{s.reason}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        {/* ── what the receiver sees ── */}
        <div className="flex flex-col gap-2 lg:col-span-5">
          <div className="rounded border border-border/60 bg-card/40 p-2.5">
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-muted-foreground text-[10px] font-semibold tracking-[0.1em] uppercase">
                Stream
              </span>
              <span
                className={cn(
                  "flex items-center gap-1.5 text-[9px]",
                  link.armed ? "text-meter-ok" : "text-muted-foreground",
                )}
              >
                <span className={cn("led size-1.5", link.armed && "led-on")} aria-hidden />
                {link.armed ? "framing" : "idle"}
              </span>
            </div>
            <dl className="grid grid-cols-2 gap-y-1 text-[9px]">
              <dt className="text-muted-foreground">Packets</dt>
              <dd className="text-readout text-right">{link.packets}</dd>
              <dt className="text-muted-foreground">Rate</dt>
              <dd className="text-readout text-right">
                {link.fps > 0 ? `${link.fps.toFixed(1)} /s` : "—"}
              </dd>
              <dt className="text-muted-foreground">Wire</dt>
              <dd className="text-readout text-right">
                {formatKbps(link.kbps)}
                <span className="text-muted-foreground"> /path</span>
              </dd>
              <dt className="text-muted-foreground">Sent</dt>
              <dd className="text-readout text-right">
                {(link.bytes / 1024).toFixed(0)} KiB
                <span className="text-muted-foreground">
                  {" "}
                  · {link.transport === "udp" ? "UDP" : link.transport === "custom" ? "custom" : "loopback"}
                </span>
              </dd>
            </dl>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <LinkRow label="Link A" health={link.links[0]} live={link.receive && link.active === 0} />
            <LinkRow label="Link B" health={link.links[1]} live={link.receive && link.active === 1} />
          </div>

          {/* ── decoded from the splice, not from the sender ── */}
          <div className="rounded border border-border/60 bg-card/40 p-2.5">
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-muted-foreground text-[10px] font-semibold tracking-[0.1em] uppercase">
                Received content
              </span>
              <span
                className={cn(
                  "flex items-center gap-1.5 text-[9px]",
                  link.content?.rds.locked ? "text-meter-ok" : "text-muted-foreground",
                )}
              >
                <span
                  className={cn("led size-1.5", link.content?.rds.locked && "led-on")}
                  aria-hidden
                />
                {link.content?.rds.locked ? "RDS locked" : "searching"}
              </span>
            </div>
            {link.content ? (
              <>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-readout bg-signal/10 max-w-[60%] truncate rounded px-1.5 py-0.5 text-[11px] tracking-[0.2em]">
                    {link.content.rds.ps.trim() || "—"}
                  </span>
                  <span className="text-muted-foreground shrink-0 text-[9px]">
                    0x{(link.content.rds.pi ?? 0).toString(16).toUpperCase().padStart(4, "0")} · PTY{" "}
                    {link.content.rds.pty ?? "—"}
                  </span>
                </div>
                <div className="text-readout mt-1 truncate text-[10px]">
                  {link.content.rds.rt || "—"}
                </div>
                {link.content.rds.rtPlusTags.length > 0 && (
                  <div className="text-muted-foreground mt-0.5 flex flex-wrap gap-x-2 text-[9px]">
                    {link.content.rds.rtPlusTags.map((tag) => (
                      <span key={`${tag.type}-${tag.text}`} className="truncate">
                        {tag.name.replace(/^Item\./, "")}:{" "}
                        <span className="text-foreground/90">{tag.text}</span>
                      </span>
                    ))}
                  </div>
                )}
                <div className="mt-1.5 flex flex-col gap-1">
                  <LevelBar label="L" rms={link.content.audio.rmsL} />
                  <LevelBar label="R" rms={link.content.audio.rmsR} />
                </div>
                <div className="text-muted-foreground mt-1 flex justify-between gap-2 text-[9px]">
                  <span>
                    {link.content.rds.groups} groups · {link.content.rds.bits} bits · phase{" "}
                    {link.content.rds.phase}
                  </span>
                  <span>
                    {link.content.rds.errors} bad blocks · pilot{" "}
                    {(link.content.rds.pilot * 100).toFixed(0)} %
                  </span>
                </div>
              </>
            ) : (
              <p className="text-muted-foreground text-[9px] leading-3.5">
                Turn Receive on and the splice's output is demodulated here — station name and
                RadioText off the 57 kHz subcarrier, left and right off the 38 kHz one.
              </p>
            )}
          </div>

          {link.selfTest ? (
            <SelfTestBlock report={link.selfTest} />
          ) : (
            <p className="text-muted-foreground px-1 text-[9px] leading-3.5">
              The self-test sends both paths through a network model — the primary with loss,
              reordering and jitter — and reports whether the receiver switched to the standby
              without dropping the composite.
            </p>
          )}
        </div>
      </div>
    </ModuleCard>
  );
}
