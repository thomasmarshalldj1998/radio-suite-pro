import { Brand } from "@/components/Brand";
import { SpectrumCanvas } from "@/components/console/Spectrum";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { motion } from "framer-motion";
import {
  Activity,
  ArrowRight,
  AudioLines,
  BookOpenText,
  Gauge,
  Headphones,
  Mic2,
  RadioTower,
  Server,
  SlidersHorizontal,
  Sparkles,
  Waves,
  Zap,
} from "lucide-react";
import { Link } from "react-router";

const fadeUp = {
  initial: { opacity: 0, y: 18 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, margin: "-60px" },
  transition: { duration: 0.5, ease: "easeOut" as const },
};

/* ── static console visual pieces (marketing only) ──────────────────────── */

function StaticMeter({ level, peak }: { level: number; peak: number }) {
  return (
    <div className="panel-well flex h-full w-5 flex-col-reverse gap-0.5 rounded p-0.5">
      {Array.from({ length: 22 }).map((_, i) => {
        const on = i < level;
        const color =
          i >= 19 ? "bg-meter-hot" : i >= 15 ? "bg-meter-warn" : "bg-meter-ok";
        return (
          <div
            key={i}
            className={cn(
              "flex-1 rounded-[1px]",
              on ? color : "bg-white/8",
              i === peak && "shadow-[0_0_6px_rgba(255,255,255,0.7)]",
            )}
          />
        );
      })}
    </div>
  );
}

