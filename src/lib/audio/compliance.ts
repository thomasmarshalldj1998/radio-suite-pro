/**
 * Loudness & multiplex-power compliance.
 *
 * Two normative measurements are tracked for the station's records:
 *
 * **Programme loudness — ITU-R BS.1770 / EBU R128.** The engine already runs
 * the gated integrated (BS.1770-4) and short-term measures plus EBU Tech 3342
 * loudness range; this module accumulates the session figures, the worst
 * excursion from the target and the true-peak maximum, and turns them into a
 * printable record.
 *
 * **Multiplex power — ITU-R BS.412-9 clause 2.5.1.** The clause requires that
 * "the power of the complete multiplex signal (including pilot-tone and
 * additional signals) integrated over any interval of 60 s is not higher than
 * the power of a multiplex signal containing a single sinusoidal tone which
 * causes a peak deviation of ±19 kHz". Written as an integral, with Δf the
 * instantaneous frequency deviation and T = 60 s:
 *
 *     P_dBr = 10·log10[ (2/T) · ∫ (Δf(t) / 19000)² dt ]
 *
 * The 2 makes a ±19 kHz-peak sine read exactly 0 dBr (its mean square is
 * 19000²/2). This generator normalises the composite so ±1.0 = ±75 kHz, so
 * Δf = 75000·c and the expression collapses to
 *
 *     P_dBr = 10·log10[ 2 · (75/19)² · mean(c²) ]
 *
 * which is exactly what `mpxPowerDbr` below computes. A full-scale sine reads
 * +11.93 dBr, i.e. hearing 0 dBr means the chain is 11.9 dB below that — the
 * limit ("not higher than" the reference) is 0 dBr.
 *
 * Sources: ITU-R BS.412-9 (https://www.itu.int/rec/R-REC-BS.412-9-199812-I/en)
 * and the Orban multiplex-power controller patent, which reproduces the clause
 * verbatim (https://patents.google.com/patent/EP1428337A2/en). Jurisdictions
 * that permit a looser limit may set `mpxLimitDbr` above 0 (Stereo Tool notes
 * some countries use +3 dB) — the default here is the BS.412 limit.
 */

/** Peak deviation of the BS.412 reference tone (Hz). */
export const MPX_REFERENCE_DEVIATION_HZ = 19_000;
/** Composite full scale: ±1.0 in the generator = ±75 kHz deviation. */
export const MPX_FULL_SCALE_DEVIATION_HZ = 75_000;
/** The BS.412-9 limit itself, in dBr. */
export const MPX_LIMIT_DBR = 0;
/** Averaging interval required by the clause (s). */
export const MPX_WINDOW_SECONDS = 60;

/**
 * Multiplex-power level from the mean square of the composite signal.
 * `meanSquare` is the average of c² over the 60 s window, with ±1.0 = ±75 kHz.
 * Returns dBr (0 dBr = the BS.412 reference). Silence returns −120.
 */
export function mpxPowerDbr(meanSquare: number): number {
  if (!Number.isFinite(meanSquare) || meanSquare <= 0) return -120;
  const k =
    2 *
    (MPX_FULL_SCALE_DEVIATION_HZ / MPX_REFERENCE_DEVIATION_HZ) ** 2 *
    meanSquare;
  const dbr = 10 * Math.log10(k);
  return dbr < -120 ? -120 : dbr;
}

export interface ComplianceTargets {
  /** Programme loudness target (LUFS, ITU-R BS.1770-4). */
  lufsTarget: number;
  /** Allowed deviation either side of the target (LU). */
  lufsTolerance: number;
  /** True-peak ceiling (dBTP). */
  truePeakCeilingDb: number;
  /** Multiplex-power limit (dBr) — 0 unless local rules allow more. */
  mpxLimitDbr: number;
}

export const DEFAULT_TARGETS: ComplianceTargets = {
  lufsTarget: -14,
  lufsTolerance: 1,
  truePeakCeilingDb: -1,
  mpxLimitDbr: MPX_LIMIT_DBR,
};

