import { SILENT_SNAPSHOT, getEngine, type MeterSnapshot } from "@/lib/audio/engine";
import { cn } from "@/lib/utils";
import { useEffect, useRef, useState } from "react";

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
  className,
}: SegmentBarProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const getRef = useRef(get);
  const peakRef = useRef(minDb);

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
      peakRef.current = Math.max(value, peakRef.current - decay * dt);
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
  }, [minDb, maxDb, fromTop, zone, decay]);

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

/* ── stereo level meter ─────────────────────────────────────────────────── */

export function StereoLevelMeter({
  kind,
  height = 176,
}: {
  kind: "in" | "out";
  height?: number;
}) {
  const getL = () => {
    const s = getEngine().snapshot();
    return kind === "in" ? s.inPeakL : s.outPeakL;
  };
  const getR = () => {
    const s = getEngine().snapshot();
    return kind === "in" ? s.inPeakR : s.outPeakR;
  };

  return (
    <div className="flex items-stretch gap-2">
      <div className="flex flex-col justify-between py-0.5 text-[8px] leading-none text-panel-mut">
        {["0", "−6", "−20", "−40", "−60"].map((t) => (
          <span key={t} className="text-right">
            {t}
          </span>
        ))}
      </div>
      <div className="panel-well flex gap-1 rounded-md px-2 py-2">
        <div className="flex w-3.5 flex-col items-center justify-end gap-1">
          <span className="text-[8px] font-semibold text-panel-mut">L</span>
          <div className="w-full" style={{ height: height - 14 }}>
            <SegmentBar get={getL} minDb={-60} maxDb={0} height={height - 14} zone={levelZone} />
          </div>
        </div>
        <div className="flex w-3.5 flex-col items-center justify-end gap-1">
          <span className="text-[8px] font-semibold text-panel-mut">R</span>
          <div className="w-full" style={{ height: height - 14 }}>
            <SegmentBar get={getR} minDb={-60} maxDb={0} height={height - 14} zone={levelZone} />
          </div>
        </div>
      </div>
      <div className="flex flex-col justify-between">
        <Readout get={getL} className="text-[9px] text-panel-fg" />
        <div className="flex flex-col gap-1.5">
          <Readout get={getR} className="text-[9px] text-panel-fg" />
        </div>
      </div>
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
  return (
    <div className="flex items-center gap-1.5">
      <div className="panel-well rounded px-1.5 py-1.5" style={{ width: width + 12 }}>
        <SegmentBar get={mapped} minDb={-maxDb} maxDb={0} height={height} fromTop zone={grZone} decay={34} />
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
      <Readout get={() => -mapped()} suffix=" dB" className="text-[10px] text-panel-fg" />
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
