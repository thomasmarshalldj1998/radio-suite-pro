import type { SignalMode, SourceKind } from "@/lib/audio/engine";
import { getEngine } from "@/lib/audio/engine";
import type { ProcessorParams } from "@/lib/audio/params";
import { formatTime } from "@/lib/audio/params";
import { CtrlRow, Seg, Val } from "@/components/console/controls";
import { ModuleCard } from "@/components/console/ModuleCard";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";
import { FileAudio, Mic, Pause, Play, Radio, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";

/** Signed value with typographic minus, always 2 decimal places. */
const sgn = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(2).replace("-", "−")}`;

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
          x / w <= posRatio ? "rgba(74,144,226,0.9)" : "rgba(255,255,255,0.22)";
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

/* ── program source & preamp ────────────────────────────────────────────── */

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
  const [genOn, setGenOn] = useState(engine.generatorOn);
  const [micStatus, setMicStatus] = useState(engine.micStatus);
  const [micLabel, setMicLabel] = useState(engine.micLabel);
  const [inputs, setInputs] = useState(engine.inputDevices);
  const [inputId, setInputId] = useState(engine.inputDeviceId);
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
        setInputs((prev) => (prev === engine.inputDevices ? prev : engine.inputDevices));
        setInputId((prev) => (prev === engine.inputDeviceId ? prev : engine.inputDeviceId));
        setPlaying((prev) => (prev === engine.filePlaying ? prev : engine.filePlaying));
        setPosition(engine.filePosition);
        setSourceState((prev) => (prev === engine.sourceKind ? prev : engine.sourceKind));
        setSignalModeState((prev) =>
          prev === engine.signalMode ? prev : engine.signalMode,
        );
        setGenOn((prev) => (prev === engine.generatorOn ? prev : engine.generatorOn));
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
        "flex items-center justify-center gap-2 rounded border px-3 py-2.5 text-[11px] font-semibold tracking-[0.12em] uppercase transition-colors",
        source === kind
          ? "border-signal bg-signal/15 text-signal"
          : "border-border/70 text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
      aria-pressed={source === kind}
    >
      {icon}
      {label}
    </button>
  );

  return (
    <ModuleCard
      title="Program source & preamp"
      subtitle="Source select · trim · filter · phase · gate"
    >
      {/* source select */}
      <div className="grid grid-cols-3 gap-2">
        {sourceBtn("mic", <Mic className="size-4" />, "Mic")}
        {sourceBtn("signal", <Radio className="size-4" />, "Stream")}
        {sourceBtn("file", <FileAudio className="size-4" />, "File")}
      </div>

      {/* source detail */}
      <div className="mt-3 min-h-[64px] rounded border border-border/60 bg-muted/40 p-2.5">
        {source === "signal" && (
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate text-xs font-medium">
                {genOn
                  ? signalMode === "tone"
                    ? "1 kHz tone · −18 dBFS"
                    : "Pink noise · −18 dBFS"
                  : "Generator off — stream silent"}
              </p>
              <p className="mt-0.5 text-[10px] text-muted-foreground">
                Built-in program stream feeding the chain.
              </p>
            </div>
            <span
              className={cn("led shrink-0", genOn && "led-on")}
              aria-hidden
            />
          </div>
        )}

        {source === "mic" && (
          <div className="space-y-2">
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
            <div className="flex items-center gap-2">
              <select
                className="h-7 min-w-0 flex-1 cursor-pointer truncate rounded border border-border/60 bg-muted/40 px-1.5 text-[11px] text-foreground"
                value={inputId}
                aria-label="Input device"
                onFocus={() => void engine.refreshDevices()}
                onChange={(e) => {
                  setInputId(e.target.value);
                  engine.setInputDevice(e.target.value);
                }}
              >
                <option value="">System default input</option>
                {inputs
                  .filter((d) => d.id)
                  .map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.label}
                    </option>
                  ))}
              </select>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 shrink-0 px-2 text-[11px]"
                onClick={() => void engine.refreshDevices()}
                aria-label="Rescan audio devices"
              >
                ↻
              </Button>
            </div>
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

      {/* control strip */}
      <div className="mt-3 divide-y divide-border/60 rounded border border-border/60 bg-card">
        <CtrlRow label="Input trim">
          <Slider
            className="w-40"
            min={-24}
            max={24}
            step={0.5}
            value={[params.inputGainDb]}
            onValueChange={(v) => setParams((p) => ({ ...p, inputGainDb: v[0] }))}
            aria-label="Input trim"
          />
          <Val>{sgn(params.inputGainDb)} dB</Val>
        </CtrlRow>

        <CtrlRow label="HPF">
          <Slider
            className="w-28"
            min={20}
            max={300}
            step={1}
            disabled={!params.hpf.on}
            value={[params.hpf.freqHz]}
            onValueChange={(v) =>
              setParams((p) => ({ ...p, hpf: { ...p.hpf, freqHz: v[0] } }))
            }
            aria-label="High-pass filter frequency"
          />
          <Val>{params.hpf.freqHz.toFixed(2)} Hz</Val>
          <Seg
            ariaLabel="High-pass filter"
            value={params.hpf.on ? "on" : "bypass"}
            options={[
              { value: "on", label: "On" },
              { value: "bypass", label: "Bypass" },
            ]}
            onChange={(v) =>
              setParams((p) => ({ ...p, hpf: { ...p.hpf, on: v === "on" } }))
            }
          />
        </CtrlRow>

        <CtrlRow label="Phase rot">
          <Seg
            ariaLabel="Phase rotation mode"
            value={params.phase.mode}
            options={[
              { value: "auto", label: "Auto" },
              { value: "manual", label: "Manual" },
            ]}
            onChange={(mode) =>
              setParams((p) => ({
                ...p,
                phase: { ...p.phase, mode: mode as "auto" | "manual" },
              }))
            }
          />
          <Slider
            className="w-28"
            min={100}
            max={1000}
            step={10}
            disabled={params.phase.mode === "auto"}
            value={[params.phase.freqHz]}
            onValueChange={(v) =>
              setParams((p) => ({ ...p, phase: { ...p.phase, freqHz: v[0] } }))
            }
            aria-label="Phase rotation frequency"
          />
          <Val>
            {(params.phase.mode === "auto" ? 300 : params.phase.freqHz).toFixed(2)} Hz
          </Val>
        </CtrlRow>

        <CtrlRow label="Silence gate">
          <Slider
            className="w-24"
            min={-80}
            max={-20}
            step={1}
            disabled={!params.gate.on}
            value={[params.gate.thresholdDb]}
            onValueChange={(v) =>
              setParams((p) => ({ ...p, gate: { ...p.gate, thresholdDb: v[0] } }))
            }
            aria-label="Silence gate threshold"
          />
          <Val>{sgn(params.gate.thresholdDb)} dB</Val>
          <span className="text-[9px] font-semibold tracking-[0.1em] text-muted-foreground uppercase">
            Hold
          </span>
          <Slider
            className="w-16"
            min={0}
            max={2000}
            step={50}
            disabled={!params.gate.on}
            value={[params.gate.holdMs]}
            onValueChange={(v) =>
              setParams((p) => ({ ...p, gate: { ...p.gate, holdMs: v[0] } }))
            }
            aria-label="Silence gate hold"
          />
          <Val>{(params.gate.holdMs / 1000).toFixed(2)} s</Val>
          <Seg
            ariaLabel="Silence gate"
            value={params.gate.on ? "on" : "bypass"}
            options={[
              { value: "on", label: "On" },
              { value: "bypass", label: "Bypass" },
            ]}
            onChange={(v) =>
              setParams((p) => ({ ...p, gate: { ...p.gate, on: v === "on" } }))
            }
          />
        </CtrlRow>
      </div>
    </ModuleCard>
  );
}
