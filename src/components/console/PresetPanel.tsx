import {
  usePresets,
  usePushLog,
  useRemovePreset,
  useSavePreset,
} from "@/lib/backend/hooks";
import {
  BUILTIN_PRESETS,
  coerceParams,
  formatHz,
  type BuiltinPreset,
  type ProcessorParams,
} from "@/lib/audio/params";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { format } from "date-fns";
import { Bookmark, Copy, Download, RotateCcw, Trash2, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

const summaryOf = (p: ProcessorParams): string[] => [
  p.hpf.on ? `HPF ${formatHz(p.hpf.freqHz)}` : "HPF off",
  `AGC ${p.agc.ratio.toFixed(2)}:1`,
  `6-band · ${p.deq.on ? "Dyn-EQ on" : "Dyn-EQ off"}`,
  `Ceiling ${p.limiter.ceilingDb.toFixed(2)} dB`,
];

/**
 * Preset families are derived from the chain itself rather than hardcoded:
 * two aggressive stages → High impact, slow levelling → Smooth, presence
 * lift or deep HPF → Speech, everything else → General. Reference chains
 * carry their own family override.
 */
function familyOf(p: ProcessorParams): string {
  const presence = p.eq.bands.find((b) => b.freq === 2500)?.gainDb ?? 0;
  if (p.agc.ratio >= 5) return "High impact";
  if (p.agc.releaseMs >= 500) return "Smooth";
  if (presence >= 2 || p.hpf.freqHz >= 100) return "Speech";
  return "General";
}

export function PresetPanel({
  params,
  activeName,
  dirty = false,
  onApply,
  onRevert,
}: {
  params: ProcessorParams;
  activeName: string;
  /** True when the displayed controls differ from the loaded preset. */
  dirty?: boolean;
  onApply: (p: ProcessorParams, name: string) => void;
  onRevert: () => void;
}) {
  const saved = usePresets();
  const savePreset = useSavePreset();
  const removePreset = useRemovePreset();
  const pushLog = usePushLog();

  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirmOverwrite, setConfirmOverwrite] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const apply = (p: ProcessorParams, presetName: string) => {
    onApply(coerceParams(p), presetName);
    void pushLog({
      kind: "preset",
      title: `Applied “${presetName}”`,
      detail: summaryOf(coerceParams(p)).join(" · "),
    });
    toast.success(`Preset applied — ${presetName}`);
  };

  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error("Give the preset a name");
      return;
    }
    if (trimmed.length > 80) {
      toast.error("Preset names are limited to 80 characters");
      return;
    }
    // overwrite protection: second click confirms replacing an existing preset
    const exists =
      (saved ?? []).some(
        (p) => p.name.toLowerCase() === trimmed.toLowerCase(),
      ) ||
      BUILTIN_PRESETS.some(
        (p) => p.name.toLowerCase() === trimmed.toLowerCase(),
      );
    if (exists && !confirmOverwrite) {
      setConfirmOverwrite(true);
      toast.warning(`“${trimmed}” already exists — press Save again to overwrite it.`);
      return;
    }
    setSaving(true);
    try {
      await savePreset({
        name: trimmed,
        description: description.trim() || undefined,
        params,
      });
      await pushLog({
        kind: "preset",
        title: `Saved preset “${trimmed}”`,
        detail: summaryOf(params).join(" · "),
      });
      toast.success(
        exists ? `Overwrote “${trimmed}”` : "Chain saved as preset",
      );
      setName("");
      setDescription("");
      setShowForm(false);
    } catch (err) {
      toast.error("Could not save the preset", {
        description:
          err instanceof Error && err.message ? err.message : undefined,
      });
    } finally {
      setSaving(false);
      setConfirmOverwrite(false);
    }
  };

  /** DUPLICATE — store a copy of a library entry under a free name. */
  const duplicateFrom = async (
    baseName: string,
    desc: string | undefined,
    p: ProcessorParams,
  ) => {
    const taken = new Set(
      [
        ...(saved ?? []).map((s) => s.name.toLowerCase()),
        ...BUILTIN_PRESETS.map((b) => b.name.toLowerCase()),
      ],
    );
    let candidate = `${baseName} (copy)`;
    for (let i = 2; taken.has(candidate.toLowerCase()) && i < 10; i++) {
      candidate = `${baseName} (copy ${i})`;
    }
    if (taken.has(candidate.toLowerCase())) {
      candidate = `${baseName} (${new Date().toISOString().slice(11, 19)})`;
    }
    try {
      await savePreset({
        name: candidate,
        description: desc || undefined,
        params: p,
      });
      toast.success(`Duplicated as “${candidate}”`);
    } catch (err) {
      toast.error("Could not duplicate the preset", {
        description:
          err instanceof Error && err.message ? err.message : undefined,
      });
    }
  };

  const remove = async (id: string, presetName: string) => {
    try {
      await removePreset(id);
      toast.success(`Deleted “${presetName}”`);
    } catch (err) {
      toast.error("Could not delete the preset", {
        description:
          err instanceof Error && err.message ? err.message : undefined,
      });
    } finally {
      setConfirmDeleteId(null);
    }
  };

  const custom = (saved ?? []) as {
    _id: string;
    name: string;
    description?: string;
    params: unknown;
    _creationTime: number;
  }[];

  // dynamic families: derived from every preset currently in the library
  const entries = [
    ...BUILTIN_PRESETS.map((p: BuiltinPreset) => ({
      key: p.id as string,
      name: p.name,
      description: p.description,
      chips: [...p.tags, ...summaryOf(p.params).slice(0, 1)],
      meta: "Factory",
      family: p.family ?? familyOf(p.params),
      onApply: () => apply(p.params, p.name),
      onDuplicate: () => duplicateFrom(p.name, p.description, p.params),
      onDelete: undefined as undefined | (() => void),
    })),
    ...custom.map((p) => {
      const cp = coerceParams(p.params);
      return {
        key: p._id as string,
        name: p.name,
        description: p.description ?? "Custom chain snapshot.",
        chips: summaryOf(cp),
        meta: `Saved ${format(new Date(p._creationTime), "MMM d, yyyy")}`,
        family: familyOf(cp),
        onApply: () => apply(cp, p.name),
        onDuplicate: () => duplicateFrom(p.name, p.description, cp),
        onDelete: () => void remove(p._id, p.name),
      };
    }),
  ];

  // group by family, preserving count order (largest first, then A→Z)
  const groups = (() => {
    const map = new Map<string, typeof entries>();
    for (const e of entries) {
      const list = map.get(e.family) ?? [];
      list.push(e);
      map.set(e.family, list);
    }
    return [...map.entries()].sort(
      (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]),
    );
  })();

  /** EXPORT ALL — download the whole library (factory + custom) as JSON. */
  const exportAll = () => {
    const payload = {
      exportedAt: new Date().toISOString(),
      presets: [
        ...BUILTIN_PRESETS.map((p) => ({
          id: p.id,
          name: p.name,
          description: p.description,
          tags: p.tags,
          family: p.family ?? familyOf(p.params),
          params: p.params,
        })),
        ...custom.map((p) => ({
          id: p._id,
          name: p.name,
          description: p.description,
          family: familyOf(coerceParams(p.params)),
          params: coerceParams(p.params),
        })),
      ],
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `signalpath-presets-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(`Exported ${payload.presets.length} presets`);
  };

  return (
    <div className="grid gap-4 xl:grid-cols-12">
      {/* ── library ── */}
      <div className="space-y-4 xl:col-span-9">
        {/* active + actions */}
        <div className="card-layer flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/70 bg-card px-4 py-3">
          <div className="min-w-0">
            <p className="flex items-center gap-2 text-[9px] font-semibold tracking-[0.2em] text-muted-foreground uppercase">
              Active
              {dirty && (
                <span className="rounded border border-amber-led/40 bg-amber-led/10 px-1.5 py-0.5 text-[8px] font-bold tracking-[0.12em] text-amber-led">
                  Unsaved changes
                </span>
              )}
            </p>
            <p className="truncate text-lg leading-6 font-semibold text-white">
              {activeName}
            </p>
            {dirty && (
              <p className="mt-0.5 text-[10px] text-meter-warn">
                Controls differ from the loaded preset — Revert to restore it,
                or Save to store this variation.
              </p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant={showForm ? "outline" : "default"}
              className="h-8 text-[11px] tracking-wide uppercase"
              onClick={() => setShowForm((s) => !s)}
            >
              {showForm ? (
                <X className="size-3.5" />
              ) : (
                <Bookmark className="size-3.5" />
              )}
              {showForm ? "Cancel" : "Save current"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-8 text-[11px] tracking-wide uppercase"
              onClick={onRevert}
            >
              <RotateCcw className="size-3.5" />
              Revert
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-8 text-[11px] tracking-wide uppercase"
              onClick={exportAll}
            >
              <Download className="size-3.5" />
              Export all
            </Button>
          </div>
        </div>

        {showForm && (
          <div className="card-layer rounded-lg border border-border/70 bg-card p-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="text-[10px] font-semibold tracking-[0.1em] text-muted-foreground uppercase">
                  Preset name
                </label>
                <Input
                  className="mt-1.5 h-9"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Morning show chain"
                />
              </div>
              <div>
                <label className="text-[10px] font-semibold tracking-[0.1em] text-muted-foreground uppercase">
                  Description
                </label>
                <Textarea
                  className="mt-1.5 min-h-[36px] resize-none"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="What this chain is tuned for"
                />
              </div>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <Button size="sm" onClick={() => void save()} disabled={saving}>
                <Bookmark className="mr-1.5 size-3.5" />
                {saving
                  ? "Saving…"
                  : confirmOverwrite
                    ? "Save — overwrite?"
                    : "Save preset"}
              </Button>
              <span className="text-[11px] text-muted-foreground">
                {summaryOf(params).join(" · ")}
              </span>
            </div>
            {confirmOverwrite && (
              <p className="mt-2 rounded border border-meter-warn/40 bg-meter-warn/10 px-2.5 py-1.5 text-[11px] text-meter-warn">
                A preset named “{name.trim()}” already exists — press Save
                again to overwrite it, or change the name.
              </p>
            )}
          </div>
        )}

        {/* dynamic family sections — names and values come from the library */}
        <div className="space-y-4">
          {groups.map(([family, list]) => (
            <section
              key={family}
              className="card-layer overflow-hidden rounded-lg border border-border/70 bg-card"
            >
              <header className="flex items-center justify-between border-b border-border/60 bg-muted/40 px-4 py-2.5">
                <h3 className="text-[11px] font-semibold tracking-[0.14em] text-foreground uppercase">
                  {family} family
                </h3>
                <span className="text-readout text-[10px] text-muted-foreground">
                  {list.length}
                </span>
              </header>
              <div className="divide-y divide-border/50">
                {list.map((e) => {
                  const active = e.name === activeName;
                  return (
                    <div
                      key={e.key}
                      className={cn(
                        "group flex cursor-pointer items-center gap-3 px-4 py-3 transition-colors",
                        active ? "bg-signal/10" : "hover:bg-muted/40",
                      )}
                      onClick={e.onApply}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(ev) => {
                        if (ev.key === "Enter" || ev.key === " ") {
                          ev.preventDefault();
                          e.onApply();
                        }
                      }}
                    >
                      <span
                        className={cn(
                          "led size-1.5 shrink-0",
                          active && "led-on",
                        )}
                        aria-hidden
                      />
                      <div className="min-w-0 flex-1">
                        <p className="flex items-center gap-2 truncate text-[13px] font-semibold text-white">
                          {e.name}
                          {active && (
                            <span className="rounded bg-signal/20 px-1.5 py-0.5 text-[8px] font-bold tracking-[0.14em] text-signal uppercase">
                              Active
                            </span>
                          )}
                        </p>
                        <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                          {e.description}
                        </p>
                      </div>
                      <div className="hidden shrink-0 flex-wrap gap-1.5 lg:flex">
                        {e.chips.slice(0, 3).map((chip) => (
                          <span
                            key={chip}
                            className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-foreground/70"
                          >
                            {chip}
                          </span>
                        ))}
                      </div>
                      <span className="w-24 shrink-0 text-right text-[10px] text-muted-foreground">
                        {e.meta}
                      </span>
                      <button
                        type="button"
                        aria-label={`Duplicate ${e.name}`}
                        title="Duplicate as a new preset"
                        className="flex shrink-0 items-center gap-1 text-muted-foreground/60 transition-colors hover:text-signal"
                        onClick={(ev) => {
                          ev.stopPropagation();
                          e.onDuplicate();
                        }}
                      >
                        <Copy className="size-3.5" />
                      </button>
                      {e.onDelete && (
                        <button
                          type="button"
                          aria-label={
                            confirmDeleteId === e.key
                              ? `Confirm delete ${e.name}`
                              : `Delete ${e.name}`
                          }
                          title={
                            confirmDeleteId === e.key
                              ? "Click again to confirm deletion"
                              : "Delete preset"
                          }
                          className={cn(
                            "flex shrink-0 items-center gap-1 transition-colors",
                            confirmDeleteId === e.key
                              ? "font-bold text-destructive"
                              : "text-muted-foreground/60 hover:text-destructive",
                          )}
                          onClick={(ev) => {
                            ev.stopPropagation();
                            if (confirmDeleteId === e.key) {
                              e.onDelete?.();
                            } else {
                              setConfirmDeleteId(e.key);
                              window.setTimeout(
                                () =>
                                  setConfirmDeleteId((c) =>
                                    c === e.key ? null : c,
                                  ),
                                4000,
                              );
                            }
                          }}
                        >
                          <Trash2 className="size-3.5" />
                          {confirmDeleteId === e.key && (
                            <span className="text-[9px] tracking-wide uppercase">
                              Confirm
                            </span>
                          )}
                        </button>
                      )}
                      <Button
                        size="sm"
                        variant={active ? "secondary" : "default"}
                        className="h-7 shrink-0 text-[10px] tracking-wide uppercase"
                        onClick={(ev) => {
                          ev.stopPropagation();
                          e.onApply();
                        }}
                      >
                        {active ? "Reload" : "Load"}
                      </Button>
                    </div>
                  );
                })}
              </div>
            </section>
          ))}

          {saved !== undefined && custom.length === 0 && (
            <p className="rounded-lg border border-dashed border-border/80 px-4 py-3 text-[11px] text-muted-foreground">
              No custom presets yet — tune the chain, then hit Save current to
              snapshot it here.
            </p>
          )}
        </div>
      </div>

      {/* ── current chain summary ── */}
      <aside className="xl:col-span-3">
        <div className="card-layer rounded-lg border border-border/70 bg-card p-4">
          <h3 className="text-[11px] font-semibold tracking-[0.14em] text-foreground uppercase">
            Current chain
          </h3>
          <dl className="mt-3 space-y-2 text-[11px]">
            {[
              ["Active preset", activeName],
              ["HPF", params.hpf.on ? formatHz(params.hpf.freqHz) : "bypassed"],
              ["Phase rot", params.phase.mode === "auto" ? "auto" : `${params.phase.freqHz.toFixed(2)} Hz`],
              [
                "Silence gate",
                params.gate.on
                  ? `${params.gate.thresholdDb.toFixed(2).replace("-", "−")} dB`
                  : "bypassed",
              ],
              ["AGC", `${params.agc.ratio.toFixed(2)}:1 · ${params.agc.on ? "on" : "bypassed"}`],
              [
                "Rider",
                params.rider.on
                  ? `${params.rider.targetLufs.toFixed(2).replace("-", "−")} LUFS · ${params.rider.speed}`
                  : "bypassed",
              ],
              [
                "Dyn-EQ",
                params.deq.on
                  ? `${params.deq.bands.length} bands · ${params.deq.bands.map((b) => b.freqHz >= 1000 ? `${(b.freqHz / 1000).toFixed(1)}k` : b.freqHz).join(" / ")}`
                  : "bypassed",
              ],
              ["Ceiling", `${params.limiter.ceilingDb.toFixed(2).replace("-", "−")} dBTP guard`],
            ].map(([k, v]) => (
              <div key={k} className="flex items-baseline justify-between gap-3">
                <dt className="text-muted-foreground uppercase">{k}</dt>
                <dd className="text-readout truncate text-white">{v}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-4 text-[10px] leading-4 text-muted-foreground">
            Click any preset row to load it instantly — the chain applies on
            the spot with no confirmation delay.
          </p>
        </div>
      </aside>
    </div>
  );
}
