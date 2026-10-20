import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Download,
  FileAudio,
  ListChecks,
  Loader2,
  Play,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ModuleCard } from "@/components/console/ModuleCard";
import {
  BATCH_SAMPLE_RATE,
  processBatchFile,
  type BatchFileResult,
} from "@/lib/audio/batch";
import {
  LOUDNESS_STANDARDS,
  complianceTarget,
  loudnessStandard,
} from "@/lib/audio/loudness";
import type { LoudnessStandardId, ProcessorParams } from "@/lib/audio/params";
import { cn } from "@/lib/utils";

type RowStatus = "queued" | "running" | "done" | "error";

interface Row {
  id: string;
  file: File;
  status: RowStatus;
  result?: BatchFileResult;
  url?: string;
  error?: string;
}

const statusMeta: Record<RowStatus, { label: string; led: string }> = {
  queued: { label: "Queued", led: "" },
  running: { label: "Processing", led: "led-warn animate-pulse-live" },
  done: { label: "Done", led: "led-on" },
  error: { label: "Failed", led: "led-hot" },
};

const formatDuration = (ms: number): string => {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
};

const formatSize = (bytes: number): string =>
  bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/**
 * BATCH — offline delivery processing.
 *
 * Takes a queue of local files, measures each against the selected loudness
 * standard, normalises to its target, limits at its true-peak ceiling with
 * the same lookahead kernel the live worklet runs, and hands back 16-bit WAV
 * downloads. Live metering is untouched: this is a separate offline path.
 */
