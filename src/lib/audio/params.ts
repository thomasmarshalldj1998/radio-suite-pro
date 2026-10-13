/**
 * Processor parameter model for the Signalpath broadcast chain:
 *
 *   input gain → HPF → 6-band EQ → dynamic EQ (3 subtractive bands) →
 *   6-band multiband compressor (LR4 crossovers) → program AGC →
 *   composite limiter (fast peak stage + per-sample ceiling guard) →
 *   output gain → (monitor + encoder send)
 */

export interface EqBand {
  freq: number;
  gainDb: number;
  q: number;
  type: "lowshelf" | "peaking" | "highshelf";
}

export interface BandCompParams {
  thresholdDb: number;
  ratio: number;
  attackMs: number;
  releaseMs: number;
  makeupDb: number;
}

/** One dynamic-EQ band: cut the band (up to maxCutDb) when it exceeds threshold. */
export interface DeqBand {
  freqHz: number;
  thresholdDb: number;
  maxCutDb: number;
  attackMs: number;
  releaseMs: number;
}

/**
 * Loudness rider — the Compellor-style leveler / AERO.lite long-term
 * controller. Slow K-weighted gain ride toward a target loudness, bounded
 * by maxRideDb, with a silence gate so pauses never ride noise up.
 */
export interface RiderParams {
  on: boolean;
  targetLufs: number;
  maxRideDb: number;
  /** "fast" ≈ Compellor fast leveler (1.5 s down / 3 s up), "slow" ≈ 5 s / 10 s. */
  speed: "fast" | "slow";
}

export type MultibandSplits = [number, number, number, number, number];
export type MultibandBands = [
  BandCompParams,
  BandCompParams,
  BandCompParams,
  BandCompParams,
  BandCompParams,
  BandCompParams,
];
export type DeqBands = [DeqBand, DeqBand, DeqBand];

export interface ProcessorParams {
  inputGainDb: number;
  hpf: { on: boolean; freqHz: number };
  eq: { on: boolean; bands: EqBand[] };
  deq: { on: boolean; bands: DeqBands };
  multiband: {
    on: boolean;
    splitsHz: MultibandSplits;
    bands: MultibandBands;
  };
  agc: {
    on: boolean;
    thresholdDb: number;
    ratio: number;
    kneeDb: number;
    attackMs: number;
    releaseMs: number;
    makeupDb: number;
  };
  limiter: {
    on: boolean;
    ceilingDb: number;
    attackMs: number;
    releaseMs: number;
  };
  /** M/S stereo width: 1 = neutral, >1 widens the side channel. */
  stereo: { width: number };
  /** Parallel harmonic exciter (Aphex-style sweetening). */
  exciter: { on: boolean; mix: number; freqHz: number };
  rider: RiderParams;
  outputGainDb: number;
  monitorDb: number;
  duckDb: number;
}

export const EQ_FREQS = [60, 200, 700, 2500, 6000, 12000] as const;
export const MB_LABELS = ["Low", "Lo-mid", "Mid", "Hi-mid", "High", "Air"] as const;
export const DEQ_LABELS = ["Mud", "Presence", "De-ess"] as const;
export const LUFS_TARGET = -23;
export const TRUE_PEAK_TARGET = -1;

/** Default crossover split points for the 6-band matrix (Hz). */
export const DEFAULT_SPLITS: MultibandSplits = [140, 450, 1800, 4500, 9000];

