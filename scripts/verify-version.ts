/**
 * Release version guard:
 *
 *   bun scripts/verify-version.ts
 *
 * Two files carry the app version — `package.json`, which electron-builder
 * reads for the installer metadata, and `src/lib/version.ts`, which feeds the
 * footer, the landing page and the diagnostics export. Nothing in the build
 * compared them, so a tag cut from a tree where only one was bumped ships an
 * installer that reports the wrong version; that is how 1.1.1 went out stamped
 * 1.0.0. This runs before packaging, so the release fails here instead.
 *
 *  1  package.json carries a plain X.Y.Z version
 *  2  APP_VERSION carries a plain X.Y.Z version
 *  3  the two agree
 *  4  every download link resolves under /latest/download/ and never pins a
 *     version, so the URLs survive the next release
 *  5  the releases URL is an absolute repository page, not a placeholder
 */
import { readFileSync } from "node:fs";

import {
  APP_VERSION,
  DESKTOP_DOWNLOADS,
  RELEASES_URL,
} from "../src/lib/version";

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

const SEMVER = /^\d+\.\d+\.\d+$/;
const VERSION_SEGMENT = /\/\d+\.\d+\.\d+\//;
const PLACEHOLDER = /<[^>]*>|\/(your|owner|repo)\//i;

const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version?: string };

console.log("\n1 · package.json");
check(typeof pkg.version === "string" && pkg.version.length > 0, "the version field is present", `${pkg.version}`);
check(SEMVER.test(pkg.version ?? ""), "it is a plain X.Y.Z", `${pkg.version ?? "missing"}`);

console.log("\n2 · src/lib/version.ts");
check(SEMVER.test(APP_VERSION), "APP_VERSION is a plain X.Y.Z", APP_VERSION);

console.log("\n3 · agreement");
check(
  pkg.version === APP_VERSION,
  "the installer metadata and the shipped constant agree",
  `package.json ${pkg.version} · APP_VERSION ${APP_VERSION}`,
);

/* ── 4: the download links ─────────────────────────────────────────────── */

console.log("\n4 · download links");
const links = Object.entries(DESKTOP_DOWNLOADS);
check(links.length === 5, "all five desktop installers are listed", `${links.length}`);

const prefix = `${RELEASES_URL}/latest/download/`;
const seen = new Set<string>();
for (const [key, url] of links) {
  check(url.startsWith(prefix), `${key} resolves under /latest/download/`, key);
  check(!VERSION_SEGMENT.test(url), `${key} pins no version, so it survives a bump`, key);
  check(!seen.has(url), `${key} is a distinct artifact`, key);
  seen.add(url);
}

/* ── 5: where the links point ──────────────────────────────────────────── */

console.log("\n5 · releases page");
check(
  /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/releases$/.test(RELEASES_URL),
  "RELEASES_URL is an absolute GitHub releases page",
  RELEASES_URL,
);
check(!PLACEHOLDER.test(RELEASES_URL), "it names a real repository, not a placeholder");

if (pkg.version !== APP_VERSION) {
  console.log(
    "\n  -> bump BOTH files before tagging: package.json and src/lib/version.ts",
  );
}

console.log(`\n${passed} checks passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
