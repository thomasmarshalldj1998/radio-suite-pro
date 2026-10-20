/**
 * Console measurement maths.
 *
 * Everything the engine reports on its meters is derived here, as pure
 * functions over sample blocks: peak, mean square, correlation, inter-sample
 * (true) peak, BS.1770 loudness and its gating. The engine only has to read an
 * analyser and hand the samples over, which keeps the metering testable
 * without an AudioContext and keeps the arithmetic in one place.
 */

/** Meter floor — anything quieter reads as this (dBFS). */
export const METER_FLOOR = -120;
/** BS.1770 silence floor for loudness readings (LUFS). */
export const LOUDNESS_FLOOR = -70;

export type Samples = Float32Array<ArrayBufferLike>;

export function toDb(v: number): number {
  const db = 20 * Math.log10(Math.max(Math.abs(v), 1e-12));
  return db < METER_FLOOR ? METER_FLOOR : db;
}

/** Largest absolute sample in the block. */
export function peakOf(samples: Samples): number {
  let max = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = Math.abs(samples[i]);
    if (v > max) max = v;
  }
  return max;
}

export function peakDb(samples: Samples): number {
  return toDb(peakOf(samples));
}

/** Mean of the squares — the power behind a loudness reading. */
export function meanSquare(samples: Samples): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return samples.length ? sum / samples.length : 0;
}

/** Normalised L/R correlation: +1 mono, 0 uncorrelated, −1 anti-phase. */
export function correlationOf(l: Samples, r: Samples): number {
  const n = Math.min(l.length, r.length);
  let dot = 0;
  let eL = 0;
  let eR = 0;
  for (let i = 0; i < n; i++) {
    const a = l[i];
    const b = r[i];
    dot += a * b;
    eL += a * a;
    eR += b * b;
  }
  const denom = Math.sqrt(eL * eR);
  return denom > 1e-9 ? Math.max(-1, Math.min(1, dot / denom)) : 1;
}

/* ── true peak (BS.1770-4 Annex 2, 4× oversampling) ───────────────────── */

const TRUE_PEAK_TAPS = 8;

/**
 * Kernel cache: one set of 8-tap Hann-windowed sinc phases per oversampling
 * factor. Coefficients are normalised to unity DC gain so the interpolator
 * never shifts programme level. Cubic interpolation under-reads near Nyquist
 * by over a decibel; a windowed sinc keeps the ceiling honest at 12–15 kHz.
 * 2× reads the sample pair, 4× adds the half, 8× resolves the shallowest
 * inter-sample crests that a low-bitrate encoder will reconstruct.
 */
const TRUE_PEAK_KERNELS = new Map<number, number[][]>();

function truePeakKernel(factor: number): number[][] {
  const f = factor === 2 || factor === 8 ? factor : 4;
  const cached = TRUE_PEAK_KERNELS.get(f);
  if (cached) return cached;
  const phases = Array.from({ length: f - 1 }, (_, i) => (i + 1) / f);
  const built = phases.map((phase) => {
    const coeffs: number[] = [];
    let sum = 0;
    for (let k = 0; k < TRUE_PEAK_TAPS; k++) {
      const x = k - 3 - phase;
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      const hann =
        0.5 - 0.5 * Math.cos((2 * Math.PI * (k + 0.5)) / TRUE_PEAK_TAPS);
      const v = sinc * hann;
      coeffs.push(v);
      sum += v;
    }
    return coeffs.map((v) => v / sum);
  });
  TRUE_PEAK_KERNELS.set(f, built);
  return built;
}

/** Quarter-phase kernel at 4× — exported for the transfer-curve docs/tests. */
export const TRUE_PEAK_PHASES: number[][] = truePeakKernel(4);

/**
 * Inter-sample peak in dBTP at 2×, 4× (default) or 8× oversampling.
 * Interpolates the *signed* waveform — four neighbouring samples per estimate
 * — because interpolating magnitudes invents peaks wherever the signal
 * crosses zero.
 */
