/**
 * Audio I/O — the hardware layer, laid out the way a broadcast processor
 * does it (Stereo Tool's Audio I/O page is the reference):
 *
 *   audio setup: device rate + processing latency, one clock domain
 *   inputs:      Input 1, plus Input 2 as a hot standby with silence failover
 *   outputs:     Web/HD delivery bus, FM composite, low-latency monitoring
 *
 * Everything here is wired to the engine: the failover is measured from the
 * two live input paths, the bus meters read the delivery/monitor taps, and
 * the rate/quantum controls rebuild the context through the safe teardown.
 */
import { useEffect, useState } from "react";
import { AudioLines, Cable, Headphones, Radio, RefreshCw, ShieldCheck } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Seg } from "@/components/console/controls";
import {
  getEngine,
  type ChannelMode,
  type InputSlot,
  type MeterSnapshot,
} from "@/lib/audio/engine";
import { getFm, subscribeFm, type FmSnapshot } from "@/lib/audio/fm";
import { formatDb, formatHz, type ProcessorParams } from "@/lib/audio/params";
import { cn } from "@/lib/utils";

const selectCls =
  "h-8 w-full cursor-pointer truncate rounded border border-border/60 bg-[#07090e] px-2 text-[11px] text-panel-fg outline-none focus-visible:border-signal/60";

const rangeCls =
  "h-1.5 w-full cursor-pointer appearance-none rounded-full bg-border accent-signal";

const CHANNEL_OPTIONS: { value: ChannelMode; label: string }[] = [
  { value: "stereo", label: "Stereo" },
  { value: "mono", label: "Mono" },
  { value: "left", label: "L" },
  { value: "right", label: "R" },
];

function dbText(db: number, digits = 1): string {
  return !Number.isFinite(db) || db <= -99 ? "—" : formatDb(db, digits);
}

/** Horizontal stereo bus meter, fed by the engine's real bus levels. */
function BusMeter({
  l,
  r,
  className,
}: {
  l: number;
  r: number;
  className?: string;
}) {
  const bar = (db: number, label: string) => {
    const pct = Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
    const hot = db >= -3;
    const warn = db >= -9;
    return (
      <div className="flex items-center gap-2">
        <span className="w-2 shrink-0 text-readout text-[8px] text-panel-mut">{label}</span>
        <div className="panel-well relative h-2 flex-1 overflow-hidden rounded-sm">
          <div
            className={cn(
              "absolute inset-y-0 left-0 transition-[width] duration-100",
              hot ? "bg-meter-hot" : warn ? "bg-meter-warn" : "bg-meter-ok",
            )}
            style={{ width: `${pct}%` }}
          />
          {/* PPM reference marks at −20 and −6 dBFS */}
          <span className="absolute inset-y-0 left-[66.6%] w-px bg-white/15" aria-hidden />
          <span className="absolute inset-y-0 left-[90%] w-px bg-white/15" aria-hidden />
        </div>
        <span className="w-14 shrink-0 text-right text-readout text-[9px] text-panel-mut">
          {dbText(db)}
        </span>
      </div>
    );
  };
  return (
    <div className={cn("space-y-1", className)} aria-label="Bus level">
      {bar(l, "L")}
      {bar(r, "R")}
    </div>
  );
}

function Band({
  title,
  hint,
  right,
}: {
  title: string;
  hint?: string;
  right?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-y border-border/60 bg-white/[0.03] px-4 py-2 first:border-t-0">
      <div className="flex min-w-0 items-center gap-2">
        <span className="h-3 w-[3px] shrink-0 rounded-full bg-signal" aria-hidden />
        <h3 className="text-[10px] font-bold tracking-[0.16em] text-foreground uppercase">
          {title}
        </h3>
        {hint && <span className="truncate text-[10px] text-panel-mut">{hint}</span>}
      </div>
      {right}
    </div>
  );
}

