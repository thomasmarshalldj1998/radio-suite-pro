/**
 * Digital console controls — exact numbers in, exact curves out.
 *
 * DigitalCtrl replaces the rotary knob: slider for travel, −/+ steppers for
 * single-step precision, and a type-in readout that commits on Enter/blur
 * (clamped to range, rounded to step). Double-click the label resets.
 *
 * TransferCurve draws what a dynamics stage is doing: the exact static
 * transfer computed from your threshold/ratio/knee/ceiling, plus a live
 * operating dot from the meters. The curve is exact; the dot is
 * approximate (meter ballistics), and captioned as such.
 */
import { useEffect, useRef, useState } from "react";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";

export { compCurve, limitCurve } from "@/lib/audio/tools";

export function DigitalCtrl({
  label,
  value,
  min,
  max,
  step = 0.1,
  bipolar = false,
  format,
  onChange,
  onReset,
  disabled = false,
  className,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  bipolar?: boolean;
  format: (v: number) => string;
  onChange: (v: number) => void;
  onReset?: () => void;
  disabled?: boolean;
  className?: string;
}) {
  const [text, setText] = useState<string | null>(null);
  const decimals = Math.max(0, Math.ceil(-Math.log10(step)));

  const commit = (raw: string) => {
    const n = Number(raw);
    if (Number.isFinite(n)) {
      const clamped = Math.min(max, Math.max(min, n));
      const stepped = Math.round(clamped / step) * step;
      onChange(Math.round(stepped * 10 ** decimals) / 10 ** decimals);
    }
    setText(null);
  };

  const nudge = (dir: 1 | -1) => {
    const next = Math.min(
      max,
      Math.max(min, Math.round((value + dir * step) * 10 ** decimals) / 10 ** decimals),
    );
    onChange(next);
  };

  return (
    <div
      className={cn(
        "flex w-44 shrink-0 flex-col gap-1",
        disabled && "pointer-events-none opacity-40",
        className,
      )}
    >
      <button
        type="button"
        className="self-start text-[10px] font-semibold tracking-[0.1em] text-muted-foreground uppercase hover:text-foreground"
        title={onReset ? "Double-click to reset" : label}
        onDoubleClick={onReset}
      >
        {label}
      </button>
      <div className="relative">
        <Slider
          min={min}
          max={max}
          step={step}
          value={[value]}
          onValueChange={([v]) => onChange(v)}
          aria-label={label}
        />
        {bipolar && (
          <span
            className="pointer-events-none absolute top-1/2 h-3 w-px -translate-y-1/2 bg-border"
            style={{ left: `${((0 - min) / (max - min)) * 100}%` }}
          />
        )}
      </div>
      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-label={`Decrease ${label}`}
          onClick={() => nudge(-1)}
          className="h-6 w-6 shrink-0 rounded border border-border/60 font-mono text-[12px] text-muted-foreground hover:bg-muted/40 hover:text-foreground"
        >
          −
        </button>
        <input
          type="number"
          aria-label={`${label} exact value`}
          className="h-6 min-w-0 flex-1 rounded border border-border/60 bg-background px-1 text-right font-mono text-[11px] text-foreground tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
          min={min}
          max={max}
          step={step}
          value={text ?? String(Math.round(value * 10 ** decimals) / 10 ** decimals)}
          onChange={(e) => setText(e.target.value)}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit((e.target as HTMLInputElement).value);
            if (e.key === "Escape") setText(null);
          }}
        />
        <button
          type="button"
          aria-label={`Increase ${label}`}
          onClick={() => nudge(1)}
          className="h-6 w-6 shrink-0 rounded border border-border/60 font-mono text-[12px] text-muted-foreground hover:bg-muted/40 hover:text-foreground"
        >
          +
        </button>
        <span className="w-16 shrink-0 truncate text-right font-mono text-[10px] text-muted-foreground tabular-nums">
          {format(value)}
        </span>
      </div>
    </div>
  );
}

const DOM_LO = -60;
const DOM_HI = 5;

export function TransferCurve({
  title,
  subtitle,
  curve,
  inputDb,
  grDb,
  live,
}: {
  title: string;
  subtitle: string;
  curve: (xDb: number) => number;
  /** Approximate stage input level (dB) — NaN hides the dot. */
  inputDb: number;
  /** Live gain reduction (dB, positive number). */
  grDb: number;
  live: boolean;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w === 0 || h === 0) return;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    const padL = 30;
    const padB = 14;
    const padT = 6;
    const padR = 8;
    const iw = w - padL - padR;
    const ih = h - padT - padB;
    const X = (db: number) =>
      padL + ((db - DOM_LO) / (DOM_HI - DOM_LO)) * iw;
    const Y = (db: number) =>
      padT + (1 - (db - DOM_LO) / (DOM_HI - DOM_LO)) * ih;

    // grid + axis labels every 10 dB
    ctx.font = "8px ui-monospace, monospace";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (let db = -60; db <= 0; db += 10) {
      ctx.strokeStyle = "rgba(38,42,53,0.9)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padL, Y(db));
      ctx.lineTo(w - padR, Y(db));
      ctx.stroke();
      ctx.fillStyle = "#6b7280";
      ctx.fillText(`${db}`, padL - 4, Y(db));
      ctx.beginPath();
      ctx.moveTo(X(db), padT);
      ctx.lineTo(X(db), h - padB);
      ctx.stroke();
    }

    // unity reference
    ctx.strokeStyle = "rgba(107,114,128,0.55)";
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(X(DOM_LO), Y(DOM_LO));
    ctx.lineTo(X(DOM_HI), Y(DOM_HI));
    ctx.stroke();
    ctx.setLineDash([]);

    // the transfer itself — exact from your settings
    ctx.strokeStyle = "#f5a524";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let px = 0; px <= iw; px += 1) {
      const db = DOM_LO + (px / iw) * (DOM_HI - DOM_LO);
      const y = curve(db);
      const cx = padL + px;
      const cy = Y(Math.min(DOM_HI, Math.max(DOM_LO, y)));
      if (px === 0) ctx.moveTo(cx, cy);
      else ctx.lineTo(cx, cy);
    }
    ctx.stroke();

    // live operating dot — approximate (meter ballistics)
    if (live && Number.isFinite(inputDb) && inputDb > DOM_LO) {
      const xi = Math.min(DOM_HI, inputDb);
      const yo = Math.min(DOM_HI, Math.max(DOM_LO, xi - Math.max(0, grDb)));
      ctx.strokeStyle = "rgba(45,212,191,0.5)";
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(X(xi), padT);
      ctx.lineTo(X(xi), h - padB);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "#2dd4bf";
      ctx.beginPath();
      ctx.arc(X(xi), Y(yo), 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }, [curve, inputDb, grDb, live]);

  return (
    <div className="mt-2 rounded border border-border/60 px-2.5 py-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <p className="text-[8px] font-semibold tracking-[0.12em] text-panel-mut uppercase">
          {title}
        </p>
        <p className="text-[8px] text-muted-foreground">{subtitle}</p>
      </div>
      <canvas ref={ref} className="mt-1 h-[132px] w-full" />
    </div>
  );
}
