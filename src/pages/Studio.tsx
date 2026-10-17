/**
 * Signalpath Studio — a single-file advanced broadcast processor.
 *
 * Everything the page needs lives in this file: the rack styling, the DSP
 * graph (Web Audio), the program generator, the meters, the scopes and the
 * control surface. Mounted at /studio.
 *
 * Signal path (as displayed and as wired):
 *   INPUT → PREAMP → DE-CLIPPER → AGC → SUB-BASS → DYN-EQ
 *         → MULTIBAND (5) → TRANSIENT SNAP → LIMITER → OUTPUT
 */
/* eslint-disable react-refresh/only-export-components -- this page is deliberately
   one file; the DSP helpers are exported so the verification scripts can drive
   the real maths rather than a copy of it. */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

/* ──────────────────────────────────────────────────────────────────────────
 * Theme
 * ────────────────────────────────────────────────────────────────────────── */

const CSS = `
.sp-root{
  --bg:#0c0e12; --card:#151921; --card-2:#11151b; --well:#0f1319;
  --line:#232b38; --line-2:#2c3646; --ink:#e8eef8; --mut:#7d8ba1; --dim:#586579;
  --cyan:#22d3ee; --cyan-dim:#0e7490; --blue:#3b82f6; --ok:#34d399;
  --warn:#fbbf24; --hot:#fb7185; --amber:#f59e0b;
  background:
    radial-gradient(1200px 500px at 50% -10%, rgba(34,211,238,.07), transparent 70%),
    var(--bg);
  color:var(--ink); min-height:100vh; font-family:"Inter",ui-sans-serif,system-ui,sans-serif;
  padding-bottom:28px;
}
.sp-root *{box-sizing:border-box}
.sp-mono{font-family:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace;font-variant-numeric:tabular-nums}
.sp-shell{max-width:1600px;margin:0 auto;padding:0 14px}

/* header */
.sp-head{display:flex;align-items:center;gap:16px;flex-wrap:wrap;padding:16px 0 12px;border-bottom:1px solid var(--line)}
.sp-brand{display:flex;align-items:center;gap:11px;min-width:0}
.sp-mark{width:34px;height:34px;border-radius:8px;display:grid;place-items:center;
  background:linear-gradient(145deg,#0e5f70,#0a2b38);border:1px solid #1d7f93;
  box-shadow:0 0 18px rgba(34,211,238,.18) inset,0 0 22px rgba(34,211,238,.12)}
.sp-mark svg{width:19px;height:19px}
.sp-title{font-size:15px;font-weight:800;letter-spacing:.14em;line-height:1}
.sp-sub{font-size:9px;letter-spacing:.22em;color:var(--mut);margin-top:4px}
.sp-head-right{margin-left:auto;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.sp-badge{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 9px;border-radius:5px;
  border:1px solid var(--line-2);background:var(--card-2);font-size:9.5px;letter-spacing:.14em;
  text-transform:uppercase;color:var(--mut)}
.sp-badge b{color:var(--ink);font-weight:600}
.sp-led{width:7px;height:7px;border-radius:50%;background:#2a3442;box-shadow:0 0 0 1px #000 inset}
.sp-led.on{background:var(--ok);box-shadow:0 0 8px rgba(52,211,153,.8)}
.sp-led.hot{background:var(--hot);box-shadow:0 0 9px rgba(251,113,133,.9);animation:sp-pulse 1.4s infinite}
.sp-led.warn{background:var(--warn);box-shadow:0 0 8px rgba(251,191,36,.7)}
@keyframes sp-pulse{0%,100%{opacity:1}50%{opacity:.35}}
.sp-btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;height:30px;padding:0 13px;
  border-radius:5px;border:1px solid var(--line-2);background:var(--card);color:var(--ink);
  font-size:10px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;cursor:pointer;
  transition:border-color .15s,background .15s,transform .08s}
.sp-btn:hover{border-color:#3a4a60;background:#1a2030}
.sp-btn:active{transform:translateY(1px)}
.sp-btn.primary{background:linear-gradient(180deg,#0e6c7e,#0a4b57);border-color:#1d8fa3;color:#dcfeff;
  box-shadow:0 0 18px rgba(34,211,238,.16)}
.sp-btn.primary:hover{background:linear-gradient(180deg,#108094,#0b5766)}
.sp-btn.danger{background:#3a1418;border-color:#7f2b33;color:#ffd9dd}
.sp-btn:disabled{opacity:.45;cursor:default}
.sp-select{height:28px;border-radius:5px;background:var(--card-2);border:1px solid var(--line-2);
  color:var(--ink);font-size:10px;letter-spacing:.08em;padding:0 8px;outline:none;cursor:pointer}
.sp-select:focus{border-color:var(--cyan-dim)}

/* signal path ribbon */
.sp-path{display:flex;align-items:center;gap:0;overflow-x:auto;padding:9px 0 2px;scrollbar-width:none}
.sp-path::-webkit-scrollbar{display:none}
.sp-stage{display:inline-flex;align-items:center;gap:8px;padding:5px 9px;border-radius:4px;
  border:1px solid transparent;white-space:nowrap;font-size:9px;letter-spacing:.14em;color:var(--dim);
  text-transform:uppercase}
.sp-stage b{font-weight:600;color:var(--mut)}
.sp-stage.active{background:rgba(34,211,238,.07);border-color:rgba(34,211,238,.26);color:#a9f2ff}
.sp-stage.active b{color:var(--cyan)}
.sp-arrow{color:#2b3648;font-size:10px;padding:0 2px}

/* meter bridge */
.sp-deck{margin-top:12px;border:1px solid var(--line);border-radius:9px;background:
  linear-gradient(180deg,#161b24,#12161d);box-shadow:0 12px 30px rgba(0,0,0,.35),0 1px 0 rgba(255,255,255,.03) inset}
.sp-deck-top{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:8px 12px;border-bottom:1px solid var(--line)}
.sp-deck-title{font-size:9px;letter-spacing:.22em;color:var(--mut);text-transform:uppercase}
.sp-deck-title b{color:var(--ink);letter-spacing:.14em}
.sp-meters{display:flex;gap:2px;align-items:flex-end;padding:10px 12px 8px;overflow-x:auto}
.sp-meter{display:flex;flex-direction:column;align-items:center;gap:4px;min-width:42px;flex:1 1 42px}
.sp-meter-label{font-size:8px;letter-spacing:.12em;color:var(--mut);text-transform:uppercase;white-space:nowrap}
.sp-rail{display:flex;flex-direction:column;gap:2px;width:100%;max-width:44px;height:106px;justify-content:flex-end}
.sp-seg{height:3.6px;border-radius:1px;background:#1d2531;transition:background .06s linear}
.sp-seg.on{background:var(--cyan);box-shadow:0 0 6px rgba(34,211,238,.55)}
.sp-seg.on.warn{background:var(--warn);box-shadow:0 0 6px rgba(251,191,36,.5)}
.sp-seg.on.hot{background:var(--hot);box-shadow:0 0 7px rgba(251,113,133,.6)}
.sp-meter-val{font-size:9px;color:var(--ink);white-space:nowrap}
.sp-meter-val small{color:var(--dim);font-size:7.5px;margin-left:1px}
.sp-meter-sub{font-size:7.5px;letter-spacing:.08em;color:var(--dim);text-transform:uppercase;margin-top:-2px}

/* silence banner */
.sp-alarm{display:flex;align-items:center;gap:10px;margin:10px 12px 12px;padding:8px 12px;border-radius:6px;
  background:linear-gradient(90deg,rgba(251,113,133,.16),rgba(251,113,133,.04));
  border:1px solid rgba(251,113,133,.45);color:#ffe4e8;font-size:10px;letter-spacing:.1em;text-transform:uppercase}
.sp-alarm b{color:#fff;font-weight:800;letter-spacing:.16em}
.sp-alarm .sp-mono{color:#ffb4bf}
.sp-alarm button{margin-left:auto}

/* tabs */
.sp-tabs{display:flex;gap:4px;margin-top:14px;overflow-x:auto;border-bottom:1px solid var(--line);padding-bottom:0}
.sp-tabs::-webkit-scrollbar{height:0}
.sp-tab{appearance:none;border:1px solid transparent;border-bottom:none;background:transparent;color:var(--mut);
  font-size:9.5px;letter-spacing:.14em;text-transform:uppercase;font-weight:600;padding:9px 11px 8px;
  border-radius:5px 5px 0 0;cursor:pointer;white-space:nowrap}
.sp-tab:hover{color:var(--ink);background:rgba(255,255,255,.025)}
.sp-tab.active{color:#c8f7ff;background:linear-gradient(180deg,rgba(34,211,238,.12),rgba(34,211,238,.02));
  border-color:rgba(34,211,238,.3);border-bottom-color:transparent;box-shadow:0 -1px 0 var(--cyan) inset}

/* workspace */
.sp-work{margin-top:14px}
.sp-grid{display:grid;gap:12px;grid-template-columns:repeat(12,1fr)}
.sp-col-4{grid-column:span 4}.sp-col-5{grid-column:span 5}.sp-col-6{grid-column:span 6}
.sp-col-7{grid-column:span 7}.sp-col-8{grid-column:span 8}.sp-col-12{grid-column:span 12}
@media(max-width:1100px){.sp-col-4,.sp-col-5,.sp-col-7{grid-column:span 6}.sp-col-8{grid-column:span 12}}
@media(max-width:720px){.sp-col-4,.sp-col-5,.sp-col-6,.sp-col-7{grid-column:span 12}}
.sp-card{border:1px solid var(--line);border-radius:8px;background:linear-gradient(180deg,#151921,#12161d);
  overflow:hidden;min-width:0}
.sp-card-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:9px 12px;border-bottom:1px solid var(--line);
  background:rgba(255,255,255,.012)}
.sp-card-head h3{margin:0;font-size:9.5px;letter-spacing:.18em;text-transform:uppercase;font-weight:700;color:#cfd9e8}
.sp-card-head p{margin:2px 0 0;font-size:8.5px;color:var(--dim);letter-spacing:.04em}
.sp-card-head .sp-right{margin-left:auto;display:flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:flex-end}
.sp-card-body{padding:12px}
.sp-stack{display:flex;flex-direction:column;gap:12px}

/* control rows */
.sp-row{display:grid;grid-template-columns:1fr auto;align-items:center;gap:7px 10px;margin-bottom:11px}
.sp-row:last-child{margin-bottom:0}
.sp-row-label{font-size:9px;letter-spacing:.11em;color:var(--mut);text-transform:uppercase;display:flex;align-items:center;gap:6px}
.sp-row-label i{font-style:normal;color:var(--dim);font-size:8px}
.sp-val{font-size:10px;color:#dff7ff;border:1px solid var(--line-2);background:#0d1117;border-radius:3px;
  padding:1px 6px;min-width:58px;text-align:right;letter-spacing:.03em}
.sp-slider{-webkit-appearance:none;appearance:none;grid-column:1/-1;width:100%;height:18px;background:transparent;margin:-3px 0 0;cursor:pointer}
.sp-slider::-webkit-slider-runnable-track{height:4px;border-radius:3px;
  background:linear-gradient(90deg,rgba(34,211,238,.55),rgba(59,130,246,.35)),#1b2330}
.sp-slider::-moz-range-track{height:4px;border-radius:3px;background:#1b2330}
.sp-slider::-webkit-slider-thumb{-webkit-appearance:none;width:12px;height:16px;margin-top:-6px;border-radius:2px;
  background:linear-gradient(180deg,#e7fbff,#8fe9f7);border:1px solid #1b8ea0;box-shadow:0 0 9px rgba(34,211,238,.55)}
.sp-slider::-moz-range-thumb{width:12px;height:16px;border-radius:2px;border:1px solid #1b8ea0;
  background:linear-gradient(180deg,#e7fbff,#8fe9f7);box-shadow:0 0 9px rgba(34,211,238,.55)}
.sp-slider:focus-visible{outline:1px solid var(--cyan-dim);outline-offset:4px}

.sp-toggle{display:inline-flex;align-items:center;gap:7px;border:1px solid var(--line-2);background:#0e1218;
  border-radius:14px;padding:3px 3px 3px 9px;cursor:pointer;color:var(--mut);font-size:8.5px;
  letter-spacing:.12em;text-transform:uppercase}
.sp-toggle .knob{width:22px;height:14px;border-radius:8px;background:#222b39;position:relative;transition:background .15s}
.sp-toggle .knob::after{content:"";position:absolute;top:2px;left:2px;width:10px;height:10px;border-radius:50%;
  background:#7b8a9e;transition:left .15s,background .15s}
.sp-toggle[aria-pressed="true"]{border-color:rgba(34,211,238,.45);color:#bdf6ff}
.sp-toggle[aria-pressed="true"] .knob{background:#0d5f6e}
.sp-toggle[aria-pressed="true"] .knob::after{left:10px;background:var(--cyan);box-shadow:0 0 8px var(--cyan)}

.sp-mini{display:grid;gap:2px;margin-bottom:9px}
.sp-mini:last-child{margin-bottom:0}
.sp-mini-top{display:flex;justify-content:space-between;align-items:baseline;font-size:8px;letter-spacing:.08em;
  text-transform:uppercase;color:var(--dim)}
.sp-mini-top b{color:#cfd9e8;font-weight:500;font-size:9px}
.sp-mini .sp-slider{height:14px}
.sp-mini .sp-slider::-webkit-slider-thumb{width:9px;height:12px;margin-top:-4px}

.sp-kv{display:flex;justify-content:space-between;gap:10px;padding:5px 0;border-bottom:1px dashed rgba(255,255,255,.05);font-size:9px}
.sp-kv:last-child{border-bottom:none}
.sp-kv span{color:var(--mut);letter-spacing:.09em;text-transform:uppercase}
.sp-kv b{font-weight:500;color:#dff7ff}
.sp-note{font-size:9px;line-height:1.55;color:var(--dim);margin:8px 0 0}
.sp-note b{color:var(--mut);font-weight:500}
.sp-tag{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--line-2);border-radius:3px;
  padding:2px 6px;font-size:8px;letter-spacing:.12em;text-transform:uppercase;color:var(--mut)}
.sp-tag.cyan{border-color:rgba(34,211,238,.35);color:#a9f2ff;background:rgba(34,211,238,.06)}
.sp-tag.amber{border-color:rgba(251,191,36,.35);color:#ffe4a3;background:rgba(251,191,36,.06)}

/* multiband */
.sp-bands{display:grid;gap:10px;grid-template-columns:repeat(5,1fr)}
@media(max-width:1000px){.sp-bands{grid-template-columns:repeat(2,1fr)}}
@media(max-width:560px){.sp-bands{grid-template-columns:1fr}}
.sp-band{border:1px solid var(--line);border-radius:7px;background:var(--card-2);padding:10px}
.sp-band-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}
.sp-band-head b{font-size:9.5px;letter-spacing:.14em;color:#c9f6ff}
.sp-band-head span{font-size:8px;color:var(--dim)}
.sp-band-gr{height:5px;border-radius:3px;background:#1b2330;overflow:hidden;margin:0 0 9px}
.sp-band-gr i{display:block;height:100%;background:linear-gradient(90deg,var(--cyan),var(--blue));
  transition:width .08s linear}

/* canvases */
.sp-scope{width:100%;height:300px;display:block;border-radius:6px;background:
  radial-gradient(circle at 50% 50%,rgba(34,211,238,.05),transparent 62%),#080b10;
  border:1px solid #1a2130}
.sp-chart{width:100%;height:250px;display:block;border-radius:6px;background:#080b10;border:1px solid #1a2130}
.sp-legend{display:flex;gap:12px;flex-wrap:wrap;font-size:8px;letter-spacing:.1em;text-transform:uppercase;color:var(--dim)}
.sp-legend i{display:inline-block;width:14px;height:2px;margin-right:5px;vertical-align:middle;border-radius:2px}
.sp-corr{display:flex;align-items:baseline;gap:8px;margin-top:8px}
.sp-corr b{font-size:24px;font-weight:600;letter-spacing:-.02em}
.sp-corr span{font-size:8.5px;letter-spacing:.16em;text-transform:uppercase;color:var(--dim)}
.sp-corr-track{position:relative;height:6px;border-radius:3px;margin-top:6px;background:
  linear-gradient(90deg,#fb7185 0%,#3a2b1d 38%,#2a3442 50%,#1d3a44 62%,#22d3ee 100%)}
.sp-corr-track i{position:absolute;top:-3px;width:2px;height:12px;background:#fff;box-shadow:0 0 8px rgba(255,255,255,.8)}

/* misc */
.sp-hint{display:flex;align-items:center;gap:10px;margin-top:12px;padding:9px 12px;border-radius:6px;
  border:1px dashed rgba(34,211,238,.3);background:rgba(34,211,238,.04);color:#a9f2ff;font-size:9.5px;letter-spacing:.05em}
.sp-err{margin-top:10px;padding:8px 12px;border-radius:6px;border:1px solid rgba(251,113,133,.4);
  background:rgba(251,113,133,.08);color:#ffd9de;font-size:9.5px}
.sp-foot{display:flex;gap:14px;flex-wrap:wrap;align-items:center;margin-top:18px;padding-top:10px;
  border-top:1px solid var(--line);font-size:8.5px;letter-spacing:.1em;color:var(--dim);text-transform:uppercase}
.sp-foot b{color:var(--mut);font-weight:500}
@media(prefers-reduced-motion:reduce){.sp-led.hot{animation:none}}
`;

