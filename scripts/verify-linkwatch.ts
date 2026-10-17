/**
 * Link watchdog checks:
 *
 *   bun scripts/verify-linkwatch.ts
 *
 * The composite-over-IP link reports its state; this decides which of those
 * states are worth an entry in the durable alarm history. The rules are pure
 * apart from the module's episode timers, so they can be driven tick by tick
 * here without a browser or an engine.
 *
 * Checks:
 *  1  a disarmed link says nothing
 *  2  a healthy pair says nothing
 *  3  a path switch is announced once, not once per tick
 *  4  both paths quiet long enough is a link-down alarm
 *  5  loss on the serving path is reported
 *  6  a receiver that never locks to RDS is reported
 *  7  disarming clears the episode state
 */
import type { LinkHealth } from "../src/lib/audio/mpxlink";
import type { LinkSnapshot } from "../src/lib/audio/mpxlink-runtime";
import { evaluateLinkHealth, resetLinkWatch } from "../src/lib/audio/linkwatch";

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

function health(over: Partial<LinkHealth> = {}): LinkHealth {
  return {
    alive: true,
    lossPct: 0,
    jitterMs: 2,
    depthMs: 120,
    kbps: 3072,
    received: 500,
    lost: 0,
    duplicates: 0,
    reordered: 0,
    concealed: 0,
    silentMs: 5,
    ...over,
  };
}

function snap(over: Partial<LinkSnapshot> = {}): LinkSnapshot {
  return {
    armed: true,
    codec: "raw",
    packets: 500,
    bytes: 1024000,
    kbps: 3072,
    fps: 187.5,
    transporting: true,
    transport: "udp",
    receive: true,
    active: 0,
    forced: null,
    links: [health(), health()],
    splices: [],
    content: null,
    selfTest: null,
    ...over,
  };
}

const T0 = 1_800_000_000_000;

async function main(): Promise<void> {
  // ── 1 · disarmed ─────────────────────────────────────────────────────────
  console.log("\n1 · disarmed");
  resetLinkWatch();
  check(
    evaluateLinkHealth(snap({ armed: false }), T0).length === 0,
    "a disarmed link produces no alerts",
  );

  // ── 2 · healthy ──────────────────────────────────────────────────────────
  console.log("\n2 · healthy");
  resetLinkWatch();
  check(evaluateLinkHealth(snap(), T0).length === 0, "a clean pair produces no alerts");

  // ── 3 · path switch ──────────────────────────────────────────────────────
  console.log("\n3 · path switch");
  resetLinkWatch();
  evaluateLinkHealth(snap(), T0);
  const spliced = snap({
    active: 1,
    splices: [{ at: 1234, from: 0, to: 1, reason: "path A silent for 412 ms" }],
  });
  const first = evaluateLinkHealth(spliced, T0 + 500);
  check(first.length === 1, "the switch is announced", first[0]?.title ?? "none");
  check(
    (first[0]?.detail ?? "").includes("path A silent"),
    "the reason is carried through",
    first[0]?.detail ?? "",
  );
  check(
    evaluateLinkHealth(spliced, T0 + 1000).length === 0,
    "the same switch is not announced again on the next tick",
  );
  const second = evaluateLinkHealth(
    snap({
      active: 0,
      splices: [{ at: 5678, from: 1, to: 0, reason: "path B loss 4.2 %" }],
    }),
    T0 + 1500,
  );
  check(second.length === 1, "a later switch is announced again");

  // ── 4 · both paths down ──────────────────────────────────────────────────
  console.log("\n4 · link down");
  resetLinkWatch();
  const down = snap({
    links: [
      health({ alive: false, silentMs: 5000 }),
      health({ alive: false, silentMs: 5000 }),
    ],
  });
  check(evaluateLinkHealth(down, T0).length === 0, "the first quiet tick is not an alarm");
  check(
    evaluateLinkHealth(down, T0 + 2000).length === 0,
    "a short gap is still not an alarm",
  );
  const downAlerts = evaluateLinkHealth(down, T0 + 3200);
  check(downAlerts.length >= 1, "silence past the threshold is", downAlerts[0]?.title ?? "none");
  check(
    (downAlerts[0]?.detail ?? "").includes("buffer"),
    "the listener is told the splice is concealing",
    downAlerts[0]?.detail ?? "",
  );

  // ── 5 · loss on the serving path ────────────────────────────────────────
  console.log("\n5 · loss");
  resetLinkWatch();
  const lossy = snap({
    links: [health({ lossPct: 6.4, concealed: 31, jitterMs: 12 }), health()],
  });
  const lossAlerts = evaluateLinkHealth(lossy, T0);
  check(lossAlerts.length === 1, "loss above the threshold is reported", lossAlerts[0]?.title ?? "none");
  check(
    (lossAlerts[0]?.detail ?? "").includes("6.4 %"),
    "the measured loss is in the detail",
    lossAlerts[0]?.detail ?? "",
  );
  resetLinkWatch();
  check(
    evaluateLinkHealth(snap({ links: [health({ lossPct: 0.4 }), health()] }), T0).length === 0,
    "normal loss does not page anyone",
  );

  // ── 6 · no RDS from the link ────────────────────────────────────────────
  console.log("\n6 · no RDS");
  resetLinkWatch();
  check(evaluateLinkHealth(snap(), T0).length === 0, "the first unlocked tick is not an alarm");
  check(evaluateLinkHealth(snap(), T0 + 5000).length === 0, "five seconds is still tolerated");
  const rdsAlerts = evaluateLinkHealth(snap(), T0 + 10_500);
  check(rdsAlerts.some((a) => a.title === "No RDS from the link"), "ten seconds without lock is");
  const locked = snap({
    content: {
      rds: {
        locked: true,
        groups: 40,
        bits: 3000,
        blocks: 160,
        errors: 0,
        phase: 3,
        pi: 0xc479,
        pty: 10,
        ps: "SIGNAL  ",
        psComplete: true,
        rt: "Miles - Blue",
        rtPlus: true,
        rtPlusTags: [],
        pilot: 0.09,
      },
      audio: { rmsL: 0.1, rmsR: 0.1, peakL: 0.2, peakR: 0.2, correlation: 0.1 },
      samples: 192000,
    },
  });
  check(evaluateLinkHealth(locked, T0 + 20_000).length === 0, "a locked receiver is quiet");

  // ── 7 · disarm clears the episode ───────────────────────────────────────
  console.log("\n7 · disarm");
  evaluateLinkHealth(snap({ armed: false }), T0 + 21_000);
  check(evaluateLinkHealth(down, T0 + 22_000).length === 0, "timers restart after re-arming");

  console.log(`\n${passed} checks passed, ${failed} failed.\n`);
  if (failed > 0) process.exit(1);
}

await main();
