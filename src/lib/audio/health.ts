/**
 * One status model for the console.
 *
 * The console used to answer "is it working?" in three places that each knew a
 * different half of the truth: the header chip read the output meters (which
 * keep their last buffer when a context is suspended), the engine badge read a
 * raw clock-drift sample (which also moves when the tab is throttled), and the
 * telemetry grid read the *stream* matrix (which is empty until an encoder is
 * configured). So a console with no sound could read "Audio live", "Degraded"
 * and "NO OUTPUT" at once, and none of the three was the actual fault.
 *
 * This module is the single answer. It takes measured facts — no parameters,
 * no guessed values — and returns one phase plus the check that decided it.
 * Everything here is pure, so the rules can be exercised without an
 * AudioContext (scripts/verify-engine-health.ts).
 */

/** How long without programme before the input is called missing. */
export const INPUT_TIMEOUT_MS = 4000;
/** How long a processed-signal gap is tolerated before it is a fault. */
export const OUTPUT_TIMEOUT_MS = 1500;
/** A stall inside this window still counts as a live fault. */
export const STALL_RECENT_MS = 15_000;
/** Peak below this reads as silence on the meters. */
export const SILENCE_DB = -70;
/** A monitor bus at or below this is inaudible. */
export const MONITOR_FLOOR_DB = -60;

export type EnginePhase =
  | "stopped"
  | "starting"
  | "live"
  | "degraded"
  | "no-input"
  | "no-output"
  | "error";

export type CheckState = "pass" | "warn" | "fail" | "idle";

export interface HealthCheck {
  id: "context" | "input" | "dsp" | "signal" | "output" | "delivery";
  label: string;
  state: CheckState;
  /** What was measured, in the operator's words. */
  detail: string;
}

export interface HealthFacts {
  /** The engine has been asked to run and has a graph. */
  powered: boolean;
  /** A start/recover request is in flight. */
  starting: boolean;
  /** Last initialisation failure, cleared by a successful start. */
  bootError: string | null;
  /** ms since this power-on. */
  uptimeMs: number;
  /** `AudioContext.state`: running / suspended / closed / none. */
  contextState: string;
  /** True once this context has clocked at least one quantum. */
  everClocked: boolean;
  /** Pre-chain programme peak (dBFS) — the input the chain is being fed. */
  programmeDb: number;
  /** Post-chain output peak (dBFS). */
  outPeakDb: number;
  /** ms since programme was last above the silence floor (Infinity = never). */
  silentForMs: number;
  /** ms since the processed bus was last above the silence floor. */
  outSilentForMs: number;
  monitorMuted: boolean;
  /** Monitor bus gain as the node holds it, dB (−Infinity when muted). */
  monitorDb: number;
  /** The chosen speaker refused the switch and fell back to the default. */
  sinkRefused: boolean;
  /**
   * The platform blocked the switch (missing `speaker-selection` permission,
   * or a browser without setSinkId). Audio is still playing, on the system
   * default — a routing wish that was not granted, not a dead output.
   */
  sinkDenied: boolean;
  /** The chosen sink is a loopback/virtual endpoint — inaudible locally. */
  sinkVirtual: boolean;
  sinkLabel: string;
  /** Render underruns measured this session. */
  stalls: number;
  /** The clock monitor is currently inside a stall episode. */
  stalledNow: boolean;
  /** ms since the last measured stall (Infinity = never). */
  lastStallAgoMs: number;
  /** A sample at or over the ceiling guard was measured. */
  clipOut: boolean;
  /** Integrated loudness has no gated figure yet. */
  loudnessMeasuring: boolean;
  /** Powered time inside the integrated measurement, ms. */
  measureMs: number;
  /** Programme is being delivered to a mount. */
  streamOnAir: boolean;
  /** At least one output slot is configured. */
  streamConfigured: boolean;
}

export interface EngineHealth {
  phase: EnginePhase;
  /** Uppercase chip text: LIVE, NO OUTPUT, … */
  label: string;
  /** One-line plain-English reason, always safe to show. */
  summary: string;
  /** The individual checks, in signal order. */
  checks: HealthCheck[];
  /** Every condition behind a DEGRADED verdict. */
  faults: string[];
}

const LABELS: Record<EnginePhase, string> = {
  stopped: "Stopped",
  starting: "Starting",
  live: "Live",
  degraded: "Degraded",
  "no-input": "No input",
  "no-output": "No output",
  error: "Error",
};

const isRunning = (state: string) => state === "running";

/**
 * Derive the one status the console shows.
 *
 * Order matters: an initialisation error outranks everything, a request in
 * flight is `starting`, and an asleep context is `no-output` before any meter
 * is believed — a suspended analyser holds its last buffer, so "the meters
 * move" is not evidence that anything is being rendered. Only after the
 * context is clocking do the input, output and clock checks apply.
 */
