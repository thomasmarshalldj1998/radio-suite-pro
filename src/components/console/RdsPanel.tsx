/**
 * RDS encoder panel — the 57 kHz data subcarrier in full.
 *
 * Everything a receiver works from is here: programme identification and type,
 * the programme service name (with a scrolling window for names longer than
 * eight characters), RadioText with an optional delay that lines the display up
 * with delayed audio, the alternative-frequency list, and — when the station's
 * now-playing metadata is the source of truth — a switch that keeps RadioText
 * in step with it.
 *
 * The status column reports what the generator is actually sending: measured
 * group rate, how long each field takes to cycle, and the live PS window.
 */
import { DigitalCtrl } from "@/components/console/DigitalCtrl";
import { ModuleCard } from "@/components/console/ModuleCard";
import { CtrlRow, Seg, Val } from "@/components/console/controls";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { getFm, subscribeFm } from "@/lib/audio/fm";
import {
  RDS_BIT_RATE,
  RDS_RTPLUS_AID,
  RDS_RTPLUS_TAG_NAMES,
  RDS_SCHEDULE,
  rdsAfCode,
  rdsAscii,
  rdsRtPlusTags,
  type MpxTickStats,
} from "@/lib/audio/mpx";
import type { FmParams } from "@/lib/audio/params";
import { cn } from "@/lib/utils";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

/** Programme type codes, IEC 62106 table 6 (0–31). */
const PTY_NAMES = [
  "None",
  "News",
  "Current affairs",
  "Information",
  "Sport",
  "Education",
  "Drama",
  "Culture",
  "Science",
  "Varied",
  "Pop music",
  "Rock music",
  "Easy listening",
  "Light classical",
  "Serious classical",
  "Other music",
  "Weather",
  "Finance",
  "Children's",
  "Social affairs",
  "Religion",
  "Phone-in",
  "Travel",
  "Leisure",
  "Jazz",
  "Country",
  "National music",
  "Oldies",
  "Folk music",
  "Documentary",
  "Alarm test",
  "Alarm",
];

export const RDS_PTY_NAMES = PTY_NAMES;

/** Groups per second at 1187.5 bit/s / 104 bits per group. */
const GROUPS_PER_S = RDS_BIT_RATE / 104;

/**
 * Timing of the repeating cycle, derived from the encoder's own schedule so
 * the panel cannot drift away from what is transmitted: the PS name cycles
 * every four PS groups, a RadioText every sixteen text groups, and the RT+
 * pair once per cycle. Slots a configuration does not use are dropped.
 */
function cycleTiming(rtPlus: boolean, hasRt: boolean) {
  const slots = RDS_SCHEDULE.filter(
    (s) => rtPlus || (s !== "3A" && s !== "11A"),
  ).map((s) => (s === "2A" && !hasRt ? "0A" : s));
  const total = slots.length;
  const count = (t: string) => slots.filter((s) => s === t).length;
  const ps = count("0A");
  const rt = count("2A");
  const oda = rtPlus && hasRt;
  return {
    total,
    psPassS: ps > 0 ? ((total / ps) * 4) / GROUPS_PER_S : 0,
    rtPassS: rt > 0 ? ((total / rt) * 16) / GROUPS_PER_S : 0,
    odaS: oda ? total / GROUPS_PER_S : 0,
  };
}

/** The eight characters a receiver shows for a given scroll step. */
export function rdsWindow(ps: string, scroll: boolean, step: number): string {
  if (ps.length <= 8) return ps.padEnd(8, " ");
  if (!scroll) return ps.slice(0, 8);
  const cycle = `${ps}    `;
  const at = ((step % cycle.length) + cycle.length) % cycle.length;
  return (cycle + cycle).slice(at, at + 8);
}

/** Measured group rate from consecutive generator ticks. */
function useGroupRate(stats: MpxTickStats | null): number {
  const ref = useRef<{ stats: MpxTickStats | null; at: number; rate: number }>({
    stats: null,
    at: 0,
    rate: 0,
  });
  const now = performance.now();
  const prev = ref.current;
  if (stats && stats !== prev.stats) {
    if (prev.stats && now > prev.at) {
      const inst = stats.rdsGroups / ((now - prev.at) / 1000);
      prev.rate = prev.rate === 0 ? inst : prev.rate * 0.6 + inst * 0.4;
    }
    prev.stats = stats;
    prev.at = now;
  }
  return prev.rate;
}

