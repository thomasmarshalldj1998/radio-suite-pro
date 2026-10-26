/**
 * Branded installer art for the Windows NSIS installer — zero dependencies.
 *
 * NSIS shows two bitmaps while it installs:
 *   build/installer-sidebar.bmp  164×314  left rail of every page
 *   build/installer-header.bmp   150×57   top-right of every page
 * (also reused for the uninstaller). Both are drawn from the current
 * Signalpath brand: the navy rounded-square mark with its five capsule
 * meter bars and cyan signal centre, quiet slate neutrals, and a hairline
 * cyan accent. The version label is read from package.json.
 *
 *   node scripts/make-installer-art.mjs
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const pkg = JSON.parse(
  readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
);
const version = typeof pkg.version === "string" ? pkg.version : "3.0.0";
/** "3.0.0" → "V3.0" — the badge shown at the foot of the installer rail. */
const versionLabel = `V${version.split(".").slice(0, 2).join(".")}`;

/* ── brand palette (mirrors public/logo.svg) ─────────────────────────── */
const BG_STOPS = [
  [0, [0x1b, 0x22, 0x31]],
  [0.55, [0x11, 0x16, 0x21]],
  [1, [0x08, 0x0b, 0x11]],
];
const CORE_STOPS = [
  [0, [0x9b, 0xf8, 0xff]],
  [0.42, [0x00, 0xe0, 0xff]],
  [1, [0x00, 0x87, 0xa8]],
];
const WHITE = [0xea, 0xf2, 0xff];
const MUTED = [0x9e, 0xb0, 0xd0];
const DIM = [0x5a, 0x6b, 0x8c];
const CYAN = [0x00, 0xe0, 0xff];
const CYAN_DIM = [0x00, 0xb8, 0xd4];
const AMBER = [0xff, 0xcc, 0x22];
const RED = [0xff, 0x33, 0x55];
const GREEN = [0x00, 0xee, 0x77];
const PANEL = [0x0a, 0x0f, 0x17];

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
  1: [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
  2: [0x0e, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1f],
  3: [0x1f, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0e],
  4: [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02],
  5: [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
  6: [0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e],
  7: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  8: [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e],
  9: [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c],
  ".": [0x00, 0x00, 0x00, 0x00, 0x00, 0x0c, 0x0c],
  "-": [0x00, 0x00, 0x00, 0x1f, 0x00, 0x00, 0x00],
  " ": [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
};

const mix = (a, b, t) => a + (b - a) * t;

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

/* ── tiny float canvas ────────────────────────────────────────────────── */
function canvas(w, h) {
  const px = new Float64Array(w * h * 3);
  const set = (x, y, r, g, b) => {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const i = (y * w + x) * 3;
    px[i] = r;
    px[i + 1] = g;
    px[i + 2] = b;
  };
  /** Blend one channel-triple over the existing pixel. */
  const blend = (x, y, color, alpha) => {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= w || y >= h || alpha <= 0) return;
    const i = (y * w + x) * 3;
    px[i] += (color[0] - px[i]) * alpha;
    px[i + 1] += (color[1] - px[i + 1]) * alpha;
    px[i + 2] += (color[2] - px[i + 2]) * alpha;
  };
  const fill = (x0, y0, w0, h0, color) => {
    for (let y = Math.max(0, y0); y < Math.min(h, y0 + h0); y++)
      for (let x = Math.max(0, x0); x < Math.min(w, x0 + w0); x++)
        set(x, y, color[0], color[1], color[2]);
  };
  /** Vertical multi-stop gradient across the whole canvas. */
  const vgrad = (stops) => {
    for (let y = 0; y < h; y++) {
      const [r, g, b] = gradient(stops, h === 1 ? 0 : y / (h - 1));
      for (let x = 0; x < w; x++) set(x, y, r, g, b);
    }
  };
  /** Soft elliptical glow, additive-over. */
  const glow = (cx, cy, rx, ry, color, alpha) => {
    for (let y = 0; y < h; y++) {
      const dy = (y - cy) / ry;
      for (let x = 0; x < w; x++) {
        const dx = (x - cx) / rx;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < 1) blend(x, y, color, alpha * (1 - d));
      }
    }
  };
  const hline = (x0, x1, y, color, alpha) => {
    for (let x = x0; x <= x1; x++) blend(x, y, color, alpha);
  };
  /** Antialiased filled disc. */
  const disc = (cx, cy, r, color) => {
    for (let y = Math.floor(cy - r - 1); y <= Math.ceil(cy + r + 1); y++) {
      for (let x = Math.floor(cx - r - 1); x <= Math.ceil(cx + r + 1); x++) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        const a = Math.min(1, Math.max(0, r + 0.5 - d));
        if (a > 0) blend(x, y, color, a);
      }
    }
  };
  const text = (str, x0, y0, scale, color) => {
    let cx = x0;
    for (const ch of str.toUpperCase()) {
      const glyph = FONT[ch] ?? FONT[" "];
      for (let r = 0; r < 7; r++)
        for (let c = 0; c < 5; c++)
          if (glyph[r] & (1 << (4 - c)))
            fill(cx + c * scale, y0 + r * scale, scale, scale, color);
      cx += 6 * scale;
    }
    return cx - x0 - scale; // drawn width
  };
  const textWidth = (str, scale) => str.length * 6 * scale - scale;
  const textRight = (str, xRight, y0, scale, color) =>
    text(str, xRight - textWidth(str, scale), y0, scale, color);

  /**
   * The Signalpath mark — the logo's rounded square, glow, five capsule bars,
   * rim and specular line — rendered at `size` px with 3×3 subsampling so the
   * small installer sizes stay smooth.
   */
  const mark = (x0, y0, size) => {
    const scale = size / 512;
    const bars = [
      { x: 123, y: 217, w: 34, h: 78, color: [0xea, 0xf2, 0xff], alpha: 0.42 },
      { x: 181, y: 167, w: 34, h: 178, color: [0xf4, 0xf8, 0xff], alpha: 0.78 },
      { x: 239, y: 97, w: 34, h: 318, gradient: CORE_STOPS, alpha: 1 },
      { x: 297, y: 167, w: 34, h: 178, color: [0xf4, 0xf8, 0xff], alpha: 0.78 },
      { x: 355, y: 217, w: 34, h: 78, color: [0xea, 0xf2, 0xff], alpha: 0.42 },
    ];
    const cx = x0 + size / 2;
    const cy = y0 + size / 2;
    const r = 112 * scale;
    const pad = 1;
    const SUB = 3;

    for (let y = Math.floor(y0 - pad); y < y0 + size + pad; y++) {
      for (let x = Math.floor(x0 - pad); x < x0 + size + pad; x++) {
        let sr = 0;
        let sg = 0;
        let sb = 0;
        let hits = 0;
        for (let sy = 0; sy < SUB; sy++) {
          for (let sx = 0; sx < SUB; sx++) {
            const lx = x + (sx + 0.5) / SUB;
            const ly = y + (sy + 0.5) / SUB;
            if (!inRoundRect(lx, ly, cx, cy, size / 2, size / 2, r)) continue;

            let [rr, gg, bb] = gradient(BG_STOPS, (ly - y0) / size);

            // Cyan top glow.
            const gx = (lx - (x0 + 256 * scale)) / (220 * scale);
            const gy = (ly - (y0 + 132 * scale)) / (310 * scale);
            const gd = Math.sqrt(gx * gx + gy * gy);
            if (gd < 1) {
              const a = 0.22 * (1 - gd);
              rr += (0x00 - rr) * a;
              gg += (0xe0 - gg) * a;
              bb += (0xff - bb) * a;
            }

            // 1px hairline rim — lifted slightly over the logo's own 16%
            // so the tile keeps an edge against the dark installer rail.
            if (!inRoundRect(lx, ly, cx, cy, size / 2 - 1, size / 2 - 1, Math.max(0, r - 1))) {
              const a = mix(0.28, 0.06, (ly - y0) / size);
              rr += (255 - rr) * a;
              gg += (255 - gg) * a;
              bb += (255 - bb) * a;
            }

            for (const bar of bars) {
              const bx = x0 + (bar.x + bar.w / 2) * scale;
              const by = y0 + (bar.y + bar.h / 2) * scale;
              const bw = (bar.w / 2) * scale;
              const bh = (bar.h / 2) * scale;
              if (!inRoundRect(lx, ly, bx, by, bw, bh, bw)) continue;
              const c = bar.gradient
                ? gradient(bar.gradient, (ly - (y0 + bar.y * scale)) / (bar.h * scale))
                : bar.color;
              rr += (c[0] - rr) * bar.alpha;
              gg += (c[1] - gg) * bar.alpha;
              bb += (c[2] - bb) * bar.alpha;
            }

            // Specular line (sub-pixel at small sizes, still lifts the core).
            const hx = x0 + (243 + 1.5) * scale;
            const hy = y0 + (108 + 148) * scale;
            const hw = Math.max(0.5, 1.5 * scale);
            if (inRoundRect(lx, ly, hx, hy, hw, 148 * scale, hw)) {
              rr += (255 - rr) * 0.28;
              gg += (255 - gg) * 0.28;
              bb += (255 - bb) * 0.28;
            }

            sr += rr;
            sg += gg;
            sb += bb;
            hits++;
          }
        }
        if (hits > 0) {
          const coverage = hits / (SUB * SUB);
          blend(x, y, [sr / hits, sg / hits, sb / hits], coverage);
        }
      }
    }
  };

  return {
    w,
    h,
    px,
    set,
    blend,
    fill,
    vgrad,
    glow,
    hline,
    disc,
    text,
    textWidth,
    textRight,
    mark,
  };
}

