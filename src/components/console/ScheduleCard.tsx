import { ModuleCard } from "@/components/console/ModuleCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  useRemoveSchedule,
  useSaveSchedule,
  useSchedules,
  useSetScheduleEnabled,
} from "@/lib/backend/hooks";
import type { ScheduleRecord } from "@/lib/backend/types";
import type { ProcessorParams } from "@/lib/audio/params";
import {
  DAY_SHORT,
  describeDays,
  formatMinute,
  nextSchedule,
  parseMinute,
  resolveActiveSchedule,
} from "@/lib/audio/scheduler";
import { cn } from "@/lib/utils";
import { CalendarClock, Clock, Pencil, Plus, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

interface Draft {
  id?: string;
  name: string;
  presetName: string;
  days: number[];
  start: string;
  end: string;
  enabled: boolean;
}

const emptyDraft = (presetName: string): Draft => ({
  name: "",
  presetName,
  days: [1, 2, 3, 4, 5],
  start: "06:00",
  end: "10:00",
  enabled: true,
});

/**
 * DAYPARTING — swap the whole chain by day and time of day.
 *
 * Each slot stores a full parameter snapshot, so a slot keeps working even if
 * the preset library changes underneath it. The Dashboard applies the live
 * slot; this panel is where the schedule is written.
 */
export function ScheduleCard({
  params,
  activeName,
  className,
}: {
  params: ProcessorParams;
  activeName: string;
  className?: string;
}) {
  const schedules = useSchedules();
  const saveSchedule = useSaveSchedule();
  const removeSchedule = useRemoveSchedule();
  const setEnabled = useSetScheduleEnabled();
  const [draft, setDraft] = useState<Draft>(() => emptyDraft(activeName));

  // keep the draft's preset name tracking the live chain until the operator
  // types their own
  useEffect(() => {
    setDraft((d) =>
      d.id === undefined && d.presetName === "" ? { ...d, presetName: activeName } : d,
    );
  }, [activeName]);

  const active = resolveActiveSchedule(schedules as ScheduleRecord[] | undefined);
  const next = nextSchedule(schedules as ScheduleRecord[] | undefined);

  const save = async () => {
    const start = parseMinute(draft.start);
    const end = parseMinute(draft.end);
    if (!draft.name.trim()) {
      toast.error("Name the slot (e.g. “Breakfast”)");
      return;
    }
    if (start === null || end === null) {
      toast.error("Times must be HH:MM");
      return;
    }
    try {
      await saveSchedule({
        id: draft.id,
        name: draft.name,
        days: draft.days,
        startMin: start,
        endMin: end,
        presetName: draft.presetName.trim() || activeName,
        // snapshot the live chain so the slot is self-contained
        params: JSON.parse(JSON.stringify(params)) as unknown,
        enabled: draft.enabled,
      });
      toast.success(draft.id ? "Slot updated" : `“${draft.name.trim()}” scheduled`);
      setDraft(emptyDraft(activeName));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save the slot");
    }
  };

  const edit = (slot: ScheduleRecord) => {
    setDraft({
      id: slot._id,
      name: slot.name,
      presetName: slot.presetName,
      days: slot.days,
      start: formatMinute(slot.startMin),
      end: formatMinute(slot.endMin),
      enabled: slot.enabled,
    });
  };

  return (
    <ModuleCard
      className={className}
      title="Dayparting"
      subtitle="Preset slots by day and time of day · the live slot is applied automatically"
      right={
        <span className="flex items-center gap-1.5 text-[10px] tracking-[0.1em] text-panel-mut uppercase">
          <CalendarClock className="size-3.5" />
          {active ? `live: ${active.name}` : next ? `next: ${next.slot.name}` : "empty"}
        </span>
      }
    >
      {/* ── slot list ── */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border/60 text-left text-[10px] font-semibold tracking-[0.1em] text-muted-foreground uppercase">
              <th className="px-3 py-2 font-semibold">Slot</th>
              <th className="px-3 py-2 font-semibold">Days</th>
              <th className="px-3 py-2 font-semibold">Window</th>
              <th className="hidden px-3 py-2 font-semibold md:table-cell">Preset</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {(schedules ?? []).map((slot) => {
              const isLive = active?._id === slot._id;
              return (
                <tr
                  key={slot._id}
                  className={cn(
                    "transition-colors hover:bg-muted/40",
                    !slot.enabled && "opacity-55",
                  )}
                >
                  <td className="px-3 py-2.5">
                    <span className="flex items-center gap-2 text-[13px] font-medium">
                      <span
                        className={cn("led size-1.5", isLive ? "led-on" : "")}
                      />
                      {slot.name}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-xs text-muted-foreground">
                    {describeDays(slot.days)}
                  </td>
                  <td className="text-readout px-3 py-2.5 text-xs">
                    {formatMinute(slot.startMin)}–{formatMinute(slot.endMin)}
                  </td>
                  <td className="hidden px-3 py-2.5 text-xs md:table-cell">
                    {slot.presetName}
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex items-center justify-end gap-1">
                      <Switch
                        checked={slot.enabled}
                        onCheckedChange={(v) => void setEnabled(slot._id, v)}
                        aria-label={`Enable ${slot.name}`}
                      />
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 cursor-pointer px-2"
                        onClick={() => edit(slot)}
                        aria-label={`Edit ${slot.name}`}
                      >
                        <Pencil className="size-3.5" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 cursor-pointer px-2 text-destructive hover:text-destructive"
                        onClick={() => {
                          void removeSchedule(slot._id).then(() =>
                            toast.success(`${slot.name} removed`),
                          );
                        }}
                        aria-label={`Delete ${slot.name}`}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {(schedules ?? []).length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-8 text-center">
                  <p className="text-sm font-medium">No slots scheduled</p>
                  <p className="mx-auto mt-1 max-w-md text-xs text-muted-foreground">
                    Add a slot and it will be stored with a snapshot of the chain
                    you have dialled in right now — the console switches to it
                    when the clock reaches the window and logs every change.
                  </p>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* ── editor ── */}
      <div className="mt-3 rounded-md border border-border/60 p-3">
        <div className="flex items-center justify-between gap-3">
          <p className="text-[9px] font-semibold tracking-[0.14em] text-panel-mut uppercase">
            {draft.id ? "Edit slot" : "New slot"}
          </p>
          {draft.id && (
            <Button
              size="sm"
              variant="ghost"
              className="h-6 cursor-pointer px-2 text-[11px]"
              onClick={() => setDraft(emptyDraft(activeName))}
            >
              <X className="size-3.5" /> Cancel edit
            </Button>
          )}
        </div>

        <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <Input
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            placeholder="Breakfast"
            aria-label="Slot name"
            className="h-8 text-[12px]"
          />
          <Input
            value={draft.presetName}
            onChange={(e) => setDraft({ ...draft, presetName: e.target.value })}
            placeholder={activeName}
            aria-label="Preset name for the slot"
            className="h-8 text-[12px]"
          />
          <Input
            value={draft.start}
            onChange={(e) => setDraft({ ...draft, start: e.target.value })}
            placeholder="06:00"
            aria-label="Start time HH:MM"
            className="h-8 text-[12px]"
          />
          <Input
            value={draft.end}
            onChange={(e) => setDraft({ ...draft, end: e.target.value })}
            placeholder="10:00"
            aria-label="End time HH:MM"
            className="h-8 text-[12px]"
          />
        </div>

        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          {DAY_SHORT.map((label, day) => {
            const on = draft.days.includes(day);
            return (
              <button
                key={day}
                type="button"
                aria-pressed={on}
                aria-label={`Toggle ${label}`}
                onClick={() =>
                  setDraft({
                    ...draft,
                    days: on
                      ? draft.days.filter((d) => d !== day)
                      : [...draft.days, day].sort(),
                  })
                }
                className={cn(
                  "size-7 cursor-pointer rounded border text-[11px] font-semibold transition-colors",
                  on
                    ? "border-signal bg-signal/15 text-signal"
                    : "border-border/70 text-muted-foreground hover:bg-accent",
                )}
              >
                {label}
              </button>
            );
          })}
          <span className="ml-1 flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <Clock className="size-3" />
            {describeDays(draft.days)} · snapshot {activeName}
          </span>
          <label className="ml-auto flex items-center gap-2 text-[10px] font-semibold tracking-[0.1em] text-muted-foreground uppercase">
            Enabled
            <Switch
              checked={draft.enabled}
              onCheckedChange={(v) => setDraft({ ...draft, enabled: v })}
              aria-label="Slot enabled"
            />
          </label>
        </div>

        <div className="mt-3 flex items-center justify-between gap-3">
          <p className="text-[10px] text-muted-foreground">
            Slots that cross midnight belong to the day they start.
            {next && ` Next up: ${next.slot.name} in ${next.inMinutes} min.`}
          </p>
          <Button size="sm" className="cursor-pointer" onClick={() => void save()}>
            <Plus className="size-3.5" /> {draft.id ? "Save slot" : "Add slot"}
          </Button>
        </div>
      </div>
    </ModuleCard>
  );
}
