import {
  AudioDevicesPanel,
  useLocalAudioController,
  useRemoteAudioController,
} from "@/components/console/AudioDevicesPanel";

/**
 * Satellite window content for Audio → Audio Devices… — the same proper
 * sound-settings panel as the main console. Remote-controls the console's
 * engine over the shell bridge; falls back to the local engine where the
 * bridge is absent (browser build).
 */
export default function Devices() {
  const remote = useRemoteAudioController();
  const local = useLocalAudioController();
  const controller = remote ?? local;

  return (
    <main className="min-h-screen bg-background p-5 text-foreground">
      <header>
        <h1 className="text-base font-semibold tracking-tight">Audio Devices</h1>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          Sound input → processor → encoders · monitor → speakers
        </p>
      </header>
      <div className="mt-4">
        <AudioDevicesPanel controller={controller} compact />
      </div>
      <footer className="mt-4 border-t border-border/60 pt-3 text-[11px] leading-5 text-muted-foreground">
        Device names appear after microphone permission is granted. Plug or
        unplug hardware any time — the list follows automatically.
      </footer>
    </main>
  );
}
