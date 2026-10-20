/**
 * Broadcast processing tools — the control maths behind four console
 * features. Kept as pure functions/classes so they can be verified without a
 * browser audio graph, and so the engine only has to wire them to nodes.
 *
 *  1  WindowGate      — freeze AGC gain while the level stays inside a window
 *  2  PHASE_STAGE_RATIOS — the staggered allpass cascade that rotates phase
 *  3  densityProfile  — the Less–More macro: ratios, timing, limiter drive
 *  4  de-esser        — band clamp + the parallel-subtract cut coefficient
 *  5  transfer curves — exact static transfers drawn by the console
 */

/* ── 1 · AGC window gate ──────────────────────────────────────────────── */

export interface WindowGateReading {
  /** Gain should be held (no new AGC movement) this tick. */
  frozen: boolean;
  /** Peak-to-trough spread over the window (dB). */
  spreadDb: number;
  /** Samples currently inside the window. */
  samples: number;
}

export interface WindowGateConfig {
  /** Window width in dB (peak-to-trough). 0 or less disables the gate. */
  windowDb: number;
  /** History length the spread is measured over (ms). */
  spanMs: number;
  /** Below this level the programme is silence, not "stable" (dBFS). */
  floorDb: number;
}

export const DEFAULT_WINDOW: WindowGateConfig = {
  windowDb: 3,
  spanMs: 1500,
  floorDb: -70,
};

/**
 * The gate reads the programme level every metering tick and watches its
 * peak-to-trough spread. Inside the window the AGC is frozen: gain stops
 * moving, so a quiet intro or a speech pause cannot be ridden up into the
 * noise floor. Leaving the window releases it.
 *
 * Hysteresis (35 %) keeps it from chattering on a level that sits exactly on
 * the edge — the same reason a hardware window gate has two thresholds.
 */
export class WindowGate {
  private points: { t: number; db: number }[] = [];
  private frozenFlag = false;

  private cfg: WindowGateConfig;

  constructor(cfg: WindowGateConfig = DEFAULT_WINDOW) {
    this.cfg = { ...cfg };
  }

  configure(patch: Partial<WindowGateConfig>) {
    Object.assign(this.cfg, patch);
    if (this.cfg.windowDb <= 0) this.reset();
  }

  get frozen() {
    return this.frozenFlag;
  }

  reset() {
    this.points = [];
    this.frozenFlag = false;
  }

  update(levelDb: number, nowMs: number): WindowGateReading {
    const { windowDb, spanMs, floorDb } = this.cfg;
    if (!(windowDb > 0) || !Number.isFinite(levelDb)) {
      this.reset();
      return { frozen: false, spreadDb: 0, samples: 0 };
    }
    // Silence is not "a stable programme" — a paused mic must not freeze the
    // gain at whatever the noise floor happens to be.
    if (levelDb < floorDb) {
      this.reset();
      return { frozen: false, spreadDb: 0, samples: 0 };
    }

    this.points.push({ t: nowMs, db: levelDb });
    while (this.points.length > 2 && nowMs - this.points[0].t > spanMs) {
      this.points.shift();
    }
    if (this.points.length > 240) this.points.shift();

    let lo = Infinity;
    let hi = -Infinity;
    for (const p of this.points) {
      if (p.db < lo) lo = p.db;
      if (p.db > hi) hi = p.db;
    }
    const spreadDb = hi - lo;
    const spanned = nowMs - this.points[0].t;

    // Only judge once the window holds real history, or one quiet moment
    // would look like a perfectly stable programme.
    if (spanned < spanMs * 0.5) {
      return { frozen: this.frozenFlag, spreadDb, samples: this.points.length };
    }

    if (!this.frozenFlag && spreadDb <= windowDb) this.frozenFlag = true;
    else if (this.frozenFlag && spreadDb > windowDb * 1.35 + 0.25) {
      this.frozenFlag = false;
    }

    return { frozen: this.frozenFlag, spreadDb, samples: this.points.length };
  }
}

/* ── 2 · phase rotator cascade ────────────────────────────────────────── */

/**
 * Four allpass sections, staggered around the tuning frequency. One allpass
 * rotates phase but leaves magnitude untouched; a cascade spreads that
 * rotation across the voice band so the positive and negative peaks of an
 * asymmetric waveform are levelled before the limiter sees them.
 *
 * 0.5× / 0.75× / 1× / 1.5× of the tuning frequency: at the 300 Hz voice
 * setting that is 150 / 225 / 300 / 450 Hz.
 */
export const PHASE_STAGE_RATIOS = [0.5, 0.75, 1, 1.5] as const;

export function phaseStageFrequencies(baseHz: number): number[] {
  const base = Number.isFinite(baseHz) ? Math.min(2000, Math.max(40, baseHz)) : 300;
  return PHASE_STAGE_RATIOS.map((r) => Math.round(base * r * 100) / 100);
}

/* ── 3 · Less–More density macro ──────────────────────────────────────── */

export interface DensityProfile {
  /** Multiplier for every multiband ratio. */
  ratioScale: number;
  /** Multiplier for every multiband attack/release time. */
  timeScale: number;
  /** Extra dB of gain into the limiter (the limiter ceiling is untouched). */
  driveDb: number;
  /** Human label for the console. */
  label: string;
}

