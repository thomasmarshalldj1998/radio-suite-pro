/**
 * Diagnostics — what the engine can actually prove, and one safe recovery.
 *
 * Every value here is measured: the context state comes from the AudioContext,
 * the latency from the device's own `baseLatency`, the underrun count from the
 * clock monitor, the sink outcome from the last `setSinkId`. Where something
 * cannot be measured (acoustic output, a delivery that is not configured) it
 * says so rather than showing a number.
 */
import { ModuleCard } from "@/components/console/ModuleCard";
import { Button } from "@/components/ui/button";
import { getEngine } from "@/lib/audio/engine";
import { phaseAdvice, type CheckState, type EngineHealth } from "@/lib/audio/health";
import { isConfigured, useOutputs } from "@/lib/audio/outputs";
import { getRuntime, subscribeRuntime } from "@/lib/audio/runtime";
import { cn } from "@/lib/utils";
import { RotateCcw, Wrench } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

const CHECK_TONE: Record<CheckState, { dot: string; text: string; word: string }> = {
  pass: { dot: "led-on", text: "text-meter-ok", word: "OK" },
  warn: { dot: "led-warn", text: "text-meter-warn", word: "Check" },
  fail: { dot: "led-hot", text: "text-meter-hot", word: "Fault" },
  idle: { dot: "", text: "text-panel-mut", word: "Idle" },
};

const PHASE_TONE: Record<EngineHealth["phase"], string> = {
  stopped: "border-rack-line text-rack-mut",
  starting: "border-meter-warn/50 bg-meter-warn/10 text-meter-warn",
  live: "border-meter-ok/45 bg-meter-ok/10 text-meter-ok",
  degraded: "border-meter-warn/50 bg-meter-warn/12 text-meter-warn",
  "no-input": "border-meter-warn/50 bg-meter-warn/12 text-meter-warn",
  "no-output": "border-meter-hot/50 bg-meter-hot/12 text-meter-hot",
  error: "bg-[#ff3b30] text-white",
};