/* ──────────────────────────────────────────────────────────────────────────
 * Model
 * ────────────────────────────────────────────────────────────────────────── */

type TabId =
  | "input"
  | "restore"
  | "agc"
  | "enhance"
  | "multiband"
  | "output"
  | "stream"
  | "scope"
  | "presets";

type CodecId = "off" | "mp3-64" | "mp3-128" | "mp3-320" | "aac-he-64" | "opus-96";
type GenreId = "pop" | "rock" | "hiphop" | "edm" | "acoustic" | "talk";

type BandId = "low" | "mid1" | "mid2" | "mid3" | "high";
type TraceMode = "cyan" | "amber" | "green";
type SourceMode = "demo" | "mic";

interface BandParams {
  thresholdDb: number;
  ratio: number;
  attackMs: number;
  releaseMs: number;
  gainDb: number;
}

export interface Params {
  inputGainDb: number;
  toneLowDb: number;
  toneHighDb: number;
  declipOn: boolean;
  declipDriveDb: number;
  declipThresholdDb: number;
  declipMix: number;
  agcThresholdDb: number;
  agcRatio: number;
  agcAttackMs: number;
  agcReleaseMs: number;
  agcMakeupDb: number;
  subOn: boolean;
  subDrive: number;
  subCutoff: number;
  subHarmonics: number;
  dynEq: number;
  bands: Record<BandId, BandParams>;
  transientOn: boolean;
  transientAttackDb: number;
  transientSensitivity: number;
  hf: number;
  width: number;
  ceilingDb: number;
  limiterReleaseMs: number;
  outputGainDb: number;
  speechOn: boolean;
  autoLoudness: boolean;
  target: number;
  // ── streaming & automation ──
  codec: CodecId;
  hfComp: boolean;
  duckOn: boolean;
  duckDepthDb: number;
  duckReleaseMs: number;
  duckMicOpen: boolean;
  duckAuto: boolean;
  genre: GenreId | "auto";
  metadata: string;
  backupOn: boolean;
  talentMode: boolean;
}

/**
 * Codec preview profiles. This is an emulation, not a real encoder: each
 * profile band-limits the monitor feed, adds the short comb that stands in for
 * pre-echo, and tells the HF compensation how much upper-band limiting the
 * bitrate needs.
 */
export const CODEC_PROFILES: Record<
  CodecId,
  { label: string; bitrate: number; lowpass: number; comb: number; hfTrimDb: number }
> = {
  off: { label: "Preview bypassed", bitrate: 0, lowpass: 20000, comb: 0, hfTrimDb: 0 },
  "mp3-64": { label: "MP3 · 64 kbps", bitrate: 64, lowpass: 11000, comb: 0.35, hfTrimDb: 3 },
  "mp3-128": { label: "MP3 · 128 kbps", bitrate: 128, lowpass: 15500, comb: 0.22, hfTrimDb: 1.6 },
  "mp3-320": { label: "MP3 · 320 kbps", bitrate: 320, lowpass: 19500, comb: 0.08, hfTrimDb: 0.4 },
  "aac-he-64": { label: "AAC-HE · 64 kbps", bitrate: 64, lowpass: 16500, comb: 0.3, hfTrimDb: 2.4 },
  "opus-96": { label: "Opus · 96 kbps", bitrate: 96, lowpass: 20000, comb: 0.12, hfTrimDb: 0.8 },
};

export const GENRE_PROFILES: Record<
  GenreId,
  { label: string; toneLow: number; toneHigh: number; bandThreshold: number; lowGain: number }
> = {
  pop: { label: "Pop", toneLow: 0.8, toneHigh: 1.2, bandThreshold: 0, lowGain: 0.4 },
  rock: { label: "Rock", toneLow: -0.6, toneHigh: 1.6, bandThreshold: -0.8, lowGain: 0.6 },
  hiphop: { label: "Hip-Hop", toneLow: 2.4, toneHigh: -0.4, bandThreshold: -1.6, lowGain: 1.2 },
  edm: { label: "EDM", toneLow: 2, toneHigh: 1.4, bandThreshold: -1, lowGain: 1 },
  acoustic: { label: "Acoustic", toneLow: 0, toneHigh: 0.8, bandThreshold: 0.8, lowGain: 0 },
  talk: { label: "Talk", toneLow: -2.8, toneHigh: -0.8, bandThreshold: 1, lowGain: -0.4 },
};

/** Genre tag out of a metadata line — `[EDM]`, `genre=hiphop`, `#talk`. */
export function parseGenreTag(metadata: string): GenreId | null {
  const match = /(?:\[|genre\s*=\s*|#)\s*(pop|rock|hip-?hop|edm|acoustic|talk)\b/i.exec(metadata);
  if (!match) return null;
  const raw = match[1].toLowerCase().replace("-", "");
  return raw as GenreId;
}

const BANDS: {
  id: BandId;
  label: string;
  span: string;
  freq: number;
  type: BiquadFilterType;
  q: number;
}[] = [
  { id: "low", label: "LOW", span: "30–120 Hz", freq: 120, type: "lowpass", q: 0.707 },
  { id: "mid1", label: "MID1", span: "120–500 Hz", freq: 268, type: "bandpass", q: 0.56 },
  { id: "mid2", label: "MID2", span: "500 Hz–2 kHz", freq: 1095, type: "bandpass", q: 0.78 },
  { id: "mid3", label: "MID3", span: "2–6 kHz", freq: 3464, type: "bandpass", q: 0.87 },
  { id: "high", label: "HIGH", span: "6 kHz +", freq: 6000, type: "highpass", q: 0.707 },
];

function defaultBands(): Record<BandId, BandParams> {
  return {
    low: { thresholdDb: -24, ratio: 3.2, attackMs: 9, releaseMs: 180, gainDb: 1.5 },
    mid1: { thresholdDb: -26, ratio: 2.6, attackMs: 12, releaseMs: 220, gainDb: 0.8 },
    mid2: { thresholdDb: -25, ratio: 2.4, attackMs: 10, releaseMs: 190, gainDb: 0.5 },
    mid3: { thresholdDb: -23, ratio: 2.8, attackMs: 6, releaseMs: 140, gainDb: 0.9 },
    high: { thresholdDb: -21, ratio: 2.2, attackMs: 4, releaseMs: 110, gainDb: 1.2 },
  };
}

export const PRESET_A: Params = {
  inputGainDb: 0,
  toneLowDb: 0,
  toneHighDb: 0,
  declipOn: true,
  declipDriveDb: 4,
  declipThresholdDb: -6,
  declipMix: 55,
  agcThresholdDb: -26,
  agcRatio: 3,
  agcAttackMs: 12,
  agcReleaseMs: 280,
  agcMakeupDb: 4,
  subOn: true,
  subDrive: 32,
  subCutoff: 45,
  subHarmonics: 28,
  dynEq: 30,
  bands: defaultBands(),
  transientOn: true,
  transientAttackDb: 3,
  transientSensitivity: 55,
  hf: 30,
  width: 106,
  ceilingDb: -1,
  limiterReleaseMs: 120,
  outputGainDb: 0,
  speechOn: true,
  autoLoudness: true,
  target: -14,
  codec: "off",
  hfComp: true,
  duckOn: true,
  duckDepthDb: 6,
  duckReleaseMs: 250,
  duckMicOpen: false,
  duckAuto: true,
  genre: "auto",
  metadata: "",
  backupOn: true,
  talentMode: false,
};

export const PRESET_B: Params = {
  ...PRESET_A,
  toneLowDb: 1.5,
  toneHighDb: -1,
  declipDriveDb: 7,
  declipThresholdDb: -9,
  declipMix: 70,
  agcThresholdDb: -30,
  agcRatio: 4.5,
  agcAttackMs: 6,
  agcReleaseMs: 420,
  agcMakeupDb: 7,
  subDrive: 46,
  subCutoff: 38,
  subHarmonics: 45,
  dynEq: 45,
  bands: {
    low: { thresholdDb: -27, ratio: 4, attackMs: 7, releaseMs: 220, gainDb: 2.2 },
    mid1: { thresholdDb: -29, ratio: 3.4, attackMs: 9, releaseMs: 260, gainDb: 1.4 },
    mid2: { thresholdDb: -28, ratio: 3.2, attackMs: 8, releaseMs: 240, gainDb: 1.1 },
    mid3: { thresholdDb: -27, ratio: 3.6, attackMs: 5, releaseMs: 170, gainDb: 1.5 },
    high: { thresholdDb: -24, ratio: 2.8, attackMs: 3, releaseMs: 130, gainDb: 1.8 },
  },
  transientAttackDb: 4.5,
  transientSensitivity: 70,
  width: 88,
  ceilingDb: -1.5,
  limiterReleaseMs: 90,
  target: -16,
  codec: "mp3-128",
  duckDepthDb: 8,
  duckReleaseMs: 180,
  genre: "talk",
};

const PRESET_LIBRARY: { name: string; note: string; params: Params }[] = [
  { name: "AES71 Web", note: "-14 LUFS · 4 dB ceiling margin", params: PRESET_A },
  { name: "Podcast / Voice", note: "-16 LUFS · fast speech profile", params: PRESET_B },
  {
    name: "EBU R128",
    note: "-23 LUFS · broadcast delivery",
    params: {
      ...PRESET_A,
      target: -23,
      agcThresholdDb: -32,
      agcMakeupDb: 1,
      outputGainDb: -2,
      width: 100,
      hf: 20,
      transientAttackDb: 2,
    },
  },
];

/* ──────────────────────────────────────────────────────────────────────────
 * Helpers
 * ────────────────────────────────────────────────────────────────────────── */

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const dbToGain = (db: number) => (db <= -120 ? 0 : Math.pow(10, db / 20));
const gainToDb = (g: number) => (g <= 1e-7 ? -120 : 20 * Math.log10(g));
const round = (v: number, d = 1) => Number(v.toFixed(d));

export function morphParams(a: Params, b: Params, t: number): Params {
  const n = (x: number, y: number) => round(lerp(x, y, t), 2);
  const bands = {} as Record<BandId, BandParams>;
  for (const band of BANDS) {
    const x = a.bands[band.id];
    const y = b.bands[band.id];
    bands[band.id] = {
      thresholdDb: n(x.thresholdDb, y.thresholdDb),
      ratio: n(x.ratio, y.ratio),
      attackMs: n(x.attackMs, y.attackMs),
      releaseMs: n(x.releaseMs, y.releaseMs),
      gainDb: n(x.gainDb, y.gainDb),
    };
  }
  return {
    inputGainDb: n(a.inputGainDb, b.inputGainDb),
    toneLowDb: n(a.toneLowDb, b.toneLowDb),
    toneHighDb: n(a.toneHighDb, b.toneHighDb),
    declipOn: t < 0.5 ? a.declipOn : b.declipOn,
    declipDriveDb: n(a.declipDriveDb, b.declipDriveDb),
    declipThresholdDb: n(a.declipThresholdDb, b.declipThresholdDb),
    declipMix: n(a.declipMix, b.declipMix),
    agcThresholdDb: n(a.agcThresholdDb, b.agcThresholdDb),
    agcRatio: n(a.agcRatio, b.agcRatio),
    agcAttackMs: n(a.agcAttackMs, b.agcAttackMs),
    agcReleaseMs: n(a.agcReleaseMs, b.agcReleaseMs),
    agcMakeupDb: n(a.agcMakeupDb, b.agcMakeupDb),
    subOn: t < 0.5 ? a.subOn : b.subOn,
    subDrive: n(a.subDrive, b.subDrive),
    subCutoff: n(a.subCutoff, b.subCutoff),
    subHarmonics: n(a.subHarmonics, b.subHarmonics),
    dynEq: n(a.dynEq, b.dynEq),
    bands,
    transientOn: t < 0.5 ? a.transientOn : b.transientOn,
    transientAttackDb: n(a.transientAttackDb, b.transientAttackDb),
    transientSensitivity: n(a.transientSensitivity, b.transientSensitivity),
    hf: n(a.hf, b.hf),
    width: n(a.width, b.width),
    ceilingDb: n(a.ceilingDb, b.ceilingDb),
    limiterReleaseMs: n(a.limiterReleaseMs, b.limiterReleaseMs),
    outputGainDb: n(a.outputGainDb, b.outputGainDb),
    speechOn: t < 0.5 ? a.speechOn : b.speechOn,
    autoLoudness: a.autoLoudness,
    target: t < 0.5 ? a.target : b.target,
    codec: t < 0.5 ? a.codec : b.codec,
    hfComp: t < 0.5 ? a.hfComp : b.hfComp,
    duckOn: t < 0.5 ? a.duckOn : b.duckOn,
    duckDepthDb: n(a.duckDepthDb, b.duckDepthDb),
    duckReleaseMs: n(a.duckReleaseMs, b.duckReleaseMs),
    duckMicOpen: t < 0.5 ? a.duckMicOpen : b.duckMicOpen,
    duckAuto: t < 0.5 ? a.duckAuto : b.duckAuto,
    genre: t < 0.5 ? a.genre : b.genre,
    metadata: a.metadata,
    backupOn: t < 0.5 ? a.backupOn : b.backupOn,
    talentMode: t < 0.5 ? a.talentMode : b.talentMode,
  };
}

const STORAGE_KEY = "signalpath.studio.v1";

function loadParams(): Params {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return PRESET_A;
    const parsed = JSON.parse(raw) as Partial<Params>;
    return {
      ...PRESET_A,
      ...parsed,
      bands: { ...PRESET_A.bands, ...(parsed.bands ?? {}) },
    };
  } catch {
    return PRESET_A;
  }
}

/* ──────────────────────────────────────────────────────────────────────────
 * Demo program — an 8-second stereo loop with kick, snare, hats, bass, pad.
 * It gives the meters real dynamics, real transients and a wide stereo image.
 * ────────────────────────────────────────────────────────────────────────── */

function buildDemo(ctx: AudioContext): AudioBuffer {
  const sr = ctx.sampleRate;
  const secs = 8;
  const len = Math.floor(sr * secs);
  const buffer = ctx.createBuffer(2, len, sr);
  const L = buffer.getChannelData(0);
  const R = buffer.getChannelData(1);

  const add = (start: number, dur: number, pan: number, fn: (t: number) => number) => {
    const i0 = Math.max(0, Math.floor(start * sr));
    const n = Math.min(Math.floor(dur * sr), len - i0);
    const gl = Math.cos(((pan + 1) * Math.PI) / 4);
    const gr = Math.sin(((pan + 1) * Math.PI) / 4);
    for (let i = 0; i < n; i++) {
      const v = fn(i / sr);
      L[i0 + i] += v * gl;
      R[i0 + i] += v * gr;
    }
  };

  let seed = 0x9e3779b9;
  const noise = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return (seed / 0xffffffff) * 2 - 1;
  };

  const step = 0.15; // 16th at 100 BPM
  const notes = [55, 55, 65.41, 49, 58.27, 73.42, 65.41, 43.65];

  for (let s = 0; s < 54; s++) {
    const t = s * step;
    if (s % 4 === 0) {
      // kick: pitch drop 120 → 45 Hz with a fast body envelope
      let phase = 0;
      add(t, 0.38, 0, (x) => {
        const f = 45 + 75 * Math.exp(-x * 28);
        phase += (2 * Math.PI * f) / sr;
        return Math.sin(phase) * Math.exp(-x * 7.5) * 0.9;
      });
    }
    if (s % 8 === 4) {
      // snare: noise body plus a 185 Hz shell tone
      add(t, 0.2, 0.05, (x) => {
        const env = Math.exp(-x * 22);
        return (noise() * 0.5 + Math.sin(2 * Math.PI * 185 * x) * 0.25) * env * 0.62;
      });
    }
    if (s % 2 === 0) {
      // hat: differentiated noise (a cheap high-pass), tighter on the offbeat
      let prev = 0;
      add(t + 0.02, 0.05, -0.25, (x) => {
        const n = noise();
        const hp = n - prev;
        prev = n;
        return hp * Math.exp(-x * 70) * 0.16;
      });
    }
    if (s % 4 === 2) {
      const f = notes[(s >> 1) % notes.length];
      add(t, 0.44, -0.05, (x) => {
        const env = Math.min(1, x * 180) * Math.exp(-x * 4.5);
        return (
          (Math.sin(2 * Math.PI * f * x) * 0.6 +
            Math.sin(2 * Math.PI * f * 2 * x) * 0.18) *
          env *
          0.5
        );
      });
    }
  }

  // wide pad: three voices, deliberately decorrelated between the legs
  const chord = [220, 261.63, 329.63, 392];
  for (let i = 0; i < len; i++) {
    const t = i / sr;
    let l = 0;
    let r = 0;
    for (let k = 0; k < chord.length; k++) {
      const f = chord[k] * (k === 3 ? 1.003 : 1);
      const drift = 1 + 0.0016 * Math.sin(2 * Math.PI * (0.17 + k * 0.05) * t);
      l += Math.sin(2 * Math.PI * f * drift * t + k * 0.9);
      r += Math.sin(2 * Math.PI * f * drift * t + k * 0.9 + 0.55 + k * 0.12);
    }
    const swell = 0.5 + 0.5 * Math.sin(2 * Math.PI * 0.125 * t - Math.PI / 2);
    L[i] += l * 0.016 * (0.55 + swell * 0.45);
    R[i] += r * 0.016 * (0.55 + swell * 0.45);
  }

  // normalise with headroom
  let peak = 0;
  for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  const scale = peak > 0 ? 0.82 / peak : 1;
  for (let i = 0; i < len; i++) {
    L[i] *= scale;
    R[i] *= scale;
  }
  return buffer;
}