export const DENSITY_MIN = 1;
export const DENSITY_MAX = 10;

/**
 * One control, three effects. 5 is exactly the preset's own tuning, below it
 * the chain opens up (lower ratios, slower envelopes, less drive), above it
 * packs tighter. The limiter ceiling never moves, so "more" raises average
 * density without spending true-peak headroom.
 */
export function densityProfile(setting: number): DensityProfile {
  const raw = Number.isFinite(setting) ? setting : 5;
  const d = Math.min(DENSITY_MAX, Math.max(DENSITY_MIN, raw));
  const w = (d - 5) / 5; // −0.8 … +1
  return {
    ratioScale: Math.round((1 + 0.4 * w) * 1000) / 1000,
    timeScale: Math.round((1 - 0.35 * w) * 1000) / 1000,
    driveDb: Math.round(1.5 * w * 100) / 100,
    label: d <= 3 ? "Open" : d <= 6 ? "Balanced" : d <= 8 ? "Dense" : "Maximum",
  };
}

/* ── 4 · de-esser ─────────────────────────────────────────────────────── */

export const DEESS_MIN_HZ = 5000;
export const DEESS_MAX_HZ = 10000;

/** Keep the operator's tuning inside the 6–10 kHz sibilance band. */
export function clampDeessFreq(hz: number): number {
  const v = Number.isFinite(hz) ? hz : 7500;
  return Math.min(DEESS_MAX_HZ, Math.max(DEESS_MIN_HZ, v));
}

/**
 * Parallel-subtract cut: subtracting α of a band is a −20·log10(1−α) cut at
 * its centre, so invert that for the wanted cut depth. α is capped below 1
 * because a full subtract would null the band entirely.
 */
export function deessAlpha(cutDb: number): number {
  if (!(cutDb > 0)) return 0;
  const cut = Math.min(60, cutDb);
  return Math.min(0.999, 1 - Math.pow(10, -cut / 20));
}

/* ── 5 · adaptive limiter envelopes ───────────────────────────────────── */

/**
 * Release for the limiter stages, adapted to the programme.
 *
 * A fixed release is always wrong for half the material: percussion needs a
 * short one or the next hit arrives while the gain is still down, and
 * sustained music needs a long one or the gain rides the waveform and pumps.
 * The crest factor (peak − short-term loudness) is the practical tell —
 * percussive programme is peaky, sustained programme is not — so the release
 * is scaled between 0.55× and 1.6× of the operator's setting. A deep
 * reduction pushes it back up so recovery stays smooth under heavy limiting.
 *
 * With `adaptive` off the configured value is returned untouched.
 */
export function dynamicReleaseMs(
  configuredMs: number,
  crestDb: number,
  reductionDb: number,
  adaptive: boolean,
): number {
  const base = Math.min(2000, Math.max(10, Number.isFinite(configuredMs) ? configuredMs : 100));
  if (!adaptive) return base;
  const crest = Math.min(24, Math.max(3, Number.isFinite(crestDb) ? crestDb : 12));
  // 0 = sustained programme, 1 = transient-dense programme.
  const density = Math.min(1, Math.max(0, (16 - crest) / 10));
  const push = Math.min(1, Math.max(0, reductionDb / 6));
  const factor = 0.55 + 0.9 * (1 - density) + 0.15 * push;
  return Math.min(2000, Math.max(20, base * factor));
}

/**
 * Per-band widening safety for the coherence-width matrix.
 *
 * Widening a band that is already weakly correlated (a reverb tail, a doubled
 * vocal, an out-of-phase synth) is what makes a station sound hollow and can
 * collapse in mono. Widths at or below 1 (narrowing, including bass-to-mono)
 * are always safe; only widening is scaled down as correlation falls.
 */
export function coherenceSafety(correlation: number, guard: number): number {
  if (!Number.isFinite(correlation)) return 1;
  const floor = Math.min(0.9, Math.max(0, guard));
  if (correlation >= floor) return 1;
  const span = Math.max(0.05, floor - 0.2);
  return Math.min(1, Math.max(0, (correlation - 0.2) / span));
}

/** Effective per-band width after the safety scaling (never narrows less). */
export function safeWidth(width: number, safety: number): number {
  if (!(width > 1)) return width;
  return 1 + (width - 1) * Math.min(1, Math.max(0, safety));
}

/* ── 6 · transfer curves (drawn by the console, exact from settings) ──── */

/** Exact soft-knee compressor transfer from threshold/ratio/knee. */
export function compCurve(
  thresholdDb: number,
  ratio: number,
  kneeDb: number,
): (xDb: number) => number {
  const r = Math.max(1, ratio);
  const k = Math.max(0.01, kneeDb);
  return (x) => {
    if (x <= thresholdDb - k / 2) return x;
    if (x >= thresholdDb + k / 2) return thresholdDb + (x - thresholdDb) / r;
    const d = x - thresholdDb + k / 2;
    return x + ((1 / r - 1) * (d * d)) / (2 * k);
  };
}

/** Limiter transfer: density drive into a hard ceiling. */
export function limitCurve(
  driveDb: number,
  ceilingDb: number,
): (xDb: number) => number {
  return (x) => Math.min(x + driveDb, ceilingDb);
}
