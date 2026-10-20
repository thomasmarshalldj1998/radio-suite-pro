/**
 * v3.1 Advanced Processing Suite — defaults, control maths and presets.
 *
 *   bun scripts/verify-advanced.ts
 *
 * The suite proves the two promises that matter before any new DSP is
 * trusted: every module starts neutral (so a v3.0 chain is unchanged), and
 * the pure controllers behave at their limits. Preset wiring is checked
 * against the six factory demonstrations in Part 8.
 *
 *  1  neutral defaults and save coercion
 *  2  AGC profiles, gate, crest, drift and dual anchor
 *  3  compliance / tone / spatial helpers
 *  4  source classification and preset routing
 *  5  six v3.1 factory presets
 */
import {
  DEFAULT_ADVANCED,
  advancedIsNeutral,
  agcProfileEnvelope,
  airShelf,
  channelTrim,
  dcHighpassHz,
  dimDb,
  mainsNotchHz,
  variableQFrequency,
  classifyProgram,
  codecLowpassHz,
  crestDriveDb,
  gateGainTarget,
  harmonicMix,
  notchQ,
  preEmphCorrection,
  presenceGains,
  presetForClass,
  riderTargetLufs,
  lraRatioScale,
} from "../src/lib/audio/advanced";
import {
  BUILTIN_PRESETS,
  DEFAULT_PARAMS,
  coerceParams,
} from "../src/lib/audio/params";

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

const near = (a: number, b: number, tol = 0.01) => Math.abs(a - b) <= tol;

/* ── 1 · neutral defaults ─────────────────────────────────────────────── */

console.log("\n1 · neutral defaults");

{
  check(advancedIsNeutral(DEFAULT_ADVANCED), "every v3.1 module ships bypassed");
  check(DEFAULT_PARAMS.advanced.latency === "balanced", "latency defaults to balanced");
  check(DEFAULT_ADVANCED.spatial.msEq.bands.length === 10, "ten M/S EQ bands are defined");
  check(
    DEFAULT_ADVANCED.spatial.msEq.bands.every((b) => b.midDb === 0 && b.sideDb === 0),
    "M/S EQ is flat by default",
  );

  const legacy = { ...DEFAULT_PARAMS } as Record<string, unknown>;
  delete (legacy as { advanced?: unknown }).advanced;
  const coerced = coerceParams(legacy);
  check(advancedIsNeutral(coerced.advanced), "a v3.0 save gains the neutral suite");
  check(coerced.advanced.compliance.dual.on === false, "dual compliance starts off");
}

/* ── 2 · level-control maths ──────────────────────────────────────────── */

console.log("\n2 · leveling controllers");

