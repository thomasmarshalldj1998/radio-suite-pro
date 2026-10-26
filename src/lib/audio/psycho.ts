/**
 * Psychoacoustic parameter layer — SignalPath v3.0.
 *
 * Every module defaults BYPASSED / NEUTRAL: merging DEFAULT_PSY changes
 * nothing audible. Modules marked LIVE are applied by the engine; modules
 * marked STORED are parameter-complete (persisted, preset-safe) with engine
 * DSP arriving in staged rollout — enabling a STORED module today is a
 * no-op by design, never a silent fake.
 *
 * Status per module lives in PSY_STATUS below and is surfaced in the UI as
 * a Live/Stored dot next to each panel title.
 */
import type { MeterSnapshot } from "./engine";

export type LatencyMode = "low" | "balanced" | "max";

/** Engine-application status of each psychoacoustic module. */
export const PSY_STATUS: Record<string, "live" | "stored"> = {
  latency: "live",
  tilt: "live",
  preEmphasis: "stored",
  declipper: "live",
  dehummer: "stored",
  artifact: "stored",
  clock: "stored",
  xtalk: "stored",
  dualAgc: "stored",
  vocal: "stored",
  energy: "stored",
  density: "stored",
  loudStab: "stored",
  linEq: "stored",
  dynEq: "stored",
  matchEq: "stored",
  cohWidth: "live",
  bassSynth: "live",
  align: "stored",
  msTrim: "live",
  linXover: "stored",
  maskComp: "stored",
  antiPump: "stored",
  transEmph: "stored",
  knee: "stored",
  limStages: "stored",
  dither: "stored",
  loudLock: "live",
  tpGuard: "stored",
  codecPre: "stored",
  metadata: "stored",
};

export interface DeclipperParams {
  on: boolean;
  sensitivity: number;
  reconstruct: number;
}
export interface DehummerParams {
  on: boolean;
  freqHz: 50 | 60 | 100 | 120;
  harmonics: number;
  depth: number;
}
export type ArtifactMode = "off" | "light" | "medium" | "heavy" | "auto";
export interface ArtifactParams {
  mode: ArtifactMode;
  smooth: number;
}
export interface XtalkParams {
  on: boolean;
  lrDb: number;
  rlDb: number;
}
export interface DualAgcParams {
  on: boolean;
  fastAttackMs: number;
  slowAttackMs: number;
  link: number;
}
export interface VocalParams {
  on: boolean;
  preserve: number;
  separation: number;
}
export interface EnergyParams {
  on: boolean;
  bassDb: number;
  trebleDb: number;
  autoComp: boolean;
}
export interface DensityParams {
  on: boolean;
  density: number;
  openness: number;
}
export type StabWindow = "10s" | "30s" | "2min" | "5min";
export interface LoudStabParams {
  on: boolean;
  window: StabWindow;
}
export interface LinEqBand {
  gainDb: number;
  q: number;
}
export interface LinEqParams {
  on: boolean;
  bands: LinEqBand[];
}
export interface DynEqParams {
  on: boolean;
  thresholdDb: number;
  ratio: number;
  attackMs: number;
  releaseMs: number;
}
export interface MatchEqParams {
  on: boolean;
  toleranceDb: number;
  captured: number[] | null;
}
export interface TiltParams {
  on: boolean;
  slopeDb: number;
}
export interface CohWidthParams {
  on: boolean;
  bands: [number, number, number, number, number];
  corrGuard: number;
}
export interface BassSynthParams {
  on: boolean;
  fundHz: number;
  harmMix: number;
  depth: number;
}
export interface AlignParams {
  on: boolean;
  offsetMs: number;
  rotateDeg: number;
  gdCorr: boolean;
}
export interface MsTrimParams {
  on: boolean;
  midDb: number;
  sideDb: number;
  sideHpfHz: number;
}
export interface MaskCompParams {
  on: boolean;
  strength: number;
  transient: number;
}
export interface AntiPumpParams {
  on: boolean;
  damping: number;
  bassSuppress: number;
}
export interface TransEmphParams {
  on: boolean;
  recovery: number;
  windowMs: number;
}
export type KneeShape = "hard" | "soft" | "adaptive";
export interface LimStagesParams {
  fastOn: boolean;
  lookaheadMs: number;
  ceilingDb: number;
  attackMs: number;
  maskOn: boolean;
  tpOversample: 2 | 8 | 16;
  ispOn: boolean;
  compositeProtect: boolean;
  multipath: number;
  blend: number;
}
export type DitherType = "tpdf" | "rpdf" | "weighted";
export interface DitherParams {
  on: boolean;
  type: DitherType;
  bits: 16 | 24 | 32;
}
export interface LoudLockParams {
  on: boolean;
  targetLufs: -14 | -16 | -18 | -23;
  gateDb: number;
}
export type CodecTarget = "auto" | "mp3" | "heaac" | "opus";
export interface CodecPreParams {
  on: boolean;
  target: CodecTarget;
  hfPreserve: number;
}

