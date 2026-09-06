/**
 * Draws the Mr Ahmed Ibrahim Students app icon and splash screen from source.
 *
 * Outputs, into web/resources/:
 *   icon.png          1024×1024  the brand tile — #7C5CFF rounded square, white cap
 *   splash.png        2732×2732  the mark centred on the #0A0B0F app canvas
 *   splash-dark.png   2732×2732  identical (the canvas is already the dark one)
 *
 * `npx @capacitor/assets generate --android` slices those three into every
 * mipmap and drawable density the APK needs.
 *
 * WHY IT IS DRAWN IN CODE. The project must build on a machine with nothing but
 * Node installed, and every image library worth using (sharp, canvas) is a
 * native module — exactly the kind of dependency that fails on the teacher's
 * laptop. Node's own zlib is enough to emit a valid PNG, so the artwork is
 * reproducible from this one file with zero dependencies. Delete the PNGs and
 * run `npm run brand` from the repo root at any time.
 *
 * THE ARTWORK IS THE MARK, and the mark is defined once — in
 * web/src/components/Brand.tsx, as an inline SVG on a 100×100 grid. The
 * coordinates below are that SVG, path for path: the mortarboard diamond
 * (50,24)→(88,42)→(50,60)→(12,42), the cap body under it, the tassel cord down
 * the right and its knot. Change the SVG and change these together, or the
 * launcher icon and the in-app logo drift apart.
 *
 *   node scripts/generate-brand-assets.mjs
 */

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT_DIR = join(dirname(dirname(fileURLToPath(import.meta.url))), "resources");

/* ──────────────────────────────── palette ──────────────────────────────── */

/** --brand. The one accent, identical in src/index.css. */
const BRAND = [0x7c, 0x5c, 0xff]; // #7C5CFF
/** --brand-contrast: the glyph printed on the tile. */
const WHITE = [0xff, 0xff, 0xff];
/** --bg (dark): the splash canvas, and the theme-color in index.html. */
const CANVAS = [0x0a, 0x0b, 0x0f]; // #0A0B0F

/* ─────────────────────────────── proportions ───────────────────────────── */

/** Corner radius of the tile, as a fraction of its edge. Fixed by the brand. */
const CORNER_RADIUS = 0.26;

/**
 * How much the glyph is shrunk inside the launcher icon.
 *
 * At its natural size the mark's furthest point — the tassel knot — sits 41.4
 * units from the centre of the 100-grid. Android's adaptive-icon mask can crop
 * to a circle of radius 33, which would slice the knot clean off, so the glyph
 * (not the tile: that stays full-bleed) is scaled to 0.80 and everything lands
 * inside the safe circle. The in-app SVG has no mask and therefore no shrink.
 */
const ICON_GLYPH_SCALE = 0.8;

/** Mark size on the splash, as a fraction of the canvas edge. */
const SPLASH_MARK_FRACTION = 0.22;

/** Sub-pixel samples per axis. 3×3 is the point where edges stop looking sawn. */
const SUPERSAMPLE = 3;

/* ────────────────────────────── PNG encoding ───────────────────────────── */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/** `pixels` is straight-alpha RGBA, 4 bytes per pixel, row-major. */
function encodePNG(width, height, pixels) {
  const stride = width * 4;
  // Every scanline is prefixed with its filter type; 0 = None. Filtering would
  // shrink the file, but these are flat-colour images that deflate well anyway.
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ─────────────────────────── geometry primitives ───────────────────────── */

/** Flattens one cubic Bézier into points, the start point excluded. */
function cubic(p0, p1, p2, p3, steps = 40) {
  const points = [];
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    const u = 1 - t;
    const a = u * u * u;
    const b = 3 * u * u * t;
    const c = 3 * u * t * t;
    const d = t * t * t;
    points.push([
      a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0],
      a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1],
    ]);
  }
  return points;
}

/**
 * A closed polygon with a bounding box in front of it. The box is what keeps
 * this affordable: it rejects the overwhelming majority of samples in one
 * comparison, so the crossing-count loop only runs near the shape.
 */
function polygon(points) {
  const n = points.length;
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (let i = 0; i < n; i += 1) {
    xs[i] = points[i][0];
    ys[i] = points[i][1];
    if (xs[i] < minX) minX = xs[i];
    if (xs[i] > maxX) maxX = xs[i];
    if (ys[i] < minY) minY = ys[i];
    if (ys[i] > maxY) maxY = ys[i];
  }

  return function contains(x, y) {
    if (x < minX || x > maxX || y < minY || y > maxY) return false;
    let inside = false;
    for (let i = 0, j = n - 1; i < n; j = i, i += 1) {
      const yi = ys[i];
      const yj = ys[j];
      if (yi > y === yj > y) continue;
      if (x < xs[i] + ((y - yi) / (yj - yi)) * (xs[j] - xs[i])) inside = !inside;
    }
    return inside;
  };
}

/** Inside the rectangle [x0,x1]×[y0,y1] with corner radius `r`. */
function inRoundedRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const dx = Math.max(x0 + r - x, x - (x1 - r), 0);
  const dy = Math.max(y0 + r - y, y - (y1 - r), 0);
  return dx * dx + dy * dy <= r * r;
}

/* ──────────────────────────────── the mark ─────────────────────────────── */
/*  All coordinates are the 100×100 grid of the <svg> in Brand.tsx.          */

/** `<path d="M50 24 88 42 50 60 12 42Z" />` — the mortarboard. */
const inBoard = polygon([
  [50, 24],
  [88, 42],
  [50, 60],
  [12, 42],
]);

