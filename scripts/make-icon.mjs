/**
 * Rasterize the Signalpath brand mark to build/icon.png (512×512) with zero
 * dependencies — pure Node: 4× supersampled rendering, box-filtered down,
 * RGBA PNG via zlib.
 *
 * Geometry and colour stops mirror public/logo.svg exactly: deep navy
 * rounded square, cyan top glow, five capsule meter bars (centre bar in the
 * cyan signal gradient), hairline rim and a white specular line. Pixels
 * outside the rounded square are transparent, so macOS/Windows masks and
 * Linux launchers composite the mark cleanly.
 *
 *   node scripts/make-icon.mjs
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const SIZE = 512;
const SS = 4; // supersampling factor
const N = SIZE * SS;

/** Background gradient sampled from logo.svg: #1B2231 → #111621 → #080B11. */
const BG_STOPS = [
  [0, [0x1b, 0x22, 0x31]],
  [0.55, [0x11, 0x16, 0x21]],
  [1, [0x08, 0x0b, 0x11]],
];

/** Centre bar gradient: #9BF8FF → #00E0FF → #0087A8. */
const CORE_STOPS = [
  [0, [0x9b, 0xf8, 0xff]],
  [0.42, [0x00, 0xe0, 0xff]],
  [1, [0x00, 0x87, 0xa8]],
];

/** Capsule meter bars, in logo.svg coordinates. */
const BARS = [
  { x: 123, y: 217, w: 34, h: 78, color: [0xea, 0xf2, 0xff], alpha: 0.42 },
  { x: 181, y: 167, w: 34, h: 178, color: [0xf4, 0xf8, 0xff], alpha: 0.78 },
  { x: 239, y: 97, w: 34, h: 318, gradient: CORE_STOPS, alpha: 1 },
  { x: 297, y: 167, w: 34, h: 178, color: [0xf4, 0xf8, 0xff], alpha: 0.78 },
  { x: 355, y: 217, w: 34, h: 78, color: [0xea, 0xf2, 0xff], alpha: 0.42 },
];

/** The logo's specular highlight line. */
const SPECULAR = { x: 243, y: 108, w: 3, h: 296, alpha: 0.28 };

function mix(a, b, t) {
  return a + (b - a) * t;
}

/** Piecewise-linear multi-stop gradient. */
function gradient(stops, t) {
  const v = Math.min(1, Math.max(0, t));
  for (let i = 1; i < stops.length; i++) {
    const [p1, c1] = stops[i];
    if (v <= p1) {
      const [p0, c0] = stops[i - 1];
      const k = p1 === p0 ? 0 : (v - p0) / (p1 - p0);
      return [mix(c0[0], c1[0], k), mix(c0[1], c1[1], k), mix(c0[2], c1[2], k)];
    }
  }
  return stops[stops.length - 1][1];
}

/** Point inside a rounded rectangle of half-width hw / half-height hh. */
function inRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return ax * ax + ay * ay <= r * r;
}

// Accumulate straight-alpha colour at supersampled resolution, plus coverage.
const px = new Float64Array(N * N * 3);
const cover = new Uint8Array(N * N);

for (let y = 0; y < N; y++) {
  const sy = (y + 0.5) / SS;
  const bg = gradient(BG_STOPS, sy / SIZE);

  for (let x = 0; x < N; x++) {
    const sx = (x + 0.5) / SS;

    // Outside the rounded square → fully transparent (no colour).
    if (!inRoundRect(sx, sy, 256, 256, 256, 256, 112)) continue;

    let r = bg[0];
    let g = bg[1];
    let b = bg[2];

    // Radial cyan glow: ellipse centred at (256, 132), fading to nothing.
    const gx = (sx - 256) / 220;
    const gy = (sy - 132) / 310;
    const gd = Math.sqrt(gx * gx + gy * gy);
    if (gd < 1) {
      const a = 0.22 * (1 - gd);
      r += (0x00 - r) * a;
      g += (0xe0 - g) * a;
      b += (0xff - b) * a;
    }

    // 1px hairline rim, white fading top → bottom.
    if (!inRoundRect(sx, sy, 256, 256, 255, 255, 111)) {
      const a = mix(0.16, 0.02, sy / SIZE);
      r += (255 - r) * a;
      g += (255 - g) * a;
      b += (255 - b) * a;
    }

    // Capsule meter bars (centre bar uses the cyan signal gradient).
    for (const bar of BARS) {
      const bh = bar.h;
      if (sy < bar.y - 1 || sy > bar.y + bh + 1) continue;
      if (!inRoundRect(sx, sy, bar.x + bar.w / 2, bar.y + bh / 2, bar.w / 2, bh / 2, bar.w / 2)) continue;
      const c = bar.gradient ? gradient(bar.gradient, (sy - bar.y) / bh) : bar.color;
      r += (c[0] - r) * bar.alpha;
      g += (c[1] - g) * bar.alpha;
      b += (c[2] - b) * bar.alpha;
    }

    // Specular highlight line down the centre bar.
    if (
      inRoundRect(
        sx,
        sy,
        SPECULAR.x + SPECULAR.w / 2,
        SPECULAR.y + SPECULAR.h / 2,
        SPECULAR.w / 2,
        SPECULAR.h / 2,
        SPECULAR.w / 2,
      )
    ) {
      r += (255 - r) * SPECULAR.alpha;
      g += (255 - g) * SPECULAR.alpha;
      b += (255 - b) * SPECULAR.alpha;
    }

    const i = y * N + x;
    px[i * 3] = r;
    px[i * 3 + 1] = g;
    px[i * 3 + 2] = b;
    cover[i] = 1;
  }
}

// Box-filter down to SIZE×SIZE and build the RGBA scanlines (filter 0).
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  const rowStart = y * (SIZE * 4 + 1);
  raw[rowStart] = 0; // None filter
  for (let x = 0; x < SIZE; x++) {
    let r = 0;
    let g = 0;
    let b = 0;
    let hits = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const i = (y * SS + sy) * N + x * SS + sx;
        if (!cover[i]) continue;
        r += px[i * 3];
        g += px[i * 3 + 1];
        b += px[i * 3 + 2];
        hits++;
      }
    }
    const o = rowStart + 1 + x * 4;
    if (hits > 0) {
      raw[o] = Math.round(r / hits);
      raw[o + 1] = Math.round(g / hits);
      raw[o + 2] = Math.round(b / hits);
      raw[o + 3] = Math.round((hits / (SS * SS)) * 255);
    }
  }
}

// ── minimal PNG encoder (RGBA8) ──
const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

const outDir = path.join(process.cwd(), "build");
mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, "icon.png");
writeFileSync(outFile, png);
console.log(`wrote ${outFile} (${SIZE}×${SIZE}, ${png.length} bytes)`);