export function deriveEngineHealth(f: HealthFacts): EngineHealth {
  const checks = buildChecks(f);
  const degradedFaults = faultsOf(f);

  const finish = (
    phase: EnginePhase,
    summary: string,
    faults: string[] = [],
  ): EngineHealth => ({
    phase,
    label: LABELS[phase],
    summary,
    checks,
    faults,
  });

  if (f.bootError && !f.powered) {
    return finish("error", f.bootError, [f.bootError]);
  }
  if (f.starting && !f.powered) {
    return finish("starting", "The audio graph is being built…");
  }
  if (!f.powered) {
    return finish("stopped", "The engine is not running. Press Start to open the audio device.");
  }
  if (!isRunning(f.contextState)) {
    const asleep =
      f.contextState === "suspended" || f.contextState === "interrupted";
    return finish(
      "no-output",
      asleep
        ? f.everClocked
          ? "Audio output is asleep — the browser is holding the audio context suspended, so nothing reaches the speakers. Click anywhere (or Recover) to resume it."
          : "The audio device has not started yet — browsers only run audio after a click or tap, and the context is still suspended. Click anywhere (or press Recover)."
        : `The audio context is ${f.contextState || "not running"}, so nothing is being rendered even though the chain is powered.`,
    );
  }

  const inputMissing =
    f.uptimeMs > INPUT_TIMEOUT_MS && f.silentForMs > INPUT_TIMEOUT_MS;
  const outputMissing =
    f.uptimeMs > INPUT_TIMEOUT_MS && f.outSilentForMs > OUTPUT_TIMEOUT_MS;
  const monitorClosed = f.monitorMuted || f.monitorDb <= MONITOR_FLOOR_DB;
  const speakerDead = f.sinkRefused || (monitorClosed && !f.streamOnAir);

  // Missing input outranks missing output: the source is the upstream cause,
  // and reporting "no output" for a dead source sends the operator hunting
  // through the processor for a fault it does not have.
  if (inputMissing) {
    return finish(
      "no-input",
      `No usable input for ${Math.round(f.silentForMs / 1000)} s — the chain is running but the source is silent or unplugged.`,
      degradedFaults,
    );
  }
  if (f.sinkRefused) {
    return finish(
      "no-output",
      `The chosen output “${f.sinkLabel || "unknown"}” refused to open, so the monitor fell back to the system default.`,
      degradedFaults,
    );
  }
  if (outputMissing) {
    return finish(
      "no-output",
      "Input is present but the chain is passing no measurable signal to the output bus.",
      degradedFaults,
    );
  }
  if (speakerDead) {
    return finish(
      "no-output",
      f.monitorMuted
        ? "The monitor bus is muted: programme is being processed and metered but cannot be heard."
        : "The monitor bus is at or below −60 dB, so the speakers are effectively silent.",
      degradedFaults,
    );
  }
  if (degradedFaults.length > 0) {
    return finish("degraded", degradedFaults[0], degradedFaults);
  }
  return finish(
    "live",
    f.streamOnAir
      ? "Processing is running and programme is being delivered to the stream."
      : "Processing is running and programme is reaching the monitor bus.",
  );
}

/**
 * What, if anything, makes a running chain degraded. Loudness still measuring
 * is deliberately absent: a meter filling is not a fault, and saying so was
 * one of the ways this console used to cry wolf.
 */
function faultsOf(f: HealthFacts): string[] {
  const faults: string[] = [];
  if (f.stalledNow) {
    faults.push(
      "The audio thread is starved right now — the graph is losing time against the wall clock, so audio is being dropped.",
    );
  } else if (f.lastStallAgoMs < STALL_RECENT_MS) {
    faults.push(
      `The audio graph underran ${Math.round(f.lastStallAgoMs / 1000)} s ago (${f.stalls} episode${f.stalls === 1 ? "" : "s"} this session).`,
    );
  }
  if (f.clipOut) {
    faults.push(
      "A sample at or above the ceiling was measured on the output bus — the guard is working but the chain is being driven into it.",
    );
  }
  return faults;
}