export const DEFAULT_PARAMS: ProcessorParams = {
  inputGainDb: 0,
  hpf: { on: true, freqHz: 80 },
  eq: {
    on: true,
    bands: [
      { freq: 60, gainDb: 0, q: 0.7, type: "lowshelf" },
      { freq: 200, gainDb: 0, q: 1.0, type: "peaking" },
      { freq: 700, gainDb: 0, q: 1.0, type: "peaking" },
      { freq: 2500, gainDb: 1.5, q: 1.2, type: "peaking" },
      { freq: 6000, gainDb: 0, q: 1.4, type: "peaking" },
      { freq: 12000, gainDb: 0, q: 0.7, type: "highshelf" },
    ],
  },
  deq: {
    on: true,
    bands: [
      { freqHz: 120, thresholdDb: -20, maxCutDb: 6, attackMs: 10, releaseMs: 250 },
      { freqHz: 3200, thresholdDb: -18, maxCutDb: 5, attackMs: 6, releaseMs: 180 },
      { freqHz: 8000, thresholdDb: -22, maxCutDb: 8, attackMs: 4, releaseMs: 120 },
    ],
  },
  multiband: {
    on: true,
    splitsHz: [...DEFAULT_SPLITS] as MultibandSplits,
    bands: [
      { thresholdDb: -12, ratio: 4, attackMs: 15, releaseMs: 300, makeupDb: 2 },
      { thresholdDb: -13, ratio: 4, attackMs: 10, releaseMs: 280, makeupDb: 2 },
      { thresholdDb: -14, ratio: 3.5, attackMs: 8, releaseMs: 250, makeupDb: 1.5 },
      { thresholdDb: -15, ratio: 3, attackMs: 5, releaseMs: 220, makeupDb: 1.5 },
      { thresholdDb: -16, ratio: 3, attackMs: 3, releaseMs: 180, makeupDb: 1.5 },
      { thresholdDb: -17, ratio: 3, attackMs: 2, releaseMs: 150, makeupDb: 1 },
    ],
  },
  agc: {
    on: true,
    thresholdDb: -18,
    ratio: 3,
    kneeDb: 6,
    attackMs: 15,
    releaseMs: 400,
    makeupDb: 4,
  },
  limiter: { on: true, ceilingDb: -1, attackMs: 1.5, releaseMs: 100 },
  stereo: { width: 1 },
  exciter: { on: false, mix: 3, freqHz: 3200 },
  rider: { on: false, targetLufs: LUFS_TARGET, maxRideDb: 8, speed: "fast" },
  outputGainDb: 0,
  monitorDb: -6,
  duckDb: 12,
};

export interface BuiltinPreset {
  id: string;
  name: string;
  description: string;
  tags: string[];
  /** Optional preset family override (e.g. "Reference" chains). */
  family?: string;
  params: ProcessorParams;
}

const merge = (patch: Partial<ProcessorParams>): ProcessorParams =>
  coerceParams({ ...structuredClone(DEFAULT_PARAMS), ...patch });

/**
 * Expand a 3-way broadcast tuning (low / mid / high specs) into the 6-band
 * matrix. The upper half of each legacy lane gets slightly faster timing and
 * a 1 dB lower threshold so the matrix behaves like a finer version of the
 * 3-band chain it replaces.
 */
function mb6(
  low: BandCompParams,
  mid: BandCompParams,
  high: BandCompParams,
  splitsHz: MultibandSplits = DEFAULT_SPLITS,
): ProcessorParams["multiband"] {
  const b = (
    base: BandCompParams,
    patch: Partial<BandCompParams>,
  ): BandCompParams => ({ ...base, ...patch });
  return {
    on: true,
    splitsHz: [...splitsHz] as MultibandSplits,
    bands: [
      b(low, {}),
      b(low, {
        thresholdDb: low.thresholdDb - 1,
        attackMs: Math.max(0.5, +(low.attackMs * 0.6).toFixed(1)),
        releaseMs: Math.round(low.releaseMs * 0.85),
      }),
      b(mid, {}),
      b(mid, {
        thresholdDb: mid.thresholdDb - 1,
        attackMs: Math.max(0.5, +(mid.attackMs * 0.6).toFixed(1)),
      }),
      b(high, { attackMs: Math.max(0.5, +(high.attackMs * 0.8).toFixed(1)) }),
      b(high, {
        thresholdDb: high.thresholdDb - 1,
        attackMs: Math.max(0.5, +(high.attackMs * 0.5).toFixed(1)),
      }),
    ],
  };
}

