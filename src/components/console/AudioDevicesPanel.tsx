import { useEffect, useState } from "react";
import {
  getEngine,
  type AudioDevice,
  type MicStatus,
} from "@/lib/audio/engine";
import { isFeedbackLoop, isVirtualDevice } from "@/lib/audio/devices";
import type { SignalpathAudioState } from "@/types/desktop";
import { cn } from "@/lib/utils";

/**
 * One controller drives the panel everywhere. The main console uses the live
 * engine; the satellite Devices window uses the shell bridge (remote) or the
 * local engine when the bridge is absent (browser build).
 */
export interface AudioPanelController {
  inputs: AudioDevice[];
  outputs: AudioDevice[];
  inputId: string;
  outputId: string;
  micStatus: MicStatus | string;
  micLabel: string;
  engineOn: boolean;
  contextState: string;
  sampleRate: number;
  /** Program source currently feeding the chain. */
  sourceKind: "signal" | "mic" | "file";
  /** Monitor sink is a virtual/loopback endpoint (inaudible locally). */
  monitorVirtual?: boolean;
  /** Input and monitor are two sides of the same endpoint (feedback). */
  feedbackRisk?: boolean;
  setInput: (id: string) => void;
  setOutput: (id: string) => void;
  refresh: () => void;
  arm: () => void;
  disarm: () => void;
}

const EMPTY_INPUTS: AudioDevice[] = [];
const EMPTY_OUTPUTS: AudioDevice[] = [];

/** Live engine binding for the main console. */
export function useLocalAudioController(): AudioPanelController {
  const engine = getEngine();
  const [, force] = useState(0);
  useEffect(() => engine.subscribe(() => force((n) => n + 1)), [engine]);
  return {
    inputs: engine.inputDevices.length ? engine.inputDevices : EMPTY_INPUTS,
    outputs: engine.outputDevices.length ? engine.outputDevices : EMPTY_OUTPUTS,
    inputId: engine.inputDeviceId,
    outputId: engine.outputDeviceId,
    micStatus: engine.micStatus,
    micLabel: engine.micLabel,
    engineOn: engine.powered,
    contextState: engine.ctx?.state ?? "closed",
    sampleRate: engine.sampleRate,
    sourceKind: engine.sourceKind,
    monitorVirtual: engine.monitorIsVirtual,
    feedbackRisk: engine.feedbackRisk,
    setInput: (id) => engine.setInputDevice(id),
    setOutput: (id) => engine.setOutputDevice(id),
    refresh: () => void engine.refreshDevices(),
    arm: () => void engine.armMic(),
    disarm: () => engine.disarmMic(),
  };
}

