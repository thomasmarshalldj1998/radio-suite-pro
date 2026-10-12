import type { SignalMode, SourceKind } from "@/lib/audio/engine";
import { getEngine } from "@/lib/audio/engine";
import type { ProcessorParams } from "@/lib/audio/params";
import { formatHz, formatTime } from "@/lib/audio/params";
import { StereoLevelMeter } from "@/components/console/Meters";
import { Fader } from "@/components/console/Fader";
import { ModuleCard } from "@/components/console/ModuleCard";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { FileAudio, Mic, Pause, Play, Radio, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";

/* ── waveform with scrub-to-seek ────────────────────────────────────────── */

function Waveform({ peaks, height = 52 }: { peaks: Float32Array; height?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const peaksRef = useRef(peaks);

  useEffect(() => {
    peaksRef.current = peaks;
  }, [peaks]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let raf = 0;
    const draw = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const p = peaksRef.current;
      const mid = h / 2;
      const posRatio =
        getEngine().fileDuration > 0
          ? getEngine().filePosition / getEngine().fileDuration
          : 0;

      const bars = Math.min(p.length, Math.floor(w / 3));
      for (let i = 0; i < bars; i++) {
        const v = p[Math.floor((i / bars) * p.length)] ?? 0;
        const bh = Math.max(1.5, v * (h - 6));
        const x = i * 3;
        ctx.fillStyle =
          x / w <= posRatio ? "rgba(239,91,43,0.85)" : "rgba(255,255,255,0.22)";
        ctx.fillRect(x, mid - bh / 2, 2, bh);
      }
      // playhead
      const px = posRatio * w;
      ctx.fillStyle = "rgba(255,255,255,0.9)";
      ctx.fillRect(px - 0.5, 0, 1, h);
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  const seekAt = (clientX: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    getEngine().seekFile(ratio * getEngine().fileDuration);
  };

  return (
    <canvas
      ref={canvasRef}
      className="panel-well w-full cursor-pointer rounded-md"
      style={{ height }}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        seekAt(e.clientX);
      }}
      onPointerMove={(e) => {
        if (e.buttons === 1) seekAt(e.clientX);
      }}
      aria-label="Waveform, click to seek"
    />
  );
}

/* ── input module ───────────────────────────────────────────────────────── */

export function SourceModule({
  params,
  setParams,
}: {
  params: ProcessorParams;
  setParams: React.Dispatch<React.SetStateAction<ProcessorParams>>;
}) {
  const engine = getEngine();
  const [source, setSourceState] = useState<SourceKind>(engine.sourceKind);
  const [signalMode, setSignalModeState] = useState<SignalMode>(engine.signalMode);
  const [micStatus, setMicStatus] = useState(engine.micStatus);
  const [micLabel, setMicLabel] = useState(engine.micLabel);
  const [fileMeta, setFileMeta] = useState<{
    name: string;
    duration: number;
    peaks: Float32Array | null;
  }>({ name: engine.fileName, duration: engine.fileDuration, peaks: engine.filePeaks });
  const [playing, setPlaying] = useState(engine.filePlaying);
  const [position, setPosition] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(
    () =>
      engine.subscribe(() => {
        setMicStatus((prev) => (prev === engine.micStatus ? prev : engine.micStatus));
        setMicLabel((prev) => (prev === engine.micLabel ? prev : engine.micLabel));
        setPlaying((prev) => (prev === engine.filePlaying ? prev : engine.filePlaying));
        setPosition(engine.filePosition);
      }),
    [engine],
  );

  const selectSource = (kind: SourceKind) => {
    setSourceState(kind);
    engine.setSource(kind);
  };

  const pickFile = async (file: File) => {
    await engine.loadFile(file);
    setSourceState("file");
    setFileMeta({
      name: engine.fileName,
      duration: engine.fileDuration,
      peaks: engine.filePeaks,
    });
    engine.setSource("file");
  };

  const sourceBtn = (kind: SourceKind, icon: React.ReactNode, label: string) => (
    <button
      type="button"
      onClick={() => selectSource(kind)}
      className={cn(
        "flex flex-1 flex-col items-center gap-1.5 rounded-lg border px-2 py-2.5 text-[10px] font-medium tracking-wide uppercase transition-colors",
        source === kind
          ? "border-foreground/25 bg-foreground/[0.06] text-foreground"
          : "border-border/70 text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      {icon}
      {label}
    </button>
  );

  return (
    <ModuleCard title="Input" subtitle="Program source & preamp">
      <div className="flex gap-2">
        {sourceBtn("mic", <Mic className="size-4" />, "Mic")}
        {sourceBtn("signal", <Radio className="size-4" />, "Signal")}
        {sourceBtn("file", <FileAudio className="size-4" />, "File")}
      </div>

      <div className="mt-3 min-h-[64px] rounded-lg border border-border/60 bg-muted/40 p-2.5">
        {source === "signal" && (
          <div className="flex items-center gap-2">
            {(["tone", "pink"] as SignalMode[]).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => {
                  setSignalModeState(mode);
                  void engine.setSignalMode(mode);
                }}
                className={cn(
                  "rounded-md border px-2.5 py-1 text-[10px] font-medium transition-colors",
                  signalMode === mode
                    ? "border-signal/40 bg-signal/10 text-signal"
                    : "border-border/70 text-muted-foreground hover:bg-background",
                )}
              >
                {mode === "tone" ? "1 kHz tone −18 dBFS" : "Pink noise −18 dBFS"}
              </button>
            ))}
          </div>
        )}

        {source === "mic" && (
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate text-xs font-medium">
                {micStatus === "on"
                  ? micLabel || "Input device"
                  : micStatus === "arming"
                    ? "Requesting access…"
                    : micStatus === "error"
                      ? "Microphone blocked"
                      : "No input armed"}
              </p>
              <p className="mt-0.5 text-[10px] text-muted-foreground">
                Echo cancellation, noise suppression and AGC disabled.
              </p>
            </div>
            <Button
              size="sm"
              variant={micStatus === "on" ? "outline" : "default"}
              className="h-7 shrink-0 text-[11px]"
              onClick={() => {
                if (micStatus === "on") {
                  engine.disarmMic();
                } else {
                  void engine.armMic();
                }
              }}
            >
              {micStatus === "on" ? "Disarm" : "Arm input"}
            </Button>
          </div>
        )}

        {source === "file" && (
          <div className="space-y-2">
            {fileMeta.peaks ? (
              <>
                <Waveform peaks={fileMeta.peaks} />
                <div className="flex items-center gap-2">
                  <Button
                    size="icon"
                    variant="secondary"
                    className="size-7"
                    onClick={() => (playing ? engine.pauseFile() : engine.playFile())}
                    aria-label={playing ? "Pause" : "Play"}
                  >
                    {playing ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
                  </Button>
                  <span className="text-readout text-[11px] text-muted-foreground">
                    {formatTime(position)} / {formatTime(fileMeta.duration)}
                  </span>
                  <span className="ml-auto truncate text-[10px] text-muted-foreground">
                    {fileMeta.name}
                  </span>
                </div>
              </>
            ) : (
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs text-muted-foreground">
                  Decode a local file to audition the full chain.
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 shrink-0 text-[11px]"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Upload className="mr-1.5 size-3.5" />
                  Choose file
                </Button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="audio/*"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void pickFile(f);
                    e.target.value = "";
                  }}
                />
              </div>
            )}
          </div>
        )}
      </div>

      {/* preamp + HPF */}
      <div className="mt-4 flex items-end justify-between gap-3">
        <div className="flex gap-4">
          <Fader
            label="Input"
            value={params.inputGainDb}
            min={-24}
            max={24}
            step={0.5}
            height={118}
            format={(v) => `${v > 0 ? "+" : ""}${v.toFixed(1)}`}
            onChange={(v) => setParams((p) => ({ ...p, inputGainDb: v }))}
          />
          <div className="flex flex-col items-center gap-2">
            <Fader
              label="HPF"
              value={params.hpf.freqHz}
              min={20}
              max={300}
              step={1}
              height={118}
              accent={params.hpf.on}
              format={(v) => formatHz(v)}
              onChange={(v) =>
                setParams((p) => ({ ...p, hpf: { ...p.hpf, freqHz: v } }))
              }
            />
            <label className="flex cursor-pointer items-center gap-1.5 text-[9px] font-semibold tracking-wider text-muted-foreground uppercase">
              <Switch
                checked={params.hpf.on}
                onCheckedChange={(on) =>
                  setParams((p) => ({ ...p, hpf: { ...p.hpf, on } }))
                }
                aria-label="High-pass filter"
              />
              On
            </label>
          </div>
        </div>
        <StereoLevelMeter kind="in" height={158} />
      </div>
    </ModuleCard>
  );
}
