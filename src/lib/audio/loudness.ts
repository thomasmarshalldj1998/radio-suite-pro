/**
 * Loudness compliance.
 *
 * One table of published targets, one resolver from the operator's chain to
 * the target in force, and the two calculations a station actually needs:
 * deviation from target and a pass/warn/fail verdict. Export is plain CSV so
 * the log can go straight into a spreadsheet or an OFCOM/EBU report without a
 * PDF renderer.
 */
import type { LoudnessStandardId, ProcessorParams } from "./params";

export interface LoudnessStandard {
  id: LoudnessStandardId;
  /** Full name for the picker and the report header. */
  label: string;
  short: string;
  /** Integrated loudness target (LUFS). */
  targetLufs: number;
  /** True-peak target (dBTP). */
  truePeakDb: number;
  region: string;
  note: string;
}

/**
 * Published targets. Streaming services normalise on playback, so their
 * figures are the delivery target rather than a legal limit; the broadcast
 * entries are the statutory ones.
 */
export const LOUDNESS_STANDARDS: readonly LoudnessStandard[] = [
  {
    id: "ebu",
    label: "EBU R128",
    short: "R128",
    targetLufs: -23,
    truePeakDb: -1,
    region: "UK / EU broadcast",
    note: "−23 LUFS integrated, −1 dBTP. The reference for European broadcast delivery.",
  },
  {
    id: "r128s1",
    label: "EBU R128 s1",
    short: "R128 s1",
    targetLufs: -16,
    truePeakDb: -1,
    region: "Short-form / online",
    note: "−16 LUFS for short-form and online broadcast — phone-first mixes stay intelligible.",
  },
  {
    id: "atsc",
    label: "ATSC A/85",
    short: "A/85",
    targetLufs: -24,
    truePeakDb: -2,
    region: "US broadcast",
    note: "−24 LKFS, −2 dBTP. The CALM Act target for US television delivery.",
  },
  {
    id: "spotify",
    label: "Spotify / streaming",
    short: "Spotify",
    targetLufs: -14,
    truePeakDb: -1,
    region: "Streaming",
    note: "−14 LUFS. The service normalises playback, so louder masters only lose dynamics.",
  },
  {
    id: "apple",
    label: "Apple Music",
    short: "Apple",
    targetLufs: -16,
    truePeakDb: -1,
    region: "Streaming",
    note: "−16 LUFS. Apple normalises on playback and asks for true-peak-safe masters.",
  },
  {
    id: "custom",
    label: "Custom",
    short: "Custom",
    targetLufs: -14,
    truePeakDb: -1,
    region: "House standard",
    note: "Your own target, −30…−10 LUFS, with its own true-peak ceiling.",
  },
] as const;

export function loudnessStandard(id: LoudnessStandardId): LoudnessStandard {
  return LOUDNESS_STANDARDS.find((s) => s.id === id) ?? LOUDNESS_STANDARDS[0];
}

export interface ComplianceTarget {
  id: LoudnessStandardId;
  label: string;
  /** Integrated loudness target in force (LUFS). */
  lufs: number;
  /** True-peak ceiling in force (dBTP). */
  truePeakDb: number;
}

/**
 * Resolve the target the console should measure against. `custom` reads the
 * operator's own numbers (clamped to a sane −30…−10 LUFS / −6…0 dBTP window);
 * every other standard is fixed by its publication.
 */
export function complianceTarget(params: ProcessorParams): ComplianceTarget {
  const std = loudnessStandard(params.loudness.standard);
  if (std.id !== "custom") {
    return { id: std.id, label: std.label, lufs: std.targetLufs, truePeakDb: std.truePeakDb };
  }
  const raw = Number(params.loudness.customLufs);
  const lufs = Math.min(-10, Math.max(-30, Number.isFinite(raw) ? raw : -14));
  const tpRaw = Number(params.loudness.customTpDb);
  const truePeakDb = Math.min(0, Math.max(-6, Number.isFinite(tpRaw) ? tpRaw : -1));
  return { id: "custom", label: "Custom", lufs, truePeakDb };
}

/** Measured minus target in LU; null while the integrated meter is still filling. */
export function loudnessDeviation(
  measured: number | null,
  target: number,
): number | null {
  if (measured === null || !Number.isFinite(measured)) return null;
  return Math.round((measured - target) * 10) / 10;
}

export type ComplianceState = "measuring" | "pass" | "warn" | "fail";

/**
 * Compliance verdict.
 *
 * `measuring` until the gated integrated figure exists (20 s of programme) —
 * a verdict on half a minute of silence would be a lie. Loudness outside
 * ±`toleranceLu` is a warning, outside twice that a failure; a true-peak
 * overshoot is always a failure, because it is the one error that survives
 * the encoder.
 */
export function complianceState(
  lufsI: number | null,
  truePeak: number,
  target: ComplianceTarget,
  toleranceLu = 2,
): ComplianceState {
  if (lufsI === null) return "measuring";
  if (Number.isFinite(truePeak) && truePeak > target.truePeakDb + 0.1) return "fail";
  const deviation = Math.abs(lufsI - target.lufs);
  if (deviation <= toleranceLu) return "pass";
  if (deviation <= toleranceLu * 2) return "warn";
  return "fail";
}

export interface LoudnessLogRow {
  /** Epoch ms of the reading. */
  at: number;
  momentary: number;
  shortTerm: number;
  integrated: number | null;
  lra: number | null;
  truePeak: number;
}

export interface LoudnessLogMeta {
  station: string;
  preset: string;
  standard: ComplianceTarget;
}

const csvCell = (v: string | number | null): string => {
  if (v === null) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
};

/**
 * CSV report: a comment preamble the operator can read in any editor, then a
 * header row and one row per reading. Timestamps are absolute UTC so the file
 * is unambiguous across shifts and time zones.
 */
export function loudnessCsv(
  rows: readonly LoudnessLogRow[],
  meta: LoudnessLogMeta,
): string {
  const lines: string[] = [
    `# Signalpath loudness log`,
    `# station: ${meta.station}`,
    `# preset: ${meta.preset}`,
    `# standard: ${meta.standard.label}`,
    `# target: ${meta.standard.lufs} LUFS / ${meta.standard.truePeakDb} dBTP`,
    `# export: ${new Date().toISOString()}`,
    `# readings: ${rows.length}`,
    "",
    "timestamp_utc,integrated_lufs,short_term_lufs,momentary_lufs,lra_lu,true_peak_dbtp,deviation_lu",
  ];
  for (const row of rows) {
    const at = new Date(row.at);
    const deviation = loudnessDeviation(row.integrated, meta.standard.lufs);
    lines.push(
      [
        csvCell(at.toISOString()),
        csvCell(row.integrated),
        csvCell(round1(row.shortTerm)),
        csvCell(round1(row.momentary)),
        csvCell(row.lra === null ? null : round1(row.lra)),
        csvCell(round1(row.truePeak)),
        csvCell(deviation),
      ].join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}

const round1 = (v: number) => Math.round(v * 10) / 10;