/** Animated PS window so a scrolling name can be seen moving. */
function useScrollStep(active: boolean): number {
  const [step, setStep] = useState(0);
  useEffect(() => {
    if (!active) {
      setStep(0);
      return;
    }
    const id = window.setInterval(() => setStep((s) => s + 1), 350);
    return () => window.clearInterval(id);
  }, [active]);
  return step;
}

export function RdsPanel({
  fm,
  onChange,
}: {
  fm: FmParams;
  onChange: (next: FmParams) => void;
}) {
  const snap = useSyncExternalStore(subscribeFm, getFm);
  const mpx = fm.mpx;
  const setMpx = (patch: Partial<FmParams["mpx"]>) =>
    onChange({ ...fm, mpx: { ...fm.mpx, ...patch } });

  // drafts keep typing intact (the encoder trims and strips on commit)
  const sig = [
    mpx.rdsPs,
    mpx.rdsRt,
    mpx.rdsAf.join(","),
    mpx.rdsPi,
  ].join("\u0000");
  const [draft, setDraft] = useState({
    sig,
    ps: mpx.rdsPs,
    rt: mpx.rdsRt,
    af: mpx.rdsAf.join(", "),
    pi: mpx.rdsPi,
  });
  if (draft.sig !== sig) {
    setDraft({
      sig,
      ps: mpx.rdsPs,
      rt: mpx.rdsRt,
      af: mpx.rdsAf.join(", "),
      pi: mpx.rdsPi,
    });
  }

  const enabled = fm.on && mpx.on && mpx.rdsPct > 0;
  const piValid = /^[0-9a-fA-F]{4}$/.test(draft.pi.trim());
  const piHex = /^[0-9a-fA-F]{1,4}$/.test(draft.pi.trim())
    ? draft.pi.trim().toUpperCase().padStart(4, "0")
    : "C479";
  const afList = draft.af
    .split(/[\s,;]+/)
    .map((s) => Number.parseFloat(s))
    .filter((n) => Number.isFinite(n));
  const afInvalid = draft.af
    .split(/[\s,;]+/)
    .filter((s) => s.length > 0 && rdsAfCode(Number.parseFloat(s)) === 0);
  const afSummary =
    afList.length > 0
      ? `AF ${afList.map((f) => f.toFixed(1)).join(" / ")} MHz`
      : "AF — no alternatives";

  const step = useScrollStep(enabled && mpx.rdsScroll && mpx.rdsPs.length > 8);
  const window = rdsWindow(mpx.rdsPs, mpx.rdsScroll, step);
  const overflow = mpx.rdsPs.length > 8;
  const groupRate = useGroupRate(snap.stats);
  const tags = rdsRtPlusTags(mpx.rdsRt);
  const timing = cycleTiming(mpx.rdsRtPlus && tags.length > 0, tags.length > 0);
  const commits: [string, string, string][] = [
    ["0A", `${timing.psPassS.toFixed(2)} s`, `PS "${mpx.rdsPs.slice(0, 8).padEnd(8, " ")}"`],
    ["0A", `${timing.psPassS.toFixed(2)} s`, afSummary],
  ];
  if (timing.rtPassS > 0) {
    commits.push(["2A", `${timing.rtPassS.toFixed(1)} s`, `RT "${mpx.rdsRt}"`]);
  }
  if (timing.odaS > 0) {
    commits.push([
      "3A",
      `${timing.odaS.toFixed(2)} s`,
      `RT+ announced · AID 0x${RDS_RTPLUS_AID.toString(16).toUpperCase()} · data in 11A`,
    ]);
    commits.push([
      "11A",
      `${timing.odaS.toFixed(2)} s`,
      tags
        .map((t) => `${RDS_RTPLUS_TAG_NAMES[t.type] ?? `type ${t.type}`} [${t.start},${t.len + 1}]`)
        .join(" · "),
    ]);
  }

  return (
    <ModuleCard
      title="RDS encoder · 57 kHz"
      subtitle={
        enabled
          ? `IEC 62106 groups 0A/2A · PI 0x${piHex} · PTY ${mpx.rdsPty} ${PTY_NAMES[mpx.rdsPty] ?? ""}`
          : "Off — the data subcarrier is at 0 %"
      }
      enabled={enabled}
      onToggle={() => setMpx({ rdsPct: enabled ? 0 : 3.3 })}
    >
      <div className="grid gap-5 lg:grid-cols-12">
        {/* ── encoder settings ── */}
        <div className="lg:col-span-7">
          <CtrlRow label="Programme ID">
            <Input
              value={draft.pi}
              maxLength={4}
              onChange={(e) =>
                setDraft((d) => ({
                  ...d,
                  pi: e.target.value
                    .replace(/[^0-9a-fA-F]/g, "")
                    .toUpperCase(),
                }))
              }
              onBlur={() => setMpx({ rdsPi: piHex })}
              className="text-readout w-24 font-mono tracking-[0.2em] uppercase"
              aria-label="RDS programme identification (4 hex digits)"
            />
            <Val className="text-right">
              0x{piHex} · {piValid ? "transmitted in every group" : "defaulting to 0xC479"}
            </Val>
          </CtrlRow>

          <CtrlRow label="Programme type">
            <Select
              value={String(mpx.rdsPty)}
              onValueChange={(v) => setMpx({ rdsPty: Number(v) })}
            >
              <SelectTrigger
                className="h-7 w-48 text-[11px]"
                aria-label="RDS programme type"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PTY_NAMES.map((name, code) => (
                  <SelectItem key={code} value={String(code)} className="text-[11px]">
                    {code} · {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Val className="text-right">PTY {mpx.rdsPty} (5 bits, block B)</Val>
          </CtrlRow>

          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label className="text-muted-foreground text-[10px] font-semibold tracking-[0.1em] uppercase">
                PS name
              </Label>
              <Input
                value={draft.ps}
                maxLength={64}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, ps: e.target.value.toUpperCase() }))
                }
                onBlur={() => setMpx({ rdsPs: rdsAscii(draft.ps) })}
                onKeyDown={(e) => {
                  if (e.key === "Enter") setMpx({ rdsPs: rdsAscii(draft.ps) });
                }}
                className="text-readout font-mono tracking-[0.2em] uppercase"
                aria-label="RDS programme service name"
              />
              <div className="flex items-center justify-between gap-2">
                <Seg
                  value={mpx.rdsScroll ? "scroll" : "static"}
                  options={[
                    { value: "static", label: "8 char" },
                    { value: "scroll", label: "Scroll" },
                  ]}
                  onChange={(v) => setMpx({ rdsScroll: v === "scroll" })}
                  ariaLabel="RDS programme service name scrolling"
                />
                <span className="text-readout text-[10px] tracking-[0.2em]">
                  [{window}]
                </span>
              </div>
              <span className="text-muted-foreground text-[9px]">
                {overflow
                  ? mpx.rdsScroll
                    ? `${mpx.rdsPs.length} characters — the window slides every ${(timing.psPassS * 1000).toFixed(0)} ms, a full pass every ${((mpx.rdsPs.length + 4) * timing.psPassS).toFixed(1)} s`
                    : `${mpx.rdsPs.length} characters entered — enable Scroll, or only the first eight are sent`
                  : "Eight characters, sent as group 0A on the 57 kHz subcarrier"}
              </span>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label className="text-muted-foreground text-[10px] font-semibold tracking-[0.1em] uppercase">
                RadioText (64 characters)
              </Label>
              <Input
                value={draft.rt}
                maxLength={64}
                onChange={(e) => setDraft((d) => ({ ...d, rt: e.target.value }))}
                onBlur={() => setMpx({ rdsRt: rdsAscii(draft.rt) })}
                onKeyDown={(e) => {
                  if (e.key === "Enter") setMpx({ rdsRt: rdsAscii(draft.rt) });
                }}
                className="text-readout font-mono"
                aria-label="RDS RadioText"
              />
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground text-[9px]">
                  {rdsAscii(draft.rt).length}/64 chars · group 2A
                </span>
                <label className="flex cursor-pointer items-center gap-1.5 text-[9px]">
                  <Switch
                    checked={mpx.rdsRtAuto}
                    onCheckedChange={(v) => setMpx({ rdsRtAuto: v })}
                    className="scale-75"
                    aria-label="Follow now-playing metadata"
                  />
                  follow now-playing
                </label>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground text-[9px]">
                  {mpx.rdsRtAuto
                    ? "artist + title pushed from station metadata"
                    : "text taken from this field only"}
                </span>
                <label className="flex cursor-pointer items-center gap-1.5 text-[9px]">
                  <Switch
                    checked={mpx.rdsRtPlus}
                    onCheckedChange={(v) => setMpx({ rdsRtPlus: v })}
                    className="scale-75"
                    aria-label="RadioText Plus tagging"
                  />
                  RT+ tags
                </label>
              </div>
              <span className="text-muted-foreground text-[9px] leading-3.5">
                {!mpx.rdsRtPlus
                  ? `Plain RadioText only — AID 0x${RDS_RTPLUS_AID.toString(16).toUpperCase()} is not announced`
                  : tags.length > 0
                    ? tags
                        .map(
                          (t) =>
                            `${RDS_RTPLUS_TAG_NAMES[t.type] ?? `type ${t.type}`} "${mpx.rdsRt.slice(t.start, t.start + t.len + 1)}"`,
                        )
                        .join(" · ")
                    : "announces RT+ support; tags follow once RadioText is set"}
              </span>
            </div>
          </div>

          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label className="text-muted-foreground text-[10px] font-semibold tracking-[0.1em] uppercase">
                Alternative frequencies
              </Label>
              <Input
                value={draft.af}
                onChange={(e) => setDraft((d) => ({ ...d, af: e.target.value }))}
                onBlur={() =>
                  setMpx({
                    rdsAf: afList.filter((f) => rdsAfCode(f) > 0),
                  })
                }
                placeholder="96.4, 98.9"
                className="text-readout font-mono"
                aria-label="Alternative frequencies in MHz"
              />
              <span
                className={cn(
                  "text-[9px]",
                  afInvalid.length > 0 ? "text-meter-warn" : "text-muted-foreground",
                )}
              >
                {afInvalid.length > 0
                  ? `Ignored outside 87.6–107.9 MHz: ${afInvalid.join(", ")}`
                  : afList.length > 0
                    ? `Codes ${afList
                        .map((f) => rdsAfCode(f))
                        .filter((c) => c > 0)
                        .join(", ")} · receivers step here when the signal drops`
                    : "No alternatives — the no-AF filler is sent instead"}
              </span>
            </div>

            <div className="flex flex-col justify-end gap-1.5">
              <DigitalCtrl
                label="Text delay"
                value={mpx.rdsDelayMs / 1000}
                min={0}
                max={20}
                step={0.5}
                format={(v) => (v === 0 ? "0 s" : `${v.toFixed(1)} s`)}
                onChange={(v) => setMpx({ rdsDelayMs: Math.round(v * 1000) })}
                onReset={() => setMpx({ rdsDelayMs: 0 })}
                disabled={!enabled}
              />
              <span className="text-muted-foreground text-center text-[9px] leading-3.5">
                {mpx.rdsDelayMs > 0
                  ? `A text change waits ${(mpx.rdsDelayMs / 1000).toFixed(1)} s before it is sent — match the audio delay line`
                  : "Text changes go out on the next group (no delay)"}
              </span>
            </div>
          </div>

          {snap.error && (
            <span className="border-meter-hot/50 bg-meter-hot/10 text-meter-hot mt-3 block rounded border px-2 py-1.5 text-[9px]">
              {snap.error}
            </span>
          )}
        </div>

        {/* ── what is going out ── */}
        <div className="flex flex-col gap-3 lg:col-span-5">
          <div className="rounded border border-border/60 bg-card/40 p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-muted-foreground text-[10px] font-semibold tracking-[0.1em] uppercase">
                Subcarrier status
              </span>
              <span
                className={cn(
                  "flex items-center gap-1.5 text-[9px]",
                  enabled ? "text-meter-ok" : "text-muted-foreground",
                )}
              >
                <span
                  className={cn("led size-1.5", enabled && "led-on")}
                  aria-hidden
                />
                {enabled ? "encoding" : "idle"}
              </span>
            </div>
            <dl className="grid grid-cols-2 gap-y-1.5 text-[10px]">
              <dt className="text-muted-foreground">Group rate</dt>
              <dd className="text-readout text-right">
                {groupRate > 0 ? groupRate.toFixed(1) : "—"} /s{" "}
                <span className="text-muted-foreground">
                  of {GROUPS_PER_S.toFixed(1)}
                </span>
              </dd>
              <dt className="text-muted-foreground">Subcarrier</dt>
              <dd className="text-readout text-right">
                {mpx.on && fm.on ? mpx.rdsPct.toFixed(1) : "0.0"} %{" "}
                <span className="text-muted-foreground">· 57 kHz</span>
              </dd>
              <dt className="text-muted-foreground">Pilot</dt>
              <dd className="text-readout text-right">
                {mpx.on && fm.on ? mpx.pilotPct.toFixed(1) : "0.0"} %{" "}
                <span className="text-muted-foreground">· 19 kHz</span>
              </dd>
              <dt className="text-muted-foreground">PI / PTY</dt>
              <dd className="text-readout text-right">
                0x{piHex} · {mpx.rdsPty}
              </dd>
            </dl>
          </div>

          <div className="rounded border border-border/60 bg-card/40 p-3">
            <span className="text-muted-foreground mb-2 block text-[10px] font-semibold tracking-[0.1em] uppercase">
              Group cycle
            </span>
            <ul className="flex flex-col gap-1.5 text-[10px]">
              {commits.map(([type, every, what], i) => (
                <li key={i} className="flex items-baseline gap-2">
                  <span className="text-readout w-7 shrink-0 text-signal">
                    {type}
                  </span>
                  <span className="text-readout text-muted-foreground w-14 shrink-0">
                    {every}
                  </span>
                  <span className="truncate">{what}</span>
                </li>
              ))}
            </ul>
            <p className="text-muted-foreground mt-2 text-[9px] leading-3.5">
              {timing.total}-group cycle: the name repeats every{" "}
              {timing.psPassS.toFixed(2)} s, a full RadioText needs{" "}
              {timing.rtPassS > 0 ? `${timing.rtPassS.toFixed(1)} s` : "no groups"}
              {timing.odaS > 0
                ? `, and the RadioText Plus pair goes out every ${timing.odaS.toFixed(2)} s`
                : ""}
              . Bit rate 1187.5 bit/s ± 6 ppm.
            </p>
          </div>

          <div className="rounded border border-border/60 bg-card/40 p-3">
            <span className="text-muted-foreground mb-2 block text-[10px] font-semibold tracking-[0.1em] uppercase">
              Receiver display
            </span>
            <div className="text-readout flex items-center justify-between text-[11px] tracking-[0.25em]">
              <span className="bg-signal/10 rounded px-2 py-1">{window}</span>
              <span className="text-muted-foreground text-[9px] tracking-normal">
                PS {mpx.rdsScroll ? "scrolling" : "static"}
              </span>
            </div>
            <div className="text-readout mt-2 truncate text-[11px]">
              {mpx.rdsRt || "—"}
            </div>
            <div className="text-muted-foreground mt-1 flex justify-between text-[9px]">
              <span>
                {mpx.rdsDelayMs > 0
                  ? `delayed ${(mpx.rdsDelayMs / 1000).toFixed(1)} s`
                  : "undelayed"}
              </span>
              <span>57 kHz subcarrier</span>
            </div>
          </div>
        </div>
      </div>
    </ModuleCard>
  );
}
