import { getEngine } from "@/lib/audio/engine";
import { chainResponseDb, type EqBand, type MultibandSplits } from "@/lib/audio/params";
import { cn } from "@/lib/utils";
import { useEffect, useRef } from "react";

const F_MIN = 20;
const F_MAX = 20000;
const GRID_FREQS = [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
const LABELS: Record<number, string> = {
  50: "50",
  100: "100",
  200: "200",
  500: "500",
  1000: "1k",
  2000: "2k",
  5000: "5k",
  10000: "10k",
  20000: "20k",
};

const logToX = (f: number, w: number) =>
  (Math.log(f / F_MIN) / Math.log(F_MAX / F_MIN)) * w;
const xToFreq = (x: number, w: number) =>
  F_MIN * Math.pow(F_MAX / F_MIN, Math.max(0, Math.min(1, x / w)));

export interface SpectrumCanvasProps {
  /** "live" reads the audio engine; "synthetic" animates a demo program. */
  mode: "live" | "synthetic";
  height?: number;
  className?: string;
  /** Draw the static EQ response curve (+0 dB axis) over the spectrum. */
  eq?: { on: boolean; bands: EqBand[] };
  /** Input high-pass marker — folded into the response curve. */
  hpf?: { on: boolean; freqHz: number };
  /** Multiband crossover splits — drawn as labelled verticals. */
  splits?: MultibandSplits;
}

/**
 * Precision log-frequency analyzer. Live mode overlays the pre-processing
 * spectrum (dim) under the processed output (illuminated) so operators can
 * see exactly what the chain is doing, with a slow peak-hold trace.
 */
export function SpectrumCanvas({
  mode,
  height = 190,
  className,
  eq,
  hpf,
  splits,
}: SpectrumCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const peaksRef = useRef<Float32Array | null>(null);
  const synthRef = useRef<Float32Array | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let raf = 0;
    const start = performance.now();
    let preCurve = new Float32Array(0);
    let hasPre = false;

    const draw = () => {
      const now = performance.now();
      const t = (now - start) / 1000;
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
        peaksRef.current = new Float32Array(w);
      }
      const peaks = peaksRef.current;

      // ── collect the level curve for this frame ──
      const curve = new Float32Array(w);
      let live = false;

      if (mode === "live") {
        const engine = getEngine();
        const post = engine.getSpectrum(false);
        if (post) {
          live = true;
          const pre = engine.getSpectrum(true);
          hasPre = !!pre;
          if (preCurve.length !== w) preCurve = new Float32Array(w);
          const sr = engine.sampleRate || 48000;
          const bins = post.length;
          const binHz = sr / 2 / bins;
          for (let px = 0; px < w; px++) {
            const f = xToFreq(px, w);
            const fNext = xToFreq(px + 1, w);
            const bin = Math.min(bins - 1, Math.round(f / binHz));
            const binEnd = Math.max(bin + 1, Math.round(fNext / binHz));
            let v = 0;
            let pv = 0;
            for (let b = bin; b < Math.min(bins, binEnd); b++) {
              v = Math.max(v, post[b]);
              if (pre) pv = Math.max(pv, pre[b]);
            }
            curve[px] = v / 255;
            preCurve[px] = pv / 255;
          }
        }
      } else {
        // synthetic program material: kick pulse + mids + sparkle hats
        if (!synthRef.current || synthRef.current.length !== w) {
          synthRef.current = new Float32Array(w);
        }
        const s = synthRef.current;
        const kick = Math.pow(Math.abs(Math.sin(t * Math.PI * 2 * 1.9)), 10);
        const groove = 0.6 + 0.4 * Math.sin(t * 0.9);
        for (let px = 0; px < w; px++) {
          const f = xToFreq(px, w);
          let target: number;
          if (f < 120) target = 0.55 + 0.42 * kick;
          else if (f < 600)
            target = 0.42 + 0.16 * Math.sin(t * 2.3 + f / 240) * groove;
          else if (f < 3000)
            target = 0.38 + 0.2 * Math.sin(t * 1.7 + f / 900) * groove;
          else if (f < 9000) {
            const hat = Math.pow(Math.abs(Math.sin(t * Math.PI * 1.9 + 0.9)), 24);
            target = 0.26 + 0.34 * hat;
          } else target = 0.16 + 0.08 * Math.sin(t * 3.1 + f / 4200);
          s[px] += (target - s[px]) * 0.22;
          curve[px] = s[px];
        }
        live = true;
      }

      // ── grid ──
      ctx.strokeStyle = "rgba(255,255,255,0.055)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 1; i < 4; i++) {
        const y = Math.round((h * i) / 4) + 0.5;
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
      }
      for (const f of GRID_FREQS) {
        const x = Math.round(logToX(f, w)) + 0.5;
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
      }
      ctx.stroke();

      ctx.font = "9px 'JetBrains Mono', monospace";
      ctx.fillStyle = "rgba(255,255,255,0.32)";
      ctx.textAlign = "center";
      for (const f of GRID_FREQS) {
        const x = logToX(f, w);
        if (x > 8 && x < w - 12) ctx.fillText(LABELS[f] ?? `${f}`, x, h - 4);
      }

      /* ── overlay: EQ response curve + crossover markers ── */
      const drawOverlay = () => {
        const amp = h / 2 - 6;
        const yOf = (db: number) =>
          h / 2 - (Math.max(-16, Math.min(16, db)) / 15) * amp;
        const mid = Math.round(h / 2) + 0.5;

        ctx.save();
        // 0 dB axis + scale
        ctx.strokeStyle = "rgba(255,255,255,0.16)";
        ctx.setLineDash([4, 4]);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, mid);
        ctx.lineTo(w, mid);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.font = "8px 'JetBrains Mono', monospace";
        ctx.textAlign = "left";
        ctx.fillStyle = "rgba(255,255,255,0.3)";
        ctx.fillText("+15", 4, 11);
        ctx.fillText("0", 4, mid - 3);
        ctx.fillText("−15", 4, h - 16);

        // multiband crossover verticals
        if (splits) {
          ctx.textAlign = "center";
          ctx.font = "8px 'JetBrains Mono', monospace";
          for (const f of splits) {
            const x = Math.round(logToX(f, w)) + 0.5;
            ctx.strokeStyle = "rgba(47,181,181,0.4)";
            ctx.setLineDash([3, 5]);
            ctx.beginPath();
            ctx.moveTo(x, 14);
            ctx.lineTo(x, h - 12);
            ctx.stroke();
            ctx.setLineDash([]);
            if (x > 20 && x < w - 20) {
              ctx.fillStyle = "rgba(47,181,181,0.85)";
              ctx.fillText(f >= 1000 ? `${+(f / 1000).toFixed(1)}k` : `${f}`, x, 11);
            }
          }
        }

        // EQ + HPF response curve
        if (eq) {
          const n = eq.bands.length;
          ctx.beginPath();
          let px = 0;
          for (; px <= w; px += 2) {
            const db = chainResponseDb(
              { eq, hpf: hpf ?? { on: false, freqHz: 80 } },
              xToFreq(px, w),
            );
            const y = yOf(db);
            if (px === 0) ctx.moveTo(px, y);
            else ctx.lineTo(px, y);
          }
          if (px < w) {
            const db = chainResponseDb(
              { eq, hpf: hpf ?? { on: false, freqHz: 80 } },
              xToFreq(w, w),
            );
            ctx.lineTo(w, yOf(db));
          }
          // tinted area between the curve and 0 dB
          ctx.lineTo(w, mid);
          ctx.lineTo(0, mid);
          ctx.closePath();
          ctx.fillStyle = "rgba(47,181,181,0.10)";
          ctx.fill();
          // the curve itself, with a soft glow
          ctx.beginPath();
          px = 0;
          for (; px <= w; px += 2) {
            const db = chainResponseDb(
              { eq, hpf: hpf ?? { on: false, freqHz: 80 } },
              xToFreq(px, w),
            );
            const y = yOf(db);
            if (px === 0) ctx.moveTo(px, y);
            else ctx.lineTo(px, y);
          }
          ctx.strokeStyle = n > 0 ? "rgba(47,181,181,0.95)" : "rgba(255,255,255,0.5)";
          ctx.lineWidth = 1.5;
          ctx.shadowColor = "rgba(47,181,181,0.65)";
          ctx.shadowBlur = 6;
          ctx.stroke();
          ctx.shadowBlur = 0;
        }
        ctx.restore();
      };

      if (!live) {
        // idle baseline — the response curve still shows the static chain
        ctx.strokeStyle = "rgba(255,255,255,0.14)";
        ctx.beginPath();
        ctx.moveTo(0, h - 1);
        ctx.lineTo(w, h - 1);
        ctx.stroke();
        drawOverlay();
        ctx.fillStyle = "rgba(255,255,255,0.28)";
        ctx.textAlign = "left";
        ctx.font = "10px 'JetBrains Mono', monospace";
        ctx.fillText("SIGNAL PATH IDLE", 10, 16);
        raf = requestAnimationFrame(draw);
        return;
      }

      // ── pre-processing ghost ──
      if (mode === "live" && preCurve.length === w && hasPre) {
        ctx.beginPath();
        ctx.moveTo(0, h);
        for (let px = 0; px < w; px++) ctx.lineTo(px, h - preCurve[px] * (h - 8));
        ctx.lineTo(w, h);
        ctx.closePath();
        ctx.fillStyle = "rgba(255,255,255,0.06)";
        ctx.fill();
      }

      // ── peak-hold trace ──
      for (let px = 0; px < w; px++) {
        peaks[px] = Math.max(curve[px], peaks[px] - 0.0035);
        if (peaks[px] < curve[px]) peaks[px] = curve[px];
      }

      // ── processed curve ──
      const grad = ctx.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, "rgba(239,91,43,0.92)");
      grad.addColorStop(0.55, "rgba(239,91,43,0.38)");
      grad.addColorStop(1, "rgba(239,91,43,0.06)");
      ctx.beginPath();
      ctx.moveTo(0, h);
      for (let px = 0; px < w; px++) ctx.lineTo(px, h - curve[px] * (h - 8));
      ctx.lineTo(w, h);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();

      ctx.beginPath();
      for (let px = 0; px < w; px++) {
        const y = h - peaks[px] * (h - 8);
        if (px === 0) ctx.moveTo(px, y);
        else ctx.lineTo(px, y);
      }
      ctx.strokeStyle = "rgba(255,255,255,0.5)";
      ctx.lineWidth = 1;
      ctx.stroke();

      // response curve + crossovers sit above the spectrum fill
      drawOverlay();

      raf = requestAnimationFrame(draw);
    };

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [mode, eq, hpf, splits]);

  return (
    <div className={cn("panel-well relative overflow-hidden rounded-lg", className)} style={{ height }}>
      <canvas ref={canvasRef} className="h-full w-full" />
    </div>
  );
}
