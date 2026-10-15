import { Knob } from "@/components/console/Knob";
import { ModuleCard } from "@/components/console/ModuleCard";
import { CtrlRow, Seg, Val } from "@/components/console/controls";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getFm, subscribeFm, type FmSnapshot } from "@/lib/audio/fm";
import { emphasisBoostDb, emphasisCornerHz } from "@/lib/audio/mpx";
import {
  type FmEmphasis,
  type FmParams,
} from "@/lib/audio/params";
import { cn } from "@/lib/utils";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { TermTip } from "@/components/console/Meters";

/* ── MPX composite spectrum (0–100 kHz linear, subcarrier markers) ─────── */

const MARKERS: { hz: number; label: string }[] = [
  { hz: 19000, label: "19 pilot" },
  { hz: 38000, label: "38 L−R" },
  { hz: 57000, label: "57 RDS" },
  { hz: 67000, label: "67 SCA" },
];

function MpxSpectrumCanvas({ height = 120 }: { height?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const peaksRef = useRef<Float32Array | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let raf = 0;
    let lastSnap = getFm();
    let lastSpec: Float32Array | null = lastSnap.spectrum;
    const unsub = subscribeFm(() => {
      lastSnap = getFm();
      lastSpec = lastSnap.spectrum;
    });

    const draw = () => {
      raf = requestAnimationFrame(draw);
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      if (!peaksRef.current || peaksRef.current.length !== w) {
        peaksRef.current = new Float32Array(w).fill(-110);
      }
      const peaks = peaksRef.current;

      const F_MAX = 100000;
      const spec = lastSpec;
      // dB range −100…0 mapped to the canvas
      const yFor = (db: number) =>
        h - 6 - ((Math.max(-100, Math.min(0, db)) + 100) / 100) * (h - 14);

      // band shading: programme 0–15, stereo 23–53, RDS ~55–59
      ctx.fillStyle = "rgba(74,144,226,0.05)";
      ctx.fillRect(0, 0, (15000 / F_MAX) * w, h);
      ctx.fillStyle = "rgba(74,144,226,0.03)";
      ctx.fillRect((23000 / F_MAX) * w, 0, ((53000 - 23000) / F_MAX) * w, h);

      // marker gridlines
      ctx.strokeStyle = "rgba(255,255,255,0.08)";
      ctx.beginPath();
      for (let f = 20000; f < F_MAX; f += 20000) {
        const x = Math.round((f / F_MAX) * w) + 0.5;
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
      }
      ctx.stroke();
      for (const m of MARKERS) {
        const x = Math.round((m.hz / F_MAX) * w) + 0.5;
        ctx.strokeStyle = "rgba(255,204,0,0.28)";
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
      }

      if (spec && spec.length > 0) {
        const binHz = (lastSnap.outRate || 192000) / 4096;
        // spectrum trace (filled)
        ctx.beginPath();
        ctx.moveTo(0, h);
        for (let x = 0; x < w; x++) {
          const f = (x / w) * F_MAX;
          const k = Math.min(spec.length - 1, Math.round(f / binHz));
          const db = spec[k];
          peaks[x] = Math.max(db, peaks[x] - 0.35);
          ctx.lineTo(x, yFor(db));
        }
        ctx.lineTo(w, h);
        ctx.closePath();
        ctx.fillStyle = "rgba(74,144,226,0.18)";
        ctx.fill();
        ctx.strokeStyle = "#4a90e2";
        ctx.lineWidth = 1;
        ctx.stroke();
        // peak hold
        ctx.beginPath();
        for (let x = 0; x < w; x++) {
          if (x === 0) ctx.moveTo(x, yFor(peaks[x]));
          else ctx.lineTo(x, yFor(peaks[x]));
        }
        ctx.strokeStyle = "rgba(255,255,255,0.35)";
        ctx.stroke();
      }

      // labels
      ctx.font = "8px ui-monospace, monospace";
      ctx.fillStyle = "rgba(176,182,192,0.9)";
      for (const m of MARKERS) {
        const x = (m.hz / F_MAX) * w;
        ctx.fillText(m.label, Math.min(x + 3, w - 44), 10);
      }
      ctx.fillText("0", 2, h - 2);
      ctx.fillText("50k", w / 2 - 6, h - 2);
      ctx.fillText("100 kHz", w - 30, h - 2);
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      unsub();
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="w-full rounded-md border border-border/50 bg-black/30"
      style={{ height }}
      aria-label="MPX composite spectrum, 0 to 100 kHz"
    />
  );
}

/* ── deviation meter (% of ±75 kHz) ────────────────────────────────────── */

function DeviationMeter({ snap }: { snap: FmSnapshot }) {
  const stats = snap.stats;
  const pct = stats?.modPct ?? 0;
  const hold = stats?.peakHoldPct ?? 0;
  const alarm = stats?.alarmPct ?? 100;
  const ceiling = stats?.ceilingPct ?? 100;
  const over = pct > alarm;
  const bar = (v: number) => `${Math.min(100, (v / 120) * 100)}%`;

  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="flex items-center gap-1.5 text-[10px] font-semibold tracking-[0.1em] text-muted-foreground uppercase">
          %MOD
          <TermTip
            term="%MOD"
            definition="Peak composite deviation as a percentage of ±75 kHz. 100 % = full permitted deviation; sustained readings over the alarm threshold risk enforcement action."
          />
        </span>
        <span
          className={cn(
            "text-readout text-lg font-semibold tabular-nums",
            over ? "text-meter-hot" : "text-foreground",
          )}
        >
          {pct.toFixed(1)}
          <span className="ml-0.5 text-[10px] text-muted-foreground">%</span>
        </span>
      </div>
      <div className="panel-well relative mt-1.5 h-3 overflow-hidden rounded-sm">
        {/* zone tints */}
        <div
          className="absolute inset-y-0 left-0 bg-meter-ok/15"
          style={{ width: bar(alarm) }}
        />
        <div
          className="absolute inset-y-0 bg-meter-hot/20"
          style={{ left: bar(alarm), right: 0 }}
        />
        {/* live fill */}
        <div
          className={cn(
            "absolute inset-y-0 left-0 transition-[width] duration-150",
            over ? "bg-meter-hot" : "bg-meter-ok",
          )}
          style={{ width: bar(pct) }}
        />
        {/* peak hold */}
        <div
          className="absolute inset-y-0 w-px bg-white/80"
          style={{ left: bar(hold) }}
        />
        {/* ceiling marker */}
        <div
          className="absolute inset-y-0 w-px bg-meter-warn"
          style={{ left: bar(ceiling) }}
          title={`Composite ceiling ${ceiling}%`}
        />
      </div>
      <div className="mt-1 flex justify-between text-[8px] tracking-wider text-muted-foreground tabular-nums">
        <span>0</span>
        <span>alarm {alarm}%</span>
        <span>120</span>
      </div>
    </div>
  );
}

