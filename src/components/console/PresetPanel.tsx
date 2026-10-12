import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
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
import { useMutation, useQuery } from "convex/react";
import { format } from "date-fns";
import { Bookmark, Plus, Sparkles, Trash2, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

const summaryOf = (p: ProcessorParams): string[] => [
  p.hpf.on ? `HPF ${formatHz(p.hpf.freqHz)}` : "HPF off",
  `AGC ${p.agc.ratio.toFixed(1)}:1`,
  `Ceiling ${p.limiter.ceilingDb.toFixed(1)} dB`,
];

function PresetCard({
  name,
  description,
  chips,
  meta,
  onApply,
  onDelete,
  accent,
}: {
  name: string;
  description: string;
  chips: string[];
  meta?: string;
  onApply: () => void;
  onDelete?: () => void;
  accent?: boolean;
}) {
  return (
    <article
      className={cn(
        "card-layer group flex flex-col rounded-xl border bg-card p-4 transition-shadow hover:shadow-[0_2px_4px_rgba(16,24,40,0.05),0_18px_44px_-20px_rgba(16,24,40,0.28)]",
        accent ? "border-signal/30" : "border-border/70",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-sm leading-5 font-semibold tracking-tight">{name}</h3>
        {onDelete && (
          <button
            type="button"
            onClick={onDelete}
            aria-label={`Delete ${name}`}
            className="text-muted-foreground/60 transition-colors hover:text-destructive"
          >
            <Trash2 className="size-3.5" />
          </button>
        )}
      </div>
      <p className="mt-1.5 flex-1 text-xs leading-5 text-muted-foreground">
        {description}
      </p>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {chips.map((chip) => (
          <span
            key={chip}
            className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium text-foreground/70"
          >
            {chip}
          </span>
        ))}
      </div>
      <div className="mt-4 flex items-center justify-between gap-2">
        <span className="text-[10px] text-muted-foreground">{meta}</span>
        <Button size="sm" className="h-8 text-xs" onClick={onApply}>
          Apply
        </Button>
      </div>
    </article>
  );
}

export function PresetPanel({
  params,
  onApply,
}: {
  params: ProcessorParams;
  onApply: (p: ProcessorParams, name: string) => void;
}) {
  const saved = useQuery(api.presets.list);
  const savePreset = useMutation(api.presets.save);
  const removePreset = useMutation(api.presets.remove);
  const pushLog = useMutation(api.stations.pushLog);

  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);

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
    if (!name.trim()) {
      toast.error("Give the preset a name");
      return;
    }
    setSaving(true);
    try {
      await savePreset({ name: name.trim(), description: description.trim() || undefined, params });
      await pushLog({
        kind: "preset",
        title: `Saved preset “${name.trim()}”`,
        detail: summaryOf(params).join(" · "),
      });
      toast.success("Chain saved as preset");
      setName("");
      setDescription("");
      setShowForm(false);
    } catch {
      toast.error("Could not save the preset");
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: Id<"presets">, presetName: string) => {
    try {
      await removePreset({ id });
      toast.success(`Deleted “${presetName}”`);
    } catch {
      toast.error("Could not delete the preset");
    }
  };

  const custom = (saved ?? []) as {
    _id: Id<"presets">;
    name: string;
    description?: string;
    params: unknown;
    _creationTime: number;
  }[];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Preset library</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Factory broadcast chains and your own snapshots of the current processor.
          </p>
        </div>
        <Button onClick={() => setShowForm((s) => !s)} variant={showForm ? "outline" : "default"}>
          {showForm ? <X className="mr-1.5 size-4" /> : <Plus className="mr-1.5 size-4" />}
          {showForm ? "Cancel" : "Save current chain"}
        </Button>
      </div>

      {showForm && (
        <div className="card-layer rounded-xl border border-border/70 bg-card p-4">
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
          <div className="mt-3 flex items-center gap-3">
            <Button size="sm" onClick={() => void save()} disabled={saving}>
              <Bookmark className="mr-1.5 size-3.5" />
              {saving ? "Saving…" : "Save preset"}
            </Button>
            <span className="text-[11px] text-muted-foreground">
              {summaryOf(params).join(" · ")}
            </span>
          </div>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {BUILTIN_PRESETS.map((p: BuiltinPreset) => (
          <PresetCard
            key={p.id}
            name={p.name}
            description={p.description}
            chips={[...p.tags, ...summaryOf(p.params).slice(0, 1)]}
            meta="Factory"
            accent={p.name === "Broadcast Standard FM"}
            onApply={() => apply(p.params, p.name)}
          />
        ))}
        {custom.map((p) => (
          <PresetCard
            key={p._id}
            name={p.name}
            description={p.description ?? "Custom chain snapshot."}
            chips={summaryOf(coerceParams(p.params))}
            meta={`Saved ${format(new Date(p._creationTime), "MMM d, yyyy")}`}
            onApply={() => apply(coerceParams(p.params), p.name)}
            onDelete={() => void remove(p._id, p.name)}
          />
        ))}
        {saved !== undefined && custom.length === 0 && (
          <button
            type="button"
            onClick={() => setShowForm(true)}
            className="flex min-h-[168px] flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border/80 text-muted-foreground transition-colors hover:border-signal/40 hover:text-foreground"
          >
            <Sparkles className="size-5" />
            <span className="text-xs font-medium">Save your first custom preset</span>
          </button>
        )}
      </div>
    </div>
  );
}
