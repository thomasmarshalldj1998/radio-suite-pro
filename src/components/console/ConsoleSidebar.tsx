import { cn } from "@/lib/utils";
import { APP_NAME } from "@/lib/version";
import { ChevronsLeft, ChevronsRight, TriangleAlert } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { TabId } from "@/pages/Dashboard";

/** Sidebar groups: console pages first, station pages second. */
const GROUP_OF: Record<TabId, "Console" | "Station"> = {
  overview: "Console",
  compact: "Console",
  dsp: "Console",
  presets: "Console",
  stations: "Station",
  telemetry: "Station",
};

export interface ConsoleNavItem {
  id: TabId;
  label: string;
  hint: string;
  icon: LucideIcon;
}

/**
 * Station sidebar — collapsible left rail for station-level navigation:
 * station identity with the active preset, the console pages, a live
 * engine status line and the collapse toggle. Desktop only; phones use
 * the horizontal page strip instead.
 */
export function ConsoleSidebar({
  tab,
  items,
  onSelect,
  phaseLabel,
  phaseLed,
  activePreset,
  dirty,
  error,
  top,
  collapsed,
  onToggleCollapsed,
}: {
  tab: TabId;
  items: ConsoleNavItem[];
  onSelect: (t: TabId) => void;
  phaseLabel: string;
  /** LED class for the engine phase (e.g. "led-on", "led-warn"). */
  phaseLed: string;
  activePreset: string;
  dirty: boolean;
  /** Engine failure summary — rendered as a scannable alert box. */
  error?: string | null;
  /** Sticky offset below the engine header. */
  top: number;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}) {
  return (
    <aside
      aria-label="Station navigation"
      style={{ top }}
      className={cn(
        "sticky hidden shrink-0 flex-col self-start border-r border-rack-line pt-4 pb-6 lg:flex",
        collapsed ? "w-16" : "w-52",
      )}
    >
      {/* ── station identity ── */}
      <div className={cn(collapsed ? "px-0" : "px-4", "pb-2")}>
        {collapsed ? (
          <p
            className="text-center text-[9px] font-bold tracking-[0.18em] text-rack-mut uppercase"
            title={APP_NAME}
          >
            SP
          </p>
        ) : (
          <>
            <p className="text-[9px] font-semibold tracking-[0.2em] text-rack-mut uppercase">
              Station
            </p>
            <p className="mt-1 truncate text-[13px] font-semibold text-white">
              {APP_NAME}
            </p>
            <p
              className="mt-0.5 flex items-center gap-1.5 truncate text-[10px] text-rack-mut"
              title={activePreset}
            >
              <span className="min-w-0 flex-1 truncate">{activePreset}</span>
              {dirty && (
                <span
                  className="size-1.5 shrink-0 rounded-full bg-amber-led shadow-[0_0_6px_rgba(255,204,0,0.8)]"
                  title="Preset modified"
                />
              )}
            </p>
          </>
        )}
      </div>

      {/* ── console pages, grouped: console first, station second ── */}
      <ul className="flex flex-col gap-0.5 px-2">
        {items.map((t, i) => {
          const Icon = t.icon;
          const active = tab === t.id;
          const group = GROUP_OF[t.id];
          const prevGroup = i > 0 ? GROUP_OF[items[i - 1].id] : null;
          const groupHead = !collapsed && group !== prevGroup;
          return (
            <li key={t.id}>
              {groupHead && (
                <p className="px-2.5 pt-2 pb-1 text-[9px] font-bold tracking-[0.2em] text-rack-mut/80 uppercase">
                  {group}
                </p>
              )}
              {i > 0 && group !== prevGroup && collapsed && (
                <span aria-hidden className="mx-auto my-1 block h-px w-8 bg-rack-line" />
              )}
              <button
                type="button"
                onClick={() => onSelect(t.id)}
                aria-current={active ? "page" : undefined}
                title={collapsed ? `${t.label} — ${t.hint}` : t.hint}
                className={cn(
                  "group flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2.5 text-left transition-colors",
                  collapsed && "justify-center px-0",
                  active
                    ? "bg-signal/15 font-bold text-white shadow-[inset_3px_0_0_0_var(--color-signal)]"
                    : "text-rack-mut hover:bg-white/5 hover:text-rack-fg",
                )}
              >
                <Icon
                  className={cn(
                    "size-4 shrink-0",
                    active && "text-signal",
                  )}
                />
                {!collapsed && (
                  <span className="min-w-0">
                    <span
                      className={cn(
                        "block text-[11px] tracking-[0.12em] uppercase",
                        active ? "font-bold" : "font-semibold",
                      )}
                    >
                      {t.label}
                    </span>
                    <span className="mt-0.5 block truncate text-[9px] leading-3.5 text-rack-mut group-hover:text-rack-fg">
                      {t.hint}
                    </span>
                  </span>
                )}
                {!collapsed && active && (
                  <span className="mt-1.5 ml-auto size-1.5 shrink-0 rounded-full bg-signal shadow-[0_0_8px_rgba(229,169,59,0.9)]" />
                )}
              </button>
            </li>
          );
        })}
      </ul>

      {/* ── engine failure summary — icon + headline, never raw text alone ── */}
      {error && !collapsed && (
        <div className="mx-2 mt-3 flex items-start gap-2 rounded-md border border-meter-hot/50 bg-meter-hot/10 px-2.5 py-2">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-meter-hot" aria-hidden />
          <div className="min-w-0">
            <p className="text-[10px] font-bold tracking-[0.12em] text-meter-hot uppercase">
              Engine error
            </p>
            <p className="mt-0.5 line-clamp-3 text-[10px] leading-4 text-rack-fg" title={error}>
              {error}
            </p>
          </div>
        </div>
      )}

      {/* ── engine status + collapse ── */}
      <div className={cn("mt-auto px-2 pt-4", collapsed && "px-2")}>
        <div
          className={cn(
            "rounded border border-rack-line bg-[#15181d] px-3 py-2.5",
            collapsed && "flex justify-center px-0",
          )}
          title={collapsed ? `Engine ${phaseLabel}` : undefined}
        >
          <p
            className={cn(
              "flex items-center gap-2 text-[11px] font-semibold text-white",
              collapsed && "justify-center",
            )}
          >
            <span className={cn("led size-1.5", phaseLed)} aria-hidden />
            {!collapsed && phaseLabel}
          </p>
          {!collapsed && (
            <p className="mt-1 truncate text-[10px] text-rack-mut">
              6-band LR4 · 4× guard
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={onToggleCollapsed}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className={cn(
            "mt-2 flex w-full cursor-pointer items-center gap-1.5 rounded-md border border-rack-line px-2.5 py-2 text-[10px] font-semibold tracking-[0.12em] text-rack-mut uppercase transition-colors hover:bg-white/5 hover:text-rack-fg",
            collapsed ? "justify-center px-0" : "justify-start",
          )}
        >
          {collapsed ? (
            <ChevronsRight className="size-3.5" />
          ) : (
            <>
              <ChevronsLeft className="size-3.5" />
              Collapse
            </>
          )}
        </button>
      </div>
    </aside>
  );
}
