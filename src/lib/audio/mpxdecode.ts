/**
 * Composite decoder — the far end of the link, in software.
 *
 * Everything the encoder put into the multiplex comes back out here: the 19 kHz
 * pilot is recovered and used as the phase reference, the 38 kHz subcarrier is
 * mixed down and matrixed back into left and right, and the 57 kHz data
 * subcarrier is demodulated, sliced, differentially decoded and
 * block-synchronised into RDS groups.
 *
 * It is deliberately a plain receiver: it knows the frequencies the standard
 * puts the subcarriers at and nothing else about the transmitter. Every number
 * it reports — PI, PTY, the programme service name, RadioText — was read out of
 * the received waveform, so if the console shows the right station name after a
 * link test, the bytes really did survive the wire.
 *
 * All subcarriers derive from the pilot phase, exactly as the generator derives
 * them: cos 2φ at 38 kHz, sin 3φ at 57 kHz.
 *
 * Bit timing. Both ends run off the same composite sample clock, so the symbol
 * grid is exact — but the phase is not: a link splice repeats a frame, which
 * shifts every following bit by a fraction of a bit. Rather than chase that
 * with a loop, eight slicers are run at eighths of a bit and the block layer
 * decides which one is on the grid: only the right phase produces 26-bit words
 * that satisfy the RDS syndrome. A splice simply hands the job to another
 * slicer, and a bank resolution of 1/8 bit keeps the worst-case skew at 1/16.
 */
import { Biquad, RDS_BIT_RATE, RDS_OFFSET, RDS_POLY, RDS_RTPLUS_TAG_NAMES } from "./mpx";

/** A RadioText Plus tag, resolved against the RadioText that is on air. */
export interface RdsTag {
  type: number;
  /** Content-type name, e.g. "Item.Title". */
  name: string;
  text: string;
}

/** Composite rate the link carries. */
export const DECODE_RATE = 192000;
const PILOT_HZ = 19000;
/** Deviation gain the generator applies to the main and difference signals. */
const MPX_GAIN = 0.9;
/** Bit-clock phases tried in parallel, as a fraction of one bit period. */
const PHASES = 8;

export interface RdsSnapshot {
  /** Block synchronisation is held (A/B/C/D seen in order). */
  locked: boolean;
  groups: number;
  /** Data bits recovered by the winning slicer. */
  bits: number;
  blocks: number;
  /** Blocks that failed the syndrome check — dropped, never guessed at. */
  errors: number;
  /** Which of the eight bit-clock phases carries the data. */
  phase: number;
  pi: number | null;
  pty: number | null;
  ps: string;
  psComplete: boolean;
  rt: string;
  /** Heard the 3A announcement that names group 11A as the RT+ carrier. */
  rtPlus: boolean;
  /** Tags from the 11A payload, resolved against the received RadioText. */
  rtPlusTags: RdsTag[];
  /** Pilot amplitude in the composite, 0…1. Zero means no coherent reference. */
  pilot: number;
}

export interface AudioSnapshot {
  rmsL: number;
  rmsR: number;
  peakL: number;
  peakR: number;
  /** Inter-channel correlation over the same window, −1…1. */
  correlation: number;
}

export interface DecodeSnapshot {
  rds: RdsSnapshot;
  audio: AudioSnapshot;
  /** Composite samples decoded since the decoder was created. */
  samples: number;
}

/**
 * Remainder of a 26-bit block modulo the RDS generator polynomial.
 *
 * The encoder appends `crc10(data) ⊕ offset`, so an intact block leaves the
 * remainder of its offset word alone — which tells a receiver both that the
 * block is good and where it sits in the group.
 */
export function rdsSyndrome(word: number): number {
  let reg = word & 0x3ffffff;
  for (let i = 25; i >= 10; i--) {
    if (reg & (1 << i)) reg ^= RDS_POLY << (i - 10);
  }
  return reg & 0x3ff;
}

/**
 * The offset word is xor'ed into the ten check bits, so an intact block leaves
 * exactly the remainder of the offset on its own — not of an offset-shaped
 * 26-bit word.
 */
