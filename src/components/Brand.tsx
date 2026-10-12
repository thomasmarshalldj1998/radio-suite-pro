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
        className="rounded-[22%] shadow-[0_2px_8px_-2px_rgba(16,24,40,0.35)]"
      />
      <div className="leading-none">
        <p
          className="font-semibold tracking-tight"
          style={{ fontSize: Math.round(size * 0.46) }}
        >
          Signalpath
        </p>
        {tagline && (
          <p className="mt-1 text-[9px] font-medium tracking-[0.16em] text-muted-foreground uppercase">
            {tagline}
          </p>
        )}
      </div>
    </div>
  );
}
