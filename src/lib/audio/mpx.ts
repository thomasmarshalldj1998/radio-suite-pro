/**
 * FM composite (MPX) generator — pure DSP, no DOM/Web Audio dependencies.
 *
 * Builds the baseband signal an FM exciter would receive, from the program
 * bus at the engine rate (44.1/48 kHz), following ITU-R BS.450 / FCC 73.319
 * / IEC 62106 structure:
 *
 *   L,R ── pre-emphasis (50/75 µs shelf) ── 15 kHz brickwall ─┐
 *                                                             ├─ stereo matrix
 *   composite @4× rate:   0.9·(L+R)/2                        │
 *                       + 0.9·(L−R)/2·cos(2φ)   φ = 19 kHz   │
 *                       + pilot·sin(φ)          8–10 %       │
 *                       + RDS·biphase·sin(3φ)   57 kHz       │
 *                       + SCA·sin(ψ)            67 kHz       │
 *                       → composite clipper (ceiling %)  ─────┘
 *
 * Deviation accounting: the composite is normalised so ±1.0 = ±75 kHz =
 * 100 % modulation. A single-channel full-scale drive reaches 45 % on its
 * channel plus the shared 45 % cross term — the classic 45/45/10 allocation
 * (90 % audio + 10 % subcarriers).
 *
 * Everything here is deterministic and unit-testable; scripts/verify-fm.ts
 * sweeps the filters, checks the RDS CRC framing and measures the composite
 * spectrum against the spec allocation.
 */
import { MPX_WINDOW_SECONDS, mpxPowerDbr } from "./compliance";
import type { FmParams } from "./params";

/* ── constants ─────────────────────────────────────────────────────────── */

/** Composite (MPX) synthesis rate — 4× a 48 kHz engine, FLAC-friendly. */
export const MPX_RATE = 192000;
/** RDS bit rate (IEC 62106): 57 kHz / 48 exactly. */
export const RDS_BIT_RATE = 1187.5;
/** Pilot frequency — every subcarrier derives from this phase accumulator. */
const PILOT_HZ = 19000;
const SCA_HZ = 67000;

/** Pre-emphasis time constants → corner frequency 1/(2πτ). */
export const EMPHASIS_TAU: Record<"50" | "75", number> = {
  "50": 50e-6,
  "75": 75e-6,
};

export function emphasisCornerHz(emphasis: "50" | "75"): number {
  return 1 / (2 * Math.PI * EMPHASIS_TAU[emphasis]);
}

/** Ideal pre-emphasis gain at f: |H| = √(1 + (2πfτ)²). */
export function emphasisBoostDb(emphasis: "50" | "75", fHz: number): number {
  const w = 2 * Math.PI * fHz * EMPHASIS_TAU[emphasis];
  return 10 * Math.log10(1 + w * w);
}

/* ── FIR design (windowed inverse FFT, Kaiser window) ──────────────────── */

function besselI0(x: number): number {
  let sum = 1;
  let term = 1;
  const half = x / 2;
  for (let k = 1; k < 40; k++) {
    term *= (half / k) * (half / k);
    sum += term;
    if (term < 1e-14 * sum) break;
  }
  return sum;
}

function kaiserBeta(stopbandDb: number): number {
  if (stopbandDb <= 21) return 0;
  const a = stopbandDb - 21;
  return 0.5842 * Math.pow(a, 0.4) + 0.07886 * a;
}

/**
 * Linear-phase lowpass with an arbitrary passband shape.
 *
 * `shapeDb(fHz)` returns the desired gain in dB for f ≤ stopHz; a half-cosine
 * transition follows up to transHz, then zero. Used for the combined
 * pre-emphasis + 15 kHz brickwall (both LTI — the cascade is one filter).
 */
function designShapedLpf(opts: {
  sampleRate: number;
  taps: number;
  shapeDb: (f: number) => number;
  passHz: number;
  transHz: number;
  stopbandDb: number;
}): Float64Array {
  const { sampleRate: fs, taps: n, shapeDb, passHz, transHz, stopbandDb } = opts;
  const mid = (n - 1) / 2;
  const m = 2048;
  const h = new Float64Array(m);
  for (let k = 0; k <= m / 2; k++) {
    const f = (k / m) * fs;
    let g: number;
    if (f <= passHz) {
      g = Math.pow(10, shapeDb(f) / 20);
    } else if (f < transHz) {
      const t = (f - passHz) / (transHz - passHz);
      g = Math.pow(10, shapeDb(passHz) / 20) * 0.5 * (1 + Math.cos(Math.PI * t));
    } else {
      g = 0;
    }
    h[k] = g;
    if (k > 0 && k < m / 2) h[m - k] = g;
  }
  // inverse FFT → zero-phase impulse, centred at index 0. The spectrum is
  // real-even, so the forward DFT already equals the (real) inverse up to
  // scaling — one FFT instead of an O(m²) transform.
  const re = new Float32Array(m);
  const im = new Float32Array(m);
  for (let k = 0; k < m; k++) re[k] = h[k];
  fft(re, im);
  const beta = kaiserBeta(stopbandDb);
  const out = new Float64Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const idx = ((i - mid) % m + m) % m;
    const w =
      besselI0(beta * Math.sqrt(1 - Math.pow((i - mid) / mid, 2))) /
      besselI0(beta);
    out[i] = (re[idx] / m) * w;
    sum += out[i];
  }
  for (let i = 0; i < n; i++) out[i] /= sum; // exact unity gain at DC
  return out;
}