function HeroConsole() {
  const chain = [
    { name: "HPF", on: true },
    { name: "EQ", on: true },
    { name: "MB", on: true },
    { name: "AGC", on: true },
    { name: "LIM", on: true },
  ];
  return (
    <div className="panel rounded-2xl p-4 sm:p-5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span className="led led-on" />
          <span className="text-[10px] font-semibold tracking-[0.18em] text-panel-mut uppercase">
            Program bus
          </span>
        </div>
        <span className="flex items-center gap-1.5 rounded-full bg-signal px-2 py-0.5 text-[9px] font-bold tracking-[0.16em] text-signal-fg uppercase animate-pulse-live">
          <RadioTower className="size-3" /> On air
        </span>
      </div>

      <SpectrumCanvas mode="synthetic" height={188} className="mt-3" />

      <div className="mt-3 grid grid-cols-[auto_1fr] gap-3">
        <div className="flex gap-1.5">
          <StaticMeter level={16} peak={18} />
          <StaticMeter level={14} peak={17} />
        </div>
        <div className="grid grid-cols-3 gap-2">
          {[
            { label: "Loudness", value: "−23.0", unit: "LUFS" },
            { label: "True peak", value: "−1.2", unit: "dBTP" },
            { label: "Limiter GR", value: "−4.8", unit: "dB" },
          ].map((s) => (
            <div key={s.label} className="panel-well rounded-md px-2.5 py-2">
              <p className="text-[8px] font-semibold tracking-[0.12em] text-panel-mut uppercase">
                {s.label}
              </p>
              <p className="text-readout mt-1 text-sm font-semibold text-panel-fg">
                {s.value}
                <span className="ml-1 text-[8px] font-normal text-panel-mut">
                  {s.unit}
                </span>
              </p>
            </div>
          ))}
          <div className="panel-well col-span-3 flex items-center gap-1.5 rounded-md px-2.5 py-2">
            {chain.map((stage, i) => (
              <span key={stage.name} className="flex items-center gap-1.5">
                {i > 0 && <span className="text-[9px] text-panel-mut">→</span>}
                <span className="flex items-center gap-1 rounded bg-white/6 px-1.5 py-0.5 text-[9px] font-semibold tracking-wider text-panel-fg uppercase">
                  <span
                    className="led size-1 animate-pulse-live"
                    style={{ animationDelay: `${i * 0.35}s` }}
                  />
                  {stage.name}
                </span>
              </span>
            ))}
            <span className="ml-auto text-[9px] text-panel-mut">→ encoder</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── page ───────────────────────────────────────────────────────────────── */

const FEATURES = [
  {
    icon: <Waves className="size-5" />,
    title: "3-band multiband compressor",
    body: "Linkwitz-Riley crossovers split the program into independent lanes — bass transients never pump the midrange, sibilance never trips the low band.",
  },
  {
    icon: <SlidersHorizontal className="size-5" />,
    title: "6-band parametric EQ",
    body: "Shelving ends with peaking mids, ±15 dB per band. Shape voice, music beds and overnight rotation with console-grade faders.",
  },
  {
    icon: <Gauge className="size-5" />,
    title: "Program AGC that talks back",
    body: "A wideband leveller with tunable knee, attack and release keeps every source — bed, voice, sweeper — inside a ±2 LU window.",
  },
  {
    icon: <Zap className="size-5" />,
    title: "Brickwall limiter + true peak",
    body: "Hard-knee 20:1 ceiling with inter-sample peak estimation, so what leaves the processor never clips the listener's DAC.",
  },
  {
    icon: <Activity className="size-5" />,
    title: "EBU R128 loudness metering",
    body: "K-weighted BS.1770-4 momentary and short-term loudness, dBTP and stereo correlation — metered the way broadcast engineers meter.",
  },
  {
    icon: <RadioTower className="size-5" />,
    title: "Opus / AAC stream encoder",
    body: "The processed bus is encoded live at 64–320 kbps, measured chunk by chunk, ready for your Icecast or Shoutcast source endpoint.",
  },
];

const CHAIN = [
  { name: "Input", desc: "Mic · generator · files", icon: <Mic2 className="size-4" /> },
  { name: "HPF", desc: "20–300 Hz rumble cut", icon: <Waves className="size-4" /> },
  { name: "EQ", desc: "6-band voicing", icon: <SlidersHorizontal className="size-4" /> },
  { name: "Multiband", desc: "3-band dynamics", icon: <AudioLines className="size-4" /> },
  { name: "AGC", desc: "Wideband levelling", icon: <Gauge className="size-4" /> },
  { name: "Limiter", desc: "−1 dBTP ceiling", icon: <Zap className="size-4" /> },
  { name: "Encoder", desc: "Opus / AAC to Icecast", icon: <RadioTower className="size-4" /> },
];

const STATIONS = [
  "KXNT Talk 101",
  "Nova FM",
  "Pulse Radio",
  "Midnightwave",
  "City Sports AM",
  "Airwave Collective",
];

export default function Landing() {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.4 }}
      className="min-h-screen bg-background"
    >
      {/* ── nav ── */}
      <header className="sticky top-0 z-50 border-b border-border/60 bg-background/85 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5">
          <Brand size={30} />
          <nav className="hidden items-center gap-7 text-sm text-muted-foreground md:flex">
            <a href="#chain" className="transition-colors hover:text-foreground">
              Signal path
            </a>
            <a href="#features" className="transition-colors hover:text-foreground">
              Features
            </a>
            <a href="#metering" className="transition-colors hover:text-foreground">
              Metering
            </a>
            <a href="#encoder" className="transition-colors hover:text-foreground">
              Encoder
            </a>
          </nav>
          <div className="flex items-center gap-2">
            <Button variant="ghost" asChild>
              <Link to="/auth?returnTo=/dashboard">Sign in</Link>
            </Button>
            <Button asChild>
              <Link to="/auth?returnTo=/dashboard">
                Open console
                <ArrowRight className="ml-1.5 size-4" />
              </Link>
            </Button>
          </div>
        </div>
      </header>

      {/* ── hero ── */}
      <section className="relative overflow-hidden">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-[420px] bg-[radial-gradient(60%_100%_at_50%_0%,oklch(0.645_0.19_32/7%),transparent)]"
        />
        <div className="relative mx-auto grid max-w-6xl items-center gap-12 px-5 pt-16 pb-14 lg:grid-cols-[1.05fr_1fr] lg:pt-24">
          <motion.div
            initial={{ opacity: 0, y: 22 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.55, ease: "easeOut" }}
          >
            <span className="inline-flex items-center gap-2 rounded-full border border-signal/25 bg-signal/8 px-3 py-1 text-[11px] font-semibold tracking-[0.14em] text-signal uppercase">
              <Sparkles className="size-3" />
              Broadcast processor · stream encoder
            </span>
            <h1 className="mt-5 text-4xl leading-[1.05] font-bold tracking-tight sm:text-5xl lg:text-[3.4rem]">
              Run your station&apos;s
              <span className="text-signal"> air chain </span>
              with broadcast precision.
            </h1>
            <p className="mt-5 max-w-xl text-base leading-7 text-muted-foreground">
              Signalpath is a full audio processor suite for radio: multiband
              dynamics, parametric EQ, brickwall limiting and EBU R128 loudness
              metering — ending in a live Opus/AAC encoder that feeds your
              Icecast or Shoutcast mount.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Button size="lg" asChild>
                <Link to="/auth?returnTo=/dashboard">
                  Open the console
                  <ArrowRight className="ml-2 size-4" />
                </Link>
              </Button>
              <Button size="lg" variant="outline" asChild>
                <Link to="/auth?returnTo=/dashboard">Sign in to your station</Link>
              </Button>
            </div>
            <dl className="mt-10 grid max-w-lg grid-cols-3 gap-4 border-t border-border/60 pt-6">
              {[
                { k: "Audio path", v: "48 kHz" },
                { k: "Dynamics", v: "3-band + AGC" },
                { k: "Ceiling", v: "−1 dBTP" },
              ].map((s) => (
                <div key={s.k}>
                  <dt className="text-[10px] font-semibold tracking-[0.12em] text-muted-foreground uppercase">
                    {s.k}
                  </dt>
                  <dd className="text-readout mt-1 text-sm font-semibold">{s.v}</dd>
                </div>
              ))}
            </dl>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 30, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ duration: 0.6, delay: 0.12, ease: "easeOut" }}
          >
            <HeroConsole />
          </motion.div>
        </div>

        {/* stations strip */}
        <div className="border-y border-border/60 bg-muted/30">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-center gap-x-10 gap-y-3 px-5 py-5">
            <span className="text-[10px] font-semibold tracking-[0.14em] text-muted-foreground uppercase">
              On air with
            </span>
            {STATIONS.map((s) => (
              <span
                key={s}
                className="text-sm font-semibold tracking-tight text-foreground/55"
              >
                {s}
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* ── signal path ── */}
      <section id="chain" className="mx-auto max-w-6xl scroll-mt-24 px-5 py-20">
        <motion.div {...fadeUp} className="mx-auto max-w-2xl text-center">
          <p className="text-[11px] font-semibold tracking-[0.16em] text-signal uppercase">
            The signal path
          </p>
          <h2 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">
            Every stage a real rack would have
          </h2>
          <p className="mt-4 text-base leading-7 text-muted-foreground">
            A single program bus, processed in order, metered end to end. Bypass
            any stage and the meters keep telling you the truth.
          </p>
        </motion.div>

        <motion.div
          {...fadeUp}
          transition={{ ...fadeUp.transition, delay: 0.08 }}
          className="mt-12 flex flex-wrap items-stretch justify-center gap-2"
        >
          {CHAIN.map((stage, i) => (
            <div key={stage.name} className="flex items-center gap-2">
              {i > 0 && (
                <span className="text-xs text-muted-foreground/50" aria-hidden>
                  →
                </span>
              )}
              <div className="card-layer group min-w-[128px] flex-1 rounded-xl border border-border/70 bg-card px-3.5 py-3 transition-all hover:-translate-y-0.5 hover:border-signal/30">
                <span className="flex size-8 items-center justify-center rounded-lg bg-foreground/6 text-foreground/80 transition-colors group-hover:bg-signal/10 group-hover:text-signal">
                  {stage.icon}
                </span>
                <p className="mt-2.5 text-[11px] font-semibold tracking-[0.1em] text-foreground/90 uppercase">
                  {stage.name}
                </p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">{stage.desc}</p>
              </div>
            </div>
          ))}
        </motion.div>
      </section>

      {/* ── features ── */}
      <section id="features" className="scroll-mt-24 border-y border-border/60 bg-muted/25">
        <div className="mx-auto max-w-6xl px-5 py-20">
          <motion.div {...fadeUp} className="max-w-xl">
            <p className="text-[11px] font-semibold tracking-[0.16em] text-signal uppercase">
              The suite
            </p>
            <h2 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">
              Processional tools, zero rack space
            </h2>
            <p className="mt-4 text-base leading-7 text-muted-foreground">
              Built for operators who care about the details — attack times in
              milliseconds, ceilings in tenths of a dB, loudness in LUFS.
            </p>
          </motion.div>

          <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((f, i) => (
              <motion.article
                key={f.title}
                {...fadeUp}
                transition={{ ...fadeUp.transition, delay: 0.04 * i }}
                className="card-layer group rounded-xl border border-border/70 bg-card p-5 transition-all hover:-translate-y-0.5 hover:border-signal/25 hover:shadow-[0_2px_4px_rgba(16,24,40,0.05),0_18px_44px_-20px_rgba(16,24,40,0.28)]"
              >
                <span className="flex size-10 items-center justify-center rounded-lg bg-foreground/6 text-foreground/85 transition-colors group-hover:bg-signal/10 group-hover:text-signal">
                  {f.icon}
                </span>
                <h3 className="mt-4 text-sm font-semibold tracking-tight">{f.title}</h3>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">{f.body}</p>
              </motion.article>
            ))}
          </div>
        </div>
      </section>

      {/* ── metering spotlight ── */}
      <section id="metering" className="mx-auto max-w-6xl scroll-mt-24 px-5 py-20">
        <div className="grid items-center gap-12 lg:grid-cols-2">
          <motion.div {...fadeUp}>
            <p className="text-[11px] font-semibold tracking-[0.16em] text-signal uppercase">
              Loudness, measured properly
            </p>
            <h2 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">
              Master the loudness,
              <br />
              not just the level
            </h2>
            <p className="mt-4 text-base leading-7 text-muted-foreground">
              Peak meters lie. Signalpath implements ITU-R BS.1770-4
              K-weighting in the browser: momentary and short-term LUFS,
              inter-sample true peak, and stereo correlation — with the EBU
              R128 −23 LUFS target drawn right on the history graph.
            </p>
            <ul className="mt-6 space-y-3">
              {[
                { icon: <Activity className="size-4" />, t: "Momentary & short-term LUFS", d: "400 ms and 3 s windows, updated continuously" },
                { icon: <Gauge className="size-4" />, t: "True peak (dBTP)", d: "Inter-sample peak estimation ahead of the encoder" },
                { icon: <BookOpenText className="size-4" />, t: "Target deviation", d: "Live delta against your −23 LUFS compliance target" },
              ].map((r) => (
                <li key={r.t} className="flex gap-3">
                  <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-signal/10 text-signal">
                    {r.icon}
                  </span>
                  <div>
                    <p className="text-sm font-semibold">{r.t}</p>
                    <p className="text-sm text-muted-foreground">{r.d}</p>
                  </div>
                </li>
              ))}
            </ul>
          </motion.div>

          <motion.div {...fadeUp} transition={{ ...fadeUp.transition, delay: 0.1 }}>
            <div className="panel rounded-2xl p-5">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-semibold tracking-[0.18em] text-panel-mut uppercase">
                  Loudness · BS.1770-4
                </span>
                <span className="rounded-full bg-meter-ok/15 px-2 py-0.5 text-[9px] font-semibold text-meter-ok">
                  ±0.4 LU vs target
                </span>
              </div>
              <div className="mt-4 grid grid-cols-2 gap-4">
                <div>
                  <p className="text-[9px] font-semibold tracking-[0.14em] text-panel-mut uppercase">
                    Momentary
                  </p>
                  <p className="text-readout text-4xl font-semibold text-panel-fg">
                    −23.4
                    <span className="ml-1 text-xs font-normal text-panel-mut">LUFS</span>
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-[9px] font-semibold tracking-[0.14em] text-panel-mut uppercase">
                    Short-term
                  </p>
                  <p className="text-readout text-2xl font-medium text-panel-fg">
                    −22.9
                    <span className="ml-1 text-[10px] font-normal text-panel-mut">LUFS</span>
                  </p>
                </div>
              </div>
              {/* history mock */}
              <div className="panel-well mt-4 rounded-md p-2">
                <svg viewBox="0 0 320 64" className="h-16 w-full" preserveAspectRatio="none">
                  <line x1="0" y1="34" x2="320" y2="34" stroke="rgba(239,91,43,0.5)" strokeWidth="1" strokeDasharray="4 4" />
                  <polyline
                    fill="none"
                    stroke="#3ec48a"
                    strokeWidth="1.6"
                    points="0,38 20,35 40,40 60,33 80,36 100,30 120,35 140,31 160,38 180,34 200,29 220,36 240,32 260,37 280,33 300,35 320,31"
                  />
                </svg>
                <div className="mt-1 flex justify-between text-[8px] text-panel-mut">
                  <span>60 s ago</span>
                  <span>target −23</span>
                  <span>now</span>
                </div>
              </div>
              <div className="mt-4 grid grid-cols-3 gap-2">
                {[
                  { l: "True peak", v: "−1.2 dBTP" },
                  { l: "Correlation", v: "+0.82" },
                  { l: "Limiter GR", v: "−4.8 dB" },
                ].map((s) => (
                  <div key={s.l} className="panel-well rounded-md px-2 py-2">
                    <p className="text-[8px] font-semibold tracking-[0.12em] text-panel-mut uppercase">
                      {s.l}
                    </p>
                    <p className="text-readout mt-1 text-xs font-medium text-panel-fg">
                      {s.v}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </motion.div>
        </div>
      </section>

      {/* ── encoder ── */}
      <section id="encoder" className="scroll-mt-24 border-y border-border/60 bg-muted/25">
        <div className="mx-auto grid max-w-6xl items-center gap-12 px-5 py-20 lg:grid-cols-2">
          <motion.div {...fadeUp} className="order-2 lg:order-1">
            <div className="card-layer overflow-hidden rounded-2xl border border-border/70 bg-card">
              <div className="flex items-center justify-between border-b border-border/60 px-5 py-3.5">
                <span className="flex items-center gap-2 text-[11px] font-semibold tracking-[0.12em] text-foreground/80 uppercase">
                  <Server className="size-4" />
                  Mount configuration
                </span>
                <span className="rounded-full bg-signal px-2 py-0.5 text-[9px] font-bold tracking-[0.14em] text-signal-fg uppercase">
                  On air
                </span>
              </div>
              <table className="w-full text-sm">
                <tbody className="divide-y divide-border/60">
                  {[
                    { k: "Endpoint", v: "stream.yourstation.fm:8000/live" },
                    { k: "Codec", v: "Opus · 48 kHz · 128 kbps" },
                    { k: "Measured", v: "127.4 kbps (live)" },
                    { k: "Uptime", v: "02:41:08" },
                    { k: "Metadata", v: "Nova Waves — Midnight Drive" },
                    { k: "Protocol", v: "Icecast 2 · source auth" },
                  ].map((r) => (
                    <tr key={r.k}>
                      <th className="w-36 px-5 py-2.5 text-left text-[10px] font-semibold tracking-[0.1em] text-muted-foreground uppercase">
                        {r.k}
                      </th>
                      <td className="text-readout px-5 py-2.5 text-xs text-foreground/90">
                        {r.v}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="border-t border-border/60 bg-muted/40 px-5 py-3 text-[11px] text-muted-foreground">
                Chunks are measured as they leave the encoder — you see the real
                bitrate on the wire, not the nominal one.
              </div>
            </div>
          </motion.div>

          <motion.div {...fadeUp} className="order-1 lg:order-2">
            <p className="text-[11px] font-semibold tracking-[0.16em] text-signal uppercase">
              The stream encoder
            </p>
            <h2 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">
              From the program bus to your listeners
            </h2>
            <p className="mt-4 text-base leading-7 text-muted-foreground">
              The processed output feeds a live encoder with production codecs —
              Opus for efficiency, AAC-LC for universal hardware decode. Save
              your mount once, push ICY now-playing metadata, and every session
              is timestamped in the broadcast log.
            </p>
            <dl className="mt-8 grid grid-cols-2 gap-4">
              {[
                { k: "Codecs", v: "Opus · AAC-LC" },
                { k: "Bitrates", v: "64 – 320 kbps" },
                { k: "Endpoints", v: "Icecast 2 · Shoutcast" },
                { k: "Metadata", v: "ICY now-playing" },
              ].map((s) => (
                <div key={s.k} className="rounded-xl border border-border/70 bg-card p-3.5">
                  <dt className="text-[10px] font-semibold tracking-[0.12em] text-muted-foreground uppercase">
                    {s.k}
                  </dt>
                  <dd className="text-readout mt-1 text-sm font-semibold">{s.v}</dd>
                </div>
              ))}
            </dl>
          </motion.div>
        </div>
      </section>

      {/* ── steps ── */}
      <section className="mx-auto max-w-6xl px-5 py-20">
        <motion.div {...fadeUp} className="mx-auto max-w-xl text-center">
          <p className="text-[11px] font-semibold tracking-[0.16em] text-signal uppercase">
            Three steps to air
          </p>
          <h2 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">
            Arm it, shape it, stream it
          </h2>
        </motion.div>
        <div className="mt-12 grid gap-4 md:grid-cols-3">
          {[
            {
              n: "01",
              icon: <Mic2 className="size-5" />,
              t: "Arm a source",
              d: "Microphone, reference generator or a local file — audition the full chain before a single listener hears it.",
            },
            {
              n: "02",
              icon: <SlidersHorizontal className="size-5" />,
              t: "Shape with the chain",
              d: "EQ, multiband, AGC and limiter with live GR meters and BS.1770 loudness. Save any result as a preset.",
            },
            {
              n: "03",
              icon: <RadioTower className="size-5" />,
              t: "Go on air",
              d: "Point the encoder at your mount, hit connect, and watch uptime, measured bitrate and metadata live.",
            },
          ].map((s, i) => (
            <motion.div
              key={s.n}
              {...fadeUp}
              transition={{ ...fadeUp.transition, delay: 0.06 * i }}
              className="card-layer relative rounded-xl border border-border/70 bg-card p-5"
            >
              <span className="text-readout absolute top-5 right-5 text-2xl font-semibold text-foreground/10">
                {s.n}
              </span>
              <span className="flex size-10 items-center justify-center rounded-lg bg-signal/10 text-signal">
                {s.icon}
              </span>
              <h3 className="mt-4 text-sm font-semibold tracking-tight">{s.t}</h3>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">{s.d}</p>
            </motion.div>
          ))}
        </div>
      </section>

      {/* ── quote ── */}
      <section className="border-y border-border/60 bg-muted/25">
        <motion.figure
          {...fadeUp}
          className="mx-auto max-w-3xl px-5 py-16 text-center"
        >
          <Headphones className="mx-auto size-6 text-signal" />
          <blockquote className="mt-6 text-xl leading-9 font-medium tracking-tight sm:text-2xl sm:leading-10">
            “We replaced a shelf of outboard gear with Signalpath. The multiband
            and the loudness metering alone changed how our morning show sounds
            — and the encoder just stays locked all day.”
          </blockquote>
          <figcaption className="mt-6 text-sm text-muted-foreground">
            <span className="font-semibold text-foreground">Dana Okafor</span> ·
            Program Director, Nova FM
          </figcaption>
        </motion.figure>
      </section>

      {/* ── CTA ── */}
      <section className="mx-auto max-w-6xl px-5 py-20">
        <motion.div
          {...fadeUp}
          className="panel relative overflow-hidden rounded-2xl px-6 py-14 text-center sm:px-12"
        >
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 bg-[radial-gradient(70%_120%_at_50%_0%,oklch(0.645_0.19_32/16%),transparent)]"
          />
          <div className="relative">
            <Brand size={38} className="mx-auto" />
            <h2 className="mx-auto mt-6 max-w-2xl text-3xl font-bold tracking-tight text-panel-fg sm:text-4xl">
              Your air chain, running in the browser
            </h2>
            <p className="mx-auto mt-4 max-w-xl text-sm leading-6 text-panel-mut">
              Start the engine, audition a source, and be on air in minutes —
              no rack, no installer, no guesswork.
            </p>
            <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
              <Button size="lg" asChild>
                <Link to="/auth?returnTo=/dashboard">
                  Open the console
                  <ArrowRight className="ml-2 size-4" />
                </Link>
              </Button>
              <Button
                size="lg"
                variant="outline"
                className="border-white/15 bg-white/5 text-panel-fg hover:bg-white/10"
                asChild
              >
                <Link to="/auth?returnTo=/dashboard">Create your station</Link>
              </Button>
            </div>
          </div>
        </motion.div>
      </section>

      {/* ── footer ── */}
      <footer className="border-t border-border/60">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-6 px-5 py-10 sm:flex-row">
          <Brand size={26} tagline="Broadcast precision" />
          <nav className="flex flex-wrap items-center justify-center gap-6 text-sm text-muted-foreground">
            <a href="#chain" className="transition-colors hover:text-foreground">
              Signal path
            </a>
            <a href="#features" className="transition-colors hover:text-foreground">
              Features
            </a>
            <a href="#encoder" className="transition-colors hover:text-foreground">
              Encoder
            </a>
            <Link to="/auth?returnTo=/dashboard" className="transition-colors hover:text-foreground">
              Sign in
            </Link>
          </nav>
          <p className="text-xs text-muted-foreground">
            © {new Date().getFullYear()} Signalpath · Built for radio operators
          </p>
        </div>
      </footer>
    </motion.div>
  );
}