export interface PsyParams {
  latency: LatencyMode;
  declipper: DeclipperParams;
  dehummer: DehummerParams;
  artifact: ArtifactParams;
  clockLock: "auto" | "manual";
  clockDrift: boolean;
  xtalk: XtalkParams;
  dualAgc: DualAgcParams;
  vocal: VocalParams;
  energy: EnergyParams;
  density: DensityParams;
  loudStab: LoudStabParams;
  fatigueWarn: number;
  linEq: LinEqParams;
  dynEq: DynEqParams;
  matchEq: MatchEqParams;
  /** LIVE — perceptual spectral tilt (±3 dB pivot 1 kHz). */
  tilt: TiltParams;
  /** STORED — transmission pre-emphasis curve select. Off = flat. */
  preEmphasis: "off" | "50" | "75" | "j17" | "flat";
  cohWidth: CohWidthParams;
  bassSynth: BassSynthParams;
  align: AlignParams;
  msTrim: MsTrimParams;
  linXover: boolean;
  maskComp: MaskCompParams;
  antiPump: AntiPumpParams;
  transEmph: TransEmphParams;
  kneeShape: KneeShape;
  kneeAmount: number;
  limStages: LimStagesParams;
  dither: DitherParams;
  loudLock: LoudLockParams;
  tpCeilingDb: -0.1 | -0.5 | -1.0 | -2.0;
  codecPre: CodecPreParams;
  metaIntervalS: number;
  metaEncoding: "utf8" | "latin1";
}

/** All modules bypassed / neutral — zero audible change. */
export const DEFAULT_PSY: PsyParams = {
  latency: "balanced",
  declipper: { on: false, sensitivity: 50, reconstruct: 50 },
  dehummer: { on: false, freqHz: 50, harmonics: 4, depth: 50 },
  artifact: { mode: "off", smooth: 50 },
  clockLock: "auto",
  clockDrift: false,
  xtalk: { on: false, lrDb: -60, rlDb: -60 },
  dualAgc: { on: false, fastAttackMs: 8, slowAttackMs: 120, link: 50 },
  vocal: { on: false, preserve: 70, separation: 50 },
  energy: { on: false, bassDb: 0, trebleDb: 0, autoComp: true },
  density: { on: false, density: 50, openness: 50 },
  loudStab: { on: false, window: "30s" },
  fatigueWarn: 75,
  linEq: {
    on: false,
    bands: Array.from({ length: 10 }, () => ({ gainDb: 0, q: 1.0 })),
  },
  dynEq: { on: false, thresholdDb: -20, ratio: 2, attackMs: 15, releaseMs: 80 },
  matchEq: { on: false, toleranceDb: 0.5, captured: null },
  tilt: { on: false, slopeDb: 0 },
  preEmphasis: "off",
  cohWidth: { on: false, bands: [1, 1, 1, 1, 1], corrGuard: 0.95 },
  bassSynth: { on: false, fundHz: 70, harmMix: 10, depth: 50 },
  align: { on: false, offsetMs: 0, rotateDeg: 0, gdCorr: false },
  msTrim: { on: false, midDb: 0, sideDb: 0, sideHpfHz: 400 },
  linXover: false,
  maskComp: { on: false, strength: 50, transient: 70 },
  antiPump: { on: false, damping: 50, bassSuppress: 50 },
  transEmph: { on: false, recovery: 50, windowMs: 4 },
  kneeShape: "soft",
  kneeAmount: 50,
  limStages: {
    fastOn: false,
    lookaheadMs: 2,
    ceilingDb: -1.0,
    attackMs: 3,
    maskOn: false,
    tpOversample: 8,
    ispOn: true,
    compositeProtect: true,
    multipath: 50,
    blend: 50,
  },
  dither: { on: false, type: "tpdf", bits: 24 },
  loudLock: { on: false, targetLufs: -14, gateDb: -10 },
  tpCeilingDb: -1.0,
  codecPre: { on: false, target: "auto", hfPreserve: 70 },
  metaIntervalS: 5,
  metaEncoding: "utf8",
};

