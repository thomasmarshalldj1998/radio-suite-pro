/**
 * Rasterize the Signalpath logo to build/icon.png (512×512) with zero
 * dependencies — pure Node: signed-distance-field drawing at 4× scale,
 * box-filtered down, encoded as RGBA PNG via zlib.
 *
 * Geometry mirrors public/logo.svg: dark rounded square, five capsule
 * meter bars, the centre bar in signal orange.
 *
 *   node scripts/make-icon.mjs
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const SIZE = 512;
const SS = 4; // supersampling factor
const N = SIZE * SS;

/** Background rounded-square. */
const BG = { r: 0x17, g: 0x1b, b: 0x28 };
const BG_RADIUS = 104;

/** Capsule meter bars: [x, y, w, h, r, fill, alpha] in SVG coordinates. */
const BARS = [
  [123, 216, 34, 80, 17, [255, 255, 255], 0.5],
  [181, 166, 34, 180, 17, [255, 255, 255], 0.85],
  [239, 96, 34, 320, 17, [0xef, 0x5b, 0x2b], 1.0],
  [297, 166, 34, 180, 17, [255, 255, 255], 0.85],
  [355, 216, 34, 80, 17, [255, 255, 255], 0.5],
];

/** Signed distance to a rounded rectangle centred at (cx, cy). */
function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const dx = Math.abs(px - cx) - (hw - r);
  const dy = Math.abs(py - cy) - (hh - r);
  const ax = Math.max(dx, 0);
  const ay = Math.max(dy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(dx, dy), 0) - r;
}

// Accumulate coverage at supersampled resolution.
const px = new Float64Array(N * N * 3);

for (let y = 0; y < N; y++) {
  const sy = (y + 0.5) / SS;
  for (let x = 0; x < N; x++) {
    const sx = (x + 0.5) / SS;
    // 16× coverage of the background rounded square (0 or 1 per sample)
    const bgDist = sdRoundRect(
      sx,
      sy,
      256,
      256,
      256,
      256,
      BG_RADIUS,
    );
    if (bgDist > 0) continue; // transparent outside the icon shape
    let r = BG.r;
    let g = BG.g;
    let b = BG.b;
    for (const [bx, by, bw, bh, br, [fr, fg, fb], alpha] of BARS) {
      const dist = sdRoundRect(
        sx,
        sy,
        bx + bw / 2,
        by + bh / 2,
        bw / 2,
        bh / 2,
        br,
      );
      if (dist <= 0) {
        r = r + (fr - r) * alpha;
        g = g + (fg - g) * alpha;
        b = b + (fb - b) * alpha;
      }
    }
    const i = (y * N + x) * 3;
    px[i] = r;
    px[i + 1] = g;
    px[i + 2] = b;
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
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const i = ((y * SS + sy) * N + x * SS + sx) * 3;
        r += px[i];
        g += px[i + 1];
        b += px[i + 2];
      }
    }
    const n = SS * SS;
    const o = rowStart + 1 + x * 4;
    raw[o] = Math.round(r / n);
    raw[o + 1] = Math.round(g / n);
    raw[o + 2] = Math.round(b / n);
    raw[o + 3] = 255;
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
