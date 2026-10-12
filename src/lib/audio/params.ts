/**
 * Processor parameter model for the Signalpath broadcast chain:
 *
 *   input gain → HPF →6-band EQ → 3-band multiband compressor →
 *   program AGC → brickwall limiter → output gain → (monitor + encoder send)
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

export interface ProcessorParams {
  inputGainDb: number;
  hpf: { on: boolean; freqHz: number };
  eq: { on: boolean; bands: EqBand[] };
  multiband: {
    on: boolean;
    xoverLowHz: number;
    xoverHighHz: number;
    bands: [BandCompParams, BandCompParams, BandCompParams];
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
  outputGainDb: number;
  monitorDb: number;
  duckDb: number;
}

export const EQ_FREQS = [60, 200, 700, 2500, 6000, 12000] as const;
export const BAND_LABELS = ["Low", "Mid", "High"] as const;
export const LUFS_TARGET = -23;

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
  multiband: {
    on: true,
    xoverLowHz: 120,
    xoverHighHz: 5500,
    bands: [
      { thresholdDb: -12, ratio: 4, attackMs: 10, releaseMs: 250, makeupDb: 2 },
      { thresholdDb: -14, ratio: 3, attackMs: 5, releaseMs: 200, makeupDb: 1.5 },
      { thresholdDb: -16, ratio: 3, attackMs: 2, releaseMs: 150, makeupDb: 1.5 },
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
  outputGainDb: 0,
  monitorDb: -6,
  duckDb: 12,
};

export interface BuiltinPreset {
  id: string;
  name: string;
  description: string;
  tags: string[];
  params: ProcessorParams;
}

const merge = (patch: Partial<ProcessorParams>): ProcessorParams =>
  coerceParams({ ...structuredClone(DEFAULT_PARAMS), ...patch });

/** Built-in broadcast presets — full parameter snapshots of the chain. */
export const BUILTIN_PRESETS: BuiltinPreset[] = [
  {
    id: "broadcast-fm",
    name: "Broadcast Standard FM",
    description:
      "Balanced on-air chain: gentle levelling, musical 3-band dynamics, −1 dBTP ceiling.",
    tags: ["General", "Stereo", "−23 LUFS"],
    params: structuredClone(DEFAULT_PARAMS),
  },
  {
    id: "talk-radio",
    name: "Talk Radio Voice",
    description:
      "Fast program levelling with presence lift and de-esser band for speech-heavy formats.",
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
      multiband: {
        on: true,
        xoverLowHz: 150,
        xoverHighHz: 5000,
        bands: [
          { thresholdDb: -14, ratio: 4, attackMs: 8, releaseMs: 200, makeupDb: 2 },
          { thresholdDb: -16, ratio: 4, attackMs: 3, releaseMs: 150, makeupDb: 2.5 },
          { thresholdDb: -18, ratio: 5, attackMs: 1.5, releaseMs: 120, makeupDb: 2 },
        ],
      },
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
      "Slow, transparent dynamics with a warm shelf — built for overnight music rotation.",
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
      multiband: {
        on: true,
        xoverLowHz: 110,
        xoverHighHz: 6000,
        bands: [
          { thresholdDb: -14, ratio: 2.5, attackMs: 20, releaseMs: 500, makeupDb: 1.5 },
          { thresholdDb: -16, ratio: 2, attackMs: 15, releaseMs: 450, makeupDb: 1 },
          { thresholdDb: -18, ratio: 2.5, attackMs: 8, releaseMs: 400, makeupDb: 1 },
        ],
      },
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
      "Dense, competitive Top-40 chain — hard multiband, deep AGC, loud but legal ceiling.",
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
      multiband: {
        on: true,
        xoverLowHz: 130,
        xoverHighHz: 5200,
        bands: [
          { thresholdDb: -18, ratio: 6, attackMs: 5, releaseMs: 180, makeupDb: 4 },
          { thresholdDb: -20, ratio: 5, attackMs: 3, releaseMs: 150, makeupDb: 4 },
          { thresholdDb: -20, ratio: 4, attackMs: 1.5, releaseMs: 120, makeupDb: 3 },
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
      limiter: { on: true, ceilingDb: -0.8, attackMs: 0.8, releaseMs: 60 },
      outputGainDb: 0,
    }),
  },
  {
    id: "sports",
    name: "Sports Play-by-Play",
    description:
      "Cuts crowd rumble, lifts commentary intelligibility, survives crowd-surge peaks.",
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
      multiband: {
        on: true,
        xoverLowHz: 140,
        xoverHighHz: 4800,
        bands: [
          { thresholdDb: -16, ratio: 6, attackMs: 3, releaseMs: 120, makeupDb: 3 },
          { thresholdDb: -16, ratio: 4, attackMs: 2, releaseMs: 120, makeupDb: 3 },
          { thresholdDb: -18, ratio: 4, attackMs: 1.2, releaseMs: 100, makeupDb: 2 },
        ],
      },
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
      "Clean voice master targeting −16 LUFS with soft limiting for platforms and web.",
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
      multiband: {
        on: true,
        xoverLowHz: 120,
        xoverHighHz: 5000,
        bands: [
          { thresholdDb: -14, ratio: 3, attackMs: 8, releaseMs: 250, makeupDb: 2 },
          { thresholdDb: -16, ratio: 3, attackMs: 4, releaseMs: 200, makeupDb: 2 },
          { thresholdDb: -18, ratio: 4, attackMs: 2, releaseMs: 150, makeupDb: 1.5 },
        ],
      },
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

/** Format dB with a typographic minus, e.g. "−3.5 dB". */
export function formatDb(db: number, digits = 1): string {
  const v = Math.abs(db) < Math.pow(10, -digits) / 2 ? 0 : db;
  return `${v.toFixed(digits).replace("-", "−")} dB`;
}

/** Format Hz for humans: "80 Hz" / "5.5 kHz". */
export function formatHz(hz: number): string {
  return hz >= 1000 ? `${(hz / 1000).toFixed(hz >= 10000 ? 1 : 1)} kHz` : `${Math.round(hz)} Hz`;
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
 * old presets always load safely.
 */
export function coerceParams(saved: unknown): ProcessorParams {
  const base = structuredClone(DEFAULT_PARAMS);
  if (!saved || typeof saved !== "object") return base;
  return mergeDeep(base, saved);
}