const SYNC_SYNDROME = [
  rdsSyndrome(RDS_OFFSET.A),
  rdsSyndrome(RDS_OFFSET.B),
  rdsSyndrome(RDS_OFFSET.C),
  rdsSyndrome(RDS_OFFSET.D),
];

/** One bit-clock phase: biphase integrators, differential decoder, block sync. */
interface Slicer {
  first: number;
  second: number;
  prevEnc: number;
  shift: number;
  count: number;
  /** −1 while searching for block A, otherwise the next block expected. */
  syncIdx: number;
  blocks: number;
  groups: number;
  bits: number;
  errors: number;
  groupBlocks: number[];
}

const newSlicer = (): Slicer => ({
  first: 0,
  second: 0,
  prevEnc: 0,
  shift: 0,
  count: 0,
  syncIdx: -1,
  blocks: 0,
  groups: 0,
  bits: 0,
  errors: 0,
  groupBlocks: [],
});

export interface DecoderOptions {
  sampleRate?: number;
  bitRate?: number;
}

export class CompositeDecoder {
  readonly sampleRate: number;
  private readonly wPilot: number;
  private readonly wBit: number;

  // pilot-locked reference
  private nco = 0;
  private phi0 = 0;
  private pilotI1: Biquad;
  private pilotI2: Biquad;
  private pilotQ1: Biquad;
  private pilotQ2: Biquad;

  // data subcarrier
  private rds1: Biquad;
  private rds2: Biquad;
  private bitPhase = 0;
  private slicers: Slicer[] = Array.from({ length: PHASES }, newSlicer);
  private winner = 0;

  // audio — four cascaded sections a side: two would leave the 57 kHz
  // subcarrier only 8 dB down, which shows up as crosstalk between the legs
  private main: Biquad[];
  private diff: Biquad[];

  // station state, assembled from groups
  private pi: number | null = null;
  private pty: number | null = null;
  private psChars = new Array<string>(8).fill(" ");
  private psSeen = 0;
  private rtChars = new Array<string>(64).fill(" ");
  private rtPlus = false;
  /** Raw tag positions from the last 11A group; text is resolved on read. */
  private rtTagFields: { type: number; start: number; len: number }[] = [];
  private rtItemToggle = -1;
  private abFlag = -1;

  // metering
  private samples = 0;
  private sumL2 = 0;
  private sumR2 = 0;
  private sumLR = 0;
  private meterN = 0;
  private peakL = 0;
  private peakR = 0;
  private rmsL = 0;
  private rmsR = 0;
  private correlation = 0;
  private pilotMag = 0;

  // capture (tests and offline analysis)
  private capL: Float32Array | null = null;
  private capR: Float32Array | null = null;
  private capAt = 0;

  constructor(options: DecoderOptions = {}) {
    this.sampleRate = options.sampleRate ?? DECODE_RATE;
    const fs = this.sampleRate;
    this.wPilot = (2 * Math.PI * PILOT_HZ) / fs;
    this.wBit = (options.bitRate ?? RDS_BIT_RATE) / fs;

    // Pilot: narrow enough that programme audio cannot pull the reference —
    // after mixing by 19 kHz the 15 kHz audio band starts at 4 kHz, so 500 Hz
    // still leaves three octaves of margin while keeping the loop's delay
    // short enough to stay stable.
    this.pilotI1 = Biquad.lowpass(500, fs);
    this.pilotI2 = Biquad.lowpass(500, fs);
    this.pilotQ1 = Biquad.lowpass(500, fs);
    this.pilotQ2 = Biquad.lowpass(500, fs);

    // Data: 2.4 kHz, the subcarrier's own bandwidth.
    this.rds1 = Biquad.lowpass(2400, fs);
    this.rds2 = Biquad.lowpass(2400, fs);

    // Audio: 15 kHz brickwall either side of the stereo matrix.
    this.main = Array.from({ length: 4 }, () => Biquad.lowpass(15000, fs));
    this.diff = Array.from({ length: 4 }, () => Biquad.lowpass(15000, fs));
  }