/** True when any engine-affecting psychoacoustic control is engaged. */
export function psyEngaged(p: PsyParams): boolean {
  return (
    p.latency !== "balanced" ||
    p.tilt.on ||
    p.preEmphasis !== "off" ||
    p.declipper.on ||
    p.dehummer.on ||
    p.artifact.mode !== "off" ||
    p.clockDrift ||
    p.xtalk.on ||
    p.dualAgc.on ||
    p.vocal.on ||
    p.energy.on ||
    p.density.on ||
    p.loudStab.on ||
    p.linEq.on ||
    p.dynEq.on ||
    p.matchEq.on ||
    p.cohWidth.on ||
    p.bassSynth.on ||
    p.align.on ||
    p.msTrim.on ||
    p.maskComp.on ||
    p.antiPump.on ||
    p.transEmph.on ||
    p.limStages.fastOn ||
    p.limStages.maskOn ||
    p.dither.on ||
    p.loudLock.on ||
    p.codecPre.on
  );
}

export interface PerceptualMetrics {
  /** 0–100 listening-fatigue estimate (documented heuristic, not a standard). */
  fatigue: number;
  /** 0–100 clarity estimate from crest factor + HF headroom. */
  clarity: number;
  /** 0–100 spatial coherence from the correlation meter. */
  coherence: number;
  /** Crest factor (sample peak − short-term LUFS). */
  crestDb: number;
  /** Speech/music/mixed guess + confidence — heuristic, labelled as such. */
  sourceGuess: { kind: "speech" | "music" | "mixed"; confidence: number };
}

/**
 * Honest derived metrics from the live meter snapshot plus the operator's
 * own density/exciter settings. Fatigue/clarity are house heuristics
 * (0–100) — the UI labels them estimates, never standards.
 */
export function perceptualMetrics(
  snap: MeterSnapshot,
  density: number,
  exciterMix: number,
): PerceptualMetrics {
  const crest = snap.samplePeakDb - snap.lufsS;
  const crestC = Math.min(24, Math.max(4, Number.isFinite(crest) ? crest : 12));
  const grAvg =
    snap.gr.bands.length > 0
      ? snap.gr.bands.reduce((a, b) => a + Math.abs(b), 0) /
        snap.gr.bands.length
      : 0;
  const fatigue = Math.min(
    100,
    Math.max(
      0,
      46 + (density - 5) * 5 + exciterMix * 18 + grAvg * 1.6 - (crestC - 12) * 2.2,
    ),
  );
  const clarity = Math.min(
    100,
    Math.max(0, 52 + (crestC - 12) * 2.4 - grAvg * 1.2 - exciterMix * 8),
  );
  const coherence = Math.min(
    100,
    Math.max(0, Math.round(((snap.correlation + 1) / 2) * 100)),
  );
  // speech: low crest + high coherence; music: high crest + wide image.
  const speechScore = (1 - (crestC - 4) / 20) * 0.6 + (coherence / 100) * 0.4;
  const kind =
    speechScore > 0.62 ? "speech" : speechScore < 0.42 ? "music" : "mixed";
  const confidence = Math.round(
    (kind === "mixed"
      ? 1 - Math.abs(speechScore - 0.52) * 3
      : Math.abs(speechScore - 0.52) * 2) *
      100,
  );
  return {
    fatigue: Math.round(fatigue),
    clarity: Math.round(clarity),
    coherence,
    crestDb: Math.round(crestC * 10) / 10,
    sourceGuess: {
      kind,
      confidence: Math.min(95, Math.max(35, confidence)),
    },
  };
}
