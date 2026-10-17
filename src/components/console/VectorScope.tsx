/**
 * VECTOR SCOPE — real-time stereo Lissajous monitor off the post-chain
 * output analysers: X = side (L−R), Y = mid (L+R), so a mono-compatible
 * programme draws a tall vertical trace and an out-of-phase one falls over
 * sideways. Phosphor persistence gives the CRT feel; the correlation
 * readout is the engine's measured value, not derived from the drawing.
 */
import { useEffect, useRef, useState } from "react";
import { Seg } from "@/components/console/controls";
import { getEngine } from "@/lib/audio/engine";
import { cn } from "@/lib/utils";

type TraceMode = "cyan" | "amber" | "green";

const TRACE: Record<TraceMode, { main: string; glow: string; label: string }> = {
  cyan: { main: "#22d3ee", glow: "rgba(34,211,238,0.55)", label: "Cyan neon" },
  amber: { main: "#f5a524", glow: "rgba(245,165,36,0.55)", label: "Amber CRT" },
  green: { main: "#4ade80", glow: "rgba(74,222,128,0.55)", label: "Matrix green" },
};

export function VectorScope({ height = 180 }: { height?: number }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [mode, setMode] = useState<TraceMode>("cyan");
  const [corr, setCorr] = useState(1);
  const [live, setLive] = useState(false);
  const modeRef = useRef(mode);
  const corrRef = useRef(1);
  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  useEffect(() => {
    let raf = 0;
    let last = 0;
    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);
      if (t - last < 66) return; // ~15 fps is plenty for phosphor
      last = t;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const engine = getEngine();
      const snap = engine.snapshot();
      const on = snap.powered && Math.max(snap.outPeakL, snap.outPeakR) > -70;
      setLive((prev) => (prev === on ? prev : on));
      if (Math.abs(snap.correlation - corrRef.current) > 0.005) {
        corrRef.current = snap.correlation;
        setCorr(snap.correlation);
      }
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (!w || !h) return;
      if (canvas.width !== Math.round(w * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // phosphor decay: fade the previous frame instead of clearing
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = "rgba(10,12,16,0.28)";
      ctx.fillRect(0, 0, w, h);

      const cx = w / 2;
      const cy = h / 2;
      const R = Math.min(w, h) / 2 - 6;
      const trace = TRACE[modeRef.current];

      // graticule: circle + cross + ±45° phase diagonals
      ctx.strokeStyle = "rgba(38,42,53,0.9)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx - R, cy);
      ctx.lineTo(cx + R, cy);
      ctx.moveTo(cx, cy - R);
      ctx.lineTo(cx, cy + R);
      ctx.stroke();
      ctx.strokeStyle = "rgba(38,42,53,0.55)";
      ctx.setLineDash([2, 4]);
      for (const s of [1, -1]) {
        ctx.beginPath();
        ctx.moveTo(cx - (R * s) / Math.SQRT2, cy - R / Math.SQRT2);
        ctx.lineTo(cx + (R * s) / Math.SQRT2, cy + R / Math.SQRT2);
        ctx.stroke();
      }
      ctx.setLineDash([]);

      if (!on) return;
      const { l, r } = engine.getScopeFrames(512);
      if (l.length === 0) return;
      ctx.strokeStyle = trace.main;
      ctx.shadowColor = trace.glow;
      ctx.shadowBlur = 5;
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      const step = Math.max(1, Math.floor(l.length / 220));
      for (let i = 0; i < l.length; i += step) {
        // gentle 2.2× loupe so broadcast levels use the whole face
        const m = (l[i] + r[i]) * 1.1;
        const s = (l[i] - r[i]) * 1.1;
        const x = cx + Math.max(-1, Math.min(1, s)) * R;
        const y = cy - Math.max(-1, Math.min(1, m)) * R;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.shadowBlur = 0;
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="mt-3 rounded border border-border/60 px-2.5 py-1.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[8px] font-semibold tracking-[0.12em] text-panel-mut uppercase">
          Vector scope · X side / Y mid
        </p>
        <div className="flex items-center gap-3">
          <span
            className={cn(
              "font-mono text-[11px] tabular-nums",
              corr < 0 ? "text-red-400" : corr < 0.3 ? "text-amber-300" : "text-emerald-300",
            )}
          >
            Φ {corr >= 0 ? "+" : "−"}
            {Math.abs(corr).toFixed(2)}
          </span>
          <Seg
            ariaLabel="Scope trace color"
            value={mode}
            options={(Object.keys(TRACE) as TraceMode[]).map((m) => ({
              value: m,
              label: TRACE[m].label,
            }))}
            onChange={(v) => setMode(v as TraceMode)}
          />
        </div>
      </div>
      <canvas ref={canvasRef} className="mt-1 w-full" style={{ height }} />
      {!live && (
        <p className="mt-1 text-center text-[9px] text-muted-foreground">
          No programme — start the engine to light the trace
        </p>
      )}
    </div>
  );
}
