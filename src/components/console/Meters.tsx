import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { SILENT_SNAPSHOT, getEngine, type MeterSnapshot } from "@/lib/audio/engine";
import { cn } from "@/lib/utils";
import { Info } from "lucide-react";
import { useEffect, useRef, useState } from "react";

/** Glossary tooltip for broadcast metering terms (GR, LUFS, LRA, dBFS, dBTP). */
export function TermTip({
  term,
  definition,
  className,
}: {
  term: string;
  definition: string;
  className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={`What is ${term}?`}
          className={cn(
            "inline-flex shrink-0 cursor-help items-center text-panel-mut transition-colors hover:text-panel-fg",
            className,
          )}
        >
          <Info className="size-3" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-64 text-left">
        <span className="font-semibold">{term}</span> — {definition}
      </TooltipContent>
    </Tooltip>
  );
}

const COLORS = {
  ok: "#4cd964",
  warn: "#ffcc00",
  hot: "#ff3b30",
  slate: "#59616e",
  unlit: "rgba(255,255,255,0.07)",
  hold: "rgba(255,255,255,0.85)",
};;

/* ── shared canvas segment bar ──────────────────────────────────────────── */

interface SegmentBarProps {
  /** dB value read fresh every frame (no React re-render). */
  get: () => number;
  minDb: number;
  maxDb: number;
  height: number;
  /** Fill direction: up from the bottom (level) or down from the top (GR). */
  fromTop?: boolean;
  /** dB → segment color. */
  zone: (db: number) => string;
  /** Peak-hold decay in dB/s (0 disables). */
  decay?: number;
  /** Peak-hold duration in ms before decay starts (0 = decay immediately). */
  holdMs?: number;
  className?: string;
}

