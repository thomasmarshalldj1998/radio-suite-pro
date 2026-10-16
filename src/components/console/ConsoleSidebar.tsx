import { cn } from "@/lib/utils";
import { APP_NAME } from "@/lib/version";
import { ChevronsLeft, ChevronsRight } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { TabId } from "@/pages/Dashboard";

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

      {/* ── console pages ── */}
      {!collapsed && (
        <p className="px-4 pt-2 pb-2 text-[9px] font-semibold tracking-[0.2em] text-rack-mut uppercase">
          Pages
        </p>
      )}
      <ul className="flex flex-col gap-0.5 px-2">
        {items.map((t) => {
          const Icon = t.icon;
          const active = tab === t.id;
          return (
            <li key={t.id}>
              <button
                type="button"
                onClick={() => onSelect(t.id)}
                aria-current={active ? "page" : undefined}
                title={collapsed ? `${t.label} — ${t.hint}` : t.hint}
                className={cn(
                  "group flex w-full cursor-pointer items-center gap-2.5 rounded px-2.5 py-2 text-left transition-colors",
                  collapsed && "justify-center px-0",
                  active
                    ? "bg-cyan-400/10 text-cyan-300 shadow-[inset_2px_0_0_0_#22d3ee]"
                    : "text-rack-mut hover:bg-white/5 hover:text-rack-fg",
                )}
              >
                <Icon className="size-4 shrink-0" />
                {!collapsed && (
                  <span className="min-w-0">
                    <span className="block text-[11px] font-semibold tracking-[0.12em] uppercase">
                      {t.label}
                    </span>
                    <span className="mt-0.5 block truncate text-[9px] leading-3.5 text-rack-mut group-hover:text-rack-fg">
                      {t.hint}
                    </span>
                  </span>
                )}
                {!collapsed && active && (
                  <span className="mt-1.5 ml-auto size-1.5 shrink-0 rounded-full bg-cyan-300 shadow-[0_0_8px_rgba(34,211,238,0.8)]" />
                )}
              </button>
            </li>
          );
        })}
      </ul>

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
          className="mt-2 flex w-full cursor-pointer items-center justify-center gap-1.5 rounded border border-rack-line px-2 py-2 text-[10px] font-semibold tracking-[0.12em] text-rack-mut uppercase transition-colors hover:bg-white/5 hover:text-rack-fg"
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
