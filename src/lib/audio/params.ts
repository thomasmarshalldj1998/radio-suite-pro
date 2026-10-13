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
  /** Detector/cut bandwidth (Q of the band-pass). */
  q: number;
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
  /** Silence gate — never ride background noise up during pauses. */
  gateDb: number;
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
export type DeqBands = [DeqBand, DeqBand, DeqBand, DeqBand, DeqBand];

export interface ProcessorParams {
  inputGainDb: number;
  hpf: { on: boolean; freqHz: number };
  /** Phase rotation (allpass): auto = fixed voice window, manual = user freq. */
  phase: { mode: "auto" | "manual"; freqHz: number };
  /** Input-stage silence gate (close below threshold, hold, reopen). */
  gate: { on: boolean; thresholdDb: number; holdMs: number };
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
export const MB_LABELS = [
  "Sub-bass",
  "Bass",
  "Low-mid",
  "High-mid",
  "Presence",
  "Hf rolloff",
] as const;
export const DEQ_LABELS = ["Sub", "Mud", "Mid", "Presence", "Air"] as const;
export const LUFS_TARGET = -23;
export const TRUE_PEAK_TARGET = -1;

/** Default crossover split points for the 6-band matrix (Hz). */
export const DEFAULT_SPLITS: MultibandSplits = [140, 450, 1800, 4500, 9000];

/**
 * Omnia-style crossovers: the Omnia ONE manual documents its AGC/limiter
 * splits at 180 Hz / 1 kHz / 3.3 kHz (plus a 6.5 kHz fifth limiter band);
 * the extra 12 kHz point feeds the 6th (air) band of this matrix.
 */
export const OMNIA_SPLITS: MultibandSplits = [180, 1000, 3300, 6500, 12000];

export const DEFAULT_PARAMS: ProcessorParams = {
  inputGainDb: 0,
  hpf: { on: true, freqHz: 80 },
  phase: { mode: "auto", freqHz: 300 },
  gate: { on: true, thresholdDb: -52, holdMs: 500 },
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
      { freqHz: 80, q: 0.9, thresholdDb: -20, maxCutDb: 5, attackMs: 12, releaseMs: 280 },
      { freqHz: 250, q: 1.0, thresholdDb: -20, maxCutDb: 6, attackMs: 10, releaseMs: 250 },
      { freqHz: 1600, q: 1.1, thresholdDb: -18, maxCutDb: 5, attackMs: 6, releaseMs: 180 },
      { freqHz: 5000, q: 1.2, thresholdDb: -18, maxCutDb: 5, attackMs: 6, releaseMs: 160 },
      { freqHz: 10000, q: 1.1, thresholdDb: -22, maxCutDb: 8, attackMs: 4, releaseMs: 120 },
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
  rider: {
    on: false,
    targetLufs: LUFS_TARGET,
    maxRideDb: 8,
    gateDb: -55,
    speed: "fast",
  },
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

/**
 * Built-in presets — parameter snapshots modelled on the documented
 * characters of real Orban Optimod (8600/8700i) and Omnia (ONE/9) factory
 * presets. Neither manufacturer publishes numeric recipes, so each preset
 * follows its documented *behaviour*: Orban NEWS-TALK/SPORTS fast
 * multiband release, JAZZ quiet/mellow restraint, ROCK bright highs +
 * punchy lows + vocal presence, URBAN 18 dB/oct bass shape, IMPACT maximum
 * loudness, and Omnia's documented 180 Hz / 1 kHz / 3.3 kHz / 6.5 kHz
 * band structure with purist Classical handling.
 */
export const BUILTIN_PRESETS: BuiltinPreset[] = [
  {
    id: "omnia-general",
    name: "Omnia · General",
    description:
      "Balanced house chain in the Omnia mold: gentle levelling, musical 6-band dynamics on the ONE-style crossovers, dynamic-EQ hygiene, −1 dBTP ceiling.",
    tags: ["General", "Omnia", "−23 LUFS"],
    family: "Omnia",
    params: structuredClone(DEFAULT_PARAMS),
  },
  {
    id: "orban-news-talk",
    name: "Orban · News-Talk",
    description:
      "Optimod NEWS-TALK character: fast multiband release builds a dense, clean, unclipped sound that rescues telephone and field sources; assertive presence for intelligibility.",
    tags: ["Speech", "Orban", "Dense"],
    family: "Orban",
    params: merge({
      hpf: { on: true, freqHz: 120 },
      eq: {
        on: true,
        bands: [
          { freq: 60, gainDb: -2, q: 0.7, type: "lowshelf" },
          { freq: 200, gainDb: -1.5, q: 1.0, type: "peaking" },
          { freq: 700, gainDb: 1, q: 1.0, type: "peaking" },
          { freq: 2500, gainDb: 3.5, q: 1.1, type: "peaking" },
          { freq: 6000, gainDb: -2, q: 2.2, type: "peaking" },
          { freq: 12000, gainDb: 0.5, q: 0.7, type: "highshelf" },
        ],
      },
      deq: {
        on: true,
        bands: [
          { freqHz: 80, q: 0.9, thresholdDb: -24, maxCutDb: 5, attackMs: 10, releaseMs: 220 },
          { freqHz: 250, q: 1.0, thresholdDb: -22, maxCutDb: 6, attackMs: 8, releaseMs: 200 },
          { freqHz: 1600, q: 1.1, thresholdDb: -22, maxCutDb: 4, attackMs: 7, releaseMs: 180 },
          { freqHz: 5000, q: 1.2, thresholdDb: -18, maxCutDb: 6, attackMs: 5, releaseMs: 150 },
          { freqHz: 10000, q: 1.1, thresholdDb: -24, maxCutDb: 9, attackMs: 4, releaseMs: 110 },
        ],
      },
      multiband: mb6(
        { thresholdDb: -14, ratio: 5, attackMs: 4, releaseMs: 90, makeupDb: 2.5 },
        { thresholdDb: -16, ratio: 4.5, attackMs: 2, releaseMs: 80, makeupDb: 2.5 },
        { thresholdDb: -18, ratio: 5, attackMs: 1, releaseMs: 70, makeupDb: 2 },
        [150, 500, 1900, 4800, 10000],
      ),
      agc: {
        on: true,
        thresholdDb: -22,
        ratio: 5,
        kneeDb: 3,
        attackMs: 3,
        releaseMs: 120,
        makeupDb: 6,
      },
      rider: { on: true, targetLufs: LUFS_TARGET, maxRideDb: 10, gateDb: -50, speed: "fast" },
      limiter: { on: true, ceilingDb: -1, attackMs: 0.5, releaseMs: 60 },
    }),
  },
  {
    id: "orban-sports",
    name: "Orban · Sports",
    description:
      "Optimod SPORTS/NEWS-TALK lineage: fast multiband release keeps crowd surges and hot field mics in check while a presence lift keeps commentary intelligible over the din.",
    tags: ["Speech", "Orban", "Fast"],
    family: "Orban",
    params: merge({
      hpf: { on: true, freqHz: 100 },
      eq: {
        on: true,
        bands: [
          { freq: 60, gainDb: -3, q: 0.7, type: "lowshelf" },
          { freq: 200, gainDb: -1.5, q: 1.0, type: "peaking" },
          { freq: 700, gainDb: 1.5, q: 1.0, type: "peaking" },
          { freq: 2500, gainDb: 4, q: 1.1, type: "peaking" },
          { freq: 6000, gainDb: -2, q: 1.8, type: "peaking" },
          { freq: 12000, gainDb: 0, q: 0.7, type: "highshelf" },
        ],
      },
      deq: {
        on: true,
        bands: [
          { freqHz: 80, q: 0.9, thresholdDb: -22, maxCutDb: 6, attackMs: 8, releaseMs: 200 },
          { freqHz: 250, q: 1.0, thresholdDb: -20, maxCutDb: 8, attackMs: 8, releaseMs: 200 },
          { freqHz: 1600, q: 1.1, thresholdDb: -20, maxCutDb: 6, attackMs: 7, releaseMs: 180 },
          { freqHz: 5000, q: 1.2, thresholdDb: -16, maxCutDb: 8, attackMs: 5, releaseMs: 150 },
          { freqHz: 10000, q: 1.1, thresholdDb: -24, maxCutDb: 6, attackMs: 4, releaseMs: 120 },
        ],
      },
      multiband: mb6(
        { thresholdDb: -16, ratio: 6, attackMs: 3, releaseMs: 100, makeupDb: 3 },
        { thresholdDb: -16, ratio: 4, attackMs: 2, releaseMs: 100, makeupDb: 3 },
        { thresholdDb: -18, ratio: 4, attackMs: 1.2, releaseMs: 90, makeupDb: 2 },
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
      rider: { on: true, targetLufs: LUFS_TARGET, maxRideDb: 12, gateDb: -48, speed: "fast" },
      limiter: { on: true, ceilingDb: -1, attackMs: 0.8, releaseMs: 50 },
    }),
  },
  {
    id: "orban-jazz",
    name: "Orban · Jazz",
    description:
      "Optimod JAZZ character: quiet, clean and mellow for instrumental music — light re-equalization that eases horn/sax stridency without erasing the recording's own balance.",
    tags: ["Music", "Orban", "Mellow"],
    family: "Orban",
    params: merge({
      hpf: { on: true, freqHz: 50 },
      eq: {
        on: true,
        bands: [
          { freq: 60, gainDb: 1, q: 0.7, type: "lowshelf" },
          { freq: 200, gainDb: -0.5, q: 0.9, type: "peaking" },
          { freq: 700, gainDb: 0, q: 1.0, type: "peaking" },
          { freq: 2500, gainDb: -1, q: 1.2, type: "peaking" },
          { freq: 6000, gainDb: -2, q: 1.6, type: "peaking" },
          { freq: 12000, gainDb: 1, q: 0.7, type: "highshelf" },
        ],
      },
      deq: {
        on: true,
        bands: [
          { freqHz: 80, q: 0.9, thresholdDb: -26, maxCutDb: 3, attackMs: 20, releaseMs: 420 },
          { freqHz: 250, q: 1.0, thresholdDb: -24, maxCutDb: 3, attackMs: 18, releaseMs: 400 },
          { freqHz: 1600, q: 1.1, thresholdDb: -26, maxCutDb: 2, attackMs: 15, releaseMs: 360 },
          { freqHz: 5000, q: 1.2, thresholdDb: -22, maxCutDb: 3, attackMs: 12, releaseMs: 320 },
          { freqHz: 10000, q: 1.1, thresholdDb: -26, maxCutDb: 3, attackMs: 10, releaseMs: 300 },
        ],
      },
      multiband: mb6(
        { thresholdDb: -12, ratio: 2, attackMs: 20, releaseMs: 550, makeupDb: 1 },
        { thresholdDb: -14, ratio: 2, attackMs: 15, releaseMs: 500, makeupDb: 1 },
        { thresholdDb: -16, ratio: 2.5, attackMs: 8, releaseMs: 450, makeupDb: 1 },
        [120, 450, 1800, 4800, 9800],
      ),
      agc: {
        on: true,
        thresholdDb: -18,
        ratio: 2,
        kneeDb: 10,
        attackMs: 25,
        releaseMs: 650,
        makeupDb: 3,
      },
      rider: { on: true, targetLufs: -26, maxRideDb: 6, gateDb: -58, speed: "slow" },
      stereo: { width: 1.05 },
      limiter: { on: true, ceilingDb: -1.5, attackMs: 2, releaseMs: 220 },
    }),
  },
  {
    id: "orban-rock-dense",
    name: "Orban · Rock Dense",
    description:
      "Optimod ROCK-DENSE character: fast multiband release builds a dense, punchy wall for rock/CHR — bright highs, punchy lows and a midrange presence lift that keeps vocals forward.",
    tags: ["Music", "Orban", "Dense"],
    family: "Orban",
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
          { freqHz: 80, q: 0.9, thresholdDb: -22, maxCutDb: 6, attackMs: 10, releaseMs: 240 },
          { freqHz: 250, q: 1.0, thresholdDb: -18, maxCutDb: 8, attackMs: 8, releaseMs: 220 },
          { freqHz: 1600, q: 1.1, thresholdDb: -20, maxCutDb: 5, attackMs: 6, releaseMs: 180 },
          { freqHz: 5000, q: 1.2, thresholdDb: -20, maxCutDb: 6, attackMs: 5, releaseMs: 160 },
          { freqHz: 10000, q: 1.1, thresholdDb: -22, maxCutDb: 8, attackMs: 4, releaseMs: 120 },
        ],
      },
      multiband: mb6(
        { thresholdDb: -18, ratio: 6, attackMs: 5, releaseMs: 150, makeupDb: 4 },
        { thresholdDb: -20, ratio: 5, attackMs: 3, releaseMs: 130, makeupDb: 4 },
        { thresholdDb: -20, ratio: 4, attackMs: 1.5, releaseMs: 110, makeupDb: 3 },
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
      exciter: { on: true, mix: 4, freqHz: 5000 },
      stereo: { width: 1.12 },
      limiter: { on: true, ceilingDb: -0.8, attackMs: 0.8, releaseMs: 60 },
      outputGainDb: 0,
    }),
  },
  {
    id: "orban-urban-heavy",
    name: "Orban · Urban Heavy",
    description:
      "Optimod URBAN-HEAVY character: the documented 18 dB/octave bass-EQ shape over hip-hop/rap/R&B — deep, controlled low end with a dense competitive top.",
    tags: ["Music", "Orban", "Bass"],
    family: "Orban",
    params: merge({
      hpf: { on: true, freqHz: 45 },
      eq: {
        on: true,
        bands: [
          { freq: 60, gainDb: 4.5, q: 0.7, type: "lowshelf" },
          { freq: 200, gainDb: -1, q: 1.0, type: "peaking" },
          { freq: 700, gainDb: 0, q: 1.0, type: "peaking" },
          { freq: 2500, gainDb: 1.5, q: 1.1, type: "peaking" },
          { freq: 6000, gainDb: 1, q: 1.4, type: "peaking" },
          { freq: 12000, gainDb: 2, q: 0.7, type: "highshelf" },
        ],
      },
      deq: {
        on: true,
        bands: [
          { freqHz: 80, q: 0.9, thresholdDb: -18, maxCutDb: 8, attackMs: 8, releaseMs: 220 },
          { freqHz: 250, q: 1.0, thresholdDb: -18, maxCutDb: 7, attackMs: 8, releaseMs: 200 },
          { freqHz: 1600, q: 1.1, thresholdDb: -20, maxCutDb: 5, attackMs: 6, releaseMs: 180 },
          { freqHz: 5000, q: 1.2, thresholdDb: -20, maxCutDb: 6, attackMs: 5, releaseMs: 160 },
          { freqHz: 10000, q: 1.1, thresholdDb: -22, maxCutDb: 8, attackMs: 4, releaseMs: 130 },
        ],
      },
      multiband: mb6(
        { thresholdDb: -18, ratio: 6, attackMs: 4, releaseMs: 160, makeupDb: 4.5 },
        { thresholdDb: -20, ratio: 5, attackMs: 3, releaseMs: 140, makeupDb: 4 },
        { thresholdDb: -21, ratio: 4.5, attackMs: 1.5, releaseMs: 120, makeupDb: 3 },
        [120, 450, 1800, 4700, 9500],
      ),
      agc: {
        on: true,
        thresholdDb: -24,
        ratio: 6,
        kneeDb: 2.5,
        attackMs: 4,
        releaseMs: 180,
        makeupDb: 8,
      },
      stereo: { width: 1.15 },
      limiter: { on: true, ceilingDb: -0.8, attackMs: 0.6, releaseMs: 70 },
    }),
  },
  {
    id: "omnia-vox",
    name: "Omnia · Vox",
    description:
      "Omnia ONE voice-processor heritage: fast wideband levelling and assertive de-essing for talk, podcast and hybrid formats — clean, dense, intelligible.",
    tags: ["Speech", "Omnia", "Voice"],
    family: "Omnia",
    params: merge({
      hpf: { on: true, freqHz: 80 },
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
          { freqHz: 80, q: 0.9, thresholdDb: -24, maxCutDb: 5, attackMs: 12, releaseMs: 280 },
          { freqHz: 250, q: 1.0, thresholdDb: -22, maxCutDb: 6, attackMs: 10, releaseMs: 250 },
          { freqHz: 1600, q: 1.1, thresholdDb: -22, maxCutDb: 5, attackMs: 8, releaseMs: 200 },
          { freqHz: 5000, q: 1.2, thresholdDb: -18, maxCutDb: 6, attackMs: 6, releaseMs: 180 },
          { freqHz: 10000, q: 1.1, thresholdDb: -22, maxCutDb: 9, attackMs: 4, releaseMs: 120 },
        ],
      },
      multiband: mb6(
        { thresholdDb: -14, ratio: 3.5, attackMs: 6, releaseMs: 220, makeupDb: 2 },
        { thresholdDb: -16, ratio: 3.5, attackMs: 4, releaseMs: 200, makeupDb: 2 },
        { thresholdDb: -18, ratio: 4, attackMs: 2, releaseMs: 150, makeupDb: 1.5 },
        [180, 1000, 3300, 6500, 12000],
      ),
      agc: {
        on: true,
        thresholdDb: -18,
        ratio: 3.5,
        kneeDb: 5,
        attackMs: 8,
        releaseMs: 280,
        makeupDb: 5,
      },
      rider: { on: true, targetLufs: -18, maxRideDb: 10, gateDb: -52, speed: "fast" },
      limiter: { on: true, ceilingDb: -1, attackMs: 1, releaseMs: 100 },
      outputGainDb: 0,
    }),
  },

  {
    id: "orban-rock-open",
    name: "Orban · Rock Open",
    description:
      "Optimod ROCK-OPEN character: the same bright/punchy/presence tonality as Rock Dense but with slow releases — open transients and breathing room for audiophile rock formats.",
    tags: ["Music", "Orban", "Open"],
    family: "Orban",
    params: merge({
      hpf: { on: true, freqHz: 65 },
      eq: {
        on: true,
        bands: [
          { freq: 60, gainDb: 2, q: 0.7, type: "lowshelf" },
          { freq: 200, gainDb: -1, q: 1.1, type: "peaking" },
          { freq: 700, gainDb: 0.5, q: 1.0, type: "peaking" },
          { freq: 2500, gainDb: 2, q: 1.1, type: "peaking" },
          { freq: 6000, gainDb: 0.5, q: 1.4, type: "peaking" },
          { freq: 12000, gainDb: 2, q: 0.7, type: "highshelf" },
        ],
      },
      deq: {
        on: true,
        bands: [
          { freqHz: 80, q: 0.9, thresholdDb: -24, maxCutDb: 4, attackMs: 18, releaseMs: 400 },
          { freqHz: 250, q: 1.0, thresholdDb: -22, maxCutDb: 5, attackMs: 15, releaseMs: 380 },
          { freqHz: 1600, q: 1.1, thresholdDb: -24, maxCutDb: 3, attackMs: 12, releaseMs: 340 },
          { freqHz: 5000, q: 1.2, thresholdDb: -22, maxCutDb: 4, attackMs: 10, releaseMs: 300 },
          { freqHz: 10000, q: 1.1, thresholdDb: -24, maxCutDb: 5, attackMs: 8, releaseMs: 260 },
        ],
      },
      multiband: mb6(
        { thresholdDb: -14, ratio: 3, attackMs: 15, releaseMs: 420, makeupDb: 2 },
        { thresholdDb: -16, ratio: 3, attackMs: 10, releaseMs: 400, makeupDb: 2 },
        { thresholdDb: -18, ratio: 3, attackMs: 6, releaseMs: 350, makeupDb: 1.5 },
        [130, 480, 1900, 4800, 9500],
      ),
      agc: {
        on: true,
        thresholdDb: -18,
        ratio: 2.5,
        kneeDb: 9,
        attackMs: 15,
        releaseMs: 500,
        makeupDb: 4,
      },
      exciter: { on: true, mix: 3, freqHz: 5000 },
      stereo: { width: 1.15 },
      limiter: { on: true, ceilingDb: -1, attackMs: 1.2, releaseMs: 150 },
    }),
  },
  {
    id: "omnia-big-bottom",
    name: "Omnia · Big Bottom",
    description:
      "The famous Omnia bass preset: a weighty low shelf tamed by tight dynamic-EQ control so the bottom stays huge without flapping — club, dance and modern pop.",
    tags: ["Music", "Omnia", "Bass"],
    family: "Omnia",
    params: merge({
      hpf: { on: true, freqHz: 40 },
      eq: {
        on: true,
        bands: [
          { freq: 60, gainDb: 5, q: 0.7, type: "lowshelf" },
          { freq: 200, gainDb: -1.5, q: 1.0, type: "peaking" },
          { freq: 700, gainDb: 0, q: 1.0, type: "peaking" },
          { freq: 2500, gainDb: 1, q: 1.1, type: "peaking" },
          { freq: 6000, gainDb: 0.5, q: 1.4, type: "peaking" },
          { freq: 12000, gainDb: 1.5, q: 0.7, type: "highshelf" },
        ],
      },
      deq: {
        on: true,
        bands: [
          { freqHz: 80, q: 0.9, thresholdDb: -16, maxCutDb: 9, attackMs: 8, releaseMs: 220 },
          { freqHz: 250, q: 1.0, thresholdDb: -18, maxCutDb: 7, attackMs: 8, releaseMs: 200 },
          { freqHz: 1600, q: 1.1, thresholdDb: -22, maxCutDb: 4, attackMs: 6, releaseMs: 180 },
          { freqHz: 5000, q: 1.2, thresholdDb: -22, maxCutDb: 5, attackMs: 5, releaseMs: 160 },
          { freqHz: 10000, q: 1.1, thresholdDb: -24, maxCutDb: 6, attackMs: 4, releaseMs: 130 },
        ],
      },
      multiband: mb6(
        { thresholdDb: -16, ratio: 5, attackMs: 6, releaseMs: 200, makeupDb: 3.5 },
        { thresholdDb: -18, ratio: 4, attackMs: 4, releaseMs: 180, makeupDb: 3 },
        { thresholdDb: -20, ratio: 3.5, attackMs: 2, releaseMs: 150, makeupDb: 2.5 },
        [180, 1000, 3300, 6500, 12000],
      ),
      agc: {
        on: true,
        thresholdDb: -22,
        ratio: 4,
        kneeDb: 5,
        attackMs: 8,
        releaseMs: 280,
        makeupDb: 6,
      },
      stereo: { width: 1.1 },
      limiter: { on: true, ceilingDb: -0.8, attackMs: 0.6, releaseMs: 90 },
    }),
  },
  {
    id: "omnia-tokyo",
    name: "Omnia · Tokyo",
    description:
      "Omnia 9 Tokyo lineage: maximum density for competitive J-pop/Asian markets — tight hyper-compressed multiband, aggressive de-essing, wide stereo and a hot but legal ceiling.",
    tags: ["Music", "Omnia", "Loud"],
    family: "Omnia",
    params: merge({
      hpf: { on: true, freqHz: 70 },
      eq: {
        on: true,
        bands: [
          { freq: 60, gainDb: 3, q: 0.7, type: "lowshelf" },
          { freq: 200, gainDb: -2, q: 1.1, type: "peaking" },
          { freq: 700, gainDb: 0.5, q: 1.0, type: "peaking" },
          { freq: 2500, gainDb: 2.5, q: 1.1, type: "peaking" },
          { freq: 6000, gainDb: 1.5, q: 1.4, type: "peaking" },
          { freq: 12000, gainDb: 3, q: 0.7, type: "highshelf" },
        ],
      },
      deq: {
        on: true,
        bands: [
          { freqHz: 80, q: 0.9, thresholdDb: -20, maxCutDb: 7, attackMs: 8, releaseMs: 220 },
          { freqHz: 250, q: 1.0, thresholdDb: -18, maxCutDb: 8, attackMs: 7, releaseMs: 200 },
          { freqHz: 1600, q: 1.1, thresholdDb: -20, maxCutDb: 6, attackMs: 6, releaseMs: 180 },
          { freqHz: 5000, q: 1.2, thresholdDb: -18, maxCutDb: 8, attackMs: 5, releaseMs: 160 },
          { freqHz: 10000, q: 1.1, thresholdDb: -20, maxCutDb: 10, attackMs: 4, releaseMs: 120 },
        ],
      },
      multiband: mb6(
        { thresholdDb: -20, ratio: 6, attackMs: 4, releaseMs: 140, makeupDb: 5 },
        { thresholdDb: -22, ratio: 5, attackMs: 2.5, releaseMs: 120, makeupDb: 5 },
        { thresholdDb: -22, ratio: 4.5, attackMs: 1.5, releaseMs: 100, makeupDb: 4 },
        [180, 1000, 3300, 6500, 12000],
      ),
      agc: {
        on: true,
        thresholdDb: -26,
        ratio: 7,
        kneeDb: 2,
        attackMs: 3,
        releaseMs: 150,
        makeupDb: 10,
      },
      exciter: { on: true, mix: 5, freqHz: 6000 },
      stereo: { width: 1.2 },
      limiter: { on: true, ceilingDb: -0.5, attackMs: 0.3, releaseMs: 60 },
    }),
  },
  {
    id: "omnia-classical",
    name: "Omnia · Classical / Jazz",
    description:
      "The documented purist approach: minimal intervention so the recording survives — gentle levelling, no dynamic-EQ busywork, slow timing and a conservative −1.5 dBTP ceiling that only acts on real peaks.",
    tags: ["Music", "Omnia", "Purist"],
    family: "Omnia",
    params: merge({
      hpf: { on: true, freqHz: 40 },
      eq: {
        on: true,
        bands: [
          { freq: 60, gainDb: 0.5, q: 0.7, type: "lowshelf" },
          { freq: 200, gainDb: 0, q: 1.0, type: "peaking" },
          { freq: 700, gainDb: 0, q: 1.0, type: "peaking" },
          { freq: 2500, gainDb: -0.5, q: 1.2, type: "peaking" },
          { freq: 6000, gainDb: 0, q: 1.4, type: "peaking" },
          { freq: 12000, gainDb: 0.5, q: 0.7, type: "highshelf" },
        ],
      },
      deq: {
        on: false,
        bands: [
          { freqHz: 80, q: 0.9, thresholdDb: -28, maxCutDb: 3, attackMs: 25, releaseMs: 500 },
          { freqHz: 250, q: 1.0, thresholdDb: -26, maxCutDb: 3, attackMs: 22, releaseMs: 480 },
          { freqHz: 1600, q: 1.1, thresholdDb: -28, maxCutDb: 2, attackMs: 20, releaseMs: 450 },
          { freqHz: 5000, q: 1.2, thresholdDb: -26, maxCutDb: 3, attackMs: 18, releaseMs: 420 },
          { freqHz: 10000, q: 1.1, thresholdDb: -28, maxCutDb: 3, attackMs: 15, releaseMs: 380 },
        ],
      },
      multiband: mb6(
        { thresholdDb: -12, ratio: 1.8, attackMs: 30, releaseMs: 700, makeupDb: 1 },
        { thresholdDb: -14, ratio: 1.8, attackMs: 25, releaseMs: 650, makeupDb: 1 },
        { thresholdDb: -16, ratio: 2, attackMs: 15, releaseMs: 600, makeupDb: 1 },
        [180, 1000, 3300, 6500, 12000],
      ),
      agc: {
        on: true,
        thresholdDb: -16,
        ratio: 1.8,
        kneeDb: 12,
        attackMs: 40,
        releaseMs: 900,
        makeupDb: 2,
      },
      rider: { on: true, targetLufs: -24, maxRideDb: 5, gateDb: -60, speed: "slow" },
      stereo: { width: 1.02 },
      limiter: { on: true, ceilingDb: -1.5, attackMs: 3, releaseMs: 280 },
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

/** Format dB with a typographic minus, e.g. \"−3.50 dB\". Console values show 2 dp. */
export function formatDb(db: number, digits = 2): string {
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