function SegmentBar({
  get,
  minDb,
  maxDb,
  height,
  fromTop = false,
  zone,
  decay = 22,
  holdMs = 1500,
  className,
}: SegmentBarProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const getRef = useRef(get);
  const peakRef = useRef(minDb);
  const holdUntilRef = useRef(0);

  useEffect(() => {
    getRef.current = get;
  }, [get]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let raf = 0;
    let last = performance.now();

    const draw = () => {
      const now = performance.now();
      const dt = (now - last) / 1000;
      last = now;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const value = Math.min(maxDb, Math.max(minDb, getRef.current()));
      const t = (value - minDb) / (maxDb - minDb);
      if (value >= peakRef.current) {
        peakRef.current = value;
        holdUntilRef.current = now + holdMs;
      } else if (now >= holdUntilRef.current) {
        peakRef.current = Math.max(value, peakRef.current - decay * dt);
      }
      const peakT = Math.min(1, Math.max(0, (peakRef.current - minDb) / (maxDb - minDb)));

      const segH = 3;
      const gap = 2;
      const count = Math.max(1, Math.floor(h / (segH + gap)));
      const lit = Math.round(t * count);
      const peakIdx = Math.round(peakT * count) - 1;

      for (let i = 0; i < count; i++) {
        const segDb = minDb + ((fromTop ? count - i : i + 1) / count) * (maxDb - minDb);
        const isLit = fromTop ? i < lit : i < lit;
        const y = i * (segH + gap);
        ctx.fillStyle = isLit ? zone(fromTop ? segDb : segDb) : COLORS.unlit;
        ctx.fillRect(0, y, w, segH);
        if (peakRef.current > minDb + 0.1) {
          const pIdx = fromTop ? count - 1 - peakIdx : peakIdx;
          if (i === pIdx) {
            ctx.fillStyle = COLORS.hold;
            ctx.fillRect(0, y, w, 1.5);
          }
        }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [minDb, maxDb, fromTop, zone, decay, holdMs]);

  return <canvas ref={canvasRef} className={cn("block h-full w-full", className)} style={{ height }} />;
}

/* Broadcast PPM colouring: < −20 slate · −20…−6 green · −6…−3 amber · −3…0 red */
const levelZone = (db: number) =>
  db >= -3 ? COLORS.hot : db >= -6 ? COLORS.warn : db >= -20 ? COLORS.ok : COLORS.slate;
const grZone = () => COLORS.warn;

/* ── numeric readouts driven by rAF (no re-renders) ─────────────────────── */

function Readout({
  get,
  suffix = " dB",
  className,
}: {
  get: () => number;
  suffix?: string;
  className?: string;
}) {
  const spanRef = useRef<HTMLSpanElement>(null);
  const getRef = useRef(get);
  useEffect(() => {
    getRef.current = get;
  }, [get]);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const el = spanRef.current;
      if (el) {
        const v = getRef.current();
        const text = v <= -99 ? "−∞" : v.toFixed(2).replace("-", "−");
        el.textContent = `${text}${suffix}`;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [suffix]);
  return <span ref={spanRef} className={cn("text-readout", className)} />;
}

/* ── gain-reduction peak tracker (real values, sampled at 4 Hz) ────────── */

function useGrPeak(get: () => number, decayPerSec = 2): number {
  const getRef = useRef(get);
  useEffect(() => {
    getRef.current = get;
  }, [get]);
  const [peak, setPeak] = useState(0);
  useEffect(() => {
    let v = 0;
    let last = performance.now();
    const id = window.setInterval(() => {
      const now = performance.now();
      const cur = Math.max(0, getRef.current());
      v = Math.max(cur, v - ((now - last) / 1000) * decayPerSec);
      last = now;
      setPeak(v);
    }, 250);
    return () => window.clearInterval(id);
  }, [decayPerSec]);
  return peak;
}

/* ── stereo level meter ─────────────────────────────────────────────────── */

export function StereoLevelMeter({
  kind,
  height = 176,
  holdMs = 1500,
  decay = 22,
  showState = false,
}: {
  kind: "in" | "out";
  height?: number;
  /** Peak-hold duration (ms) before the indicator starts falling. */
  holdMs?: number;
  /** Peak-hold decay in dB/s. */
  decay?: number;
  /** Render clip/activity LEDs and the no-signal state. */
  showState?: boolean;
}) {
  const getL = () => {
    const s = getEngine().snapshot();
    return kind === "in" ? s.inPeakL : s.outPeakL;
  };
  const getR = () => {
    const s = getEngine().snapshot();
    return kind === "in" ? s.inPeakR : s.outPeakR;
  };

  // state LEDs are sampled at 4 Hz — no per-frame React work
  const [state, setState] = useState({ clip: false, active: false, noSignal: true });
  useEffect(() => {
    if (!showState) return;
    let last = 0;
    let lastActive = 0;
    return getEngine().subscribe((s) => {
      const now = performance.now();
      if (now - last < 250) return;
      last = now;
      const clip = kind === "in" ? s.clipIn : s.clipOut;
      const peak = Math.max(
        kind === "in" ? s.inPeakL : s.outPeakL,
        kind === "in" ? s.inPeakR : s.outPeakR,
      );
      if (s.powered && peak > -60) lastActive = now;
      const noSignal = !s.powered || now - lastActive > 2500;
      setState((prev) =>
        prev.clip === clip && prev.active === !noSignal && prev.noSignal === noSignal
          ? prev
          : { clip, active: !noSignal, noSignal },
      );
    });
  }, [kind, showState]);

  return (
    <div className="flex flex-col gap-1">
      {showState && (
        <div className="flex items-center justify-between gap-3 px-0.5">
          <span className="flex items-center gap-1 text-[8px] font-semibold tracking-[0.12em] text-panel-mut uppercase">
            <span className={cn("led size-1.5", state.active && "led-on")} aria-hidden />
            Sig
          </span>
          <span className="flex items-center gap-1 text-[8px] font-semibold tracking-[0.12em] text-panel-mut uppercase">
            Clip
            <span className={cn("led size-1.5", state.clip && "led-hot")} aria-hidden />
          </span>
        </div>
      )}
      <div className="flex items-stretch gap-2">
        <div className="flex flex-col justify-between py-0.5 text-[8px] leading-none text-panel-mut">
          {["0", "−6", "−20", "−40", "−60"].map((t) => (
            <span key={t} className="text-right">
              {t}
            </span>
          ))}
        </div>
        <div className="panel-well relative flex gap-1 rounded-md px-2 py-2">
          <div className="flex w-3.5 flex-col items-center justify-end gap-1">
            <span className="text-[8px] font-semibold text-panel-mut">L</span>
            <div className="w-full" style={{ height: height - 14 }}>
              <SegmentBar
                get={getL}
                minDb={-60}
                maxDb={0}
                height={height - 14}
                zone={levelZone}
                holdMs={holdMs}
                decay={decay}
              />
            </div>
          </div>
          <div className="flex w-3.5 flex-col items-center justify-end gap-1">
            <span className="text-[8px] font-semibold text-panel-mut">R</span>
            <div className="w-full" style={{ height: height - 14 }}>
              <SegmentBar
                get={getR}
                minDb={-60}
                maxDb={0}
                height={height - 14}
                zone={levelZone}
                holdMs={holdMs}
                decay={decay}
              />
            </div>
          </div>
          {showState && state.noSignal && (
            <span className="pointer-events-none absolute inset-x-1 top-1/2 -translate-y-1/2 text-center text-[8px] font-semibold tracking-[0.14em] text-panel-mut/70 uppercase">
              No signal
            </span>
          )}
        </div>
        <div className="flex flex-col justify-between py-0.5">
          <Readout get={getL} className="text-[9px] text-panel-fg" />
          <Readout get={getR} className="text-[9px] text-panel-fg" />
        </div>
      </div>
      {showState && (
        <p className="px-0.5 text-[7px] font-semibold tracking-[0.14em] text-panel-mut/80 uppercase">
          dBFS · hold {holdMs >= 1000 ? `${(holdMs / 1000).toFixed(1)} s` : "off"}
        </p>
      )}
    </div>
  );
}

/* ── gain reduction meter (dB down from the top) ────────────────────────── */

export function GainReductionMeter({
  get,
  maxDb = 24,
  height = 120,
  width = 10,
  label,
}: {
  get: () => number;
  maxDb?: number;
  height?: number;
  width?: number;
  label?: string;
}) {
  // GR is positive dB of reduction; render on a negative scale so the bar
  // falls from the top like a hardware GR meter.
  const mapped = () => -Math.min(maxDb, Math.max(0, get()));
  const peak = useGrPeak(get);
  return (
    <div className="flex items-center gap-1.5">
      <div className="panel-well rounded px-1.5 py-1.5" style={{ width: width + 12 }}>
        <SegmentBar get={mapped} minDb={-maxDb} maxDb={0} height={height} fromTop zone={grZone} decay={34} holdMs={800} />
      </div>
      <div className="flex h-full flex-col justify-between py-0.5">
        <span className="text-[8px] leading-none text-panel-mut">0</span>
        <span className="text-[8px] leading-none text-panel-mut">−{maxDb}</span>
        {label && (
          <span className="mt-auto text-[8px] font-semibold tracking-wider text-panel-mut uppercase">
            {label}
          </span>
        )}
      </div>
      <div className="flex flex-col gap-0.5">
        <Readout get={() => -mapped()} suffix=" dB" className="text-[10px] text-panel-fg" />
        <span className="text-readout text-[8px] leading-none text-panel-mut">
          PK {peak < 0.05 ? "0.00" : peak.toFixed(2)}
        </span>
      </div>
    </div>
  );
}

/* ── slim band GR bar for multiband channel strips ─────────────────────── */

export function BandGrBar({
  get,
  maxDb = 15,
  height = 44,
  label,
}: {
  get: () => number;
  maxDb?: number;
  height?: number;
  /** Compact band caption (e.g. "SUB") — replaces the generic peak caption. */
  label?: string;
}) {
  const mapped = () => -Math.min(maxDb, Math.max(0, get()));
  const peak = useGrPeak(get, 3);
  return (
    <div className="flex flex-col items-center gap-1">
      <div className="panel-well rounded px-[3px] py-1" style={{ width: 14 }}>
        <SegmentBar
          get={mapped}
          minDb={-maxDb}
          maxDb={0}
          height={height}
          fromTop
          zone={grZone}
          decay={34}
          holdMs={800}
        />
      </div>
      <Readout
        get={() => -mapped()}
        suffix=""
        className="text-[9px] text-panel-fg"
      />
      <span className="text-readout text-[7px] leading-none whitespace-nowrap text-panel-mut uppercase">
        {label ?? `pk ${peak < 0.05 ? "0" : peak.toFixed(1)}`}
      </span>
    </div>
  );
}

/* ── stereo correlation ─────────────────────────────────────────────────── */

export function CorrelationMeter() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let raf = 0;
    const draw = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const mid = w / 2;
      const value = getEngine().snapshot().correlation;
      const x = mid + (mid - 4) * Math.max(-1, Math.min(1, value));

      ctx.fillStyle = "rgba(255,255,255,0.07)";
      ctx.fillRect(0, h / 2 - 2, w, 4);
      ctx.fillStyle = "rgba(255,255,255,0.28)";
      ctx.fillRect(mid - 0.5, h / 2 - 6, 1, 12);
      const grad = ctx.createLinearGradient(mid, 0, x, 0);
      if (value >= 0) {
        grad.addColorStop(0, "rgba(62,196,138,0.25)");
        grad.addColorStop(1, COLORS.ok);
      } else {
        grad.addColorStop(0, "rgba(242,86,47,0.25)");
        grad.addColorStop(1, COLORS.hot);
      }
      ctx.fillStyle = grad;
      ctx.fillRect(Math.min(mid, x), h / 2 - 3, Math.abs(x - mid), 6);
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="panel-well rounded-md px-2 py-1.5">
      <canvas ref={canvasRef} className="h-4 w-full" />
      <div className="mt-1 flex justify-between text-[8px] text-panel-mut">
        <span>−1 mono</span>
        <span>corr</span>
        <span>+1 wide</span>
      </div>
    </div>
  );
}

