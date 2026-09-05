/**
 * Generates web/resources/icon.png and web/resources/splash.png — the two
 * source images `npx @capacitor/assets generate --android` slices into every
 * mipmap and drawable density the APK needs.
 *
 * Why hand-rolled instead of a design file or an image library: the project
 * must build on a machine with nothing but Node installed, and `sharp` (what
 * @capacitor/assets itself uses) is a native module that is exactly the kind
 * of thing that fails on the teacher's laptop. Node's own `zlib` is enough to
 * emit a valid PNG, so these two files are reproducible from source with zero
 * dependencies. Delete them and re-run `npm run assets:gen` at any time.
 *
 * The artwork is deliberately plain — a blue rounded square with a white
 * mortarboard, matching the #2563eb theme colour in index.html. Replace both
 * PNGs with real artwork whenever there is any, and nothing else changes.
 *
 *   node scripts/generate-assets.mjs
 */

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT_DIR = join(dirname(dirname(fileURLToPath(import.meta.url))), "resources");

/** Same blue as `<meta name="theme-color">` and the primary button. */
const BLUE = [37, 99, 235];
const WHITE = [255, 255, 255];

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

/** `pixels` is RGBA, 4 bytes per pixel, row-major. */
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

/* ─────────────────────────────── Geometry ──────────────────────────────── */

/** Inside a rounded square spanning [0,size] with the given corner radius. */
function inRoundedSquare(x, y, size, radius) {
  const dx = Math.max(radius - x, x - (size - radius), 0);
  const dy = Math.max(radius - y, y - (size - radius), 0);
  return dx * dx + dy * dy <= radius * radius;
}

/**
 * A mortarboard centred on (cx, cy) drawn at scale `g`, in three parts:
 * the diamond board, the cap under it, and the tassel hanging off the right.
 * All offsets are fractions of `g` so the glyph scales without re-tuning.
 */
function inMortarboard(x, y, cx, cy, g) {
  const dx = x - cx;
  const dy = y - cy;

  // Board — a rhombus, i.e. a square seen in perspective.
  const boardY = dy + 0.20 * g;
  if (Math.abs(dx) / (0.52 * g) + Math.abs(boardY) / (0.24 * g) <= 1) return true;

  // Cap — a trapezoid tucked under the board, narrowing towards the bottom.
  const capTop = -0.02 * g;
  const capBottom = 0.30 * g;
  if (dy >= capTop && dy <= capBottom) {
    const t = (dy - capTop) / (capBottom - capTop);
    const halfWidth = (0.30 - 0.06 * t) * g;
    // Round the bottom corners so it reads as fabric rather than a box.
    const corner = 0.10 * g;
    const overshoot = Math.max(dy - (capBottom - corner), 0);
    const sideCut = Math.max(Math.abs(dx) - (halfWidth - corner), 0);
    if (Math.abs(dx) <= halfWidth && sideCut * sideCut + overshoot * overshoot <= corner * corner)
      return true;
  }

  // Tassel — a cord down the right edge of the board ending in a knot.
  const cordX = 0.47 * g;
  if (Math.abs(dx - cordX) <= 0.028 * g && dy >= -0.20 * g && dy <= 0.16 * g) return true;
  const knotY = 0.21 * g;
  if ((dx - cordX) ** 2 + (dy - knotY) ** 2 <= (0.062 * g) ** 2) return true;

  return false;
}

/* ─────────────────────────────── Rendering ─────────────────────────────── */

/**
 * `shape(x, y)` returns 0 (transparent), 1 (blue) or 2 (white) for a point in
 * image space. Each pixel averages SUPERSAMPLE² samples, which is what turns
 * the diagonal board edges from stairs into a clean line.
 */
function render(width, height, shape) {
  const pixels = Buffer.alloc(width * height * 4);
  const step = 1 / SUPERSAMPLE;
  const offset = step / 2;
  const total = SUPERSAMPLE * SUPERSAMPLE;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let blue = 0;
      let white = 0;

      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const value = shape(x + sx * step + offset, y + sy * step + offset);
          if (value === 1) blue += 1;
          else if (value === 2) white += 1;
        }
      }

      const i = (y * width + x) * 4;
      const covered = blue + white;
      if (covered === 0) continue;

      // Composite the two ink colours by coverage, then premultiply nothing —
      // PNG alpha is straight, so the RGB is the average of what is *there*.
      pixels[i] = Math.round((BLUE[0] * blue + WHITE[0] * white) / covered);
      pixels[i + 1] = Math.round((BLUE[1] * blue + WHITE[1] * white) / covered);
      pixels[i + 2] = Math.round((BLUE[2] * blue + WHITE[2] * white) / covered);
      pixels[i + 3] = Math.round((covered / total) * 255);
    }
  }

  return encodePNG(width, height, pixels);
}

/**
 * 1024×1024 launcher icon. The glyph is kept inside the middle ~62% so it
 * survives Android's adaptive-icon mask, which can crop to a circle.
 */
function icon(size = 1024) {
  const radius = size * 0.22;
  const centre = size / 2;
  const glyph = size * 0.62;
  return render(size, size, (x, y) => {
    if (!inRoundedSquare(x, y, size, radius)) return 0;
    return inMortarboard(x, y, centre, centre, glyph) ? 2 : 1;
  });
}

/**
 * 2732×2732 splash. @capacitor/assets centre-crops this to every orientation,
 * so the artwork must stay well inside the middle square — hence a glyph at
 * 18% of the canvas on a full-bleed background.
 */
function splash(size = 2732) {
  const centre = size / 2;
  const glyph = size * 0.18;
  const half = glyph;
  return render(size, size, (x, y) => {
    // Outside the glyph's bounding box nothing but background can appear, and
    // skipping the shape test there is what keeps 7.5M pixels quick.
    if (Math.abs(x - centre) > half || Math.abs(y - centre) > half) return 1;
    return inMortarboard(x, y, centre, centre, glyph) ? 2 : 1;
  });
}

mkdirSync(OUT_DIR, { recursive: true });

for (const [name, buffer] of [
  ["icon.png", icon()],
  ["splash.png", splash()],
  // Same artwork for dark mode: the background is already dark enough to sit
  // under white status-bar icons, and a second palette would only drift.
  ["splash-dark.png", splash()],
]) {
  const target = join(OUT_DIR, name);
  writeFileSync(target, buffer);
  console.log(`${name.padEnd(16)} ${(buffer.length / 1024).toFixed(1)} KB  →  ${target}`);
}
