/**
 * Retro installer art for the Windows NSIS installer — zero dependencies.
 *
 * NSIS shows two bitmaps while it installs:
 *   build/installer-sidebar.bmp  164×314  left rail of every page
 *   build/installer-header.bmp   150×57   top-right of every page
 * (also reused for the uninstaller). Style: 70s broadcast hardware —
 * charcoal steel, amber VU bars, a red ON AIR lamp, scanlines, 5×7 LED text.
 *
 *   node scripts/make-installer-art.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/* ── 5×7 LED font (rows as 5-bit values) ─────────────────────────────── */
const FONT = {
  A: [0x0e, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  B: [0x1e, 0x11, 0x11, 0x1e, 0x11, 0x11, 0x1e],
  C: [0x0e, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0e],
  D: [0x1e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1e],
  E: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x1f],
  G: [0x0e, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0f],
  H: [0x11, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  I: [0x0e, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0e],
  L: [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1f],
  N: [0x11, 0x19, 0x19, 0x15, 0x13, 0x13, 0x11],
  O: [0x0e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  P: [0x1e, 0x11, 0x11, 0x1e, 0x10, 0x10, 0x10],
  R: [0x1e, 0x11, 0x11, 0x1e, 0x14, 0x12, 0x11],
  S: [0x0f, 0x10, 0x10, 0x0e, 0x01, 0x01, 0x1e],
  T: [0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  U: [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  V: [0x11, 0x11, 0x11, 0x11, 0x11, 0x0a, 0x04],
  0: [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e],
  2: [0x0e, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1f],
  6: [0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e],
  ".": [0x00, 0x00, 0x00, 0x00, 0x00, 0x0c, 0x0c],
  "-": [0x00, 0x00, 0x00, 0x1f, 0x00, 0x00, 0x00],
  " ": [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
};

/* ── tiny canvas ──────────────────────────────────────────────────────── */
function canvas(w, h) {
  const px = new Float64Array(w * h * 3);
  const set = (x, y, r, g, b) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const i = (y * w + x) * 3;
    px[i] = r;
    px[i + 1] = g;
    px[i + 2] = b;
  };
  const fill = (x0, y0, w0, h0, [r, g, b]) => {
    for (let y = Math.max(0, y0); y < Math.min(h, y0 + h0); y++)
      for (let x = Math.max(0, x0); x < Math.min(w, x0 + w0); x++) set(x, y, r, g, b);
  };
  const vgrad = (top, bot) => {
    for (let y = 0; y < h; y++) {
      const t = y / (h - 1);
      for (let x = 0; x < w; x++)
        set(x, y, top[0] + (bot[0] - top[0]) * t, top[1] + (bot[1] - top[1]) * t, top[2] + (bot[2] - top[2]) * t);
    }
  };
  const text = (str, x0, y0, scale, [r, g, b]) => {
    let cx = x0;
    for (const ch of str.toUpperCase()) {
      const glyph = FONT[ch] ?? FONT[" "];
      for (let r = 0; r < 7; r++)
        for (let c = 0; c < 5; c++)
          if (glyph[r] & (1 << (4 - c))) fill(cx + c * scale, y0 + r * scale, scale, scale, [r, g, b]);
      cx += 6 * scale;
    }
    return cx - x0 - scale; // drawn width
  };
  const scanlines = () => {
    for (let y = 0; y < h; y += 3)
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 3;
        px[i] *= 0.82;
        px[i + 1] *= 0.82;
        px[i + 2] *= 0.82;
      }
  };
  return { w, h, px, set, fill, vgrad, text, scanlines };
}

/** Five capsule meter bars echoing the logo; heights in px. */
function bars(cv, x0, yBase, gap, widths, heights, colors) {
  let x = x0;
  for (let i = 0; i < heights.length; i++) {
    const bw = widths;
    const bh = heights[i];
    const [r, g, b] = colors[i];
    // capsule approx: rect + round caps
    cv.fill(x, yBase - bh, bw, bh, [r, g, b]);
    for (let dx = 0; dx < bw; dx++) {
      for (let dy = 0; dy < 3; dy++) {
        cv.set(x + dx, yBase - bh + dy, r, g, b);
        cv.set(x + dx, yBase - 1 - dy, r, g, b);
      }
    }
    x += bw + gap;
  }
  return x - x0 - gap;
}

const WHITE = [232, 234, 239];
const DIM = [120, 126, 134];
const ORANGE = [239, 91, 43];
const AMBER = [255, 204, 0];
const RED = [255, 59, 48];
const DARKRED = [140, 28, 24];

/* ── sidebar 164×314 ─────────────────────────────────────────────────── */
function sidebar() {
  const cv = canvas(164, 314);
  cv.vgrad([24, 27, 33], [11, 13, 16]);
  // top hairline light
  cv.fill(0, 0, 164, 2, [58, 64, 74]);
  // VU bars
  bars(cv, 27, 118, 8, 14, [34, 62, 84, 62, 34], [WHITE, WHITE, ORANGE, WHITE, WHITE]);
  // brand
  cv.text("SIGNALPATH", 17, 140, 2, WHITE);
  cv.text("BROADCAST AUDIO", 32, 162, 1, DIM);
  // ON AIR lamp (label width = 6 chars × 6px × 2 − 2 = 70)
  cv.fill(22, 190, 120, 44, DARKRED);
  cv.fill(24, 192, 116, 40, RED);
  cv.text("ON AIR", 24 + (116 - 70) / 2, 203, 2, [255, 255, 255]);
  // VU scale ticks under lamp
  for (let i = 0; i <= 10; i++) {
    const x = 30 + i * 10;
    cv.fill(x, 244, 2, i % 5 === 0 ? 10 : 6, i >= 8 ? RED : i >= 6 ? AMBER : [76, 217, 100]);
  }
  // bottom baseline
  cv.fill(0, 306, 164, 2, [255, 204, 0]);
  cv.text("V2.0", 70, 286, 1, DIM);
  cv.scanlines();
  return cv;
}

/* ── header 150×57 ───────────────────────────────────────────────────── */
function header() {
  const cv = canvas(150, 57);
  cv.vgrad([24, 27, 33], [14, 16, 20]);
  bars(cv, 12, 44, 5, 9, [20, 34, 44, 34, 20], [DIM, DIM, ORANGE, DIM, DIM]);
  cv.text("SIGNALPATH", 78, 16, 1, WHITE);
  cv.text("ON AIR", 78, 30, 1, RED);
  cv.scanlines();
  return cv;
}

/* ── 24-bit BMP writer ───────────────────────────────────────────────── */
function toBmp(cv) {
  const { w, h, px } = cv;
  const row = Math.ceil((w * 3) / 4) * 4;
  const out = Buffer.alloc(54 + row * h);
  out.write("BM", 0);
  out.writeUInt32LE(out.length, 2);
  out.writeUInt32LE(54, 10);
  out.writeUInt32LE(40, 14);
  out.writeInt32LE(w, 18);
  out.writeInt32LE(h, 22);
  out.writeUInt16LE(1, 26);
  out.writeUInt16LE(24, 28);
  for (let y = 0; y < h; y++) {
    const dst = 54 + (h - 1 - y) * row;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      out[dst + x * 3] = Math.max(0, Math.min(255, Math.round(px[i + 2])));
      out[dst + x * 3 + 1] = Math.max(0, Math.min(255, Math.round(px[i + 1])));
      out[dst + x * 3 + 2] = Math.max(0, Math.min(255, Math.round(px[i])));
    }
  }
  return out;
}

const outDir = path.join(process.cwd(), "build");
mkdirSync(outDir, { recursive: true });
for (const [name, cv] of [
  ["installer-sidebar.bmp", sidebar()],
  ["installer-header.bmp", header()],
]) {
  const bmp = toBmp(cv);
  const f = path.join(outDir, name);
  writeFileSync(f, bmp);
  console.log(`wrote ${f} (${cv.w}×${cv.h}, ${bmp.length} bytes)`);
}
