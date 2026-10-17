/**
 * Audio-clock health checks:
 *
 *   bun scripts/verify-glitch.ts
 *
 * The engine's one-second drift figure is the amount of audio the graph lost
 * against wall time. These checks drive the classifier that turns it into
 * episodes — one alarm per stall, one recovery, no chatter from a single bad
 * second.
 *
 *  1  a single starved second is not yet an episode
 *  2  two consecutive starved seconds report a stall
 *  3  a stall is not re-reported while the graph stays starved
 *  4  an inconclusive sample neither resets the streak nor recovers
 *  5  a healthy sample recovers the episode, once
 *  6  the worst drift is kept, and reset clears the session
 */
import { DEFAULT_GLITCH, GlitchMonitor } from "../src/lib/audio/glitch";

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

const STALL = DEFAULT_GLITCH.thresholdMs - 1; // below the threshold
const NEAR = (DEFAULT_GLITCH.thresholdMs + DEFAULT_GLITCH.recoverMs) / 2; // inconclusive
const HEALTHY = 0;

/* ── 1 + 2: hold time ──────────────────────────────────────────────────── */

console.log("\n1 · a single bad second");
let clock = 1_000_000;
const monitor = new GlitchMonitor();
check(monitor.update(HEALTHY, (clock += 1000)) === null, "a healthy second says nothing");
check(monitor.update(STALL, (clock += 1000)) === null, "one starved second is not reported");
check(!monitor.stalled && monitor.stalls === 0, "the monitor has not declared a stall");

console.log("\n2 · the second starved second");
const stall = monitor.update(STALL, (clock += 1000));
check(stall?.type === "stall", "the stall is reported", stall ? `${stall.driftMs} ms/s` : "—");
check(monitor.stalled && monitor.stalls === 1, "the episode is open and counted once", `${monitor.stalls}`);
check(monitor.lastStallAt === clock, "the report is timestamped", `t=${clock}`);

/* ── 3: no chatter while it stays bad ──────────────────────────────────── */

console.log("\n3 · still starved");
let again = null;
for (let i = 0; i < 5; i++) again = monitor.update(STALL - 4, (clock += 1000)) ?? again;
check(again === null, "a continuing stall is not re-reported");
check(monitor.stalls === 1, "the episode count does not climb", `${monitor.stalls}`);

/* ── 4: inconclusive readings ──────────────────────────────────────────── */

console.log("\n4 · inconclusive");
check(monitor.update(NEAR, (clock += 1000)) === null, "a borderline second reports nothing");
check(monitor.stalled, "and does not end the episode while still open");

/* ── 5: recovery ───────────────────────────────────────────────────────── */

console.log("\n5 · recovery");
const recovered = monitor.update(HEALTHY, (clock += 1000));
check(recovered?.type === "recovered", "the recovery is reported");
check(!monitor.stalled, "the episode is closed");
check(monitor.update(HEALTHY, (clock += 1000)) === null, "a second healthy second is quiet");

console.log("\n5b · a fresh dip after recovery");
check(monitor.update(STALL, (clock += 1000)) === null, "the hold time applies again");
const second = monitor.update(STALL, (clock += 1000));
check(second?.type === "stall" && monitor.stalls === 2, "a new episode is its own report", `${monitor.stalls}`);

/* ── 6: worst case + reset ─────────────────────────────────────────────── */

console.log("\n6 · session bookkeeping");
check(monitor.worstDriftMs <= STALL - 4, "the worst one-second drift is kept", `${monitor.worstDriftMs}`);
monitor.reset();
check(monitor.stalls === 0 && monitor.lastStallAt === 0 && !monitor.stalled, "reset clears the session");
check(monitor.worstDriftMs === 0, "reset clears the worst case");

console.log(`\n${passed} checks passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