/* ── component deviation breakdown ─────────────────────────────────────── */

function ComponentBars({ snap }: { snap: FmSnapshot }) {
  const c = snap.stats?.components;
  const rows: { label: string; pct: number; tone: string }[] = [
    { label: "L+R main", pct: c?.mainPct ?? 0, tone: "bg-signal" },
    { label: "L−R @38k", pct: c?.subPct ?? 0, tone: "bg-signal-strong" },
    { label: "Pilot 19k", pct: c?.pilotPct ?? 0, tone: "bg-meter-ok" },
    { label: "RDS 57k", pct: c?.rdsPct ?? 0, tone: "bg-meter-warn" },
    { label: "SCA 67k", pct: c?.scaPct ?? 0, tone: "bg-amber-led" },
  ];
  return (
    <div className="grid gap-1">
      {rows.map((r) => (
        <div key={r.label} className="flex items-center gap-2">
          <span className="w-16 shrink-0 text-[9px] tracking-wide text-muted-foreground">
            {r.label}
          </span>
          <span className="panel-well h-1.5 flex-1 overflow-hidden rounded-sm">
            <span
              className={cn("block h-full rounded-sm", r.tone)}
              style={{ width: `${Math.min(100, (r.pct / 45) * 100)}%` }}
            />
          </span>
          <span className="text-readout w-10 shrink-0 text-right text-[9px] text-foreground tabular-nums">
            {r.pct.toFixed(1)}%
          </span>
        </div>
      ))}
    </div>
  );
}

