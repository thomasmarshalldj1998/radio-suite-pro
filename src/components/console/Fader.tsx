import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";

export interface FaderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  format?: (v: number) => string;
  onChange: (v: number) => void;
  disabled?: boolean;
  /** Height of the fader track in px. */
  height?: number;
  /** Show dB tick marks beside the track. */
  ticks?: boolean;
  accent?: boolean;
  className?: string;
}

/**
 * Vertical channel fader. Used across the EQ bank and dynamics strips.
 * The readout sits above the cap; tick marks flank the travel.
 */
export function Fader({
  label,
  value,
  min,
  max,
  step = 0.1,
  format,
  onChange,
  disabled = false,
  height = 148,
  ticks = true,
  accent = false,
  className,
}: FaderProps) {
  const display = format ? format(value) : value.toFixed(1);
  const neutralPct =
    min < 0 && max > 0 ? ((0 - min) / (max - min)) * 100 : null;

  return (
    <div className={cn("flex w-10 flex-col items-center gap-1.5", className)}>
      <div
        className={cn(
          "text-readout text-[10px] leading-none",
          accent ? "text-signal" : "text-foreground/85",
        )}
      >
        {display}
      </div>
      <div className="relative flex w-full justify-center" style={{ height }}>
        {ticks && (
          <div className="pointer-events-none absolute inset-y-0 left-0 w-full">
            {[0, 25, 50, 75, 100].map((pct) => (
              <div
                key={pct}
                className="absolute left-0 h-px w-1.5 bg-foreground/15"
                style={{ top: `${pct}%` }}
              />
            ))}
            {neutralPct !== null && (
              <div
                className="absolute left-0 h-px w-full bg-foreground/10"
                style={{ top: `${100 - neutralPct}%` }}
              />
            )}
          </div>
        )}
        <Slider
          orientation="vertical"
          value={[value]}
          min={min}
          max={max}
          step={step}
          disabled={disabled}
          onValueChange={(v) => onChange(v[0])}
          className="h-full"
          aria-label={label}
        />
      </div>
      <div className="text-[9px] font-medium tracking-[0.06em] text-muted-foreground uppercase">
        {label}
      </div>
    </div>
  );
}