  /** Decode a run of composite samples (mono, ±1 full scale). */
  process(composite: Float32Array): void {
    const wPilot = this.wPilot;
    const wBit = this.wBit;
    const slicers = this.slicers;
    let nco = this.nco;
    let phi0 = this.phi0;
    let bitPhase = this.bitPhase;
    let sumL2 = this.sumL2;
    let sumR2 = this.sumR2;
    let sumLR = this.sumLR;
    let meterN = this.meterN;
    let peakL = this.peakL;
    let peakR = this.peakR;
    let pilotMag = this.pilotMag;

    const capL = this.capL;
    const capR = this.capR;
    let capAt = this.capAt;

    for (let i = 0; i < composite.length; i++) {
      const x = composite[i];

      // ── pilot: measure its phase against a free-running 19 kHz NCO ──
      nco += wPilot;
      if (nco > Math.PI * 2) nco -= Math.PI * 2;
      const a = nco + phi0;
      const sA = Math.sin(a);
      const cA = Math.cos(a);

      // Mixing the pilot down to DC leaves a phasor whose angle is the error:
      // I = P·sin δ, Q = P·cos δ, so δ = atan2(I, Q).
      const piI = this.pilotI2.process(this.pilotI1.process(x * cA));
      const piQ = this.pilotQ2.process(this.pilotQ1.process(x * sA));
      if ((i & 15) === 0) {
        // One small step per 16 samples: the filter's group delay sits between
        // the measurement and the correction, so a deadbeat gain would ring.
        phi0 += 0.08 * Math.atan2(piI, piQ);
        if (phi0 > Math.PI) phi0 -= Math.PI * 2;
        if (phi0 < -Math.PI) phi0 += Math.PI * 2;
        this.phi0 = phi0;
      }
      pilotMag = 2 * Math.sqrt(piI * piI + piQ * piQ);

      const sin3 = sA * (3 - 4 * sA * sA); // sin 3φ (the data carrier)
      const cos2 = 1 - 2 * sA * sA; // cos 2φ (the stereo subcarrier)

      // The pilot is reconstructed exactly from the locked phasor and taken
      // out before the audio filters: 19 kHz is far too close to 15 kHz to
      // remove with a practical lowpass, and a pilot leaking into the
      // difference channel shows up as crosstalk between the two legs.
      const xa = x - 2 * (piI * cA + piQ * sA);

      // ── data subcarrier: mix to baseband, limit, slice ──
      const d = this.rds2.process(this.rds1.process(xa * sin3));

      // ── eight bit-clock phases, all on the same free-running grid ──
      const before = bitPhase;
      bitPhase += wBit;
      if (bitPhase >= 1) {
        bitPhase -= 1;
        this.emit(0);
      }
      for (let k = 1; k < PHASES; k++) {
        const cross = 1 - k / PHASES;
        if (before < cross && bitPhase >= cross) this.emit(k);
      }

      // biphase: the two halves of a bit carry opposite polarity
      for (let k = 0; k < PHASES; k++) {
        let phase = bitPhase + k / PHASES;
        if (phase >= 1) phase -= 1;
        if (phase < 0.5) slicers[k].first += d;
        else slicers[k].second += d;
      }

      // ── audio: main channel and 38 kHz difference, matrixed back ──
      let main = xa;
      for (let f = 0; f < 4; f++) main = this.main[f].process(main);
      let diff = xa * cos2;
      for (let f = 0; f < 4; f++) diff = this.diff[f].process(diff);
      diff *= 2;
      const l = (main + diff) / MPX_GAIN;
      const r = (main - diff) / MPX_GAIN;

      sumL2 += l * l;
      sumR2 += r * r;
      sumLR += l * r;
      meterN += 1;
      const al = l < 0 ? -l : l;
      const ar = r < 0 ? -r : r;
      if (al > peakL) peakL = al;
      if (ar > peakR) peakR = ar;

      if (capL && capAt < capL.length) {
        capL[capAt] = l;
        capR![capAt] = r;
        capAt += 1;
      }
    }

    this.nco = nco;
    this.phi0 = phi0;
    this.bitPhase = bitPhase;
    this.sumL2 = sumL2;
    this.sumR2 = sumR2;
    this.sumLR = sumLR;
    this.meterN = meterN;
    this.peakL = peakL;
    this.peakR = peakR;
    this.pilotMag = pilotMag;
    this.capAt = capAt;
    this.samples += composite.length;

    if (meterN >= this.sampleRate) this.closeMeter();
  }