export function truePeak(samples: Samples, factor = 4): number {
  const n = samples.length;
  if (n < 4) return peakDb(samples);
  const kernel = truePeakKernel(factor);
  let max = 0;
  // Every sample is interpolated: stepping by two silently misses crests that
  // fall on the skipped phase, which a steady tone does every period (a
  // 6 kHz tone reads 0.7 dB low with every other sample skipped).
  for (let i = 4; i < n - 4; i += 1) {
    const sample = Math.abs(samples[i]);
    if (sample > max) max = sample;
    for (const coeffs of kernel) {
      let acc = 0;
      for (let k = 0; k < TRUE_PEAK_TAPS; k++) {
        acc += samples[i - 3 + k] * coeffs[k];
      }
      const v = Math.abs(acc);
      if (v > max) max = v;
    }
  }
  return toDb(max);
}

/* ── loudness ──────────────────────────────────────────────────────────── */

/** BS.1770 loudness of a K-weighted power sum, floored at silence. */
export function loudnessOf(power: number): number {
  if (!(power > 1e-12)) return LOUDNESS_FLOOR;
  const l = -0.691 + 10 * Math.log10(power);
  return l < LOUDNESS_FLOOR ? LOUDNESS_FLOOR : l;
}

/**
 * Rolling power history for momentary (400 ms) and short-term (3 s)
 * loudness. Ticks arrive at whatever rate the meter loop runs; each entry is
 * one K-weighted power reading, and the window is the arithmetic mean of the
 * entries inside it — a time-weighted average because the ticks are evenly
 * spaced.
 */
export class LoudnessWindow {
  private points: { t: number; power: number }[] = [];
  /** Longest window that must be answerable from the history (ms). */
  private readonly spanMs: number;

  constructor(spanMs = 3200) {
    this.spanMs = Math.max(400, spanMs);
  }

  clear() {
    this.points = [];
  }

  get size() {
    return this.points.length;
  }

  push(t: number, power: number) {
    this.points.push({ t, power });
    // Keep the newest entry even if it is the only one: the span is a memory
    // bound, not a filter — power() already ignores points outside a window.
    while (this.points.length > 1 && t - this.points[0].t > this.spanMs) {
      this.points.shift();
    }
  }

  /** Mean power over the window ending now; 0 when nothing is inside it. */
  power(winMs: number, now: number): number {
    let acc = 0;
    let n = 0;
    for (const p of this.points) {
      if (now - p.t <= winMs) {
        acc += p.power;
        n++;
      }
    }
    return n > 0 ? acc / n : 0;
  }

  loudness(winMs: number, now: number): number {
    return loudnessOf(this.power(winMs, now));
  }
}

/**
 * BS.1770-4 gated integrated loudness from 400 ms block powers.
 *
 * Returns null until 20 s of programme has been measured — a shorter
 * "integrated" figure is noise, not a programme measurement.
 */
export function gatedIntegrated(
  blocks: readonly number[],
  measureMs: number,
): number | null {
  if (measureMs < 20_000 || blocks.length < 50) return null;
  const absolute: number[] = [];
  for (const b of blocks) {
    if (b > 1e-12 && -0.691 + 10 * Math.log10(b) >= -70) absolute.push(b);
  }
  if (absolute.length === 0) return null;
  let sum = 0;
  for (const b of absolute) sum += b;
  const relative = -0.691 + 10 * Math.log10(sum / absolute.length) - 10;
  let gsum = 0;
  let gn = 0;
  for (const b of absolute) {
    if (-0.691 + 10 * Math.log10(b) >= relative) {
      gsum += b;
      gn++;
    }
  }
  return gn === 0 ? null : -0.691 + 10 * Math.log10(gsum / gn);
}

/** EBU Tech 3342 loudness range (LU) from 3 s block powers. */
export function loudnessRange(blocks: readonly number[]): number | null {
  if (blocks.length < 30) return null;
  const powers: number[] = [];
  for (const b of blocks) {
    if (b > 1e-12 && loudnessOf(b) > LOUDNESS_FLOOR) powers.push(b);
  }
  if (powers.length < 20) return null;
  let sum = 0;
  for (const b of powers) sum += b;
  const relative = loudnessOf(sum / powers.length) - 20;
  const gated = powers.map(loudnessOf).filter((v) => v >= relative);
  if (gated.length < 10) return null;
  gated.sort((a, b) => a - b);
  const pct = (p: number) => {
    const idx = (gated.length - 1) * p;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    return gated[lo] + (gated[hi] - gated[lo]) * (idx - lo);
  };
  return Math.max(0, pct(0.95) - pct(0.1));
}
