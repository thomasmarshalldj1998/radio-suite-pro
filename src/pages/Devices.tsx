import { useEffect, useState } from "react";
import type { SignalpathAudioState } from "@/types/desktop";
import { getEngine } from "@/lib/audio/engine";
import { cn } from "@/lib/utils";

const EMPTY: SignalpathAudioState = {
  inputs: [],
  outputs: [],
  inputId: "",
  outputId: "",
  micStatus: "idle",
  micLabel: "",
};

function useDeviceState(): {
  state: SignalpathAudioState;
  remote: boolean;
  setInput: (id: string) => void;
  setOutput: (id: string) => void;
  refresh: () => void;
  arm: () => void;
  disarm: () => void;
} {
  const bridge =
    typeof window !== "undefined" ? (window.signalpath?.audio ?? null) : null;
  const [state, setState] = useState<SignalpathAudioState>(EMPTY);

  useEffect(() => {
    if (bridge) {
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
    }
    // No shell (browser build, or the main console itself): drive the local engine.
    const engine = getEngine();
    const sync = () =>
      setState({
        inputs: engine.inputDevices,
        outputs: engine.outputDevices,
        inputId: engine.inputDeviceId,
        outputId: engine.outputDeviceId,
        micStatus: engine.micStatus,
        micLabel: engine.micLabel,
      });
    sync();
    void engine.refreshDevices();
    return engine.subscribe(sync);
  }, [bridge]);

  if (bridge) {
    return {
      state,
      remote: true,
      setInput: (id) => bridge.setInput(id),
      setOutput: (id) => bridge.setOutput(id),
      refresh: () => bridge.refresh(),
      arm: () => bridge.arm(),
      disarm: () => bridge.disarm(),
    };
  }
  const engine = getEngine();
  return {
    state,
    remote: false,
    setInput: (id) => engine.setInputDevice(id),
    setOutput: (id) => engine.setOutputDevice(id),
    refresh: () => void engine.refreshDevices(),
    arm: () => void engine.armMic(),
    disarm: () => engine.disarmMic(),
  };
}

const selectCls =
  "h-8 w-full cursor-pointer truncate rounded border border-border/60 bg-muted/40 px-2 text-xs text-foreground";

/**
 * Satellite window content for Audio → Audio Devices… — pick the physical
 * sound input and monitor output. Inside the desktop shell this remote-controls
 * the main console's engine over IPC (a second AudioContext here would arm a
 * second mic and route a silent graph); in the browser it drives the local
 * engine directly.
 */
export default function Devices() {
  const { state, setInput, setOutput, refresh, arm, disarm } = useDeviceState();
  const live = state.micStatus === "on";

  return (
    <main className="min-h-screen bg-background p-5 text-foreground">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-base font-semibold tracking-tight">Audio Devices</h1>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            Sound input → processor → encoders · monitor → speakers
          </p>
        </div>
        <button
          type="button"
          onClick={refresh}
          aria-label="Rescan audio devices"
          className="h-8 rounded border border-border/60 px-2.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          ↻ Rescan
        </button>
      </header>

      <section className="mt-5">
        <h2 className="text-[10px] font-semibold tracking-[0.16em] text-muted-foreground uppercase">
          Sound input
        </h2>
        <select
          className={cn(selectCls, "mt-2")}
          value={state.inputId}
          aria-label="Sound input device"
          onFocus={refresh}
          onChange={(e) => setInput(e.target.value)}
        >
          <option value="">System default input</option>
          {state.inputs
            .filter((d) => d.id)
            .map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
        </select>
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            onClick={live ? disarm : arm}
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
              ? state.micLabel || "Live"
              : state.micStatus === "arming"
                ? "Arming…"
                : state.micStatus === "error"
                  ? "Blocked"
                  : "Idle"}
          </span>
        </div>
      </section>

      <section className="mt-6">
        <h2 className="text-[10px] font-semibold tracking-[0.16em] text-muted-foreground uppercase">
          Monitor output
        </h2>
        <select
          className={cn(selectCls, "mt-2")}
          value={state.outputId}
          aria-label="Monitor output device"
          onFocus={refresh}
          onChange={(e) => setOutput(e.target.value)}
        >
          <option value="">System default output</option>
          {state.outputs
            .filter((d) => d.id)
            .map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
        </select>
        <p className="mt-2 text-[11px] leading-5 text-muted-foreground">
          What you hear on the monitor bus. The encoder feed is unaffected — it
          always carries the full program chain.
        </p>
      </section>

      <footer className="mt-6 border-t border-border/60 pt-3 text-[11px] leading-5 text-muted-foreground">
        Device names appear after microphone permission is granted. Plug or
        unplug hardware any time — the list follows automatically.
      </footer>
    </main>
  );
}
