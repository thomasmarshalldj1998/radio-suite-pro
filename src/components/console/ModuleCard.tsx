import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

export interface ModuleCardProps {
  title: string;
  subtitle?: string;
  /** Bypass LED state; omit `enabled` for a static module. */
  enabled?: boolean;
  onToggle?: () => void;
  /** Right-aligned controls in the module header. */
  right?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}

/**
 * A processor module in the rack: title bar with status LED and bypass
 * switch, soft layered card body. Used across the console tab.
 */
export function ModuleCard({
  title,
  subtitle,
  enabled,
  onToggle,
  right,
  children,
  className,
  bodyClassName,
}: ModuleCardProps) {
  return (
    <section
      className={cn(
        "card-layer flex flex-col rounded-xl border border-border/70 bg-card",
        className,
      )}
    >
      <header className="flex items-center gap-3 border-b border-border/60 px-4 py-3">
        <span
          className={cn("led", enabled ? "led-on" : undefined)}
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <h3 className="text-[11px] font-semibold tracking-[0.12em] text-foreground/90 uppercase">
            {title}
          </h3>
          {subtitle && (
            <p className="mt-0.5 truncate text-[10px] text-muted-foreground">
              {subtitle}
            </p>
          )}
        </div>
        {right}
        {enabled !== undefined && onToggle && (
          <Switch
            checked={enabled}
            onCheckedChange={onToggle}
            aria-label={`${enabled ? "Bypass" : "Enable"} ${title}`}
            className="cursor-pointer"
          />
        )}
      </header>
      <div className={cn("flex-1 p-4", bodyClassName)}>{children}</div>
    </section>
  );
}