/** Standby loop: a slow ambient bed, deliberately unlike the demo programme. */
function buildBackup(ctx: AudioContext): AudioBuffer {
  const sr = ctx.sampleRate;
  const len = Math.floor(sr * 8);
  const buffer = ctx.createBuffer(2, len, sr);
  const L = buffer.getChannelData(0);
  const R = buffer.getChannelData(1);
  const chord = [110, 138.59, 164.81, 220];
  for (let i = 0; i < len; i++) {
    const t = i / sr;
    const swell = 0.55 + 0.45 * Math.sin(2 * Math.PI * 0.08 * t - Math.PI / 2);
    let l = 0;
    let r = 0;
    for (let k = 0; k < chord.length; k++) {
      const f = chord[k];
      l += Math.sin(2 * Math.PI * f * t + k * 0.7);
      r += Math.sin(2 * Math.PI * f * t + k * 0.7 + 0.45);
    }
    const pulse = Math.exp(-((t % 1) * 7)) * Math.sin(2 * Math.PI * 55 * t) * 0.22;
    L[i] = (l * 0.035 * swell + pulse) * 0.9;
    R[i] = (r * 0.035 * swell + pulse) * 0.9;
  }
  let peak = 0;
  for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  const scale = peak > 0 ? 0.6 / peak : 1;
  for (let i = 0; i < len; i++) {
    L[i] *= scale;
    R[i] *= scale;
  }
  return buffer;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Frame
 * ────────────────────────────────────────────────────────────────────────── */

interface Frame {
  inputL: number;
  inputR: number;
  outL: number;
  outR: number;
  truePeak: number;
  agcGr: number;
  limiterGr: number;
  bandGr: number[];
  hf: number;
  stereo: number;
  correlation: number;
  momentary: number;
  shortTerm: number;
  integrated: number;
  silenceMs: number;
  speech: boolean;
  normDb: number;
  duckDb: number;
  backup: boolean;
  genre: string;
  talent: boolean;
  codec: string;
}

const EMPTY_FRAME: Frame = {
  inputL: -120,
  inputR: -120,
  outL: -120,
  outR: -120,
  truePeak: -120,
  agcGr: 0,
  limiterGr: 0,
  bandGr: [0, 0, 0, 0, 0],
  hf: 0,
  stereo: 0,
  correlation: 1,
  momentary: -70,
  shortTerm: -70,
  integrated: -70,
  silenceMs: 0,
  speech: false,
  normDb: 0,
  duckDb: 0,
  backup: false,
  genre: "—",
  talent: false,
  codec: "off",
};

interface LufsPoint {
  t: number;
  m: number;
  s: number;
  i: number;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Engine
 * ────────────────────────────────────────────────────────────────────────── */

export class StudioEngine {
  readonly ctx: AudioContext;
  frame: Frame = { ...EMPTY_FRAME };
  history: LufsPoint[] = [];
  sourceMode: SourceMode = "demo";
  target = -14;
  private timer: number | null = null;
  private tickCount = 0;

  // graph
  private srcGain: GainNode;
  private pre: GainNode;
  private toneLow: BiquadFilterNode;
  private toneHigh: BiquadFilterNode;
  private declipIn: GainNode;
  private declipDry: GainNode;
  private declipWet: GainNode;
  private shaper: WaveShaperNode;
  private declipOut: GainNode;
  private agc: DynamicsCompressorNode;
  private agcMakeup: GainNode;
  private subGate: GainNode;
  private subOsc: OscillatorNode;
  private subHarm: OscillatorNode;
  private subHarmGain: GainNode;
  private subCutoffFilter: BiquadFilterNode;
  private subMix: GainNode;
  private dynLow: BiquadFilterNode;
  private dynMid: BiquadFilterNode;
  private dynHigh: BiquadFilterNode;
  private bandComp: DynamicsCompressorNode[] = [];
  private bandGain: GainNode[] = [];
  private bandLaneGain: GainNode[] = [];
  private mbSum: GainNode;
  private transGain: GainNode;
  private transSum: GainNode;
  private side: GainNode;
  private hfShelf: BiquadFilterNode;
  private normGain: GainNode;
  private outGain: GainNode;
  private limiter: DynamicsCompressorNode;
  // voice-duck sidechain (low-mid shelf + bus trim)
  private duckShelf: BiquadFilterNode;
  private duckGain: GainNode;
  // talent monitor / on-air paths
  private mainPath: GainNode;
  private talentPath: GainNode;
  private talentShaper: WaveShaperNode;
  private monitorMerge: GainNode;
  // codec preview insert
  private codecHp: BiquadFilterNode;
  private codecLp: BiquadFilterNode;
  private codecComb: DelayNode;
  private codecCombGain: GainNode;
  private codecSum: GainNode;
  private codecBypass: GainNode;
  private codecOut: GainNode;
  // silence backup source
  private backupGain: GainNode;
  private backupSrc: AudioBufferSourceNode | null = null;
  private backupBuffer: AudioBuffer | null = null;
  private backupActive = false;
  private backupHealthyMs = 0;
  /** Silence needed before the backup source takes over (ms). */
  backupHoldMs = 5000;
  /** Healthy program needed before the backup is released (ms). */
  backupReturnMs = 2000;

  // analysers
  private inL: AnalyserNode;
  private inR: AnalyserNode;
  private outL: AnalyserNode;
  private outR: AnalyserNode;
  private scopeL: AnalyserNode;
  private scopeR: AnalyserNode;
  private kL: AnalyserNode;
  private kR: AnalyserNode;
  private hfAn: AnalyserNode;
  private mbAn: AnalyserNode;
  private voiceAn: AnalyserNode;
  private lowAn: AnalyserNode;
  private dynAn: AnalyserNode[] = [];

  // scratch
  private bufL = new Float32Array(2048);
  private bufR = new Float32Array(2048);
  private bufK = new Float32Array(2048);
  /** Program fade — the backup crossfades against this, not the source bus. */
  private programFade: GainNode;
  private bufS = new Float32Array(1024);
  private pitchBuf = new Float32Array(2048);
  private scopeBufL = new Float32Array(2048);
  private scopeBufR = new Float32Array(2048);

  // control state
  private blocks: { t: number; p: number }[] = [];
  private integratedPowers: number[] = [];
  private silentSince = 0;
  private speechHold = 0;
  private speechQuiet = 0;
  private speech = false;
  private normDb = 0;
  private transSlow = 0;
  private transEnv = 0;
  private subPitch = 45;
  private appliedAttack = 0;
  private appliedRelease = 0;
  private lastBandAttack = 0;
  private lastBandRelease = 0;
  private demo: AudioBufferSourceNode | null = null;
  private micNode: MediaStreamAudioSourceNode | null = null;
  private micStream: MediaStream | null = null;
  private demoBuffer: AudioBuffer | null = null;

  constructor(context?: AudioContext) {
    const ctx = context ?? new AudioContext({ latencyHint: "interactive" });
    this.ctx = ctx;
    const now = ctx.currentTime;

    const gain = (v = 1) => {
      const n = ctx.createGain();
      n.gain.value = v;
      return n;
    };
    const an = (fft = 2048) => {
      const n = ctx.createAnalyser();
      n.fftSize = fft;
      n.smoothingTimeConstant = 0.2;
      return n;
    };
    const filt = (type: BiquadFilterType, freq: number, q = 0.707) => {
      const n = ctx.createBiquadFilter();
      n.type = type;
      n.frequency.value = freq;
      n.Q.value = q;
      return n;
    };

    this.srcGain = gain(1);
    this.programFade = gain(1);
    this.pre = gain(1);
    this.srcGain.connect(this.programFade);
    this.programFade.connect(this.pre);

    // INPUT meters (post preamp trim, pre processing). They sit on the source
    // bus ahead of the backup crossfade, so the silence gate keeps hearing the
    // real program even while the standby is on air.
    const inSplit = ctx.createChannelSplitter(2);
    this.inL = an();
    this.inR = an();
    this.srcGain.connect(inSplit);
    inSplit.connect(this.inL, 0);
    inSplit.connect(this.inR, 1);

    // PREAMP tone
    this.toneLow = filt("lowshelf", 110);
    this.toneHigh = filt("highshelf", 7500);
    this.pre.connect(this.toneLow);
    this.toneLow.connect(this.toneHigh);

    // DE-CLIPPER (dry/wet wave-shaper)
    this.declipIn = gain(1);
    this.declipDry = gain(0.5);
    this.declipWet = gain(0.5);
    this.declipOut = gain(1);
    this.shaper = ctx.createWaveShaper();
    this.shaper.oversample = "4x";
    this.toneHigh.connect(this.declipIn);
    this.declipIn.connect(this.declipDry);
    this.declipDry.connect(this.declipOut);
    this.declipIn.connect(this.shaper);
    this.shaper.connect(this.declipWet);
    this.declipWet.connect(this.declipOut);

    // AGC (macro leveler, ahead of everything spectral)
    this.agc = ctx.createDynamicsCompressor();
    this.agc.knee.value = 8;
    this.agcMakeup = gain(1);
    this.declipOut.connect(this.agc);
    this.agc.connect(this.agcMakeup);

    // SUB-HARMONIC (parallel to the AGC output)
    this.subMix = gain(1);
    this.subGate = gain(0);
    this.subOsc = ctx.createOscillator();
    this.subOsc.type = "sine";
    this.subOsc.frequency.value = 45;
    this.subHarm = ctx.createOscillator();
    this.subHarm.type = "triangle";
    this.subHarm.frequency.value = 90;
    this.subCutoffFilter = filt("lowpass", 320, 0.6);
    this.subHarmGain = gain(0);
    this.subOsc.connect(this.subGate);
    this.subGate.connect(this.subMix);
    this.subHarm.connect(this.subCutoffFilter);
    this.subCutoffFilter.connect(this.subHarmGain);
    this.subHarmGain.connect(this.subMix);
    this.agcMakeup.connect(this.subMix);
    this.subOsc.start(now);
    this.subHarm.start(now);

    // DYN-EQ (3 subtractive bands)
    this.dynLow = filt("peaking", 120, 1);
    this.dynMid = filt("peaking", 900, 1);
    this.dynHigh = filt("peaking", 5000, 1);
    // voice-duck sidechain: a low-mid shelf and a bus trim, driven by the
    // DJ-mic detection, sit between the AGC and the band split
    this.duckShelf = filt("lowshelf", 260);
    this.duckGain = gain(1);
    this.subMix.connect(this.duckShelf);
    this.duckShelf.connect(this.duckGain);
    this.duckGain.connect(this.dynLow);
    this.dynLow.connect(this.dynMid);
    this.dynMid.connect(this.dynHigh);

    // MULTIBAND — five parallel lanes into one summing bus
    this.mbSum = gain(1);
    for (const band of BANDS) {
      const f = filt(band.type, band.freq, band.q);
      const comp = ctx.createDynamicsCompressor();
      comp.knee.value = 6;
      comp.ratio.value = 2.5;
      comp.attack.value = 0.01;
      comp.release.value = 0.2;
      comp.threshold.value = -25;
      const makeup = gain(1);
      const lane = gain(1);
      this.dynHigh.connect(f);
      f.connect(comp);
      comp.connect(makeup);
      makeup.connect(lane);
      lane.connect(this.mbSum);
      this.bandComp.push(comp);
      this.bandGain.push(makeup);
      this.bandLaneGain.push(lane);
    }
    // high band activity + transient detector taps
    this.hfAn = an();
    this.bandLaneGain[4].connect(this.hfAn);
    this.mbAn = an();
    this.mbSum.connect(this.mbAn);

    // TRANSIENT SNAP (parallel high band, envelope driven)
    this.transGain = gain(0);
    this.transSum = gain(1);
    const hp = filt("highpass", 3000, 0.707);
    this.mbSum.connect(this.transSum);
    this.mbSum.connect(hp);
    hp.connect(this.transGain);
    this.transGain.connect(this.transSum);

    // STEREO WIDTH (M/S)
    const split = ctx.createChannelSplitter(2);
    const mid = gain(0.5);
    const sidePos = gain(0.5);
    const sideNeg = gain(-0.5);
    this.side = gain(1);
    const merger = ctx.createChannelMerger(2);
    const mL = gain(1);
    const mR = gain(1);
    const inv = gain(-1);
    this.transSum.connect(split);
    split.connect(mid, 0);
    split.connect(mid, 1);
    split.connect(sidePos, 0);
    split.connect(sideNeg, 1);
    sidePos.connect(this.side);
    sideNeg.connect(this.side);
    mid.connect(mL);
    this.side.connect(mL);
    mid.connect(mR);
    this.side.connect(inv);
    inv.connect(mR);
    mL.connect(merger, 0, 0);
    mR.connect(merger, 0, 1);

    // HF enhancer, loudness servo, output trim
    this.hfShelf = filt("highshelf", 8500);
    this.normGain = gain(1);
    this.outGain = gain(1);
    merger.connect(this.hfShelf);
    this.hfShelf.connect(this.normGain);
    this.normGain.connect(this.outGain);

    // standby source joins the chain ahead of the preamp
    this.backupGain = gain(0);
    this.backupGain.connect(this.pre);

    // LIMITER (final ceiling, then the device)
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -1;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.001;
    this.limiter.release.value = 0.12;
    this.outGain.connect(this.limiter);

    // two monitor paths: the on-air chain (through the limiter) and the
    // talent feed, which skips the limiter's look-ahead entirely
    this.mainPath = gain(1);
    this.talentPath = gain(0);
    this.talentShaper = ctx.createWaveShaper();
    this.talentShaper.oversample = "none";
    this.talentShaper.curve = softClipCurve(1.1);
    this.monitorMerge = gain(1);
    this.limiter.connect(this.mainPath);
    this.mainPath.connect(this.monitorMerge);
    this.outGain.connect(this.talentShaper);
    this.talentShaper.connect(this.talentPath);
    this.talentPath.connect(this.monitorMerge);

    // codec preview insert — band-limit plus a short pre-echo comb
    this.codecHp = filt("highpass", 28, 0.707);
    this.codecLp = filt("lowpass", 20000, 0.707);
    this.codecComb = ctx.createDelay(0.05);
    this.codecComb.delayTime.value = 0.0032;
    this.codecCombGain = gain(0);
    this.codecSum = gain(0);
    this.codecBypass = gain(1);
    this.codecOut = gain(1);
    this.monitorMerge.connect(this.codecBypass);
    this.codecBypass.connect(this.codecOut);
    this.monitorMerge.connect(this.codecHp);
    this.codecHp.connect(this.codecLp);
    this.codecLp.connect(this.codecSum);
    this.codecLp.connect(this.codecComb);
    this.codecComb.connect(this.codecCombGain);
    this.codecCombGain.connect(this.codecSum);
    this.codecSum.connect(this.codecOut);
    this.codecOut.connect(ctx.destination);

    // OUTPUT taps follow the selected monitor path
    const outSplit = ctx.createChannelSplitter(2);
    this.monitorMerge.connect(outSplit);
    this.outL = an();
    this.outR = an();
    this.scopeL = an(2048);
    this.scopeR = an(2048);
    outSplit.connect(this.outL, 0);
    outSplit.connect(this.outR, 1);
    outSplit.connect(this.scopeL, 0);
    outSplit.connect(this.scopeR, 1);

    // K-weighted loudness taps
    const kShelfL = filt("highshelf", 1681, 0.707);
    kShelfL.gain.value = 4;
    const kShelfR = filt("highshelf", 1681, 0.707);
    kShelfR.gain.value = 4;
    const kHpL = filt("highpass", 38, 0.5);
    const kHpR = filt("highpass", 38, 0.5);
    this.kL = an();
    this.kR = an();
    outSplit.connect(kShelfL, 0);
    outSplit.connect(kShelfR, 1);
    kShelfL.connect(kHpL);
    kShelfR.connect(kHpR);
    kHpL.connect(this.kL);
    kHpR.connect(this.kR);

    // speech detector — voice band and a low band for the sub gate
    const vHp = filt("highpass", 280, 0.707);
    const vLp = filt("lowpass", 3400, 0.707);
    this.srcGain.connect(vHp);
    vHp.connect(vLp);
    this.voiceAn = an();
    vLp.connect(this.voiceAn);
    const lowLp = filt("lowpass", 180, 0.707);
    this.srcGain.connect(lowLp);
    this.lowAn = an();
    lowLp.connect(this.lowAn);

    // dynamic-EQ band detectors
    for (const f of [120, 900, 5000]) {
      const bp = filt("bandpass", f, 1);
      const a = an(1024);
      this.declipOut.connect(bp);
      bp.connect(a);
      this.dynAn.push(a);
    }

    this.subOsc.frequency.setTargetAtTime(45, now, 0.1);
    this.subHarm.frequency.setTargetAtTime(90, now, 0.1);
  }

  /* ── lifecycle ──────────────────────────────────────────────────────── */

  async start(mode: SourceMode): Promise<void> {
    await this.ctx.resume();
    await this.setSource(mode);
    if (this.timer === null) {
      this.timer = setInterval(() => this.tick(), 100) as unknown as number;
    }
  }

  async setSource(mode: SourceMode): Promise<void> {
    this.stopSource();
    this.sourceMode = mode;
    if (mode === "demo") {
      if (!this.demoBuffer) this.demoBuffer = buildDemo(this.ctx);
      const src = this.ctx.createBufferSource();
      src.buffer = this.demoBuffer;
      src.loop = true;
      src.connect(this.srcGain);
      src.start();
      this.demo = src;
      return;
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    this.micStream = stream;
    const node = this.ctx.createMediaStreamSource(stream);
    node.connect(this.srcGain);
    this.micNode = node;
  }

  /** Standby loop takes over the chain after a long silence. */
  private enterBackup(): void {
    if (!this.backupBuffer) this.backupBuffer = buildBackup(this.ctx);
    const src = this.ctx.createBufferSource();
    src.buffer = this.backupBuffer;
    src.loop = true;
    src.connect(this.backupGain);
    src.start();
    this.backupSrc = src;
    this.backupActive = true;
    this.backupHealthyMs = 0;
    const now = this.ctx.currentTime;
    this.programFade.gain.setTargetAtTime(0, now, 0.08);
    this.backupGain.gain.setTargetAtTime(1, now, 0.08);
  }

  /** Programme is healthy again — hand the chain back. */
  private leaveBackup(): void {
    const now = this.ctx.currentTime;
    this.programFade.gain.setTargetAtTime(1, now, 0.08);
    this.backupGain.gain.setTargetAtTime(0, now, 0.08);
    this.backupActive = false;
    this.backupHealthyMs = 0;
    const src = this.backupSrc;
    this.backupSrc = null;
    if (src) {
      setTimeout(() => {
        try {
          src.stop();
        } catch {
          /* already stopped */
        }
        src.disconnect();
      }, 400);
    }
  }

  private stopSource(): void {
    try {
      this.demo?.stop();
    } catch {
      /* already stopped */
    }
    this.demo?.disconnect();
    this.demo = null;
    this.micNode?.disconnect();
    this.micNode = null;
    if (this.micStream) {
      for (const track of this.micStream.getTracks()) track.stop();
      this.micStream = null;
    }
  }

  suspend(): void {
    void this.ctx.suspend();
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One measurement pass without waiting for the 100 ms timer (testing seam). */
  tickNow(): void {
    this.tick();
  }

  dispose(): void {
    this.stopSource();
    if (this.backupSrc) {
      try {
        this.backupSrc.stop();
      } catch {
        /* already stopped */
      }
      this.backupSrc.disconnect();
      this.backupSrc = null;
    }
    this.suspend();
    void this.ctx.close();
  }

  /* ── parameters ─────────────────────────────────────────────────────── */

  apply(p: Params): void {
    const now = this.ctx.currentTime;
    this.target = p.target;
    const genre = this.genreActive ? GENRE_PROFILES[this.genreActive] : null;
    const trim =
      this.hfComp && this.codecId !== "off"
        ? CODEC_PROFILES[this.codecId].hfTrimDb
        : 0;
    this.pre.gain.setTargetAtTime(dbToGain(p.inputGainDb), now, 0.02);
    this.toneLow.gain.setTargetAtTime(p.toneLowDb + (genre?.toneLow ?? 0), now, 0.03);
    this.toneHigh.gain.setTargetAtTime(p.toneHighDb + (genre?.toneHigh ?? 0), now, 0.03);

    // de-clipper: soft-knee peak reconstruction above the threshold
    const mix = clamp(p.declipMix / 100, 0, 1);
    this.declipWet.gain.setTargetAtTime(p.declipOn ? mix : 0, now, 0.02);
    this.declipDry.gain.setTargetAtTime(p.declipOn ? 1 - mix : 1, now, 0.02);
    this.shaper.curve = declipCurve(p.declipDriveDb, p.declipThresholdDb);

    this.agc.threshold.setTargetAtTime(p.agcThresholdDb, now, 0.03);
    this.agc.ratio.setTargetAtTime(clamp(p.agcRatio, 1, 20), now, 0.03);
    this.agcMakeup.gain.setTargetAtTime(dbToGain(p.agcMakeupDb), now, 0.03);
    this.appliedAttack = p.agcAttackMs;
    this.appliedRelease = p.agcReleaseMs;
    this.agc.attack.setTargetAtTime(Math.max(p.agcAttackMs, 0.5) / 1000, now, 0.02);
    this.agc.release.setTargetAtTime(Math.max(p.agcReleaseMs, 20) / 1000, now, 0.02);

    // sub
    const subLevel = p.subOn ? (p.subDrive / 100) * 0.55 : 0;
    this.subGate.gain.setTargetAtTime(subLevel, now, 0.06);
    this.subOsc.frequency.setTargetAtTime(clamp(p.subCutoff, 30, 60), now, 0.08);
    this.subHarmGain.gain.setTargetAtTime(
      p.subOn ? (p.subHarmonics / 100) * 0.35 : 0,
      now,
      0.06,
    );
    this.lastBandAttack = p.bands.low.attackMs;
    this.lastBandRelease = p.bands.low.releaseMs;

    // dynamic EQ amount is applied in the tick from the band detectors
    // (the filters themselves carry the current cut)

    // multiband
    BANDS.forEach((band, i) => {
      const b = p.bands[band.id];
      const comp = this.bandComp[i];
      // genre profile shifts the whole split; HF compensation leans harder on
      // the top band so low-bitrate encoders get less pre-echo to chew on
      const threshold =
        b.thresholdDb +
        (genre?.bandThreshold ?? 0) -
        (band.id === "high" ? trim : 0);
      const release = b.releaseMs * (band.id === "high" && trim > 0 ? 0.75 : 1);
      comp.threshold.setTargetAtTime(threshold, now, 0.03);
      comp.ratio.setTargetAtTime(clamp(b.ratio, 1, 20), now, 0.03);
      comp.attack.setTargetAtTime(Math.max(b.attackMs, 0.5) / 1000, now, 0.02);
      comp.release.setTargetAtTime(Math.max(release, 20) / 1000, now, 0.02);
      const makeup = b.gainDb + (band.id === "low" ? (genre?.lowGain ?? 0) : 0);
      this.bandGain[i].gain.setTargetAtTime(dbToGain(makeup), now, 0.03);
    });

    if (!p.transientOn) this.transGain.gain.setTargetAtTime(0, now, 0.02);
    this.side.gain.setTargetAtTime(clamp(p.width / 100, 0, 2), now, 0.04);
    this.hfShelf.gain.setTargetAtTime(p.hf * 0.12 - trim * 0.6, now, 0.03);
    this.limiter.threshold.setTargetAtTime(p.ceilingDb, now, 0.03);
    this.limiter.release.setTargetAtTime(Math.max(p.limiterReleaseMs, 20) / 1000, now, 0.03);
    this.outGain.gain.setTargetAtTime(dbToGain(p.outputGainDb), now, 0.03);
    this.normGain.gain.setTargetAtTime(dbToGain(this.normDb), now, 0.25);

    // codec preview: band-limit + short pre-echo comb, crossfaded in
    const profile = CODEC_PROFILES[p.codec];
    const preview = p.codec !== "off";
    this.codecLp.frequency.setTargetAtTime(profile.lowpass, now, 0.03);
    this.codecCombGain.gain.setTargetAtTime(preview ? profile.comb * 0.55 : 0, now, 0.03);
    this.codecBypass.gain.setTargetAtTime(preview ? 0 : 1, now, 0.02);
    this.codecSum.gain.setTargetAtTime(preview ? 1 : 0, now, 0.02);

    // talent feed bypasses the limiter's look-ahead
    this.mainPath.gain.setTargetAtTime(p.talentMode ? 0 : 1, now, 0.02);
    this.talentPath.gain.setTargetAtTime(p.talentMode ? 1 : 0, now, 0.02);

    this.frame.codec = p.codec;
    this.frame.genre = genre?.label ?? "—";
    this.frame.talent = p.talentMode;
  }

  /* ── measurement ────────────────────────────────────────────────────── */

  private tick(): void {
    const f = this.frame;
    const now = performance.now();
    this.tickCount += 1;

    this.inL.getFloatTimeDomainData(this.bufL);
    this.inR.getFloatTimeDomainData(this.bufR);
    const inL = peak(this.bufL);
    const inR = peak(this.bufR);
    const inRms = Math.max(rms(this.bufL), rms(this.bufR));
    f.inputL = gainToDb(inL);
    f.inputR = gainToDb(inR);

    this.outL.getFloatTimeDomainData(this.bufL);
    this.outR.getFloatTimeDomainData(this.bufR);
    f.outL = gainToDb(peak(this.bufL));
    f.outR = gainToDb(peak(this.bufR));
    f.truePeak = gainToDb(truePeak(this.bufL, this.bufR));
    f.correlation = correlation(this.bufL, this.bufR);

    let sideE = 0;
    let totalE = 0;
    for (let i = 0; i < this.bufL.length; i++) {
      const d = (this.bufL[i] - this.bufR[i]) * 0.5;
      sideE += d * d;
      totalE += this.bufL[i] * this.bufL[i] + this.bufR[i] * this.bufR[i];
    }
    f.stereo = totalE > 1e-12 ? clamp((sideE * 4) / totalE, 0, 1) * 100 : 0;

    f.agcGr = Math.max(0, -(this.agc.reduction || 0));
    f.limiterGr = Math.max(0, -(this.limiter.reduction || 0));
    f.bandGr = this.bandComp.map((c) => Math.max(0, -(c.reduction || 0)));

    this.hfAn.getFloatTimeDomainData(this.bufS);
    f.hf = clamp(((gainToDb(rms(this.bufS)) + 60) / 60) * 100, 0, 100);

    // loudness blocks (K-weighted, 400 ms momentary / 3 s short-term)
    this.kL.getFloatTimeDomainData(this.bufK);
    const pl = meanSquare(this.bufK);
    this.kR.getFloatTimeDomainData(this.bufK);
    const pr = meanSquare(this.bufK);
    const power = pl + pr;
    if (power > 1e-12) {
      this.blocks.push({ t: now, p: power });
      if (this.integratedPowers.length < 4000) this.integratedPowers.push(power);
    }
    while (this.blocks.length > 0 && now - this.blocks[0].t > 3200) this.blocks.shift();

    const windowPower = (ms: number) => {
      let sum = 0;
      let n = 0;
      for (let i = this.blocks.length - 1; i >= 0; i--) {
        if (now - this.blocks[i].t > ms) break;
        sum += this.blocks[i].p;
        n += 1;
      }
      return n > 0 ? sum / n : 0;
    };
    const m = windowPower(400);
    const s = windowPower(3000);
    f.momentary = m > 1e-12 ? -0.691 + 10 * Math.log10(m) : -70;
    f.shortTerm = s > 1e-12 ? -0.691 + 10 * Math.log10(s) : -70;

    if (this.tickCount % 10 === 0) {
      f.integrated = gatedLoudness(this.integratedPowers);
      this.history.push({
        t: now,
        m: f.momentary,
        s: f.shortTerm,
        i: f.integrated,
      });
      if (this.history.length > 120) this.history.shift();
    }

    // silence gate: program below -55 dBFS for 3 s
    if (gainToDb(Math.max(inL, inR)) < -55) {
      if (this.silentSince === 0) this.silentSince = now;
    } else {
      this.silentSince = 0;
    }
    f.silenceMs = this.silentSince === 0 ? 0 : now - this.silentSince;

    // silence backup: after the hold the standby loop takes the chain, and it
    // releases only after the program has been healthy for the return window
    if (this.backupOn && !this.backupActive && f.silenceMs >= this.backupHoldMs) {
      this.enterBackup();
    }
    if (this.backupActive) {
      this.backupHealthyMs = f.silenceMs === 0 ? this.backupHealthyMs + 100 : 0;
      if (this.backupHealthyMs >= this.backupReturnMs) this.leaveBackup();
    }
    f.backup = this.backupActive;

    // speech detection from voice-band energy ratio
    this.voiceAn.getFloatTimeDomainData(this.bufS);
    const voice = rms(this.bufS);
    const broad = Math.max(inRms, 1e-6);
    if (voice / broad > 0.52) {
      this.speechHold += 100;
      this.speechQuiet = 0;
    } else {
      this.speechHold = 0;
      this.speechQuiet += 100;
    }
    if (!this.speech && this.speechHold >= 300) this.speech = true;
    if (this.speech && this.speechQuiet >= 1500) this.speech = false;
    f.speech = this.speech;

    // voice ducking: the DJ mic (manual switch, or the voice detector on the
    // demo program) pulls the bed down and the low-mid shelf with it
    const wantDuck =
      this.duckOn &&
      (this.duckMicOpen || (this.duckAuto && this.speech && this.sourceMode === "demo"))
        ? this.duckDepthDb
        : 0;
    this.duckDb = wantDuck;
    this.duckGain.gain.setTargetAtTime(dbToGain(-wantDuck * 0.5), now, 0.06);
    this.duckShelf.gain.setTargetAtTime(-wantDuck * 0.8, now, 0.08);
    f.duckDb = wantDuck;

    // dynamic EQ — cut where a detector band is hot
    const amounts = [0, 1, 2].map((i) => {
      this.dynAn[i].getFloatTimeDomainData(this.bufS);
      return gainToDb(rms(this.bufS));
    });
    const cut = (db: number) => {
      if (db < -34) return 0;
      return clamp((db + 34) * 0.35, 0, 6);
    };
    this.dynLow.gain.setTargetAtTime(-cut(amounts[0]) * this.dynEqScale, now, 0.1);
    this.dynMid.gain.setTargetAtTime(-cut(amounts[1]) * this.dynEqScale, now, 0.1);
    this.dynHigh.gain.setTargetAtTime(-cut(amounts[2]) * this.dynEqScale, now, 0.1);

    // sub gate + pitch tracking
    this.lowAn.getFloatTimeDomainData(this.pitchBuf);
    const lowLevel = rms(this.pitchBuf);
    if (this.subOn) {
      this.subGate.gain.setTargetAtTime(
        lowLevel > 0.004 ? this.subDrive * 0.55 : 0,
        now,
        0.03,
      );
    }
    if (this.tickCount % 4 === 0) {
      const f0 = detectPitch(this.pitchBuf, this.ctx.sampleRate);
      if (f0 > 35 && f0 < 240) this.subPitch = f0;
      // the cutoff is the ceiling for the synthesised sub, so the control has
      // a real effect instead of being overwritten by the pitch tracker
      const sub = clamp(this.subPitch / 2, 20, this.subCutoffHz);
      this.subOsc.frequency.setTargetAtTime(sub, now, 0.09);
      this.subHarm.frequency.setTargetAtTime(clamp(this.subPitch, 50, 420), now, 0.09);
    }

    // transient envelope from the multiband sum
    this.mbAn.getFloatTimeDomainData(this.bufS);
    const peakNow = peak(this.bufS);
    this.transSlow = this.transSlow * 0.88 + peakNow * 0.12;
    if (peakNow > this.transSlow * 1.45 && peakNow > 0.02) this.transEnv = 1;
    else this.transEnv = Math.max(0, this.transEnv - 0.14);
    if (this.transientOn) {
      const drive = (this.transientAttack / 6) * (this.transientSensitivity / 100);
      this.transGain.gain.setTargetAtTime(
        clamp(0.12 + this.transEnv * drive * 0.8, 0, 1),
        now,
        0.012,
      );
    }

    // auto loudness servo toward the chosen target
    if (this.autoLoudness && f.shortTerm > -60) {
      if (this.tickCount % 5 === 0) {
        const err = this.target - f.shortTerm;
        this.normDb = clamp(this.normDb + clamp(err * 0.12, -0.4, 0.4), -12, 12);
        this.normGain.gain.setTargetAtTime(dbToGain(this.normDb), now, 0.3);
      }
    }
    f.normDb = this.normDb;

    // speech profile for AGC + bands
    const fast = this.speech && this.speechOn;
    const ducked = this.duckDb > 0;
    const agcAttack = Math.max((fast ? this.appliedAttack * 0.55 : this.appliedAttack) / 1000, 0.0005);
    // while the mic is open the release is the operator's duck recovery time,
    // so the bed comes back at a predictable rate
    const agcRelease = ducked
      ? Math.max(this.duckReleaseMs / 1000, 0.02)
      : Math.max((fast ? this.appliedRelease * 0.45 : this.appliedRelease) / 1000, 0.02);
    this.agc.attack.setTargetAtTime(agcAttack, now, 0.05);
    this.agc.release.setTargetAtTime(agcRelease, now, 0.05);
    BANDS.forEach((band, i) => {
      const b = this.bandParams[band.id];
      const attack = Math.max((fast ? b.attackMs * 0.6 : b.attackMs) / 1000, 0.0005);
      const release = Math.max((fast ? b.releaseMs * 0.5 : b.releaseMs) / 1000, 0.02);
      this.bandComp[i].attack.setTargetAtTime(attack, now, 0.05);
      this.bandComp[i].release.setTargetAtTime(release, now, 0.05);
    });
  }

  /* control values kept for the tick */
  private dynEqScale = 1;
  private transientOn = true;
  private transientAttack = 3;
  private transientSensitivity = 55;
  private subOn = true;
  private subDrive = 0.32;
  /** Upper bound for the synthesised sub tone, Hz. */
  private subCutoffHz = 45;
  private autoLoudness = true;
  private speechOn = true;
  private bandParams: Record<BandId, BandParams> = defaultBands();
  // streaming & automation state
  private codecId: CodecId = "off";
  private hfComp = true;
  private duckOn = true;
  private duckDepthDb = 6;
  private duckReleaseMs = 250;
  private duckMicOpen = false;
  private duckAuto = true;
  private duckDb = 0;
  private genreActive: GenreId | null = null;
  private backupOn = true;
  private talentMode = false;

  setControlState(p: Params): void {
    this.dynEqScale = clamp(p.dynEq / 100, 0, 1);
    this.transientOn = p.transientOn;
    this.transientAttack = p.transientAttackDb;
    this.transientSensitivity = p.transientSensitivity;
    this.subOn = p.subOn;
    this.subDrive = clamp(p.subDrive / 100, 0, 1);
    this.subCutoffHz = clamp(p.subCutoff, 30, 60);
    this.autoLoudness = p.autoLoudness;
    this.speechOn = p.speechOn;
    this.bandParams = p.bands;
    this.codecId = p.codec;
    this.hfComp = p.hfComp;
    this.duckOn = p.duckOn;
    this.duckDepthDb = p.duckDepthDb;
    this.duckReleaseMs = p.duckReleaseMs;
    this.duckMicOpen = p.duckMicOpen;
    this.duckAuto = p.duckAuto;
    this.genreActive =
      p.genre === "auto" ? parseGenreTag(p.metadata) : (p.genre as GenreId);
    this.backupOn = p.backupOn;
    this.talentMode = p.talentMode;
    if (!this.backupOn && this.backupActive) this.leaveBackup();
  }

  scope(): { l: Float32Array; r: Float32Array } {
    this.scopeL.getFloatTimeDomainData(this.scopeBufL);
    this.scopeR.getFloatTimeDomainData(this.scopeBufR);
    return { l: this.scopeBufL, r: this.scopeBufR };
  }

  latencyMs(): number {
    return ((this.ctx.baseLatency ?? 0) + (this.ctx.outputLatency ?? 0)) * 1000;
  }

  get sampleRate(): number {
    return this.ctx.sampleRate;
  }
}

/* ── DSP helpers ──────────────────────────────────────────────────────── */

function peak(buf: Float32Array): number {
  let p = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = Math.abs(buf[i]);
    if (v > p) p = v;
  }
  return p;
}

function rms(buf: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  return Math.sqrt(sum / buf.length);
}

function meanSquare(buf: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  return sum / buf.length;
}

/** 4× linear-interpolated true-peak estimate over the two legs. */
export function truePeak(l: Float32Array, r: Float32Array): number {
  let p = 0;
  for (let i = 1; i < l.length; i++) {
    const dl = l[i] - l[i - 1];
    const dr = r[i] - r[i - 1];
    for (let k = 0; k < 4; k++) {
      const t = k / 4;
      const a = Math.abs(l[i - 1] + dl * t);
      const b = Math.abs(r[i - 1] + dr * t);
      if (a > p) p = a;
      if (b > p) p = b;
    }
  }
  return p;
}

export function correlation(l: Float32Array, r: Float32Array): number {
  let lr = 0;
  let ll = 0;
  let rr = 0;
  for (let i = 0; i < l.length; i++) {
    lr += l[i] * r[i];
    ll += l[i] * l[i];
    rr += r[i] * r[i];
  }
  if (ll < 1e-12 || rr < 1e-12) return 1;
  return clamp(lr / Math.sqrt(ll * rr), -1, 1);
}

export function gatedLoudness(powers: number[]): number {
  if (powers.length < 4) return -70;
  const abs: number[] = [];
  for (const p of powers) {
    if (p <= 1e-12) continue;
    if (-0.691 + 10 * Math.log10(p) >= -70) abs.push(p);
  }
  if (abs.length === 0) return -70;
  const mean = abs.reduce((a, b) => a + b, 0) / abs.length;
  const rel = -0.691 + 10 * Math.log10(mean) - 10;
  let sum = 0;
  let n = 0;
  for (const p of abs) {
    if (-0.691 + 10 * Math.log10(p) >= rel) {
      sum += p;
      n += 1;
    }
  }
  return n === 0 ? -70 : -0.691 + 10 * Math.log10(sum / n);
}

/** Normalised autocorrelation over 45–500 Hz; returns 0 when unvoiced. */
export function detectPitch(buf: Float32Array, sr: number): number {
  const minLag = Math.floor(sr / 500);
  const maxLag = Math.min(Math.floor(sr / 45), buf.length - 1);
  let bestLag = 0;
  let best = 0;
  let energy = 0;
  for (let i = 0; i < buf.length; i++) energy += buf[i] * buf[i];
  if (energy < 1e-6) return 0;
  const mean = energy / buf.length;
  const normAt = (lag: number) => {
    let acc = 0;
    let n = 0;
    for (let i = 0; i < buf.length - lag; i += 2) {
      acc += buf[i] * buf[i + lag];
      n += 1;
    }
    // normalise by the number of pairs actually summed: a short lag must not
    // outscore a long one just because it accumulated more terms
    return n > 0 ? acc / (n * mean) : 0;
  };
  for (let lag = minLag; lag <= maxLag; lag++) {
    const norm = normAt(lag);
    if (norm > best) {
      best = norm;
      bestLag = lag;
    }
  }
  // octave correction: a period multiple correlates just as well as the
  // period itself, so prefer the lowest sub-multiple that scores nearly as high
  if (bestLag > 0) {
    for (const divisor of [2, 3]) {
      const candidate = Math.round(bestLag / divisor);
      if (candidate < minLag || candidate > maxLag) continue;
      const score = normAt(candidate);
      if (score >= best * 0.85) {
        best = score;
        bestLag = candidate;
        break;
      }
    }
  }
  return best > 0.28 && bestLag > 0 ? sr / bestLag : 0;
}

export /** Gentle tanh limiter for the talent feed — no look-ahead, just soft knee. */
function softClipCurve(drive: number): Float32Array<ArrayBuffer> {
  const n = 2048;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * drive) / Math.tanh(drive);
  }
  return curve;
}

export function declipCurve(driveDb: number, thresholdDb: number): Float32Array<ArrayBuffer> {
  const n = 4096;
  const curve = new Float32Array(n);
  const t = clamp(Math.pow(10, thresholdDb / 20), 0.05, 0.98);
  const drive = clamp(driveDb / 12, 0, 1);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const ax = Math.abs(x);
    if (ax <= t) {
      // below the threshold the curve is transparent
      curve[i] = x;
    } else {
      // above it the peak is expanded back out: a concave knee rebuilds the
      // crest factor a clipped download lost, and drive lifts the shoulder
      const over = (ax - t) / (1 - t);
      const rebuilt = t + (1 - t) * Math.pow(over, 1 - drive * 0.45);
      const lifted = Math.min(1, rebuilt * (1 + drive * 0.22));
      curve[i] = Math.sign(x) * lifted;
    }
  }
  return curve;
}

