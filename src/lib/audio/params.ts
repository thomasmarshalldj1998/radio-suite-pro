/**
 * Processor parameter model for the Signalpath broadcast chain:
 *
 *   input gain → HPF → phase rotator (4-stage allpass) → 6-band EQ →
 *   dynamic EQ (3 subtractive bands) → program AGC (window-gated leveller)
 *   → 6-band multiband compressor (LR4 crossovers, Less–More macro) →
 *   de-esser (dynamic 6–10 kHz) → composite limiter (fast peak stage +
 *   per-sample ceiling guard) → output gain → (monitor + encoder send)
 *
 * The FM branch taps the program bus after the chain and builds the
 * composite (MPX) signal for an FM exciter: pre-emphasis → 15 kHz brickwall
 * → stereo matrix → pilot / RDS / SCA subcarriers → composite clipper.
 */

/**
 * Biquad shapes a band can take. The first three are the original
 * shelving/peaking set; low/high-pass and notch turn a band into a
 * static filter (its gain control is then inert, as on a real console).
 */
export type EqBandType =
  | "peaking"
  | "lowshelf"
  | "highshelf"
  | "lowpass"
  | "highpass"
  | "notch";

export interface EqBand {
  freq: number;
  gainDb: number;
  q: number;
  type: EqBandType;
  /**
   * Band in circuit. Optional so presets saved before per-band bypass was
   * added still read as enabled (`undefined` = on).
   */
  on?: boolean;
}

/** A band is in circuit unless it was explicitly switched off. */
export function eqBandOn(band: EqBand): boolean {
  return band.on !== false;
}

/**
 * High-pass steepness in dB/octave. 12 dB/oct is one biquad section;
 * each step adds another section in cascade (Butterworth pole spacing),
 * so 48 dB/oct is the classic four-section broadcast rumble filter.
 * Optional on the saved object so older presets load at the 24 dB default.
 */
export type HpfSlope = 12 | 24 | 36 | 48;

export const HPF_SLOPES: HpfSlope[] = [12, 24, 36, 48];
export const HPF_DEFAULT_SLOPE: HpfSlope = 24;

/** Standard broadcast high-pass points, in Hz. */
export const HPF_STANDARD_HZ = [30, 40, 50, 60, 80, 100] as const;

/**
 * Butterworth pole Qs for a cascade of 2nd-order sections, per order:
 * 2nd order = 1 section, 4th = 2, 6th = 3, 8th = 4. These give a
 * maximally-flat passband instead of the resonant bump that cascading
 * identical Q=0.707 sections would produce.
 */
const HPF_SECTION_Q: Record<number, number[]> = {
  1: [0.7071],
  2: [0.5412, 1.3066],
  3: [0.5176, 0.7071, 1.9319],
  4: [0.5098, 0.6013, 0.8999, 2.5629],
};

/** Section Qs for a slope: 12 dB/oct → 1 section, 48 → 4. */
export function hpfSectionQs(slope: HpfSlope | undefined): number[] {
  const sections = Math.max(1, Math.min(4, Math.round((slope ?? HPF_DEFAULT_SLOPE) / 12)));
  return HPF_SECTION_Q[sections];
}

export interface BandCompParams {
  thresholdDb: number;
  ratio: number;
  attackMs: number;
  releaseMs: number;
  makeupDb: number;
}

/**
 * High-frequency de-esser: a dynamic cut over a band inside 5–10 kHz (5 kHz
 * for dark, chesty voices; 8–10 kHz for bright condensers), placed ahead of
 * the limiter so sibilance is tamed before it drives the final stage instead
 * of after it has already squashed the programme.
 */
import { DEFAULT_PSY, type PsyParams } from "./psycho";

export interface DeessParams {
  on: boolean;
  /** Centre of the detection band (Hz) — 5 kHz … 10 kHz. */
  freqHz: number;
  /** HF level at which the cut starts (dBFS). */
  thresholdDb: number;
  /** Deepest cut the band may apply (dB). */
  maxCutDb: number;
  attackMs: number;
  releaseMs: number;
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
 * Fast peak window of the dual-window AGC. It sits ahead of the slow
 * leveller and catches transients the long release would otherwise let
 * through, with its own threshold so the two stages never fight.
 */
export interface AgcFastParams {
  on: boolean;
  thresholdDb: number;
  ratio: number;
  kneeDb: number;
  attackMs: number;
  releaseMs: number;
}

export const DEFAULT_AGC_FAST: AgcFastParams = {
  on: false,
  thresholdDb: -10,
  ratio: 4,
  kneeDb: 0,
  attackMs: 3,
  releaseMs: 250,
};

/**
 * Fast window settings for an AGC block. Optional on the saved object so
 * presets written before the dual-window stage existed load with it
 * bypassed, leaving their sound byte-identical.
 */
export function agcFast(agc: ProcessorParams["agc"]): AgcFastParams {
  return agc.fast ?? DEFAULT_AGC_FAST;
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

/**
 * Soft clipper ahead of the limiter. Real broadcast chains clip a decibel or
 * two before the final ceiling so fast transients are shaved instead of
 * making the limiter pump. `thresholdDb` is where the curve leaves linear;
 * `mix` blends clipped and unclipped program in parallel.
 */
export interface ClipperParams {
  on: boolean;
  thresholdDb: number;
  mix: number;
}

export const DEFAULT_CLIPPER: ClipperParams = {
  on: false,
  thresholdDb: -1.5,
  mix: 60,
};

/**
 * Program limiter: the slow second stage of the dual-stage limiter. It rides
 * the short-term level, leaving the fast peak stage to catch transients only.
 * `ceilingDb` is independent of the peak ceiling (usually a few tenths lower,
 * so the program stage does the audible work and the peak stage stays idle).
 */
export interface LimiterProgramParams {
  on: boolean;
  ceilingDb: number;
  attackMs: number;
  releaseMs: number;
}

export const DEFAULT_LIMITER_PROGRAM: LimiterProgramParams = {
  on: false,
  ceilingDb: -1.4,
  attackMs: 12,
  releaseMs: 320,
};

/** Peak-stage implementation chosen for the final limiter. */
export type LimiterEngine = "native" | "worklet";

/**
 * Resolve the peak stage. Old saves and presets predate the worklet, so they
 * take the lookahead path; the engine falls back to native when the platform
 * cannot register the module.
 */
export function limiterEngine(
  limiter: ProcessorParams["limiter"] | undefined,
): LimiterEngine {
  return limiter?.engine === "native" ? "native" : "worklet";
}

/** Program-limiter settings for a limiter block (old saves → bypassed). */
export function limiterProgram(
  limiter: ProcessorParams["limiter"],
): LimiterProgramParams {
  return limiter.program ?? DEFAULT_LIMITER_PROGRAM;
}

/** Published loudness standards the console can measure against. */
export type LoudnessStandardId =
  | "ebu"
  | "r128s1"
  | "atsc"
  | "spotify"
  | "apple"
  | "custom";

/**
 * Clipper settings for a limiter block. Optional on the saved object so
 * presets written before the clip stage existed load with it bypassed.
 */
export function limiterClipper(
  limiter: ProcessorParams["limiter"],
): ClipperParams {
  return limiter.clipper ?? DEFAULT_CLIPPER;
}

/** Pre-emphasis time constant: 50 µs (CEPT/Europe) or 75 µs (ITU Region 2). */
export type FmEmphasis = "off" | "50" | "75";

/**
 * FM transmission branch — pre-emphasis and the composite (MPX) generator
 * that feeds an exciter. All percentages are of the ±75 kHz total permitted
 * deviation (100 % = 75 kHz), the convention FM monitors use.
 *
 *   L+R baseband 0–15 kHz  0.9 × mono   (single-channel drive → 45 %)
 *   L−R DSB-SC @ 38 kHz    0.9 × side   (→ 45 %)
 *   pilot @ 19 kHz         8–10 %       (FCC 73.322)
 *   RDS  @ 57 kHz (3×pilot) 2–4 kHz dev  (IEC 62106 — ≈ 2.7–5.3 %)
 *   SCA  @ 67 kHz          ≤ 10 % each, subcarriers ≤ 20 % (FCC 73.319)
 *   composite ceiling      100 % frequent recurrence, 110 % absolute cap
 */
export interface FmParams {
  /** FM branch engaged — pre-emphasis + composite generator in circuit. */
  on: boolean;
  /** Pre-emphasis time constant (receiver de-emphasises to match). */
  emphasis: FmEmphasis;
  /** Composite (MPX) multiplex generator. */
  mpx: {
    on: boolean;
    /** 19 kHz pilot level, % of total deviation (FCC 73.322: 8–10 %). */
    pilotPct: number;
    /** 57 kHz RDS injection, % of 75 kHz (2–4 kHz deviation typical). */
    rdsPct: number;
    /** RDS programme service name — 8 characters, space-padded. */
    rdsPs: string;
    /** Programme identification, 4 hex digits (e.g. "C479"). */
    rdsPi: string;
    /** Programme type 0–31 (IEC 62106 Annex F table). */
    rdsPty: number;
    /** RadioText, up to 64 characters (group 2A). */
    rdsRt: string;
    /**
     * Alternative frequencies in MHz. The first is carried in group 0A's
     * block C as "one alternative" — the count field is emitted as 1 so the
     * list is never over-claimed.
     */
    rdsAf: number[];
    /** Scroll a longer PS text through the 8-character window. */
    rdsScroll: boolean;
    /**
     * Delay RDS text changes by this many ms, so station/artist text lines up
     * with audio that is itself delayed (profanity delay, diversity delay).
     */
    rdsDelayMs: number;
    /** Drive RadioText from the station's now-playing metadata. */
    rdsRtAuto: boolean;
    /**
     * RadioText Plus: announce the application in group 3A and tag two
     * character ranges of the RadioText (artist, title) in group 11A.
     */
    rdsRtPlus: boolean;
    /** 67 kHz SCA subcarrier, % of total deviation (unmodulated placeholder). */
    scaPct: number;
    /** Composite clipper ceiling, % of ±75 kHz (US cap: 110 %). */
    ceilingPct: number;
    /** Overmodulation alarm threshold, % — sustained demand trips it. */
    alarmPct: number;
  };
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
  hpf: { on: boolean; freqHz: number; slope?: HpfSlope };
  /**
   * Phase rotation: a 4-stage allpass cascade (staggered around the tuning
   * frequency) that makes asymmetrical speech waveforms symmetrical so the
   * limiter meets the same peak from either polarity.
   * auto = fixed voice window, manual = user frequency.
   */
  phase: { on: boolean; mode: "auto" | "manual"; freqHz: number };
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
    /** Slow window: long-term program levelling (the main AGC stage). */
    thresholdDb: number;
    ratio: number;
    kneeDb: number;
    attackMs: number;
    releaseMs: number;
    makeupDb: number;
    /**
     * Window gate: while the programme's level spread over the last 1.5 s
     * stays inside this many dB, the AGC gain is held rather than re-ridden,
     * so quiet intros and speech pauses do not pump the noise floor.
     * 0 = off.
     */
    windowDb: number;
    /**
     * Auto-speech sensing: while the mic feed carries programme, halve AGC
     * and multiband attack/release so speech transients stay ahead of the
     * gain. Detection lives in the engine (mic + live level); the flag is
     * reported back in the meter snapshot.
     */
    speechSense: boolean;
    /** Fast peak window, ahead of the slow leveller (optional for old saves). */
    fast?: AgcFastParams;
  };
  /** High-frequency dynamic de-esser ahead of the limiter. */
  deess: DeessParams;
  /**
   * Less–More master density macro, 1 (open, dynamic) … 10 (dense, loud).
   * One control scales multiband ratios, their attack/release and the drive
   * into the final limiter together.
   */
  density: number;
  limiter: {
    on: boolean;
    ceilingDb: number;
    attackMs: number;
    releaseMs: number;
    /** Soft clip stage ahead of the peak limiter (optional for old presets). */
    clipper?: ClipperParams;
    /**
     * Second, slower limiter after the peak stage: it takes the residual
     * short-term level and keeps it under its own ceiling, so the fast stage
     * only ever sees transients. Optional for old saves → bypassed.
     */
    program?: LimiterProgramParams;
    /**
     * Adaptive release: lengthen/shorten both limiter releases from the live
     * crest factor — faster on percussive programme, smoother on sustained
     * music — instead of one fixed release for everything.
     */
    adaptive?: boolean;
    /**
     * Hold (ms): once the limiter has pulled more than ~1.5 dB, the release
     * is frozen for this long so short loud peaks cannot breathe between
     * events. 0 = off. Bounded 20–200 ms in the control loop.
     */
    holdMs?: number;
    /**
     * True-peak meter oversampling: 2×, 4× (default) or 8×. Higher factors
     * resolve shallower inter-sample crests — the ones a lossy encoder will
     * rebuild — at a higher metering cost.
     */
    truePeakX?: 2 | 4 | 8;
    /**
     * Peak-stage implementation. "worklet" runs the lookahead brickwall on
     * the audio thread; "native" keeps the browser compressor. Absent on old
     * saves → worklet, with an automatic fallback where it cannot load.
     */
    engine?: LimiterEngine;
  };
  /**
   * M/S stereo image: width 1 = neutral, >1 widens the side channel;
   * lowMonoHz folds the side channel to mono below the crossover so
   * sub-bass stays centred (FM / club / phone safe). 0 = off.
   */
  stereo: { width: number; lowMonoHz: number };
  /**
   * Loudness compliance target. `standard` picks a published target (EBU R128
   * −23, R128 s1 −16, ATSC A/85 −24, Spotify −14, Apple Music −16) and
   * `custom` uses the two values below. The rider, the target readout and the
   * compliance flag all follow this one choice.
   */
  loudness: {
    standard: LoudnessStandardId;
    customLufs: number;
    customTpDb: number;
  };
  /**
   * Monitoring checks. These are applied on the monitor path only — the
   * encoder send always carries the untouched processed programme, so a mono
   * check or a polarity flip can never leak on air.
   */
  monitor: { mono: boolean; invertL: boolean; invertR: boolean };
  /** Parallel harmonic exciter (Aphex-style sweetening). */
  exciter: { on: boolean; mix: number; freqHz: number };
  /** FM transmission branch (pre-emphasis + MPX composite generator). */
  fm: FmParams;
  rider: RiderParams;
  outputGainDb: number;
  monitorDb: number;
  duckDb: number;
  /**
   * Psychoacoustic layer (v3.0): all modules default bypassed/neutral, so
   * existing presets and the default chain sound byte-identical with it.
   */
  psy: PsyParams;
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
/** Compact per-band captions for the MB gain-reduction meter strip. */
export const MB_SHORT_LABELS = [
  "SUB",
  "BASS",
  "L-MID",
  "H-MID",
  "PRES",
  "AIR",
] as const;
export const DEQ_LABELS = ["Sub", "Mud", "Mid", "Presence", "Air"] as const;
/**
 * Default streaming loudness target (AES-71 web-streaming practice).
 * Curated broadcast presets that must stay put — the OFCOM compliance
 * family at −23 LUFS, classical, jazz, etc. — carry explicit targets and
 * are unaffected by this default.
 */
export const LUFS_TARGET = -14;
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
  hpf: { on: true, freqHz: 80, slope: 24 },
  phase: { on: true, mode: "auto", freqHz: 300 },
  gate: { on: true, thresholdDb: -52, holdMs: 1500 },
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
    windowDb: 0,
    speechSense: false,
    fast: { ...DEFAULT_AGC_FAST },
  },
  deess: {
    on: true,
    freqHz: 7500,
    thresholdDb: -26,
    maxCutDb: 6,
    attackMs: 1,
    releaseMs: 60,
  },
  density: 5,
  limiter: {
    on: true,
    ceilingDb: -1,
    attackMs: 1.5,
    releaseMs: 100,
    clipper: { ...DEFAULT_CLIPPER },
    program: { ...DEFAULT_LIMITER_PROGRAM },
    adaptive: false,
    holdMs: 0,
    truePeakX: 4,
    engine: "worklet",
  },
  stereo: { width: 1, lowMonoHz: 120 },
  loudness: { standard: "spotify", customLufs: LUFS_TARGET, customTpDb: TRUE_PEAK_TARGET },
  monitor: { mono: false, invertL: false, invertR: false },
  exciter: { on: false, mix: 3, freqHz: 3200 },
  fm: {
    on: false,
    emphasis: "75",
    mpx: {
      on: true,
      pilotPct: 9,
      rdsPct: 3.3,
      rdsPs: "SIGNAL  ",
      rdsPi: "C479",
      rdsPty: 10,
      rdsRt: "Signalpath broadcast",
      rdsAf: [],
      rdsScroll: false,
      rdsDelayMs: 0,
      rdsRtAuto: true,
      rdsRtPlus: true,
      scaPct: 0,
      ceilingPct: 100,
      alarmPct: 100,
    },
  },
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
  psy: structuredClone(DEFAULT_PSY),
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

/**
 * Presets patch a chain section (e.g. only the AGC fields they retune) and
 * let the rest fall back to the defaults, so the patch type has to be deep:
 * a shallow Partial would demand every field of every nested block and force
 * all ~40 presets to be rewritten whenever a control is added.
 */
type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends readonly unknown[]
    ? T[K]
    : T[K] extends object
      ? DeepPartial<T[K]>
      : T[K];
};

