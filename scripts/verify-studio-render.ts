/**
 * Markup smoke test for the studio page:
 *
 *   bun scripts/verify-studio-render.ts
 *
 * The page is rendered server-side (no AudioContext is constructed until the
 * operator presses start), so this proves the component tree builds, the
 * default tab renders, and every control the brief asks for is present.
 *
 *  1  the rack chrome and engine header render
 *  2  the ten-stage signal path is in the right order
 *  3  the meter bridge carries all input / GR / band / limiter meters
 *  4  the five multiband meters carry their frequency labels
 *  5  all eight workspace tabs are present
 *  6  every loudness target option is selectable
 *  7  the default panel exposes the preamp, gate and speech controls
 *  8  the markup contains no NaN / undefined leakage
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Studio from "../src/pages/Studio";

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

const html = renderToStaticMarkup(createElement(Studio));

console.log("\n1 · chrome");
check(html.includes('class="sp-root"'), "the rack shell renders");
check(html.includes("SIGNALPATH") && html.includes("SP-9600"), "brand and model are present");
check(html.includes("Meter bridge"), "the meter deck renders");
check(html.includes("Start engine"), "the engine can be started from the header");

console.log("\n2 · signal path");
const STAGES = [
  "INPUT",
  "PREAMP",
  "DE-CLIPPER",
  "AGC",
  "SUB-BASS",
  "DYN-EQ",
  "MULTIBAND",
  "TRANSIENT",
  "LIMITER",
  "OUTPUT",
];
let last = -1;
let ordered = true;
for (const stage of STAGES) {
  const at = html.indexOf(`>${stage}<`, last + 1);
  if (at < 0) ordered = false;
  last = at;
}
check(ordered, "all ten stages appear in processing order", STAGES.join(" → "));

console.log("\n3 · meter bridge");
const METERS = [
  "IN L",
  "IN R",
  "AGC GR",
  "HF",
  "STEREO",
  "LIMIT",
  "TRUE PK",
  "OUT L",
  "OUT R",
];
const missing = METERS.filter((m) => !html.includes(m));
check(missing.length === 0, "input, AGC, enhancer, limiter and output meters render", missing.join(", ") || `${METERS.length} meters`);

console.log("\n4 · multiband labels");
const BAND_LABELS = ["LOW", "MID1", "MID2", "MID3", "HIGH"];
const missingBands = BAND_LABELS.filter((b) => !html.includes(`>${b}<`));
check(missingBands.length === 0, "each band GR bar is labelled", missingBands.join(", ") || BAND_LABELS.join(" · "));
check(html.includes("30–120 Hz") && html.includes("6 kHz +"), "frequency spans sit under the band meters");

console.log("\n5 · tabs");
const TABS = [
  "Input / Preamp",
  "Restoration",
  "AGC &amp; Leveller",
  "Enhancers &amp; Sub",
  "Multiband 5-Band",
  "Limiter &amp; Output",
  "Streaming &amp; Automation",
  "Telemetry Scope",
  "Preset Morph",
];
const missingTabs = TABS.filter((t) => !html.includes(t));
check(missingTabs.length === 0, "all nine workspace tabs render", missingTabs.join(", ") || `${TABS.length} tabs`);
check(/sp-tab active"[^>]*>Input \/ Preamp/.test(html), "the input panel is the default tab");

console.log("\n6 · loudness targets");
check(html.includes("−14.0 LUFS") && html.includes("−16.0 LUFS") && html.includes("−23.0 LUFS"), "three delivery targets are offered");
check(html.includes("AES71") || html.includes("-14"), "the web default is called out");

console.log("\n7 · default panel");
check(html.includes("Input trim"), "preamp trim renders");
check(html.includes("Silence gate"), "the silence gate readout renders");
check(html.includes("Speech detector"), "the speech detector status renders");
check(html.includes("Demo program"), "the demo source is selectable");
check(html.includes("Start engine"), "the gesture-gated start control is visible");

console.log("\n8 · markup hygiene");
check(!html.includes("NaN"), "no NaN leaked into the markup");
check(!html.includes("undefined"), "no undefined leaked into the markup");
check(!html.includes("[object Object]"), "no object stringification leaked");

console.log(`\n${passed} checks passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
