import logo from "@/assets/logo.svg";
import { cn } from "@/lib/utils";

/**
 * Branded boot surface shown while the first route chunk loads. Kept
 * dependency-free (CSS animation only) so it can render before the audio
 * engine, fonts or app providers have initialised.
 */
export function SplashScreen({
  label = "Calibrating signal path",
  className,
}: {
  label?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "splash-screen relative flex min-h-[100svh] w-full flex-col items-center justify-center overflow-hidden px-6 py-20",
        className,
      )}
      role="status"
      aria-label={`Signalpath — ${label}`}
    >
      <div
        aria-hidden
        className="splash-grid pointer-events-none absolute inset-0"
      />
      <div
        aria-hidden
        className="splash-wash pointer-events-none absolute inset-0"
      />

      <div
        aria-hidden
        className="pointer-events-none absolute inset-4 sm:inset-7"
      >
        <span className="absolute top-0 left-0 h-5 w-5 border-t border-l border-foreground/15" />
        <span className="absolute top-0 right-0 h-5 w-5 border-t border-r border-foreground/15" />
        <span className="absolute bottom-0 left-0 h-5 w-5 border-b border-l border-foreground/15" />
        <span className="absolute right-0 bottom-0 h-5 w-5 border-r border-b border-foreground/15" />
      </div>

      <div className="relative flex flex-col items-center text-center">
        <div className="splash-mark">
          <span aria-hidden className="splash-mark-halo" />
          <span aria-hidden className="splash-mark-ring" />
          <img
            src={logo}
            alt=""
            width={76}
            height={76}
            className="relative z-10 rounded-[22%] shadow-[0_18px_44px_-18px_rgba(8,11,17,0.6)] ring-1 ring-black/10"
          />
        </div>

        <p className="mt-8 text-[1.7rem] font-semibold tracking-[-0.045em] text-foreground">
          Signalpath
        </p>
        <p className="mt-2.5 flex items-center gap-2.5 text-[9px] font-semibold tracking-[0.28em] text-muted-foreground uppercase">
          <span aria-hidden className="h-px w-5 bg-signal/60" />
          Precision broadcast audio
          <span aria-hidden className="h-px w-5 bg-signal/60" />
        </p>

        <div className="mt-10 flex w-64 flex-col items-center">
          <div className="splash-track h-[2px] w-full overflow-hidden rounded-full">
            <span
              aria-hidden
              className="splash-bar block h-full w-[42%] rounded-full"
            />
          </div>
          <div className="mt-4 flex items-center gap-2.5">
            <span
              aria-hidden
              className="splash-led size-1.5 rounded-full bg-signal"
            />
            <span className="text-[9.5px] font-medium tracking-[0.2em] text-muted-foreground uppercase">
              {label}
            </span>
          </div>
        </div>
      </div>

      <div className="absolute inset-x-0 bottom-7 flex flex-wrap items-center justify-center gap-x-3 gap-y-1.5 px-6">
        <span className="text-[8.5px] font-medium tracking-[0.22em] text-muted-foreground uppercase">
          48 kHz · 32-bit float
        </span>
        <span aria-hidden className="hidden h-px w-6 bg-border sm:block" />
        <span className="hidden text-[8.5px] font-medium tracking-[0.22em] text-muted-foreground uppercase sm:inline">
          EBU R128
        </span>
      </div>
    </div>
  );
}