export function DiagnosticsPanel() {
  const engine = getEngine();
  const { slots } = useOutputs();
  const [onAir, setOnAir] = useState(() => getRuntime().onAir);
  /** Re-render cadence only — every value below is read live on render. */
  const [, setTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<
    { ok: boolean; at: number } | null
  >(null);

  // 4 Hz is enough for a slow-changing panel; the numbers that flicker
  // (levels, drift) are read on each render and labelled with their window.
  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), 250);
    return () => window.clearInterval(id);
  }, []);
  useEffect(
    () =>
      subscribeRuntime(() => {
        setOnAir(getRuntime().onAir);
      }),
    [],
  );

  const configured = slots.some(isConfigured);
  const health = engine.health({ onAir, configured });
  const d = engine.diagnostics;
  const snap = engine.snapshot();
  const advice = phaseAdvice(health);

  const recover = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const ok = await engine.recover();
      setOutcome({ ok, at: Date.now() });
      if (ok) toast.success("Audio output recovered", { description: health.summary });
      else
        toast.error("Recovery did not start the device", {
          description:
            "The browser is still holding the audio context. Click somewhere on the page, then try again.",
        });
    } finally {
      setBusy(false);
      setTick((n) => n + 1);
    }
  };

  const facts: { label: string; value: string; note?: string }[] = [
    {
      label: "Context",
      value: d.contextState,
      note: d.contextState === "running" ? "device clocking" : "not rendering",
    },
    {
      label: "Sample rate",
      value: d.sampleRate ? `${(d.sampleRate / 1000).toFixed(1)} kHz` : "—",
      note: d.channels ? `${d.channels}-channel bus` : "no graph",
    },
    {
      label: "Device latency",
      value: `${d.baseLatencyMs.toFixed(2)} ms`,
      note: d.baseFrames ? `≈ ${d.baseFrames} frames in` : "base latency",
    },
    {
      label: "Output latency",
      value: `${d.outputLatencyMs.toFixed(2)} ms`,
      note: "to the speaker",
    },
    {
      label: "Meter pass",
      value: snap.perf.throttled ? "throttled" : "full rate",
      note: `${snap.perf.frameMs.toFixed(2)} ms of main thread`,
    },
    {
      label: "Clock drift",
      value: snap.perf.driftValid
        ? `${snap.perf.driftMs >= 0 ? "+" : "−"}${Math.abs(snap.perf.driftMs).toFixed(2)} ms/s`
        : "no reading",
      note: snap.perf.driftValid
        ? `over ${snap.perf.intervalMs.toFixed(0)} ms`
        : "suspended or throttled",
    },
    {
      label: "Underruns",
      value: `${snap.perf.stalls}`,
      note: snap.perf.glitchAt
        ? `last ${new Date(snap.perf.glitchAt).toLocaleTimeString()}`
        : "none this session",
    },
    {
      label: "Monitor bus",
      value: d.monitorMuted
        ? "muted"
        : Number.isFinite(d.monitorDb)
          ? `${d.monitorDb.toFixed(1)} dB`
          : "shut",
      note: d.outputOpen ? "open" : "faded out",
    },
    {
      label: "Sink",
      value: d.sinkState === "unsupported" ? "not supported" : d.sinkLabel,
      note:
        d.sinkState === "refused"
          ? "refused — using default"
          : d.sinkState === "pending"
            ? "switch pending"
            : d.sinkState === "applied"
              ? "applied"
              : d.sinkState === "unsupported"
                ? "browser default only"
                : "system default",
    },
    {
      label: "Limiter",
      value: d.workletLimiter ? "worklet" : "native",
      note: "audio-thread stage",
    },
    {
      label: "Loudness",
      value: snap.lufsI === null ? "measuring" : `${snap.lufsI.toFixed(1)} LUFS`,
      note: snap.lufsI === null ? `${(snap.measureMs / 1000).toFixed(0)} s of 20 s` : "gated BS.1770-4",
    },
    {
      label: "Delivery",
      value: onAir ? "on air" : configured ? "ready" : "not configured",
      note: onAir ? "encoder sending" : configured ? "off air" : "local monitoring only",
    },
  ];

  return (
    <ModuleCard
      className="xl:col-span-12"
      title="Diagnostics"
      subtitle="Real engine state · measured timings · one safe recovery"
      right={
        <span
          className={cn(
            "flex items-center gap-2 rounded border px-2 py-1 text-[10px] font-bold tracking-[0.14em] uppercase",
            PHASE_TONE[health.phase],
          )}
          aria-live="polite"
        >
          <span
            className={cn(
              "led size-1.5",
              health.phase === "live" && "led-on",
              (health.phase === "degraded" ||
                health.phase === "no-input" ||
                health.phase === "starting") &&
                "led-warn",
              (health.phase === "no-output" || health.phase === "error") && "led-hot",
            )}
            aria-hidden
          />
          {health.label}
        </span>
      }
    >
      <p className="text-[11px] leading-5 text-foreground/90">{health.summary}</p>
      <p className="mt-1 text-[10px] leading-4 text-muted-foreground">{advice}</p>

      {/* ── the six checks, in signal order ── */}
      <ul className="mt-3 grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
        {health.checks.map((c) => {
          const tone = CHECK_TONE[c.state];
          return (
            <li
              key={c.id}
              className="panel-well flex items-start gap-2 rounded px-2.5 py-1.5"
            >
              <span className={cn("led mt-1 size-1.5 shrink-0", tone.dot)} aria-hidden />
              <span className="min-w-0">
                <span className="flex items-baseline gap-2">
                  <span className="text-[10px] font-semibold tracking-[0.1em] text-foreground/90 uppercase">
                    {c.label}
                  </span>
                  <span className={cn("text-[9px] font-bold uppercase", tone.text)}>
                    {tone.word}
                  </span>
                </span>
                <span className="mt-0.5 block truncate text-[10px] text-muted-foreground" title={c.detail}>
                  {c.detail}
                </span>
              </span>
            </li>
          );
        })}
      </ul>

      {/* ── measured facts ── */}
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        {facts.map((f) => (
          <div key={f.label} className="panel-well rounded px-2.5 py-2">
            <p className="text-[8px] font-semibold tracking-[0.1em] text-panel-mut uppercase">
              {f.label}
            </p>
            <p className="text-readout mt-0.5 truncate text-[12px] font-medium text-white" title={f.value}>
              {f.value}
            </p>
            <p className="mt-0.5 truncate text-[8px] text-panel-mut" title={f.note}>
              {f.note}
            </p>
          </div>
        ))}
      </div>

      {/* ── last fault + recovery ── */}
      <div className="mt-3 flex flex-col gap-3 rounded-lg border border-border/60 bg-muted/40 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-xs font-medium">Last reported fault</p>
          <p className="mt-0.5 text-[10px] leading-4 text-muted-foreground">
            {d.lastFault
              ? `${d.lastFault.message} — ${new Date(d.lastFault.at).toLocaleTimeString()}`
              : "None this session."}
            {outcome && (
              <span className={outcome.ok ? "text-meter-ok" : "text-meter-hot"}>
                {" "}
                · last recovery {outcome.ok ? "succeeded" : "failed"} at{" "}
                {new Date(outcome.at).toLocaleTimeString()}
              </span>
            )}
          </p>
        </div>
        <Button
          size="sm"
          variant={health.phase === "live" ? "outline" : "default"}
          onClick={() => void recover()}
          disabled={busy}
          className="h-9 shrink-0 cursor-pointer gap-1.5 text-[11px] font-semibold tracking-[0.1em] uppercase"
          title="Resume the context, reopen the output and reapply the monitor — without reloading"
        >
          {busy ? <RotateCcw className="size-3.5 animate-spin" /> : <Wrench className="size-3.5" />}
          {busy ? "Recovering…" : "Recover audio"}
        </Button>
      </div>
    </ModuleCard>
  );
}
