/**
 * Offline batch processing.
 *
 * Files are decoded, brought to 48 kHz (the K-weighting coefficients and the
 * limiter kernel are specified there), loudness-normalised to the chosen
 * delivery target, brickwall-limited at the target's true-peak ceiling and
 * written as 16-bit WAV — the same lookahead kernel the live worklet runs, so
 * a batch delivery and a live stream meet the same ceiling.
 *
 * The pipeline is plain maths over sample arrays; only `decodeTo48k` and
 * `processBatchFile` touch browser audio APIs. That keeps the normaliser and
 * the WAV writer verifiable in Bun with no AudioContext.
 */
import { LOUDNESS_FLOOR, loudnessOf, peakDb, truePeak } from "./measure";
import { LookaheadLimiter } from "./limiter";

/** BS.1770 K-weighting, 48 kHz (the rate the batch converter works at). */
const K_SHELF = {
  b0: 1.53512485958697,
  b1: -2.69169618940638,
  b2: 1.19839281085285,
  a1: -1.69065929318241,
  a2: 0.73248077421585,
};

const K_HIGHPASS = {
  b0: 1.0,
  b1: -2.0,
  b2: 1.0,
  a1: -1.99004745483398,
  a2: 0.99007225036621,
};

export const BATCH_SAMPLE_RATE = 48_000;
const BLOCK = BATCH_SAMPLE_RATE * 0.4; // 400 ms gating blocks

interface BiquadState {
  x1: number;
  x2: number;
  y1: number;
  y2: number;
}

const state = (): BiquadState => ({ x1: 0, x2: 0, y1: 0, y2: 0 });

/** One direct-form-I biquad pass over a block, mutating `state`. */
function biquad(
  input: Float32Array,
  output: Float32Array,
  count: number,
  c: { b0: number; b1: number; b2: number; a1: number; a2: number },
  s: BiquadState,
): void {
  for (let i = 0; i < count; i++) {
    const x = input[i];
    const y = c.b0 * x + c.b1 * s.x1 + c.b2 * s.x2 - c.a1 * s.y1 - c.a2 * s.y2;
    s.x2 = s.x1;
    s.x1 = x;
    s.y2 = s.y1;
    s.y1 = y;
    output[i] = y;
  }
}

/**
 * BS.1770-4 gated integrated loudness at 48 kHz.
 *
 * The K-weighting runs block by block with persistent filter state, so a long
 * programme costs one 400 ms scratch buffer rather than a second copy of the
 * file. Blocks are non-overlapping; the absolute (−70 LUFS) and relative
 * (−10 LU) gates then follow the standard.
 */
export function integratedLoudness48k(
  l: Float32Array,
  r: Float32Array,
): number {
  const n = Math.min(l.length, r.length);
  if (n === 0) return LOUDNESS_FLOOR;
  const scratch = new Float32Array(BLOCK);
  const shelved = new Float32Array(BLOCK);
  const sl = state();
  const sr = state();
  const hl = state();
  const hr = state();
  const powers: number[] = [];
  for (let start = 0; start < n; start += BLOCK) {
    const count = Math.min(BLOCK, n - start);
    const blockL = l.subarray(start, start + count);
    const blockR = r.subarray(start, start + count);
    biquad(blockL, scratch, count, K_SHELF, sl);
    biquad(scratch, shelved, count, K_HIGHPASS, hl);
    const left = squared(shelved, count);
    biquad(blockR, scratch, count, K_SHELF, sr);
    biquad(scratch, shelved, count, K_HIGHPASS, hr);
    const right = squared(shelved, count);
    powers.push((left + right) / count);
  }
  if (powers.length === 0) return LOUDNESS_FLOOR;
  const gated = powers.filter(
    (p) => p > 1e-12 && loudnessOf(p) >= LOUDNESS_FLOOR,
  );
  if (gated.length === 0) return LOUDNESS_FLOOR;
  const mean = gated.reduce((a, b) => a + b, 0) / gated.length;
  const relative = loudnessOf(mean) - 10;
  const kept = gated.filter((p) => loudnessOf(p) >= relative);
  if (kept.length === 0) return LOUDNESS_FLOOR;
  return loudnessOf(kept.reduce((a, b) => a + b, 0) / kept.length);
}

function squared(samples: Float32Array, count: number): number {
  let sum = 0;
  for (let i = 0; i < count; i++) sum += samples[i] * samples[i];
  return sum;
}

export interface BatchSettings {
  /** Integrated loudness target (LUFS). */
  targetLufs: number;
  /** True-peak ceiling (dBTP). */
  ceilingDb: number;
  /** Limiter release (ms). */
  releaseMs?: number;
  /** Limiter lookahead (ms). */
  lookaheadMs?: number;
}

export interface BatchMetrics {
  lufsIn: number;
  lufsOut: number;
  truePeakIn: number;
  truePeakOut: number;
  peakOut: number;
  /** Total make-up gain applied before limiting (dB). */
  gainDb: number;
  /** Largest limiter gain reduction in the file (dB). */
  grMaxDb: number;
  /** Limiter passes used by the correction loop (1 or 2). */
  passes: number;
  /** True when the input was too quiet to measure (silence). */
  silent: boolean;
}

