/**
 * Failover auto-tune checks.
 *
 *   bun scripts/verify-failover-tune.ts
 *
 * Tuning is the part of dead-air protection that cannot be checked by eye:
 * the threshold has to sit below the quietest programme the station actually
 * produces, not below a number someone typed. These checks feed the watchdog
 * a synthetic programme with quiet passages, tune it, and pin the result:
 *
 *   · tuning refuses when there is no measured programme;
 *   · the threshold lands below the measured quiet floor and above hard
 *     silence, so quiet links do not trip it and dead air still does;
 *   · hold / return / fade are scaled into their physical bounds;
 *   · tuning never arms the watchdog by itself.
 */
import {
  evaluateFailover,
  getFailover,
  setFailoverConfig,
  tuneFailover,
} from "../src/lib/audio/failover";

let passed = 0;
let failed = 0;

function check(ok: boolean, label: string, detail = ""): void {
  if (ok) {
    passed += 1;
    console.log(`  ok   ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

setFailoverConfig({
  enabled: false,
  thresholdDb: -48,
  holdMs: 4000,
  returnMs: 8000,
  fadeMs: 250,
});

const t0 = Date.now();

/* ── 1 · refuses without measured programme ───────────────────────────── */

console.log("\n1 · needs programme");
{
  const empty = tuneFailover(t0);
  check(!empty.ok, "tuning refuses before any programme is measured");
  check(empty.samples === 0, "the refusal reports zero samples");
  check(getFailover().config.thresholdDb === -48, "a refused tune leaves the threshold alone");
}

/* ── 2 · tunes from a measured programme ──────────────────────────────── */

console.log("\n2 · measured tuning");
{
  // 20 s at the console's 2 Hz watchdog tick: mostly speech at −14…−20 dBFS,
  // with genuine quiet passages at −34 dBFS.
  for (let i = 0; i < 40; i += 1) {
    const db = i % 5 === 0 ? -34 : -14 - (i % 7);
    evaluateFailover(db, true, t0 + i * 500);
  }
  const tuned = tuneFailover(t0 + 40 * 500);
  const cfg = getFailover();

  check(tuned.ok, "tuning succeeds with live programme", tuned.reason);
  check(tuned.samples >= 12, "tuning used a real sample window", `${tuned.samples} samples`);
  check(
    cfg.config.thresholdDb === tuned.thresholdDb,
    "the tuned threshold is persisted to the config",
    `${tuned.thresholdDb} dBFS`,
  );
  check(
    tuned.thresholdDb < tuned.medianDb,
    "the threshold sits below typical programme",
    `${tuned.thresholdDb} < ${tuned.medianDb} dBFS`,
  );
  check(
    tuned.thresholdDb >= -75 && tuned.thresholdDb <= -25,
    "the threshold stays in the useful dead-air band",
    `${tuned.thresholdDb} dBFS`,
  );
  check(
    tuned.thresholdDb <= tuned.floorDb - 5,
    "the threshold clears the measured quiet floor",
    `floor ${tuned.floorDb.toFixed(1)} dBFS`,
  );
  check(
    cfg.config.holdMs >= 2500 && cfg.config.holdMs <= 9000,
    "hold stays between 2.5 s and 9 s",
    `${cfg.config.holdMs} ms`,
  );
  check(
    cfg.config.returnMs >= 5000 && cfg.config.returnMs <= 18_000,
    "return stays between 5 s and 18 s",
    `${cfg.config.returnMs} ms`,
  );
  check(
    cfg.config.fadeMs >= 150 && cfg.config.fadeMs <= 800,
    "cross-fade stays between 150 ms and 800 ms",
    `${cfg.config.fadeMs} ms`,
  );
  check(!cfg.config.enabled, "tuning never arms the watchdog");
  check(cfg.floorDb === tuned.floorDb, "the measured floor is kept for the panel");
  check(cfg.tunedAt > 0, "the tuning timestamp is recorded");
}

console.log(`\n${passed} checks passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
