/**
 * Composite-over-IP watchdog.
 *
 * The console's alarm feed already has a `link` kind and a cooldown; this is
 * the piece that decides when to use it. It reads the link snapshot the panel
 * shows and turns transport facts — a path switch, both paths going quiet,
 * frames being lost on the serving path, a receiver that never gets RDS — into
 * alerts the Dashboard hands to the durable alarm history.
 *
 * State is module scope, like the other console stores, so a tab switch does
 * not re-announce a condition that is already known. Nothing here fires on a
 * single tick: a splice is reported once, and silence has to persist before it
 * counts, so a momentary gap does not page anybody.
 */
import type { LinkSnapshot } from "./mpxlink-runtime";

export interface LinkAlert {
  title: string;
  detail: string;
}

/** Both paths must be quiet this long before the link is called down. */
const DOWN_MS = 3000;
/** Receive mode must have gone this long without RDS before alarming. */
const NO_RDS_MS = 10_000;
/** Loss on the serving path that is worth telling the operator about, %. */
const LOSS_PCT = 2;
/** Jitter on the serving path worth reporting, ms. */
const JITTER_MS = 40;

let armedAt = 0;
let lastSpliceKey = "";
let silentSince = 0;
let noRdsSince = 0;

export function resetLinkWatch(): void {
  armedAt = 0;
  lastSpliceKey = "";
  silentSince = 0;
  noRdsSince = 0;
}

/**
 * Evaluate one status tick. Returns at most one alert per condition; the alarm
 * store's per-kind cooldown is what keeps a stuck fault from flooding.
 */
export function evaluateLinkHealth(
  link: LinkSnapshot,
  now = Date.now(),
): LinkAlert[] {
  const alerts: LinkAlert[] = [];
  if (!link.armed) {
    resetLinkWatch();
    return alerts;
  }
  if (armedAt === 0) armedAt = now;

  // ── a path switch: report the switch itself, once ──
  const latest = link.splices[0];
  if (latest) {
    const key = `${latest.at}:${latest.from}:${latest.to}`;
    if (key !== lastSpliceKey) {
      lastSpliceKey = key;
      alerts.push({
        title: `Composite link switched to path ${latest.to === 0 ? "A" : "B"}`,
        detail: `Path ${latest.from === 0 ? "A" : "B"} was replaced at ${new Date(now).toLocaleTimeString()} — ${latest.reason}`,
      });
    }
  }

  const [a, b] = link.links;
  const active = link.active === 0 ? a : b;
  const activeName = link.active === 0 ? "A" : "B";

  // ── both paths quiet: the exciter is running on whatever the buffer holds ──
  const bothQuiet =
    !a.alive && !b.alive && (a.received === 0 || a.silentMs > DOWN_MS) &&
    (b.received === 0 || b.silentMs > DOWN_MS);
  if (bothQuiet) {
    if (silentSince === 0) silentSince = now;
    if (now - silentSince >= DOWN_MS) {
      alerts.push({
        title: "Composite link down",
        detail: `No packets on ${a.received === 0 && b.received === 0 ? "either path" : `path ${activeName}`} for ${((now - silentSince) / 1000).toFixed(1)} s — the splice is concealing from its buffer`,
      });
    }
  } else {
    silentSince = 0;
  }

  // ── the serving path is not clean ──
  if (active.alive && active.received > 0) {
    if (active.lossPct > LOSS_PCT) {
      alerts.push({
        title: `Path ${activeName} losing frames`,
        detail: `${active.lossPct.toFixed(1)} % of frames missing, ${active.concealed} concealed, ${active.jitterMs.toFixed(0)} ms jitter — the standby is preferred above 1.5 %`,
      });
    } else if (active.jitterMs > JITTER_MS) {
      alerts.push({
        title: `Path ${activeName} jitter high`,
        detail: `${active.jitterMs.toFixed(0)} ms interarrival jitter with ${active.depthMs.toFixed(0)} ms buffered`,
      });
    }
  }

  // ── receive mode that never gets a station identity is not working ──
  if (link.receive) {
    const locked = link.content?.rds.locked ?? false;
    if (locked) {
      noRdsSince = 0;
    } else {
      if (noRdsSince === 0) noRdsSince = now;
      if (now - noRdsSince >= NO_RDS_MS) {
        alerts.push({
          title: "No RDS from the link",
          detail: `Receive mode has run for ${((now - noRdsSince) / 1000).toFixed(0)} s without locking to the 57 kHz data — check the pilot level and the payload format`,
        });
      }
    }
  } else {
    noRdsSince = 0;
  }

  return alerts;
}