/* ── loudness panel (ITU-R BS.1770-4) ───────────────────────────────────── */

const HISTORY_SECONDS = 60;
const LUFS_MIN = -44;
const LUFS_MAX = -6;

export function LoudnessMeter({ target = -23 }: { target?: number }) {
  const [snap, setSnap] = useState<MeterSnapshot>(SILENT_SNAPSHOT);
  const historyRef = useRef<{ t: number; v: number }[]>([]);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let lastState = 0;
    let lastHist = 0;
    const unsub = getEngine().subscribe((s) => {
      const now = performance.now();
      if (now - lastHist > 250) {
        lastHist = now;
        const hist = historyRef.current;
        hist.push({ t: s.t, v: s.lufsM });
        const cutoff = s.t - HISTORY_SECONDS * 1000;
        while (hist.length && hist[0].t < cutoff) hist.shift();
      }
      if (now - lastState > 120) {
        lastState = now;
        setSnap(s);
      }
      drawHistory();
    });

    function drawHistory() {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const yOf = (v: number) => {
        const clamped = Math.min(LUFS_MAX, Math.max(LUFS_MIN, v));
        return h - ((clamped - LUFS_MIN) / (LUFS_MAX - LUFS_MIN)) * h;
      };

      // grid
      ctx.strokeStyle = "rgba(255,255,255,0.06)";
      ctx.lineWidth = 1;
      for (let db = -40; db <= -10; db += 10) {
        const y = Math.round(yOf(db)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }
      // target line
      ctx.strokeStyle = "rgba(74,144,226,0.6)";
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(0, yOf(target));
      ctx.lineTo(w, yOf(target));
      ctx.stroke();
      ctx.setLineDash([]);

      const hist = historyRef.current;
      if (hist.length > 1) {
        ctx.beginPath();
        hist.forEach((p, i) => {
          const x = ((p.t + HISTORY_SECONDS * 1000 - hist[hist.length - 1].t) / (HISTORY_SECONDS * 1000)) * w;
          const y = yOf(p.v);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.strokeStyle = COLORS.ok;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.lineTo(w, h);
        ctx.lineTo(((hist[0].t + HISTORY_SECONDS * 1000 - hist[hist.length - 1].t) / (HISTORY_SECONDS * 1000)) * w, h);
        ctx.closePath();
        ctx.fillStyle = "rgba(62,196,138,0.12)";
        ctx.fill();
      }
    }

    drawHistory();
    return unsub;
  }, [target]);

  const fmt = (v: number) => (v <= -69.5 ? "−∞" : v.toFixed(2).replace("-", "−"));
  const delta = snap.powered ? snap.lufsM - target : null;

  return (
    <div className="panel rounded-lg p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[9px] font-semibold tracking-[0.14em] text-panel-mut uppercase">
            Momentary
          </p>
          <p className="text-readout text-3xl leading-none font-semibold text-panel-fg">
            {snap.powered ? fmt(snap.lufsM) : "—"}
            <span className="ml-1 text-xs font-normal text-panel-mut">LUFS</span>
          </p>
        </div>
        <div className="text-right">
          <p className="text-[9px] font-semibold tracking-[0.14em] text-panel-mut uppercase">
            Short-term
          </p>
          <p className="text-readout text-xl leading-none font-medium text-panel-fg">
            {snap.powered ? fmt(snap.lufsS) : "—"}
            <span className="ml-1 text-[10px] font-normal text-panel-mut">LUFS</span>
          </p>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-[1fr_auto] items-end gap-3">
        <div className="panel-well rounded-md px-2 py-1.5">
          <canvas ref={canvasRef} className="h-14 w-full" />
          <div className="mt-1 flex justify-between text-[8px] text-panel-mut">
            <span>{HISTORY_SECONDS}s ago</span>
            <span>target {target.toFixed(0)}</span>
            <span>now</span>
          </div>
        </div>
        <div className="flex flex-col items-end gap-2">
          <div className="text-right">
            <p className="text-[9px] font-semibold tracking-[0.14em] text-panel-mut uppercase">
              True peak
            </p>
            <p
              className={cn(
                "text-readout text-xl leading-none font-medium",
                snap.truePeak > -1 ? "text-meter-hot" : "text-panel-fg",
              )}
            >
              {snap.powered ? fmt(snap.truePeak) : "—"}
              <span className="ml-1 text-[10px] font-normal text-panel-mut">dBTP</span>
            </p>
          </div>
          {delta !== null && (
            <span
              className={cn(
                "rounded-full px-2 py-0.5 text-[9px] font-semibold tracking-wide",
                Math.abs(delta) <= 1
                  ? "bg-meter-ok/15 text-meter-ok"
                  : "bg-meter-warn/15 text-meter-warn",
              )}
            >
              {delta >= 0 ? "+" : "−"}
              {Math.abs(delta).toFixed(2)} LU vs target
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