/* ── the FM module ─────────────────────────────────────────────────────── */

const EMPHASIS_OPTIONS: { value: FmEmphasis; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "50", label: "50 µs" },
  { value: "75", label: "75 µs" },
];

export function FmPanel({
  fm,
  onChange,
}: {
  fm: FmParams;
  onChange: (next: FmParams) => void;
}) {
  const snap = useSyncExternalStore(subscribeFm, getFm);
  const [psDraft, setPsDraft] = useState(fm.mpx.rdsPs);
  const [lastPs, setLastPs] = useState(fm.mpx.rdsPs);
  // keep the draft in step with external PS changes (preset loads) —
  // adjust during render rather than resetting from an effect
  if (fm.mpx.rdsPs !== lastPs) {
    setLastPs(fm.mpx.rdsPs);
    setPsDraft(fm.mpx.rdsPs);
  }

  const set = (patch: Partial<FmParams>) => onChange({ ...fm, ...patch });
  const setMpx = (patch: Partial<FmParams["mpx"]>) =>
    onChange({ ...fm, mpx: { ...fm.mpx, ...patch } });

  const corner =
    fm.emphasis === "off" ? null : emphasisCornerHz(fm.emphasis);
  const boost15 =
    fm.emphasis === "off" ? null : emphasisBoostDb(fm.emphasis, 15000);

  const subcarrierSum =
    (fm.mpx.on ? fm.mpx.pilotPct + fm.mpx.rdsPct + fm.mpx.scaPct : 0);
  const sumWarn = subcarrierSum > 20;

  return (
    <ModuleCard
      title="FM exciter · MPX"
      subtitle={
        fm.on
          ? `${fm.emphasis === "off" ? "No pre-emphasis" : `${fm.emphasis} µs pre-emphasis`} · composite @ ${((snap.outRate / 1000).toFixed(1))} kHz`
          : "Bypassed — programme feeds the stream only"
      }
      enabled={fm.on}
      onToggle={() => set({ on: !fm.on })}
    >
      <div className="grid gap-5 lg:grid-cols-12">
        {/* ── controls ── */}
        <div className="lg:col-span-7">
          <CtrlRow label="Pre-emphasis">
            <Seg
              value={fm.emphasis}
              options={EMPHASIS_OPTIONS}
              onChange={(v) => set({ emphasis: v })}
              ariaLabel="FM pre-emphasis time constant"
            />
            <Val className="w-40 truncate text-right">
              {corner !== null
                ? `${corner.toFixed(0)} Hz corner · +${boost15?.toFixed(1)} dB @ 15k`
                : "flat — receiver gets the raw chain"}
            </Val>
          </CtrlRow>

          <CtrlRow label="Multiplex">
            <Seg
              value={fm.mpx.on ? "stereo" : "mono"}
              options={[
                { value: "stereo", label: "Stereo MPX" },
                { value: "mono", label: "Mono" },
              ]}
              onChange={(v) => setMpx({ on: v === "stereo" })}
              ariaLabel="Stereo multiplex generator"
            />
            <Val>
              {fm.mpx.on
                ? "19k pilot + 38k DSB-SC"
                : "L+R only — no subcarriers"}
            </Val>
          </CtrlRow>

          <div className="mt-3 flex flex-wrap items-start justify-center gap-4">
            <Knob
              label="Pilot"
              value={fm.mpx.pilotPct}
              min={0}
              max={15}
              step={0.1}
              accent
              format={(v) => `${v.toFixed(1)} %`}
              onChange={(v) => setMpx({ pilotPct: v })}
              onReset={() => setMpx({ pilotPct: 9 })}
              disabled={!fm.mpx.on || !fm.on}
            />
            <Knob
              label="RDS"
              value={fm.mpx.rdsPct}
              min={0}
              max={8}
              step={0.1}
              format={(v) => `${v.toFixed(1)} %`}
              onChange={(v) => setMpx({ rdsPct: v })}
              onReset={() => setMpx({ rdsPct: 3.3 })}
              disabled={!fm.mpx.on || !fm.on}
            />
            <Knob
              label="SCA"
              value={fm.mpx.scaPct}
              min={0}
              max={15}
              step={0.5}
              format={(v) => `${v.toFixed(1)} %`}
              onChange={(v) => setMpx({ scaPct: v })}
              onReset={() => setMpx({ scaPct: 0 })}
              disabled={!fm.mpx.on || !fm.on}
            />
            <Knob
              label="Ceiling"
              value={fm.mpx.ceilingPct}
              min={80}
              max={110}
              step={0.5}
              format={(v) => `${v.toFixed(0)} %`}
              onChange={(v) => setMpx({ ceilingPct: v })}
              onReset={() => setMpx({ ceilingPct: 100 })}
              disabled={!fm.on}
            />
            <Knob
              label="Alarm"
              value={fm.mpx.alarmPct}
              min={85}
              max={115}
              step={0.5}
              format={(v) => `${v.toFixed(0)} %`}
              onChange={(v) => setMpx({ alarmPct: v })}
              onReset={() => setMpx({ alarmPct: 100 })}
              disabled={!fm.on}
            />
          </div>

          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label className="text-[10px] font-semibold tracking-[0.1em] text-muted-foreground uppercase">
                RDS PS name
              </Label>
              <Input
                value={psDraft}
                maxLength={8}
                onChange={(e) => setPsDraft(e.target.value.toUpperCase())}
                onBlur={() => setMpx({ rdsPs: psDraft.padEnd(8, " ").slice(0, 8) })}
                className="text-readout font-mono tracking-[0.2em] uppercase"
                aria-label="RDS programme service name (8 characters)"
              />
              <span className="text-[9px] text-muted-foreground">
                8 characters · sent as group 0A on the 57 kHz subcarrier
              </span>
            </div>
            <div className="flex flex-col justify-end gap-1.5">
              <span
                className={cn(
                  "rounded border px-2 py-1.5 text-[9px] leading-3.5",
                  sumWarn
                    ? "border-meter-warn/50 bg-meter-warn/10 text-meter-warn"
                    : "border-meter-ok/40 bg-meter-ok/10 text-meter-ok",
                )}
              >
                Subcarrier budget {subcarrierSum.toFixed(1)} % of 20 % max
                (pilot + RDS + SCA) — {sumWarn ? "over the FCC 73.319 sum" : "within FCC 73.319"}
              </span>
              {snap.error && (
                <span className="rounded border border-meter-hot/50 bg-meter-hot/10 px-2 py-1.5 text-[9px] text-meter-hot">
                  {snap.error}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* ── metering ── */}
        <div className="flex flex-col gap-3 lg:col-span-5">
          <DeviationMeter snap={snap} />
          <ComponentBars snap={snap} />
          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-[10px] font-semibold tracking-[0.1em] text-muted-foreground uppercase">
                MPX composite spectrum
              </span>
              <span
                className={cn(
                  "flex items-center gap-1.5 text-[9px]",
                  snap.running ? "text-meter-ok" : "text-muted-foreground",
                )}
              >
                <span
                  className={cn("led size-1.5", snap.running && "led-on")}
                  aria-hidden
                />
                {snap.running ? "generator live" : "idle — engage FM + power on"}
              </span>
            </div>
            <MpxSpectrumCanvas />
            <p className="mt-1 text-[9px] leading-3.5 text-muted-foreground">
              Programme ≤15 kHz · DSB-SC difference 23–53 kHz · pilot 19 kHz ·
              RDS ±2.4 kHz around 57 kHz · SCA at 67 kHz
            </p>
          </div>
        </div>
      </div>
    </ModuleCard>
  );
}
