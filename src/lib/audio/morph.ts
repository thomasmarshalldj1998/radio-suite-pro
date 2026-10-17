import type { ProcessorParams } from "@/lib/audio/params";

/**
 * PRESET MORPH — interpolate two chains, never crossfade audio.
 *
 * Numbers lerp (gains, thresholds, ratios, times, frequencies); booleans,
 * enums and text snap at the midpoint; arrays blend element-wise when they
 * line up, otherwise snap. The result always goes back through coerceParams
 * at the call site, so morphing can never produce an illegal chain, and
 * gain staging moves continuously — no jumps in gain, threshold, ratio,
 * clipping or limiting.
 */

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

function blend(a: unknown, b: unknown, t: number): unknown {
  if (typeof a === "number" && typeof b === "number") {
    if (!Number.isFinite(a)) return b;
    if (!Number.isFinite(b)) return a;
    return a + (b - a) * t;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return t < 0.5 ? a : b;
    return a.map((v, i) => blend(v, b[i], t));
  }
  if (isObj(a) && isObj(b)) {
    const out: Record<string, unknown> = {};
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (!(k in b)) out[k] = a[k];
      else if (!(k in a)) out[k] = b[k];
      else out[k] = blend(a[k], b[k], t);
    }
    return out;
  }
  return t < 0.5 ? a : b;
}

export function interpolateParams(
  a: ProcessorParams,
  b: ProcessorParams,
  t: number,
): ProcessorParams {
  const k = Math.min(1, Math.max(0, t));
  return blend(a, b, k) as ProcessorParams;
}

/* ── differences for the comparison readout ─────────────────────────── */

interface Diff {
  path: string;
  from: string;
  to: string;
}

const fmtVal = (path: string, v: unknown): string => {
  if (typeof v === "number") {
    const p = path.toLowerCase();
    const suffix = p.includes("freq") || p.includes("hz")
      ? " Hz"
      : p.includes("lufs")
        ? " LUFS"
        : p.includes("db")
          ? " dB"
          : p.includes("ms")
            ? " ms"
            : p.includes("ratio")
              ? ":1"
              : p.includes("width")
                ? "×"
                : "";
    const n = Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2);
    return `${n}${suffix}`;
  }
  if (typeof v === "boolean") return v ? "on" : "off";
  return String(v);
};

const LABELS: [RegExp, string][] = [
  [/^agc\.ratio$/, "AGC ratio"],
  [/^agc\.thresholdDb$/, "AGC threshold"],
  [/^agc\.releaseMs$/, "AGC release"],
  [/^agc\.attackMs$/, "AGC attack"],
  [/^multiband\.bands/, "Multiband"],
  [/^limiter\.releaseMs$/, "Limiter release"],
  [/^limiter\.ceilingDb$/, "Ceiling"],
  [/^limiter\.attackMs$/, "Limiter attack"],
  [/^density$/, "Density"],
  [/^stereo\.width$/, "Stereo width"],
  [/^stereo\.lowMonoHz$/, "Low-end mono"],
  [/^exciter\.mix$/, "Exciter mix"],
  [/^exciter\.on$/, "Exciter"],
  [/^deess\.maxCutDb$/, "De-esser"],
  [/^rider\.targetLufs$/, "Rider target"],
  [/^rider\.on$/, "Rider"],
  [/^gate\.thresholdDb$/, "Gate threshold"],
  [/^hpf\.freqHz$/, "HPF"],
  [/^outputGainDb$/, "Output trim"],
  [/^inputGainDb$/, "Input trim"],
];

function labelOf(path: string): string {
  for (const [re, label] of LABELS) if (re.test(path)) return label;
  const leaf = path.split(".").pop() ?? path;
  return leaf
    .replace(/Db$|Ms$|Hz$/, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase();
}

function walk(a: unknown, b: unknown, path: string, out: Diff[]): void {
  if (isObj(a) && isObj(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      walk(a[k], b[k], path ? `${path}.${k}` : k, out);
    }
    return;
  }
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
    a.forEach((v, i) => walk(v, b[i], `${path}[${i}]`, out));
    return;
  }
  const fa = fmtVal(path, a);
  const fb = fmtVal(path, b);
  if (fa !== fb && typeof a === typeof b) out.push({ path, from: fa, to: fb });
}

/** Top human-readable differences between two chains (text fields ignored). */
export function diffParams(
  a: ProcessorParams,
  b: ProcessorParams,
  limit = 6,
): Diff[] {
  const out: Diff[] = [];
  walk(a, b, "", out);
  const seen = new Set<string>();
  return out
    .filter((d) => {
      const l = labelOf(d.path);
      if (seen.has(l)) return false;
      seen.add(l);
      return true;
    })
    .slice(0, limit)
    .map((d) => ({ ...d, path: labelOf(d.path) }));
}
