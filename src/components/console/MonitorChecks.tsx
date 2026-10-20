import { ModuleCard } from "@/components/console/ModuleCard";
import { CtrlRow, Seg, Val } from "@/components/console/controls";
import type { ProcessorParams } from "@/lib/audio/params";
import { getEngine, type MeterSnapshot } from "@/lib/audio/engine";
import { cn } from "@/lib/utils";
import { useEffect, useRef, useState } from "react";

/**
 * Phase / mono audit tools.
 *
 * These three checks are monitoring decisions, not processing ones: they sit
 * on the monitor bus only, after the encoder send has already been tapped, so
 * a mono fold or a polarity flip can never leak onto the stream.
 */
export function MonitorChecks({
  params,
  setParams,
}: {
  params: ProcessorParams;
  setParams: React.Dispatch<React.SetStateAction<ProcessorParams>>;
}) {
  const engine = getEngine();
  const [snap, setSnap] = useState<MeterSnapshot>(() => engine.snapshot());
  useEffect(() => {
    let last = 0;
    return engine.subscribe((s) => {
      const now = performance.now();
      if (now - last >= 120) {
        last = now;
        setSnap(s);
      }
    });
  }, [engine]);

  const mono = params.monitor.mono;
  const inverted = params.monitor.invertL !== params.monitor.invertR;
  const corr = snap.correlation;
  const powered = snap.powered;

  return (
    <ModuleCard
      title="Monitor checks"
      subtitle="Mono fold · polarity · 2-minute correlation history · monitor bus only"
      right={
        <span className="text-readout text-[10px] text-panel-mut">
          {powered ? corr.toFixed(2) : "—"}
        </span>
      }
    >
      <div className="divide-y divide-border/60 rounded border border-border/60">
        <CtrlRow label="Mono check">
          <Seg
            ariaLabel="Mono downmix check"
            value={mono ? "mono" : "stereo"}
            options={[
              { value: "stereo", label: "Stereo" },
              { value: "mono", label: "Mono" },
            ]}
            onChange={(v) =>
              setParams((p) => ({
                ...p,
                monitor: { ...p.monitor, mono: v === "mono" },
              }))
            }
          />
          <span className="text-[10px] leading-4 text-muted-foreground">
            Folds the monitor to L+R so a mono listener hears what you hear.
          </span>
        </CtrlRow>
        <CtrlRow label="Polarity">
          <Seg
            ariaLabel="Invert left channel"
            value={params.monitor.invertL ? "inv" : "normal"}
            options={[
              { value: "normal", label: "L +" },
              { value: "inv", label: "L −" },
            ]}
            onChange={(v) =>
              setParams((p) => ({
                ...p,
                monitor: { ...p.monitor, invertL: v === "inv" },
              }))
            }
          />
          <Seg
            ariaLabel="Invert right channel"
            value={params.monitor.invertR ? "inv" : "normal"}
            options={[
              { value: "normal", label: "R +" },
              { value: "inv", label: "R −" },
            ]}
            onChange={(v) =>
              setParams((p) => ({
                ...p,
                monitor: { ...p.monitor, invertR: v === "inv" },
              }))
            }
          />
          <Val className={cn(inverted && "text-meter-warn")}>
            {inverted ? "out of phase" : "normal"}
          </Val>
        </CtrlRow>
      </div>

      <CorrelationHistory />

      <p className="mt-2 text-[10px] leading-4 text-muted-foreground">
        {mono
          ? "Mono check engaged: the monitor is being folded, the program and the stream are untouched."
          : "A correlation that sits below zero means the left and right channels cancel; fold to mono before you trust the image on air."}
      </p>
    </ModuleCard>
  );
}

/** Canvas strip of the engine's 1 Hz correlation history. */
function CorrelationHistory() {
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
      const mid = h / 2;
      ctx.strokeStyle = "rgba(255,255,255,0.14)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, mid);
      ctx.lineTo(w, mid);
      ctx.stroke();

      const history = getEngine().getCorrelationHistory();
      if (history.length > 1) {
        const step = w / (history.length - 1);
        for (let i = 1; i < history.length; i++) {
          const a = history[i - 1];
          const b = history[i];
          const yA = mid - (a * (h - 6)) / 2;
          const yB = mid - (b * (h - 6)) / 2;
          ctx.strokeStyle =
            (a + b) / 2 < 0 ? "rgba(255,92,82,0.95)" : "rgba(47,181,181,0.9)";
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo((i - 1) * step, yA);
          ctx.lineTo(i * step, yB);
          ctx.stroke();
        }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <canvas
      ref={canvasRef}
      className="panel-well mt-3 h-[64px] w-full rounded-md"
      aria-label="Correlation history, one point per second"
    />
  );
}
