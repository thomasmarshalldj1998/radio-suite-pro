import logo from "@/assets/logo.svg";
import { cn } from "@/lib/utils";

export function Brand({
  size = 30,
  tagline,
  className,
}: {
  size?: number;
  tagline?: string;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center gap-2.5", className)}>
      <img
        src={logo}
        alt=""
        width={size}
        height={size}
        className="rounded-[22%] shadow-[0_2px_8px_-2px_rgba(16,24,40,0.35)] ring-1 ring-black/5 dark:ring-white/10"
      />
      <div className="leading-none">
        <p
          className="font-semibold tracking-[-0.035em]"
          style={{ fontSize: Math.round(size * 0.46) }}
        >
          Signalpath
        </p>
        {tagline && (
          <p className="mt-1.5 flex items-center gap-1.5 text-[8.5px] font-medium tracking-[0.18em] text-muted-foreground uppercase">
            <span aria-hidden className="h-px w-2.5 shrink-0 bg-signal/70" />
            {tagline}
          </p>
        )}
      </div>
    </div>
  );
}
