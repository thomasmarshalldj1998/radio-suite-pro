/**
 * Transparency guards for the program chain.
 *
 * Three small pieces of maths the engine needs in order to sound like the
 * programme rather than the processing:
 *
 *  1  `safeFilterHz` — a biquad's corner is only well conditioned well below
 *     Nyquist. A 22 kHz low-pass is comfortable in a 48 kHz context
 *     (0.92 · Nyquist) and degenerate in a 44.1 kHz one (0.998 · Nyquist),
 *     where `tan(πf/fs)` explodes, the poles land on the unit circle and the
 *     section rings or produces NaN. The chain keeps its 22 kHz settings —
 *     they are only folded down when the context cannot represent them.
 *
 *  2  `softCeilingCurve` — a safety clamp that is *linear* until the last
 *     couple of dB under the ceiling, then bends smoothly into it. A tanh
 *     transfer across the whole range is a compressor: it adds third harmonic
 *     at every level and costs nearly a decibel by −6 dBFS.
 *
 *  3  `identityCurve` — a WaveShaper that passes its input untouched but
 *     still pays the oversampler's latency. It is used on the dry leg of
 *     parallel waveshaping stages, so wet and dry arrive at the same time and
 *     a blend cannot comb.
 *
 * All three are pure and unit-tested by `scripts/verify-quality.ts`.
 */

/** Below this fraction of Nyquist every biquad is numerically comfortable. */
const COMFORT_NYQUIST = 0.9;
/** Above this fraction the corner is folded back to COMFORT_NYQUIST. */
const UNSTABLE_NYQUIST = 0.96;

/**
 * Clamp a filter corner to a frequency the context can represent.
 *
 * Values that are already safe are returned bit-identically, so the console's
 * 22 kHz defaults are preserved on a 48 kHz device and only corrected where
 * they would otherwise sit on Nyquist (44.1 kHz).
 */
export function safeFilterHz(hz: number, sampleRate: number): number {
  const fs =
    Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 48000;
  const nyquist = fs / 2;
  const v = Number.isFinite(hz) ? hz : 20;
  const mag = Math.abs(v);
  if (mag <= UNSTABLE_NYQUIST * nyquist) return v;
  return (v < 0 ? -1 : 1) * COMFORT_NYQUIST * nyquist;
}

/**
 * Soft ceiling transfer, symmetric about zero.
 *
 * |x| ≤ knee is passed through exactly — unity gain, no added harmonic. Above
 * the knee the transfer `knee + (c − knee)·tanh((|x| − knee)/(c − knee))`
 * matches the slope at the join, is monotonic, and asymptotes at the ceiling.
 * The curve's top end is therefore the highest output the shaper can produce,
 * so a signal driven past full scale is held at (just under) the ceiling
 * instead of folding back.
 */
export function softCeilingCurve(
  ceilingDb: number,
  size = 8193,
): Float32Array<ArrayBuffer> {
  const points = Math.max(65, Math.round(size));
  const ceiling = Math.min(
    0.999,
    Math.max(0.05, Math.pow(10, ceilingDb / 20)),
  );
  // 0.9 × the ceiling: −1.9 dBFS at the usual −1 dBFS setting, which keeps
  // the guard clear of normal programme and still catches the last few dB.
  const knee = ceiling * 0.9;
  const span = ceiling - knee;
  const curve = new Float32Array(points);
  for (let i = 0; i < points; i++) {
    const x = -1 + (2 * i) / (points - 1);
    const u = Math.abs(x);
    const y =
      u <= knee ? u : knee + span * Math.tanh((u - knee) / span);
    curve[i] = x < 0 ? -y : y;
  }
  return curve;
}

/** Unity transfer over [−1, 1] — a pass-through that keeps shaper latency. */
export function identityCurve(size = 8193): Float32Array<ArrayBuffer> {
  const points = Math.max(65, Math.round(size));
  const curve = new Float32Array(points);
  for (let i = 0; i < points; i++) {
    curve[i] = -1 + (2 * i) / (points - 1);
  }
  return curve;
}