/**
 * Upsampling interpolator prototype: ×L zero-stuff image killer.
 *
 * Normalised so the total tap sum equals `l` — each polyphase branch then
 * sums to ≈1, giving the branch unity gain (zero-stuffing dilutes amplitude
 * by 1/L, so the prototype must supply the L back).
 */
function designInterpLpf(taps: number, cutoffHz: number, fs: number, l: number): Float64Array {
  const mid = (taps - 1) / 2;
  const beta = kaiserBeta(85);
  const out = new Float64Array(taps);
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const x = i - mid;
    const s = x === 0 ? 1 : Math.sin((2 * Math.PI * cutoffHz * x) / fs) / ((2 * Math.PI * cutoffHz * x) / fs);
    const w =
      besselI0(beta * Math.sqrt(1 - Math.pow(x / mid, 2))) / besselI0(beta);
    out[i] = s * w;
    sum += out[i];
  }
  for (let i = 0; i < taps; i++) out[i] = (out[i] / sum) * l; // Σ = L → each branch sums to ≈1
  return out;
}

/* ── FIR filters ───────────────────────────────────────────────────────── */

/** History-delay FIR (linear phase, direct convolution). */
class FirFilter {
  private readonly taps: Float64Array;
  private hist: Float64Array;
  private scratch: Float64Array;
  constructor(taps: Float64Array, blockSize: number) {
    this.taps = taps;
    this.hist = new Float64Array(taps.length - 1);
    this.scratch = new Float64Array(taps.length - 1 + blockSize);
  }
  process(input: Float32Array, output: Float32Array): void {
    const n = this.taps.length;
    const m = input.length;
    if (m + n - 1 > this.scratch.length) {
      this.scratch = new Float64Array(m + n - 1);
    }
    this.scratch.set(this.hist, 0);
    this.scratch.set(input, n - 1);
    for (let i = 0; i < m; i++) {
      let acc = 0;
      for (let k = 0; k < n; k++) {
        acc += this.taps[k] * this.scratch[i + n - 1 - k];
      }
      output[i] = acc;
    }
    this.hist.set(this.scratch.subarray(m, m + n - 1));
  }
}

/** ×L polyphase interpolator (16 taps per phase, L=4). */
class PolyphaseUpsampler {
  private readonly l = 4;
  private readonly pp: number;
  private readonly proto: Float64Array;
  private readonly hist: Float64Array;
  private scratch: Float64Array;
  constructor(proto: Float64Array) {
    this.proto = proto;
    this.pp = proto.length / this.l;
    this.hist = new Float64Array(this.pp);
    this.scratch = new Float64Array(this.pp - 1 + 4096);
  }
  process(input: Float32Array, output: Float32Array): void {
    const { pp, l, proto, scratch } = this;
    const m = input.length;
    if (m + pp - 1 > scratch.length) this.scratch = new Float64Array(m + pp - 1);
    const buf = this.scratch;
    buf.set(this.hist, 0);
    buf.set(input, pp - 1);
    for (let i = 0; i < m; i++) {
      for (let p = 0; p < l; p++) {
        let acc = 0;
        // polyphase branch p taps: proto[p], proto[p+L], proto[p+2L] …
        for (let k = 0; k < pp; k++) {
          acc += proto[k * l + p] * buf[i + pp - 1 - k];
        }
        output[i * l + p] = acc;
      }
    }
    this.hist.set(buf.subarray(m, m + pp - 1));
  }
}

/* ── RDS (IEC 62106) group 0A encoder ──────────────────────────────────── */

/** CRC-10 generator: x¹⁰+x⁸+x⁷+x⁵+x⁴+x³+1 (IEC 62106 §3.2.2). */
const RDS_POLY = 0b10110111001; // 0x5B9

/** Block offset words identifying A/B/C/C′/D within a group. */
const RDS_OFFSET = { A: 0x0fc, B: 0x198, C: 0x168, D: 0x1b4 } as const;

/** Application identification carried in group 3A for RadioText Plus. */
export const RDS_RTPLUS_AID = 0x4bd7;
/**
 * Application group type code announced for RT+: group 11, version A. The
 * four type bits and the version bit are sent as one five-bit field.
 */
export const RDS_RTPLUS_AGTC = (11 << 1) | 0;
/** RT+ content types (IEC 62106-6 annex A). */
export const RDS_RTPLUS_TAG = {
  title: 1,
  album: 2,
  track: 3,
  artist: 4,
  comment: 10,
  genre: 11,
} as const;

/** Content-type names for the tags this encoder emits. */
export const RDS_RTPLUS_TAG_NAMES: Record<number, string> = {
  0: "undefined",
  1: "Item.Title",
  2: "Item.Album",
  3: "Item.Tracknumber",
  4: "Item.Artist",
  5: "Item.Composition",
  6: "Item.Movement",
  7: "Item.Conductor",
  8: "Item.Composer",
  9: "Item.Band",
  10: "Item.Comment",
  11: "Item.Genre",
  12: "Info.News",
  31: "StationName.Short",
  32: "StationName.Long",
  33: "Program.Now",
  34: "Program.Next",
};

/** One RT+ tag: a content type plus a character range of the RadioText. */
export interface RdsTag {
  type: number;
  /** Zero-based character offset into the RadioText. */
  start: number;
  /** Characters *after* the first, which is how the marker is defined. */
  len: number;
}

