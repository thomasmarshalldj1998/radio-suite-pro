import { getEngine } from "@/lib/audio/engine";
import { LUFS_TARGET } from "@/lib/audio/params";
import { cn } from "@/lib/utils";
import { Pause, Play, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";

const RANGE_TOP = 0;
const RANGE_BOTTOM = -35;

type RangeKey = "10s" | "1m" | "5m" | "30m";
const RANGES: { id: RangeKey; label: string; seconds: number }[] = [
  { id: "10s", label: "10 sec", seconds: 10 },
  { id: "1m", label: "1 min", seconds: 60 },
  { id: "5m", label: "5 min", seconds: 300 },
  { id: "30m", label: "30 min", seconds: 1800 },
];

interface Sample {
  t: number;
  m: number;
  s: number;
  i: number;
  tp: number;
  gr: number;
}

interface Trace {
  key: keyof Omit<Sample, "t">;
  label: string;
  color: string;
  dash?: number[];
  width?: number;
}

/** All four share one axis: LUFS, dBTP and GR dB all live usefully in −35…0. */
const TRACES: Trace[] = [
  { key: "m", label: "Mom", color: "rgba(255,255,255,0.55)", width: 1 },
  { key: "s", label: "ST", color: "#2fb5b5", width: 1.4 },
  { key: "i", label: "Int", color: "rgba(76,217,100,0.8)", width: 1.2 },
  { key: "tp", label: "TP", color: "rgba(255,59,48,0.85)", width: 1 },
  { key: "gr", label: "GR", color: "rgba(0,224,255,0.8)", dash: [4, 3], width: 1 },
];

/**
 * LOUDNESS HISTORY — scrolling compliance recorder: momentary, short-term
 * and integrated LUFS plus true peak and limiter GR, all measured live off
 * the composite bus. Ranges 10 s…30 min, pausable, resettable. GR plots as
 * negative dB on the same axis; TP clamps to it.
 */
export function LoudnessHistory({ height = 140 }: { height?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bufRef = useRef<Sample[]>([]);
  const poweredRef = useRef(false);
  const pausedRef = useRef(false);
  const [range, setRange] = useState<RangeKey>("5m");
  const [paused, setPaused] = useState(false);
  const [tpMax, setTpMax] = useState<number | null>(null);
  const [latest, setLatest] = useState<Sample | null>(null); // chrome readouts

  const windowS = RANGES.find((r) => r.id === range)?.seconds ?? 300;

  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  useEffect(() => {
    let last = 0;
    let lastUi = 0;
    return getEngine().subscribe(() => {
      const now = performance.now();
      if (now - lastUi >= 1000) {
        lastUi = now;
        const buf = bufRef.current;
        setLatest(buf.length ? buf[buf.length - 1] : null);
      }
      if (now - last < 200 || pausedRef.current) return; // 5 Hz sampling
      last = now;
      const s = getEngine().snapshot();
      poweredRef.current = s.powered;
      if (!s.powered) return;
      const buf = bufRef.current;
      buf.push({
        t: Date.now(),
        m: s.lufsM,
        s: s.lufsS,
        i: s.lufsI ?? -70,
        tp: s.truePeak,
        gr: -Math.max(0, s.gr.limiter),
      });
      while (buf.length > 0 && Date.now() - buf[0].t > 1800 * 1000) buf.shift();
      setTpMax((prev) => {
        const m = Math.max(prev ?? -70, s.truePeak);
        return prev === m ? prev : m;
      });
    });
  }, []);

  const reset = () => {
    bufRef.current = [];
    setTpMax(null);
    setLatest(null);
  };

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

      const nowMs = Date.now();
      const buf = bufRef.current.filter((p) => nowMs - p.t <= windowS * 1000);
      if (buf.length > 1) {
        for (const tr of TRACES) {
          ctx.beginPath();
          for (let i = 0; i < buf.length; i++) {
            const x =
              w - ((nowMs - buf[i].t) / (windowS * 1000)) * w;
            const y = yOf(buf[i][tr.key]);
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }
          ctx.strokeStyle = tr.color;
          ctx.lineWidth = tr.width ?? 1;
          ctx.setLineDash(tr.dash ?? []);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      } else {
        ctx.fillStyle = "rgba(255,255,255,0.26)";
        ctx.font = "10px 'JetBrains Mono', monospace";
        ctx.textAlign = "center";
        ctx.fillText(
          poweredRef.current
            ? "COLLECTING — BS.1770 SHORT-TERM + TP + GR"
            : "AWAITING SIGNAL",
          w / 2,
          h / 2,
        );
      }

      // time axis
      ctx.font = "8px 'JetBrains Mono', monospace";
      ctx.fillStyle = "rgba(255,255,255,0.28)";
      ctx.textAlign = "left";
      ctx.fillText(
        range === "10s" ? "−10 s" : range === "1m" ? "−1 min" : range === "5m" ? "−5 min" : "−30 min",
        4,
        h - 4,
      );
      ctx.textAlign = "right";
      ctx.fillText(paused ? "paused" : "now", w - 4, h - 4);

      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [range, windowS, paused]);

  return (
    <div>
      <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
        <span
          role="group"
          aria-label="History range"
          className="inline-flex overflow-hidden rounded-md border border-border/70"
        >
          {RANGES.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => setRange(r.id)}
              aria-pressed={range === r.id}
              className={cn(
                "px-2 py-1 text-[9px] font-semibold tracking-[0.08em] uppercase transition-colors",
                range === r.id
                  ? "bg-signal text-signal-fg"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              {r.label}
            </button>
          ))}
        </span>
        <span className="ml-1 hidden flex-wrap items-center gap-x-2 gap-y-0.5 sm:flex">
          {TRACES.map((tr) => (
            <span
              key={tr.key}
              className="flex items-center gap-1 text-[8px] tracking-[0.08em] text-panel-mut uppercase"
            >
              <span
                aria-hidden
                className="inline-block h-0.5 w-3 rounded"
                style={{ background: tr.color }}
              />
              {tr.label}
            </span>
          ))}
        </span>
        <span className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setPaused((p) => !p)}
            aria-pressed={paused}
            title={paused ? "Resume recording" : "Pause recording"}
            className="flex h-6 items-center gap-1 rounded-md border border-border/70 px-2 text-[9px] font-semibold tracking-[0.08em] text-muted-foreground uppercase transition-colors hover:text-foreground"
          >
            {paused ? <Play className="size-3" /> : <Pause className="size-3" />}
            {paused ? "Resume" : "Pause"}
          </button>
          <button
            type="button"
            onClick={reset}
            title="Clear history"
            className="flex h-6 items-center gap-1 rounded-md border border-border/70 px-2 text-[9px] font-semibold tracking-[0.08em] text-muted-foreground uppercase transition-colors hover:text-foreground"
          >
            <RotateCcw className="size-3" />
            Reset
          </button>
        </span>
      </div>
      <div className="panel-well relative overflow-hidden rounded-md" style={{ height }}>
        <canvas ref={canvasRef} className="h-full w-full" />
      </div>
      <div className="mt-1.5 grid grid-cols-3 gap-2 sm:grid-cols-5">
        <div className="panel-well rounded px-2 py-1">
          <p className="text-[8px] font-semibold tracking-[0.12em] text-panel-mut uppercase">
            TP max
          </p>
          <p
            className={cn(
              "text-readout text-[11px] font-medium",
              tpMax !== null && tpMax > -1
                ? "text-meter-hot"
                : "text-white",
            )}
          >
            {tpMax === null ? "—" : tpMax.toFixed(1).replace("-", "−")}
            <span className="ml-0.5 text-[8px] text-panel-mut">dBTP</span>
          </p>
        </div>
        {[
          { label: "Mom now", get: (b: Sample) => b.m },
          { label: "ST now", get: (b: Sample) => b.s },
          { label: "Int now", get: (b: Sample) => b.i },
          { label: "GR now", get: (b: Sample) => b.gr },
        ].map((s) => {
          const v = latest ? s.get(latest) : null;
          return (
            <div key={s.label} className="panel-well rounded px-2 py-1">
              <p className="text-[8px] font-semibold tracking-[0.12em] text-panel-mut uppercase">
                {s.label}
              </p>
              <p className="text-readout text-[11px] font-medium text-white">
                {v === null ? "—" : v.toFixed(1).replace("-", "−")}
                <span className="ml-0.5 text-[8px] text-panel-mut">dB</span>
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
}
