import { useEffect } from "react";
import { IS_DESKTOP } from "@/lib/backend";
import { getEngine } from "@/lib/audio/engine";
import type { SignalpathAudioState } from "@/types/desktop";

/**
 * Desktop main-console side of the Audio Devices window.
 *
 * The Devices satellite has its own renderer (and therefore its own engine
 * instance), so it must never arm hardware itself — it remote-controls this
 * console over the shell bridge. This component publishes device state on
 * change (deduplicated) and applies incoming pick/arm commands to the real
 * engine. Renders nothing.
 */
export function AudioSync() {
  useEffect(() => {
    if (!IS_DESKTOP) return;
    const bridge = window.signalpath?.audio;
    if (!bridge) return;
    const engine = getEngine();

    let last = "";
    const push = () => {
      const s: SignalpathAudioState = {
        inputs: engine.inputDevices,
        outputs: engine.outputDevices,
        inputId: engine.inputDeviceId,
        outputId: engine.outputDeviceId,
        micStatus: engine.micStatus,
        micLabel: engine.micLabel,
        sourceKind: engine.sourceKind,
        sampleRate: engine.sampleRate,
        contextState: engine.ctx?.state ?? "closed",
      };
      const key = JSON.stringify(s);
      if (key !== last) {
        last = key;
        bridge.push(s);
      }
    };
    push();
    const offSub = engine.subscribe(push);
    const offCmd = bridge.onCommand((cmd) => {
      if (cmd.type === "input") engine.setInputDevice(cmd.id ?? "");
      else if (cmd.type === "output") engine.setOutputDevice(cmd.id ?? "");
      else if (cmd.type === "refresh") void engine.refreshDevices();
      else if (cmd.type === "arm") void engine.armMic();
      else if (cmd.type === "disarm") engine.disarmMic();
    });
    return () => {
      offSub();
      offCmd();
    };
  }, []);
  return null;
}