export interface ComplianceState {
  targets: ComplianceTargets;
  startedAt: number;
  /** ms of powered measurement time accumulated by the engine. */
  measureMs: number;
  /** Latest windows. */
  lufsM: number;
  lufsS: number;
  lufsI: number | null;
  lra: number | null;
  /** Session maxima. */
  maxTruePeakDb: number;
  maxSamplePeakDb: number;
  /** Worst deviation from the loudness target seen in the short-term window. */
  worstLufsDeviation: number;
  /** Gated blocks outside the target window (share of the measurement, %). */
  outOfToleranceMs: number;
  /** Current + worst BS.412 multiplex power. */
  mpxPowerDbr: number;
  mpxWorstDbr: number;
  mpxWindowSeconds: number;
  /** Time spent above the multiplex-power limit (ms, this session). */
  mpxOverLimitMs: number;
  /** True when the FM branch is producing a composite to measure. */
  mpxActive: boolean;
  /** Internal: timestamp of the previous multiplex-power sample. */
  mpxLastAt: number;
}

export interface Criterion {
  label: string;
  value: string;
  limit: string;
  pass: boolean | null;
  detail?: string;
}

export interface ComplianceReport {
  generatedAt: number;
  sessionStartedAt: number;
  durationMs: number;
  targets: ComplianceTargets;
  criteria: Criterion[];
  pass: boolean;
  note: string;
}

const state: ComplianceState = {
  targets: { ...DEFAULT_TARGETS },
  startedAt: 0,
  measureMs: 0,
  lufsM: -70,
  lufsS: -70,
  lufsI: null,
  lra: null,
  maxTruePeakDb: -120,
  maxSamplePeakDb: -120,
  worstLufsDeviation: 0,
  outOfToleranceMs: 0,
  mpxPowerDbr: -120,
  mpxWorstDbr: -120,
  mpxWindowSeconds: 0,
  mpxOverLimitMs: 0,
  mpxActive: false,
  mpxLastAt: 0,
};

const listeners = new Set<() => void>();

/**
 * Published immutable snapshot — `useSyncExternalStore` compares by identity,
 * so the readers must see a new object whenever anything changes. The working
 * `state` object itself is mutated in place for speed.
 */
let snapshot: ComplianceState = { ...state };

function emit() {
  snapshot = { ...state };
  for (const cb of listeners) cb();
}

export function getCompliance(): ComplianceState {
  return snapshot;
}

