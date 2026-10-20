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
import {
  CHARACTERS,
  applyCharacter,
  type CharacterId,
} from "@/lib/audio/character";
import { diffParams, interpolateParams } from "@/lib/audio/morph";
import {
  SNAPSHOT_SLOTS,
  clearSnapshot,
  loadSnapshots,
  saveSnapshot,
  type SnapshotSlot,
} from "@/lib/audio/snapshots";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { format } from "date-fns";
import { Bookmark, Copy, Download, RotateCcw, Trash2, Upload, X } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";

const summaryOf = (p: ProcessorParams): string[] => [
  p.hpf.on
    ? `HPF ${formatHz(p.hpf.freqHz)} · ${p.hpf.slope ?? 24} dB/oct`
    : "HPF off",
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

/* ── preset morph + snapshots ─────────────────────────────────────────── */

function MorphSection({
  params,
  activeName,
  customParams,
  bank,
  setBank,
  morphA,
  morphB,
  morphT,
  setMorphA,
  setMorphB,
  setMorphT,
  onPreview,
  onCommit,
}: {
  params: ProcessorParams;
  activeName: string;
  customParams: { name: string; params: ProcessorParams }[];
  bank: ReturnType<typeof loadSnapshots>;
  setBank: React.Dispatch<React.SetStateAction<ReturnType<typeof loadSnapshots>>>;
  morphA: string | null;
  morphB: string | null;
  morphT: number;
  setMorphA: (n: string) => void;
  setMorphB: (n: string) => void;
  setMorphT: (n: number) => void;
  onPreview?: (p: ProcessorParams) => void;
  onCommit: (p: ProcessorParams, name: string) => void;
}) {
  const lib = [
    ...BUILTIN_PRESETS.map((p) => ({ name: p.name, params: p.params })),
    ...customParams,
  ];
  const find = (n: string | null) => lib.find((l) => l.name === n) ?? null;
  const a = find(morphA) ?? find(activeName) ?? lib[0];
  const b = find(morphB) ?? lib.find((l) => l.name !== a?.name) ?? lib[0];
  const t = morphT / 100;
  const mixed = a && b ? coerceParams(interpolateParams(a.params, b.params, t)) : null;
  const diffs = a && b ? diffParams(a.params, b.params) : [];

  const drag = (v: number) => {
    setMorphT(v);
    if (a && b && onPreview) {
      onPreview(coerceParams(interpolateParams(a.params, b.params, v / 100)));
    }
  };
  const commit = () => {
    if (a && b && mixed) {
      onCommit(
        mixed,
        `Morph ${Math.round((1 - t) * 100)}% ${a.name} · ${Math.round(t * 100)}% ${b.name}`,
      );
    }
  };

  const holdCompare = (p: ProcessorParams) => ({
    onPointerDown: () => onPreview?.(coerceParams(p)),
    onPointerUp: () => onPreview?.(coerceParams(params)),
    onPointerLeave: () => onPreview?.(coerceParams(params)),
  });

  const selectCls =
    "h-8 min-w-0 flex-1 cursor-pointer truncate rounded-md border border-border/60 bg-muted/40 px-2 text-[11px] text-foreground";

  return (
    <div className="panel rounded-xl p-4">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-[10px] font-semibold tracking-[0.16em] text-panel-mut uppercase">
          Preset morph · snapshots
        </p>
        <p className="text-[10px] text-panel-mut">Interpolates DSP — never crossfades</p>
      </div>

      <div className="mt-3 flex items-center gap-2">
        <select
          aria-label="Morph source A"
          className={selectCls}
          value={a?.name ?? ""}
          onChange={(e) => setMorphA(e.target.value)}
        >
          {lib.map((l) => (
            <option key={l.name} value={l.name}>
              {l.name}
            </option>
          ))}
        </select>
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={morphT}
          onChange={(e) => drag(Number(e.target.value))}
          onPointerUp={commit}
          onKeyUp={commit}
          aria-label="Morph position between presets"
          className="h-1.5 min-w-0 flex-1 cursor-pointer accent-[#e5a93b]"
        />
        <select
          aria-label="Morph source B"
          className={selectCls}
          value={b?.name ?? ""}
          onChange={(e) => setMorphB(e.target.value)}
        >
          {lib.map((l) => (
            <option key={l.name} value={l.name}>
              {l.name}
            </option>
          ))}
        </select>
      </div>
      {a && b && (
        <p className="text-readout mt-1.5 text-center text-[11px] text-white">
          {Math.round((1 - t) * 100)}% {a.name} · {Math.round(t * 100)}% {b.name}
        </p>
      )}

      {diffs.length > 0 && (
        <div className="mt-2 grid gap-x-4 gap-y-0.5 sm:grid-cols-2">
          {diffs.map((d) => (
            <p key={d.path} className="flex items-baseline justify-between gap-2 text-[10px]">
              <span className="text-panel-mut">{d.path}</span>
              <span className="text-readout truncate text-white">
                {d.from} <span className="text-panel-mut">→</span> {d.to}
              </span>
            </p>
          ))}
        </div>
      )}

      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        {SNAPSHOT_SLOTS.map((slot) => {
          const s = bank[slot];
          return (
            <div
              key={slot}
              className="rounded-lg border border-border/60 bg-muted/40 p-2"
            >
              <p className="flex items-center justify-between text-[9px] font-bold tracking-[0.14em] text-panel-mut uppercase">
                <span>Snapshot {slot}</span>
                {s && (
                  <button
                    type="button"
                    title={`Clear snapshot ${slot}`}
                    aria-label={`Clear snapshot ${slot}`}
                    onClick={() => setBank((bn) => clearSnapshot(bn, slot as SnapshotSlot))}
                    className="cursor-pointer text-panel-mut hover:text-meter-hot"
                  >
                    ×
                  </button>
                )}
              </p>
              <p className="text-readout mt-0.5 truncate text-[11px] text-white" title={s?.name}>
                {s ? s.name : "— empty —"}
              </p>
              <div className="mt-1.5 flex gap-1">
                <button
                  type="button"
                  title="Save current chain"
                  onClick={() =>
                    setBank((bn) =>
                      saveSnapshot(bn, slot as SnapshotSlot, {
                        name: activeName,
                        params: coerceParams(params),
                        at: Date.now(),
                      }),
                    )
                  }
                  className="h-7 flex-1 cursor-pointer rounded-md border border-border/60 text-[9px] font-bold tracking-[0.08em] text-muted-foreground uppercase transition-colors hover:text-foreground"
                >
                  Save
                </button>
                <button
                  type="button"
                  title="Recall snapshot"
                  disabled={!s}
                  onClick={() => s && onCommit(coerceParams(s.params), `Snapshot ${slot} · ${s.name}`)}
                  className="h-7 flex-1 cursor-pointer rounded-md border border-border/60 text-[9px] font-bold tracking-[0.08em] text-muted-foreground uppercase transition-colors hover:text-foreground disabled:opacity-40"
                >
                  Recall
                </button>
                <button
                  type="button"
                  title="Hold to compare"
                  disabled={!s}
                  {...(s ? holdCompare(s.params) : {})}
                  className="h-7 flex-1 cursor-pointer rounded-md border border-signal/40 bg-signal/10 text-[9px] font-bold tracking-[0.08em] text-signal uppercase transition-colors hover:bg-signal/20 disabled:opacity-40"
                >
                  Hold
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function PresetPanel({
  params,
  activeName,
  dirty = false,
  onApply,
  onRevert,
  onPreview,
}: {
  params: ProcessorParams;
  activeName: string;
  /** True when the displayed controls differ from the loaded preset. */
  dirty?: boolean;
  onApply: (p: ProcessorParams, name: string) => void;
  onRevert: () => void;
  /** Silent live update (no log/toast) — morph drags and compare-hold. */
  onPreview?: (p: ProcessorParams) => void;
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
  const fileRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);

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
      format: "signalpath-presets",
      version: 1,
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

  /**
   * IMPORT — accept an export from another console (or a single preset
   * object). Every entry is coerced onto the current parameter shape, so a
   * file written before a schema addition still loads. Name clashes with the
   * factory library or the local bank get an "(imported)" suffix instead of
   * silently overwriting something.
   */
  const importFile = async (file: File) => {
    setImporting(true);
    try {
      const parsed: unknown = JSON.parse(await file.text());
      const rawList = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === "object" && Array.isArray((parsed as { presets?: unknown }).presets)
          ? ((parsed as { presets: unknown[] }).presets)
          : [parsed];
      if (rawList.length === 0) {
        toast.error("That file contains no presets");
        return;
      }
      const taken = new Set<string>([
        ...(saved ?? []).map((s) => s.name.toLowerCase()),
        ...BUILTIN_PRESETS.map((b) => b.name.toLowerCase()),
      ]);
      let added = 0;
      for (const entry of rawList.slice(0, 200)) {
        if (!entry || typeof entry !== "object") continue;
        const src = entry as {
          name?: unknown;
          description?: unknown;
          params?: unknown;
        };
        const wanted =
          typeof src.name === "string" ? src.name.trim().slice(0, 80) : "";
        if (!wanted || !src.params || typeof src.params !== "object") continue;
        let unique = wanted;
        if (taken.has(unique.toLowerCase())) unique = `${wanted} (imported)`;
        for (let n = 2; taken.has(unique.toLowerCase()) && n < 100; n++) {
          unique = `${wanted} (imported ${n})`;
        }
        if (taken.has(unique.toLowerCase())) continue;
        taken.add(unique.toLowerCase());
        await savePreset({
          name: unique,
          description:
            typeof src.description === "string" ? src.description : undefined,
          params: coerceParams(src.params),
        });
        added++;
      }
      if (added === 0) {
        toast.error("No usable presets in that file");
      } else {
        await pushLog({
          kind: "preset",
          title: `Imported ${added} preset${added === 1 ? "" : "s"}`,
          detail: file.name,
        });
        toast.success(`Imported ${added} preset${added === 1 ? "" : "s"}`);
      }
    } catch (err) {
      toast.error("Could not import that file", {
        description:
          err instanceof Error && err.message ? err.message : undefined,
      });
    } finally {
      setImporting(false);
    }
  };

  const [bank, setBank] = useState(loadSnapshots);
  const [morphA, setMorphA] = useState<string | null>(null);
  const [morphB, setMorphB] = useState<string | null>(null);
  const [morphT, setMorphT] = useState(50);
  const [character, setCharacter] = useState<CharacterId | null>(null);
  const applyCharacterCard = (id: CharacterId) => {
    const def = CHARACTERS.find((c) => c.id === id);
    if (!def) return;
    setCharacter(id);
    apply(coerceParams(applyCharacter(params, id)), `Character · ${def.name}`);
  };

  return (
    <div className="grid gap-4 xl:grid-cols-12">
      {/* ── library ── */}
      <div className="space-y-4 xl:col-span-9">
        {/* character face — one-word promises that reshape the live chain */}
        <div className="panel rounded-xl p-4">
          <div className="flex items-baseline justify-between gap-2">
            <p className="text-[10px] font-semibold tracking-[0.16em] text-panel-mut uppercase">
              Character
            </p>
            <p className="text-[10px] text-panel-mut">
              Reshapes dynamics + density — never volume
            </p>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
            {CHARACTERS.map((c) => {
              const active = character === c.id;
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => applyCharacterCard(c.id)}
                  aria-pressed={active}
                  title={c.description}
                  className={cn(
                    "rounded-lg border px-3 py-2.5 text-left transition-all",
                    active
                      ? "border-signal bg-signal/15 shadow-[0_0_16px_rgba(229,169,59,0.28)]"
                      : "border-border/60 bg-muted/40 hover:border-signal/40 hover:bg-accent",
                  )}
                >
                  <span
                    className={cn(
                      "block text-xs font-bold tracking-wide uppercase",
                      active ? "text-signal" : "text-foreground",
                    )}
                  >
                    {c.name}
                  </span>
                  <span className="mt-0.5 block text-[10px] text-muted-foreground">
                    {c.promise} · density {c.density}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
        {/* preset morph + snapshots — interpolate chains, never crossfade */}
        <MorphSection
          params={params}
          activeName={activeName}
          customParams={custom.map((p) => ({
            name: p.name,
            params: coerceParams(p.params),
          }))}
          bank={bank}
          setBank={setBank}
          morphA={morphA}
          morphB={morphB}
          morphT={morphT}
          setMorphA={setMorphA}
          setMorphB={setMorphB}
          setMorphT={setMorphT}
          onPreview={onPreview}
          onCommit={apply}
        />
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
            <Button
              size="sm"
              variant="outline"
              className="h-8 text-[11px] tracking-wide uppercase"
              disabled={importing}
              onClick={() => fileRef.current?.click()}
            >
              <Upload className="size-3.5" />
              {importing ? "Importing…" : "Import"}
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json,.signalpath"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) void importFile(file);
              }}
            />
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