  /** Close one bit of a slicer: biphase decision, then differential decode. */
  private emit(k: number): void {
    const s = this.slicers[k];
    const sym = s.first - s.second;
    s.first = 0;
    s.second = 0;
    const enc = sym > 0 ? 0 : 1;
    const bit = enc ^ s.prevEnc;
    s.prevEnc = enc;

    s.bits += 1;
    s.shift = ((s.shift << 1) | bit) & 0x3ffffff;
    s.count += 1;

    // Searching: slide one bit at a time until a block A appears. Locked:
    // blocks are 26 bits and only the boundary carries a syndrome — checking
    // every bit would reject the aligned windows in between.
    if (s.syncIdx < 0) {
      if (s.count < 26) return;
      if (rdsSyndrome(s.shift) === SYNC_SYNDROME[0]) {
        s.syncIdx = 1;
        s.groupBlocks = [(s.shift >>> 10) & 0xffff];
        s.blocks += 1;
        s.count = 0;
        this.winner = k;
      }
      return;
    }
    if (s.count < 26) return;
    s.count = 0;

    const syndrome = rdsSyndrome(s.shift);
    const data = (s.shift >>> 10) & 0xffff;

    if (syndrome === SYNC_SYNDROME[s.syncIdx]) {
      s.groupBlocks.push(data);
      s.blocks += 1;
      s.syncIdx = (s.syncIdx + 1) & 3;
      if (s.syncIdx === 0) {
        s.groups += 1;
        this.winner = k;
        this.parseGroup(s.groupBlocks);
        s.groupBlocks = [];
      }
      return;
    }
    // Broken block: drop the partial group rather than guess at it.
    s.errors += 1;
    if (syndrome === SYNC_SYNDROME[0]) {
      s.syncIdx = 1;
      s.groupBlocks = [data];
    } else {
      s.syncIdx = -1;
      s.groupBlocks = [];
    }
  }

  private parseGroup(blocks: number[]): void {
    if (blocks.length < 4) return;
    const [a, b, c, d] = blocks;
    this.pi = a;
    const type = (b >> 12) & 0xf;
    const versionB = (b >> 11) & 1;
    this.pty = (b >> 5) & 0x1f;

    if (type === 0 && versionB === 0) {
      // 0A: block C carries the alternative-frequency list, block D the two
      // characters of this segment of the programme service name.
      const seg = b & 3;
      this.psChars[seg * 2] = String.fromCharCode((d >> 8) & 0xff || 0x20);
      this.psChars[seg * 2 + 1] = String.fromCharCode((d & 0xff) || 0x20);
      this.psSeen |= 1 << seg;
      return;
    }
    if (type === 2 && versionB === 0) {
      const seg = b & 0xf;
      const ab = (b >> 4) & 1;
      if (this.abFlag !== ab) {
        // A: the station started a new message, so old characters are not
        // ours. The first sighting is not a change — a receiver tuning in
        // mid-message keeps whatever it has.
        if (this.abFlag !== -1) this.rtChars = new Array<string>(64).fill(" ");
        this.abFlag = ab;
      }
      const chars = [c >> 8, c & 0xff, d >> 8, d & 0xff];
      for (let k = 0; k < 4; k++) {
        const ch = chars[k] & 0xff;
        this.rtChars[seg * 4 + k] = String.fromCharCode(ch === 0 ? 0x20 : ch);
      }
      return;
    }
    if (type === 3 && versionB === 0) {
      // ODA announcement: block C names the application
      if (c === 0x4bd7) this.rtPlus = true;
      return;
    }
    if (type === 11 && versionB === 0) {
      // RadioText Plus: two tags, each a content type, a start offset in
      // RadioText and a length that is transmitted minus one.
      const toggle = (b >> 4) & 1;
      if (toggle !== this.rtItemToggle) {
        this.rtItemToggle = toggle;
        this.rtTagFields = [];
      }
      const type1 = ((b & 0b111) << 3) | ((c >> 13) & 0b111);
      const start1 = (c >> 7) & 0x3f;
      const len1 = ((c >> 1) & 0x3f) + 1;
      const type2 = ((c & 1) << 5) | ((d >> 11) & 0x1f);
      const start2 = (d >> 5) & 0x3f;
      const len2 = (d & 0x1f) + 1;
      const fields: { type: number; start: number; len: number }[] = [];
      if (type1 !== 0) fields.push({ type: type1, start: start1, len: len1 });
      if (type2 !== 0) fields.push({ type: type2, start: start2, len: len2 });
      this.rtTagFields = fields;
    }
  }