export function AudioIoPanel({
  params,
  setParams,
}: {
  params: ProcessorParams;
  setParams: React.Dispatch<React.SetStateAction<ProcessorParams>>;
}) {
  const engine = getEngine();
  const [snap, setSnap] = useState<MeterSnapshot>(() => engine.snapshot());
  const [fm, setFm] = useState<FmSnapshot>(() => getFm());
  const [rebuilding, setRebuilding] = useState(false);

  useEffect(() => {
    let last = 0;
    const off = engine.subscribe((s) => {
      const now = performance.now();
      if (now - last < 120) return;
      last = now;
      // Copy: notify() reuses the snapshot object, and a device-list or I/O
      // setting change must still repaint even when the meters have not moved.
      setSnap({ ...s });
    });
    const offFm = subscribeFm(() => setFm(getFm()));
    return () => {
      off();
      offFm();
    };
  }, [engine]);

  const io = engine.ioState;
  const cfg = io.config;
  const monitor = engine.monitorState;
  const inputs = engine.inputDevices.filter((d) => d.id);
  const outputs = engine.outputDevices.filter((d) => d.id);
  const activeRate = io.sampleRateActual;
  const rateLabel = activeRate ? `${(activeRate / 1000).toFixed(1)} kHz` : "—";
  const requestedRateLabel = cfg.sampleRate ? `${(cfg.sampleRate / 1000).toFixed(1)} kHz` : "Auto";
  const rateMismatch = cfg.sampleRate > 0 && activeRate > 0 && cfg.sampleRate !== activeRate;
  const engineOn = snap.powered && io.running;
  const fmStats = fm.stats;
  const compositeDb = fmStats
    ? 20 * Math.log10(Math.max(1e-6, fmStats.modPct / 100))
    : null;
  const fmOn = params.fm.on;
  const lowLatency = params.psy.latency === "low";

  const rebuild = async (patch: { sampleRate?: number; latencyFrames?: number }) => {
    setRebuilding(true);
    try {
      await engine.applyAudioConfig(patch);
    } finally {
      setRebuilding(false);
    }
  };

  const renderInput = (slot: InputSlot) => {
    const main = slot === "main";
    const isActive = io.activeInput === slot;
    // Post-trim, per-channel levels — the same meter the failover measures,
    // but through the channel format and the preamp, which is what actually
    // reaches the program bus.
    const lvl = main
      ? {
          l: snap.io.mainL,
          r: snap.io.mainR,
          corr: snap.io.mainCorr,
          clip: snap.io.mainClip,
        }
      : {
          l: snap.io.backupL,
          r: snap.io.backupR,
          corr: snap.io.backupCorr,
          clip: snap.io.backupClip,
        };
    const deviceId = main ? engine.inputDeviceId : cfg.backupInput;
    const label = main ? io.mainLabel : io.backupLabel || "No backup input";
    const gain = main ? cfg.mainGainDb : cfg.backupGainDb;
    const channels = main ? cfg.mainChannels : cfg.backupChannels;
    const status = main ? engine.micStatus : io.backupStatus;

    return (
      <div
        className={cn(
          "rounded-lg border p-3 transition-colors",
          isActive && snap.powered
            ? "border-signal/45 bg-signal/[0.06]"
            : "border-border/60 bg-panel-2/40",
        )}
      >
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={cn(
              "led",
              isActive && snap.powered && "led-on",
              status === "error" && "led-hot",
              status === "arming" && "led-warn",
            )}
            aria-hidden
          />
          <h4 className="text-[11px] font-semibold tracking-[0.12em] text-panel-fg uppercase">
            {main ? "Input 1" : "Input 2"}
          </h4>
          <span className="text-[10px] text-panel-mut">
            {main ? "Main programme" : "Hot standby"}
          </span>
          <span className="ml-auto flex items-center gap-1.5">
            {!main && io.autoSwitched && (
              <span className="rounded-sm bg-meter-warn/15 px-1.5 py-0.5 text-[8px] font-bold tracking-[0.12em] text-meter-warn uppercase">
                Auto-switched
              </span>
            )}
            <span className="text-readout text-[9px] text-panel-mut">
              {status === "on"
                ? isActive
                  ? "ON BUS"
                  : "STANDBY"
                : status === "arming"
                  ? "ARMING"
                  : status === "error"
                    ? "ERROR"
                    : "IDLE"}
            </span>
          </span>
        </div>

        <div className="mt-2 truncate text-[10px] text-panel-mut" title={label}>
          {label || (inputs.length ? "Choose a device" : "No input devices detected")}
        </div>

        <select
          className={cn(selectCls, "mt-2")}
          aria-label={main ? "Input 1 device" : "Input 2 device"}
          value={deviceId}
          onFocus={() => void engine.refreshDevices()}
          onChange={(e) => {
            if (main) engine.setInputDevice(e.target.value);
            else engine.setBackupInput(e.target.value);
          }}
        >
          <option value="">{main ? "System default input" : "Choose backup input"}</option>
          {inputs
            .filter((d) => !(!main && d.id === engine.inputDeviceId))
            .map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
        </select>

        <div className="mt-2 flex items-center justify-between gap-2">
          <span className="text-[9px] font-semibold tracking-[0.12em] text-panel-mut uppercase">
            Channel setup
          </span>
          <Seg
            ariaLabel={`${main ? "Input 1" : "Input 2"} channel setup`}
            value={channels}
            options={CHANNEL_OPTIONS}
            onChange={(v) => engine.setInputChannels(slot, v)}
          />
        </div>

        <div className="mt-2 flex items-center justify-between gap-2">
          <span className="text-[9px] font-semibold tracking-[0.12em] text-panel-mut uppercase">
            Preamp gain
          </span>
          <span className="text-readout text-[10px] text-panel-fg">{dbText(gain, 1)}</span>
        </div>
        <input
          type="range"
          className={rangeCls}
          min={-24}
          max={24}
          step={0.5}
          value={gain}
          aria-label={`${main ? "Input 1" : "Input 2"} preamp gain`}
          onChange={(e) => engine.setInputGain(slot, Number(e.target.value))}
        />

        <BusMeter l={lvl.l} r={lvl.r} className="mt-2.5" />

        <div className="mt-1.5 flex items-center justify-between gap-2 text-[9px]">
          <span className="text-panel-mut">
            Phase{" "}
            <b
              className={cn(
                "text-readout font-semibold",
                lvl.corr < -0.2
                  ? "text-meter-hot"
                  : lvl.corr < 0.5
                    ? "text-meter-warn"
                    : "text-meter-ok",
              )}
              title="Stereo correlation of this input — below 0 the feed loses level in a mono fold-down"
            >
              {lvl.corr >= 0.999 ? "mono" : lvl.corr.toFixed(2)}
            </b>
          </span>
          <span
            className={cn(
              "rounded-sm px-1.5 py-0.5 text-[8px] font-bold tracking-[0.12em] uppercase",
              lvl.clip ? "bg-meter-hot/15 text-meter-hot" : "text-panel-mut",
            )}
            title={
              lvl.clip
                ? "The input reached the digital ceiling — lower the preamp gain"
                : "Input peak"
            }
          >
            {lvl.clip ? "Clip" : `pk ${dbText(Math.max(lvl.l, lvl.r))}`}
          </span>
        </div>

        <div className="mt-2 flex gap-2">
          {isActive ? (
            <>
              <span className="flex h-7 flex-1 items-center justify-center rounded border border-signal/40 bg-signal/10 text-[9px] font-bold tracking-[0.14em] text-signal uppercase">
                On bus
              </span>
              {io.manualHold && (
                <button
                  type="button"
                  onClick={() => engine.resumeAutoInput()}
                  className="h-7 rounded border border-meter-warn/50 px-2 text-[9px] font-bold tracking-[0.12em] text-meter-warn uppercase transition-colors hover:bg-meter-warn/10"
                  title="Resume automatic silence failover"
                >
                  Auto
                </button>
              )}
            </>
          ) : (
            <button
              type="button"
              onClick={() => engine.takeInputToAir(slot)}
              disabled={!main && !snap.io.backupReady}
              className="h-7 flex-1 rounded border border-border/70 text-[9px] font-bold tracking-[0.14em] text-panel-mut uppercase transition-colors hover:border-signal/50 hover:text-signal disabled:opacity-40"
              title="Put this input on the program bus and pause automatic failover"
            >
              Take to air
            </button>
          )}
        </div>

        {main ? (
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={() => void engine.armMic()}
              className="h-7 flex-1 rounded border border-signal/50 bg-signal/10 text-[9px] font-bold tracking-[0.14em] text-signal uppercase transition-colors hover:bg-signal/20"
            >
              {engine.micStatus === "on" ? "Re-arm" : "Arm input"}
            </button>
            <button
              type="button"
              onClick={() => engine.disarmMic()}
              className="h-7 flex-1 rounded border border-border/70 text-[9px] font-bold tracking-[0.14em] text-panel-mut uppercase transition-colors hover:text-panel-fg"
            >
              Disarm
            </button>
          </div>
        ) : (
          <div className="mt-2 flex items-center justify-between gap-3 rounded border border-border/60 px-2 py-1.5">
            <span className="text-[9px] leading-4 text-panel-mut">
              Switch to this input if Input 1 is silent
            </span>
            <Switch
              checked={cfg.backupEnabled}
              disabled={!cfg.backupInput}
              onCheckedChange={(on) => engine.setBackupEnabled(on)}
              aria-label="Use Input 2 as a silence backup"
              className="cursor-pointer"
            />
          </div>
        )}

        {!main && cfg.backupEnabled && cfg.backupInput === engine.inputDeviceId && (
          <p className="mt-1.5 text-[9px] leading-4 text-meter-warn">
            Input 1 and Input 2 are the same endpoint — choose a different device for failover
            to mean anything.
          </p>
        )}
        {!main && io.backupStatus === "error" && (
          <p className="mt-1.5 text-[9px] leading-4 text-meter-hot">
            The backup endpoint could not be opened. Input 1 is still on air.
          </p>
        )}
      </div>
    );
  };

  return (
    <section className="panel overflow-hidden rounded-2xl">
      {/* ── title rail ── */}
      <header className="flex flex-wrap items-center gap-3 border-b border-border/70 bg-panel-2/70 px-4 py-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-signal/40 bg-signal/10 text-signal">
          <AudioLines className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-[12px] font-bold tracking-[0.18em] text-foreground uppercase">
            Audio I/O
          </h2>
          <p className="mt-0.5 truncate text-[10px] text-panel-mut">
            Hot-standby inputs · independent delivery busses · one clock domain
          </p>
        </div>
        <span
          className={cn(
            "flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[9px] font-bold tracking-[0.14em] uppercase",
            engineOn
              ? "bg-meter-ok/15 text-meter-ok"
              : snap.powered
                ? "bg-meter-warn/15 text-meter-warn"
                : "bg-muted text-panel-mut",
          )}
        >
          <span className={cn("led size-1.5", engineOn && "led-on")} aria-hidden />
          {engineOn ? "Engine running" : snap.powered ? io.contextState : "Engine off"}
        </span>
        <button
          type="button"
          onClick={() => void engine.refreshDevices()}
          aria-label="Rescan audio devices"
          className="flex h-7 shrink-0 items-center gap-1.5 rounded border border-border/60 px-2 text-[10px] text-panel-mut transition-colors hover:text-foreground"
        >
          <RefreshCw className="size-3" /> Rescan
        </button>
      </header>

      {/* ── audio input/output setup ── */}
      <Band
        title="Audio input / output setup"
        hint="device clock and render quantum"
        right={
          <span className="text-readout text-[9px] text-panel-mut">
            {rateLabel} · {io.quantum || cfg.latencyFrames} fr
          </span>
        }
      />
      <div className="grid gap-3 px-4 py-3 sm:grid-cols-2 xl:grid-cols-4">
        <label className="block">
          <span className="text-[9px] font-semibold tracking-[0.12em] text-panel-mut uppercase">
            Sample rate
          </span>
          <select
            className={cn(selectCls, "mt-1")}
            value={cfg.sampleRate}
            disabled={rebuilding}
            onChange={(e) => void rebuild({ sampleRate: Number(e.target.value) })}
          >
            <option value={0}>Auto (device default)</option>
            <option value={44100}>44.1 kHz</option>
            <option value={48000}>48 kHz</option>
            <option value={96000}>96 kHz</option>
          </select>
          <span
            className={cn(
              "mt-1 block text-readout text-[9px]",
              rateMismatch ? "text-meter-warn" : "text-panel-mut",
            )}
          >
            {rebuilding
              ? "Rebuilding engine…"
              : rateMismatch
                ? `Requested ${requestedRateLabel} · device granted ${rateLabel}`
                : `Running at ${rateLabel}`}
          </span>
        </label>

        <label className="block">
          <span className="text-[9px] font-semibold tracking-[0.12em] text-panel-mut uppercase">
            Processing latency
          </span>
          <select
            className={cn(selectCls, "mt-1")}
            value={cfg.latencyFrames}
            disabled={rebuilding}
            onChange={(e) => void rebuild({ latencyFrames: Number(e.target.value) })}
          >
            {[256, 512, 1024, 2048, 4096].map((f) => (
              <option key={f} value={f}>
                {f} samples · {((f / (activeRate || 48000)) * 1000).toFixed(1)} ms
              </option>
            ))}
          </select>
          <span className="mt-1 block text-readout text-[9px] text-panel-mut">
            Measured {io.latencyMs.toFixed(1)} ms round trip
          </span>
        </label>

        <div className="rounded border border-border/60 bg-panel-2/30 px-2.5 py-2">
          <span className="text-[9px] font-semibold tracking-[0.12em] text-panel-mut uppercase">
            Clock domain
          </span>
          <p className="mt-1 flex items-center gap-1.5 text-[10px] text-panel-fg">
            <ShieldCheck className="size-3.5 text-meter-ok" />
            Inputs and outputs share one context
          </p>
          <p className="mt-0.5 text-[9px] leading-4 text-panel-mut">
            No cross-card resampling: the failover crossfade runs inside the same clock.
          </p>
        </div>

        <div className="rounded border border-border/60 bg-panel-2/30 px-2.5 py-2">
          <span className="text-[9px] font-semibold tracking-[0.12em] text-panel-mut uppercase">
            Endpoint
          </span>
          <p className="mt-1 truncate text-[10px] text-panel-fg" title={monitor.sinkLabel}>
            <Cable className="mr-1 inline size-3.5 text-panel-mut" />
            {monitor.sinkLabel}
          </p>
          <p className="mt-0.5 text-[9px] leading-4 text-panel-mut">
            {io.sampleRateActual
              ? `${reqFrames(io.quantum, cfg.latencyFrames)}`
              : "Engine off — open it to read the hardware quantum."}
          </p>
        </div>
      </div>
      <p className="px-4 pb-3 text-[9px] leading-4 text-panel-mut">
        Changing the rate or quantum restarts the audio engine through a faded teardown;
        any live stream encoder must be restarted afterwards. Requests are not guarantees —
        the measured values above are what the device actually granted.
      </p>

      {/* ── inputs ── */}
      <Band
        title="Inputs"
        hint="Input 2 is a measured hot standby, not a second mix bus"
        right={
          <span className="flex items-center gap-1.5 text-[9px] text-panel-mut">
            <Radio className="size-3" />
            {io.manualHold
              ? "manual hold — failover paused"
              : `failover window ${cfg.backupEnabled ? "armed" : "off"}`}
          </span>
        }
      />
      <div className="grid gap-3 px-4 py-3 lg:grid-cols-2">
        {renderInput("main")}
        {renderInput("backup")}
      </div>

      {/* ── outputs ── */}
      <Band title="Outputs" hint="one chain, separate delivery taps" />
      <div className="grid gap-3 px-4 py-3 xl:grid-cols-3">
        {/* Web / HD */}
        <div className="rounded-lg border border-border/60 bg-panel-2/40 p-3">
          <div className="flex items-center gap-2">
            <span className={cn("led", engineOn && "led-on")} aria-hidden />
            <h4 className="text-[11px] font-semibold tracking-[0.12em] text-panel-fg uppercase">
              Web / HD output
            </h4>
            <span className="ml-auto text-readout text-[9px] text-panel-mut">
              {engineOn ? "ACTIVE" : "IDLE"}
            </span>
          </div>
          <p className="mt-1 text-[9px] leading-4 text-panel-mut">
            MediaStream + PCM capture tap. Stream encoders and the MPX branch both read this bus.
          </p>

          <div className="mt-3 flex items-center justify-between">
            <span className="text-[9px] font-semibold tracking-[0.12em] text-panel-mut uppercase">
              Volume
            </span>
            <span className="text-readout text-[10px] text-panel-fg">
              {dbText(cfg.webGainDb)} · {Math.round(gainPct(cfg.webGainDb))}%
            </span>
          </div>
          <input
            type="range"
            className={rangeCls}
            min={-60}
            max={12}
            step={0.5}
            value={cfg.webGainDb}
            aria-label="Web/HD output volume"
            onChange={(e) => engine.setWebGainDb(Number(e.target.value))}
          />

          <div className="mt-3">
            <span className="text-[9px] font-semibold tracking-[0.12em] text-panel-mut uppercase">
              Signal selection
            </span>
            <div className="mt-1 flex h-8 items-center rounded border border-border/60 bg-[#07090e] px-2 text-[11px] text-panel-fg">
              Processed program bus · post-limiter
            </div>
            <span className="mt-1 block text-[9px] leading-4 text-panel-mut">
              The delivery tap is always the processed bus, so a streaming output can never
              land unprocessed audio on air.
            </span>
          </div>

          <div className="mt-2 flex items-center justify-between gap-2">
            <span className="text-[9px] font-semibold tracking-[0.12em] text-panel-mut uppercase">
              Channel setup
            </span>
            <Seg
              ariaLabel="Web/HD channel setup"
              value={cfg.webChannels}
              options={CHANNEL_OPTIONS}
              onChange={(v) => engine.setWebChannels(v)}
            />
          </div>

          <BusMeter l={snap.io.webL} r={snap.io.webR} className="mt-3" />
        </div>

        {/* FM composite */}
        <div
          className={cn(
            "rounded-lg border p-3",
            fmOn ? "border-border/60 bg-panel-2/40" : "border-border/50 bg-panel-2/20",
          )}
        >
          <div className="flex items-center gap-2">
            <span className={cn("led", fmOn && fm.running && "led-on")} aria-hidden />
            <h4 className="text-[11px] font-semibold tracking-[0.12em] text-panel-fg uppercase">
              FM output
            </h4>
            <span className="ml-auto text-readout text-[9px] text-panel-mut">
              {fmOn ? (fm.running ? "ON AIR" : "STARTING") : "OFF"}
            </span>
          </div>

          {fmOn ? (
            <>
              <p className="mt-1 text-[9px] leading-4 text-panel-mut">
                Composite MPX · {((fm.outRate || 192000) / 1000).toFixed(0)} kHz · pilot{" "}
                {params.fm.mpx.pilotPct}% · RDS {params.fm.mpx.rdsPct}%
              </p>
              <div className="panel-well mt-3 flex items-end justify-between rounded px-2.5 py-2">
                <div>
                  <p className="text-[8px] font-semibold tracking-[0.14em] text-panel-mut uppercase">
                    Composite output level
                  </p>
                  <p className="text-readout mt-0.5 text-lg leading-none font-semibold text-white">
                    {compositeDb == null ? "—" : formatDb(compositeDb, 2)}
                  </p>
                </div>
                <span className="text-readout text-[10px] text-panel-mut">
                  {fmStats ? `${fmStats.modPct.toFixed(0)}% dev` : "awaiting audio"}
                </span>
              </div>
              <div className="mt-2 space-y-1">
                <BusMeter
                  l={fmStats ? compositeDb ?? -120 : -120}
                  r={fmStats ? compositeDb ?? -120 : -120}
                />
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2 text-[9px] text-panel-mut">
                <span>
                  Peak hold{" "}
                  <b className="text-readout text-panel-fg">
                    {fmStats ? `${fmStats.peakHoldPct.toFixed(0)}%` : "—"}
                  </b>
                </span>
                <span className="text-right">
                  MPX power{" "}
                  <b className="text-readout text-panel-fg">
                    {fmStats ? `${fmStats.powerDbr.toFixed(1)} dBr` : "—"}
                  </b>
                </span>
              </div>
              {fm.error && (
                <p className="mt-2 text-[9px] leading-4 text-meter-hot">{fm.error}</p>
              )}
            </>
          ) : (
            <div className="mt-2">
              <p className="text-[10px] leading-4 text-panel-mut">
                No FM (or AM) signal available. Enable FM generation first.
              </p>
              <button
                type="button"
                onClick={() =>
                  setParams((p) => ({ ...p, fm: { ...p.fm, on: true } }))
                }
                className="mt-2 h-7 w-full rounded border border-signal/50 bg-signal/10 text-[9px] font-bold tracking-[0.14em] text-signal uppercase transition-colors hover:bg-signal/20"
              >
                Enable FM generation
              </button>
            </div>
          )}
        </div>

        {/* Low-latency monitoring */}
        <div className="rounded-lg border border-border/60 bg-panel-2/40 p-3">
          <div className="flex items-center gap-2">
            <span
              className={cn("led", engineOn && !monitor.muted && "led-on")}
              aria-hidden
            />
            <h4 className="text-[11px] font-semibold tracking-[0.12em] text-panel-fg uppercase">
              Low-latency monitoring
            </h4>
            <span className="ml-auto text-readout text-[9px] text-panel-mut">
              {monitor.muted ? "MUTED" : engineOn ? "LIVE" : "IDLE"}
            </span>
          </div>
          <p className="mt-1 flex items-center gap-1 text-[9px] leading-4 text-panel-mut">
            <Headphones className="size-3" />
            {lowLatency ? "Low-latency profile" : "Full lookahead quality"} ·{" "}
            {io.latencyMs.toFixed(1)} ms
          </p>

          <select
            className={cn(selectCls, "mt-2")}
            aria-label="Monitoring output device"
            value={engine.outputDeviceId}
            onFocus={() => void engine.refreshDevices()}
            onChange={(e) => engine.setOutputDevice(e.target.value)}
          >
            <option value="">System default output</option>
            {outputs.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </select>

          <div className="mt-3 flex items-center justify-between">
            <span className="text-[9px] font-semibold tracking-[0.12em] text-panel-mut uppercase">
              Volume
            </span>
            <span className="text-readout text-[10px] text-panel-fg">
              {dbText(params.monitorDb)} · {Math.round(gainPct(params.monitorDb))}%
            </span>
          </div>
          <input
            type="range"
            className={rangeCls}
            min={-60}
            max={0}
            step={0.5}
            value={Math.max(-60, params.monitorDb)}
            aria-label="Monitoring volume"
            onChange={(e) => {
              const v = Number(e.target.value);
              setParams((p) => ({ ...p, monitorDb: v }));
              if (!monitor.muted) engine.setMonitorDb(v);
            }}
          />

          <div className="mt-2 flex items-center justify-between gap-3 rounded border border-border/60 px-2 py-1.5">
            <span className="text-[9px] text-panel-mut">Monitor mute</span>
            <Switch
              checked={monitor.muted}
              onCheckedChange={(on) => engine.setMonitorMuted(on)}
              aria-label="Mute the monitor bus"
              className="cursor-pointer"
            />
          </div>

          {engine.feedbackRisk && (
            <p className="mt-2 text-[9px] leading-4 text-meter-warn">
              Input 1 and the monitor are the same loopback endpoint — this will feed back.
            </p>
          )}
          {engine.monitorIsVirtual && (
            <p className="mt-2 text-[9px] leading-4 text-panel-mut">
              The monitor is routed to a virtual endpoint, so it is silent on local speakers.
            </p>
          )}

          <BusMeter l={snap.io.monitorL} r={snap.io.monitorR} className="mt-3" />
        </div>
      </div>

      {/* ── footer telemetry ── */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-2 border-t border-border/70 bg-panel-2/60 px-4 py-2.5 sm:grid-cols-3 xl:grid-cols-6">
        <Readout label="Meter CPU" value={`${snap.io.cpuPct.toFixed(1)}%`} />
        <Readout
          label="Input buffer"
          value={io.quantum ? `${io.quantum} fr` : "—"}
          sub={io.quantum && activeRate ? `${((io.quantum / activeRate) * 1000).toFixed(1)} ms` : undefined}
        />
        <Readout
          label="Web/HD buffer"
          value={snap.io.bufferFrames ? `${snap.io.bufferFrames} fr` : "—"}
          sub={`${io.latencyMs.toFixed(1)} ms out`}
        />
        <Readout label="Under-runs" value={`${snap.perf.stalls}`} />
        <Readout
          label="Passband"
          value={`${formatHz(snap.io.bandLowHz)} – ${formatHz(snap.io.bandHighHz)}`}
        />
        <Readout
          label="Failover"
          value={cfg.backupEnabled ? (io.autoSwitched ? "BACKUP" : "ARMED") : "OFF"}
          sub={io.backupStatus === "on" ? "Input 2 ready" : "Input 2 idle"}
        />
      </div>
    </section>
  );
}

function Readout({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="min-w-0">
      <p className="text-[8px] font-semibold tracking-[0.14em] text-panel-mut uppercase">
        {label}
      </p>
      <p className="text-readout truncate text-[10px] text-panel-fg">{value}</p>
      {sub && <p className="text-readout truncate text-[8px] text-panel-mut">{sub}</p>}
    </div>
  );
}

function gainPct(db: number): number {
  if (!Number.isFinite(db)) return 0;
  return Math.pow(10, db / 20) * 100;
}

function reqFrames(quantum: number, requested: number): string {
  if (!quantum) return "Hardware quantum unreadable while the engine is off.";
  return quantum === requested
    ? `Hardware quantum granted: ${quantum} frames.`
    : `Requested ${requested} frames · device runs ${quantum}.`;
}