{
  const profile = DEFAULT_ADVANCED.leveling.agcProfile;
  const music = agcProfileEnvelope({ ...profile, on: true }, false);
  const speech = agcProfileEnvelope({ ...profile, on: true }, true);
  check(speech.attackMs < music.attackMs, "speech attack is faster than music", `${speech.attackMs} vs ${music.attackMs}`);
  check(speech.releaseMs < music.releaseMs, "speech release is faster than music");
  const neutral = agcProfileEnvelope(
    { ...profile, sensitivity: 50, music: { attackMs: 20, releaseMs: 400 } },
    false,
  );
  check(near(neutral.attackMs, 20) && near(neutral.releaseMs, 400), "50 % sensitivity leaves the stored envelope alone");

  const gate = { ...DEFAULT_ADVANCED.leveling.gate, on: true };
  check(gateGainTarget(-30, false, gate).open, "the gate opens above its open threshold");
  const closed = gateGainTarget(-50, true, gate);
  check(!closed.open && closed.gain === 0, "a level below close−hysteresis closes it");
  check(gateGainTarget(-41, false, gate).open === false, "hysteresis holds it closed just above the close point");
  check(gateGainTarget(-39, false, gate).open, "it reopens at the open threshold");

  check(crestDriveDb(14, DEFAULT_ADVANCED.leveling.crest) > 0, "excess crest asks for drive");
  check(crestDriveDb(8, DEFAULT_ADVANCED.leveling.crest) === 0, "a crest at target adds no drive");
  check(crestDriveDb(40, DEFAULT_ADVANCED.leveling.crest, 5.9) <= 6, "crest drive is capped at 6 dB");

  const drift = riderTargetLufs(
    {
      riderTarget: -16,
      drift: { ...DEFAULT_ADVANCED.leveling.drift, on: true, rangeDb: 2 },
      dual: DEFAULT_ADVANCED.leveling.dualAnchor,
    },
    -22,
  );
  check(drift > -16 && drift <= -14.2, "the drift corrector moves the target within range", `${drift} LUFS`);

  const dual = riderTargetLufs(
    {
      riderTarget: -16,
      drift: DEFAULT_ADVANCED.leveling.drift,
      dual: { ...DEFAULT_ADVANCED.leveling.dualAnchor, on: true, balance: 100 },
    },
    null,
  );
  check(dual === -18, "a full density anchor takes the density target", `${dual} LUFS`);

  check(lraRatioScale(12, DEFAULT_ADVANCED.compliance.lra) === 1, "LRA off is unity");
  const compress = lraRatioScale(12, {
    ...DEFAULT_ADVANCED.compliance.lra,
    on: true,
    targetLu: 6,
  });
  const expand = lraRatioScale(12, {
    ...DEFAULT_ADVANCED.compliance.lra,
    on: true,
    targetLu: 6,
    mode: "expand",
  });
  check(compress > 1 && expand < 1, "compress raises ratios, expand lowers them", `${compress.toFixed(2)} / ${expand.toFixed(2)}`);
}

/* ── 3 · compliance, tone and spatial helpers ─────────────────────────── */

console.log("\n3 · compliance, tone and spatial");

{
  const trim = channelTrim(1);
  check(near(trim.l, Math.pow(10, -1 / 20)) && near(trim.r, Math.pow(10, 1 / 20)), "channel trim splits L/R symmetrically");

  const nq = notchQ(0.2);
  check(nq > 1 && nq < 20, "a 0.2-octave notch gets a finite Q", `${nq.toFixed(1)}`);

  check(codecLowpassHz(DEFAULT_ADVANCED.limiter.codec) === 22000, "codec shaping is transparent when off");
  const opus = codecLowpassHz({
    ...DEFAULT_ADVANCED.limiter.codec,
    on: true,
    target: "opus",
    lowpassHz: 20000,
    hfPreserve: 100,
  });
  check(opus <= 20000 && opus > 15000, "Opus pre-shaping stays inside the audible band", `${opus.toFixed(0)} Hz`);

  const pre = preEmphCorrection(DEFAULT_ADVANCED.limiter.preEmph);
  check(pre.gainDb === 0, "pre-emphasis correction is 0 dB when off");
  const pre50 = preEmphCorrection({
    ...DEFAULT_ADVANCED.limiter.preEmph,
    on: true,
    curve: "50",
    compensateHf: 100,
  });
  check(pre50.gainDb > 0, "a 50 µs curve asks for high-frequency lift", `${pre50.gainDb.toFixed(2)} dB`);

  check(dcHighpassHz(DEFAULT_ADVANCED.restoration.dc) === 0, "DC/subsonic filter is off by default");
  check(
    dcHighpassHz({ ...DEFAULT_ADVANCED.restoration.dc, on: true, hpfHz: 0 }) === 30,
    "brickwall maps to the 30 Hz corner",
  );
  check(mainsNotchHz(DEFAULT_ADVANCED.restoration.interference) === 0, "mains notch is off by default");
  check(
    mainsNotchHz({ ...DEFAULT_ADVANCED.restoration.interference, on: true, mains: 60 }) === 60,
    "the mains notch follows 50/60 Hz",
  );
  const air = airShelf(DEFAULT_ADVANCED.eq.air);
  check(air.gainDb === 0, "air band is 0 dB when off");
  check(dimDb(DEFAULT_ADVANCED.limiter.output) === 0, "output dim is 0 dB when off");
  check(variableQFrequency(1) === 31 && variableQFrequency(10) === 16000, "variable-Q bands span 31 Hz–16 kHz");

  const presence = presenceGains(DEFAULT_ADVANCED.eq.presence);
  check(presence.presenceDb === 0 && presence.brillianceDb === 0, "presence and brilliance are flat when off");

  const mix = harmonicMix(80, 80);
  check(near(mix.even + mix.odd, 1), "harmonic weights normalise to unity", `${mix.even.toFixed(2)} / ${mix.odd.toFixed(2)}`);
}