/* ── sidebar 164×314 ─────────────────────────────────────────────────── */
function sidebar() {
  const cv = canvas(164, 314);
  cv.vgrad(BG_STOPS);
  // cyan haze behind the mark, echoing the logo glow
  cv.glow(82, 80, 118, 150, CYAN, 0.1);
  // top hairline
  cv.hline(0, 163, 0, WHITE, 0.12);

  cv.mark(36, 34, 92);

  // wordmark + descriptor
  cv.text("SIGNALPATH", 23, 142, 2, WHITE);
  cv.text("BROADCAST AUDIO", 43, 164, 1, DIM);
  cv.hline(34, 129, 180, CYAN_DIM, 0.45);

  // ON AIR chip — cyan LED, quiet panel, no retro lamp
  for (let y = 192; y < 226; y++) {
    for (let x = 28; x < 136; x++) {
      const edge = !inRoundRect(x + 0.5, y + 0.5, 82, 209, 54, 17, 4);
      if (edge) continue;
      cv.set(x, y, PANEL[0], PANEL[1], PANEL[2]);
    }
  }
  // chip outline
  for (let y = 192; y < 226; y++) {
    for (let x = 28; x < 136; x++) {
      const inside = inRoundRect(x + 0.5, y + 0.5, 82, 209, 54, 17, 4);
      const inner = inRoundRect(x + 0.5, y + 0.5, 82, 209, 53, 16, 3);
      if (inside && !inner) cv.blend(x, y, CYAN, 0.3);
    }
  }
  cv.glow(43, 209, 9, 9, CYAN, 0.35);
  cv.disc(43, 209, 3, CYAN);
  cv.text("ON AIR", 54, 202, 2, CYAN);

  // PPM tick strip: safe zone → amber → over
  for (let i = 0; i <= 10; i++) {
    const x = 32 + i * 10;
    const h = i % 5 === 0 ? 10 : 6;
    const col = i >= 9 ? RED : i >= 7 ? AMBER : i >= 5 ? CYAN_DIM : GREEN;
    for (let y = 262 - h; y < 262; y++) cv.set(x, y, col[0], col[1], col[2]);
  }

  // version + bottom accent
  cv.text(
    versionLabel,
    Math.round(82 - cv.textWidth(versionLabel, 1) / 2),
    284,
    1,
    DIM,
  );
  for (let x = 0; x < 164; x++) {
    const a = 0.55 * (1 - Math.abs(x - 82) / 82);
    cv.blend(x, 306, CYAN, Math.max(0, a));
    cv.blend(x, 307, CYAN, Math.max(0, a) * 0.4);
  }
  return cv;
}

/* ── header 150×57 ───────────────────────────────────────────────────── */
function header() {
  const cv = canvas(150, 57);
  cv.vgrad(BG_STOPS);
  cv.glow(26, 26, 54, 46, CYAN, 0.1);

  cv.mark(11, 14, 30);

  cv.text("SIGNALPATH", 49, 15, 1, WHITE);
  cv.text("BROADCAST AUDIO", 49, 27, 1, DIM);

  cv.glow(51, 44, 6, 6, CYAN, 0.4);
  cv.disc(51, 44, 2, CYAN);
  cv.text("ON AIR", 57, 41, 1, CYAN);
  cv.textRight(versionLabel, 142, 41, 1, DIM);

  cv.hline(0, 149, 56, CYAN_DIM, 0.35);
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