  private closeMeter(): void {
    const n = Math.max(1, this.meterN);
    this.rmsL = Math.sqrt(this.sumL2 / n);
    this.rmsR = Math.sqrt(this.sumR2 / n);
    const denom = Math.sqrt(this.sumL2 * this.sumR2);
    this.correlation = denom > 1e-12 ? this.sumLR / denom : 0;
    this.peakL = 0;
    this.peakR = 0;
    this.sumL2 = 0;
    this.sumR2 = 0;
    this.sumLR = 0;
    this.meterN = 0;
  }

  snapshot(): DecodeSnapshot {
    if (this.meterN >= this.sampleRate / 4) this.closeMeter();
    let best = this.slicers[this.winner];
    for (const s of this.slicers) if (s.groups > best.groups) best = s;
    const rtFull = this.rtChars.join("").split("\r")[0];
    const rt = rtFull.replace(/\s+$/, "");
    const rtPlusTags: RdsTag[] = this.rtTagFields
      .filter((f) => f.start + f.len <= rtFull.length)
      .map((f) => ({
        type: f.type,
        name: RDS_RTPLUS_TAG_NAMES[f.type] ?? `type ${f.type}`,
        text: rtFull.slice(f.start, f.start + f.len).trim(),
      }));
    return {
      rds: {
        locked: best.syncIdx >= 0,
        groups: best.groups,
        bits: best.bits,
        blocks: best.blocks,
        errors: best.errors,
        phase: this.slicers.indexOf(best),
        pi: this.pi,
        pty: this.pty,
        ps: this.psChars.join(""),
        psComplete: this.psSeen === 0b1111,
        rt,
        rtPlus: this.rtPlus,
        rtPlusTags,
        pilot: this.pilotMag,
      },
      audio: {
        rmsL: this.rmsL,
        rmsR: this.rmsR,
        peakL: this.peakL,
        peakR: this.peakR,
        correlation: this.correlation,
      },
      samples: this.samples,
    };
  }

  /** Record decoded audio, for measurement rather than listening. */
  startCapture(maxSamples: number): void {
    this.capL = new Float32Array(maxSamples);
    this.capR = new Float32Array(maxSamples);
    this.capAt = 0;
  }

  takeCapture(): { left: Float32Array; right: Float32Array; rate: number } | null {
    if (!this.capL || !this.capR) return null;
    const out = {
      left: this.capL.subarray(0, this.capAt),
      right: this.capR.subarray(0, this.capAt),
      rate: this.sampleRate,
    };
    this.capL = null;
    this.capR = null;
    this.capAt = 0;
    return out;
  }
}

/** One-shot decode of a finished composite — the whole chain in one call. */
export function decodeComposite(
  composite: Float32Array,
  options: DecoderOptions & { capture?: number } = {},
): { snapshot: DecodeSnapshot; audio: { left: Float32Array; right: Float32Array; rate: number } | null } {
  const decoder = new CompositeDecoder(options);
  if (options.capture) decoder.startCapture(options.capture);
  decoder.process(composite);
  return { snapshot: decoder.snapshot(), audio: decoder.takeCapture() };
}
