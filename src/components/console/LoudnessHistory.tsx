import { getEngine } from "@/lib/audio/engine";
import { LUFS_TARGET } from "@/lib/audio/params";
import { cn } from "@/lib/utils";
import { useEffect, useRef, useState } from "react";

const RANGE_TOP = 0;
const RANGE_BOTTOM = -35;

interface Sample {
  t: number;
  v: number;
}

interface Stats {
  min: number;
  max: number;
  avg: number;
  pctInBand: number;
}

/**
 * LOUDNESS HISTORY — EBU R128 short-term loudness trend over the last
 * minutes, the way a compliance recorder reads: a slow chart with the
 * target line, the ±1 LU tolerance band and min/max/average stats.
 * Samples at 1 Hz from the engine while powered; the buffer freezes when
 * the engine stops so the last session stays readable.
 */
export function LoudnessHistory({
  minutes = 15,
  height = 140,
}: {
  minutes?: number;
  height?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bufRef = useRef<Sample[]>([]);
  const poweredRef = useRef(false);
  const [stats, setStats] = useState<Stats | null>(null);

  const windowS = Math.max(60, Math.round(minutes * 60));

  useEffect(() => {
    let last = 0;
    return getEngine().subscribe((s) => {
      const now = performance.now();
      if (now - last < 1000) return;
      last = now;
      poweredRef.current = s.powered;
      if (!s.powered) return;
      const buf = bufRef.current;
      buf.push({ t: Date.now(), v: s.lufsS });
      while (buf.length > windowS) buf.shift();
      let min = Infinity;
      let max = -Infinity;
      let sum = 0;
      let band = 0;
      for (const p of buf) {
        if (p.v < min) min = p.v;
        if (p.v > max) max = p.v;
        sum += p.v;
        if (Math.abs(p.v - LUFS_TARGET) <= 1) band += 1;
      }
      setStats({
        min,
        max,
        avg: sum / buf.length,
        pctInBand: Math.round((band / buf.length) * 100),
      });
    });
  }, [windowS]);

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

      const yOf = (v: number) =>
        ((RANGE_TOP - Math.max(RANGE_BOTTOM, Math.min(RANGE_TOP, v))) /
          (RANGE_TOP - RANGE_BOTTOM)) *
        h;

      // dB grid
      ctx.strokeStyle = "rgba(255,255,255,0.055)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let db = -5; db > RANGE_BOTTOM; db -= 5) {
        const y = Math.round(yOf(db)) + 0.5;
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
      }
      ctx.stroke();
      ctx.font = "8px 'JetBrains Mono', monospace";
      ctx.textAlign = "left";
      for (let db = 0; db > RANGE_BOTTOM; db -= 10) {
        ctx.fillStyle = "rgba(255,255,255,0.28)";
        ctx.fillText(`${db}`, 4, yOf(db) - 3);
      }

      // ±1 LU tolerance band + target line
      const bandTop = yOf(LUFS_TARGET + 1);
      const bandBot = yOf(LUFS_TARGET - 1);
      ctx.fillStyle = "rgba(76,217,100,0.10)";
      ctx.fillRect(0, bandTop, w, bandBot - bandTop);
      ctx.strokeStyle = "rgba(76,217,100,0.55)";
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(0, Math.round(yOf(LUFS_TARGET)) + 0.5);
      ctx.lineTo(w, Math.round(yOf(LUFS_TARGET)) + 0.5);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "rgba(76,217,100,0.8)";
      ctx.textAlign = "right";
      ctx.fillText(`target ${LUFS_TARGET}`, w - 4, yOf(LUFS_TARGET) - 3);

      const buf = bufRef.current;
      if (buf.length > 1) {
        // trend line
        ctx.beginPath();
        for (let i = 0; i < buf.length; i++) {
          const x = (i / (windowS - 1)) * w;
          const y = yOf(buf[i].v);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = "rgba(74,144,226,0.95)";
        ctx.lineWidth = 1.4;
        ctx.shadowColor = "rgba(74,144,226,0.5)";
        ctx.shadowBlur = 4;
        ctx.stroke();
        ctx.shadowBlur = 0;

        // current-value dot + readout
        const lx = ((buf.length - 1) / (windowS - 1)) * w;
        const ly = yOf(buf[buf.length - 1].v);
        ctx.fillStyle = "#2fb5b5";
        ctx.beginPath();
        ctx.arc(lx, ly, 2.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.font = "9px 'JetBrains Mono', monospace";
        ctx.textAlign = "right";
        ctx.fillStyle = "rgba(255,255,255,0.85)";
        ctx.fillText(
          buf[buf.length - 1].v.toFixed(1),
          Math.min(w - 4, lx - 5),
          ly - 4,
        );
      } else {
        ctx.fillStyle = "rgba(255,255,255,0.26)";
        ctx.font = "10px 'JetBrains Mono', monospace";
        ctx.textAlign = "center";
        ctx.fillText(
          poweredRef.current
            ? "COLLECTING — 1 Hz BS.1770 SHORT-TERM"
            : "AWAITING SIGNAL",
          w / 2,
          h / 2,
        );
      }

      // time axis
      ctx.font = "8px 'JetBrains Mono', monospace";
      ctx.fillStyle = "rgba(255,255,255,0.28)";
      ctx.textAlign = "left";
      ctx.fillText(`−${minutes} min`, 4, h - 4);
      ctx.textAlign = "right";
      ctx.fillText("now", w - 4, h - 4);

      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [minutes, windowS]);

  return (
    <div>
      <div className="panel-well relative overflow-hidden rounded-md" style={{ height }}>
        <canvas ref={canvasRef} className="h-full w-full" />
      </div>
      <div className="mt-1.5 grid grid-cols-4 gap-2">
        {[
          { label: "Min", value: stats ? `${stats.min.toFixed(1)}` : "—" },
          { label: "Max", value: stats ? `${stats.max.toFixed(1)}` : "—" },
          { label: "Avg", value: stats ? `${stats.avg.toFixed(1)}` : "—" },
          {
            label: "In tolerance",
            value: stats ? `${stats.pctInBand}%` : "—",
            tone: stats
              ? stats.pctInBand >= 90
                ? "ok"
                : stats.pctInBand >= 70
                  ? "warn"
                  : "hot"
              : undefined,
          },
        ].map((s) => (
          <div key={s.label} className="panel-well rounded px-2 py-1">
            <p className="text-[8px] font-semibold tracking-[0.12em] text-panel-mut uppercase">
              {s.label}
            </p>
            <p
              className={cn(
                "text-readout text-[11px] font-medium text-white",
                s.tone === "ok" && "text-meter-ok",
                s.tone === "warn" && "text-meter-warn",
                s.tone === "hot" && "text-meter-hot",
              )}
            >
              {s.value}
              {s.label === "In tolerance" ? "" : <span className="ml-0.5 text-[8px] text-panel-mut">LUFS</span>}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