/** `<path d="M31 50.5V63c0 6.2 8.5 10.5 19 10.5S69 69.2 69 63V50.5L50 59.5Z" />` */
const inCap = polygon([
  [31, 50.5],
  [31, 63],
  ...cubic([31, 63], [31, 69.2], [39.5, 73.5], [50, 73.5]),
  ...cubic([50, 73.5], [60.5, 73.5], [69, 69.2], [69, 63]),
  [69, 50.5],
  [50, 59.5],
]);

/** The whole glyph: board, cap, tassel cord, tassel knot. */
function inGlyph(x, y) {
  if (inBoard(x, y)) return true;
  if (inCap(x, y)) return true;
  // <rect x="81.8" y="43.5" width="4.4" height="15" rx="2.2" /> — the cord.
  if (inRoundedRect(x, y, 81.8, 43.5, 86.2, 58.5, 2.2)) return true;
  // <circle cx="84" cy="65" r="4.6" /> — the knot.
  const dx = x - 84;
  const dy = y - 65;
  return dx * dx + dy * dy <= 4.6 * 4.6;
}

/** Inside the tile itself — a square with radius 26% of its edge. */
function inTile(x, y) {
  const r = 100 * CORNER_RADIUS;
  const dx = Math.max(r - x, x - (100 - r), 0);
  const dy = Math.max(r - y, y - (100 - r), 0);
  return dx * dx + dy * dy <= r * r;
}

/* ─────────────────────────────── rendering ─────────────────────────────── */

/**
 * The mark as a straight-alpha RGBA buffer, `size`×`size`, transparent outside
 * the tile. `glyphScale` shrinks the graduation cap about the centre without
 * touching the tile — see ICON_GLYPH_SCALE.
 *
 * Each pixel averages SUPERSAMPLE² samples, which is what turns the diagonal
 * board edges and the tile's corners from stairs into clean lines.
 */
function renderMark(size, glyphScale) {
  const pixels = Buffer.alloc(size * size * 4);
  const step = 1 / SUPERSAMPLE;
  const offset = step / 2;
  const total = SUPERSAMPLE * SUPERSAMPLE;
  const unit = 100 / size;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let brand = 0;
      let white = 0;

      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const gx = (x + sx * step + offset) * unit;
          const gy = (y + sy * step + offset) * unit;
          if (!inTile(gx, gy)) continue;
          if (inGlyph(50 + (gx - 50) / glyphScale, 50 + (gy - 50) / glyphScale)) white += 1;
          else brand += 1;
        }
      }

      const covered = brand + white;
      if (covered === 0) continue;

      // Composite the two ink colours by coverage. PNG alpha is straight, so
      // the RGB is the average of what is actually *there*.
      const i = (y * size + x) * 4;
      pixels[i] = Math.round((BRAND[0] * brand + WHITE[0] * white) / covered);
      pixels[i + 1] = Math.round((BRAND[1] * brand + WHITE[1] * white) / covered);
      pixels[i + 2] = Math.round((BRAND[2] * brand + WHITE[2] * white) / covered);
      pixels[i + 3] = Math.round((covered / total) * 255);
    }
  }

  return pixels;
}

/**
 * 1024×1024 launcher icon: the mark at the edge of the canvas, corners
 * transparent so the tile reads as the rounded square it is on every launcher,
 * and the glyph shrunk to sit inside the adaptive-icon mask.
 */
function icon(size = 1024) {
  return encodePNG(size, size, renderMark(size, ICON_GLYPH_SCALE));
}

/**
 * 2732×2732 splash: the mark, centred, on the app's own dark canvas.
 * @capacitor/assets centre-crops this square to every orientation, so the mark
 * is kept small (22% of the edge) and dead centre — it survives the narrowest
 * crop any phone asks for.
 */
function splash(size = 2732) {
  const pixels = Buffer.alloc(size * size * 4);
  pixels.fill(Buffer.from([CANVAS[0], CANVAS[1], CANVAS[2], 0xff]));

  // Even edge so the mark lands on whole pixels rather than straddling them.
  const mark = 2 * Math.round((size * SPLASH_MARK_FRACTION) / 2);
  const markPixels = renderMark(mark, 1);
  const origin = (size - mark) / 2;

  for (let y = 0; y < mark; y += 1) {
    for (let x = 0; x < mark; x += 1) {
      const s = (y * mark + x) * 4;
      const a = markPixels[s + 3];
      if (a === 0) continue;

      const d = ((y + origin) * size + (x + origin)) * 4;
      if (a === 255) {
        markPixels.copy(pixels, d, s, s + 4);
        continue;
      }
      // Straight-alpha source over an opaque canvas.
      const t = a / 255;
      pixels[d] = Math.round(markPixels[s] * t + CANVAS[0] * (1 - t));
      pixels[d + 1] = Math.round(markPixels[s + 1] * t + CANVAS[1] * (1 - t));
      pixels[d + 2] = Math.round(markPixels[s + 2] * t + CANVAS[2] * (1 - t));
    }
  }

  return encodePNG(size, size, pixels);
}

/* ──────────────────────────────── output ───────────────────────────────── */

mkdirSync(OUT_DIR, { recursive: true });

const splashPNG = splash();

for (const [name, buffer] of [
  ["icon.png", icon()],
  ["splash.png", splashPNG],
  // The light-mode splash is already the dark canvas — the app is dark-first,
  // and a second palette here would only drift from index.html's theme-color.
  ["splash-dark.png", splashPNG],
]) {
  const target = join(OUT_DIR, name);
  writeFileSync(target, buffer);
  console.log(`${name.padEnd(16)} ${(buffer.length / 1024).toFixed(1)} KB  →  ${target}`);
}