/* ──────────────────────────────────────────────────────────────────────────
 * UI primitives
 * ────────────────────────────────────────────────────────────────────────── */

const fmtDb = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(1)} dB`;
const fmtSigned = (v: number) => `${v > 0 ? "+" : "−"}${Math.abs(v).toFixed(1)}`;

interface SliderProps {
  label: string;
  hint?: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
}

function Slider({ label, hint, value, min, max, step = 0.1, onChange, format }: SliderProps) {
  return (
    <div className="sp-row">
      <span className="sp-row-label">
        {label}
        {hint ? <i>{hint}</i> : null}
      </span>
      <span className="sp-val sp-mono">{format ? format(value) : value.toFixed(1)}</span>
      <input
        className="sp-slider"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}

function MiniSlider({
  label,
  value,
  min,
  max,
  step = 0.1,
  onChange,
  format,
}: Omit<SliderProps, "hint">) {
  return (
    <div className="sp-mini">
      <div className="sp-mini-top">
        <span>{label}</span>
        <b className="sp-mono">{format ? format(value) : value.toFixed(1)}</b>
      </div>
      <input
        className="sp-slider"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}

function Toggle({ label, on, onChange }: { label: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" className="sp-toggle" aria-pressed={on} onClick={() => onChange(!on)}>
      <span>{label}</span>
      <span className="knob" aria-hidden />
    </button>
  );
}

function Card({
  title,
  subtitle,
  right,
  className,
  children,
}: {
  title: string;
  subtitle?: string;
  right?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={`sp-card ${className ?? ""}`}>
      <header className="sp-card-head">
        <div>
          <h3>{title}</h3>
          {subtitle ? <p>{subtitle}</p> : null}
        </div>
        {right ? <div className="sp-right">{right}</div> : null}
      </header>
      <div className="sp-card-body">{children}</div>
    </section>
  );
}

/* ── LED meter ────────────────────────────────────────────────────────── */

type MeterKind = "level" | "gr" | "pct" | "peak";

function LedMeter({
  label,
  sub,
  value,
  kind,
  unit,
}: {
  label: string;
  sub?: string;
  value: number;
  kind: MeterKind;
  unit: string;
}) {
  const segments = 18;
  let frac = 0;
  if (kind === "level") frac = clamp((value + 60) / 60, 0, 1);
  else if (kind === "peak") frac = clamp((value + 30) / 30, 0, 1);
  else if (kind === "gr") frac = clamp(value / 12, 0, 1);
  else frac = clamp(value / 100, 0, 1);
  const lit = Math.round(frac * segments);

  return (
    <div className="sp-meter">
      <span className="sp-meter-label">{label}</span>
      <div className="sp-rail">
        {Array.from({ length: segments }, (_, i) => {
          const on = kind === "gr" ? i < lit : i >= segments - lit;
          const edge = kind === "gr" ? i < 3 : i < 3;
          const hot = kind === "gr" ? i < 1 : i < 2;
          return (
            <span
              key={i}
              className={`sp-seg${on ? " on" : ""}${on && edge ? " warn" : ""}${on && hot ? " hot" : ""}`}
            />
          );
        })}
      </div>
      <span className="sp-meter-val sp-mono">
        {kind === "pct" ? `${Math.round(value)}` : value <= -119 ? "−∞" : value.toFixed(1)}
        <small>{unit}</small>
      </span>
      {sub ? <span className="sp-meter-sub">{sub}</span> : null}
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────────
 * Canvases
 * ────────────────────────────────────────────────────────────────────────── */

const TRACE: Record<TraceMode, { stroke: string; glow: string; label: string }> = {
  cyan: { stroke: "#22d3ee", glow: "rgba(34,211,238,.85)", label: "Cyan Neon" },
  amber: { stroke: "#f59e0b", glow: "rgba(245,158,11,.8)", label: "Amber CRT" },
  green: { stroke: "#22c55e", glow: "rgba(34,197,94,.8)", label: "Matrix Green" },
};

function fitCanvas(canvas: HTMLCanvasElement): { c: CanvasRenderingContext2D; w: number; h: number } | null {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (w === 0 || h === 0) return null;
  const bw = Math.floor(w * dpr);
  const bh = Math.floor(h * dpr);
  if (canvas.width !== bw || canvas.height !== bh) {
    canvas.width = bw;
    canvas.height = bh;
  }
  const c = canvas.getContext("2d");
  if (!c) return null;
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { c, w, h };
}

function ScopeCanvas({
  engine,
  running,
  mode,
}: {
  engine: StudioEngine | null;
  running: boolean;
  mode: TraceMode;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const canvas = ref.current;
      if (!canvas) return;
      const fitted = fitCanvas(canvas);
      if (!fitted) return;
      const { c, w, h } = fitted;
      const trace = TRACE[mode];
      c.clearRect(0, 0, w, h);

      // grid
      c.strokeStyle = "rgba(34,211,238,.08)";
      c.lineWidth = 1;
      for (let i = 1; i < 8; i++) {
        const x = (w / 8) * i;
        const y = (h / 8) * i;
        c.beginPath();
        c.moveTo(x, 0);
        c.lineTo(x, h);
        c.stroke();
        c.beginPath();
        c.moveTo(0, y);
        c.lineTo(w, y);
        c.stroke();
      }
      c.strokeStyle = "rgba(255,255,255,.07)";
      c.beginPath();
      c.moveTo(w / 2, 0);
      c.lineTo(w / 2, h);
      c.moveTo(0, h / 2);
      c.lineTo(w, h / 2);
      c.stroke();

      // mono reference diagonal
      c.setLineDash([4, 6]);
      c.strokeStyle = "rgba(125,139,161,.3)";
      c.beginPath();
      c.moveTo(w * 0.12, h * 0.88);
      c.lineTo(w * 0.88, h * 0.12);
      c.stroke();
      c.setLineDash([]);

      // axis labels
      c.fillStyle = "rgba(125,139,161,.55)";
      c.font = "9px ui-monospace, monospace";
      c.fillText("L", w - 14, h / 2 - 8);
      c.fillText("R", w / 2 + 8, 13);

      if (running && engine) {
        const { l, r } = engine.scope();
        const sx = w / 2 - 14;
        const sy = h / 2 - 14;
        c.save();
        c.shadowBlur = 9;
        c.shadowColor = trace.glow;
        c.strokeStyle = trace.stroke;
        c.lineWidth = 1.15;
        c.beginPath();
        for (let i = 0; i < l.length; i += 2) {
          const x = w / 2 + clamp(l[i], -1, 1) * sx;
          const y = h / 2 - clamp(r[i], -1, 1) * sy;
          if (i === 0) c.moveTo(x, y);
          else c.lineTo(x, y);
        }
        c.stroke();
        c.restore();
      } else {
        c.fillStyle = "rgba(125,139,161,.45)";
        c.font = "10px ui-monospace, monospace";
        c.fillText("ENGINE IDLE", w / 2 - 32, h / 2 + 28);
      }
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [engine, running, mode]);

  return <canvas ref={ref} className="sp-scope" aria-label="Stereo vector scope" />;
}

function LufsChart({
  engine,
  running,
  target,
}: {
  engine: StudioEngine | null;
  running: boolean;
  target: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const draw = () => {
      const canvas = ref.current;
      if (!canvas) return;
      const fitted = fitCanvas(canvas);
      if (!fitted) return;
      const { c, w, h } = fitted;
      const padL = 36;
      const padR = 46;
      const padT = 12;
      const padB = 18;
      const plotW = w - padL - padR;
      const plotH = h - padT - padB;
      const yMin = target - 26;
      const yMax = target + 6;
      const yOf = (v: number) => padT + ((yMax - clamp(v, yMin, yMax)) / (yMax - yMin)) * plotH;
      const now = performance.now();
      const xOf = (t: number) => padL + ((t - (now - 60000)) / 60000) * plotW;

      c.clearRect(0, 0, w, h);
      c.fillStyle = "#080b10";
      c.fillRect(0, 0, w, h);

      c.font = "8px ui-monospace, monospace";
      c.strokeStyle = "rgba(255,255,255,.05)";
      c.lineWidth = 1;
      for (let v = yMin; v <= yMax; v += 6) {
        const y = yOf(v);
        c.beginPath();
        c.moveTo(padL, y);
        c.lineTo(w - padR, y);
        c.stroke();
        c.fillStyle = "rgba(125,139,161,.6)";
        c.fillText(`${v.toFixed(0)}`, 6, y + 3);
      }
      for (let s = 0; s <= 60; s += 10) {
        const x = padL + (s / 60) * plotW;
        c.beginPath();
        c.moveTo(x, padT);
        c.lineTo(x, padT + plotH);
        c.stroke();
        if (s % 20 === 0) {
          c.fillStyle = "rgba(125,139,161,.5)";
          c.fillText(s === 0 ? "-60s" : s === 60 ? "now" : `-${60 - s}s`, x - 9, h - 5);
        }
      }

      // target line
      c.setLineDash([5, 5]);
      c.strokeStyle = "rgba(251,191,36,.7)";
      c.beginPath();
      c.moveTo(padL, yOf(target));
      c.lineTo(w - padR, yOf(target));
      c.stroke();
      c.setLineDash([]);
      c.fillStyle = "rgba(251,191,36,.9)";
      c.fillText(`${target.toFixed(1)}`, w - padR + 6, yOf(target) + 3);

      const history = engine?.history ?? [];
      const points = history.filter((p) => p.t >= now - 60000);
      if (points.length > 1) {
        const line = (key: "m" | "s" | "i", colour: string, width: number, dash: number[]) => {
          c.setLineDash(dash);
          c.strokeStyle = colour;
          c.lineWidth = width;
          c.beginPath();
          let started = false;
          for (const p of points) {
            const x = xOf(p.t);
            const y = yOf(p[key]);
            if (!started) {
              c.moveTo(x, y);
              started = true;
            } else c.lineTo(x, y);
          }
          c.stroke();
          c.setLineDash([]);
        };
        line("i", "rgba(147,197,253,.75)", 1.2, [5, 4]);
        line("m", "rgba(34,211,238,.5)", 1, []);
        line("s", "#22d3ee", 2, []);
      } else {
        c.fillStyle = "rgba(125,139,161,.45)";
        c.font = "10px ui-monospace, monospace";
        c.fillText(
          running ? "ACQUIRING LOUDNESS…" : "ENGINE IDLE — START TO CAPTURE",
          padL + 12,
          padT + plotH / 2,
        );
      }
    };
    draw();
    const id = window.setInterval(draw, 250);
    return () => window.clearInterval(id);
  }, [engine, running, target]);

  return <canvas ref={ref} className="sp-chart" aria-label="LUFS trend, last 60 seconds" />;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Panels
 * ────────────────────────────────────────────────────────────────────────── */

interface PanelCtx {
  p: Params;
  frame: Frame;
  running: boolean;
  source: SourceMode;
  sampleRate: number;
  error: string | null;
  setParam: <K extends keyof Params>(key: K, value: Params[K]) => void;
  setBand: (band: BandId, key: keyof BandParams, value: number) => void;
  setSource: (mode: SourceMode) => void;
}

function InputPanel({ p, frame, running, source, sampleRate, error, setParam, setSource }: PanelCtx) {
  return (
    <div className="sp-grid">
      <Card
        className="sp-col-4"
        title="Input / Preamp"
        subtitle="Stage 1 · source select and analogue-style trim"
        right={<span className="sp-tag cyan">Stage 1</span>}
      >
        <div className="sp-row">
          <span className="sp-row-label">Program source</span>
          <select
            className="sp-select"
            aria-label="Program source"
            value={source}
            onChange={(e) => setSource(e.target.value as SourceMode)}
          >
            <option value="demo">Demo program (8 s loop)</option>
            <option value="mic">Microphone input</option>
          </select>
        </div>
        <Slider
          label="Input trim"
          hint="±24 dB"
          value={p.inputGainDb}
          min={-24}
          max={24}
          step={0.5}
          onChange={(v) => setParam("inputGainDb", v)}
          format={fmtDb}
        />
        <Slider
          label="Low tone"
          value={p.toneLowDb}
          min={-6}
          max={6}
          step={0.1}
          onChange={(v) => setParam("toneLowDb", v)}
          format={fmtDb}
        />
        <Slider
          label="High tone"
          value={p.toneHighDb}
          min={-6}
          max={6}
          step={0.1}
          onChange={(v) => setParam("toneHighDb", v)}
          format={fmtDb}
        />
      </Card>

      <Card className="sp-col-4" title="Input telemetry" subtitle="Peak and RMS ahead of the chain">
        <div className="sp-kv">
          <span>Left peak</span>
          <b className="sp-mono">{frame.inputL.toFixed(1)} dBFS</b>
        </div>
        <div className="sp-kv">
          <span>Right peak</span>
          <b className="sp-mono">{frame.inputR.toFixed(1)} dBFS</b>
        </div>
        <div className="sp-kv">
          <span>Silence gate</span>
          <b className="sp-mono">
            {frame.silenceMs >= 3000
              ? `ALARM · ${(frame.silenceMs / 1000).toFixed(1)} s`
              : frame.silenceMs > 0
                ? `${(frame.silenceMs / 1000).toFixed(1)} s below −55 dBFS`
                : "clear"}
          </b>
        </div>
        <div className="sp-kv">
          <span>Speech detector</span>
          <b className="sp-mono">{frame.speech ? "speech · fast profile" : "music / noise"}</b>
        </div>
        <p className="sp-note">
          The gate trips after <b>3.0 s</b> below −55 dBFS. It feeds the banner in the
          meter deck, not the audio path — the chain keeps running through silence.
        </p>
        {error ? <p className="sp-err">{error}</p> : null}
      </Card>

      <Card className="sp-col-4" title="Session" subtitle="Engine state" right={
        <span className="sp-tag">{running ? "running" : "idle"}</span>
      }>
        <div className="sp-kv"><span>Sample rate</span><b className="sp-mono">{(sampleRate / 1000).toFixed(1)} kHz</b></div>
        <div className="sp-kv"><span>Latency</span><b className="sp-mono">{running ? "interactive" : "—"}</b></div>
        <div className="sp-kv"><span>True peak</span><b className="sp-mono">{frame.truePeak.toFixed(1)} dBTP</b></div>
        <div className="sp-kv"><span>Loudness target</span><b className="sp-mono">{p.target.toFixed(1)} LUFS</b></div>
        <p className="sp-note">
          <b>AES71</b> at −14 LUFS is the default web delivery target; −16 suits
          spoken-word podcasts and −23 is the EBU R128 broadcast ceiling.
        </p>
      </Card>
    </div>
  );
}

function RestorationPanel({ p, frame, setParam }: PanelCtx) {
  return (
    <div className="sp-grid">
      <Card
        className="sp-col-8"
        title="De-Clipper / Peak Restorer"
        subtitle="Stage 3 · rebuild the crest factor of over-compressed web audio"
        right={
          <Toggle label={p.declipOn ? "In circuit" : "Bypassed"} on={p.declipOn} onChange={(v) => setParam("declipOn", v)} />
        }
      >
        <div className="sp-grid">
          <div className="sp-col-6">
            <Slider
              label="Reconstruction drive"
              hint="0 to +12 dB"
              value={p.declipDriveDb}
              min={0}
              max={12}
              step={0.1}
              onChange={(v) => setParam("declipDriveDb", v)}
              format={fmtDb}
            />
            <Slider
              label="Threshold"
              hint="where restoration starts"
              value={p.declipThresholdDb}
              min={-24}
              max={0}
              step={0.5}
              onChange={(v) => setParam("declipThresholdDb", v)}
              format={fmtDb}
            />
          </div>
          <div className="sp-col-6">
            <Slider
              label="Dry / wet"
              value={p.declipMix}
              min={0}
              max={100}
              step={1}
              onChange={(v) => setParam("declipMix", v)}
              format={(v) => `${v.toFixed(0)} %`}
            />
            <div className="sp-kv"><span>Algorithm</span><b>concave peak rebuild · 4× oversampled</b></div>
            <div className="sp-kv"><span>Restored peak</span><b className="sp-mono">{frame.outL.toFixed(1)} dBFS</b></div>
          </div>
        </div>
        <p className="sp-note">
          Material clipped on the way to the encoder arrives with its peaks flat. The
          restorer leaves everything below the threshold untouched and expands what
          sits above it, so transients get their shape back before the AGC sees them.
        </p>
      </Card>

      <Card className="sp-col-4" title="Why it matters" subtitle="Restoration before levelling">
        <div className="sp-kv"><span>Drive</span><b className="sp-mono">{p.declipDriveDb.toFixed(1)} dB</b></div>
        <div className="sp-kv"><span>Threshold</span><b className="sp-mono">{p.declipThresholdDb.toFixed(1)} dBFS</b></div>
        <div className="sp-kv"><span>Mix</span><b className="sp-mono">{p.declipMix.toFixed(0)} %</b></div>
        <p className="sp-note">
          The de-clipper sits <b>ahead of the AGC</b> on purpose: a leveller fed a
          flattened waveform just turns the flattening up. Peak reconstruction first
          keeps the leveller from over-reacting to a signal that has no crest left.
        </p>
      </Card>
    </div>
  );
}

function AgcPanel({ p, frame, setParam }: PanelCtx) {
  return (
    <div className="sp-grid">
      <Card
        className="sp-col-8"
        title="AGC / Leveller"
        subtitle="Stage 4 · macro level before the band split"
        right={<span className="sp-tag cyan">{frame.agcGr.toFixed(1)} dB GR</span>}
      >
        <div className="sp-grid">
          <div className="sp-col-6">
            <Slider label="Threshold" value={p.agcThresholdDb} min={-48} max={0} step={0.5}
              onChange={(v) => setParam("agcThresholdDb", v)} format={fmtDb} />
            <Slider label="Ratio" value={p.agcRatio} min={1} max={10} step={0.1}
              onChange={(v) => setParam("agcRatio", v)} format={(v) => `${v.toFixed(1)} : 1`} />
            <Slider label="Makeup" value={p.agcMakeupDb} min={-6} max={12} step={0.1}
              onChange={(v) => setParam("agcMakeupDb", v)} format={fmtDb} />
          </div>
          <div className="sp-col-6">
            <Slider label="Attack" value={p.agcAttackMs} min={0.5} max={120} step={0.5}
              onChange={(v) => setParam("agcAttackMs", v)} format={(v) => `${v.toFixed(1)} ms`} />
            <Slider label="Release" value={p.agcReleaseMs} min={40} max={1200} step={10}
              onChange={(v) => setParam("agcReleaseMs", v)} format={(v) => `${v.toFixed(0)} ms`} />
            <div className="sp-row">
              <span className="sp-row-label">Auto-speech sensing<i>mic profile</i></span>
              <Toggle label={p.speechOn ? "Armed" : "Off"} on={p.speechOn} onChange={(v) => setParam("speechOn", v)} />
            </div>
          </div>
        </div>
        <p className="sp-note">
          AGC output <b>feeds the multiband directly</b> — the band compressors only
          ever see a level that is already controlled, so low end cannot duck the
          midrange and the five lanes stay in step.
        </p>
      </Card>

      <Card className="sp-col-4" title="Speech profile" subtitle="Detector driven release switching" right={
        <span className={`sp-tag ${frame.speech ? "amber" : ""}`}>{frame.speech ? "speech" : "music"}</span>
      }>
        <div className="sp-kv"><span>AGC attack</span><b className="sp-mono">{p.speechOn && frame.speech ? (p.agcAttackMs * 0.55).toFixed(1) : p.agcAttackMs.toFixed(1)} ms</b></div>
        <div className="sp-kv"><span>AGC release</span><b className="sp-mono">{p.speechOn && frame.speech ? (p.agcReleaseMs * 0.45).toFixed(0) : p.agcReleaseMs.toFixed(0)} ms</b></div>
        <div className="sp-kv"><span>Band release</span><b className="sp-mono">{p.speechOn && frame.speech ? "× 0.50" : "× 1.00"}</b></div>
        <p className="sp-note">
          When mic input is detected the AGC and all five band compressors switch to
          the faster profile, then ease back to the musical timing when the voice stops.
        </p>
      </Card>
    </div>
  );
}

function EnhancePanel({ p, frame, setParam }: PanelCtx) {
  return (
    <div className="sp-grid">
      <Card className="sp-col-4" title="Sub-harmonic synthesizer" subtitle="Stage 5 · deep bass for small speakers"
        right={<Toggle label={p.subOn ? "On" : "Off"} on={p.subOn} onChange={(v) => setParam("subOn", v)} />}>
        <Slider label="Sub drive" value={p.subDrive} min={0} max={100} step={1}
          onChange={(v) => setParam("subDrive", v)} format={(v) => `${v.toFixed(0)} %`} />
        <Slider label="Sub cutoff" hint="30–60 Hz" value={p.subCutoff} min={30} max={60} step={0.5}
          onChange={(v) => setParam("subCutoff", v)} format={(v) => `${v.toFixed(1)} Hz`} />
        <Slider label="Upper harmonics" hint="small speaker bass" value={p.subHarmonics} min={0} max={100} step={1}
          onChange={(v) => setParam("subHarmonics", v)} format={(v) => `${v.toFixed(0)} %`} />
        <p className="sp-note">
          Tracks the program fundamental and synthesises an octave below it, plus
          harmonically related upper content so a phone speaker still reproduces the
          bass line it cannot physically play.
        </p>
      </Card>

      <Card className="sp-col-4" title="Enhancers" subtitle="Stage 9 · air and stereo image">
        <Slider label="HF enhancer" value={p.hf} min={0} max={100} step={1}
          onChange={(v) => setParam("hf", v)} format={(v) => `${v.toFixed(0)} %`} />
        <Slider label="Stereo width" value={p.width} min={0} max={200} step={1}
          onChange={(v) => setParam("width", v)} format={(v) => `${v.toFixed(0)} %`} />
        <div className="sp-kv"><span>HF activity</span><b className="sp-mono">{frame.hf.toFixed(0)} %</b></div>
        <div className="sp-kv"><span>Side energy</span><b className="sp-mono">{frame.stereo.toFixed(0)} %</b></div>
        <div className="sp-kv"><span>Correlation</span><b className="sp-mono">{frame.correlation.toFixed(2)}</b></div>
        <p className="sp-note">Width is a mid/side matrix, so mono compatibility is preserved down to the limiter.</p>
      </Card>

      <Card className="sp-col-4" title="Transient snap booster" subtitle="Stage 10 · pre-limiter punch"
        right={<Toggle label={p.transientOn ? "On" : "Off"} on={p.transientOn} onChange={(v) => setParam("transientOn", v)} />}>
        <Slider label="Attack boost" hint="0 to +6 dB" value={p.transientAttackDb} min={0} max={6} step={0.1}
          onChange={(v) => setParam("transientAttackDb", v)} format={fmtDb} />
        <Slider label="Sensitivity" value={p.transientSensitivity} min={0} max={100} step={1}
          onChange={(v) => setParam("transientSensitivity", v)} format={(v) => `${v.toFixed(0)} %`} />
        <p className="sp-note">
          A high-band parallel path opened by the program's own attack slope — the
          snap is added back after the multiband has done its work and before the
          limiter clamps the result.
        </p>
      </Card>
    </div>
  );
}

function MultibandPanel({ p, frame, setBand }: PanelCtx) {
  return (
    <Card
      title="Multiband compressor · 5 bands"
      subtitle="Stage 7 · Linkwitz-Riley split, independent lane dynamics"
      right={<span className="sp-tag cyan">{BANDS.length} bands</span>}
    >
      <div className="sp-bands">
        {BANDS.map((band, i) => {
          const b = p.bands[band.id];
          const gr = frame.bandGr[i] ?? 0;
          return (
            <div className="sp-band" key={band.id}>
              <div className="sp-band-head">
                <b>{band.label}</b>
                <span className="sp-mono">{band.span}</span>
              </div>
              <div className="sp-band-gr">
                <i style={{ width: `${clamp((gr / 12) * 100, 0, 100)}%` }} />
              </div>
              <MiniSlider label="Threshold" value={b.thresholdDb} min={-48} max={0} step={0.5}
                onChange={(v) => setBand(band.id, "thresholdDb", v)} format={fmtDb} />
              <MiniSlider label="Ratio" value={b.ratio} min={1} max={12} step={0.1}
                onChange={(v) => setBand(band.id, "ratio", v)} format={(v) => `${v.toFixed(1)}:1`} />
              <MiniSlider label="Attack" value={b.attackMs} min={0.5} max={60} step={0.5}
                onChange={(v) => setBand(band.id, "attackMs", v)} format={(v) => `${v.toFixed(1)}ms`} />
              <MiniSlider label="Release" value={b.releaseMs} min={40} max={900} step={10}
                onChange={(v) => setBand(band.id, "releaseMs", v)} format={(v) => `${v.toFixed(0)}ms`} />
              <MiniSlider label="Makeup" value={b.gainDb} min={-6} max={9} step={0.1}
                onChange={(v) => setBand(band.id, "gainDb", v)} format={fmtDb} />
              <div className="sp-kv" style={{ marginTop: 8 }}>
                <span>GR</span>
                <b className="sp-mono">{gr.toFixed(1)} dB</b>
              </div>
            </div>
          );
        })}
      </div>
      <p className="sp-note">
        The AGC output is split here, so every band starts from the same macro level.
        Each lane is metered in the deck above with its frequency span under the bar.
      </p>
    </Card>
  );
}

function OutputPanel({ p, frame, setParam }: PanelCtx) {
  return (
    <div className="sp-grid">
      <Card className="sp-col-6" title="Limiter" subtitle="Stage 11 · true-peak ceiling">
        <Slider label="Ceiling" value={p.ceilingDb} min={-6} max={0} step={0.1}
          onChange={(v) => setParam("ceilingDb", v)} format={(v) => `${v.toFixed(1)} dBTP`} />
        <Slider label="Release" value={p.limiterReleaseMs} min={20} max={500} step={5}
          onChange={(v) => setParam("limiterReleaseMs", v)} format={(v) => `${v.toFixed(0)} ms`} />
        <Slider label="Output trim" value={p.outputGainDb} min={-12} max={6} step={0.1}
          onChange={(v) => setParam("outputGainDb", v)} format={fmtDb} />
        <div className="sp-kv"><span>Limiter GR</span><b className="sp-mono">{frame.limiterGr.toFixed(1)} dB</b></div>
        <div className="sp-kv"><span>True peak out</span><b className="sp-mono">{frame.truePeak.toFixed(1)} dBTP</b></div>
        <p className="sp-note">Ceiling is enforced after the output trim, so the device never sees a sample above it.</p>
      </Card>

      <Card className="sp-col-6" title="Loudness delivery" subtitle="Target and automatic trim">
        <div className="sp-row">
          <span className="sp-row-label">Loudness target</span>
          <select className="sp-select" aria-label="Loudness target" value={p.target}
            onChange={(e) => setParam("target", Number(e.target.value))}>
            <option value={-14}>AES71 · −14.0 LUFS (web default)</option>
            <option value={-16}>−16.0 LUFS (podcast)</option>
            <option value={-23}>EBU R128 · −23.0 LUFS</option>
          </select>
        </div>
        <div className="sp-row">
          <span className="sp-row-label">Auto loudness servo<i>slow trim</i></span>
          <Toggle label={p.autoLoudness ? "On" : "Off"} on={p.autoLoudness} onChange={(v) => setParam("autoLoudness", v)} />
        </div>
        <div className="sp-kv"><span>Momentary</span><b className="sp-mono">{frame.momentary.toFixed(1)} LUFS</b></div>
        <div className="sp-kv"><span>Short-term</span><b className="sp-mono">{frame.shortTerm.toFixed(1)} LUFS</b></div>
        <div className="sp-kv"><span>Integrated</span><b className="sp-mono">{frame.integrated.toFixed(1)} LUFS</b></div>
        <div className="sp-kv"><span>Servo trim</span><b className="sp-mono">{fmtSigned(frame.normDb)} dB</b></div>
      </Card>
    </div>
  );
}

function StreamPanel({ p, frame, setParam }: PanelCtx) {
  const profile = CODEC_PROFILES[p.codec];
  const preview = p.codec !== "off";
  const trim = preview && p.hfComp ? profile.hfTrimDb : 0;
  return (
    <div className="sp-grid">
      <Card
        className="sp-col-6"
        title="Codec preview"
        subtitle="Listen through the delivery codec before it leaves the building"
        right={<span className={`sp-tag ${preview ? "cyan" : ""}`}>{preview ? `${profile.bitrate} kbps` : "bypass"}</span>}
      >
        <div className="sp-row">
          <span className="sp-row-label">Preview codec</span>
          <select
            className="sp-select"
            aria-label="Codec preview"
            value={p.codec}
            onChange={(e) => setParam("codec", e.target.value as CodecId)}
          >
            {(Object.keys(CODEC_PROFILES) as CodecId[]).map((id) => (
              <option key={id} value={id}>{CODEC_PROFILES[id].label}</option>
            ))}
          </select>
        </div>
        <div className="sp-row">
          <span className="sp-row-label">Auto-codec HF compensation<i>pre-echo guard</i></span>
          <Toggle label={p.hfComp ? "On" : "Off"} on={p.hfComp} onChange={(v) => setParam("hfComp", v)} />
        </div>
        <div className="sp-kv"><span>Bandwidth</span><b className="sp-mono">{preview ? `${(profile.lowpass / 1000).toFixed(1)} kHz` : "full band"}</b></div>
        <div className="sp-kv"><span>HF limiting trim</span><b className="sp-mono">{trim.toFixed(1)} dB</b></div>
        <div className="sp-kv"><span>Pre-echo model</span><b className="sp-mono">{preview ? "3.2 ms comb" : "off"}</b></div>
        <p className="sp-note">
          The preview monitors through a band-limited copy of the output with a
          short comb that stands in for pre-echo, so 64 kbps artefacts are
          audible without leaving the console. With compensation on, the top
          band is limited harder and the HF shelf backed off before delivery,
          which is what stops those artefacts at the encoder.
        </p>
      </Card>

      <Card
        className="sp-col-6"
        title="Voice-ducking sidechain"
        subtitle="DJ mic open · low-mid duck · faster AGC release"
        right={<span className={`sp-tag ${frame.duckDb > 0 ? "amber" : ""}`}>{frame.duckDb > 0 ? `−${frame.duckDb.toFixed(0)} dB` : "idle"}</span>}
      >
        <div className="sp-row">
          <span className="sp-row-label">Sidechain<i>auto or manual</i></span>
          <Toggle label={p.duckOn ? "Armed" : "Off"} on={p.duckOn} onChange={(v) => setParam("duckOn", v)} />
        </div>
        <div className="sp-row">
          <span className="sp-row-label">DJ mic open<i>manual trigger</i></span>
          <Toggle label={p.duckMicOpen ? "Open" : "Closed"} on={p.duckMicOpen} onChange={(v) => setParam("duckMicOpen", v)} />
        </div>
        <div className="sp-row">
          <span className="sp-row-label">Follow voice detector</span>
          <Toggle label={p.duckAuto ? "Auto" : "Manual"} on={p.duckAuto} onChange={(v) => setParam("duckAuto", v)} />
        </div>
        <Slider label="Duck depth" value={p.duckDepthDb} min={0} max={12} step={0.5}
          onChange={(v) => setParam("duckDepthDb", v)} format={(v) => `${v.toFixed(1)} dB`} />
        <Slider label="Recovery release" value={p.duckReleaseMs} min={60} max={600} step={10}
          onChange={(v) => setParam("duckReleaseMs", v)} format={(v) => `${v.toFixed(0)} ms`} />
        <p className="sp-note">
          When the mic opens the bed drops {p.duckDepthDb.toFixed(1)} dB and a 260 Hz
          low-mid shelf steps back; the AGC release is shortened while the duck is
          active so the music recovers quickly. The detector can be the manual mic
          switch or the voice-band energy tracker.
        </p>
      </Card>

      <Card
        className="sp-col-6"
        title="Metadata-driven preset trigger"
        subtitle="Switch EQ and multiband profiles from the now-playing tag"
        right={<span className={`sp-tag ${frame.genre !== "—" ? "cyan" : ""}`}>{frame.genre}</span>}
      >
        <div className="sp-row">
          <span className="sp-row-label">Now playing / tags</span>
          <input
            className="sp-select"
            style={{ width: "100%" }}
            aria-label="Metadata tags"
            placeholder="Artist - Title  [EDM]"
            value={p.metadata}
            onChange={(e) => setParam("metadata", e.target.value)}
          />
        </div>
        <div className="sp-row">
          <span className="sp-row-label">Genre profile</span>
          <select
            className="sp-select"
            aria-label="Genre profile"
            value={p.genre}
            onChange={(e) => setParam("genre", e.target.value as GenreId | "auto")}
          >
            <option value="auto">Auto (parse tag)</option>
            {(Object.keys(GENRE_PROFILES) as GenreId[]).map((id) => (
              <option key={id} value={id}>{GENRE_PROFILES[id].label}</option>
            ))}
          </select>
        </div>
        <div className="sp-kv"><span>Active profile</span><b>{frame.genre}</b></div>
        <div className="sp-kv"><span>EQ tilt</span><b className="sp-mono">{p.genre === "auto" ? "from tag" : `${GENRE_PROFILES[p.genre].toneLow.toFixed(1)} / ${GENRE_PROFILES[p.genre].toneHigh.toFixed(1)} dB`}</b></div>
        <div className="sp-kv"><span>Band threshold shift</span><b className="sp-mono">{p.genre === "auto" ? "—" : `${GENRE_PROFILES[p.genre].bandThreshold.toFixed(1)} dB`}</b></div>
        <p className="sp-note">
          A tag such as <b>[EDM]</b>, <b>genre=hiphop</b> or <b>#talk</b> in the
          metadata switches the tone tilt and the multiband threshold offset the
          moment the track changes. Set the selector to a fixed genre to lock it.
        </p>
      </Card>

      <Card className="sp-col-6" title="Failover & monitoring" subtitle="Silence backup · talent monitor">
        <div className="sp-row">
          <span className="sp-row-label">Silence backup<i>5 s hold</i></span>
          <Toggle label={p.backupOn ? "Armed" : "Off"} on={p.backupOn} onChange={(v) => setParam("backupOn", v)} />
        </div>
        <div className="sp-kv"><span>Backup source</span><b className="sp-mono">{frame.backup ? "on air" : "standby"}</b></div>
        <div className="sp-kv"><span>Programme silence</span><b className="sp-mono">{(frame.silenceMs / 1000).toFixed(1)} s</b></div>
        <div className="sp-row" style={{ marginTop: 10 }}>
          <span className="sp-row-label">Talent monitor<i>bypass look-ahead</i></span>
          <Toggle label={p.talentMode ? "Low latency" : "On air"} on={p.talentMode} onChange={(v) => setParam("talentMode", v)} />
        </div>
        <div className="sp-kv"><span>Monitor path</span><b>{frame.talent ? "pre-limiter" : "full chain"}</b></div>
        <div className="sp-kv"><span>Look-ahead</span><b className="sp-mono">{frame.talent ? "0 samples" : "limiter window"}</b></div>
        <p className="sp-note">
          The backup loop crossfades in after five seconds below −55 dBFS and hands
          the chain back once the real programme has been healthy for two seconds.
          Talent mode feeds the headphones from before the limiter, with a soft clip
          as the only safety — the on-air chain is untouched.
        </p>
      </Card>
    </div>
  );
}

function ScopePanel({
  engine, running, p, frame, trace, setTrace,
}: PanelCtx & { engine: StudioEngine | null; trace: TraceMode; setTrace: (m: TraceMode) => void }) {
  const delta = frame.shortTerm - p.target;
  return (
    <div className="sp-grid">
      <Card
        className="sp-col-7"
        title="Vector scope · Lissajous"
        subtitle="Stereo phase monitor · L vs R"
        right={
          <div style={{ display: "flex", gap: 5 }}>
            {(Object.keys(TRACE) as TraceMode[]).map((m) => (
              <button key={m} type="button" className="sp-btn" aria-pressed={trace === m}
                onClick={() => setTrace(m)}
                style={trace === m ? { borderColor: TRACE[m].stroke, color: TRACE[m].stroke } : undefined}>
                <span style={{ width: 6, height: 6, borderRadius: 3, background: TRACE[m].stroke, display: "inline-block" }} />
                {TRACE[m].label}
              </button>
            ))}
          </div>
        }
      >
        <ScopeCanvas engine={engine} running={running} mode={trace} />
        <div className="sp-corr">
          <b className="sp-mono">{frame.correlation.toFixed(2)}</b>
          <span>phase correlation</span>
          <span style={{ marginLeft: "auto" }} className="sp-tag">{frame.stereo.toFixed(0)} % side</span>
        </div>
        <div className="sp-corr-track">
          <i style={{ left: `${clamp((frame.correlation + 1) * 50, 0, 100)}%` }} />
        </div>
        <p className="sp-note">The dashed diagonal is a perfectly correlated mono source. An upright oval is wide stereo; a leaning figure means the legs are out of phase.</p>
      </Card>

      <Card className="sp-col-5" title="LUFS trend · 60 s" subtitle="Momentary · short-term · integrated vs target">
        <LufsChart engine={engine} running={running} target={p.target} />
        <div className="sp-legend" style={{ marginTop: 8 }}>
          <span><i style={{ background: "#22d3ee" }} />Short-term</span>
          <span><i style={{ background: "rgba(34,211,238,.5)" }} />Momentary</span>
          <span><i style={{ background: "#93c5fd" }} />Integrated</span>
          <span><i style={{ background: "#fbbf24" }} />Target {p.target.toFixed(1)}</span>
        </div>
        <div className="sp-kv" style={{ marginTop: 10 }}><span>Momentary</span><b className="sp-mono">{frame.momentary.toFixed(1)} LUFS</b></div>
        <div className="sp-kv"><span>Short-term</span><b className="sp-mono">{frame.shortTerm.toFixed(1)} LUFS</b></div>
        <div className="sp-kv"><span>Integrated</span><b className="sp-mono">{frame.integrated.toFixed(1)} LUFS</b></div>
        <div className="sp-kv"><span>Against target</span><b className="sp-mono">{fmtSigned(delta)} LU</b></div>
      </Card>
    </div>
  );
}

function MorphPanel({
  p, morph, setMorph, a, b, captureA, captureB, swap, loadPreset,
}: PanelCtx & {
  morph: number;
  setMorph: (v: number) => void;
  a: Params;
  b: Params;
  captureA: () => void;
  captureB: () => void;
  swap: () => void;
  loadPreset: (preset: Params) => void;
}) {
  const mixLabel = morph <= 0 ? "A" : morph >= 100 ? "B" : `${morph.toFixed(0)} %`;
  return (
    <div className="sp-grid">
      <Card className="sp-col-8" title="A/B preset crossfader" subtitle="Interpolate every parameter on air"
        right={<span className="sp-tag cyan">morph {mixLabel}</span>}>
        <div className="sp-row">
          <span className="sp-row-label">Morph<i>A → B</i></span>
          <span className="sp-val sp-mono">{morph.toFixed(0)} %</span>
          <input className="sp-slider" type="range" min={0} max={100} step={1} value={morph}
            aria-label="Morph between preset A and preset B"
            onChange={(e) => setMorph(Number(e.target.value))} />
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
          <button type="button" className="sp-btn" onClick={() => setMorph(0)}>← Preset A</button>
          <button type="button" className="sp-btn" onClick={() => setMorph(100)}>Preset B →</button>
          <button type="button" className="sp-btn" onClick={swap}>Swap A / B</button>
          <button type="button" className="sp-btn" onClick={captureA}>Capture into A</button>
          <button type="button" className="sp-btn" onClick={captureB}>Capture into B</button>
        </div>
        <p className="sp-note">
          The morph interpolates every numeric parameter — thresholds, ratios, timings,
          sub drive, width, ceiling — and crossfades the switches at the midpoint.
          Moving the slider writes the blended set straight to the live graph.
        </p>
        <div className="sp-grid" style={{ marginTop: 12 }}>
          {[{ key: "A", preset: a }, { key: "B", preset: b }].map(({ key, preset }) => (
            <div className="sp-col-6" key={key}>
              <div className="sp-band">
                <div className="sp-band-head"><b>Preset {key}</b><span className="sp-mono">{preset.target.toFixed(1)} LUFS</span></div>
                <div className="sp-kv"><span>AGC</span><b className="sp-mono">{preset.agcThresholdDb.toFixed(0)} dB · {preset.agcRatio.toFixed(1)}:1</b></div>
                <div className="sp-kv"><span>De-clip</span><b className="sp-mono">{preset.declipDriveDb.toFixed(1)} dB drive</b></div>
                <div className="sp-kv"><span>Sub</span><b className="sp-mono">{preset.subDrive.toFixed(0)} % · {preset.subCutoff.toFixed(0)} Hz</b></div>
                <div className="sp-kv"><span>Width</span><b className="sp-mono">{preset.width.toFixed(0)} %</b></div>
                <div className="sp-kv"><span>Ceiling</span><b className="sp-mono">{preset.ceilingDb.toFixed(1)} dBTP</b></div>
              </div>
            </div>
          ))}
        </div>
      </Card>

      <Card className="sp-col-4" title="Preset library" subtitle="Broadcast starting points">
        <div className="sp-stack">
          {PRESET_LIBRARY.map((preset) => (
            <button key={preset.name} type="button" className="sp-btn" style={{ justifyContent: "space-between", height: 40 }}
              onClick={() => loadPreset(preset.params)}>
              <span>{preset.name}</span>
              <span style={{ color: "var(--mut)", letterSpacing: ".04em", textTransform: "none", fontSize: 9 }}>{preset.note}</span>
            </button>
          ))}
        </div>
        <p className="sp-note">Loading a preset writes it into the live chain and into preset A, so the morph always has a musical starting point.</p>
        <div className="sp-kv"><span>Live target</span><b className="sp-mono">{p.target.toFixed(1)} LUFS</b></div>
        <div className="sp-kv"><span>A target</span><b className="sp-mono">{a.target.toFixed(1)} LUFS</b></div>
        <div className="sp-kv"><span>B target</span><b className="sp-mono">{b.target.toFixed(1)} LUFS</b></div>
      </Card>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────────
 * Page
 * ────────────────────────────────────────────────────────────────────────── */

const TABS: { id: TabId; label: string }[] = [
  { id: "input", label: "Input / Preamp" },
  { id: "restore", label: "Restoration" },
  { id: "agc", label: "AGC & Leveller" },
  { id: "enhance", label: "Enhancers & Sub" },
  { id: "multiband", label: "Multiband 5-Band" },
  { id: "output", label: "Limiter & Output" },
  { id: "stream", label: "Streaming & Automation" },
  { id: "scope", label: "Telemetry Scope" },
  { id: "presets", label: "Preset Morph" },
];

const CHAIN = [
  "INPUT", "PREAMP", "DE-CLIPPER", "AGC", "SUB-BASS", "DYN-EQ",
  "MULTIBAND", "TRANSIENT", "LIMITER", "OUTPUT",
];

const TAB_STAGES: Record<TabId, string[]> = {
  input: ["INPUT", "PREAMP"],
  restore: ["DE-CLIPPER"],
  agc: ["AGC"],
  enhance: ["SUB-BASS", "TRANSIENT"],
  multiband: ["MULTIBAND"],
  output: ["LIMITER", "OUTPUT"],
  stream: ["LIMITER", "OUTPUT"],
  scope: [],
  presets: [],
};

export default function Studio() {
  const engineRef = useRef<StudioEngine | null>(null);
  const paramsRef = useRef<Params>(PRESET_A);
  const [p, setP] = useState<Params>(loadParams);
  const [presetA, setPresetA] = useState<Params>(PRESET_A);
  const [presetB, setPresetB] = useState<Params>(PRESET_B);
  const [morph, setMorphState] = useState(0);
  const [tab, setTab] = useState<TabId>("input");
  const [running, setRunning] = useState(false);
  const [engine, setEngine] = useState<StudioEngine | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [source, setSourceState] = useState<SourceMode>("demo");
  const [frame, setFrame] = useState<Frame>(EMPTY_FRAME);
  const [trace, setTrace] = useState<TraceMode>("cyan");
  const [silenceAck, setSilenceAck] = useState(false);

  // keep the engine in step with the control surface
  useEffect(() => {
    paramsRef.current = p;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
    } catch {
      /* storage may be unavailable */
    }
    const engine = engineRef.current;
    if (engine) {
      engine.setControlState(p);
      engine.apply(p);
    }
  }, [p]);

  // meter refresh — 10 Hz keeps React out of the audio path
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => {
      const live = engineRef.current;
      if (!live) return;
      setFrame({ ...live.frame, bandGr: live.frame.bandGr.slice() });
      // a new silence episode re-arms the banner that was acknowledged
      if (live.frame.silenceMs === 0) setSilenceAck(false);
    }, 100);
    return () => window.clearInterval(id);
  }, [running]);

  useEffect(() => {
    return () => {
      engineRef.current?.dispose();
      engineRef.current = null;
    };
  }, []);

  const start = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (!engineRef.current) {
        const created = new StudioEngine();
        engineRef.current = created;
        setEngine(created);
      }
      const live = engineRef.current;
      live.setControlState(paramsRef.current);
      live.apply(paramsRef.current);
      await live.start(source);
      setRunning(true);
    } catch (err) {
      setError(
        err instanceof Error
          ? `${err.message}${source === "mic" ? " — switching back to the demo program" : ""}`
          : "The audio device could not be started.",
      );
      try {
        const live = engineRef.current;
        if (live && source === "mic") {
          // the mic request failed after the demo source was stopped — bring
          // the demo back up, timer included, so the panel is not left deaf
          await live.start("demo");
          setSourceState("demo");
          setRunning(true);
        }
      } catch {
        setRunning(false);
      }
    } finally {
      setBusy(false);
    }
  };

  const stop = () => {
    engineRef.current?.suspend();
    setRunning(false);
    setFrame(EMPTY_FRAME);
  };

  const setSource = (next: SourceMode) => {
    setSourceState(next);
    const engine = engineRef.current;
    if (!engine || !running) return;
    setError(null);
    void engine
      .setSource(next)
      .catch(async (err: unknown) => {
        setError(
          err instanceof Error
            ? `${err.message} — switching back to the demo program`
            : "Microphone unavailable — switching back to the demo program",
        );
        setSourceState("demo");
        try {
          await engine.setSource("demo");
        } catch {
          setRunning(false);
        }
      });
  };

  const setParam = <K extends keyof Params>(key: K, value: Params[K]) => {
    setP((prev) => ({ ...prev, [key]: value }));
  };

  const setBand = (band: BandId, key: keyof BandParams, value: number) => {
    setP((prev) => ({
      ...prev,
      bands: { ...prev.bands, [band]: { ...prev.bands[band], [key]: value } },
    }));
  };

  const setMorph = (value: number) => {
    setMorphState(value);
    setP(morphParams(presetA, presetB, value / 100));
  };

  const captureA = () => {
    setPresetA(p);
    setMorph(0);
  };
  const captureB = () => {
    setPresetB(p);
    setMorph(100);
  };
  const swap = () => {
    setPresetA(presetB);
    setPresetB(presetA);
    setMorph(100 - morph);
  };
  const loadPreset = (preset: Params) => {
    setPresetA(preset);
    setP(preset);
    setMorphState(0);
  };

  const silence = running && frame.silenceMs >= 3000;
  const panelCtx: PanelCtx = {
    p,
    frame,
    running,
    source,
    sampleRate: engine?.sampleRate ?? 48000,
    error,
    setParam,
    setBand,
    setSource,
  };

  const meters = useMemo<
    { key: string; label: string; value: number; kind: MeterKind; unit: string; sub?: string }[]
  >(
    () => [
      { key: "inL", label: "IN L", value: frame.inputL, kind: "level" as MeterKind, unit: "dBFS" },
      { key: "inR", label: "IN R", value: frame.inputR, kind: "level" as MeterKind, unit: "dBFS" },
      { key: "agc", label: "AGC GR", value: frame.agcGr, kind: "gr" as MeterKind, unit: "dB" },
      { key: "hf", label: "HF", value: frame.hf, kind: "pct" as MeterKind, unit: "%" },
      { key: "stereo", label: "STEREO", value: frame.stereo, kind: "pct" as MeterKind, unit: "%" },
      ...BANDS.map((band, i) => ({
        key: band.id,
        label: band.label,
        value: frame.bandGr[i] ?? 0,
        kind: "gr" as MeterKind,
        unit: "dB",
        sub: `${band.label} · ${band.span}`,
      })),
      { key: "limit", label: "LIMIT", value: frame.limiterGr, kind: "gr" as MeterKind, unit: "dB" },
      { key: "tp", label: "TRUE PK", value: frame.truePeak, kind: "peak" as MeterKind, unit: "dBTP" },
      { key: "outL", label: "OUT L", value: frame.outL, kind: "level" as MeterKind, unit: "dBFS" },
      { key: "outR", label: "OUT R", value: frame.outR, kind: "level" as MeterKind, unit: "dBFS" },
    ],
    [frame],
  );

  const renderPanel = () => {
    switch (tab) {
      case "input":
        return <InputPanel {...panelCtx} />;
      case "restore":
        return <RestorationPanel {...panelCtx} />;
      case "agc":
        return <AgcPanel {...panelCtx} />;
      case "enhance":
        return <EnhancePanel {...panelCtx} />;
      case "multiband":
        return <MultibandPanel {...panelCtx} />;
      case "output":
        return <OutputPanel {...panelCtx} />;
      case "stream":
        return <StreamPanel {...panelCtx} />;
      case "scope":
        return (
          <ScopePanel
            {...panelCtx}
            engine={engine}
            trace={trace}
            setTrace={setTrace}
          />
        );
      case "presets":
        return (
          <MorphPanel
            {...panelCtx}
            morph={morph}
            setMorph={setMorph}
            a={presetA}
            b={presetB}
            captureA={captureA}
            captureB={captureB}
            swap={swap}
            loadPreset={loadPreset}
          />
        );
      default:
        return null;
    }
  };

  return (
    <div className="sp-root">
      <style>{CSS}</style>
      <div className="sp-shell">
        <header className="sp-head">
          <div className="sp-brand">
            <span className="sp-mark">
              <svg viewBox="0 0 24 24" fill="none" stroke="#7ef0ff" strokeWidth="1.6">
                <path d="M2 12h3l2-6 3 12 3-9 2 5 2-2h5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            <div>
              <div className="sp-title">SIGNALPATH</div>
              <div className="sp-sub">SP-9600 · ADVANCED BROADCAST PROCESSOR</div>
            </div>
          </div>

          <div className="sp-head-right">
            <label className="sp-badge" style={{ gap: 7 }}>
              <span style={{ letterSpacing: ".14em" }}>Target</span>
              <select
                className="sp-select"
                aria-label="Loudness target"
                value={p.target}
                onChange={(e) => setParam("target", Number(e.target.value))}
              >
                <option value={-14}>−14.0 LUFS</option>
                <option value={-16}>−16.0 LUFS</option>
                <option value={-23}>−23.0 LUFS</option>
              </select>
            </label>
            <span className="sp-badge">
              <span className={`sp-led ${silence ? "hot" : running ? "on" : ""}`} />
              {silence ? "silence" : running ? "on air" : "standby"}
            </span>
            <span className="sp-badge">
              <b className="sp-mono">{frame.shortTerm.toFixed(1)}</b> LUFS
            </span>
            {running ? (
              <button type="button" className="sp-btn danger" onClick={stop}>
                Stop
              </button>
            ) : (
              <button type="button" className="sp-btn primary" onClick={() => void start()} disabled={busy}>
                {busy ? "Starting…" : "Start engine"}
              </button>
            )}
          </div>
        </header>

        <div className="sp-path">
          {CHAIN.map((stage, i) => (
            <span key={stage} style={{ display: "inline-flex", alignItems: "center" }}>
              {i > 0 ? <span className="sp-arrow">›</span> : null}
              <span className={`sp-stage${TAB_STAGES[tab].includes(stage) ? " active" : ""}`}>
                <b>{String(i + 1).padStart(2, "0")}</b>
                {stage}
              </span>
            </span>
          ))}
        </div>

        <section className="sp-deck">
          <div className="sp-deck-top">
            <span className="sp-deck-title"><b>Meter bridge</b> · peak · gain reduction · enhancement</span>
            <span style={{ marginLeft: "auto", display: "flex", gap: 10, alignItems: "center" }}>
              <span className="sp-deck-title">
                corr <b className="sp-mono">{frame.correlation.toFixed(2)}</b>
              </span>
              <span className="sp-deck-title">
                true peak <b className="sp-mono">{frame.truePeak.toFixed(1)} dBTP</b>
              </span>
              <span className="sp-deck-title">
                <b className="sp-mono">{p.target.toFixed(1)}</b> LUFS target
              </span>
              {p.codec !== "off" ? (
                <span className="sp-tag cyan">preview {CODEC_PROFILES[p.codec].bitrate}k</span>
              ) : null}
              {frame.backup ? <span className="sp-tag amber">backup on air</span> : null}
              {frame.talent ? <span className="sp-tag amber">talent monitor</span> : null}
            </span>
          </div>
          <div className="sp-meters">
            {meters.map((m) => (
              <LedMeter key={m.key} label={m.label} sub={m.sub} value={m.value} kind={m.kind} unit={m.unit} />
            ))}
          </div>
        </section>

        {silence && !silenceAck ? (
          <div className="sp-alarm" role="alert">
            <span className="sp-led hot" />
            <b>Silence gate</b>
            <span>
              no program above −55 dBFS for{" "}
              <span className="sp-mono">{(frame.silenceMs / 1000).toFixed(1)} s</span> — check the
              source before the transmitter
            </span>
            <button type="button" className="sp-btn" onClick={() => setSilenceAck(true)}>
              Acknowledge
            </button>
          </div>
        ) : null}

        {error ? <div className="sp-err">{error}</div> : null}

        {!running ? (
          <div className="sp-hint">
            <span className="sp-led warn" />
            Engine idle. Press <b style={{ margin: "0 4px" }}>Start engine</b> to open the audio
            device — browsers require a gesture before audio can run.
          </div>
        ) : null}

        <nav className="sp-tabs" aria-label="Processor sections">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`sp-tab${tab === t.id ? " active" : ""}`}
              aria-current={tab === t.id ? "page" : undefined}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>

        <main className="sp-work">{renderPanel()}</main>

        <footer className="sp-foot">
          <span><b>Chain</b> {CHAIN.join(" → ")}</span>
          <span><b>Engine</b> Web Audio · 48 kHz</span>
          <span><b>Latency</b> {running && engine ? `${engine.latencyMs().toFixed(1)} ms` : "—"}</span>
          <span><b>Loudness</b> {p.target.toFixed(1)} LUFS</span>
          <span style={{ marginLeft: "auto" }}>SIGNALPATH · SP-9600</span>
        </footer>
      </div>
    </div>
  );
}