const merge = (patch: DeepPartial<ProcessorParams>): ProcessorParams =>
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
 * characters of real Orban Optimod (8500/8600/8700i) and Omnia (ONE/9)
 * factory presets. Neither manufacturer publishes numeric recipes, so each
 * preset follows its documented *behaviour* and factory-preset roster:
 *
 * - Orban's density rule: "Open" = slow multiband release, "Medium" =
 *   medium-slow, "Dense" = medium-fast, with fast release reserved for
 *   NEWS-TALK and SPORTS only.
 * - Orban 8500/8600 factory names: NEWS-TALK, SPORTS, JAZZ, SMOOTH JAZZ,
 *   ROCK-DENSE/OPEN/MEDIUM, URBAN-HEAVY/LIGHT, COUNTRY-MEDIUM, GOLD,
 *   IMPACT, plus the LOUD-* texture family.
 * - Documented characters: ROCK bright highs + punchy lows + vocal
 *   presence, URBAN 18 dB/oct bass shape, JAZZ quiet/mellow restraint,
 *   IMPACT maximum loudness.
 * - Omnia: the documented 180 Hz / 1 kHz / 3.3 kHz / 6.5 kHz band
 *   structure (OMNIA_SPLITS), purist Classical handling, and the ONE's
 *   AC / CHR / urban-dance format extension set.
 * - Extended Orban 8500 roster: COUNTRY-LIGHT (ROCK-LIGHT source preset),
 *   ROCK-LIGHT, ROCK-SOFT (FOLK-TRADITIONAL is its documented alias),
 *   INSTRUMENTAL, CRISP (loud, ~6 kHz emphasis per the 8700i), EDGE and
 *   DANCE ENERGY (documented as preserving dance percussion punch + slam).
 * - Omnia.9's named "New York" preset grounds the metro-market entry.
 * - Format presets (Hot AC, 80s, 90s, Classic Hits, Oldies, Christian,
 *   Rhythmic, Metal) are genre models, not factory-name copies — no
 *   manufacturer publishes factory presets under those exact names.
 * - Signature family: this app's own curated house presets (research
 *   found no manufacturer-shipped "Signature" collection — Telos runs a
 *   sharing program to encourage "signature sounds" instead). Grounded in
 *   documented references: proximity-effect VOG bass, the −14 LUFS / below
 *   −1 dBTP Spotify platform reference, the −16 LUFS stereo podcast
 *   convention (Apple/podnews), and HD/digital-chain guidance for gentler
 *   timing and conservative true-peak headroom.
 * - Omnia texture family: the documented Omnia preset characters — Natural,
 *   Bright, Clear, Smooth, Full, Forward, Slam, Punchy, Dense, Hot and Bold
 *   — form a graded ladder from open/transparent to fully processed, plus
 *   the voice-optimised Talk (phase rotation + fast multiband) and the
 *   gating-focused Sports tunings.
 * - OFCOM family: UK FM compliance tunings — 50 µs pre-emphasis (ITU Region 1
 *   standard, required by UK FM receivers), MPX composite engaged with a
 *   9 % pilot and 3 % RDS injection (8–10 % / 2–4 % of the ±75 kHz total
 *   permitted deviation), a hard 100 % composite ceiling with alarm, and
 *   −23 LUFS / EBU R128 loudness practice with true-peak headroom (−1.5 to
 *   −2 dBTP) so the pre-emphasis high-frequency boost can never drive the
 *   composite over 100 % modulation. Speech entries honour Ofcom's speech
 *   quota formats (talk, phone-in, sports OB).
 */