/** Built-in broadcast presets — full parameter snapshots of the chain. */
export const BUILTIN_PRESETS: BuiltinPreset[] = [
  {
    id: "broadcast-fm",
    name: "Broadcast Standard FM",
    description:
      "Balanced on-air chain: gentle levelling, musical 6-band dynamics, dynamic-EQ hygiene, −1 dBTP ceiling.",
    tags: ["General", "Stereo", "−23 LUFS"],
    params: structuredClone(DEFAULT_PARAMS),
  },
  {
    id: "talk-radio",
    name: "Talk Radio Voice",
    description:
      "Fast program levelling with presence lift and an assertive de-esser for speech-heavy formats.",
    tags: ["Speech", "Fast AGC", "De-ess"],
    params: merge({
      hpf: { on: true, freqHz: 120 },
      eq: {
        on: true,
        bands: [
          { freq: 60, gainDb: -2, q: 0.7, type: "lowshelf" },
          { freq: 200, gainDb: -1.5, q: 1.0, type: "peaking" },
          { freq: 700, gainDb: 0, q: 1.0, type: "peaking" },
          { freq: 2500, gainDb: 4, q: 1.1, type: "peaking" },
          { freq: 6000, gainDb: -2.5, q: 2.2, type: "peaking" },
          { freq: 12000, gainDb: 1, q: 0.7, type: "highshelf" },
        ],
      },
      deq: {
        on: true,
        bands: [
          { freqHz: 130, thresholdDb: -22, maxCutDb: 6, attackMs: 10, releaseMs: 250 },
          { freqHz: 3000, thresholdDb: -18, maxCutDb: 6, attackMs: 6, releaseMs: 170 },
          { freqHz: 6500, thresholdDb: -24, maxCutDb: 10, attackMs: 4, releaseMs: 110 },
        ],
      },
      multiband: mb6(
        { thresholdDb: -14, ratio: 4, attackMs: 8, releaseMs: 200, makeupDb: 2 },
        { thresholdDb: -16, ratio: 4, attackMs: 3, releaseMs: 150, makeupDb: 2.5 },
        { thresholdDb: -18, ratio: 5, attackMs: 1.5, releaseMs: 120, makeupDb: 2 },
        [150, 520, 2100, 5200, 10000],
      ),
      agc: {
        on: true,
        thresholdDb: -22,
        ratio: 4.5,
        kneeDb: 4,
        attackMs: 5,
        releaseMs: 250,
        makeupDb: 6,
      },
      limiter: { on: true, ceilingDb: -1, attackMs: 1, releaseMs: 80 },
    }),
  },
  {
    id: "late-night",
    name: "Late Night Smooth",
    description:
      "Slow, transparent dynamics with a warm shelf and barely-there dynamic EQ — overnight music rotation.",
    tags: ["Music", "Transparent", "Slow"],
    params: merge({
      hpf: { on: true, freqHz: 60 },
      eq: {
        on: true,
        bands: [
          { freq: 60, gainDb: 1.5, q: 0.7, type: "lowshelf" },
          { freq: 200, gainDb: -1, q: 0.9, type: "peaking" },
          { freq: 700, gainDb: 0, q: 1.0, type: "peaking" },
          { freq: 2500, gainDb: 0, q: 1.2, type: "peaking" },
          { freq: 6000, gainDb: -1, q: 1.4, type: "peaking" },
          { freq: 12000, gainDb: 2, q: 0.7, type: "highshelf" },
        ],
      },
      deq: {
        on: true,
        bands: [
          { freqHz: 100, thresholdDb: -24, maxCutDb: 4, attackMs: 25, releaseMs: 450 },
          { freqHz: 3500, thresholdDb: -26, maxCutDb: 3, attackMs: 20, releaseMs: 400 },
          { freqHz: 9000, thresholdDb: -28, maxCutDb: 4, attackMs: 15, releaseMs: 350 },
        ],
      },
      multiband: mb6(
        { thresholdDb: -14, ratio: 2.5, attackMs: 20, releaseMs: 500, makeupDb: 1.5 },
        { thresholdDb: -16, ratio: 2, attackMs: 15, releaseMs: 450, makeupDb: 1 },
        { thresholdDb: -18, ratio: 2.5, attackMs: 8, releaseMs: 400, makeupDb: 1 },
        [120, 420, 1700, 4600, 9500],
      ),
      agc: {
        on: true,
        thresholdDb: -20,
        ratio: 2,
        kneeDb: 8,
        attackMs: 30,
        releaseMs: 600,
        makeupDb: 4,
      },
      limiter: { on: true, ceilingDb: -1.5, attackMs: 3, releaseMs: 200 },
    }),
  },
  {
    id: "chr-impact",
    name: "High-Impact CHR",
    description:
      "Dense, competitive Top-40 chain — hard 6-band multiband, deep AGC, loud but legal ceiling.",
    tags: ["Loud", "Music", "Competitive"],
    params: merge({
      hpf: { on: true, freqHz: 70 },
      eq: {
        on: true,
        bands: [
          { freq: 60, gainDb: 3, q: 0.7, type: "lowshelf" },
          { freq: 200, gainDb: -2, q: 1.1, type: "peaking" },
          { freq: 700, gainDb: 0.5, q: 1.0, type: "peaking" },
          { freq: 2500, gainDb: 2.5, q: 1.1, type: "peaking" },
          { freq: 6000, gainDb: 1, q: 1.4, type: "peaking" },
          { freq: 12000, gainDb: 2.5, q: 0.7, type: "highshelf" },
        ],
      },
      deq: {
        on: true,
        bands: [
          { freqHz: 90, thresholdDb: -18, maxCutDb: 8, attackMs: 8, releaseMs: 220 },
          { freqHz: 3200, thresholdDb: -20, maxCutDb: 6, attackMs: 5, releaseMs: 160 },
          { freqHz: 7500, thresholdDb: -22, maxCutDb: 8, attackMs: 4, releaseMs: 120 },
        ],
      },
      multiband: mb6(
        { thresholdDb: -18, ratio: 6, attackMs: 5, releaseMs: 180, makeupDb: 4 },
        { thresholdDb: -20, ratio: 5, attackMs: 3, releaseMs: 150, makeupDb: 4 },
        { thresholdDb: -20, ratio: 4, attackMs: 1.5, releaseMs: 120, makeupDb: 3 },
        [130, 480, 1900, 4800, 9500],
      ),
      agc: {
        on: true,
        thresholdDb: -24,
        ratio: 6,
        kneeDb: 3,
        attackMs: 5,
        releaseMs: 200,
        makeupDb: 8,
      },
      limiter: { on: true, ceilingDb: -0.8, attackMs: 0.8, releaseMs: 60 },
      outputGainDb: 0,
    }),
  },
  {
    id: "sports",
    name: "Sports Play-by-Play",
    description:
      "Cuts crowd rumble and horn glare, lifts commentary intelligibility, survives crowd-surge peaks.",
    tags: ["Speech", "Live", "Fast"],
    params: merge({
      hpf: { on: true, freqHz: 100 },
      eq: {
        on: true,
        bands: [
          { freq: 60, gainDb: -3, q: 0.7, type: "lowshelf" },
          { freq: 200, gainDb: -1.5, q: 1.0, type: "peaking" },
          { freq: 700, gainDb: 1, q: 1.0, type: "peaking" },
          { freq: 2500, gainDb: 4, q: 1.1, type: "peaking" },
          { freq: 6000, gainDb: -1, q: 1.6, type: "peaking" },
          { freq: 12000, gainDb: 0, q: 0.7, type: "highshelf" },
        ],
      },
      deq: {
        on: true,
        bands: [
          { freqHz: 110, thresholdDb: -20, maxCutDb: 8, attackMs: 8, releaseMs: 200 },
          { freqHz: 2800, thresholdDb: -16, maxCutDb: 8, attackMs: 5, releaseMs: 150 },
          { freqHz: 8000, thresholdDb: -24, maxCutDb: 6, attackMs: 4, releaseMs: 120 },
        ],
      },
      multiband: mb6(
        { thresholdDb: -16, ratio: 6, attackMs: 3, releaseMs: 120, makeupDb: 3 },
        { thresholdDb: -16, ratio: 4, attackMs: 2, releaseMs: 120, makeupDb: 3 },
        { thresholdDb: -18, ratio: 4, attackMs: 1.2, releaseMs: 100, makeupDb: 2 },
        [140, 500, 1900, 4600, 9000],
      ),
      agc: {
        on: true,
        thresholdDb: -20,
        ratio: 5,
        kneeDb: 3,
        attackMs: 2,
        releaseMs: 120,
        makeupDb: 6,
      },
      limiter: { on: true, ceilingDb: -1, attackMs: 0.8, releaseMs: 50 },
    }),
  },
  {
    id: "podcast",
    name: "Podcast Master",
    description:
      "Clean voice master targeting −16 LUFS with soft limiting and a dedicated de-esser for platforms.",
    tags: ["Speech", "−16 LUFS", "Web"],
    params: merge({
      hpf: { on: true, freqHz: 70 },
      eq: {
        on: true,
        bands: [
          { freq: 60, gainDb: -1, q: 0.7, type: "lowshelf" },
          { freq: 200, gainDb: -1, q: 1.0, type: "peaking" },
          { freq: 700, gainDb: 0.5, q: 1.0, type: "peaking" },
          { freq: 2500, gainDb: 2.5, q: 1.2, type: "peaking" },
          { freq: 6000, gainDb: -1, q: 1.8, type: "peaking" },
          { freq: 12000, gainDb: 0.5, q: 0.7, type: "highshelf" },
        ],
      },
      deq: {
        on: true,
        bands: [
          { freqHz: 100, thresholdDb: -22, maxCutDb: 6, attackMs: 10, releaseMs: 250 },
          { freqHz: 3000, thresholdDb: -20, maxCutDb: 5, attackMs: 6, releaseMs: 180 },
          { freqHz: 6800, thresholdDb: -22, maxCutDb: 9, attackMs: 4, releaseMs: 120 },
        ],
      },
      multiband: mb6(
        { thresholdDb: -14, ratio: 3, attackMs: 8, releaseMs: 250, makeupDb: 2 },
        { thresholdDb: -16, ratio: 3, attackMs: 4, releaseMs: 200, makeupDb: 2 },
        { thresholdDb: -18, ratio: 4, attackMs: 2, releaseMs: 150, makeupDb: 1.5 },
        [120, 460, 1800, 5000, 10000],
      ),
      agc: {
        on: true,
        thresholdDb: -18,
        ratio: 3,
        kneeDb: 6,
        attackMs: 10,
        releaseMs: 300,
        makeupDb: 4,
      },
      limiter: { on: true, ceilingDb: -1, attackMs: 1.2, releaseMs: 100 },
      outputGainDb: 0,
    }),
  },

  /* ── reference chains modelled on classic broadcast processors ──────────
     Time constants and ratios below follow the manufacturers' published
     specifications (Aphex Compellor 320D manual, Texar/Gentner Prism II FM
     manual, Linear Acoustic AERO.lite manual, Thimeo Stereo Tool docs). */

  {
    id: "compellor-320",
    name: "Compellor 320 · Talk",
    description:
      "Aphex Compellor 320 topology: slow average-power leveler (1.5 s down / 3 s up, silence-gated) over a gentle 2.2:1 program compressor (25 ms / 700 ms) with a fast peak stage. Level consistency you hear as glue, not compression.",
    tags: ["Reference", "Aphex", "Levelling"],
    family: "Reference",
    params: merge({
      hpf: { on: true, freqHz: 110 },
      eq: {
        on: true,
        bands: [
          { freq: 60, gainDb: -1, q: 0.7, type: "lowshelf" },
          { freq: 200, gainDb: -0.5, q: 1.0, type: "peaking" },
          { freq: 700, gainDb: 0, q: 1.0, type: "peaking" },
          { freq: 2500, gainDb: 2, q: 1.1, type: "peaking" },
          { freq: 6000, gainDb: -1.5, q: 1.8, type: "peaking" },
          { freq: 12000, gainDb: 0.5, q: 0.7, type: "highshelf" },
        ],
      },
      multiband: {
        on: true,
        splitsHz: [...DEFAULT_SPLITS] as MultibandSplits,
        bands: [
          { thresholdDb: -12, ratio: 2, attackMs: 30, releaseMs: 600, makeupDb: 1 },
          { thresholdDb: -13, ratio: 2, attackMs: 20, releaseMs: 550, makeupDb: 1 },
          { thresholdDb: -14, ratio: 2, attackMs: 15, releaseMs: 500, makeupDb: 1 },
          { thresholdDb: -15, ratio: 2, attackMs: 10, releaseMs: 450, makeupDb: 1 },
          { thresholdDb: -16, ratio: 2.5, attackMs: 8, releaseMs: 400, makeupDb: 1 },
          { thresholdDb: -17, ratio: 2.5, attackMs: 5, releaseMs: 350, makeupDb: 1 },
        ],
      },
      agc: {
        on: true,
        thresholdDb: -18,
        ratio: 2.2,
        kneeDb: 12,
        attackMs: 25,
        releaseMs: 700,
        makeupDb: 3,
      },
      rider: { on: true, targetLufs: LUFS_TARGET, maxRideDb: 8, speed: "fast" },
      limiter: { on: true, ceilingDb: -1, attackMs: 0.1, releaseMs: 200 },
    }),
  },
  {
    id: "prism-fm",
    name: "Audio Prism · FM Program",
    description:
      "Texar/Gentner Audio Prism topology: four-band parallel dynamics at the original 153 / 850 / 4900 Hz crossovers (mapped onto the 6-band matrix), slow music levelling, subtle harmonic sweetening and a whisper of stereo enhance. Loudness without listener aggravation.",
    tags: ["Reference", "Texar/Gentner", "FM"],
    family: "Reference",
    params: merge({
      hpf: { on: true, freqHz: 70 },
      eq: {
        on: true,
        bands: [
          { freq: 60, gainDb: 1, q: 0.7, type: "lowshelf" },
          { freq: 200, gainDb: -0.5, q: 1.0, type: "peaking" },
          { freq: 700, gainDb: 0.5, q: 1.0, type: "peaking" },
          { freq: 2500, gainDb: 1, q: 1.1, type: "peaking" },
          { freq: 6000, gainDb: 0, q: 1.4, type: "peaking" },
          { freq: 12000, gainDb: 1.5, q: 0.7, type: "highshelf" },
        ],
      },
      multiband: {
        on: true,
        // Prism II FM crossovers: 153 / 850 / 4900 Hz, with the top band
        // split in two for finer control of the “high” mix bus
        splitsHz: [153, 850, 2200, 4900, 9500] as MultibandSplits,
        bands: [
          { thresholdDb: -12, ratio: 2.5, attackMs: 20, releaseMs: 400, makeupDb: 1.5 },
          { thresholdDb: -14, ratio: 2.5, attackMs: 15, releaseMs: 350, makeupDb: 1.5 },
          { thresholdDb: -15, ratio: 3, attackMs: 10, releaseMs: 300, makeupDb: 1 },
          { thresholdDb: -15, ratio: 3, attackMs: 8, releaseMs: 300, makeupDb: 1 },
          { thresholdDb: -17, ratio: 2.5, attackMs: 5, releaseMs: 250, makeupDb: 1 },
          { thresholdDb: -18, ratio: 2.5, attackMs: 4, releaseMs: 250, makeupDb: 1 },
        ],
      },
      agc: {
        on: true,
        thresholdDb: -16,
        ratio: 2.5,
        kneeDb: 9,
        attackMs: 20,
        releaseMs: 500,
        makeupDb: 3,
      },
      rider: { on: true, targetLufs: LUFS_TARGET, maxRideDb: 6, speed: "slow" },
      exciter: { on: true, mix: 3, freqHz: 3200 },
      stereo: { width: 1.06 },
      limiter: { on: true, ceilingDb: -1, attackMs: 0.3, releaseMs: 150 },
    }),
  },
  {
    id: "aero-loudness",
    name: "AERO.lite · Loudness Compliance",
    description:
      "Linear Acoustic AERO.lite topology: integrating long-term loudness controller riding toward −23 LUFS (A/85 practice sits at −24 LKFS), gentle 5-band-style AGC with density in the timings, −2 dBTP final limiting. Compliance first, artifacts never.",
    tags: ["Reference", "Linear Acoustic", "R128"],
    family: "Reference",
    params: merge({
      hpf: { on: true, freqHz: 80 },
      eq: {
        on: true,
        bands: [
          { freq: 60, gainDb: 0, q: 0.7, type: "lowshelf" },
          { freq: 200, gainDb: 0, q: 1.0, type: "peaking" },
          { freq: 700, gainDb: 0, q: 1.0, type: "peaking" },
          { freq: 2500, gainDb: 1, q: 1.2, type: "peaking" },
          { freq: 6000, gainDb: 0, q: 1.4, type: "peaking" },
          { freq: 12000, gainDb: 0, q: 0.7, type: "highshelf" },
        ],
      },
      multiband: {
        on: true,
        splitsHz: [...DEFAULT_SPLITS] as MultibandSplits,
        bands: [
          { thresholdDb: -12, ratio: 2, attackMs: 30, releaseMs: 500, makeupDb: 1 },
          { thresholdDb: -13, ratio: 2, attackMs: 25, releaseMs: 500, makeupDb: 1 },
          { thresholdDb: -14, ratio: 2, attackMs: 20, releaseMs: 500, makeupDb: 1 },
          { thresholdDb: -15, ratio: 2, attackMs: 18, releaseMs: 500, makeupDb: 1 },
          { thresholdDb: -16, ratio: 2, attackMs: 15, releaseMs: 450, makeupDb: 1 },
          { thresholdDb: -17, ratio: 2, attackMs: 12, releaseMs: 450, makeupDb: 1 },
        ],
      },
      agc: {
        on: true,
        thresholdDb: -16,
        ratio: 2,
        kneeDb: 9,
        attackMs: 30,
        releaseMs: 600,
        makeupDb: 2,
      },
      rider: { on: true, targetLufs: LUFS_TARGET, maxRideDb: 10, speed: "slow" },
      limiter: { on: true, ceilingDb: -2, attackMs: 0.5, releaseMs: 300 },
    }),
  },
  {
    id: "stereo-tool-fm",
    name: "Stereo Tool · Loud & Clean",
    description:
      "Thimeo Stereo Tool character: deep 6:1 program AGC, hard 6-band multiband, M/S Stereo Boost (×1.22), high-band harmonic air and an aggressive clipper stage at −0.5 dBTP. Loud, wide, punchy — the classic ST streaming sound.",
    tags: ["Reference", "Thimeo", "Loud"],
    family: "Reference",
    params: merge({
      hpf: { on: true, freqHz: 65 },
      eq: {
        on: true,
        bands: [
          { freq: 60, gainDb: 2.5, q: 0.7, type: "lowshelf" },
          { freq: 200, gainDb: -1, q: 1.1, type: "peaking" },
          { freq: 700, gainDb: 0.5, q: 1.0, type: "peaking" },
          { freq: 2500, gainDb: 2, q: 1.1, type: "peaking" },
          { freq: 6000, gainDb: 1, q: 1.4, type: "peaking" },
          { freq: 12000, gainDb: 2.5, q: 0.7, type: "highshelf" },
        ],
      },
      deq: {
        on: true,
        bands: [
          { freqHz: 90, thresholdDb: -18, maxCutDb: 8, attackMs: 8, releaseMs: 220 },
          { freqHz: 3200, thresholdDb: -20, maxCutDb: 6, attackMs: 5, releaseMs: 160 },
          { freqHz: 7500, thresholdDb: -22, maxCutDb: 8, attackMs: 4, releaseMs: 120 },
        ],
      },
      multiband: {
        on: true,
        splitsHz: [120, 400, 1500, 4000, 9000] as MultibandSplits,
        bands: [
          { thresholdDb: -16, ratio: 5, attackMs: 8, releaseMs: 180, makeupDb: 3.5 },
          { thresholdDb: -17, ratio: 4.5, attackMs: 5, releaseMs: 170, makeupDb: 3.5 },
          { thresholdDb: -18, ratio: 4, attackMs: 3, releaseMs: 160, makeupDb: 3 },
          { thresholdDb: -19, ratio: 4, attackMs: 2, releaseMs: 150, makeupDb: 3 },
          { thresholdDb: -20, ratio: 4, attackMs: 1.5, releaseMs: 130, makeupDb: 2.5 },
          { thresholdDb: -21, ratio: 4, attackMs: 1, releaseMs: 120, makeupDb: 2.5 },
        ],
      },
      agc: {
        on: true,
        thresholdDb: -24,
        ratio: 6,
        kneeDb: 3,
        attackMs: 5,
        releaseMs: 200,
        makeupDb: 8,
      },
      exciter: { on: true, mix: 6, freqHz: 6500 },
      stereo: { width: 1.22 },
      limiter: { on: true, ceilingDb: -0.5, attackMs: 0.2, releaseMs: 80 },
    }),
  },
];

