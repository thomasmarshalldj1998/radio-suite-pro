import type {
  MultibandBands,
  ProcessorParams,
} from "@/lib/audio/params";

/**
 * TMA-style character face — five one-word promises that reshape the *live*
 * chain instead of replacing it. Each character takes the operator's current
 * params (their EQ, FM/RDS, station extras stay put) and rewrites only the
 * dynamics + density + imaging that define its sound, plus the Less–More
 * density slot. Gains are never touched: no volume jumps, ever.
 */

export type CharacterId =
  | "transparent"
  | "balanced"
  | "dense"
  | "competitive"
  | "lowLatency";

export interface CharacterDef {
  id: CharacterId;
  name: string;
  /** The one-word promise, v1.0 style. */
  promise: string;
  description: string;
  /** Less–More slot this character sits on (1 open … 10 packed). */
  density: number;
  apply: (base: ProcessorParams) => ProcessorParams;
}

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));
const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;

function scaleBands(
  base: ProcessorParams,
  ratioScale: number,
  attackScale: number,
  releaseScale: number,
  thresholdShiftDb: number,
  makeupShiftDb: number,
): MultibandBands {
  return base.multiband.bands.map((b) => ({
    thresholdDb: r1(clamp(b.thresholdDb + thresholdShiftDb, -40, 0)),
    ratio: r2(clamp(b.ratio * ratioScale, 1, 20)),
    attackMs: r1(clamp(b.attackMs * attackScale, 1, 200)),
    releaseMs: Math.round(clamp(b.releaseMs * releaseScale, 20, 2000)),
    makeupDb: r1(clamp(b.makeupDb + makeupShiftDb, 0, 12)),
  })) as MultibandBands;
}

export const CHARACTERS: CharacterDef[] = [
  {
    id: "transparent",
    name: "Transparent",
    promise: "Open",
    description:
      "Hands off the programme — slow levelling, gentle ratios, dynamics breathe.",
    density: 2,
    apply: (b) => ({
      ...b,
      density: 2,
      agc: {
        ...b.agc,
        on: true,
        ratio: 2,
        thresholdDb: r1(b.agc.thresholdDb + 3),
        kneeDb: 9,
        attackMs: 25,
        releaseMs: 600,
      },
      multiband: {
        ...b.multiband,
        bands: scaleBands(b, 0.6, 1.5, 1.4, 2, -0.5),
      },
      deess: { ...b.deess, maxCutDb: 3 },
      exciter: { ...b.exciter, on: false },
      stereo: { width: r2(clamp(Math.min(b.stereo.width, 1), 0, 2)) },
      limiter: { ...b.limiter, releaseMs: 150 },
    }),
  },
  {
    id: "balanced",
    name: "Balanced",
    promise: "Consistent",
    description:
      "Normal broadcast — controlled, open, honest. The reference middle.",
    density: 5,
    apply: (b) => ({
      ...b,
      density: 5,
      agc: {
        ...b.agc,
        on: true,
        ratio: 3,
        kneeDb: 6,
        attackMs: 15,
        releaseMs: 400,
      },
      multiband: {
        ...b.multiband,
        bands: scaleBands(b, 0.85, 1.15, 1.15, 1, 0),
      },
      deess: { ...b.deess, maxCutDb: 6 },
      limiter: { ...b.limiter, releaseMs: 100 },
    }),
  },
  {
    id: "dense",
    name: "Dense",
    promise: "Dense",
    description:
      "Packs the band energy tighter — louder average, still musical.",
    density: 7,
    apply: (b) => ({
      ...b,
      density: 7,
      agc: {
        ...b.agc,
        on: true,
        ratio: 4.5,
        kneeDb: 4,
        attackMs: 10,
        releaseMs: 280,
      },
      multiband: {
        ...b.multiband,
        bands: scaleBands(b, 1.1, 0.85, 0.9, -1, 0.5),
      },
      deess: { ...b.deess, maxCutDb: 7 },
      exciter: { ...b.exciter, on: true, mix: r1(b.exciter.mix || 2) },
      limiter: { ...b.limiter, releaseMs: 70 },
    }),
  },
  {
    id: "competitive",
    name: "Competitive",
    promise: "Loud",
    description:
      "Dial-competitive density — fast, forward, unapologetic. Mind the neighbours.",
    density: 9,
    apply: (b) => ({
      ...b,
      density: 9,
      agc: {
        ...b.agc,
        on: true,
        ratio: 6,
        kneeDb: 3,
        attackMs: 8,
        releaseMs: 200,
        makeupDb: r1(b.agc.makeupDb + 2),
      },
      multiband: {
        ...b.multiband,
        bands: scaleBands(b, 1.25, 0.7, 0.75, -2, 1),
      },
      deess: { ...b.deess, maxCutDb: 8 },
      exciter: { ...b.exciter, on: true, mix: r1(b.exciter.mix || 3.5) },
      stereo: { width: r2(clamp(b.stereo.width * 1.1, 0, 1.5)) },
      limiter: { ...b.limiter, releaseMs: 50 },
    }),
  },
  {
    id: "lowLatency",
    name: "Low Latency",
    promise: "Fast",
    description:
      "Short envelopes everywhere for talk and live — trades glue for speed.",
    density: 4,
    apply: (b) => ({
      ...b,
      density: 4,
      agc: {
        ...b.agc,
        on: true,
        ratio: 2.5,
        kneeDb: 6,
        attackMs: 5,
        releaseMs: 150,
      },
      multiband: {
        ...b.multiband,
        bands: scaleBands(b, 0.8, 0.5, 0.5, 1, 0),
      },
      deess: { ...b.deess, maxCutDb: 5 },
      limiter: { ...b.limiter, attackMs: 1, releaseMs: 40 },
    }),
  },
];

/** Reshape the live chain into a character. Caller coerces + applies. */
export function applyCharacter(
  base: ProcessorParams,
  id: CharacterId,
): ProcessorParams {
  const def = CHARACTERS.find((c) => c.id === id);
  if (!def) return base;
  return def.apply(base);
}