/** Shell-bridge binding for the satellite Devices window. Null = no bridge. */
export function useRemoteAudioController(): AudioPanelController | null {
  const bridge =
    typeof window !== "undefined" ? (window.signalpath?.audio ?? null) : null;
  const [state, setState] = useState<SignalpathAudioState | null>(null);
  useEffect(() => {
    if (!bridge) return;
    let cancelled = false;
    void bridge.get().then((s) => {
      if (s && !cancelled) setState(s);
    });
    const off = bridge.onState((s) => {
      if (!cancelled) setState(s);
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [bridge]);
  if (!bridge) return null;
  const s = state;
  const input = s?.inputs?.find((d) => d.id && d.id === s.inputId);
  const output = s?.outputs?.find((d) => d.id && d.id === s.outputId);
  return {
    inputs: s?.inputs ?? EMPTY_INPUTS,
    outputs: s?.outputs ?? EMPTY_OUTPUTS,
    inputId: s?.inputId ?? "",
    outputId: s?.outputId ?? "",
    micStatus: s?.micStatus ?? "idle",
    micLabel: s?.micLabel ?? "",
    engineOn: (s?.sampleRate ?? 0) > 0,
    contextState: s?.contextState ?? "unknown",
    sampleRate: s?.sampleRate ?? 0,
    sourceKind: s?.sourceKind ?? "signal",
    monitorVirtual: !!output && isVirtualDevice(output.label),
    feedbackRisk: isFeedbackLoop(input, output),
    setInput: (id) => bridge.setInput(id),
    setOutput: (id) => bridge.setOutput(id),
    refresh: () => bridge.refresh(),
    arm: () => bridge.arm(),
    disarm: () => bridge.disarm(),
  };
}

const selectCls =
  "h-8 w-full cursor-pointer truncate rounded border border-border/60 bg-muted/40 px-2 text-xs text-foreground";

/**
 * The proper sound-settings panel: engine state, input select + arm, output
 * select, and honest empty-states for machines with no audio hardware (most
 * VPS boxes) instead of silent dead controls.
 */
export function AudioDevicesPanel({
  controller,
  compact = false,
}: {
  controller: AudioPanelController;
  compact?: boolean;
}) {
  const live = controller.micStatus === "on";
  const suspended = controller.contextState === "suspended";
  const noInputs = controller.inputs.filter((d) => d.id).length === 0;
  const noOutputs = controller.outputs.filter((d) => d.id).length === 0;
  const program =
    controller.sourceKind === "mic"
      ? "Input device"
      : controller.sourceKind === "file"
        ? "File playback"
        : "Test generator";

  return (
    <div className={cn(!compact && "panel rounded-2xl p-4 sm:p-5")}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[9px] font-bold tracking-[0.14em] uppercase",
              controller.engineOn && !suspended
                ? "bg-meter-ok/15 text-meter-ok"
                : suspended
                  ? "bg-meter-warn/15 text-meter-warn"
                  : "bg-muted text-muted-foreground",
            )}
          >
            <span
              className={cn(
                "led size-1.5",
                controller.engineOn && !suspended && "led-on",
              )}
            />
            {controller.engineOn
              ? suspended
                ? "Suspended — click to enable"
                : "Engine running"
              : "Engine off"}
          </span>
          {controller.sampleRate > 0 && (
            <span className="text-readout text-[10px] text-panel-mut">
              {(controller.sampleRate / 1000).toFixed(1)} kHz
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={controller.refresh}
          aria-label="Rescan audio devices"
          className="h-7 shrink-0 rounded border border-border/60 px-2 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
        >
          ↻ Rescan
        </button>
      </div>

      {/* ── input ── */}
      <h3 className="mt-4 text-[10px] font-semibold tracking-[0.16em] text-panel-mut uppercase">
        Sound input
      </h3>
      <select
        className={cn(selectCls, "mt-1.5")}
        value={controller.inputId}
        aria-label="Sound input device"
        onFocus={controller.refresh}
        onChange={(e) => controller.setInput(e.target.value)}
      >
        <option value="">System default input</option>
        {controller.inputs
          .filter((d) => d.id)
          .map((d) => (
            <option key={d.id} value={d.id}>
              {d.label}
            </option>
          ))}
      </select>
      {noInputs && (
        <p className="mt-1.5 text-[11px] leading-5 text-meter-warn">
          No selectable input yet. The OS hides device names until
          microphone access is granted — arm the input once, then rescan. On a
          machine with no sound card there is nothing to list at all.
        </p>
      )}
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          onClick={live ? controller.disarm : controller.arm}
          className={cn(
            "h-8 flex-1 rounded text-xs font-semibold transition-colors",
            live
              ? "border border-border/60 text-muted-foreground hover:text-foreground"
              : "bg-signal text-signal-fg hover:opacity-90",
          )}
        >
          {live ? "Disarm input" : "Arm input"}
        </button>
        <span
          className={cn(
            "flex items-center gap-1.5 text-[11px]",
            live ? "text-meter-ok" : "text-muted-foreground",
          )}
        >
          <span className={cn("led size-2", live && "led-on")} />
          {live
            ? controller.micLabel || "Live"
            : controller.micStatus === "arming"
              ? "Arming…"
              : controller.micStatus === "error"
                ? "Blocked — check OS permission"
                : "Idle"}
        </span>
      </div>

      {/* ── output ── */}
      <h3 className="mt-4 text-[10px] font-semibold tracking-[0.16em] text-panel-mut uppercase">
        Monitor output
      </h3>
      <select
        className={cn(selectCls, "mt-1.5")}
        value={controller.outputId}
        aria-label="Monitor output device"
        onFocus={controller.refresh}
        onChange={(e) => controller.setOutput(e.target.value)}
      >
        <option value="">System default output</option>
        {controller.outputs
          .filter((d) => d.id)
          .map((d) => (
            <option key={d.id} value={d.id}>
              {d.label}
            </option>
          ))}
      </select>
      {noOutputs && (
        <p className="mt-1.5 text-[11px] leading-5 text-meter-warn">
          No selectable output — plug in speakers or headphones and rescan.
          Monitoring stays silent until then; the encoder feed is unaffected.
        </p>
      )}
      <p className="mt-2 text-[11px] leading-5 text-muted-foreground">
        What you hear locally. The stream encoder always carries the full
        program chain regardless of this choice.
      </p>
      {controller.feedbackRisk && (
        <p className="mt-2 rounded border border-meter-hot/40 bg-meter-hot/10 px-2 py-1.5 text-[11px] leading-5 text-meter-hot">
          Input and monitor are two sides of the same endpoint — the chain is
          feeding its own output back into its input. Pick the cable&apos;s
          output as the input, or monitor on real speakers instead.
        </p>
      )}
      {controller.monitorVirtual && !controller.feedbackRisk && (
        <p className="mt-2 rounded border border-border/60 bg-muted/30 px-2 py-1.5 text-[11px] leading-5 text-muted-foreground">
          The monitor is routed into a virtual cable, so nothing will be heard
          on this machine — that is normal when you are sending the chain to
          another application. The encoder still carries it.
        </p>
      )}
      <p className="mt-2 text-[10px] text-panel-mut">
        Program source: <span className="text-panel-fg">{program}</span>
      </p>
    </div>
  );
}