export function subscribeCompliance(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Session reset — targets and the FM window survive. */
export function resetCompliance(now = Date.now()) {
  state.startedAt = now;
  state.measureMs = 0;
  state.maxTruePeakDb = -120;
  state.maxSamplePeakDb = -120;
  state.worstLufsDeviation = 0;
  state.outOfToleranceMs = 0;
  state.mpxWorstDbr = -120;
  state.mpxOverLimitMs = 0;
  emit();
}

export function setComplianceTargets(patch: Partial<ComplianceTargets>) {
  const next = { ...state.targets, ...patch };
  state.targets = {
    lufsTarget: Number.isFinite(next.lufsTarget) ? next.lufsTarget : DEFAULT_TARGETS.lufsTarget,
    lufsTolerance: Number.isFinite(next.lufsTolerance)
      ? Math.max(0.1, next.lufsTolerance)
      : DEFAULT_TARGETS.lufsTolerance,
    truePeakCeilingDb: Number.isFinite(next.truePeakCeilingDb)
      ? next.truePeakCeilingDb
      : DEFAULT_TARGETS.truePeakCeilingDb,
    mpxLimitDbr: Number.isFinite(next.mpxLimitDbr)
      ? next.mpxLimitDbr
      : DEFAULT_TARGETS.mpxLimitDbr,
  };
  emit();
}

/** Aggregated loudness/peak sample — call from the console metering tick. */
export interface LoudnessSample {
  powered: boolean;
  lufsM: number;
  lufsS: number;
  lufsI: number | null;
  lra: number | null;
  truePeak: number;
  samplePeakDb: number;
  measureMs: number;
}

let lastSampleAt = 0;

export function sampleLoudness(
  sample: LoudnessSample & { targets?: Partial<ComplianceTargets> },
  now = Date.now(),
): void {
  if (sample.targets) setComplianceTargets(sample.targets);
  if (!sample.powered) {
    lastSampleAt = 0;
    return;
  }
  if (state.startedAt === 0) state.startedAt = now;

  const dt = lastSampleAt === 0 ? 0 : Math.min(Math.max(0, now - lastSampleAt), 5000);
  lastSampleAt = now;

  state.lufsM = sample.lufsM;
  state.lufsS = sample.lufsS;
  state.lufsI = sample.lufsI;
  state.lra = sample.lra;
  state.measureMs = sample.measureMs;
  if (sample.truePeak > state.maxTruePeakDb) state.maxTruePeakDb = sample.truePeak;
  if (sample.samplePeakDb > state.maxSamplePeakDb)
    state.maxSamplePeakDb = sample.samplePeakDb;

  // Only judge excursions while there is real programme: a silent bus (or the
  // silence gate holding the output down) is not a loudness failure.
  const hasProgramme = sample.lufsS > -60 && sample.lufsM > -70;
  if (hasProgramme) {
    const deviation = Math.abs(sample.lufsS - state.targets.lufsTarget);
    if (deviation > state.worstLufsDeviation)
      state.worstLufsDeviation = deviation;
    if (deviation > state.targets.lufsTolerance) state.outOfToleranceMs += dt;
  }
  emit();
}

/** Multiplex-power sample — driven by the FM branch's metering tick. */
export function sampleMpxPower(
  powerDbr: number | undefined,
  windowSeconds: number,
  now = Date.now(),
): void {
  const active = typeof powerDbr === "number" && Number.isFinite(powerDbr);
  if (!active) {
    if (state.mpxActive) {
      state.mpxActive = false;
      state.mpxPowerDbr = -120;
      emit();
    }
    return;
  }
  if (state.startedAt === 0) state.startedAt = now;
  state.mpxActive = true;
  state.mpxPowerDbr = powerDbr;
  state.mpxWindowSeconds = windowSeconds;
  if (powerDbr > state.mpxWorstDbr) state.mpxWorstDbr = powerDbr;
  if (powerDbr > state.targets.mpxLimitDbr && state.mpxLastAt > 0) {
    state.mpxOverLimitMs += Math.min(Math.max(0, now - state.mpxLastAt), 5000);
  }
  state.mpxLastAt = now;
  emit();
}

const fmt = (v: number | null, digits = 2, unit = "") =>
  v === null || !Number.isFinite(v)
    ? "—"
    : `${v.toFixed(digits).replace("-", "−")}${unit}`;

/** Build the operator-facing compliance record. */
export function complianceReport(now = Date.now()): ComplianceReport {
  const t = state.targets;
  const integrated = state.lufsI;
  const loudnessPass =
    integrated === null ? null : Math.abs(integrated - t.lufsTarget) <= t.lufsTolerance;
  const peakPass = state.maxTruePeakDb <= t.truePeakCeilingDb + 0.05;
  const mpxPass = !state.mpxActive ? null : state.mpxWorstDbr <= t.mpxLimitDbr + 0.05;

  const criteria: Criterion[] = [
    {
      label: "Integrated loudness (BS.1770-4 gated)",
      value: integrated === null ? "no programme" : fmt(integrated, 1, " LUFS"),
      limit: `${t.lufsTarget.toFixed(1)} ± ${t.lufsTolerance.toFixed(1)} LUFS`,
      pass: loudnessPass,
      detail:
        integrated === null
          ? "Needs 20 s or more of gated programme"
          : `Worst short-term excursion ${fmt(state.worstLufsDeviation, 1, " LU")}`,
    },
    {
      label: "Loudness range (EBU Tech 3342)",
      value: state.lra === null ? "measuring" : fmt(state.lra, 1, " LU"),
      limit: "no limit — recorded",
      pass: null,
      detail: "Informational",
    },
    {
      label: "True peak",
      value: fmt(state.maxTruePeakDb, 2, " dBTP"),
      limit: `≤ ${t.truePeakCeilingDb.toFixed(2)} dBTP`,
      pass: peakPass,
    },
    {
      label: "Sample peak",
      value: fmt(state.maxSamplePeakDb, 2, " dBFS"),
      limit: "≤ 0 dBFS",
      pass: state.maxSamplePeakDb <= 0.05,
    },
    {
      label: "Multiplex power (BS.412, 60 s)",
      value: state.mpxActive ? fmt(state.mpxWorstDbr, 2, " dBr") : "FM off",
      limit: `≤ ${t.mpxLimitDbr.toFixed(1)} dBr`,
      pass: mpxPass,
      detail: state.mpxActive
        ? `${state.mpxWindowSeconds.toFixed(0)} s window · ${(state.mpxOverLimitMs / 1000).toFixed(0)} s above the limit`
        : "The composite generator is not running",
    },
  ];

  return {
    generatedAt: now,
    sessionStartedAt: state.startedAt,
    durationMs: state.startedAt === 0 ? 0 : now - state.startedAt,
    targets: { ...t },
    criteria,
    pass: criteria.every((c) => c.pass !== false),
    note:
      "Programme loudness per ITU-R BS.1770-4 / EBU R128; multiplex power per ITU-R BS.412-9 clause 2.5.1 " +
      "(60 s mean square of the complete multiplex, 0 dBr = the power of a ±19 kHz peak-deviation sine). " +
      "Confirm the applicable limit for your licence before filing this record.",
  };
}

const iso = (t: number) => (t === 0 ? "" : new Date(t).toISOString());

/** CSV export — one row per criterion plus a header block. */
export function complianceCsv(report: ComplianceReport): string {
  const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const rows = [
    ["Generated", iso(report.generatedAt)],
    ["Session started", iso(report.sessionStartedAt)],
    ["Duration (s)", (report.durationMs / 1000).toFixed(0)],
    ["Loudness target (LUFS)", report.targets.lufsTarget],
    ["Loudness tolerance (LU)", report.targets.lufsTolerance],
    ["True-peak ceiling (dBTP)", report.targets.truePeakCeilingDb],
    ["MPX power limit (dBr)", report.targets.mpxLimitDbr],
    ["Overall", report.pass ? "within limits" : "outside limits"],
    [],
    ["Criterion", "Measured", "Limit", "Result", "Detail"],
    ...report.criteria.map((c) => [
      c.label,
      c.value,
      c.limit,
      c.pass === null ? "recorded" : c.pass ? "PASS" : "FAIL",
      c.detail ?? "",
    ]),
    [],
    [report.note],
  ];
  return rows.map((r) => r.map(esc).join(",")).join("\n");
}

/** Self-contained printable HTML record (print → PDF). */
export function complianceHtml(report: ComplianceReport): string {
  const rows = report.criteria
    .map(
      (c) => `<tr>
      <td>${c.label}</td>
      <td class="num">${c.value}</td>
      <td class="num">${c.limit}</td>
      <td class="${c.pass === null ? "info" : c.pass ? "pass" : "fail"}">
        ${c.pass === null ? "recorded" : c.pass ? "PASS" : "FAIL"}
      </td>
      <td class="detail">${c.detail ?? ""}</td>
    </tr>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Signalpath compliance record — ${new Date(report.generatedAt).toISOString().slice(0, 16).replace("T", " ")}</title>
<style>
  :root { color-scheme: light; }
  body { font: 13px/1.5 ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif; margin: 32px; color: #111; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  p.sub { margin: 0 0 20px; color: #555; }
  table { border-collapse: collapse; width: 100%; margin-top: 8px; }
  th, td { border-bottom: 1px solid #ddd; padding: 7px 8px; text-align: left; vertical-align: top; }
  th { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: #555; }
  td.num { font-variant-numeric: tabular-nums; white-space: nowrap; }
  td.detail { color: #555; font-size: 12px; }
  .pass { color: #0a7a33; font-weight: 600; }
  .fail { color: #b3261e; font-weight: 600; }
  .info { color: #555; }
  .badge { display: inline-block; padding: 3px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; }
  .badge.pass { background: #e6f4ea; }
  .badge.fail { background: #fdecea; }
  footer { margin-top: 20px; color: #555; font-size: 11px; max-width: 70ch; }
  @media print { body { margin: 12mm; } }
</style>
</head>
<body>
  <h1>Signalpath — audio compliance record</h1>
  <p class="sub">
    Generated ${new Date(report.generatedAt).toLocaleString()} ·
    session ${(report.durationMs / 1000).toFixed(0)} s of measurement ·
    <span class="badge ${report.pass ? "pass" : "fail"}">${report.pass ? "within limits" : "outside limits"}</span>
  </p>
  <table>
    <thead><tr><th>Criterion</th><th>Measured</th><th>Limit</th><th>Result</th><th>Detail</th></tr></thead>
    <tbody>
${rows}
    </tbody>
  </table>
  <footer>${report.note}</footer>
</body>
</html>`;
}

/** Filename stem shared by both exports. */
export function complianceFilename(report: ComplianceReport): string {
  return `signalpath-compliance-${new Date(report.generatedAt)
    .toISOString()
    .slice(0, 16)
    .replace(/[:T]/g, "-")}`;
}