/* ── 4 · classification ───────────────────────────────────────────────── */

console.log("\n4 · source intelligence");

{
  check(classifyProgram(-60, 12) === "quiet", "silence reads quiet");
  check(classifyProgram(-6, 8) === "loud", "hot programme reads loud");
  check(classifyProgram(-18, 13) === "speech", "high crest mid-level reads speech");
  check(classifyProgram(-18, 8) === "music", "dense mid-level reads music");

  const auto = { ...DEFAULT_ADVANCED.intelligence.autoSource, on: true };
  check(presetForClass(auto, "music") === auto.musicPreset, "music routes to its preset");
  check(presetForClass({ ...auto, on: false }, "music") === null, "auto source off routes nowhere");
}

/* ── 5 · factory presets ──────────────────────────────────────────────── */

console.log("\n5 · v3.1 factory presets");

{
  const names = [
    "NR-Restored",
    "Tight-Punchy",
    "Wide-Natural",
    "FM-Transmission-Grade",
    "Web-Loud-Compliant",
    "Music-HiFi-Open",
  ];
  for (const name of names) {
    const preset = BUILTIN_PRESETS.find((p) => p.name === name);
    check(Boolean(preset), `${name} exists`);
  }
  const wide = BUILTIN_PRESETS.find((p) => p.name === "Wide-Natural");
  check(wide?.params.advanced.spatial.diffusion.on === true, "Wide-Natural engages diffusion at 45 %", `${wide?.params.advanced.spatial.diffusion.width} %`);
  check(wide?.params.advanced.spatial.msEq.on === true, "Wide-Natural enables the M/S EQ");
  const fm = BUILTIN_PRESETS.find((p) => p.name === "FM-Transmission-Grade");
  check(fm?.params.advanced.limiter.mpx.on === true, "FM-Transmission-Grade engages MPX processing");
  check(fm?.params.loudness.customLufs === -18, "FM-Transmission-Grade targets −18 LUFS");
  const web = BUILTIN_PRESETS.find((p) => p.name === "Web-Loud-Compliant");
  check(web?.params.loudness.standard === "spotify", "Web-Loud-Compliant uses the streaming standard");
  check(web?.params.advanced.limiter.codec.target === "opus", "Web-Loud-Compliant pre-shapes for Opus");
  const hifi = BUILTIN_PRESETS.find((p) => p.name === "Music-HiFi-Open");
  check(hifi?.params.advanced.restoration.drr.expansion === 80, "Music-HiFi-Open recovers dynamic range");

  const extended = [
    "Clean-Voice-Broadcast",
    "Podcast-Voice-Plus",
    "Jazz-Open-Dynamic",
    "Rock-Dense-Competitive",
    "Club-Dance-Bass-Forward",
    "Nightmode-Consistent-Soft",
    "Reference-Mastering-Off",
    "Source-Through-Reference",
  ];
  for (const name of extended) {
    check(Boolean(BUILTIN_PRESETS.find((p) => p.name === name)), `${name} exists`);
  }
  const night = BUILTIN_PRESETS.find((p) => p.name === "Nightmode-Consistent-Soft");
  check(night?.params.advanced.leveling.silence.on === true, "Nightmode handles deep silence");
  const ref = BUILTIN_PRESETS.find((p) => p.name === "Source-Through-Reference");
  check(
    ref?.params.limiter.on === false && ref?.params.agc.on === false && ref?.params.eq.on === false,
    "Source-Through-Reference bypasses every dynamics stage",
  );
}

console.log(`\n${passed} checks passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