export interface NormalizedAudio {
  l: Float32Array;
  r: Float32Array;
  metrics: BatchMetrics;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Bring a 48 kHz stereo pair to target loudness under a true-peak ceiling.
 *
 * Pass 1 applies the measured gain and limits. A second pass corrects for the
 * level the limiter removed and for inter-sample peaks the sample-peak limit
 * did not see; two passes are enough in practice and bound the work per file.
 */
export function normalizeSamples(
  l: Float32Array,
  r: Float32Array,
  settings: BatchSettings,
): NormalizedAudio {
  const n = Math.min(l.length, r.length);
  const target = clamp(
    Number.isFinite(settings.targetLufs) ? settings.targetLufs : -14,
    -30,
    -10,
  );
  let ceiling = clamp(
    Number.isFinite(settings.ceilingDb) ? settings.ceilingDb : -1,
    -6,
    0,
  );
  const lufsIn = integratedLoudness48k(l, r);
  const silent = lufsIn <= LOUDNESS_FLOOR + 0.1;
  const truePeakIn = Math.max(truePeak(l), truePeak(r));

  let gainDb = silent ? 0 : clamp(target - lufsIn, -24, 24);
  const outL = new Float32Array(n);
  const outR = new Float32Array(n);
  let lufsOut = lufsIn;
  let truePeakOut = truePeakIn;
  let grMaxDb = 0;
  let passes = 0;

  for (let pass = 0; pass < 2; pass++) {
    passes += 1;
    const gain = Math.pow(10, gainDb / 20);
    for (let i = 0; i < n; i++) {
      outL[i] = l[i] * gain;
      outR[i] = r[i] * gain;
    }
    const limiter = new LookaheadLimiter(BATCH_SAMPLE_RATE);
    limiter.configure(
      ceiling,
      settings.releaseMs ?? 150,
      0,
      settings.lookaheadMs ?? 5,
    );
    grMaxDb = 0;
    for (let start = 0; start < n; start += 128) {
      const count = Math.min(128, n - start);
      const blockL = outL.subarray(start, start + count);
      const blockR = outR.subarray(start, start + count);
      const gr = limiter.process(blockL, blockR, blockL, blockR);
      if (gr > grMaxDb) grMaxDb = gr;
    }
    lufsOut = integratedLoudness48k(outL, outR);
    truePeakOut = Math.max(truePeak(outL), truePeak(outR));
    const loudEnough = silent || lufsOut >= target - 0.2;
    const peakSafe = truePeakOut <= ceiling + 0.05;
    if (loudEnough && peakSafe) break;
    if (!peakSafe) ceiling = clamp(ceiling - (truePeakOut - ceiling + 0.2), -24, 0);
    if (!loudEnough) gainDb = clamp(gainDb + (target - lufsOut), -24, 24);
  }

  return {
    l: outL,
    r: outR,
    metrics: {
      lufsIn,
      lufsOut,
      truePeakIn,
      truePeakOut,
      peakOut: Math.max(peakDb(outL), peakDb(outR)),
      gainDb,
      grMaxDb,
      passes,
      silent,
    },
  };
}

/** 16-bit PCM WAV (RIFF, interleaved stereo). */
export function wavBytes(
  l: Float32Array,
  r: Float32Array,
  sampleRate = BATCH_SAMPLE_RATE,
): Uint8Array {
  const frames = Math.min(l.length, r.length);
  const dataBytes = frames * 4;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 2, true); // stereo
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 4, true); // byte rate
  view.setUint16(32, 4, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);
  let offset = 44;
  for (let i = 0; i < frames; i++) {
    view.setInt16(offset, toPcm(l[i]), true);
    view.setInt16(offset + 2, toPcm(r[i]), true);
    offset += 4;
  }
  return new Uint8Array(buffer);
}

function toPcm(v: number): number {
  const x = Number.isFinite(v) ? clamp(v, -1, 1) : 0;
  return x < 0 ? Math.round(x * 32768) : Math.round(x * 32767);
}

export interface BatchFileResult {
  name: string;
  wav: Uint8Array;
  metrics: BatchMetrics;
  durationMs: number;
}

/** Decode any browser-supported file and hand back 48 kHz stereo samples. */
export async function decodeTo48k(
  file: File,
): Promise<{ l: Float32Array; r: Float32Array; durationMs: number }> {
  const bytes = await file.arrayBuffer();
  const decoder = new OfflineAudioContext(2, 1, BATCH_SAMPLE_RATE);
  const decoded = await decoder.decodeAudioData(bytes);
  let buffer = decoded;
  if (decoded.sampleRate !== BATCH_SAMPLE_RATE) {
    const frames = Math.max(1, Math.ceil(decoded.duration * BATCH_SAMPLE_RATE));
    const resampler = new OfflineAudioContext(2, frames, BATCH_SAMPLE_RATE);
    const source = resampler.createBufferSource();
    source.buffer = decoded;
    source.connect(resampler.destination);
    source.start();
    buffer = await resampler.startRendering();
  }
  const l = new Float32Array(buffer.getChannelData(0));
  const r =
    buffer.numberOfChannels > 1
      ? new Float32Array(buffer.getChannelData(1))
      : new Float32Array(l);
  return { l, r, durationMs: Math.round(buffer.duration * 1000) };
}

/** Decode → normalise → limit → WAV for one file. */
export async function processBatchFile(
  file: File,
  settings: BatchSettings,
): Promise<BatchFileResult> {
  const { l, r, durationMs } = await decodeTo48k(file);
  const normalized = normalizeSamples(l, r, settings);
  const wav = wavBytes(normalized.l, normalized.r);
  return {
    name: outputName(file.name),
    wav,
    metrics: normalized.metrics,
    durationMs,
  };
}

/** `mix.mp3` → `mix.normalized.wav`. */
export function outputName(input: string): string {
  const base = input.replace(/\.[^./\\]+$/, "") || "take";
  return `${base}.normalized.wav`;
}
