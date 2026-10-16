import { cn } from "@/lib/utils";

/* ── segmented control — [ON] [BYPASS] style switches ───────────────────── */

export interface SegOption<T extends string> {
  value: T;
  label: string;
}

export function Seg<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  className,
}: {
  value: T;
  options: SegOption<T>[];
  onChange: (v: T) => void;
  ariaLabel?: string;
  className?: string;
}) {
  return (
    <span
      role="group"
      aria-label={ariaLabel}
      className={cn(
        "inline-flex shrink-0 overflow-hidden rounded border border-border/70",
        className,
      )}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          aria-pressed={value === o.value}
          className={cn(
            "px-2 py-1 text-[10px] leading-4 font-semibold tracking-[0.08em] uppercase transition-colors",
            value === o.value
              ? "bg-signal text-signal-fg"
              : "text-muted-foreground hover:bg-accent hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </span>
  );
}

/* ── control row — aligned label / control strip inside a panel ─────────── */

export function CtrlRow({
  label,
  children,
  className,
}: {
  label: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        // phones: label above, controls wrap beneath so dense rows never
        // push the card wider than the viewport; ≥sm restores the inline strip
        "flex flex-col gap-1 px-3 py-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3",
        className,
      )}
    >
      <span className="text-[10px] font-semibold tracking-[0.1em] text-muted-foreground uppercase sm:w-24 sm:shrink-0">
        {label}
      </span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1.5 sm:justify-end">
        {children}
      </div>
    </div>
  );
}

/* ── numeric readout — white value, tabular, 2 decimal places ───────────── */

export function Val({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "text-readout min-w-14 text-right text-[11px] font-medium whitespace-nowrap text-white",
        className,
      )}
    >
      {children}
    </span>
  );
}
