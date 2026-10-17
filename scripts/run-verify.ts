/**
 * Runs every verification suite in `scripts/`.
 *
 *   bun run verify
 *
 * Each `verify-*.ts` file is a self-contained suite that prints
 * "N checks passed, M failed." and exits non-zero when anything fails. They
 * are the repo's only tests and nothing else invoked them, so they ran solely
 * when someone remembered to. This gives one command — and one CI step — that
 * fails on any of them.
 *
 * A passing suite prints its summary line only; a failing one prints its full
 * output afterwards, so a green run stays readable and a red one stays useful.
 *
 * In CI a failure is also emitted as a GitHub annotation and appended to the
 * step summary: job logs need authentication, but annotations are readable
 * from the public checks API, so a red run stays diagnosable from outside the
 * browser session that ran it.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL("./", import.meta.url));
const suites = readdirSync(dir)
  .filter((name) => /^verify-.*\.ts$/.test(name))
  .sort();

if (suites.length === 0) {
  console.error(`no verify-*.ts suites found in ${dir}`);
  process.exit(1);
}

let passedSuites = 0;
let totalChecks = 0;
const failures: { name: string; output: string }[] = [];

console.log(`running ${suites.length} verification suites\n`);

for (const name of suites) {
  const started = Date.now();
  // process.execPath is the bun binary that is running this file, so the
  // suites start even where `bun` is not on PATH (Windows runners included).
  const run = spawnSync(process.execPath, [join(dir, name)], {
    encoding: "utf8",
  });
  const ms = Date.now() - started;
  const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  const summary = output.match(/(\d+) checks passed, (\d+) failed/);

  if (run.status === 0) {
    const checks = Number(summary?.[1] ?? 0);
    passedSuites += 1;
    totalChecks += checks;
    console.log(`  ok   ${name.padEnd(28)} ${String(checks).padStart(3)} checks · ${ms} ms`);
  } else {
    failures.push({ name, output });
    console.log(`  FAIL ${name.padEnd(28)} exit ${run.status ?? "null"} · ${ms} ms`);
  }
}

for (const { name, output } of failures) {
  console.log(`\n${"─".repeat(72)}\n${name}\n${"─".repeat(72)}\n${output.trimEnd()}`);
  console.log(`::error title=verify ${name}::${annotationBody(output)}`);
}

if (failures.length > 0) {
  writeStepSummary(failures);
}

console.log(
  `\n${passedSuites}/${suites.length} suites passed · ${totalChecks} checks` +
    (failures.length ? ` · ${failures.length} failed` : ""),
);
process.exit(failures.length === 0 ? 0 : 1);

/**
 * The failing checks, escaped for a GitHub workflow command: `%`, CR and LF
 * are the only characters the annotation parser reserves.
 */
function annotationBody(output: string): string {
  const lines = output.split("\n").filter((line) => line.includes("FAIL"));
  const detail = lines.length
    ? lines.slice(0, 8).join("\n")
    : output.trimEnd().split("\n").slice(-4).join("\n");
  return detail.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

/** Publish the failing suites to the run's Summary tab when CI asks for it. */
function writeStepSummary(failed: { name: string; output: string }[]): void {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (!path) return;
  const body = [
    "### Verify engine failures",
    "",
    ...failed.map(({ name, output }) => {
      const lines = output.split("\n").filter((line) => line.includes("FAIL"));
      return [
        `**${name}**`,
        "```",
        (lines.length ? lines : output.trimEnd().split("\n").slice(-6)).join("\n"),
        "```",
      ].join("\n");
    }),
    "",
  ].join("\n");
  try {
    appendFileSync(path, body);
  } catch {
    /* a missing summary file must never mask the failing suites */
  }
}