export const BUILTIN_PRESETS: BuiltinPreset[] = [
  {
    id: "omnia-general",
    name: "Omnia · General",
    description:
      "Balanced house chain in the Omnia mold: gentle levelling, musical 6-band dynamics on the ONE-style crossovers, dynamic-EQ hygiene, −1 dBTP ceiling.",
    tags: ["General", "Omnia", "−14 LUFS"],
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
  {
    id: "orban-rock-medium",
    name: "Orban · Rock Medium",
    description:
      "Optimod ROCK-MEDIUM character: Orban's documented 'Medium' density — a medium-slow multiband release between Rock Open and Rock Dense, with the family's bright top, punchy low end and vocal presence lift.",
    tags: ["Music", "Orban", "Medium"],
    family: "Orban",
    params: merge({
      hpf: { on: true, freqHz: 65 },
      eq: {
        on: true,
        bands: [
          { freq: 60, gainDb: 2.5, q: 0.7, type: "lowshelf" },
          { freq: 200, gainDb: -1.5, q: 1.1, type: "peaking" },
          { freq: 700, gainDb: 0.5, q: 1.0, type: "peaking" },
          { freq: 2500, gainDb: 2.5, q: 1.1, type: "peaking" },
          { freq: 6000, gainDb: 1, q: 1.4, type: "peaking" },
          { freq: 12000, gainDb: 2, q: 0.7, type: "highshelf" },
        ],
      },
      deq: {
        on: true,
        bands: [
          { freqHz: 80, q: 0.9, thresholdDb: -22, maxCutDb: 5, attackMs: 12, releaseMs: 300 },
          { freqHz: 250, q: 1.0, thresholdDb: -20, maxCutDb: 6, attackMs: 10, releaseMs: 280 },
          { freqHz: 1600, q: 1.1, thresholdDb: -22, maxCutDb: 4, attackMs: 8, releaseMs: 240 },
          { freqHz: 5000, q: 1.2, thresholdDb: -21, maxCutDb: 5, attackMs: 6, releaseMs: 200 },
          { freqHz: 10000, q: 1.1, thresholdDb: -23, maxCutDb: 7, attackMs: 5, releaseMs: 170 },
        ],
      },
      multiband: mb6(
        { thresholdDb: -15, ratio: 4, attackMs: 10, releaseMs: 300, makeupDb: 3 },
        { thresholdDb: -17, ratio: 4, attackMs: 7, releaseMs: 280, makeupDb: 3 },
        { thresholdDb: -19, ratio: 3.5, attackMs: 4, releaseMs: 250, makeupDb: 2 },
        [130, 480, 1900, 4800, 9500],
      ),
      agc: {
        on: true,
        thresholdDb: -20,
        ratio: 4,
        kneeDb: 6,
        attackMs: 10,
        releaseMs: 350,
        makeupDb: 6,
      },
      exciter: { on: true, mix: 3, freqHz: 5000 },
      stereo: { width: 1.1 },
      limiter: { on: true, ceilingDb: -1, attackMs: 1, releaseMs: 110 },
    }),
  },
  {
    id: "orban-smooth-jazz",
    name: "Orban · Smooth Jazz",
    description:
      "Optimod SMOOTH JAZZ factory character: the softer sibling of JAZZ — warm midrange for sax and Rhodes, a silky eased-off top and very slow dynamics that leave quiet late-night beds intact.",
    tags: ["Music", "Orban", "Silky"],
    family: "Orban",
    params: merge({
      hpf: { on: true, freqHz: 50 },
      eq: {
        on: true,
        bands: [
          { freq: 60, gainDb: 1.5, q: 0.7, type: "lowshelf" },
          { freq: 200, gainDb: -0.5, q: 0.9, type: "peaking" },
          { freq: 700, gainDb: 0.5, q: 1.0, type: "peaking" },
          { freq: 2500, gainDb: -0.5, q: 1.2, type: "peaking" },
          { freq: 6000, gainDb: -1.5, q: 1.6, type: "peaking" },
          { freq: 12000, gainDb: 0, q: 0.7, type: "highshelf" },
        ],
      },
      deq: {
        on: true,
        bands: [
          { freqHz: 80, q: 0.9, thresholdDb: -26, maxCutDb: 3, attackMs: 22, releaseMs: 460 },
          { freqHz: 250, q: 1.0, thresholdDb: -25, maxCutDb: 3, attackMs: 20, releaseMs: 440 },
          { freqHz: 1600, q: 1.1, thresholdDb: -27, maxCutDb: 2, attackMs: 16, releaseMs: 400 },
          { freqHz: 5000, q: 1.2, thresholdDb: -24, maxCutDb: 3, attackMs: 14, releaseMs: 360 },
          { freqHz: 10000, q: 1.1, thresholdDb: -26, maxCutDb: 4, attackMs: 12, releaseMs: 320 },
        ],
      },
      multiband: mb6(
        { thresholdDb: -12, ratio: 2, attackMs: 25, releaseMs: 600, makeupDb: 1 },
        { thresholdDb: -14, ratio: 2, attackMs: 18, releaseMs: 550, makeupDb: 1 },
        { thresholdDb: -16, ratio: 2.2, attackMs: 10, releaseMs: 500, makeupDb: 1 },
        [120, 450, 1800, 4800, 9800],
      ),
      agc: {
        on: true,
        thresholdDb: -16,
        ratio: 2,
        kneeDb: 10,
        attackMs: 30,
        releaseMs: 700,
        makeupDb: 3,
      },
      rider: { on: true, targetLufs: -25, maxRideDb: 5, gateDb: -58, speed: "slow" },
      stereo: { width: 1.05 },
      limiter: { on: true, ceilingDb: -1.5, attackMs: 2.5, releaseMs: 240 },
    }),
  },
  {
    id: "orban-country",
    name: "Orban · Country",
    description:
      "Optimod COUNTRY-MEDIUM character: a warm, midrange-forward balance for acoustic guitars, fiddle and vocals — moderate shaped bass, gentle presence lift and a medium-slow release that keeps the band breathing.",
    tags: ["Music", "Orban", "Warm"],
    family: "Orban",
    params: merge({
      hpf: { on: true, freqHz: 60 },
      eq: {
        on: true,
        bands: [
          { freq: 60, gainDb: 1.5, q: 0.7, type: "lowshelf" },
          { freq: 200, gainDb: -0.5, q: 1.0, type: "peaking" },
          { freq: 700, gainDb: 1, q: 1.0, type: "peaking" },
          { freq: 2500, gainDb: 2.5, q: 1.1, type: "peaking" },
          { freq: 6000, gainDb: -1, q: 1.8, type: "peaking" },
          { freq: 12000, gainDb: 1, q: 0.7, type: "highshelf" },
        ],
      },
      deq: {
        on: true,
        bands: [
          { freqHz: 80, q: 0.9, thresholdDb: -24, maxCutDb: 4, attackMs: 14, releaseMs: 340 },
          { freqHz: 250, q: 1.0, thresholdDb: -22, maxCutDb: 5, attackMs: 12, releaseMs: 320 },
          { freqHz: 1600, q: 1.1, thresholdDb: -24, maxCutDb: 4, attackMs: 9, releaseMs: 260 },
          { freqHz: 5000, q: 1.2, thresholdDb: -20, maxCutDb: 5, attackMs: 7, releaseMs: 220 },
          { freqHz: 10000, q: 1.1, thresholdDb: -24, maxCutDb: 6, attackMs: 5, releaseMs: 180 },
        ],
      },
      multiband: mb6(
        { thresholdDb: -14, ratio: 3.5, attackMs: 12, releaseMs: 320, makeupDb: 2.5 },
        { thresholdDb: -16, ratio: 3.5, attackMs: 8, releaseMs: 300, makeupDb: 2.5 },
        { thresholdDb: -18, ratio: 3.5, attackMs: 5, releaseMs: 270, makeupDb: 2 },
        [140, 500, 1900, 4700, 9600],
      ),
      agc: {
        on: true,
        thresholdDb: -18,
        ratio: 3,
        kneeDb: 7,
        attackMs: 12,
        releaseMs: 380,
        makeupDb: 5,
      },
      rider: { on: true, targetLufs: LUFS_TARGET, maxRideDb: 6, gateDb: -55, speed: "slow" },
      stereo: { width: 1.06 },
      limiter: { on: true, ceilingDb: -1, attackMs: 1.2, releaseMs: 130 },
    }),
  },
  {
    id: "orban-impact",
    name: "Orban · Impact",
    description:
      "Optimod IMPACT character: the maximum-loudness factory preset — deep AGC threshold, dense medium-fast multiband and a hot −0.5 dB ceiling for formats that must win the dial. The 8600's IMPACT MX variant trades some of this heat for cleanliness.",
    tags: ["Music", "Orban", "Loud"],
    family: "Orban",
    params: merge({
      hpf: { on: true, freqHz: 60 },
      eq: {
        on: true,
        bands: [
          { freq: 60, gainDb: 3.5, q: 0.7, type: "lowshelf" },
          { freq: 200, gainDb: -2, q: 1.1, type: "peaking" },
          { freq: 700, gainDb: 0.5, q: 1.0, type: "peaking" },
          { freq: 2500, gainDb: 3, q: 1.1, type: "peaking" },
          { freq: 6000, gainDb: 1, q: 1.4, type: "peaking" },
          { freq: 12000, gainDb: 3, q: 0.7, type: "highshelf" },
        ],
      },
      deq: {
        on: true,
        bands: [
          { freqHz: 80, q: 0.9, thresholdDb: -18, maxCutDb: 8, attackMs: 7, releaseMs: 200 },
          { freqHz: 250, q: 1.0, thresholdDb: -18, maxCutDb: 8, attackMs: 7, releaseMs: 190 },
          { freqHz: 1600, q: 1.1, thresholdDb: -20, maxCutDb: 6, attackMs: 6, releaseMs: 170 },
          { freqHz: 5000, q: 1.2, thresholdDb: -19, maxCutDb: 7, attackMs: 5, releaseMs: 150 },
          { freqHz: 10000, q: 1.1, thresholdDb: -20, maxCutDb: 10, attackMs: 4, releaseMs: 120 },
        ],
      },
      multiband: mb6(
        { thresholdDb: -19, ratio: 6, attackMs: 4, releaseMs: 140, makeupDb: 4.5 },
        { thresholdDb: -21, ratio: 5, attackMs: 2.5, releaseMs: 120, makeupDb: 4.5 },
        { thresholdDb: -21, ratio: 4.5, attackMs: 1.5, releaseMs: 100, makeupDb: 3.5 },
        [130, 470, 1900, 4800, 9500],
      ),
      agc: {
        on: true,
        thresholdDb: -26,
        ratio: 7,
        kneeDb: 2,
        attackMs: 4,
        releaseMs: 170,
        makeupDb: 10,
      },
      rider: { on: true, targetLufs: -16, maxRideDb: 8, gateDb: -50, speed: "fast" },
      exciter: { on: true, mix: 5, freqHz: 5500 },
      stereo: { width: 1.15 },
      limiter: { on: true, ceilingDb: -0.5, attackMs: 0.4, releaseMs: 70 },
    }),
  },
  {
    id: "orban-gold",
    name: "Orban · Gold",
    description:
      "Optimod GOLD character: oldies and gold formats — a warm 18 dB/octave bass shape, midrange-forward balance that flatters vintage masters, gentle taming of bright reissues and relaxed dynamics that respect mono-era recordings.",
    tags: ["Music", "Orban", "Nostalgia"],
    family: "Orban",
    params: merge({
      hpf: { on: true, freqHz: 55 },
      eq: {
        on: true,
        bands: [
          { freq: 60, gainDb: 2.5, q: 0.7, type: "lowshelf" },
          { freq: 200, gainDb: 0, q: 1.0, type: "peaking" },
          { freq: 700, gainDb: 1.5, q: 1.0, type: "peaking" },
          { freq: 2500, gainDb: 1, q: 1.1, type: "peaking" },
          { freq: 6000, gainDb: -1.5, q: 1.6, type: "peaking" },
          { freq: 12000, gainDb: -0.5, q: 0.7, type: "highshelf" },
        ],
      },
      deq: {
        on: true,
        bands: [
          { freqHz: 80, q: 0.9, thresholdDb: -24, maxCutDb: 4, attackMs: 16, releaseMs: 380 },
          { freqHz: 250, q: 1.0, thresholdDb: -23, maxCutDb: 5, attackMs: 14, releaseMs: 360 },
          { freqHz: 1600, q: 1.1, thresholdDb: -25, maxCutDb: 3, attackMs: 12, releaseMs: 320 },
          { freqHz: 5000, q: 1.2, thresholdDb: -24, maxCutDb: 4, attackMs: 10, releaseMs: 280 },
          { freqHz: 10000, q: 1.1, thresholdDb: -26, maxCutDb: 4, attackMs: 9, releaseMs: 260 },
        ],
      },
      multiband: mb6(
        { thresholdDb: -13, ratio: 2.5, attackMs: 18, releaseMs: 450, makeupDb: 2 },
        { thresholdDb: -15, ratio: 2.5, attackMs: 12, releaseMs: 420, makeupDb: 2 },
        { thresholdDb: -17, ratio: 2.5, attackMs: 8, releaseMs: 380, makeupDb: 1.5 },
        [130, 460, 1800, 4700, 9500],
      ),
      agc: {
        on: true,
        thresholdDb: -16,
        ratio: 2.5,
        kneeDb: 8,
        attackMs: 20,
        releaseMs: 550,
        makeupDb: 4,
      },
      rider: { on: true, targetLufs: -23, maxRideDb: 6, gateDb: -56, speed: "slow" },
      stereo: { width: 1.03 },
      limiter: { on: true, ceilingDb: -1.2, attackMs: 1.8, releaseMs: 180 },
    }),
  },
  {
    id: "orban-urban-light",
    name: "Orban · Urban Light",
    description:
      "Optimod URBAN-LIGHT factory character: the same documented 18 dB/octave bass-EQ shape as Urban Heavy, dialed back — groove without dominating small speakers, moderate density, wider headroom.",
    tags: ["Music", "Orban", "Bass"],
    family: "Orban",
    params: merge({
      hpf: { on: true, freqHz: 50 },
      eq: {
        on: true,
        bands: [
          { freq: 60, gainDb: 2.5, q: 0.7, type: "lowshelf" },
          { freq: 200, gainDb: -0.5, q: 1.0, type: "peaking" },
          { freq: 700, gainDb: 0, q: 1.0, type: "peaking" },
          { freq: 2500, gainDb: 1.5, q: 1.1, type: "peaking" },
          { freq: 6000, gainDb: 0.5, q: 1.4, type: "peaking" },
          { freq: 12000, gainDb: 1.5, q: 0.7, type: "highshelf" },
        ],
      },
      deq: {
        on: true,
        bands: [
          { freqHz: 80, q: 0.9, thresholdDb: -20, maxCutDb: 7, attackMs: 9, releaseMs: 240 },
          { freqHz: 250, q: 1.0, thresholdDb: -20, maxCutDb: 6, attackMs: 8, releaseMs: 220 },
          { freqHz: 1600, q: 1.1, thresholdDb: -22, maxCutDb: 4, attackMs: 7, releaseMs: 200 },
          { freqHz: 5000, q: 1.2, thresholdDb: -22, maxCutDb: 5, attackMs: 6, releaseMs: 180 },
          { freqHz: 10000, q: 1.1, thresholdDb: -23, maxCutDb: 7, attackMs: 5, releaseMs: 150 },
        ],
      },
      multiband: mb6(
        { thresholdDb: -16, ratio: 4, attackMs: 7, releaseMs: 220, makeupDb: 3.5 },
        { thresholdDb: -18, ratio: 4, attackMs: 5, releaseMs: 200, makeupDb: 3 },
        { thresholdDb: -19, ratio: 3.5, attackMs: 2.5, releaseMs: 180, makeupDb: 2.5 },
        [120, 450, 1800, 4700, 9500],
      ),
      agc: {
        on: true,
        thresholdDb: -20,
        ratio: 4.5,
        kneeDb: 4,
        attackMs: 6,
        releaseMs: 220,
        makeupDb: 6,
      },
      stereo: { width: 1.12 },
      limiter: { on: true, ceilingDb: -1, attackMs: 0.8, releaseMs: 90 },
    }),
  },
  {
    id: "omnia-ac",
    name: "Omnia · AC",
    description:
      "Omnia ONE adult-contemporary lineage (part of the format extension set added to the ONE's preset bank): warm, smooth and vocal-forward — gentle density, silky top end and a slow rider that keeps ballads level against the talk breaks.",
    tags: ["Music", "Omnia", "Smooth"],
    family: "Omnia",
    params: merge({
      hpf: { on: true, freqHz: 60 },
      eq: {
        on: true,
        bands: [
          { freq: 60, gainDb: 1.5, q: 0.7, type: "lowshelf" },
          { freq: 200, gainDb: -1, q: 1.0, type: "peaking" },
          { freq: 700, gainDb: 0.5, q: 1.0, type: "peaking" },
          { freq: 2500, gainDb: 2, q: 1.1, type: "peaking" },
          { freq: 6000, gainDb: -0.5, q: 1.6, type: "peaking" },
          { freq: 12000, gainDb: 1.5, q: 0.7, type: "highshelf" },
        ],
      },
      deq: {
        on: true,
        bands: [
          { freqHz: 80, q: 0.9, thresholdDb: -23, maxCutDb: 5, attackMs: 13, releaseMs: 320 },
          { freqHz: 250, q: 1.0, thresholdDb: -22, maxCutDb: 5, attackMs: 11, releaseMs: 300 },
          { freqHz: 1600, q: 1.1, thresholdDb: -24, maxCutDb: 4, attackMs: 8, releaseMs: 240 },
          { freqHz: 5000, q: 1.2, thresholdDb: -22, maxCutDb: 4, attackMs: 7, releaseMs: 210 },
          { freqHz: 10000, q: 1.1, thresholdDb: -24, maxCutDb: 7, attackMs: 5, releaseMs: 170 },
        ],
      },
      multiband: mb6(
        { thresholdDb: -14, ratio: 3.5, attackMs: 12, releaseMs: 280, makeupDb: 2.5 },
        { thresholdDb: -16, ratio: 3.5, attackMs: 8, releaseMs: 250, makeupDb: 2.5 },
        { thresholdDb: -18, ratio: 3.5, attackMs: 5, releaseMs: 200, makeupDb: 2 },
        [...OMNIA_SPLITS] as MultibandSplits,
      ),
      agc: {
        on: true,
        thresholdDb: -18,
        ratio: 3,
        kneeDb: 7,
        attackMs: 12,
        releaseMs: 320,
        makeupDb: 5,
      },
      rider: { on: true, targetLufs: -23, maxRideDb: 6, gateDb: -56, speed: "slow" },
      stereo: { width: 1.08 },
      limiter: { on: true, ceilingDb: -1, attackMs: 1.2, releaseMs: 140 },
    }),
  },
  {
    id: "omnia-chr",
    name: "Omnia · CHR",
    description:
      "Omnia ONE CHR extension lineage: competitive top-40 density — bright, forward and loud, with a fast levelling AGC, tight de-essing and a −0.8 dBTP ceiling that stays legal while sounding hot.",
    tags: ["Music", "Omnia", "Loud"],
    family: "Omnia",
    params: merge({
      hpf: { on: true, freqHz: 65 },
      eq: {
        on: true,
        bands: [
          { freq: 60, gainDb: 3, q: 0.7, type: "lowshelf" },
          { freq: 200, gainDb: -1.5, q: 1.1, type: "peaking" },
          { freq: 700, gainDb: 0.5, q: 1.0, type: "peaking" },
          { freq: 2500, gainDb: 3, q: 1.1, type: "peaking" },
          { freq: 6000, gainDb: 1.5, q: 1.4, type: "peaking" },
          { freq: 12000, gainDb: 3, q: 0.7, type: "highshelf" },
        ],
      },
      deq: {
        on: true,
        bands: [
          { freqHz: 80, q: 0.9, thresholdDb: -19, maxCutDb: 7, attackMs: 8, releaseMs: 210 },
          { freqHz: 250, q: 1.0, thresholdDb: -18, maxCutDb: 7, attackMs: 7, releaseMs: 200 },
          { freqHz: 1600, q: 1.1, thresholdDb: -20, maxCutDb: 6, attackMs: 6, releaseMs: 180 },
          { freqHz: 5000, q: 1.2, thresholdDb: -19, maxCutDb: 7, attackMs: 5, releaseMs: 160 },
          { freqHz: 10000, q: 1.1, thresholdDb: -20, maxCutDb: 10, attackMs: 4, releaseMs: 120 },
        ],
      },
      multiband: mb6(
        { thresholdDb: -18, ratio: 5, attackMs: 5, releaseMs: 160, makeupDb: 4 },
        { thresholdDb: -20, ratio: 4.5, attackMs: 3, releaseMs: 140, makeupDb: 4 },
        { thresholdDb: -21, ratio: 4, attackMs: 1.5, releaseMs: 110, makeupDb: 3.5 },
        [...OMNIA_SPLITS] as MultibandSplits,
      ),
      agc: {
        on: true,
        thresholdDb: -24,
        ratio: 5,
        kneeDb: 3,
        attackMs: 5,
        releaseMs: 190,
        makeupDb: 8,
      },
      rider: { on: true, targetLufs: -17, maxRideDb: 8, gateDb: -52, speed: "fast" },
      exciter: { on: true, mix: 4, freqHz: 5500 },
      stereo: { width: 1.14 },
      limiter: { on: true, ceilingDb: -0.8, attackMs: 0.5, releaseMs: 80 },
    }),
  },
  {
    id: "omnia-dance",
    name: "Omnia · Dance",
    description:
      "Omnia ONE urban/dance extension lineage: a deep bottom that is compressed fast enough to pump on the beat without flapping, a crisp open top and wide stereo for club and electronic formats.",
    tags: ["Music", "Omnia", "Club"],
    family: "Omnia",
    params: merge({
      hpf: { on: true, freqHz: 40 },
      eq: {
        on: true,
        bands: [
          { freq: 60, gainDb: 4.5, q: 0.7, type: "lowshelf" },
          { freq: 200, gainDb: -1.5, q: 1.0, type: "peaking" },
          { freq: 700, gainDb: 0, q: 1.0, type: "peaking" },
          { freq: 2500, gainDb: 1.5, q: 1.1, type: "peaking" },
          { freq: 6000, gainDb: 1, q: 1.4, type: "peaking" },
          { freq: 12000, gainDb: 2.5, q: 0.7, type: "highshelf" },
        ],
      },
      deq: {
        on: true,
        bands: [
          { freqHz: 80, q: 0.9, thresholdDb: -17, maxCutDb: 9, attackMs: 6, releaseMs: 200 },
          { freqHz: 250, q: 1.0, thresholdDb: -18, maxCutDb: 7, attackMs: 7, releaseMs: 210 },
          { freqHz: 1600, q: 1.1, thresholdDb: -21, maxCutDb: 5, attackMs: 6, releaseMs: 180 },
          { freqHz: 5000, q: 1.2, thresholdDb: -21, maxCutDb: 5, attackMs: 5, releaseMs: 160 },
          { freqHz: 10000, q: 1.1, thresholdDb: -22, maxCutDb: 8, attackMs: 4, releaseMs: 130 },
        ],
      },
      multiband: mb6(
        { thresholdDb: -17, ratio: 5, attackMs: 5, releaseMs: 180, makeupDb: 4 },
        { thresholdDb: -19, ratio: 4.5, attackMs: 3.5, releaseMs: 150, makeupDb: 3.5 },
        { thresholdDb: -20, ratio: 4, attackMs: 2, releaseMs: 120, makeupDb: 3 },
        [...OMNIA_SPLITS] as MultibandSplits,
      ),
      agc: {
        on: true,
        thresholdDb: -23,
        ratio: 4.5,
        kneeDb: 4,
        attackMs: 6,
        releaseMs: 240,
        makeupDb: 7,
      },
      stereo: { width: 1.18 },
      limiter: { on: true, ceilingDb: -0.8, attackMs: 0.5, releaseMs: 85 },
    }),
  },
  {
    id: "orban-rock-light",
    name: "Orban · Rock Light",
    description:
      "Optimod ROCK-LIGHT factory preset: the gentle end of the rock family — modest low-end weight, a touch of presence and enough air to keep cymbals alive without Rock Medium/Dense density. Orban documents COUNTRY-LIGHT as taking this preset's source tuning.",
    tags: ["Music", "Orban", "Light"],
    family: "Orban",
    params: merge({
      hpf: { on: true, freqHz: 65 },
      eq: {
        on: true,
        bands: [
          { freq: 60, gainDb: 1.5, q: 0.7, type: "lowshelf" },
          { freq: 200, gainDb: -0.5, q: 1.1, type: "peaking" },
          { freq: 700, gainDb: 0, q: 1.0, type: "peaking" },
          { freq: 2500, gainDb: 1.5, q: 1.1, type: "peaking" },
          { freq: 6000, gainDb: 0.5, q: 1.4, type: "peaking" },
          { freq: 12000, gainDb: 1.5, q: 0.7, type: "highshelf" },
        ],
      },
      deq: {
        on: true,
        bands: [
          { freqHz: 80, q: 0.9, thresholdDb: -23, maxCutDb: 4, attackMs: 14, releaseMs: 330 },
          { freqHz: 250, q: 1.0, thresholdDb: -21, maxCutDb: 5, attackMs: 12, releaseMs: 310 },
          { freqHz: 1600, q: 1.1, thresholdDb: -23, maxCutDb: 3, attackMs: 10, releaseMs: 270 },
          { freqHz: 5000, q: 1.2, thresholdDb: -21, maxCutDb: 4, attackMs: 8, releaseMs: 230 },
          { freqHz: 10000, q: 1.1, thresholdDb: -23, maxCutDb: 6, attackMs: 6, releaseMs: 190 },
        ],
      },
      multiband: mb6(
        { thresholdDb: -13, ratio: 3, attackMs: 14, releaseMs: 380, makeupDb: 2 },
        { thresholdDb: -15, ratio: 3, attackMs: 9, releaseMs: 340, makeupDb: 2 },
        { thresholdDb: -17, ratio: 3, attackMs: 6, releaseMs: 300, makeupDb: 1.5 },
        [130, 480, 1900, 4800, 9500],
      ),
      agc: {
        on: true,
        thresholdDb: -17,
        ratio: 2.5,
        kneeDb: 8,
        attackMs: 16,
        releaseMs: 460,
        makeupDb: 4,
      },
      stereo: { width: 1.1 },
      limiter: { on: true, ceilingDb: -1, attackMs: 1.1, releaseMs: 135 },
    }),
  },
  {
    id: "orban-country-light",
    name: "Orban · Country Light",
    description:
      "Optimod COUNTRY-LIGHT factory preset — documented as taking ROCK-LIGHT's source tuning: light country balance with sparkle for twang and pedal steel instead of weight, and a slow hand on the faders.",
    tags: ["Music", "Orban", "Light"],
    family: "Orban",
    params: merge({
      hpf: { on: true, freqHz: 60 },
      eq: {
        on: true,
        bands: [
          { freq: 60, gainDb: 0.5, q: 0.7, type: "lowshelf" },
          { freq: 200, gainDb: 0, q: 1.0, type: "peaking" },
          { freq: 700, gainDb: 0.5, q: 1.0, type: "peaking" },
          { freq: 2500, gainDb: 2, q: 1.1, type: "peaking" },
          { freq: 6000, gainDb: -0.5, q: 1.8, type: "peaking" },
          { freq: 12000, gainDb: 1.5, q: 0.7, type: "highshelf" },
        ],
      },
      deq: {
        on: true,
        bands: [
          { freqHz: 80, q: 0.9, thresholdDb: -24, maxCutDb: 4, attackMs: 15, releaseMs: 350 },
          { freqHz: 250, q: 1.0, thresholdDb: -22, maxCutDb: 4, attackMs: 13, releaseMs: 330 },
          { freqHz: 1600, q: 1.1, thresholdDb: -24, maxCutDb: 3, attackMs: 10, releaseMs: 280 },
          { freqHz: 5000, q: 1.2, thresholdDb: -21, maxCutDb: 4, attackMs: 8, releaseMs: 240 },
          { freqHz: 10000, q: 1.1, thresholdDb: -23, maxCutDb: 5, attackMs: 6, releaseMs: 200 },
        ],
      },
      multiband: mb6(
        { thresholdDb: -12, ratio: 2.5, attackMs: 15, releaseMs: 420, makeupDb: 1.5 },
        { thresholdDb: -14, ratio: 2.5, attackMs: 10, releaseMs: 380, makeupDb: 1.5 },
        { thresholdDb: -16, ratio: 2.5, attackMs: 6, releaseMs: 330, makeupDb: 1 },
        [140, 500, 1900, 4700, 9600],
      ),
      agc: {
        on: true,
        thresholdDb: -16,
        ratio: 2,
        kneeDb: 10,
        attackMs: 18,
        releaseMs: 500,
        makeupDb: 3,
      },
      rider: { on: true, targetLufs: LUFS_TARGET, maxRideDb: 6, gateDb: -56, speed: "slow" },
      stereo: { width: 1.08 },
      limiter: { on: true, ceilingDb: -1, attackMs: 1.4, releaseMs: 155 },
    }),
  },
  {
    id: "orban-rock-soft",
    name: "Orban · Rock Soft",
    description:
      "Optimod ROCK-SOFT factory preset: soft-rock/album-rock — warm low mids, an eased-off top and slow dynamics that keep melodic, vocal-led formats breathing. Orban documents FOLK-TRADITIONAL as an alias of this tuning.",
    tags: ["Music", "Orban", "Soft"],
    family: "Orban",
    params: merge({
      hpf: { on: true, freqHz: 60 },
      eq: {
        on: true,
        bands: [
          { freq: 60, gainDb: 2, q: 0.7, type: "lowshelf" },
          { freq: 200, gainDb: -0.5, q: 1.0, type: "peaking" },
          { freq: 700, gainDb: 0.5, q: 1.0, type: "peaking" },
          { freq: 2500, gainDb: 1, q: 1.1, type: "peaking" },
          { freq: 6000, gainDb: -1, q: 1.5, type: "peaking" },
          { freq: 12000, gainDb: 0.5, q: 0.7, type: "highshelf" },
        ],
      },
      deq: {
        on: true,
        bands: [
          { freqHz: 80, q: 0.9, thresholdDb: -24, maxCutDb: 4, attackMs: 18, releaseMs: 420 },
          { freqHz: 250, q: 1.0, thresholdDb: -23, maxCutDb: 4, attackMs: 16, releaseMs: 400 },
          { freqHz: 1600, q: 1.1, thresholdDb: -25, maxCutDb: 3, attackMs: 13, releaseMs: 350 },
          { freqHz: 5000, q: 1.2, thresholdDb: -23, maxCutDb: 3, attackMs: 11, releaseMs: 310 },
          { freqHz: 10000, q: 1.1, thresholdDb: -25, maxCutDb: 5, attackMs: 9, releaseMs: 270 },
        ],
      },
      multiband: mb6(
        { thresholdDb: -12, ratio: 2, attackMs: 18, releaseMs: 540, makeupDb: 1.5 },
        { thresholdDb: -14, ratio: 2, attackMs: 13, releaseMs: 490, makeupDb: 1.5 },
        { thresholdDb: -16, ratio: 2.2, attackMs: 9, releaseMs: 440, makeupDb: 1 },
        [130, 470, 1850, 4700, 9500],
      ),
      agc: {
        on: true,
        thresholdDb: -16,
        ratio: 2,
        kneeDb: 10,
        attackMs: 25,
        releaseMs: 600,
        makeupDb: 3,
      },
      rider: { on: true, targetLufs: -23, maxRideDb: 5, gateDb: -58, speed: "slow" },
      stereo: { width: 1.08 },
      limiter: { on: true, ceilingDb: -1.2, attackMs: 2.4, releaseMs: 230 },
    }),
  },
  {
    id: "orban-folk-traditional",
    name: "Orban · Folk / Traditional",
    description:
      "Optimod FOLK-TRADITIONAL factory preset — the 8700i documents it as an alias of ROCK-SOFT: subtle processing for acoustic and roots music drawn from relatively recent, clean recordings; finger and bow noise left intact.",
    tags: ["Music", "Orban", "Acoustic"],
    family: "Orban",
    params: merge({
      hpf: { on: true, freqHz: 55 },
      eq: {
        on: true,
        bands: [
          { freq: 60, gainDb: 1, q: 0.7, type: "lowshelf" },
          { freq: 200, gainDb: 0, q: 1.0, type: "peaking" },
          { freq: 700, gainDb: 0.5, q: 1.0, type: "peaking" },
          { freq: 2500, gainDb: 1.5, q: 1.1, type: "peaking" },
          { freq: 6000, gainDb: -0.5, q: 1.6, type: "peaking" },
          { freq: 12000, gainDb: 1, q: 0.7, type: "highshelf" },
        ],
      },
      deq: {
        on: true,
        bands: [
          { freqHz: 80, q: 0.9, thresholdDb: -25, maxCutDb: 3, attackMs: 20, releaseMs: 460 },
          { freqHz: 250, q: 1.0, thresholdDb: -24, maxCutDb: 4, attackMs: 18, releaseMs: 440 },
          { freqHz: 1600, q: 1.1, thresholdDb: -26, maxCutDb: 3, attackMs: 14, releaseMs: 380 },
          { freqHz: 5000, q: 1.2, thresholdDb: -24, maxCutDb: 3, attackMs: 12, releaseMs: 340 },
          { freqHz: 10000, q: 1.1, thresholdDb: -26, maxCutDb: 4, attackMs: 10, releaseMs: 300 },
        ],
      },
      multiband: mb6(
        { thresholdDb: -12, ratio: 2, attackMs: 20, releaseMs: 560, makeupDb: 1.5 },
        { thresholdDb: -14, ratio: 2, attackMs: 14, releaseMs: 510, makeupDb: 1.5 },
        { thresholdDb: -16, ratio: 2, attackMs: 10, releaseMs: 460, makeupDb: 1 },
        [140, 520, 1950, 4900, 9800],
      ),
      agc: {
        on: true,
        thresholdDb: -15,
        ratio: 2,
        kneeDb: 11,
        attackMs: 28,
        releaseMs: 650,
        makeupDb: 3,
      },
      rider: { on: true, targetLufs: -24, maxRideDb: 5, gateDb: -58, speed: "slow" },
      stereo: { width: 1.05 },
      limiter: { on: true, ceilingDb: -1.5, attackMs: 3.2, releaseMs: 275 },
    }),
  },
  {
    id: "orban-instrumental",
    name: "Orban · Instrumental",
    description:
      "Optimod INSTRUMENTAL factory preset: mood/background music — the quietest hand in the library, wide-but-mono-safe imaging and dynamics slow enough to feel like level control rather than compression.",
    tags: ["Music", "Orban", "Mood"],
    family: "Orban",
    params: merge({
      hpf: { on: true, freqHz: 45 },
      eq: {
        on: true,
        bands: [
          { freq: 60, gainDb: 1, q: 0.7, type: "lowshelf" },
          { freq: 200, gainDb: -0.5, q: 1.0, type: "peaking" },
          { freq: 700, gainDb: 0, q: 1.0, type: "peaking" },
          { freq: 2500, gainDb: 0.5, q: 1.2, type: "peaking" },
          { freq: 6000, gainDb: 0, q: 1.4, type: "peaking" },
          { freq: 12000, gainDb: 1, q: 0.7, type: "highshelf" },
        ],
      },
      deq: {
        on: true,
        bands: [
          { freqHz: 80, q: 0.9, thresholdDb: -27, maxCutDb: 3, attackMs: 24, releaseMs: 500 },
          { freqHz: 250, q: 1.0, thresholdDb: -26, maxCutDb: 3, attackMs: 22, releaseMs: 480 },
          { freqHz: 1600, q: 1.1, thresholdDb: -28, maxCutDb: 2, attackMs: 18, releaseMs: 440 },
          { freqHz: 5000, q: 1.2, thresholdDb: -26, maxCutDb: 3, attackMs: 16, releaseMs: 400 },
          { freqHz: 10000, q: 1.1, thresholdDb: -28, maxCutDb: 3, attackMs: 13, releaseMs: 360 },
        ],
      },
      multiband: mb6(
        { thresholdDb: -11, ratio: 1.8, attackMs: 25, releaseMs: 650, makeupDb: 1 },
        { thresholdDb: -13, ratio: 1.8, attackMs: 20, releaseMs: 600, makeupDb: 1 },
        { thresholdDb: -15, ratio: 1.8, attackMs: 15, releaseMs: 520, makeupDb: 0.5 },
        [150, 550, 2000, 5000, 10000],
      ),
      agc: {
        on: true,
        thresholdDb: -14,
        ratio: 1.6,
        kneeDb: 12,
        attackMs: 45,
        releaseMs: 900,
        makeupDb: 2,
      },
      rider: { on: true, targetLufs: -25, maxRideDb: 5, gateDb: -60, speed: "slow" },
      stereo: { width: 1.1 },
      limiter: { on: true, ceilingDb: -1.5, attackMs: 4, releaseMs: 320 },
    }),
  },
  {
    id: "orban-crisp",
    name: "Orban · Crisp",
    description:
      "Optimod CRISP factory preset — the 8700i describes it as a loud, bright-upper-mid 8500-style tuning emphasizing around 6 kHz, aimed at mass-appeal formats that need to cut through noise floors and car speakers.",
    tags: ["Music", "Orban", "Bright"],
    family: "Orban",
    params: merge({
      hpf: { on: true, freqHz: 90 },
      eq: {
        on: true,
        bands: [
          { freq: 60, gainDb: -1.5, q: 0.7, type: "lowshelf" },
          { freq: 200, gainDb: -1, q: 1.0, type: "peaking" },
          { freq: 700, gainDb: 1, q: 1.0, type: "peaking" },
          { freq: 2500, gainDb: 2, q: 1.1, type: "peaking" },
          { freq: 6000, gainDb: 3, q: 1.3, type: "peaking" },
          { freq: 12000, gainDb: 2, q: 0.7, type: "highshelf" },
        ],
      },
      deq: {
        on: true,
        bands: [
          { freqHz: 80, q: 0.9, thresholdDb: -24, maxCutDb: 5, attackMs: 10, releaseMs: 240 },
          { freqHz: 250, q: 1.0, thresholdDb: -22, maxCutDb: 5, attackMs: 9, releaseMs: 220 },
          { freqHz: 1600, q: 1.1, thresholdDb: -22, maxCutDb: 4, attackMs: 7, releaseMs: 190 },
          { freqHz: 5000, q: 1.2, thresholdDb: -19, maxCutDb: 6, attackMs: 5, releaseMs: 150 },
          { freqHz: 10000, q: 1.1, thresholdDb: -22, maxCutDb: 7, attackMs: 4, releaseMs: 130 },
        ],
      },
      multiband: mb6(
        { thresholdDb: -15, ratio: 4, attackMs: 10, releaseMs: 220, makeupDb: 3 },
        { thresholdDb: -17, ratio: 4.5, attackMs: 7, releaseMs: 190, makeupDb: 3 },
        { thresholdDb: -19, ratio: 4.5, attackMs: 3, releaseMs: 150, makeupDb: 2.5 },
        [150, 500, 1900, 4800, 9800],
      ),
      agc: {
        on: true,
        thresholdDb: -22,
        ratio: 4.5,
        kneeDb: 3.5,
        attackMs: 6,
        releaseMs: 200,
        makeupDb: 7,
      },
      rider: { on: true, targetLufs: -18, maxRideDb: 8, gateDb: -52, speed: "fast" },
      exciter: { on: true, mix: 3, freqHz: 6500 },
      stereo: { width: 1.08 },
      limiter: { on: true, ceilingDb: -0.7, attackMs: 0.7, releaseMs: 95 },
    }),
  },
  {
    id: "orban-edge",
    name: "Orban · Edge",
    description:
      "Optimod EDGE factory preset: aggressive contemporary bite — deep density, a bright open top and a hot ceiling for competitive formats that live on impact. Orban's EDGE MX variant trades some of this heat for smoothness.",
    tags: ["Music", "Orban", "Loud"],
    family: "Orban",
    params: merge({
      hpf: { on: true, freqHz: 70 },
      eq: {
        on: true,
        bands: [
          { freq: 60, gainDb: 3, q: 0.7, type: "lowshelf" },
          { freq: 200, gainDb: -1.5, q: 1.1, type: "peaking" },
          { freq: 700, gainDb: 0.5, q: 1.0, type: "peaking" },
          { freq: 2500, gainDb: 3, q: 1.1, type: "peaking" },
          { freq: 6000, gainDb: 1.5, q: 1.4, type: "peaking" },
          { freq: 12000, gainDb: 3.5, q: 0.7, type: "highshelf" },
        ],
      },
      deq: {
        on: true,
        bands: [
          { freqHz: 80, q: 0.9, thresholdDb: -19, maxCutDb: 7, attackMs: 7, releaseMs: 200 },
          { freqHz: 250, q: 1.0, thresholdDb: -18, maxCutDb: 8, attackMs: 7, releaseMs: 190 },
          { freqHz: 1600, q: 1.1, thresholdDb: -20, maxCutDb: 6, attackMs: 6, releaseMs: 170 },
          { freqHz: 5000, q: 1.2, thresholdDb: -19, maxCutDb: 7, attackMs: 5, releaseMs: 150 },
          { freqHz: 10000, q: 1.1, thresholdDb: -20, maxCutDb: 10, attackMs: 4, releaseMs: 120 },
        ],
      },
      multiband: mb6(
        { thresholdDb: -18, ratio: 5, attackMs: 4.5, releaseMs: 150, makeupDb: 4 },
        { thresholdDb: -20, ratio: 5, attackMs: 3, releaseMs: 130, makeupDb: 4 },
        { thresholdDb: -21, ratio: 4.5, attackMs: 1.5, releaseMs: 110, makeupDb: 3 },
        [130, 470, 1900, 4800, 9500],
      ),
      agc: {
        on: true,
        thresholdDb: -25,
        ratio: 6,
        kneeDb: 2.5,
        attackMs: 4,
        releaseMs: 175,
        makeupDb: 8,
      },
      rider: { on: true, targetLufs: -17, maxRideDb: 8, gateDb: -50, speed: "fast" },
      exciter: { on: true, mix: 4.5, freqHz: 6000 },
      stereo: { width: 1.15 },
      limiter: { on: true, ceilingDb: -0.6, attackMs: 0.5, releaseMs: 72 },
    }),
  },
  {
    id: "orban-dance-energy",
    name: "Orban · Dance Energy",
    description:
      "Optimod DANCE ENERGY factory preset — the 8700i describes it as preserving dance percussion punch and 'slam': loud and bright, tuned to keep kick and snare impact alive under heavy limiting.",
    tags: ["Music", "Orban", "Club"],
    family: "Orban",
    params: merge({
      hpf: { on: true, freqHz: 42 },
      eq: {
        on: true,
        bands: [
          { freq: 60, gainDb: 4, q: 0.7, type: "lowshelf" },
          { freq: 200, gainDb: -1, q: 1.0, type: "peaking" },
          { freq: 700, gainDb: 0, q: 1.0, type: "peaking" },
          { freq: 2500, gainDb: 1.5, q: 1.1, type: "peaking" },
          { freq: 6000, gainDb: 1.5, q: 1.4, type: "peaking" },
          { freq: 12000, gainDb: 2.5, q: 0.7, type: "highshelf" },
        ],
      },
      deq: {
        on: true,
        bands: [
          { freqHz: 80, q: 0.9, thresholdDb: -17, maxCutDb: 9, attackMs: 6, releaseMs: 190 },
          { freqHz: 250, q: 1.0, thresholdDb: -19, maxCutDb: 6, attackMs: 7, releaseMs: 200 },
          { freqHz: 1600, q: 1.1, thresholdDb: -21, maxCutDb: 5, attackMs: 6, releaseMs: 180 },
          { freqHz: 5000, q: 1.2, thresholdDb: -21, maxCutDb: 5, attackMs: 5, releaseMs: 160 },
          { freqHz: 10000, q: 1.1, thresholdDb: -22, maxCutDb: 8, attackMs: 4, releaseMs: 130 },
        ],
      },
      multiband: mb6(
        { thresholdDb: -17, ratio: 5.5, attackMs: 5, releaseMs: 175, makeupDb: 4 },
        { thresholdDb: -19, ratio: 4.5, attackMs: 4, releaseMs: 150, makeupDb: 3.5 },
        { thresholdDb: -20, ratio: 4, attackMs: 2, releaseMs: 125, makeupDb: 3 },
        [130, 470, 1800, 4700, 9500],
      ),
      agc: {
        on: true,
        thresholdDb: -24,
        ratio: 5,
        kneeDb: 3,
        attackMs: 5,
        releaseMs: 200,
        makeupDb: 7,
      },
      rider: { on: true, targetLufs: -18, maxRideDb: 8, gateDb: -52, speed: "fast" },
      stereo: { width: 1.16 },
      limiter: { on: true, ceilingDb: -0.8, attackMs: 0.5, releaseMs: 75 },
    }),
  },
  {
    id: "omnia-hot-ac",
    name: "Omnia · Hot AC",
    description:
      "Hot-AC format character: the bridge between AC and CHR — warmer than CHR, brighter and denser than AC, forward vocals and a competitive −19 LUFS ride for request-driven mainstream formats.",
    tags: ["Music", "Omnia", "Mainstream"],
    family: "Omnia",
    params: merge({
      hpf: { on: true, freqHz: 60 },
      eq: {
        on: true,
        bands: [
          { freq: 60, gainDb: 2, q: 0.7, type: "lowshelf" },
          { freq: 200, gainDb: -1, q: 1.0, type: "peaking" },
          { freq: 700, gainDb: 0.5, q: 1.0, type: "peaking" },
          { freq: 2500, gainDb: 2.5, q: 1.1, type: "peaking" },
          { freq: 6000, gainDb: 0.5, q: 1.4, type: "peaking" },
          { freq: 12000, gainDb: 2.5, q: 0.7, type: "highshelf" },
        ],
      },
      deq: {
        on: true,
        bands: [
          { freqHz: 80, q: 0.9, thresholdDb: -21, maxCutDb: 6, attackMs: 10, releaseMs: 260 },
          { freqHz: 250, q: 1.0, thresholdDb: -20, maxCutDb: 6, attackMs: 9, releaseMs: 240 },
          { freqHz: 1600, q: 1.1, thresholdDb: -22, maxCutDb: 5, attackMs: 7, releaseMs: 200 },
          { freqHz: 5000, q: 1.2, thresholdDb: -20, maxCutDb: 5, attackMs: 6, releaseMs: 180 },
          { freqHz: 10000, q: 1.1, thresholdDb: -21, maxCutDb: 8, attackMs: 4, releaseMs: 140 },
        ],
      },
      multiband: mb6(
        { thresholdDb: -15, ratio: 4, attackMs: 9, releaseMs: 240, makeupDb: 3 },
        { thresholdDb: -17, ratio: 4, attackMs: 6, releaseMs: 210, makeupDb: 3 },
        { thresholdDb: -19, ratio: 4, attackMs: 4, releaseMs: 170, makeupDb: 2.5 },
        [...OMNIA_SPLITS] as MultibandSplits,
      ),
      agc: {
        on: true,
        thresholdDb: -20,
        ratio: 4,
        kneeDb: 5,
        attackMs: 9,
        releaseMs: 280,
        makeupDb: 6,
      },
      rider: { on: true, targetLufs: -19, maxRideDb: 7, gateDb: -54, speed: "fast" },
      stereo: { width: 1.1 },
      limiter: { on: true, ceilingDb: -0.9, attackMs: 0.9, releaseMs: 115 },
    }),
  },
  {
    id: "omnia-80s",
    name: "Omnia · 80s",
    description:
      "1980s retro format character: bright synth sheen, wide gated-drum-friendly imaging, fast bass control that keeps toms tight under plate reverb, and a harmonic lift that flatters digital-era masters.",
    tags: ["Music", "Omnia", "Retro"],
    family: "Omnia",
    params: merge({
      hpf: { on: true, freqHz: 55 },
      eq: {
        on: true,
        bands: [
          { freq: 60, gainDb: 2.5, q: 0.7, type: "lowshelf" },
          { freq: 200, gainDb: -1, q: 1.1, type: "peaking" },
          { freq: 700, gainDb: 0.5, q: 1.0, type: "peaking" },
          { freq: 2500, gainDb: 2, q: 1.1, type: "peaking" },
          { freq: 6000, gainDb: 1.5, q: 1.4, type: "peaking" },
          { freq: 12000, gainDb: 3, q: 0.7, type: "highshelf" },
        ],
      },
      deq: {
        on: true,
        bands: [
          { freqHz: 80, q: 0.9, thresholdDb: -19, maxCutDb: 7, attackMs: 8, releaseMs: 220 },
          { freqHz: 250, q: 1.0, thresholdDb: -19, maxCutDb: 6, attackMs: 8, releaseMs: 210 },
          { freqHz: 1600, q: 1.1, thresholdDb: -21, maxCutDb: 5, attackMs: 6, releaseMs: 180 },
          { freqHz: 5000, q: 1.2, thresholdDb: -20, maxCutDb: 5, attackMs: 5, releaseMs: 160 },
          { freqHz: 10000, q: 1.1, thresholdDb: -21, maxCutDb: 8, attackMs: 4, releaseMs: 130 },
        ],
      },
      multiband: mb6(
        { thresholdDb: -16, ratio: 5, attackMs: 6, releaseMs: 200, makeupDb: 3.5 },
        { thresholdDb: -18, ratio: 4, attackMs: 4, releaseMs: 180, makeupDb: 3 },
        { thresholdDb: -19, ratio: 4, attackMs: 2.5, releaseMs: 140, makeupDb: 2.5 },
        [...OMNIA_SPLITS] as MultibandSplits,
      ),
      agc: {
        on: true,
        thresholdDb: -21,
        ratio: 4.5,
        kneeDb: 4,
        attackMs: 7,
        releaseMs: 240,
        makeupDb: 6,
      },
      exciter: { on: true, mix: 4, freqHz: 7000 },
      stereo: { width: 1.2 },
      limiter: { on: true, ceilingDb: -0.8, attackMs: 0.6, releaseMs: 92 },
    }),
  },
  {
    id: "omnia-90s",
    name: "Omnia · 90s",
    description:
      "1990s format character: alternative-era balance — midrange-forward guitars and vocals, leaner bass than modern CHR, an honest less-airy top and medium density that keeps the strumming intact.",
    tags: ["Music", "Omnia", "Retro"],
    family: "Omnia",
    params: merge({
      hpf: { on: true, freqHz: 60 },
      eq: {
        on: true,
        bands: [
          { freq: 60, gainDb: 1.5, q: 0.7, type: "lowshelf" },
          { freq: 200, gainDb: 0, q: 1.0, type: "peaking" },
          { freq: 700, gainDb: 1.5, q: 1.0, type: "peaking" },
          { freq: 2500, gainDb: 2.5, q: 1.1, type: "peaking" },
          { freq: 6000, gainDb: 0.5, q: 1.4, type: "peaking" },
          { freq: 12000, gainDb: 1, q: 0.7, type: "highshelf" },
        ],
      },
      deq: {
        on: true,
        bands: [
          { freqHz: 80, q: 0.9, thresholdDb: -21, maxCutDb: 6, attackMs: 9, releaseMs: 240 },
          { freqHz: 250, q: 1.0, thresholdDb: -20, maxCutDb: 7, attackMs: 8, releaseMs: 230 },
          { freqHz: 1600, q: 1.1, thresholdDb: -21, maxCutDb: 5, attackMs: 7, releaseMs: 200 },
          { freqHz: 5000, q: 1.2, thresholdDb: -21, maxCutDb: 5, attackMs: 6, releaseMs: 170 },
          { freqHz: 10000, q: 1.1, thresholdDb: -23, maxCutDb: 6, attackMs: 5, releaseMs: 140 },
        ],
      },
      multiband: mb6(
        { thresholdDb: -15, ratio: 4, attackMs: 7, releaseMs: 240, makeupDb: 3 },
        { thresholdDb: -17, ratio: 4.5, attackMs: 5, releaseMs: 200, makeupDb: 3 },
        { thresholdDb: -18, ratio: 3.5, attackMs: 3, releaseMs: 170, makeupDb: 2.5 },
        [...OMNIA_SPLITS] as MultibandSplits,
      ),
      agc: {
        on: true,
        thresholdDb: -21,
        ratio: 4.5,
        kneeDb: 4,
        attackMs: 7,
        releaseMs: 230,
        makeupDb: 6,
      },
      stereo: { width: 1.08 },
      limiter: { on: true, ceilingDb: -0.9, attackMs: 0.8, releaseMs: 105 },
    }),
  },
  {
    id: "omnia-classic-hits",
    name: "Omnia · Classic Hits",
    description:
      "Classic-hits (70s–80s) format character: warm weight with a modern bright top — controlled vintage bass, tamed reissue sizzle and enough density to sit beside current hits in rotation.",
    tags: ["Music", "Omnia", "Retro"],
    family: "Omnia",
    params: merge({
      hpf: { on: true, freqHz: 55 },
      eq: {
        on: true,
        bands: [
          { freq: 60, gainDb: 2.5, q: 0.7, type: "lowshelf" },
          { freq: 200, gainDb: -0.5, q: 1.0, type: "peaking" },
          { freq: 700, gainDb: 1, q: 1.0, type: "peaking" },
          { freq: 2500, gainDb: 1.5, q: 1.1, type: "peaking" },
          { freq: 6000, gainDb: -0.5, q: 1.5, type: "peaking" },
          { freq: 12000, gainDb: 1.5, q: 0.7, type: "highshelf" },
        ],
      },
      deq: {
        on: true,
        bands: [
          { freqHz: 80, q: 0.9, thresholdDb: -21, maxCutDb: 6, attackMs: 12, releaseMs: 300 },
          { freqHz: 250, q: 1.0, thresholdDb: -21, maxCutDb: 5, attackMs: 11, releaseMs: 280 },
          { freqHz: 1600, q: 1.1, thresholdDb: -23, maxCutDb: 4, attackMs: 9, releaseMs: 240 },
          { freqHz: 5000, q: 1.2, thresholdDb: -22, maxCutDb: 4, attackMs: 7, releaseMs: 210 },
          { freqHz: 10000, q: 1.1, thresholdDb: -24, maxCutDb: 5, attackMs: 6, releaseMs: 180 },
        ],
      },
      multiband: mb6(
        { thresholdDb: -15, ratio: 3.5, attackMs: 12, releaseMs: 280, makeupDb: 3 },
        { thresholdDb: -17, ratio: 3.5, attackMs: 8, releaseMs: 250, makeupDb: 2.5 },
        { thresholdDb: -19, ratio: 3.5, attackMs: 5, releaseMs: 200, makeupDb: 2 },
        [...OMNIA_SPLITS] as MultibandSplits,
      ),
      agc: {
        on: true,
        thresholdDb: -20,
        ratio: 3.5,
        kneeDb: 6,
        attackMs: 11,
        releaseMs: 320,
        makeupDb: 5,
      },
      rider: { on: true, targetLufs: -21, maxRideDb: 6, gateDb: -56, speed: "slow" },
      stereo: { width: 1.08 },
      limiter: { on: true, ceilingDb: -1, attackMs: 1.3, releaseMs: 145 },
    }),
  },
  {
    id: "omnia-oldies",
    name: "Omnia · Oldies",
    description:
      "Oldies (60s–70s) format character: mono-era-safe imaging, warm midrange balance and the gentlest top-end handling in the library so tape-era masters survive processing.",
    tags: ["Music", "Omnia", "Nostalgia"],
    family: "Omnia",
    params: merge({
      hpf: { on: true, freqHz: 50 },
      eq: {
        on: true,
        bands: [
          { freq: 60, gainDb: 1.5, q: 0.7, type: "lowshelf" },
          { freq: 200, gainDb: 0.5, q: 1.0, type: "peaking" },
          { freq: 700, gainDb: 1.5, q: 1.0, type: "peaking" },
          { freq: 2500, gainDb: 0.5, q: 1.2, type: "peaking" },
          { freq: 6000, gainDb: -1, q: 1.5, type: "peaking" },
          { freq: 12000, gainDb: -0.5, q: 0.7, type: "highshelf" },
        ],
      },
      deq: {
        on: true,
        bands: [
          { freqHz: 80, q: 0.9, thresholdDb: -24, maxCutDb: 4, attackMs: 18, releaseMs: 400 },
          { freqHz: 250, q: 1.0, thresholdDb: -23, maxCutDb: 5, attackMs: 16, releaseMs: 380 },
          { freqHz: 1600, q: 1.1, thresholdDb: -25, maxCutDb: 3, attackMs: 14, releaseMs: 340 },
          { freqHz: 5000, q: 1.2, thresholdDb: -24, maxCutDb: 4, attackMs: 12, releaseMs: 300 },
          { freqHz: 10000, q: 1.1, thresholdDb: -26, maxCutDb: 4, attackMs: 10, releaseMs: 280 },
        ],
      },
      multiband: mb6(
        { thresholdDb: -13, ratio: 2.5, attackMs: 18, releaseMs: 460, makeupDb: 2 },
        { thresholdDb: -15, ratio: 2.5, attackMs: 13, releaseMs: 420, makeupDb: 1.5 },
        { thresholdDb: -17, ratio: 2.5, attackMs: 9, releaseMs: 380, makeupDb: 1 },
        [...OMNIA_SPLITS] as MultibandSplits,
      ),
      agc: {
        on: true,
        thresholdDb: -17,
        ratio: 2.5,
        kneeDb: 9,
        attackMs: 22,
        releaseMs: 550,
        makeupDb: 4,
      },
      rider: { on: true, targetLufs: -23, maxRideDb: 5, gateDb: -58, speed: "slow" },
      stereo: { width: 1.02 },
      limiter: { on: true, ceilingDb: -1.3, attackMs: 2.2, releaseMs: 225 },
    }),
  },
  {
    id: "omnia-christian",
    name: "Omnia · Christian",
    description:
      "Christian-format character (soft-AC core): vocal-forward warmth for worship and message-driven music, gentle density and wide-but-safe imaging that stays comfortable through choir and acoustic sets.",
    tags: ["Music", "Omnia", "Warm"],
    family: "Omnia",
    params: merge({
      hpf: { on: true, freqHz: 55 },
      eq: {
        on: true,
        bands: [
          { freq: 60, gainDb: 1.5, q: 0.7, type: "lowshelf" },
          { freq: 200, gainDb: -0.5, q: 1.0, type: "peaking" },
          { freq: 700, gainDb: 1, q: 1.0, type: "peaking" },
          { freq: 2500, gainDb: 2, q: 1.1, type: "peaking" },
          { freq: 6000, gainDb: -0.5, q: 1.6, type: "peaking" },
          { freq: 12000, gainDb: 1.5, q: 0.7, type: "highshelf" },
        ],
      },
      deq: {
        on: true,
        bands: [
          { freqHz: 80, q: 0.9, thresholdDb: -23, maxCutDb: 5, attackMs: 14, releaseMs: 340 },
          { freqHz: 250, q: 1.0, thresholdDb: -22, maxCutDb: 5, attackMs: 12, releaseMs: 320 },
          { freqHz: 1600, q: 1.1, thresholdDb: -24, maxCutDb: 4, attackMs: 10, releaseMs: 270 },
          { freqHz: 5000, q: 1.2, thresholdDb: -22, maxCutDb: 4, attackMs: 8, releaseMs: 230 },
          { freqHz: 10000, q: 1.1, thresholdDb: -24, maxCutDb: 6, attackMs: 6, releaseMs: 190 },
        ],
      },
      multiband: mb6(
        { thresholdDb: -14, ratio: 3.5, attackMs: 14, releaseMs: 280, makeupDb: 2.5 },
        { thresholdDb: -16, ratio: 3.5, attackMs: 10, releaseMs: 250, makeupDb: 2.5 },
        { thresholdDb: -18, ratio: 3.5, attackMs: 6, releaseMs: 210, makeupDb: 2 },
        [...OMNIA_SPLITS] as MultibandSplits,
      ),
      agc: {
        on: true,
        thresholdDb: -19,
        ratio: 3,
        kneeDb: 7,
        attackMs: 12,
        releaseMs: 340,
        makeupDb: 5,
      },
      rider: { on: true, targetLufs: -22, maxRideDb: 6, gateDb: -56, speed: "slow" },
      stereo: { width: 1.06 },
      limiter: { on: true, ceilingDb: -1, attackMs: 1.5, releaseMs: 158 },
    }),
  },
  {
    id: "omnia-rhythmic",
    name: "Omnia · Rhythmic",
    description:
      "Rhythmic-CHR format character: the urban-crossover workhorse — deep 18 dB/oct-style bass weight, fast dense multiband, assertive de-essing and a hot −17 LUFS ride with wide imaging.",
    tags: ["Music", "Omnia", "Loud"],
    family: "Omnia",
    params: merge({
      hpf: { on: true, freqHz: 45 },
      eq: {
        on: true,
        bands: [
          { freq: 60, gainDb: 3.5, q: 0.7, type: "lowshelf" },
          { freq: 200, gainDb: -1, q: 1.1, type: "peaking" },
          { freq: 700, gainDb: 0, q: 1.0, type: "peaking" },
          { freq: 2500, gainDb: 2, q: 1.1, type: "peaking" },
          { freq: 6000, gainDb: 1, q: 1.4, type: "peaking" },
          { freq: 12000, gainDb: 2.5, q: 0.7, type: "highshelf" },
        ],
      },
      deq: {
        on: true,
        bands: [
          { freqHz: 80, q: 0.9, thresholdDb: -18, maxCutDb: 8, attackMs: 7, releaseMs: 200 },
          { freqHz: 250, q: 1.0, thresholdDb: -18, maxCutDb: 7, attackMs: 7, releaseMs: 200 },
          { freqHz: 1600, q: 1.1, thresholdDb: -20, maxCutDb: 6, attackMs: 6, releaseMs: 180 },
          { freqHz: 5000, q: 1.2, thresholdDb: -19, maxCutDb: 7, attackMs: 5, releaseMs: 160 },
          { freqHz: 10000, q: 1.1, thresholdDb: -20, maxCutDb: 10, attackMs: 4, releaseMs: 120 },
        ],
      },
      multiband: mb6(
        { thresholdDb: -19, ratio: 6, attackMs: 5, releaseMs: 150, makeupDb: 4.5 },
        { thresholdDb: -21, ratio: 5, attackMs: 3, releaseMs: 130, makeupDb: 4 },
        { thresholdDb: -21, ratio: 4.5, attackMs: 1.5, releaseMs: 105, makeupDb: 3.5 },
        [...OMNIA_SPLITS] as MultibandSplits,
      ),
      agc: {
        on: true,
        thresholdDb: -25,
        ratio: 6,
        kneeDb: 2.5,
        attackMs: 4,
        releaseMs: 170,
        makeupDb: 9,
      },
      rider: { on: true, targetLufs: -17, maxRideDb: 8, gateDb: -50, speed: "fast" },
      exciter: { on: true, mix: 4, freqHz: 5500 },
      stereo: { width: 1.15 },
      limiter: { on: true, ceilingDb: -0.7, attackMs: 0.45, releaseMs: 78 },
    }),
  },
  {
    id: "omnia-metal",
    name: "Omnia · Metal",
    description:
      "Heavy-rock/metal format character: tight punchy low end under down-tuned guitars, a presence lift that keeps riffs articulate through the wall of sound, fast density and a hot but legal ceiling.",
    tags: ["Music", "Omnia", "Heavy"],
    family: "Omnia",
    params: merge({
      hpf: { on: true, freqHz: 65 },
      eq: {
        on: true,
        bands: [
          { freq: 60, gainDb: 3, q: 0.7, type: "lowshelf" },
          { freq: 200, gainDb: -1.5, q: 1.1, type: "peaking" },
          { freq: 700, gainDb: 0.5, q: 1.0, type: "peaking" },
          { freq: 2500, gainDb: 3, q: 1.1, type: "peaking" },
          { freq: 6000, gainDb: 0.5, q: 1.4, type: "peaking" },
          { freq: 12000, gainDb: 2, q: 0.7, type: "highshelf" },
        ],
      },
      deq: {
        on: true,
        bands: [
          { freqHz: 80, q: 0.9, thresholdDb: -18, maxCutDb: 8, attackMs: 7, releaseMs: 210 },
          { freqHz: 250, q: 1.0, thresholdDb: -17, maxCutDb: 8, attackMs: 7, releaseMs: 200 },
          { freqHz: 1600, q: 1.1, thresholdDb: -20, maxCutDb: 6, attackMs: 6, releaseMs: 180 },
          { freqHz: 5000, q: 1.2, thresholdDb: -19, maxCutDb: 6, attackMs: 5, releaseMs: 160 },
          { freqHz: 10000, q: 1.1, thresholdDb: -21, maxCutDb: 8, attackMs: 4, releaseMs: 130 },
        ],
      },
      multiband: mb6(
        { thresholdDb: -18, ratio: 6, attackMs: 5, releaseMs: 150, makeupDb: 4 },
        { thresholdDb: -20, ratio: 5, attackMs: 3, releaseMs: 130, makeupDb: 4 },
        { thresholdDb: -20, ratio: 4.5, attackMs: 1.5, releaseMs: 110, makeupDb: 3 },
        [...OMNIA_SPLITS] as MultibandSplits,
      ),
      agc: {
        on: true,
        thresholdDb: -24,
        ratio: 6,
        kneeDb: 3,
        attackMs: 4,
        releaseMs: 180,
        makeupDb: 8,
      },
      stereo: { width: 1.12 },
      limiter: { on: true, ceilingDb: -0.7, attackMs: 0.55, releaseMs: 76 },
    }),
  },
  {
    id: "omnia-new-york",
    name: "Omnia · New York",
    description:
      "Omnia.9 'New York' — one of the named factory presets in the Omnia.9 manual and one of its hottest metro-market tunings: low multiband thresholds, fast release and heavy limiting for maximum big-city density.",
    tags: ["Music", "Omnia", "Dense"],
    family: "Omnia",
    params: merge({
      hpf: { on: true, freqHz: 70 },
      eq: {
        on: true,
        bands: [
          { freq: 60, gainDb: 3, q: 0.7, type: "lowshelf" },
          { freq: 200, gainDb: -2, q: 1.1, type: "peaking" },
          { freq: 700, gainDb: 0.5, q: 1.0, type: "peaking" },
          { freq: 2500, gainDb: 3, q: 1.1, type: "peaking" },
          { freq: 6000, gainDb: 1, q: 1.4, type: "peaking" },
          { freq: 12000, gainDb: 3, q: 0.7, type: "highshelf" },
        ],
      },
      deq: {
        on: true,
        bands: [
          { freqHz: 80, q: 0.9, thresholdDb: -18, maxCutDb: 8, attackMs: 6, releaseMs: 190 },
          { freqHz: 250, q: 1.0, thresholdDb: -17, maxCutDb: 8, attackMs: 6, releaseMs: 190 },
          { freqHz: 1600, q: 1.1, thresholdDb: -19, maxCutDb: 7, attackMs: 5, releaseMs: 170 },
          { freqHz: 5000, q: 1.2, thresholdDb: -18, maxCutDb: 8, attackMs: 4, releaseMs: 150 },
          { freqHz: 10000, q: 1.1, thresholdDb: -19, maxCutDb: 11, attackMs: 3, releaseMs: 120 },
        ],
      },
      multiband: mb6(
        { thresholdDb: -21, ratio: 6, attackMs: 4, releaseMs: 120, makeupDb: 5 },
        { thresholdDb: -23, ratio: 5.5, attackMs: 2.5, releaseMs: 110, makeupDb: 5 },
        { thresholdDb: -23, ratio: 5, attackMs: 1.5, releaseMs: 95, makeupDb: 4 },
        [...OMNIA_SPLITS] as MultibandSplits,
      ),
      agc: {
        on: true,
        thresholdDb: -27,
        ratio: 7,
        kneeDb: 2,
        attackMs: 3,
        releaseMs: 140,
        makeupDb: 10,
      },
      rider: { on: true, targetLufs: -16, maxRideDb: 9, gateDb: -50, speed: "fast" },
      exciter: { on: true, mix: 5, freqHz: 6000 },
      stereo: { width: 1.18 },
      limiter: { on: true, ceilingDb: -0.5, attackMs: 0.35, releaseMs: 65 },
    }),
  },
  {
    id: "omnia-natural",
    name: "Omnia · Natural",
    description:
      "The open Omnia starting point: transparent levelling that preserves transients and dynamic range, with a neutral frequency balance that lifts no part of the spectrum — the right base for building your own chain.",
    tags: ["General", "Omnia", "Open"],
    family: "Omnia",
    params: merge({
      hpf: { on: true, freqHz: 50 },
      eq: {
        on: true,
        bands: [
          { freq: 60, gainDb: 0, q: 0.7, type: "lowshelf" },
          { freq: 200, gainDb: 0, q: 1.0, type: "peaking" },
          { freq: 700, gainDb: 0, q: 1.0, type: "peaking" },
          { freq: 2500, gainDb: 0, q: 1.2, type: "peaking" },
          { freq: 6000, gainDb: 0, q: 1.4, type: "peaking" },
          { freq: 12000, gainDb: 0, q: 0.7, type: "highshelf" },
        ],
      },
      deq: {
        on: false,
        bands: [
          { freqHz: 80, q: 0.9, thresholdDb: -26, maxCutDb: 3, attackMs: 20, releaseMs: 450 },
          { freqHz: 250, q: 1.0, thresholdDb: -26, maxCutDb: 3, attackMs: 18, releaseMs: 420 },
          { freqHz: 1600, q: 1.1, thresholdDb: -26, maxCutDb: 2, attackMs: 15, releaseMs: 380 },
          { freqHz: 5000, q: 1.2, thresholdDb: -26, maxCutDb: 2, attackMs: 14, releaseMs: 350 },
          { freqHz: 10000, q: 1.1, thresholdDb: -28, maxCutDb: 3, attackMs: 12, releaseMs: 320 },
        ],
      },
      multiband: mb6(
        { thresholdDb: -12, ratio: 2, attackMs: 20, releaseMs: 550, makeupDb: 1 },
        { thresholdDb: -14, ratio: 2, attackMs: 15, releaseMs: 500, makeupDb: 1 },
        { thresholdDb: -16, ratio: 2, attackMs: 10, releaseMs: 450, makeupDb: 1 },
        [...OMNIA_SPLITS] as MultibandSplits,
      ),
      agc: {
        on: true,
        thresholdDb: -16,
        ratio: 1.8,
        kneeDb: 10,
        attackMs: 25,
        releaseMs: 650,
        makeupDb: 2,
      },
      rider: { on: true, targetLufs: LUFS_TARGET, maxRideDb: 5, gateDb: -58, speed: "slow" },
      stereo: { width: 1.03 },
      limiter: { on: true, ceilingDb: -1, attackMs: 2, releaseMs: 200 },
    }),
  },
  {
    id: "omnia-bright",
    name: "Omnia · Bright",
    description:
      "Natural's texture with more clarity in the presence region — the same open, transient-friendly dynamics under a lifted 2.5 kHz window so voices and lead instruments step forward without hardening.",
    tags: ["General", "Omnia", "Clear"],
    family: "Omnia",
    params: merge({
      hpf: { on: true, freqHz: 50 },
      eq: {
        on: true,
        bands: [
          { freq: 60, gainDb: 0, q: 0.7, type: "lowshelf" },
          { freq: 200, gainDb: -0.5, q: 1.0, type: "peaking" },
          { freq: 700, gainDb: 0, q: 1.0, type: "peaking" },
          { freq: 2500, gainDb: 2.5, q: 1.2, type: "peaking" },
          { freq: 6000, gainDb: 1, q: 1.4, type: "peaking" },
          { freq: 12000, gainDb: 0.5, q: 0.7, type: "highshelf" },
        ],
      },
      deq: {
        on: false,
        bands: [
          { freqHz: 80, q: 0.9, thresholdDb: -26, maxCutDb: 3, attackMs: 20, releaseMs: 450 },
          { freqHz: 250, q: 1.0, thresholdDb: -26, maxCutDb: 3, attackMs: 18, releaseMs: 420 },
          { freqHz: 1600, q: 1.1, thresholdDb: -25, maxCutDb: 3, attackMs: 15, releaseMs: 380 },
          { freqHz: 5000, q: 1.2, thresholdDb: -25, maxCutDb: 3, attackMs: 14, releaseMs: 340 },
          { freqHz: 10000, q: 1.1, thresholdDb: -27, maxCutDb: 3, attackMs: 12, releaseMs: 320 },
        ],
      },
      multiband: mb6(
        { thresholdDb: -12, ratio: 2, attackMs: 20, releaseMs: 550, makeupDb: 1 },
        { thresholdDb: -14, ratio: 2, attackMs: 15, releaseMs: 500, makeupDb: 1 },
        { thresholdDb: -16, ratio: 2.2, attackMs: 10, releaseMs: 440, makeupDb: 1 },
        [...OMNIA_SPLITS] as MultibandSplits,
      ),
      agc: {
        on: true,
        thresholdDb: -16,
        ratio: 1.8,
        kneeDb: 10,
        attackMs: 25,
        releaseMs: 650,
        makeupDb: 2,
      },
      rider: { on: true, targetLufs: LUFS_TARGET, maxRideDb: 5, gateDb: -58, speed: "slow" },
      stereo: { width: 1.04 },
      limiter: { on: true, ceilingDb: -1, attackMs: 1.8, releaseMs: 180 },
    }),
  },
  {
    id: "omnia-clear",
    name: "Omnia · Clear",
    description:
      "Bright with more prominent highs for extra sparkle and brilliance, plus a touch of low shelf for balance — airy top end that never leaves the bottom behind.",
    tags: ["General", "Omnia", "Airy"],
    family: "Omnia",
    params: merge({
      hpf: { on: true, freqHz: 50 },
      eq: {
        on: true,
        bands: [
          { freq: 60, gainDb: 1.5, q: 0.7, type: "lowshelf" },
          { freq: 200, gainDb: -0.5, q: 1.0, type: "peaking" },
          { freq: 700, gainDb: 0, q: 1.0, type: "peaking" },
          { freq: 2500, gainDb: 2, q: 1.2, type: "peaking" },
          { freq: 6000, gainDb: 1.5, q: 1.4, type: "peaking" },
          { freq: 12000, gainDb: 3, q: 0.7, type: "highshelf" },
        ],
      },
      deq: {
        on: false,
        bands: [
          { freqHz: 80, q: 0.9, thresholdDb: -26, maxCutDb: 3, attackMs: 20, releaseMs: 450 },
          { freqHz: 250, q: 1.0, thresholdDb: -26, maxCutDb: 3, attackMs: 18, releaseMs: 420 },
          { freqHz: 1600, q: 1.1, thresholdDb: -25, maxCutDb: 3, attackMs: 15, releaseMs: 380 },
          { freqHz: 5000, q: 1.2, thresholdDb: -24, maxCutDb: 3, attackMs: 12, releaseMs: 320 },
          { freqHz: 10000, q: 1.1, thresholdDb: -24, maxCutDb: 4, attackMs: 8, releaseMs: 260 },
        ],
      },
      multiband: mb6(
        { thresholdDb: -12, ratio: 2.2, attackMs: 18, releaseMs: 520, makeupDb: 1 },
        { thresholdDb: -14, ratio: 2.2, attackMs: 14, releaseMs: 480, makeupDb: 1 },
        { thresholdDb: -16, ratio: 2.5, attackMs: 9, releaseMs: 420, makeupDb: 1.5 },
        [...OMNIA_SPLITS] as MultibandSplits,
      ),
      agc: {
        on: true,
        thresholdDb: -17,
        ratio: 2,
        kneeDb: 9,
        attackMs: 22,
        releaseMs: 600,
        makeupDb: 2.5,
      },
      rider: { on: true, targetLufs: LUFS_TARGET, maxRideDb: 5, gateDb: -56, speed: "slow" },
      stereo: { width: 1.05 },
      exciter: { on: true, mix: 2, freqHz: 8000 },
      limiter: { on: true, ceilingDb: -1, attackMs: 1.6, releaseMs: 170 },
    }),
  },
  {
    id: "omnia-smooth",
    name: "Omnia · Smooth",
    description:
      "Compared with Natural, stronger bass and more spectral consistency — deeper multiband thresholds hold every source in the same tonal window while the low shelf adds weight.",
    tags: ["General", "Omnia", "Smooth"],
    family: "Omnia",
    params: merge({
      hpf: { on: true, freqHz: 45 },
      eq: {
        on: true,
        bands: [
          { freq: 60, gainDb: 2.5, q: 0.7, type: "lowshelf" },
          { freq: 200, gainDb: 0, q: 1.0, type: "peaking" },
          { freq: 700, gainDb: 0, q: 1.0, type: "peaking" },
          { freq: 2500, gainDb: 0.5, q: 1.2, type: "peaking" },
          { freq: 6000, gainDb: -0.5, q: 1.4, type: "peaking" },
          { freq: 12000, gainDb: 0, q: 0.7, type: "highshelf" },
        ],
      },
      deq: {
        on: true,
        bands: [
          { freqHz: 80, q: 0.9, thresholdDb: -20, maxCutDb: 5, attackMs: 15, releaseMs: 350 },
          { freqHz: 250, q: 1.0, thresholdDb: -22, maxCutDb: 5, attackMs: 14, releaseMs: 340 },
          { freqHz: 1600, q: 1.1, thresholdDb: -24, maxCutDb: 3, attackMs: 12, releaseMs: 320 },
          { freqHz: 5000, q: 1.2, thresholdDb: -24, maxCutDb: 3, attackMs: 12, releaseMs: 300 },
          { freqHz: 10000, q: 1.1, thresholdDb: -26, maxCutDb: 3, attackMs: 10, releaseMs: 280 },
        ],
      },
      multiband: mb6(
        { thresholdDb: -15, ratio: 2.8, attackMs: 15, releaseMs: 450, makeupDb: 1.5 },
        { thresholdDb: -17, ratio: 2.8, attackMs: 12, releaseMs: 420, makeupDb: 1.5 },
        { thresholdDb: -19, ratio: 3, attackMs: 8, releaseMs: 380, makeupDb: 1.5 },
        [...OMNIA_SPLITS] as MultibandSplits,
      ),
      agc: {
        on: true,
        thresholdDb: -18,
        ratio: 2.2,
        kneeDb: 8,
        attackMs: 20,
        releaseMs: 550,
        makeupDb: 3,
      },
      rider: { on: true, targetLufs: LUFS_TARGET, maxRideDb: 6, gateDb: -55, speed: "slow" },
      stereo: { width: 1.05 },
      limiter: { on: true, ceilingDb: -1, attackMs: 1.5, releaseMs: 160 },
    }),
  },
  {
    id: "omnia-full",
    name: "Omnia · Full",
    description:
      "Compared with Smooth, a bit more density with more prominent bass, smoother highs and a warmer sound overall — rich and settled without sounding compressed.",
    tags: ["General", "Omnia", "Warm"],
    family: "Omnia",
    params: merge({
      hpf: { on: true, freqHz: 45 },
      eq: {
        on: true,
        bands: [
          { freq: 60, gainDb: 4, q: 0.7, type: "lowshelf" },
          { freq: 200, gainDb: -0.5, q: 1.0, type: "peaking" },
          { freq: 700, gainDb: 0.5, q: 1.0, type: "peaking" },
          { freq: 2500, gainDb: 0.5, q: 1.2, type: "peaking" },
          { freq: 6000, gainDb: -1, q: 1.4, type: "peaking" },
          { freq: 12000, gainDb: -0.5, q: 0.7, type: "highshelf" },
        ],
      },
      deq: {
        on: true,
        bands: [
          { freqHz: 80, q: 0.9, thresholdDb: -19, maxCutDb: 6, attackMs: 14, releaseMs: 330 },
          { freqHz: 250, q: 1.0, thresholdDb: -21, maxCutDb: 5, attackMs: 13, releaseMs: 320 },
          { freqHz: 1600, q: 1.1, thresholdDb: -23, maxCutDb: 3, attackMs: 11, releaseMs: 300 },
          { freqHz: 5000, q: 1.2, thresholdDb: -23, maxCutDb: 3, attackMs: 11, releaseMs: 280 },
          { freqHz: 10000, q: 1.1, thresholdDb: -25, maxCutDb: 3, attackMs: 9, releaseMs: 260 },
        ],
      },
      multiband: mb6(
        { thresholdDb: -17, ratio: 3.5, attackMs: 12, releaseMs: 400, makeupDb: 2 },
        { thresholdDb: -18, ratio: 3.5, attackMs: 9, releaseMs: 380, makeupDb: 2 },
        { thresholdDb: -20, ratio: 3.5, attackMs: 6, releaseMs: 330, makeupDb: 2 },
        [...OMNIA_SPLITS] as MultibandSplits,
      ),
      agc: {
        on: true,
        thresholdDb: -19,
        ratio: 2.6,
        kneeDb: 7,
        attackMs: 18,
        releaseMs: 500,
        makeupDb: 4,
      },
      rider: { on: true, targetLufs: LUFS_TARGET, maxRideDb: 7, gateDb: -54, speed: "slow" },
      stereo: { width: 1.06 },
      limiter: { on: true, ceilingDb: -1, attackMs: 1.2, releaseMs: 140 },
    }),
  },
  {
    id: "omnia-forward",
    name: "Omnia · Forward",
    description:
      "Full's texture with more bass, more brightness and less overall warmth — mid-bass restraint plus a presence lift puts vocals and groove right at the front of the dial.",
    tags: ["General", "Omnia", "Forward"],
    family: "Omnia",
    params: merge({
      hpf: { on: true, freqHz: 45 },
      eq: {
        on: true,
        bands: [
          { freq: 60, gainDb: 5, q: 0.7, type: "lowshelf" },
          { freq: 200, gainDb: -1.5, q: 1.0, type: "peaking" },
          { freq: 700, gainDb: -0.5, q: 1.0, type: "peaking" },
          { freq: 2500, gainDb: 2, q: 1.2, type: "peaking" },
          { freq: 6000, gainDb: 1, q: 1.4, type: "peaking" },
          { freq: 12000, gainDb: 1.5, q: 0.7, type: "highshelf" },
        ],
      },
      deq: {
        on: true,
        bands: [
          { freqHz: 80, q: 0.9, thresholdDb: -18, maxCutDb: 7, attackMs: 12, releaseMs: 300 },
          { freqHz: 250, q: 1.0, thresholdDb: -20, maxCutDb: 5, attackMs: 12, releaseMs: 300 },
          { freqHz: 1600, q: 1.1, thresholdDb: -22, maxCutDb: 4, attackMs: 10, releaseMs: 280 },
          { freqHz: 5000, q: 1.2, thresholdDb: -22, maxCutDb: 4, attackMs: 10, releaseMs: 260 },
          { freqHz: 10000, q: 1.1, thresholdDb: -24, maxCutDb: 4, attackMs: 8, releaseMs: 240 },
        ],
      },
      multiband: mb6(
        { thresholdDb: -18, ratio: 4, attackMs: 10, releaseMs: 350, makeupDb: 2.5 },
        { thresholdDb: -19, ratio: 4, attackMs: 7, releaseMs: 330, makeupDb: 2.5 },
        { thresholdDb: -20, ratio: 3.8, attackMs: 5, releaseMs: 300, makeupDb: 2.5 },
        [...OMNIA_SPLITS] as MultibandSplits,
      ),
      agc: {
        on: true,
        thresholdDb: -20,
        ratio: 3,
        kneeDb: 6,
        attackMs: 15,
        releaseMs: 450,
        makeupDb: 5,
      },
      rider: { on: true, targetLufs: LUFS_TARGET, maxRideDb: 8, gateDb: -53, speed: "slow" },
      stereo: { width: 1.08 },
      limiter: { on: true, ceilingDb: -1, attackMs: 1, releaseMs: 120 },
    }),
  },
  {
    id: "omnia-slam",
    name: "Omnia · Slam",
    description:
      "Forward's midrange with a strong, hard-hitting bass texture and a brighter top end — tight fast low-band dynamics for weight that lands instead of lingers.",
    tags: ["General", "Omnia", "Punch"],
    family: "Omnia",
    params: merge({
      hpf: { on: true, freqHz: 40 },
      eq: {
        on: true,
        bands: [
          { freq: 60, gainDb: 6, q: 0.7, type: "lowshelf" },
          { freq: 200, gainDb: -1.5, q: 1.0, type: "peaking" },
          { freq: 700, gainDb: -0.5, q: 1.0, type: "peaking" },
          { freq: 2500, gainDb: 2.5, q: 1.2, type: "peaking" },
          { freq: 6000, gainDb: 1.5, q: 1.4, type: "peaking" },
          { freq: 12000, gainDb: 2.5, q: 0.7, type: "highshelf" },
        ],
      },
      deq: {
        on: true,
        bands: [
          { freqHz: 80, q: 0.9, thresholdDb: -17, maxCutDb: 8, attackMs: 8, releaseMs: 260 },
          { freqHz: 250, q: 1.0, thresholdDb: -19, maxCutDb: 6, attackMs: 9, releaseMs: 270 },
          { freqHz: 1600, q: 1.1, thresholdDb: -21, maxCutDb: 4, attackMs: 8, releaseMs: 250 },
          { freqHz: 5000, q: 1.2, thresholdDb: -21, maxCutDb: 4, attackMs: 8, releaseMs: 230 },
          { freqHz: 10000, q: 1.1, thresholdDb: -22, maxCutDb: 5, attackMs: 6, releaseMs: 210 },
        ],
      },
      multiband: mb6(
        { thresholdDb: -19, ratio: 5, attackMs: 8, releaseMs: 280, makeupDb: 3 },
        { thresholdDb: -19, ratio: 4.5, attackMs: 6, releaseMs: 300, makeupDb: 2.5 },
        { thresholdDb: -21, ratio: 4, attackMs: 4, releaseMs: 260, makeupDb: 3 },
        [...OMNIA_SPLITS] as MultibandSplits,
      ),
      agc: {
        on: true,
        thresholdDb: -21,
        ratio: 3.5,
        kneeDb: 5,
        attackMs: 12,
        releaseMs: 400,
        makeupDb: 6,
      },
      rider: { on: true, targetLufs: LUFS_TARGET, maxRideDb: 8, gateDb: -52, speed: "fast" },
      stereo: { width: 1.12 },
      exciter: { on: true, mix: 4, freqHz: 5500 },
      limiter: { on: true, ceilingDb: -0.8, attackMs: 0.8, releaseMs: 90 },
    }),
  },
  {
    id: "omnia-punchy",
    name: "Omnia · Punchy",
    description:
      "The warmth of Full with crisper highs — a more polished, radio-ready sound that stays musical instead of sounding over-processed.",
    tags: ["General", "Omnia", "Polished"],
    family: "Omnia",
    params: merge({
      hpf: { on: true, freqHz: 45 },
      eq: {
        on: true,
        bands: [
          { freq: 60, gainDb: 3.5, q: 0.7, type: "lowshelf" },
          { freq: 200, gainDb: -0.5, q: 1.0, type: "peaking" },
          { freq: 700, gainDb: 0.5, q: 1.0, type: "peaking" },
          { freq: 2500, gainDb: 1.5, q: 1.2, type: "peaking" },
          { freq: 6000, gainDb: 0.5, q: 1.4, type: "peaking" },
          { freq: 12000, gainDb: 2, q: 0.7, type: "highshelf" },
        ],
      },
      deq: {
        on: true,
        bands: [
          { freqHz: 80, q: 0.9, thresholdDb: -19, maxCutDb: 6, attackMs: 12, releaseMs: 300 },
          { freqHz: 250, q: 1.0, thresholdDb: -21, maxCutDb: 5, attackMs: 11, releaseMs: 300 },
          { freqHz: 1600, q: 1.1, thresholdDb: -23, maxCutDb: 3, attackMs: 10, releaseMs: 280 },
          { freqHz: 5000, q: 1.2, thresholdDb: -22, maxCutDb: 4, attackMs: 9, releaseMs: 250 },
          { freqHz: 10000, q: 1.1, thresholdDb: -23, maxCutDb: 5, attackMs: 7, releaseMs: 220 },
        ],
      },
      multiband: mb6(
        { thresholdDb: -17, ratio: 4, attackMs: 10, releaseMs: 320, makeupDb: 2 },
        { thresholdDb: -18, ratio: 3.5, attackMs: 7, releaseMs: 300, makeupDb: 2 },
        { thresholdDb: -19, ratio: 3.5, attackMs: 5, releaseMs: 280, makeupDb: 2 },
        [...OMNIA_SPLITS] as MultibandSplits,
      ),
      agc: {
        on: true,
        thresholdDb: -19,
        ratio: 2.8,
        kneeDb: 7,
        attackMs: 14,
        releaseMs: 420,
        makeupDb: 4,
      },
      rider: { on: true, targetLufs: LUFS_TARGET, maxRideDb: 7, gateDb: -54, speed: "slow" },
      stereo: { width: 1.1 },
      exciter: { on: true, mix: 2.5, freqHz: 6000 },
      limiter: { on: true, ceilingDb: -0.9, attackMs: 1, releaseMs: 120 },
    }),
  },
  {
    id: "omnia-dense",
    name: "Omnia · Dense",
    description:
      "A brighter, compressed radio-like sound that renders a very consistent spectral output regardless of the source material's own frequency balance — the competitive-daypart workhorse.",
    tags: ["General", "Omnia", "Dense"],
    family: "Omnia",
    params: merge({
      hpf: { on: true, freqHz: 50 },
      eq: {
        on: true,
        bands: [
          { freq: 60, gainDb: 1.5, q: 0.7, type: "lowshelf" },
          { freq: 200, gainDb: -1, q: 1.0, type: "peaking" },
          { freq: 700, gainDb: 0.5, q: 1.0, type: "peaking" },
          { freq: 2500, gainDb: 2.5, q: 1.2, type: "peaking" },
          { freq: 6000, gainDb: 1, q: 1.4, type: "peaking" },
          { freq: 12000, gainDb: 1.5, q: 0.7, type: "highshelf" },
        ],
      },
      deq: {
        on: true,
        bands: [
          { freqHz: 80, q: 0.9, thresholdDb: -17, maxCutDb: 8, attackMs: 8, releaseMs: 240 },
          { freqHz: 250, q: 1.0, thresholdDb: -18, maxCutDb: 7, attackMs: 8, releaseMs: 240 },
          { freqHz: 1600, q: 1.1, thresholdDb: -20, maxCutDb: 5, attackMs: 7, releaseMs: 220 },
          { freqHz: 5000, q: 1.2, thresholdDb: -20, maxCutDb: 5, attackMs: 6, releaseMs: 200 },
          { freqHz: 10000, q: 1.1, thresholdDb: -21, maxCutDb: 6, attackMs: 5, releaseMs: 180 },
        ],
      },
      multiband: mb6(
        { thresholdDb: -21, ratio: 5, attackMs: 6, releaseMs: 220, makeupDb: 3.5 },
        { thresholdDb: -21, ratio: 4.5, attackMs: 4, releaseMs: 200, makeupDb: 3.5 },
        { thresholdDb: -22, ratio: 4, attackMs: 2.5, releaseMs: 180, makeupDb: 3.5 },
        [...OMNIA_SPLITS] as MultibandSplits,
      ),
      agc: {
        on: true,
        thresholdDb: -22,
        ratio: 5,
        kneeDb: 4,
        attackMs: 8,
        releaseMs: 250,
        makeupDb: 7,
      },
      rider: { on: true, targetLufs: -20, maxRideDb: 10, gateDb: -50, speed: "fast" },
      stereo: { width: 1.12 },
      exciter: { on: true, mix: 3.5, freqHz: 6000 },
      limiter: { on: true, ceilingDb: -0.8, attackMs: 0.5, releaseMs: 70 },
    }),
  },
  {
    id: "omnia-hot",
    name: "Omnia · Hot",
    description:
      "Like Dense, a processed sound overall but with stronger bass, less warmth in the mid-bass and a noticeable presence boost — loud and assertive without tipping into harshness.",
    tags: ["General", "Omnia", "Loud"],
    family: "Omnia",
    params: merge({
      hpf: { on: true, freqHz: 45 },
      eq: {
        on: true,
        bands: [
          { freq: 60, gainDb: 4.5, q: 0.7, type: "lowshelf" },
          { freq: 200, gainDb: -2, q: 1.0, type: "peaking" },
          { freq: 700, gainDb: 0, q: 1.0, type: "peaking" },
          { freq: 2500, gainDb: 4, q: 1.2, type: "peaking" },
          { freq: 6000, gainDb: 1.5, q: 1.4, type: "peaking" },
          { freq: 12000, gainDb: 1.5, q: 0.7, type: "highshelf" },
        ],
      },
      deq: {
        on: true,
        bands: [
          { freqHz: 80, q: 0.9, thresholdDb: -16, maxCutDb: 9, attackMs: 7, releaseMs: 220 },
          { freqHz: 250, q: 1.0, thresholdDb: -17, maxCutDb: 8, attackMs: 7, releaseMs: 220 },
          { freqHz: 1600, q: 1.1, thresholdDb: -19, maxCutDb: 6, attackMs: 6, releaseMs: 200 },
          { freqHz: 5000, q: 1.2, thresholdDb: -19, maxCutDb: 6, attackMs: 5, releaseMs: 180 },
          { freqHz: 10000, q: 1.1, thresholdDb: -20, maxCutDb: 7, attackMs: 4, releaseMs: 160 },
        ],
      },
      multiband: mb6(
        { thresholdDb: -22, ratio: 5.5, attackMs: 5, releaseMs: 190, makeupDb: 4 },
        { thresholdDb: -22, ratio: 5, attackMs: 3.5, releaseMs: 180, makeupDb: 4 },
        { thresholdDb: -23, ratio: 4.5, attackMs: 2, releaseMs: 160, makeupDb: 4 },
        [...OMNIA_SPLITS] as MultibandSplits,
      ),
      agc: {
        on: true,
        thresholdDb: -24,
        ratio: 6,
        kneeDb: 3,
        attackMs: 6,
        releaseMs: 200,
        makeupDb: 8,
      },
      rider: { on: true, targetLufs: -19, maxRideDb: 10, gateDb: -49, speed: "fast" },
      stereo: { width: 1.15 },
      exciter: { on: true, mix: 4.5, freqHz: 6000 },
      limiter: { on: true, ceilingDb: -0.5, attackMs: 0.4, releaseMs: 55 },
    }),
  },
  {
    id: "omnia-bold",
    name: "Omnia · Bold",
    description:
      "Like Dense but with noticeably more bass and more prominent highs — the most processed of the Omnia texture presets, built to own a crowded dial.",
    tags: ["General", "Omnia", "Max"],
    family: "Omnia",
    params: merge({
      hpf: { on: true, freqHz: 40 },
      eq: {
        on: true,
        bands: [
          { freq: 60, gainDb: 5.5, q: 0.7, type: "lowshelf" },
          { freq: 200, gainDb: -1.5, q: 1.0, type: "peaking" },
          { freq: 700, gainDb: 0.5, q: 1.0, type: "peaking" },
          { freq: 2500, gainDb: 3, q: 1.2, type: "peaking" },
          { freq: 6000, gainDb: 2, q: 1.4, type: "peaking" },
          { freq: 12000, gainDb: 4, q: 0.7, type: "highshelf" },
        ],
      },
      deq: {
        on: true,
        bands: [
          { freqHz: 80, q: 0.9, thresholdDb: -16, maxCutDb: 9, attackMs: 6, releaseMs: 200 },
          { freqHz: 250, q: 1.0, thresholdDb: -17, maxCutDb: 8, attackMs: 6, releaseMs: 200 },
          { freqHz: 1600, q: 1.1, thresholdDb: -18, maxCutDb: 6, attackMs: 5, releaseMs: 190 },
          { freqHz: 5000, q: 1.2, thresholdDb: -18, maxCutDb: 6, attackMs: 5, releaseMs: 170 },
          { freqHz: 10000, q: 1.1, thresholdDb: -19, maxCutDb: 8, attackMs: 4, releaseMs: 150 },
        ],
      },
      multiband: mb6(
        { thresholdDb: -22, ratio: 6, attackMs: 5, releaseMs: 180, makeupDb: 4.5 },
        { thresholdDb: -22, ratio: 5.5, attackMs: 3.5, releaseMs: 170, makeupDb: 4.5 },
        { thresholdDb: -23, ratio: 5, attackMs: 1.8, releaseMs: 150, makeupDb: 4.5 },
        [...OMNIA_SPLITS] as MultibandSplits,
      ),
      agc: {
        on: true,
        thresholdDb: -25,
        ratio: 7,
        kneeDb: 2.5,
        attackMs: 5,
        releaseMs: 180,
        makeupDb: 9,
      },
      rider: { on: true, targetLufs: -18, maxRideDb: 11, gateDb: -48, speed: "fast" },
      stereo: { width: 1.18 },
      exciter: { on: true, mix: 5.5, freqHz: 6500 },
      limiter: { on: true, ceilingDb: -0.5, attackMs: 0.35, releaseMs: 50 },
    }),
  },
  {
    id: "omnia-talk",
    name: "Omnia · Talk",
    description:
      "Optimised for voice: the phase rotator smooths asymmetrical peaks before dynamics see them, and fast multiband attack and release rates control the widely varying levels of multi-mic studios and call-in programmes.",
    tags: ["Speech", "Omnia", "Voice"],
    family: "Omnia",
    params: merge({
      hpf: { on: true, freqHz: 100 },
      phase: { mode: "auto", freqHz: 90 },
      gate: { on: true, thresholdDb: -50, holdMs: 700 },
      eq: {
        on: true,
        bands: [
          { freq: 60, gainDb: -1, q: 0.7, type: "lowshelf" },
          { freq: 200, gainDb: -1.5, q: 1.0, type: "peaking" },
          { freq: 700, gainDb: 0.5, q: 1.0, type: "peaking" },
          { freq: 2500, gainDb: 3.5, q: 1.2, type: "peaking" },
          { freq: 6000, gainDb: -1, q: 1.6, type: "peaking" },
          { freq: 12000, gainDb: 0.5, q: 0.7, type: "highshelf" },
        ],
      },
      deq: {
        on: true,
        bands: [
          { freqHz: 80, q: 0.9, thresholdDb: -20, maxCutDb: 6, attackMs: 10, releaseMs: 260 },
          { freqHz: 250, q: 1.0, thresholdDb: -20, maxCutDb: 6, attackMs: 10, releaseMs: 260 },
          { freqHz: 1600, q: 1.1, thresholdDb: -21, maxCutDb: 5, attackMs: 6, releaseMs: 200 },
          { freqHz: 5000, q: 1.2, thresholdDb: -19, maxCutDb: 6, attackMs: 4, releaseMs: 160 },
          { freqHz: 10000, q: 1.1, thresholdDb: -20, maxCutDb: 7, attackMs: 3, releaseMs: 120 },
        ],
      },
      multiband: mb6(
        { thresholdDb: -16, ratio: 4, attackMs: 3, releaseMs: 110, makeupDb: 3 },
        { thresholdDb: -16, ratio: 4.5, attackMs: 2, releaseMs: 100, makeupDb: 3 },
        { thresholdDb: -18, ratio: 5, attackMs: 1, releaseMs: 85, makeupDb: 3 },
        [...OMNIA_SPLITS] as MultibandSplits,
      ),
      agc: {
        on: true,
        thresholdDb: -20,
        ratio: 4.5,
        kneeDb: 3,
        attackMs: 4,
        releaseMs: 150,
        makeupDb: 6,
      },
      rider: { on: true, targetLufs: LUFS_TARGET, maxRideDb: 10, gateDb: -48, speed: "fast" },
      stereo: { width: 1.02 },
      limiter: { on: true, ceilingDb: -1, attackMs: 0.6, releaseMs: 60 },
    }),
  },
  {
    id: "omnia-sports",
    name: "Omnia · Sports",
    description:
      "Like Talk, optimised for voice but with slower attack and release rates and more active wideband and multiband gating, so crowd surges and stadium ambience never ride up during announcer pauses.",
    tags: ["Speech", "Omnia", "Fast"],
    family: "Omnia",
    params: merge({
      hpf: { on: true, freqHz: 100 },
      phase: { mode: "auto", freqHz: 90 },
      gate: { on: true, thresholdDb: -46, holdMs: 1200 },
      eq: {
        on: true,
        bands: [
          { freq: 60, gainDb: -2, q: 0.7, type: "lowshelf" },
          { freq: 200, gainDb: -1, q: 1.0, type: "peaking" },
          { freq: 700, gainDb: 1, q: 1.0, type: "peaking" },
          { freq: 2500, gainDb: 4, q: 1.2, type: "peaking" },
          { freq: 6000, gainDb: -0.5, q: 1.5, type: "peaking" },
          { freq: 12000, gainDb: 0, q: 0.7, type: "highshelf" },
        ],
      },
      deq: {
        on: true,
        bands: [
          { freqHz: 80, q: 0.9, thresholdDb: -19, maxCutDb: 7, attackMs: 12, releaseMs: 300 },
          { freqHz: 250, q: 1.0, thresholdDb: -19, maxCutDb: 6, attackMs: 12, releaseMs: 300 },
          { freqHz: 1600, q: 1.1, thresholdDb: -20, maxCutDb: 5, attackMs: 8, releaseMs: 240 },
          { freqHz: 5000, q: 1.2, thresholdDb: -18, maxCutDb: 6, attackMs: 6, releaseMs: 200 },
          { freqHz: 10000, q: 1.1, thresholdDb: -20, maxCutDb: 6, attackMs: 4, releaseMs: 150 },
        ],
      },
      multiband: mb6(
        { thresholdDb: -15, ratio: 4, attackMs: 8, releaseMs: 350, makeupDb: 3 },
        { thresholdDb: -15, ratio: 4.5, attackMs: 6, releaseMs: 330, makeupDb: 3 },
        { thresholdDb: -17, ratio: 4.5, attackMs: 4, releaseMs: 300, makeupDb: 2.5 },
        [...OMNIA_SPLITS] as MultibandSplits,
      ),
      agc: {
        on: true,
        thresholdDb: -19,
        ratio: 4,
        kneeDb: 4,
        attackMs: 10,
        releaseMs: 350,
        makeupDb: 6,
      },
      rider: { on: true, targetLufs: LUFS_TARGET, maxRideDb: 8, gateDb: -44, speed: "fast" },
      stereo: { width: 1.03 },
      limiter: { on: true, ceilingDb: -1, attackMs: 0.8, releaseMs: 80 },
    }),
  },
  {
    id: "omnia-rock",
    name: "Omnia · Rock",
    description:
      "Punchy low end, vocal presence and a bright top under medium-dense Omnia dynamics — the everyday rock/album tuning that keeps guitars exciting without squashing the drummer.",
    tags: ["Music", "Omnia", "Rock"],
    family: "Omnia",
    params: merge({
      hpf: { on: true, freqHz: 60 },
      eq: {
        on: true,
        bands: [
          { freq: 60, gainDb: 3.5, q: 0.7, type: "lowshelf" },
          { freq: 200, gainDb: -1.5, q: 1.1, type: "peaking" },
          { freq: 700, gainDb: 0.5, q: 1.0, type: "peaking" },
          { freq: 2500, gainDb: 2, q: 1.1, type: "peaking" },
          { freq: 6000, gainDb: 1, q: 1.4, type: "peaking" },
          { freq: 12000, gainDb: 2.5, q: 0.7, type: "highshelf" },
        ],
      },
      deq: {
        on: true,
        bands: [
          { freqHz: 80, q: 0.9, thresholdDb: -18, maxCutDb: 7, attackMs: 9, releaseMs: 250 },
          { freqHz: 250, q: 1.0, thresholdDb: -18, maxCutDb: 6, attackMs: 9, releaseMs: 250 },
          { freqHz: 1600, q: 1.1, thresholdDb: -20, maxCutDb: 5, attackMs: 7, releaseMs: 220 },
          { freqHz: 5000, q: 1.2, thresholdDb: -20, maxCutDb: 5, attackMs: 6, releaseMs: 200 },
          { freqHz: 10000, q: 1.1, thresholdDb: -21, maxCutDb: 6, attackMs: 5, releaseMs: 180 },
        ],
      },
      multiband: mb6(
        { thresholdDb: -18, ratio: 5, attackMs: 5, releaseMs: 180, makeupDb: 3 },
        { thresholdDb: -19, ratio: 4.5, attackMs: 3.5, releaseMs: 160, makeupDb: 3 },
        { thresholdDb: -20, ratio: 4, attackMs: 2, releaseMs: 140, makeupDb: 3 },
        [...OMNIA_SPLITS] as MultibandSplits,
      ),
      agc: {
        on: true,
        thresholdDb: -21,
        ratio: 4.5,
        kneeDb: 4,
        attackMs: 8,
        releaseMs: 240,
        makeupDb: 6,
      },
      rider: { on: true, targetLufs: -21, maxRideDb: 8, gateDb: -52, speed: "fast" },
      stereo: { width: 1.14 },
      exciter: { on: true, mix: 3.5, freqHz: 6000 },
      limiter: { on: true, ceilingDb: -0.8, attackMs: 0.6, releaseMs: 70 },
    }),
  },
  {
    id: "omnia-country",
    name: "Omnia · Country",
    description:
      "Warm and vocal-forward: fiddle, steel and twang stay intact while a gentle levelling pass and light presence lift keep lyrics front and centre over acoustic beds.",
    tags: ["Music", "Omnia", "Warm"],
    family: "Omnia",
    params: merge({
      hpf: { on: true, freqHz: 60 },
      eq: {
        on: true,
        bands: [
          { freq: 60, gainDb: 2, q: 0.7, type: "lowshelf" },
          { freq: 200, gainDb: -0.5, q: 1.0, type: "peaking" },
          { freq: 700, gainDb: 0.5, q: 1.0, type: "peaking" },
          { freq: 2500, gainDb: 2.5, q: 1.2, type: "peaking" },
          { freq: 6000, gainDb: 0.5, q: 1.4, type: "peaking" },
          { freq: 12000, gainDb: 1, q: 0.7, type: "highshelf" },
        ],
      },
      deq: {
        on: true,
        bands: [
          { freqHz: 80, q: 0.9, thresholdDb: -20, maxCutDb: 5, attackMs: 12, releaseMs: 300 },
          { freqHz: 250, q: 1.0, thresholdDb: -21, maxCutDb: 5, attackMs: 11, releaseMs: 300 },
          { freqHz: 1600, q: 1.1, thresholdDb: -22, maxCutDb: 4, attackMs: 9, releaseMs: 260 },
          { freqHz: 5000, q: 1.2, thresholdDb: -22, maxCutDb: 4, attackMs: 8, releaseMs: 240 },
          { freqHz: 10000, q: 1.1, thresholdDb: -24, maxCutDb: 4, attackMs: 7, releaseMs: 220 },
        ],
      },
      multiband: mb6(
        { thresholdDb: -16, ratio: 3.5, attackMs: 8, releaseMs: 280, makeupDb: 2 },
        { thresholdDb: -17, ratio: 3.5, attackMs: 6, releaseMs: 260, makeupDb: 2 },
        { thresholdDb: -18, ratio: 3.5, attackMs: 4, releaseMs: 230, makeupDb: 2 },
        [...OMNIA_SPLITS] as MultibandSplits,
      ),
      agc: {
        on: true,
        thresholdDb: -19,
        ratio: 3.5,
        kneeDb: 6,
        attackMs: 12,
        releaseMs: 380,
        makeupDb: 4,
      },
      rider: { on: true, targetLufs: LUFS_TARGET, maxRideDb: 7, gateDb: -54, speed: "slow" },
      stereo: { width: 1.08 },
      limiter: { on: true, ceilingDb: -1, attackMs: 0.9, releaseMs: 90 },
    }),
  },
  {
    id: "omnia-jazz",
    name: "Omnia · Jazz",
    description:
      "Quiet, clean and mellow for instrumental music — light re-equalization eases horn and sax stridency without erasing the recording's own balance, and timing stays relaxed throughout.",
    tags: ["Music", "Omnia", "Mellow"],
    family: "Omnia",
    params: merge({
      hpf: { on: true, freqHz: 50 },
      eq: {
        on: true,
        bands: [
          { freq: 60, gainDb: 1, q: 0.7, type: "lowshelf" },
          { freq: 200, gainDb: -0.5, q: 0.9, type: "peaking" },
          { freq: 700, gainDb: 0, q: 1.0, type: "peaking" },
          { freq: 2500, gainDb: -0.5, q: 1.2, type: "peaking" },
          { freq: 6000, gainDb: -1, q: 1.6, type: "peaking" },
          { freq: 12000, gainDb: 0.5, q: 0.7, type: "highshelf" },
        ],
      },
      deq: {
        on: false,
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
        [...OMNIA_SPLITS] as MultibandSplits,
      ),
      agc: {
        on: true,
        thresholdDb: -17,
        ratio: 2,
        kneeDb: 10,
        attackMs: 25,
        releaseMs: 650,
        makeupDb: 3,
      },
      rider: { on: true, targetLufs: -24, maxRideDb: 5, gateDb: -58, speed: "slow" },
      stereo: { width: 1.05 },
      limiter: { on: true, ceilingDb: -1.5, attackMs: 2, releaseMs: 220 },
    }),
  },
  {
    id: "ofcom-fm-reference",
    name: "OFCOM · UK FM Reference",
    description:
      "The UK FM compliance chain: 50 µs pre-emphasis with the composite generator engaged at legal pilot (9 %) and RDS (3 %) levels, a hard 100 % deviation ceiling with overmodulation alarm, and an EBU R128 −23 LUFS ride with −1.5 dBTP headroom so the pre-emphasis treble boost can never clip the composite.",
    tags: ["FM", "OFCOM", "R128"],
    family: "OFCOM",
    params: merge({
      hpf: { on: true, freqHz: 50 },
      eq: {
        on: true,
        bands: [
          { freq: 60, gainDb: 0, q: 0.7, type: "lowshelf" },
          { freq: 200, gainDb: 0, q: 1.0, type: "peaking" },
          { freq: 700, gainDb: 0, q: 1.0, type: "peaking" },
          { freq: 2500, gainDb: 1, q: 1.2, type: "peaking" },
          { freq: 6000, gainDb: 0, q: 1.4, type: "peaking" },
          { freq: 12000, gainDb: 0.5, q: 0.7, type: "highshelf" },
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
      multiband: mb6(
        { thresholdDb: -14, ratio: 3, attackMs: 10, releaseMs: 350, makeupDb: 2 },
        { thresholdDb: -16, ratio: 3, attackMs: 7, releaseMs: 330, makeupDb: 2 },
        { thresholdDb: -18, ratio: 3, attackMs: 4, releaseMs: 300, makeupDb: 1.5 },
      ),
      agc: {
        on: true,
        thresholdDb: -18,
        ratio: 3,
        kneeDb: 6,
        attackMs: 15,
        releaseMs: 400,
        makeupDb: 4,
      },
      // pinned: OFCOM compliance requires the −23 LUFS ride
      rider: { on: true, targetLufs: -23, maxRideDb: 8, gateDb: -55, speed: "fast" },
      stereo: { width: 1.05 },
      limiter: { on: true, ceilingDb: -1.5, attackMs: 1, releaseMs: 100 },
      fm: {
        on: true,
        emphasis: "50",
        mpx: {
          on: true,
          pilotPct: 9,
          rdsPct: 3,
          rdsPs: "SIGNAL  ",
          rdsPi: "C479",
          rdsPty: 10,
          rdsRt: "Signalpath broadcast",
          rdsAf: [],
          rdsScroll: false,
          rdsDelayMs: 0,
          rdsRtAuto: true,
          rdsRtPlus: true,
          scaPct: 0,
          ceilingPct: 100,
          alarmPct: 100,
        },
      },
    }),
  },
  {
    id: "ofcom-fm-speech",
    name: "OFCOM · UK FM Speech & Phone-in",
    description:
      "Talk and phone-in programming under the UK FM licence: phase rotation smooths asymmetrical peaks, fast multiband timing controls multi-mic studios and callers, and the same legal MPX settings with −23 LUFS ride keep the transmission compliant through every interview and talk break.",
    tags: ["Speech", "OFCOM", "Talk"],
    family: "OFCOM",
    params: merge({
      hpf: { on: true, freqHz: 100 },
      phase: { mode: "auto", freqHz: 90 },
      gate: { on: true, thresholdDb: -50, holdMs: 700 },
      eq: {
        on: true,
        bands: [
          { freq: 60, gainDb: -1, q: 0.7, type: "lowshelf" },
          { freq: 200, gainDb: -1.5, q: 1.0, type: "peaking" },
          { freq: 700, gainDb: 0.5, q: 1.0, type: "peaking" },
          { freq: 2500, gainDb: 3, q: 1.2, type: "peaking" },
          { freq: 6000, gainDb: -1, q: 1.6, type: "peaking" },
          { freq: 12000, gainDb: 0, q: 0.7, type: "highshelf" },
        ],
      },
      deq: {
        on: true,
        bands: [
          { freqHz: 80, q: 0.9, thresholdDb: -20, maxCutDb: 6, attackMs: 10, releaseMs: 260 },
          { freqHz: 250, q: 1.0, thresholdDb: -20, maxCutDb: 6, attackMs: 10, releaseMs: 260 },
          { freqHz: 1600, q: 1.1, thresholdDb: -21, maxCutDb: 5, attackMs: 6, releaseMs: 200 },
          { freqHz: 5000, q: 1.2, thresholdDb: -19, maxCutDb: 6, attackMs: 4, releaseMs: 160 },
          { freqHz: 10000, q: 1.1, thresholdDb: -20, maxCutDb: 7, attackMs: 3, releaseMs: 120 },
        ],
      },
      multiband: mb6(
        { thresholdDb: -16, ratio: 4, attackMs: 3, releaseMs: 110, makeupDb: 3 },
        { thresholdDb: -16, ratio: 4.5, attackMs: 2, releaseMs: 100, makeupDb: 3 },
        { thresholdDb: -18, ratio: 5, attackMs: 1, releaseMs: 85, makeupDb: 3 },
      ),
      agc: {
        on: true,
        thresholdDb: -20,
        ratio: 4.5,
        kneeDb: 3,
        attackMs: 4,
        releaseMs: 150,
        makeupDb: 6,
      },
      // pinned: OFCOM compliance requires the −23 LUFS ride
      rider: { on: true, targetLufs: -23, maxRideDb: 10, gateDb: -48, speed: "fast" },
      stereo: { width: 1.02 },
      limiter: { on: true, ceilingDb: -1.5, attackMs: 0.6, releaseMs: 60 },
      fm: {
        on: true,
        emphasis: "50",
        mpx: {
          on: true,
          pilotPct: 9,
          rdsPct: 3,
          rdsPs: "SIGNAL  ",
          rdsPi: "C479",
          rdsPty: 10,
          rdsRt: "Signalpath broadcast",
          rdsAf: [],
          rdsScroll: false,
          rdsDelayMs: 0,
          rdsRtAuto: true,
          rdsRtPlus: true,
          scaPct: 0,
          ceilingPct: 100,
          alarmPct: 100,
        },
      },
    }),
  },
  {
    id: "ofcom-fm-chr",
    name: "OFCOM · UK FM CHR / Hit Music",
    description:
      "Competitive contemporary radio inside the licence: density comes from deep multiband and a hot −23 LUFS ride rather than extra level, while a −2 dBTP ceiling and the 100 % composite alarm guarantee the 50 µs pre-emphasis boost never over-deviates the transmitter.",
    tags: ["Music", "OFCOM", "Loud"],
    family: "OFCOM",
    params: merge({
      hpf: { on: true, freqHz: 45 },
      eq: {
        on: true,
        bands: [
          { freq: 60, gainDb: 3, q: 0.7, type: "lowshelf" },
          { freq: 200, gainDb: -1.5, q: 1.1, type: "peaking" },
          { freq: 700, gainDb: 0.5, q: 1.0, type: "peaking" },
          { freq: 2500, gainDb: 2.5, q: 1.2, type: "peaking" },
          { freq: 6000, gainDb: 1, q: 1.4, type: "peaking" },
          { freq: 12000, gainDb: 1.5, q: 0.7, type: "highshelf" },
        ],
      },
      deq: {
        on: true,
        bands: [
          { freqHz: 80, q: 0.9, thresholdDb: -18, maxCutDb: 7, attackMs: 9, releaseMs: 250 },
          { freqHz: 250, q: 1.0, thresholdDb: -18, maxCutDb: 6, attackMs: 9, releaseMs: 250 },
          { freqHz: 1600, q: 1.1, thresholdDb: -20, maxCutDb: 5, attackMs: 7, releaseMs: 220 },
          { freqHz: 5000, q: 1.2, thresholdDb: -20, maxCutDb: 5, attackMs: 6, releaseMs: 200 },
          { freqHz: 10000, q: 1.1, thresholdDb: -21, maxCutDb: 6, attackMs: 5, releaseMs: 180 },
        ],
      },
      multiband: mb6(
        { thresholdDb: -20, ratio: 5, attackMs: 5, releaseMs: 180, makeupDb: 3.5 },
        { thresholdDb: -21, ratio: 4.5, attackMs: 3, releaseMs: 160, makeupDb: 3.5 },
        { thresholdDb: -22, ratio: 4, attackMs: 1.5, releaseMs: 140, makeupDb: 3 },
      ),
      agc: {
        on: true,
        thresholdDb: -22,
        ratio: 5,
        kneeDb: 4,
        attackMs: 6,
        releaseMs: 200,
        makeupDb: 7,
      },
      // pinned: OFCOM compliance requires the −23 LUFS ride
      rider: { on: true, targetLufs: -23, maxRideDb: 9, gateDb: -50, speed: "fast" },
      stereo: { width: 1.15 },
      exciter: { on: true, mix: 3, freqHz: 6000 },
      limiter: { on: true, ceilingDb: -2, attackMs: 0.5, releaseMs: 70 },
      fm: {
        on: true,
        emphasis: "50",
        mpx: {
          on: true,
          pilotPct: 9,
          rdsPct: 3,
          rdsPs: "SIGNAL  ",
          rdsPi: "C479",
          rdsPty: 10,
          rdsRt: "Signalpath broadcast",
          rdsAf: [],
          rdsScroll: false,
          rdsDelayMs: 0,
          rdsRtAuto: true,
          rdsRtPlus: true,
          scaPct: 0,
          ceilingPct: 100,
          alarmPct: 100,
        },
      },
    }),
  },
  {
    id: "ofcom-fm-classical",
    name: "OFCOM · UK FM Classical",
    description:
      "Wide-dynamic classical under the UK FM licence: minimal intervention with slow multiband and a long-integration loudness ride sitting just under the −23 LUFS nominal, so crescendos survive intact and the composite stays a long way inside 100 % modulation.",
    tags: ["Music", "OFCOM", "Purist"],
    family: "OFCOM",
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
      fm: {
        on: true,
        emphasis: "50",
        mpx: {
          on: true,
          pilotPct: 9,
          rdsPct: 3,
          rdsPs: "SIGNAL  ",
          rdsPi: "C479",
          rdsPty: 10,
          rdsRt: "Signalpath broadcast",
          rdsAf: [],
          rdsScroll: false,
          rdsDelayMs: 0,
          rdsRtAuto: true,
          rdsRtPlus: true,
          scaPct: 0,
          ceilingPct: 100,
          alarmPct: 100,
        },
      },
    }),
  },
  {
    id: "ofcom-fm-sports",
    name: "OFCOM · UK FM Sports OB",
    description:
      "Outside-broadcast sports commentary for UK FM: slower multiband timing with a more active wideband gate and pause-hold so crowd surges never ride up in gaps between commentary, all under the same legal 50 µs / MPX / −23 LUFS compliance stack.",
    tags: ["Speech", "OFCOM", "Sports"],
    family: "OFCOM",
    params: merge({
      hpf: { on: true, freqHz: 100 },
      phase: { mode: "auto", freqHz: 90 },
      gate: { on: true, thresholdDb: -46, holdMs: 1200 },
      eq: {
        on: true,
        bands: [
          { freq: 60, gainDb: -2, q: 0.7, type: "lowshelf" },
          { freq: 200, gainDb: -1, q: 1.0, type: "peaking" },
          { freq: 700, gainDb: 1, q: 1.0, type: "peaking" },
          { freq: 2500, gainDb: 4, q: 1.2, type: "peaking" },
          { freq: 6000, gainDb: -0.5, q: 1.5, type: "peaking" },
          { freq: 12000, gainDb: 0, q: 0.7, type: "highshelf" },
        ],
      },
      deq: {
        on: true,
        bands: [
          { freqHz: 80, q: 0.9, thresholdDb: -19, maxCutDb: 7, attackMs: 12, releaseMs: 300 },
          { freqHz: 250, q: 1.0, thresholdDb: -19, maxCutDb: 6, attackMs: 12, releaseMs: 300 },
          { freqHz: 1600, q: 1.1, thresholdDb: -20, maxCutDb: 5, attackMs: 8, releaseMs: 240 },
          { freqHz: 5000, q: 1.2, thresholdDb: -18, maxCutDb: 6, attackMs: 6, releaseMs: 200 },
          { freqHz: 10000, q: 1.1, thresholdDb: -20, maxCutDb: 6, attackMs: 4, releaseMs: 150 },
        ],
      },
      multiband: mb6(
        { thresholdDb: -15, ratio: 4, attackMs: 8, releaseMs: 350, makeupDb: 3 },
        { thresholdDb: -15, ratio: 4.5, attackMs: 6, releaseMs: 330, makeupDb: 3 },
        { thresholdDb: -17, ratio: 4.5, attackMs: 4, releaseMs: 300, makeupDb: 2.5 },
      ),
      agc: {
        on: true,
        thresholdDb: -19,
        ratio: 4,
        kneeDb: 4,
        attackMs: 10,
        releaseMs: 350,
        makeupDb: 6,
      },
      // pinned: OFCOM compliance requires the −23 LUFS ride
      rider: { on: true, targetLufs: -23, maxRideDb: 8, gateDb: -44, speed: "fast" },
      stereo: { width: 1.03 },
      limiter: { on: true, ceilingDb: -1.5, attackMs: 0.8, releaseMs: 80 },
      fm: {
        on: true,
        emphasis: "50",
        mpx: {
          on: true,
          pilotPct: 9,
          rdsPct: 3,
          rdsPs: "SIGNAL  ",
          rdsPi: "C479",
          rdsPty: 10,
          rdsRt: "Signalpath broadcast",
          rdsAf: [],
          rdsScroll: false,
          rdsDelayMs: 0,
          rdsRtAuto: true,
          rdsRtPlus: true,
          scaPct: 0,
          ceilingPct: 100,
          alarmPct: 100,
        },
      },
    }),
  },
];

/* ── EQ response & A/B compare utilities ───────────────────────────────── */

/** Magnitude (dB) of a normalized biquad at digital frequency w. */
function biquadMagnitudeDb(
  b0: number,
  b1: number,
  b2: number,
  a0: number,
  a1: number,
  a2: number,
  w: number,
): number {
  const c1 = Math.cos(w);
  const s1 = Math.sin(w);
  const c2 = Math.cos(2 * w);
  const s2 = Math.sin(2 * w);
  const nr = b0 + b1 * c1 + b2 * c2;
  const ni = -(b1 * s1 + b2 * s2);
  const dr = a0 + a1 * c1 + a2 * c2;
  const di = -(a1 * s1 + a2 * s2);
  const num = nr * nr + ni * ni;
  const den = dr * dr + di * di;
  return 10 * Math.log10(Math.max(num / Math.max(den, 1e-12), 1e-12));
}

/**
 * RBJ cookbook magnitude response (dB) for one EQ/filter stage — mirrors
 * the Web Audio BiquadFilterNodes the engine uses, so the analyzer's
 * response curve matches what the chain actually does.
 */
function stageResponseDb(
  type: EqBandType,
  freqHz: number,
  gainDb: number,
  q: number,
  f: number,
  fs: number,
): number {
  const w0 = (2 * Math.PI * freqHz) / fs;
  const cw = Math.cos(w0);
  const sw = Math.sin(w0);
  const w = (2 * Math.PI * f) / fs;
  if (type === "highpass" || type === "lowpass") {
    // RBJ: HP b0 = (1 + cos)/2, LP b0 = (1 − cos)/2. `sign` folds one
    // expression onto both.
    const alpha = sw / (2 * q);
    const a0 = 1 + alpha;
    const sign = type === "highpass" ? 1 : -1;
    const b0 = (1 + sign * cw) / 2;
    return biquadMagnitudeDb(b0, -sign * 2 * b0, b0, a0, -2 * cw, 1 - alpha, w);
  }
  if (type === "notch") {
    const alpha = sw / (2 * q);
    const a0 = 1 + alpha;
    return biquadMagnitudeDb(1, -2 * cw, 1, a0, -2 * cw, 1 - alpha, w);
  }
  const A = Math.pow(10, gainDb / 40);
  if (type === "peaking") {
    const alpha = sw / (2 * q);
    const a0 = 1 + alpha / A;
    return biquadMagnitudeDb(
      1 + alpha * A,
      -2 * cw,
      1 - alpha * A,
      a0,
      -2 * cw,
      1 - alpha / A,
      w,
    );
  }
  // shelving (RBJ: S = slope, we use the band's Q as S — display accuracy)
  const alpha =
    (sw / 2) * Math.sqrt(Math.max(0, (A + 1 / A) * (1 / q - 1) + 2));
  const twoRootA = 2 * Math.sqrt(A);
  if (type === "lowshelf") {
    const a0 = A + 1 + (A - 1) * cw + twoRootA * alpha;
    return biquadMagnitudeDb(
      A * (A + 1 - (A - 1) * cw + twoRootA * alpha),
      2 * A * (A - 1 - (A + 1) * cw),
      A * (A + 1 - (A - 1) * cw - twoRootA * alpha),
      a0,
      -2 * (A - 1 + (A + 1) * cw),
      A + 1 + (A - 1) * cw - twoRootA * alpha,
      w,
    );
  }
  const a0 = A + 1 - (A - 1) * cw + twoRootA * alpha;
  return biquadMagnitudeDb(
    A * (A + 1 + (A - 1) * cw + twoRootA * alpha),
    -2 * A * (A - 1 + (A + 1) * cw),
    A * (A + 1 + (A - 1) * cw - twoRootA * alpha),
    a0,
    2 * (A - 1 - (A + 1) * cw),
    A + 1 - (A - 1) * cw - twoRootA * alpha,
    w,
  );
}

/**
 * Composite static response of the input filter + 6-band EQ (dB) at `f`.
 * Display-only: dynamic-EQ and compression stages are level-dependent and
 * deliberately not drawn.
 */
export function chainResponseDb(
  p: Pick<ProcessorParams, "eq" | "hpf">,
  f: number,
  fs = 48000,
): number {
  let db = 0;
  if (p.hpf.on) {
    // One biquad per 12 dB/oct of the selected steepness, exactly as the
    // engine cascades them.
    for (const q of hpfSectionQs(p.hpf.slope)) {
      db += stageResponseDb("highpass", p.hpf.freqHz, 0, q, f, fs);
    }
  }
  if (p.eq.on) {
    for (const band of p.eq.bands) {
      if (!eqBandOn(band)) continue;
      db += stageResponseDb(band.type, band.freq, band.gainDb, band.q, f, fs);
    }
  }
  return db;
}

/**
 * SOURCE — the monitor feed with the processing chain bypassed for instant
 * A/B comparison. Trim, limiter and the 4× ceiling guard stay in circuit
 * (hot sources can't blast the monitor path), phase rotation has no engine
 * bypass and is left untouched.
 */
export function sourceParams(p: ProcessorParams): ProcessorParams {
  const src = cloneParams(p);
  src.hpf = { ...src.hpf, on: false };
  src.gate = { ...src.gate, on: false };
  src.eq = { ...src.eq, on: false };
  src.deq = { ...src.deq, on: false };
  src.multiband = { ...src.multiband, on: false };
  src.agc = { ...src.agc, on: false };
  src.rider = { ...src.rider, on: false };
  src.exciter = { ...src.exciter, on: false };
  src.stereo = { ...src.stereo, width: 1 };
  return src;
}

/* ── helpers ──────────────────────────────────────────────────────── */

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