/**
 * Read the two RT+ tags out of a RadioText string: with "artist - title" in
 * the text the artist is tagged first, otherwise the whole line is the title.
 * Tag 1's length marker is six bits (up to 64 characters), tag 2's is five
 * (up to 32), so both are clamped to what the field can carry.
 */
export function rdsRtPlusTags(rt: string): RdsTag[] {
  if (!rt) return [];
  const tags: RdsTag[] = [];
  const sep = rt.indexOf(" - ");
  if (sep > 0 && rt.length > sep + 3) {
    tags.push({
      type: RDS_RTPLUS_TAG.artist,
      start: 0,
      len: Math.min(rt.slice(0, sep).length - 1, 63),
    });
    tags.push({
      type: RDS_RTPLUS_TAG.title,
      start: sep + 3,
      len: Math.min(rt.slice(sep + 3).length - 1, 31),
    });
  } else {
    tags.push({
      type: RDS_RTPLUS_TAG.title,
      start: 0,
      len: Math.min(rt.length - 1, 63),
    });
  }
  return tags;
}

/** A slot in the repeating group cycle. */
export type RdsSlot = "0A" | "2A" | "3A" | "11A";

/**
 * The repeating group cycle: four PS groups, a text group, another four PS
 * groups, a second text group, then the RadioText Plus pair — the 3A
 * announcement followed by the 11A tag group.
 *
 * With RT+ off (or no RadioText) the ODA pair is skipped, which leaves the
 * classic one-text-group-per-four-PS pattern. Slots that carry nothing (2A
 * with no text) fall back to PS.
 */
export const RDS_SCHEDULE: readonly RdsSlot[] = [
  "0A",
  "0A",
  "0A",
  "0A",
  "2A",
  "0A",
  "0A",
  "0A",
  "0A",
  "2A",
  "3A",
  "11A",
];

function crc10(data16: number): number {
  let reg = data16 << 10; // 26-bit working register
  for (let i = 25; i >= 10; i--) {
    if (reg & (1 << i)) reg ^= RDS_POLY << (i - 10);
  }
  return reg & 0x3ff;
}

/** 26-bit block: 16 data bits + (CRC-10 ⊕ offset word). */
export function rdsBlock(data16: number, offset: number): number {
  return (((data16 << 10) | (crc10(data16) ^ offset)) >>> 0);
}

/**
 * Fold free text into what an RDS receiver can actually display.
 *
 * The character set is a single byte rendered with the receiver's own font, so
 * accented characters are transliterated rather than sent as UTF-8 (which a
 * receiver shows as mojibake), control characters become spaces and the result
 * is trimmed. Metadata coming from the station database goes through here
 * before it reaches RadioText.
 */