/* ── helpers ────────────────────────────────────────────────────────────── */

export function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

export function gainToDb(gain: number): number {
  return 20 * Math.log10(Math.max(gain, 1e-9));
}

export function cloneParams(p: ProcessorParams): ProcessorParams {
  return structuredClone(p);
}

/** Format dB with a typographic minus, e.g. \"−3.5 dB\". */
export function formatDb(db: number, digits = 1): string {
  const v = Math.abs(db) < Math.pow(10, -digits) / 2 ? 0 : db;
  return `${v.toFixed(digits).replace("-", "−")} dB`;
}

/** Format Hz for humans: \"80 Hz\" / \"5.5 kHz\". */
export function formatHz(hz: number): string {
  return hz >= 1000 ? `${(hz / 1000).toFixed(1)} kHz` : `${Math.round(hz)} Hz`;
}

/** Format mm:ss for transport displays. */
export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function mergeDeep<T>(base: T, patch: unknown): T {
  if (Array.isArray(base)) {
    if (!Array.isArray(patch) || patch.length !== base.length) return base;
    return base.map((b, i) =>
      b && typeof b === "object" ? mergeDeep(b, patch[i]) : (patch[i] ?? b),
    ) as unknown as T;
  }
  if (base && typeof base === "object") {
    const src = (patch ?? {}) as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(base as Record<string, unknown>)) {
      out[k] = mergeDeep(v, src[k]);
    }
    return out as T;
  }
  if (typeof base === "boolean") {
    return (typeof patch === "boolean" ? patch : base) as T;
  }
  if (isNum(base)) return (isNum(patch) ? patch : base) as T;
  return (typeof patch === typeof base && patch !== undefined ? patch : base) as T;
}

/**
 * Coerce arbitrary (possibly stale) saved params onto the current shape so
 * old presets and localStorage snapshots always load safely — legacy 3-band
 * multiband configs fall back to the 6-band defaults.
 */
export function coerceParams(saved: unknown): ProcessorParams {
  const base = structuredClone(DEFAULT_PARAMS);
  if (!saved || typeof saved !== "object") return base;
  return mergeDeep(base, saved);
}
