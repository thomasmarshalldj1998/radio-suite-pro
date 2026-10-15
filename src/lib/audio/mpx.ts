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
  const nyq = fs / 2;
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

/** Upsampling interpolator prototype: ×L zero-stuff image killer. */
function designInterpLpf(taps: number, cutoffHz: number, fs: number): Float64Array {
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
  for (let i = 0; i < taps; i++) out[i] /= sum;
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
  private readonly scratch: Float64Array;
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
 * Bit source producing spec-correct 0A groups: PI in block A, group type 0A
 * + segment address in block B, no-AF filler in block C, PS character pair
 * in block D — cycling the four PS segments so a receiver assembles the
 * 8-character name. MSB first, per standard.
 */
export class RdsBitSource {
  private bits: number[] = [];
  private idx = 0;
  private seg = 0;
  readonly pi: number;
  readonly pty: number;
  private ps: string;

  constructor(pi: number, ps: string, pty = 10, tp = 0) {
    this.pi = pi & 0xffff;
    this.pty = pty & 0x1f;
    this.ps = (ps + "        ").slice(0, 8);
  }

  setPs(ps: string) {
    this.ps = (ps + "        ").slice(0, 8);
    this.idx = this.bits.length; // rebuild the next group with the new name
  }

  private buildGroup(): void {
    const seg = this.seg;
    // B: group type 0A, B0=0, TP, PTY, TA=0, MS=1 (music), DI (stereo bit
    // rotates with the segment per the DI spread), C1C0 = segment address
    const di = (0b1000 >> seg) & 1;
    const blockB =
      (0 << 12) | (0 << 11) | (0 << 10) | (this.pty << 5) | (0 << 4) |
      (1 << 3) | (di << 2) | seg;
    const cA = this.char(2 * seg);
    const cB = this.char(2 * seg + 1);
    const blockD = (cA << 8) | cB;
    const blocks: [number, number][] = [
      [this.pi, RDS_OFFSET.A],
      [blockB, RDS_OFFSET.B],
      [0xdce8, RDS_OFFSET.C], // no-AF filler
      [blockD, RDS_OFFSET.D],
    ];
    this.bits = [];
    for (const [data, offset] of blocks) {
      const word = rdsBlock(data, offset);
      for (let b = 25; b >= 0; b--) this.bits.push((word >> b) & 1);
    }
    this.idx = 0;
    this.seg = (seg + 1) & 3;
  }

  private char(i: number): number {
    const c = this.ps.charCodeAt(i);
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

  private readonly block: number;

  constructor(inRate: number, fm: FmParams, blockSize = 4096) {
    this.inRate = inRate;
    this.outRate = inRate * 4;
    this.fm = fm;
    this.block = blockSize;
    const tau = fm.emphasis === "off" ? null : EMPHASIS_TAU[fm.emphasis];
    const empTaps = this.designEmphasis(tau);

    // both channels share one tap set (FIR never mutates its taps)
    this.empL = new FirFilter(empTaps, blockSize);
    this.empR = new FirFilter(empTaps, blockSize);
    // interpolation: flat across the 15 kHz audio band (passband ≈18.6 kHz),
    // ≥85 dB down from ≈29 kHz up — kills every image of the brickwalled
    // programme (first image at 48k−15k = 33 kHz)
    const proto = designInterpLpf(96, 24000, this.outRate);
    this.upM = new PolyphaseUpsampler(proto);
    this.upS = new PolyphaseUpsampler(proto);
    this.monoBuf = new Float32Array(blockSize);
    this.sideBuf = new Float32Array(blockSize);
    this.empOutL = new Float32Array(blockSize);
    this.empOutR = new Float32Array(blockSize);
    this.sideHi = new Float32Array(blockSize * 4);
    this.compBuf = new Float32Array(blockSize * 4);

    this.rdsPs = fm.mpx.rdsPs;
    this.rdsBits = new RdsBitSource(0x1234, fm.mpx.rdsPs);
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
    const psChanged = fm.mpx.rdsPs !== this.rdsPs;
    this.fm = fm;
    if (tauChanged) {
      const tau = fm.emphasis === "off" ? null : EMPHASIS_TAU[fm.emphasis];
      const empTaps = this.designEmphasis(tau);
      this.empL = new FirFilter(empTaps, this.block);
      this.empR = new FirFilter(empTaps, this.block);
    }
    if (psChanged) {
      this.rdsPs = fm.mpx.rdsPs;
      this.rdsBits.setPs(fm.mpx.rdsPs);
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
      comp[i] = apre > ceil ? (pre > 0 ? ceil : -ceil) : pre;
      if (apre > ceil) clip++;
    }
    this.totalSamples += clen;

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
      clipPct: (this.clipSamples / Math.max(1, this.totalSamples)) * 100,
      sustainedOver:
        this.overSince > 0 && now - this.overSince >= OVER_SUSTAIN_MS,
      alarmPct: this.fm.mpx.alarmPct,
      ceilingPct: this.fm.mpx.ceilingPct,
      components: {
        mainPct: 90 * this.maxM,
        subPct: 90 * this.maxS,
        pilotPct: this.fm.mpx.on ? this.fm.mpx.pilotPct : 0,
        rdsPct: this.fm.mpx.on ? this.fm.mpx.rdsPct : 0,
        scaPct: this.fm.mpx.on ? this.fm.mpx.scaPct : 0,
      },
    };
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
