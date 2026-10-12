import { cn } from "@/lib/utils";
import { useCallback, useRef, useState } from "react";

export interface KnobProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  size?: number;
  /** Arc centers on the neutral point (e.g. 0 dB) instead of the minimum. */
  bipolar?: boolean;
  format?: (v: number) => string;
  onChange: (v: number) => void;
  onReset?: () => void;
  disabled?: boolean;
  accent?: boolean;
  className?: string;
}

const START_ANGLE = -135;
const END_ANGLE = 135;

function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const rad = (deg * Math.PI) / 180;
  return [cx + r * Math.sin(rad), cy - r * Math.cos(rad)];
}

function arcPath(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const [x0, y0] = polar(cx, cy, r, a0);
  const [x1, y1] = polar(cx, cy, r, a1);
  const large = Math.abs(a1 - a0) > 180 ? 1 : 0;
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

/**
 * Precision rotary control: pointer drag (Shift = fine), wheel steps,
 * arrow keys, double-click to reset. Angle sweep is a broadcast-standard
 * 270° with an illuminated value arc.
 */
export function Knob({
  label,
  value,
  min,
  max,
  step = 0.1,
  size = 52,
  bipolar = false,
  format,
  onChange,
  onReset,
  disabled = false,
  accent = false,
  className,
}: KnobProps) {
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ y: number; start: number } | null>(null);

  const t = (value - min) / (max - min);
  const neutral = bipolar ? (0 - min) / (max - min) : 0;
  const angle = START_ANGLE + t * (END_ANGLE - START_ANGLE);
  const neutralAngle = START_ANGLE + neutral * (END_ANGLE - START_ANGLE);

  const clamp = useCallback(
    (v: number) => {
      const q = Math.round((v - min) / step) * step + min;
      return Math.min(max, Math.max(min, q));
    },
    [min, max, step],
  );

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (disabled) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { y: e.clientY, start: value };
    setDragging(true);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || disabled) return;
    const fine = e.shiftKey ? 0.25 : 1;
    const delta = ((drag.y - e.clientY) / 180) * (max - min) * fine;
    onChange(clamp(drag.start + delta));
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    dragRef.current = null;
    setDragging(false);
  };

  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    if (disabled) return;
    e.preventDefault();
    const dir = e.deltaY > 0 ? -1 : 1;
    onChange(clamp(value + dir * step * (e.shiftKey ? 5 : 1)));
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const big = step * 10;
    let next: number | null = null;
    if (e.key === "ArrowUp" || e.key === "ArrowRight") next = value + step;
    if (e.key === "ArrowDown" || e.key === "ArrowLeft") next = value - step;
    if (e.key === "PageUp") next = value + big;
    if (e.key === "PageDown") next = value - big;
    if (e.key === "Home") next = min;
    if (e.key === "End") next = max;
    if (next !== null) {
      e.preventDefault();
      onChange(clamp(next));
    }
  };

  const r = size / 2;
  const stroke = 4;
  const arcR = r - stroke / 2 - 1;
  const display = format ? format(value) : value.toFixed(1);

  return (
    <div className={cn("flex flex-col items-center gap-1.5 select-none", className)}>
      <div
        role="slider"
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={display}
        aria-disabled={disabled}
        tabIndex={disabled ? -1 : 0}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onWheel={handleWheel}
        onKeyDown={handleKeyDown}
        onDoubleClick={() => !disabled && onReset?.()}
        className={cn(
          "relative rounded-full touch-none outline-none",
          "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card",
          disabled ? "opacity-40" : dragging ? "cursor-grabbing" : "cursor-grab",
        )}
        style={{ width: size, height: size }}
      >
        <svg width={size} height={size} className="absolute inset-0 -rotate-0">
          <path
            d={arcPath(r, r, arcR, START_ANGLE, END_ANGLE)}
            fill="none"
            stroke="oklch(0.9 0.01 265 / 0.35)"
            strokeWidth={stroke}
            strokeLinecap="round"
          />
          <path
            d={arcPath(
              r,
              r,
              arcR,
              Math.min(neutralAngle, angle),
              Math.max(neutralAngle, angle),
            )}
            fill="none"
            stroke={accent ? "#ef5b2b" : "oklch(0.35 0.02 265 / 0.85)"}
            strokeWidth={stroke}
            strokeLinecap="round"
          />
        </svg>
        {/* knob cap */}
        <div
          className="absolute rounded-full border border-black/10"
          style={{
            inset: stroke + 3,
            background:
              "radial-gradient(120% 120% at 30% 22%, oklch(0.34 0.014 265) 0%, oklch(0.25 0.014 265) 58%, oklch(0.21 0.014 265) 100%)",
            boxShadow:
              "0 2px 6px oklch(0.2 0.02 265 / 0.35), inset 0 1px 0 oklch(1 0 0 / 14%)",
          }}
        />
        {/* pointer */}
        <div
          className="absolute left-1/2 top-1/2 origin-bottom"
          style={{
            width: 2,
            height: (size - stroke * 2 - 12) / 2,
            transform: `translate(-50%, -100%) rotate(${angle}deg)`,
            transformOrigin: "50% 100%",
            top: "50%",
            marginTop: -(size - stroke * 2 - 12) / 2 + 0.5,
            borderRadius: 2,
            background: accent ? "#f6f7f9" : "oklch(0.93 0.005 265)",
            boxShadow: accent ? "0 0 6px oklch(0.645 0.19 32 / 0.7)" : "none",
          }}
        />
      </div>
      <div className="text-center">
        <div
          className={cn(
            "text-readout text-[10px] leading-none",
            accent ? "text-signal" : "text-foreground/80",
          )}
        >
          {display}
        </div>
        <div className="mt-1 text-[9px] font-medium tracking-[0.08em] text-muted-foreground uppercase">
          {label}
        </div>
      </div>
    </div>
  );
}
