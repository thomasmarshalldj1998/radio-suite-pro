import { useEffect, useState } from "react";
import { getEngine } from "@/lib/audio/engine";

/**
 * Global "audio asleep" banner. Browsers (and some VPS shells) hold a fresh
 * AudioContext suspended until a gesture lands — every meter reads zero and
 * nothing sounds, which looks exactly like a dead engine. This says so, and
 * any click on it resumes the context.
 */
export function AudioWakeBanner() {
  const [, force] = useState(0);
  useEffect(() => getEngine().subscribe(() => force((n) => n + 1)), []);

  const engine = getEngine();
  if (!engine.powered || engine.ctx?.state !== "suspended") return null;

  return (
    <button
      type="button"
      onClick={() => void engine.ctx?.resume()}
      className="fixed inset-x-0 top-0 z-[100] flex w-full cursor-pointer items-center justify-center gap-2 bg-meter-warn/95 px-4 py-2 text-center text-xs font-semibold text-black"
    >
      <span className="led size-2" aria-hidden />
      Audio output is asleep — click here (or anywhere) to wake it. Meters and
      sound start the moment the system hands us the device.
    </button>
  );
}
