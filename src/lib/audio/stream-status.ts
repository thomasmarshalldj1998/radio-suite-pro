/**
 * Stream TX / RX status vocabulary.
 *
 * The engine states and the labels an operator reads are different things:
 * a live socket that is dropping frames is "LIVE" at the transport level and
 * "WARN" on the badge. Keeping the mapping in one pure module means the
 * Encoder deck, telemetry and logs all name the same condition the same way.
 */
import type { StreamStatus } from "./stream-client";

/** Badge text for the source (upload) side. */
export type TxBadge = "LIVE" | "CONNECTING" | "RECONNECTING" | "WARN" | "FAILED";

/** Badge text for the monitor (receive) side. */
export type RxBadge = "LOCKED" | "SYNCING" | "DROPPING" | "DRIFTING" | "SILENT";

/** Visual family — the UI picks colour from this, never from the text. */
export type BadgeTone = "ok" | "busy" | "warn" | "err" | "idle";

export interface Badge<Code extends string = TxBadge | RxBadge> {
  code: Code;
  tone: BadgeTone;
}

/** Panel glyphs for the TX badge: ● LIVE, ○ CONNECTING, ⦸ RECONNECTING,
 *  ⚠ WARN, ✗ FAILED. */
export const TX_BADGE_GLYPH: Record<TxBadge, string> = {
  LIVE: "●",
  CONNECTING: "○",
  RECONNECTING: "⦸",
  WARN: "⚠",
  FAILED: "✗",
};

/**
 * Map a transport state to its badge. `warning` promotes a live socket to
 * WARN when the protective limits have engaged (dropped audio, pacing
 * backlog) — the socket is up, but the operator should look.
 */
export function txBadge(status: StreamStatus, warning = false): Badge<TxBadge> {
  switch (status) {
    case "live":
      return warning ? { code: "WARN", tone: "warn" } : { code: "LIVE", tone: "ok" };
    case "connecting":
      return { code: "CONNECTING", tone: "busy" };
    case "retrying":
      return { code: "RECONNECTING", tone: "warn" };
    case "offline":
      return { code: "FAILED", tone: "err" };
    default:
      // Idle is not a failure — it means no session was started yet.
      return { code: "CONNECTING", tone: "idle" };
  }
}

export interface RxHealth {
  /** Receiver clock has locked to the sender. */
  locked: boolean;
  /** Programme has been below the silence threshold for silenceMs. */
  silent: boolean;
  /** Underruns or late frames inside the reporting window. */
  dropping: boolean;
  /** Measured drift exceeds the allowed correction window. */
  drifting: boolean;
}

/**
 * RX badge priority: silence is the most actionable condition, then audio
 * actually being lost, then clock drift, then lock acquisition.
 */
export function rxBadge(health: RxHealth): Badge<RxBadge> {
  if (health.silent) return { code: "SILENT", tone: "err" };
  if (health.dropping) return { code: "DROPPING", tone: "warn" };
  if (health.drifting) return { code: "DRIFTING", tone: "warn" };
  if (health.locked) return { code: "LOCKED", tone: "ok" };
  return { code: "SYNCING", tone: "busy" };
}