export function rdsAscii(text: string, max = 64): string {
  return (text ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7e]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/**
 * Alternative-frequency code for a frequency in MHz (87.6–107.9 → 1–204),
 * or 0 when the frequency is outside the broadcast band. Receivers step the
 * code exactly once to land on the neighbouring carrier.
 */
export function rdsAfCode(mhz: number): number {
  if (!Number.isFinite(mhz)) return 0;
  const code = Math.round(mhz * 10) - 875;
  return code >= 1 && code <= 204 ? code : 0;
}

/**
 * RDS group generator (IEC 62106).
 *
 * Emits the standard pair of group types:
 *
 *   · **0A** — block B carries type A + TP + PTY + TA/MS/DI + the two-bit PS
 *     segment address; block C carries the alternative-frequency list (or the
 *     no-AF filler); block D carries two PS characters.
 *   · **2A** — block B carries type 2A + the AB flag + a four-bit text address;
 *     blocks C and D carry four RadioText characters, the message terminated
 *     by 0x0D once the text runs out.
 *   · **3A / 11A** — RadioText Plus. The 3A group announces the application
 *     (aid 0x4BD7) as data carried in group 11A; the 11A group then tags two
 *     character ranges of the current RadioText with their content types, so a
 *     receiver can show the artist and title as separate fields. The tag
 *     toggle bit flips whenever the text becomes a new item.
 *
 * One 2A group follows every four 0A groups, so the 8-character name still
 * cycles in four groups while a 64-character RadioText refreshes in about two
 * seconds. MSB first, per the standard.
 *
 * Text edits can be delayed (`delayMs`) so the display lines up with audio
 * that is itself delayed — the first value of each field is shown immediately
 * so the encoder never comes up blank — and a PS longer than eight characters
 * scrolls through the receiver's window instead of being cut off.
 */
export class RdsBitSource {
  private bits: number[] = [];
  private idx = 0;
  private psSeg = 0;
  private rtSeg = 0;
  /** 0A groups since the last 2A group. */
  private slot = 0;
  private scrollStep = 0;
  /** RadioText Plus: 3A announcement + 11A tags. */
  private rtPlus = false;
  private odaToggle = 0;
  private odaItem = "";
  private pending: { at: number; ps?: string; rt?: string } | null = null;
  /** An edit has been applied, so later edits must wait out the delay. */
  private applied = false;
  private ps: string;
  private rt = "";
  private af: number[] = [];
  private scroll = false;
  private delayMs = 0;
  pi = 0x1234;
  pty = 10;
  tp = 0;
  /** Groups emitted since construction — a stall shows up as no advance. */
  groups = 0;

  constructor(pi: number, ps: string, pty = 10, tp = 0) {
    this.pi = pi & 0xffff;
    this.pty = pty & 0x1f;
    this.tp = tp & 1;
    this.ps = RdsBitSource.sanitise(ps);
  }

  /** Text as the receiver will render it (single-byte, printable). */
  private static sanitise(text: string): string {
    return rdsAscii(text);
  }

  /** Exactly the eight characters a non-scrolling receiver displays. */
  private static pad8(text: string): string {
    return (text + "        ").slice(0, 8);
  }

  /** Programme identification from a 1–4 digit hex string ("C479"). */
  static parsePi(input: string, fallback = 0x1234): number {
    const clean = (input ?? "").trim().replace(/^0x/i, "");
    if (!/^[0-9a-fA-F]{1,4}$/.test(clean)) return fallback & 0xffff;
    return parseInt(clean, 16) & 0xffff;
  }

  /** Change signature the generator uses to diff RDS settings per update. */
  static signature(mpx: FmParams["mpx"]): string {
    // defensive: the worker is fed coerced params, but presets, the CLI
    // verification script and stale saved state can still arrive partial
    return [
      mpx.rdsPi ?? "",
      mpx.rdsPty ?? 0,
      mpx.rdsPs ?? "",
      mpx.rdsRt ?? "",
      mpx.rdsScroll ? 1 : 0,
      mpx.rdsDelayMs ?? 0,
      mpx.rdsRtPlus ? 1 : 0,
      (mpx.rdsAf ?? []).join(","),
    ].join("|");
  }

  /** Apply encoder settings; text changes honour the configured delay. */
  setConfig(cfg: {
    pi?: number;
    pty?: number;
    tp?: number;
    ps?: string;
    rt?: string;
    af?: number[];
    scroll?: boolean;
    delayMs?: number;
    rtPlus?: boolean;
  }): void {
    if (cfg.pi !== undefined) this.pi = cfg.pi & 0xffff;
    if (cfg.pty !== undefined) this.pty = cfg.pty & 0x1f;
    if (cfg.tp !== undefined) this.tp = cfg.tp & 1;
    if (cfg.scroll !== undefined) this.scroll = cfg.scroll;
    if (cfg.rtPlus !== undefined) this.rtPlus = cfg.rtPlus;
    if (cfg.af !== undefined) this.af = cfg.af.slice(0, 8);
    if (cfg.delayMs !== undefined) this.delayMs = Math.max(0, cfg.delayMs);

    const ps = cfg.ps === undefined ? undefined : RdsBitSource.sanitise(cfg.ps);
    const rt =
      cfg.rt === undefined ? undefined : RdsBitSource.sanitise(cfg.rt);
    if (ps === undefined && rt === undefined) return;

    if (this.delayMs === 0 || !this.applied) {
      if (ps !== undefined) {
        this.ps = ps;
        this.scrollStep = 0;
      }
      if (rt !== undefined) this.rt = rt;
      this.pending = null;
      this.applied = true;
      return;
    }
    this.pending = { at: Date.now() + this.delayMs, ps, rt };
  }

  /** Compatibility shim for PS-only call sites. */
  setPs(ps: string): void {
    this.setConfig({ ps });
  }

  /** Apply a delayed text edit once its deadline has passed. */
  private applyPending(now: number): void {
    const p = this.pending;
    if (!p || now < p.at) return;
    if (p.ps !== undefined) {
      this.ps = p.ps;
      this.scrollStep = 0;
    }
    if (p.rt !== undefined) this.rt = p.rt;
    this.pending = null;
    this.applied = true;
  }

  /** The eight-character window the receiver should be showing right now. */
  private psWindow(): string {
    if (this.ps.length <= 8) return RdsBitSource.pad8(this.ps);
    if (!this.scroll) return this.ps.slice(0, 8);
    // one pass of the name, then a gap, wrapped so the window is continuous
    const cycle = `${this.ps}    `;
    const step = this.scrollStep % cycle.length;
    return (cycle + cycle).slice(step, step + 8);
  }

  /**
   * Group 0A block C. The count field states how many alternatives *this*
   * group carries, so a single entry is always an honest announcement even
   * when the station lists several frequencies.
   */
  private afBlockC(): number {
    const first = this.af.map(rdsAfCode).find((code) => code > 0);
    return first ? (1 << 8) | first : 0xdce8;
  }

  /**
   * Next usable slot in the repeating cycle. A slot that has nothing to carry
   * is stepped over: no RadioText means no text groups and no ODA, and RT+ off
   * means no 3A/11A — which leaves the plain PS-and-text cycle.
   */
  private nextSlot(): RdsSlot {
    const len = RDS_SCHEDULE.length;
    for (let i = 0; i < len; i++) {
      const at = (this.slot + i) % len;
      const slot = RDS_SCHEDULE[at];
      const usable =
        slot === "0A" ||
        (slot === "2A" && this.rt.length > 0) ||
        ((slot === "3A" || slot === "11A") &&
          this.rtPlus &&
          this.rt.length > 0);
      if (usable) {
        this.slot = (at + 1) % len;
        return slot;
      }
    }
    return "0A";
  }

  /** Group 11A — RadioText Plus: two tags, addressed into the current text. */
  private rtPlusBlocks(): { blockB: number; blockC: number; blockD: number } {
    if (this.rt !== this.odaItem) {
      // a new item: flip the toggle so receivers re-read the tags and return
      // the old tag positions rather than carrying them into the new text
      this.odaItem = this.rt;
      this.odaToggle ^= 1;
    }
    const [first, second] = rdsRtPlusTags(this.rt);
    const a = first ?? { type: 0, start: 0, len: 0 };
    const b = second ?? { type: 0, start: 0, len: 0 };
    return {
      // B: type 11 (1011) + version A, TP, PTY, item toggle, item running,
      // then the top three bits of tag 1's content type
      blockB:
        (11 << 12) |
        (this.tp << 10) |
        (this.pty << 5) |
        ((this.odaToggle & 1) << 4) |
        (a.type !== 0 ? 1 << 3 : 0) |
        ((a.type >> 3) & 0b111),
      blockC:
        ((a.type & 0b111) << 13) |
        ((a.start & 0x3f) << 7) |
        ((a.len & 0x3f) << 1) |
        ((b.type >> 5) & 1),
      blockD:
        ((b.type & 0b11111) << 11) |
        ((b.start & 0x3f) << 5) |
        (b.len & 0x1f),
    };
  }

  private buildGroup(): void {
    this.applyPending(Date.now());
    const slot = this.nextSlot();

    let blockB: number;
    let blockC: number;
    let blockD: number;

    if (slot === "2A") {
      const seg = this.rtSeg; // four-bit text address on 2A
      blockB =
        (2 << 12) | (0 << 11) | (this.tp << 10) | (this.pty << 5) | (0 << 4) | seg;
      const text = (this.rt + "\r".repeat(64)).slice(0, 64);
      blockC =
        ((text.charCodeAt(seg * 4) & 0xff) << 8) |
        (text.charCodeAt(seg * 4 + 1) & 0xff);
      blockD =
        ((text.charCodeAt(seg * 4 + 2) & 0xff) << 8) |
        (text.charCodeAt(seg * 4 + 3) & 0xff);
      this.rtSeg = (seg + 1) & 15;
    } else if (slot === "3A") {
      // ODA announcement: the AGTC names group 11A as the data carrier and
      // block C carries the RT+ application identification
      blockB = (3 << 12) | (this.tp << 10) | (this.pty << 5) | RDS_RTPLUS_AGTC;
      blockC = RDS_RTPLUS_AID;
      blockD = 0;
    } else if (slot === "11A") {
      ({ blockB, blockC, blockD } = this.rtPlusBlocks());
    } else {
      const seg = this.psSeg;
      // B: group type 0A, B0=0, TP, PTY, TA=0, MS=1 (music), DI (the stereo
      // bit rotates with the segment per the DI spread), C1C0 = address
      const di = (0b1000 >> seg) & 1;
      blockB =
        (0 << 12) | (0 << 11) | (this.tp << 10) | (this.pty << 5) | (0 << 4) |
        (1 << 3) | (di << 2) | seg;
      const window = this.psWindow();
      blockC = this.afBlockC();
      blockD =
        (this.char(window, 2 * seg) << 8) | this.char(window, 2 * seg + 1);
      this.psSeg = (seg + 1) & 3;
      if (this.psSeg === 0) this.scrollStep += 1;
    }

    const blocks: [number, number][] = [
      [this.pi, RDS_OFFSET.A],
      [blockB, RDS_OFFSET.B],
      [blockC, RDS_OFFSET.C],
      [blockD, RDS_OFFSET.D],
    ];
    this.bits = [];
    for (const [data, offset] of blocks) {
      const word = rdsBlock(data, offset);
      for (let b = 25; b >= 0; b--) this.bits.push((word >> b) & 1);
    }
    this.idx = 0;
    this.groups += 1;
  }

  private char(text: string, i: number): number {
    const c = text.charCodeAt(i);
    return Number.isNaN(c) || c === 0 ? 0x20 : c & 0xff;
  }

  next(): number {
    if (this.idx >= this.bits.length) this.buildGroup();
    return this.bits[this.idx++];
  }
}

/* ── composite generator ───────────────────────────────────────────────── */

export interface MpxComponents {
  /** Main channel (L+R) deviation, % — 0.9·max|M|. */
  mainPct: number;
  /** Stereo difference (L−R @38 kHz) deviation, % — 0.9·max|S|. */
  subPct: number;
  pilotPct: number;
  rdsPct: number;
  scaPct: number;
}

export interface MpxTickStats {
  /** Peak composite demand (pre-clip), % of ±75 kHz. */
  modPct: number;
  /** Slow-decay peak hold for the deviation meter. */
  peakHoldPct: number;
  /** Fraction of samples clipped this tick, %. */
  clipPct: number;
  /** Demand over the alarm threshold continuously for ≥5 s. */
  sustainedOver: boolean;
  alarmPct: number;
  ceilingPct: number;
  components: MpxComponents;
  /**
   * BS.412 multiplex power over the last 60 s, dBr — 0 dBr is the power of a
   * sine at ±19 kHz peak deviation, which the clause makes the limit.
   */
  powerDbr: number;
  /** Seconds of composite actually inside that averaging window. */
  powerWindowSeconds: number;
  /** RDS groups emitted during this tick (a stall means no data is moving). */
  rdsGroups: number;
  /** 19 kHz pilot is being injected — receivers cannot lock without it. */
  pilotOn: boolean;
  /** The RDS subcarrier is injected at a non-zero level. */
  rdsOn: boolean;
}

const OVER_SUSTAIN_MS = 5000;

export class MpxGenerator {
  readonly inRate: number;
  readonly outRate: number;
  private fm: FmParams;

  // per-channel emphasis + brickwall, then ×4 interpolation
  private empL: FirFilter;
  private empR: FirFilter;
  private upM: PolyphaseUpsampler;
  private upS: PolyphaseUpsampler;
  private monoBuf: Float32Array;
  private sideBuf: Float32Array;
  private empOutL: Float32Array;
  private empOutR: Float32Array;
  private sideHi: Float32Array;
  private compBuf: Float32Array;

  // RDS
  private rdsBits: RdsBitSource;
  private rdsPrevEnc = 0;
  private rdsCurEnc = 0;
  private halfPhase = 0;
  private inSecondHalf = false;
  private rdsShaper: Biquad;
  private rdsShaper2: Biquad;
  private rdsPs: string;
  private rdsSig = "";
  private rdsGroupsAtStats = 0;

  // oscillator phases (all subcarriers derive from the pilot accumulator)
  private phi = 0; // 19 kHz pilot phase
  private psi = 0; // 67 kHz SCA phase (independent oscillator)
  private readonly wPilot: number;
  private readonly wSca: number;

  // metering
  private maxPre = 0;
  private maxM = 0;
  private maxS = 0;
  private clipSamples = 0;
  private totalSamples = 0;
  private overSamples = 0;
  private peakHold = 0;
  private overSince = 0;

  // BS.412 multiplex power: 100 ms blocks of composite energy, 60 s of them
  private mpxBlocks: { sum: number; n: number }[] = [];
  private mpxBlockSum = 0;
  private mpxBlockN = 0;
  private mpxWindowSum = 0;
  private mpxWindowN = 0;
  private readonly mpxBlockSamples: number;
  private readonly mpxMaxBlocks: number;

  private readonly block: number;

  constructor(inRate: number, fm: FmParams, blockSize = 4096) {
    this.inRate = inRate;
    this.outRate = inRate * 4;
    this.fm = fm;
    this.block = blockSize;
    // 100 ms energy blocks, enough of them to cover the BS.412 60 s interval
    this.mpxBlockSamples = Math.max(16, Math.round(this.outRate / 10));
    this.mpxMaxBlocks = Math.round(MPX_WINDOW_SECONDS * 10);
    const tau = fm.emphasis === "off" ? null : EMPHASIS_TAU[fm.emphasis];
    const empTaps = this.designEmphasis(tau);

    // both channels share one tap set (FIR never mutates its taps)
    this.empL = new FirFilter(empTaps, blockSize);
    this.empR = new FirFilter(empTaps, blockSize);
    // interpolation: flat across the 15 kHz audio band (passband ≈18.6 kHz),
    // ≥85 dB down from ≈29 kHz up — kills every image of the brickwalled
    // programme (first image at 48k−15k = 33 kHz)
    const proto = designInterpLpf(96, 24000, this.outRate, 4);
    this.upM = new PolyphaseUpsampler(proto);
    this.upS = new PolyphaseUpsampler(proto);
    this.monoBuf = new Float32Array(blockSize);
    this.sideBuf = new Float32Array(blockSize);
    this.empOutL = new Float32Array(blockSize);
    this.empOutR = new Float32Array(blockSize);
    this.sideHi = new Float32Array(blockSize * 4);
    this.compBuf = new Float32Array(blockSize * 4);

    this.rdsPs = fm.mpx.rdsPs;
    this.rdsBits = new RdsBitSource(
      RdsBitSource.parsePi(fm.mpx.rdsPi),
      fm.mpx.rdsPs,
      fm.mpx.rdsPty,
    );
    this.rdsBits.setConfig({
      rt: fm.mpx.rdsRt,
      af: fm.mpx.rdsAf,
      scroll: fm.mpx.rdsScroll,
      delayMs: fm.mpx.rdsDelayMs,
      rtPlus: fm.mpx.rdsRtPlus,
    });
    this.rdsSig = RdsBitSource.signature(fm.mpx);
    this.rdsGroupsAtStats = 0;
    // 4th-order 2.4 kHz lowpass on the biphase stream — the IEC 62106
    // spectrum mask confines RDS to roughly ±2.4 kHz around 57 kHz
    this.rdsShaper = Biquad.lowpass(2400, this.outRate);
    this.rdsShaper2 = Biquad.lowpass(2400, this.outRate);
    this.wPilot = (2 * Math.PI * PILOT_HZ) / this.outRate;
    this.wSca = (2 * Math.PI * SCA_HZ) / this.outRate;
  }

  /** Emphasis shelf × 15 kHz brickwall (transition 15→18 kHz, ≥75 dB down). */
  private designEmphasis(tau: number | null): Float64Array {
    return designShapedLpf({
      sampleRate: this.inRate,
      taps: 161,
      passHz: 15000,
      transHz: 18000,
      stopbandDb: 75,
      shapeDb: (f) => (tau === null ? 0 : 10 * Math.log10(1 + Math.pow(2 * Math.PI * f * tau, 2))),
    });
  }

  setParams(fm: FmParams): void {
    const tauChanged =
      (fm.emphasis === "off" ? null : EMPHASIS_TAU[fm.emphasis]) !==
      (this.fm.emphasis === "off" ? null : EMPHASIS_TAU[this.fm.emphasis]);
    const rdsSig = RdsBitSource.signature(fm.mpx);
    this.fm = fm;
    if (tauChanged) {
      const tau = fm.emphasis === "off" ? null : EMPHASIS_TAU[fm.emphasis];
      const empTaps = this.designEmphasis(tau);
      this.empL = new FirFilter(empTaps, this.block);
      this.empR = new FirFilter(empTaps, this.block);
    }
    if (rdsSig !== this.rdsSig) {
      this.rdsSig = rdsSig;
      this.rdsPs = fm.mpx.rdsPs;
      this.rdsBits.setConfig({
        pi: RdsBitSource.parsePi(fm.mpx.rdsPi, this.rdsBits.pi),
        pty: fm.mpx.rdsPty,
        ps: fm.mpx.rdsPs,
        rt: fm.mpx.rdsRt,
        af: fm.mpx.rdsAf,
        scroll: fm.mpx.rdsScroll,
        delayMs: fm.mpx.rdsDelayMs,
        rtPlus: fm.mpx.rdsRtPlus,
      });
    }
  }

  /**
   * Process one program-bus batch into the composite. Returns a view into an
   * internal buffer (valid until the next call). Meters accumulate per batch.
   */
  process(l: Float32Array, r: Float32Array): Float32Array {
    const fm = this.fm;
    const n = Math.min(l.length, this.block);
    const clen = n * 4;

    // 1. per-channel emphasis + 15 kHz brickwall
    this.empL.process(l.subarray(0, n), this.empOutL);
    this.empR.process(r.subarray(0, n), this.empOutR);

    // 2. stereo matrix at the input rate
    for (let i = 0; i < n; i++) {
      const m = 0.5 * (this.empOutL[i] + this.empOutR[i]);
      const s = 0.5 * (this.empOutL[i] - this.empOutR[i]);
      this.monoBuf[i] = m;
      this.sideBuf[i] = s;
      const am = Math.abs(m);
      if (am > this.maxM) this.maxM = am;
      const as = Math.abs(s);
      if (as > this.maxS) this.maxS = as;
    }

    // 3. ×4 interpolation to the composite rate
    this.upM.process(this.monoBuf.subarray(0, n), this.compBuf);
    const sideHi = this.sideHi;
    this.upS.process(this.sideBuf.subarray(0, n), sideHi);

    // 4. subcarrier synthesis + clipper (single pass, exact phase lock:
    //    38 kHz = cos 2φ, RDS carrier = sin 3φ all derive from φ)
    const gain = 0.9;
    const pilot = fm.mpx.on ? fm.mpx.pilotPct / 100 : 0;
    const rds = fm.mpx.on && fm.mpx.rdsPct > 0 ? fm.mpx.rdsPct / 100 : 0;
    const sca = fm.mpx.on && fm.mpx.scaPct > 0 ? fm.mpx.scaPct / 100 : 0;
    const ceil = Math.min(1.2, fm.mpx.ceilingPct / 100);
    const alarm = fm.mpx.alarmPct / 100;
    let phi = this.phi;
    let psi = this.psi;
    let halfPhase = this.halfPhase;
    let inSecond = this.inSecondHalf;
    let prevEnc = this.rdsPrevEnc;
    let curEnc = this.rdsCurEnc;
    const bits = this.rdsBits;
    const comp = this.compBuf;
    let maxPre = this.maxPre;
    let clip = this.clipSamples;
    let over = this.overSamples;
    // biphase symbols run at 2× the bit rate — one transition mid-bit
    const halfAdv = (2 * RDS_BIT_RATE) / this.outRate;
    // running energy sum for the BS.412 multiplex-power window
    let sq = 0;

    for (let i = 0; i < clen; i++) {
      phi += this.wPilot;
      if (phi > Math.PI * 2) phi -= Math.PI * 2;
      psi += this.wSca;
      if (psi > Math.PI * 2) psi -= Math.PI * 2;
      const s1 = Math.sin(phi);
      const cos2 = 1 - 2 * s1 * s1; // cos 2φ
      const sin3 = s1 * (3 - 4 * s1 * s1); // sin 3φ

      let rdsW = 0;
      if (rds > 0) {
        halfPhase += halfAdv;
        while (halfPhase >= 1) {
          halfPhase -= 1;
          if (!inSecond) {
            inSecond = true;
          } else {
            // next bit starts: differential encode, then biphase it
            inSecond = false;
            curEnc = bits.next() ^ prevEnc;
            prevEnc = curEnc;
          }
        }
        // biphase: +enc for the first half-bit, −enc for the second
        const sign = 1 - 2 * curEnc;
        rdsW = this.rdsShaper.process(this.rdsShaper2.process(inSecond ? -sign : sign));
      }

      const pre =
        gain * comp[i] +
        gain * sideHi[i] * cos2 +
        pilot * s1 +
        rds * rdsW * sin3 +
        sca * Math.sin(psi);
      const apre = pre < 0 ? -pre : pre;
      if (apre > maxPre) maxPre = apre;
      if (apre > alarm) over++;
      const out = apre > ceil ? (pre > 0 ? ceil : -ceil) : pre;
      comp[i] = out;
      if (apre > ceil) clip++;
      // BS.412 measures the transmitted multiplex, so accumulate the composite
      // as it leaves the clipper
      sq += out * out;
    }
    this.totalSamples += clen;
    this.accumulateMpxPower(sq, clen);

    this.phi = phi;
    this.psi = psi;
    this.halfPhase = halfPhase;
    this.inSecondHalf = inSecond;
    this.rdsPrevEnc = prevEnc;
    this.rdsCurEnc = curEnc;
    this.maxPre = maxPre;
    this.clipSamples = clip;
    this.overSamples = over;
    return comp.subarray(0, clen);
  }

  /**
   * Fold another batch of composite energy into the rolling 60 s window.
   * Completed 100 ms blocks live in `mpxBlocks` (oldest dropped first, so the
   * reading is the mean square over the *last* 60 s); the batch still in flight
   * stays in `mpxBlockSum`/`mpxBlockN` and is added once, at read time, by
   * `mpxEnergy()` — folding it in here as well would count it twice.
   */
  private accumulateMpxPower(sumSquares: number, n: number): void {
    this.mpxBlockSum += sumSquares;
    this.mpxBlockN += n;
    if (this.mpxBlockN < this.mpxBlockSamples) return;
    this.mpxBlocks.push({ sum: this.mpxBlockSum, n: this.mpxBlockN });
    this.mpxWindowSum += this.mpxBlockSum;
    this.mpxWindowN += this.mpxBlockN;
    this.mpxBlockSum = 0;
    this.mpxBlockN = 0;
    while (this.mpxBlocks.length > this.mpxMaxBlocks) {
      const dropped = this.mpxBlocks.shift();
      if (dropped) {
        this.mpxWindowSum -= dropped.sum;
        this.mpxWindowN -= dropped.n;
      }
    }
  }

  /** Window energy and sample count, including the partial block in flight. */
  private mpxEnergy(): { sum: number; n: number } {
    return {
      sum: this.mpxWindowSum + this.mpxBlockSum,
      n: this.mpxWindowN + this.mpxBlockN,
    };
  }

  /** Take the metering tick and reset the window accumulators. */
  takeStats(): MpxTickStats {
    const modPct = this.maxPre * 100;
    this.peakHold = Math.max(modPct, this.peakHold * 0.88);
    const overRatio = this.overSamples / Math.max(1, this.totalSamples);
    const now = Date.now();
    if (overRatio > 0.001) {
      if (this.overSince === 0) this.overSince = now;
    } else {
      this.overSince = 0;
    }
    const stats: MpxTickStats = {
      modPct,
      peakHoldPct: this.peakHold,
      powerDbr: mpxPowerDbr(
        this.mpxEnergy().n > 0
          ? this.mpxEnergy().sum / this.mpxEnergy().n
          : 0,
      ),
      powerWindowSeconds: this.mpxEnergy().n / this.outRate,
      clipPct: (this.clipSamples / Math.max(1, this.totalSamples)) * 100,
      sustainedOver:
        this.overSince > 0 && now - this.overSince >= OVER_SUSTAIN_MS,
      alarmPct: this.fm.mpx.alarmPct,
      ceilingPct: this.fm.mpx.ceilingPct,
      rdsGroups: this.rdsBits.groups - this.rdsGroupsAtStats,
      pilotOn: this.fm.mpx.on && this.fm.mpx.pilotPct > 0,
      rdsOn: this.fm.mpx.on && this.fm.mpx.rdsPct > 0,
      components: {
        mainPct: 90 * this.maxM,
        subPct: 90 * this.maxS,
        pilotPct: this.fm.mpx.on ? this.fm.mpx.pilotPct : 0,
        rdsPct: this.fm.mpx.on ? this.fm.mpx.rdsPct : 0,
        scaPct: this.fm.mpx.on ? this.fm.mpx.scaPct : 0,
      },
    };
    this.rdsGroupsAtStats = this.rdsBits.groups;
    this.maxPre = 0;
    this.maxM = 0;
    this.maxS = 0;
    this.clipSamples = 0;
    this.totalSamples = 0;
    this.overSamples = 0;
    return stats;
  }
}

/* ── small helpers ─────────────────────────────────────────────────────── */

/** Direct-form-II transposed biquad (Butterworth via bilinear transform). */
export class Biquad {
  private b0 = 1;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;
  private z1 = 0;
  private z2 = 0;

  static lowpass(cutoffHz: number, fs: number, q = 0.7071): Biquad {
    const bq = new Biquad();
    const w = (2 * Math.PI * cutoffHz) / fs;
    const cw = Math.cos(w);
    const sw = Math.sin(w);
    const alpha = sw / (2 * q);
    const a0 = 1 + alpha;
    bq.b0 = ((1 - cw) / 2) / a0;
    bq.b1 = (1 - cw) / a0;
    bq.b2 = bq.b0;
    bq.a1 = (-2 * cw) / a0;
    bq.a2 = (1 - alpha) / a0;
    return bq;
  }

  process(x: number): number {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
}

/* ── FFT for the MPX spectrum display ──────────────────────────────────── */

/** In-place radix-2 FFT. `re`/`im` length must be a power of two. */
export function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k];
        const ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr;
        im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

/** Hann window, cached per size. */
const hannCache = new Map<number, Float32Array>();
function hann(n: number): Float32Array {
  let w = hannCache.get(n);
  if (!w) {
    w = new Float32Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
    hannCache.set(n, w);
  }
  return w;
}

/**
 * Composite spectrum: Hann-windowed FFT of the latest composite block,
 * returned as dB per bin (bin k ≈ k·fs/N Hz, up to Nyquist = composite rate/2).
 */
export function spectrumDb(
  composite: Float32Array,
  fftSize = 4096,
): Float32Array {
  const n = Math.min(fftSize, 1 << Math.floor(Math.log2(composite.length)));
  const re = new Float32Array(n);
  const im = new Float32Array(n);
  const w = hann(n);
  const start = composite.length - n;
  for (let i = 0; i < n; i++) re[i] = composite[start + i] * w[i];
  fft(re, im);
  const bins = n / 2;
  const out = new Float32Array(bins);
  const norm = 2 / n; // Hann coherent gain ≈ 0.5, folded into the scale
  for (let k = 0; k < bins; k++) {
    const mag = Math.hypot(re[k], im[k]) * norm * 2;
    out[k] = Math.max(-110, 20 * Math.log10(mag + 1e-11));
  }
  return out;
}