function buildChecks(f: HealthFacts): HealthCheck[] {
  const checks: HealthCheck[] = [];
  const powered = f.powered;

  checks.push({
    id: "context",
    label: "Audio context",
    state: !powered ? "idle" : isRunning(f.contextState) ? "pass" : "fail",
    detail: !powered
      ? "Not opened"
      : isRunning(f.contextState)
        ? "Running — the device is clocking"
        : f.contextState === "suspended"
          ? "Suspended — the browser is holding the device shut"
          : `State: ${f.contextState || "none"}`,
  });

  checks.push({
    id: "input",
    label: "Input signal",
    state: !powered
      ? "idle"
      : f.programmeDb > SILENCE_DB
        ? "pass"
        : f.silentForMs > INPUT_TIMEOUT_MS
          ? "fail"
          : "warn",
    detail: !powered
      ? "Not measured"
      : f.programmeDb > SILENCE_DB
        ? `${f.programmeDb.toFixed(1)} dBFS programme`
        : "No programme above −70 dBFS",
  });

  checks.push({
    id: "dsp",
    label: "DSP engine",
    state: !powered ? "idle" : isRunning(f.contextState) ? "pass" : "fail",
    detail: !powered
      ? "Stopped"
      : isRunning(f.contextState)
        ? "Graph rendering"
        : "Graph built but not rendering",
  });

  checks.push({
    id: "signal",
    label: "Processed signal",
    state: !powered
      ? "idle"
      : f.outPeakDb > SILENCE_DB
        ? "pass"
        : f.outSilentForMs > OUTPUT_TIMEOUT_MS
          ? "fail"
          : "warn",
    detail: !powered
      ? "Not measured"
      : f.outPeakDb > SILENCE_DB
        ? `${f.outPeakDb.toFixed(1)} dBFS on the output bus`
        : "No signal on the output bus",
  });

  checks.push({
    id: "output",
    label: "Speaker route",
    state: !powered
      ? "idle"
      : f.sinkRefused
        ? "fail"
        : f.monitorMuted || f.monitorDb <= MONITOR_FLOOR_DB
          ? f.streamOnAir
            ? "warn"
            : "fail"
          : f.sinkVirtual || f.sinkDenied
            ? "warn"
            : "pass",
    detail: !powered
      ? "No route"
      : f.sinkRefused
        ? "Chosen sink went away — using the system default"
        : f.monitorMuted
          ? "Monitor muted"
          : f.monitorDb <= MONITOR_FLOOR_DB
            ? "Monitor at or below −60 dB"
            : `${f.monitorDb.toFixed(1)} dB into “${f.sinkLabel || "System default"}”${
                f.sinkDenied
                  ? " — the browser would not route the pick, so this is the system default"
                  : f.sinkVirtual
                    ? " (loopback endpoint — inaudible locally)"
                    : ""
              }`,
  });

  checks.push({
    id: "delivery",
    label: "Stream delivery",
    state: f.streamOnAir ? "pass" : f.streamConfigured ? "warn" : "idle",
    detail: f.streamOnAir
      ? "On air — the encoder is sending"
      : f.streamConfigured
        ? "Configured but not on air"
        : "No output configured — local monitoring only",
  });

  return checks;
}

/** Facts for an engine that has never been started — the console's idle HUD. */
export const IDLE_FACTS: HealthFacts = {
  powered: false,
  starting: false,
  bootError: null,
  uptimeMs: 0,
  contextState: "none",
  everClocked: false,
  programmeDb: -120,
  outPeakDb: -120,
  silentForMs: Infinity,
  outSilentForMs: Infinity,
  monitorMuted: false,
  monitorDb: -6,
  sinkRefused: false,
  sinkDenied: false,
  sinkVirtual: false,
  sinkLabel: "System default",
  stalls: 0,
  stalledNow: false,
  lastStallAgoMs: Infinity,
  clipOut: false,
  loudnessMeasuring: true,
  measureMs: 0,
  streamOnAir: false,
  streamConfigured: false,
};

/** The stopped status, so components can render before the engine reports. */
export const IDLE_HEALTH: EngineHealth = deriveEngineHealth(IDLE_FACTS);

/**
 * Plain-English explanations for the compact diagnostics list. The key is the
 * phase; `degraded` explains the first fault instead.
 */
export function phaseAdvice(health: EngineHealth): string {
  switch (health.phase) {
    case "stopped":
      return "Nothing is being processed. Press Start to build the graph and open the audio device.";
    case "starting":
      return "The graph and the audio worklet are being built. This normally takes well under a second.";
    case "live":
      return "Chain running, signal present and the output route is open. Nothing to do.";
    case "degraded":
      return "Audio is still passing, but a measured fault is active. Open Diagnostics for the timings and the recovery action.";
    case "no-input":
      return "The chain is running but the source is silent. Check the source select, the input device and the file transport before touching the processor.";
    case "no-output":
      return `${health.summary} If that does not clear it, press Recover — it resumes the context, reopens the output and reapplies the monitor gain without reloading the page.`;
    case "error":
      return "The engine failed to initialise. The message above comes from the browser's own audio API.";
  }
}