export function BatchPanel({ params }: { params: ProcessorParams }) {
  const [standard, setStandard] = useState<LoudnessStandardId>(
    params.loudness.standard,
  );
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);
  const rowsRef = useRef<Row[]>([]);

  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);

  // Object URLs are the file's audio; release them when the panel goes away.
  useEffect(
    () => () => {
      for (const row of rowsRef.current) {
        if (row.url) URL.revokeObjectURL(row.url);
      }
    },
    [],
  );

  const target = complianceTarget({
    ...params,
    loudness: {
      ...params.loudness,
      standard,
      customLufs: params.loudness.customLufs,
      customTpDb: params.loudness.customTpDb,
    },
  });
  const selected = loudnessStandard(standard);

  const addFiles = (list: FileList | null) => {
    if (!list || list.length === 0) return;
    const next: Row[] = Array.from(list).map((file) => {
      seq.current += 1;
      return { id: `batch-${seq.current}`, file, status: "queued" };
    });
    setRows((prev) => [...prev, ...next]);
  };

  const removeRow = (id: string) => {
    setRows((prev) => {
      const row = prev.find((r) => r.id === id);
      if (row?.url) URL.revokeObjectURL(row.url);
      return prev.filter((r) => r.id !== id);
    });
  };

  const clearAll = () => {
    if (busy) return;
    for (const row of rowsRef.current) {
      if (row.url) URL.revokeObjectURL(row.url);
    }
    setRows([]);
  };

  const run = useCallback(async () => {
    if (busy) return;
    const pending = rowsRef.current.filter(
      (r) => r.status === "queued" || r.status === "error",
    );
    if (pending.length === 0) {
      toast.message("Nothing to process", {
        description: "Add audio files to the queue first.",
      });
      return;
    }
    setBusy(true);
    const settings = {
      targetLufs: target.lufs,
      ceilingDb: target.truePeakDb,
    };
    let done = 0;
    for (const row of pending) {
      setRows((prev) =>
        prev.map((r) =>
          r.id === row.id ? { ...r, status: "running", error: undefined } : r,
        ),
      );
      // Yield once so the row paints as running before the DSP blocks.
      await new Promise((resolve) => setTimeout(resolve, 0));
      try {
        const result = await processBatchFile(row.file, settings);
        const url = URL.createObjectURL(
          new Blob([result.wav as BlobPart], { type: "audio/wav" }),
        );
        setRows((prev) =>
          prev.map((r) => {
            if (r.id !== row.id) return r;
            if (r.url) URL.revokeObjectURL(r.url);
            return { ...r, status: "done", result, url };
          }),
        );
        done += 1;
      } catch (err) {
        setRows((prev) =>
          prev.map((r) =>
            r.id === row.id
              ? {
                  ...r,
                  status: "error",
                  error: err instanceof Error ? err.message : String(err),
                }
              : r,
          ),
        );
      }
    }
    setBusy(false);
    toast.success(`Batch finished — ${done} of ${pending.length} file${pending.length === 1 ? "" : "s"}`, {
      description: `Target ${target.label} · ${target.lufs} LUFS / ${target.truePeakDb} dBTP`,
    });
  }, [busy, target]);

  const downloadAll = () => {
    const ready = rowsRef.current.filter((r) => r.status === "done" && r.url);
    for (const row of ready) {
      const a = document.createElement("a");
      a.href = row.url as string;
      a.download = row.result?.name ?? row.file.name;
      a.click();
    }
  };

  const doneCount = rows.filter((r) => r.status === "done").length;

  return (
    <div className="grid gap-4">
      <ModuleCard
        title="Batch delivery"
        subtitle="Offline loudness normalisation · true-peak limiting · 16-bit WAV"
        right={
          <span className="hidden items-center gap-2 text-[10px] text-muted-foreground sm:flex">
            <ListChecks className="size-3.5" />
            {doneCount}/{rows.length} processed
          </span>
        }
      >
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="order-2 flex flex-col gap-3 lg:order-1">
            <label
              htmlFor="batch-files"
              className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border/70 bg-muted/30 px-4 py-6 text-center transition-colors hover:border-signal/50 hover:bg-muted/50"
            >
              <FileAudio className="size-5 text-muted-foreground" aria-hidden />
              <span className="text-xs font-semibold text-foreground/90">
                Add audio files
              </span>
              <span className="text-[10px] text-muted-foreground">
                WAV, AIFF, MP3, M4A, OGG, FLAC — decoded locally, nothing is
                uploaded
              </span>
              <input
                id="batch-files"
                type="file"
                multiple
                accept="audio/*"
                className="sr-only"
                onChange={(e) => {
                  addFiles(e.target.files);
                  e.target.value = "";
                }}
              />
            </label>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                className="h-9 cursor-pointer"
                onClick={() => void run()}
                disabled={busy || rows.length === 0}
              >
                {busy ? (
                  <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                ) : (
                  <Play className="mr-1.5 size-3.5" />
                )}
                {busy ? "Processing…" : "Process queue"}
              </Button>
              <Button
                variant="outline"
                className="h-9 cursor-pointer"
                onClick={downloadAll}
                disabled={doneCount === 0}
              >
                <Download className="mr-1.5 size-3.5" />
                Download all
              </Button>
              <Button
                variant="ghost"
                className="h-9 cursor-pointer text-muted-foreground"
                onClick={clearAll}
                disabled={busy || rows.length === 0}
              >
                <Trash2 className="mr-1.5 size-3.5" />
                Clear
              </Button>
            </div>

            {rows.length === 0 ? (
              <p className="rounded-lg border border-border/60 bg-muted/20 px-3 py-6 text-center text-[11px] text-muted-foreground">
                The queue is empty. Add files to normalise them against a
                published delivery target.
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {rows.map((row) => {
                  const meta = statusMeta[row.status];
                  const m = row.result?.metrics;
                  return (
                    <li
                      key={row.id}
                      className="rounded-lg border border-border/60 bg-card/60 px-3 py-2.5"
                    >
                      <div className="flex items-start gap-3">
                        <span
                          className={cn("mt-1.5 led size-1.5", meta.led)}
                          aria-hidden
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                            <span className="truncate text-xs font-medium text-foreground/90">
                              {row.file.name}
                            </span>
                            <span className="text-readout text-[10px] text-muted-foreground">
                              {formatSize(row.file.size)} · {meta.label}
                            </span>
                          </div>
                          {m && row.status === "done" ? (
                            <div className="text-readout mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-muted-foreground">
                              <span>
                                {m.lufsIn.toFixed(1)} →{" "}
                                <span className="text-foreground/85">
                                  {m.lufsOut.toFixed(1)} LUFS
                                </span>
                              </span>
                              <span>
                                TP{" "}
                                <span
                                  className={cn(
                                    m.truePeakOut > target.truePeakDb + 0.1
                                      ? "text-meter-hot"
                                      : "text-meter-ok",
                                  )}
                                >
                                  {m.truePeakOut.toFixed(2)}
                                </span>{" "}
                                dBTP
                              </span>
                              <span>GR max {m.grMaxDb.toFixed(1)} dB</span>
                              <span>
                                gain {m.gainDb >= 0 ? "+" : ""}
                                {m.gainDb.toFixed(1)} dB
                              </span>
                              <span>{formatDuration(row.result?.durationMs ?? 0)}</span>
                              {m.silent && (
                                <span className="text-meter-warn">
                                  silent input — normalisation skipped
                                </span>
                              )}
                            </div>
                          ) : row.status === "error" ? (
                            <p className="mt-1 text-[10px] text-destructive">
                              {row.error}
                            </p>
                          ) : (
                            <p className="text-readout mt-1 text-[10px] text-muted-foreground">
                              {row.status === "running"
                                ? "Decoding, normalising and limiting…"
                                : "Waiting for the queue"}
                            </p>
                          )}
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5">
                          {row.url && (
                            <a
                              href={row.url}
                              download={row.result?.name ?? row.file.name}
                              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border/70 px-2 text-[10px] font-medium text-foreground/80 transition-colors hover:border-signal/50 hover:text-foreground"
                            >
                              <Download className="size-3.5" />
                              {row.result ? formatSize(row.result.wav.byteLength) : "WAV"}
                            </a>
                          )}
                          <button
                            type="button"
                            onClick={() => removeRow(row.id)}
                            disabled={busy && row.status === "running"}
                            aria-label={`Remove ${row.file.name}`}
                            className="inline-flex size-8 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            <Trash2 className="size-3.5" />
                          </button>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <aside className="order-1 flex flex-col gap-3 rounded-lg border border-border/60 bg-muted/20 p-3 lg:order-2">
            <div>
              <p className="text-[10px] font-semibold tracking-[0.12em] text-muted-foreground uppercase">
                Delivery target
              </p>
              <Select
                value={standard}
                onValueChange={(v) => setStandard(v as LoudnessStandardId)}
              >
                <SelectTrigger className="mt-1.5 h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LOUDNESS_STANDARDS.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="mt-2 text-[10px] leading-4 text-muted-foreground">
                {selected.note}
              </p>
            </div>
            <dl className="divide-y divide-border/60 rounded-md border border-border/60 bg-card/50 text-[10px]">
              <div className="flex items-center justify-between px-2.5 py-2">
                <dt className="text-muted-foreground">Integrated</dt>
                <dd className="text-readout font-semibold text-foreground/90">
                  {target.lufs.toFixed(1)} LUFS
                </dd>
              </div>
              <div className="flex items-center justify-between px-2.5 py-2">
                <dt className="text-muted-foreground">True peak</dt>
                <dd className="text-readout font-semibold text-foreground/90">
                  {target.truePeakDb.toFixed(1)} dBTP
                </dd>
              </div>
              <div className="flex items-center justify-between px-2.5 py-2">
                <dt className="text-muted-foreground">Sample rate</dt>
                <dd className="text-readout text-foreground/80">
                  {(BATCH_SAMPLE_RATE / 1000).toFixed(1)} kHz
                </dd>
              </div>
              <div className="flex items-center justify-between px-2.5 py-2">
                <dt className="text-muted-foreground">Container</dt>
                <dd className="text-readout text-foreground/80">
                  16-bit PCM WAV
                </dd>
              </div>
            </dl>
            <p className="text-[10px] leading-4 text-muted-foreground">
              Each file is measured with BS.1770 K-weighting, normalised, then
              run through the same lookahead limiter the live worklet uses. The
              correction pass catches level the limiter removed and
              inter-sample peaks.
            </p>
          </aside>
        </div>
      </ModuleCard>
    </div>
  );
}
