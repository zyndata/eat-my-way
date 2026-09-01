#!/usr/bin/env node
/**
 * Generate the PWA icon set into `public/icons/`.
 *
 * The icons are drawn here rather than exported from a design tool so that the whole set is
 * reproducible from source and carries no binary blob nobody can regenerate. Everything is
 * plain arithmetic plus Node's own `zlib` — no image library, no new runtime dependency, and
 * nothing to keep in sync with the brand colour by hand: the accent is the same
 * `oklch(62% 0.16 145)` token that `src/app.css` defines, converted here.
 *
 * Run: `npm run build:icons`. The output is committed, because the production image is built
 * from `dist/` in CI and must not depend on this script having run.
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');

/* ---------------------------------------------------------------- colour -- */

/** sRGB transfer function, linear -> encoded. */
function encodeChannel(linear) {
  const clamped = Math.min(1, Math.max(0, linear));
  const encoded = clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * clamped ** (1 / 2.4) - 0.055;
  return Math.round(encoded * 255);
}

/**
 * OKLCH -> sRGB bytes. `l` is 0..1, `c` is the chroma, `hDeg` the hue in degrees — the exact
 * arguments the CSS token uses, so a colour never has to be eyeballed into a hex value.
 */
function oklch(l, c, hDeg) {
  const h = (hDeg * Math.PI) / 180;
  const a = c * Math.cos(h);
  const b = c * Math.sin(h);

  const lms = [
    (l + 0.3963377774 * a + 0.2158037573 * b) ** 3,
    (l - 0.1055613458 * a - 0.0638541728 * b) ** 3,
    (l - 0.0894841775 * a - 1.291485548 * b) ** 3
  ];

  return [
    encodeChannel(4.0767416621 * lms[0] - 3.3077115913 * lms[1] + 0.2309699292 * lms[2]),
    encodeChannel(-1.2684380046 * lms[0] + 2.6097574011 * lms[1] - 0.3413193965 * lms[2]),
    encodeChannel(-0.0041960863 * lms[0] - 0.7034186147 * lms[1] + 1.707614701 * lms[2])
  ];
}

/** --color-accent and --color-accent-ink from src/app.css. */
const ACCENT = oklch(0.62, 0.16, 145);
const ACCENT_DARK = oklch(0.5, 0.14, 145);
const INK = oklch(0.99, 0.01, 145);

/* ----------------------------------------------------------------- shapes -- */

/**
 * Signed-distance helpers, all in unit coordinates (0..1 across the icon) so one drawing
 * describes every size. A shape returns the distance to its edge: negative inside.
 */

function sdCircle(x, y, cx, cy, r) {
  return Math.hypot(x - cx, y - cy) - r;
}

function sdRoundedRect(x, y, cx, cy, halfW, halfH, radius) {
  const dx = Math.abs(x - cx) - (halfW - radius);
  const dy = Math.abs(y - cy) - (halfH - radius);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  return outside + Math.min(Math.max(dx, dy), 0) - radius;
}

/**
 * The mark: a plate seen from above with a fork on it. `scale` shrinks it towards the centre
 * so the maskable variant keeps everything inside the 80 % safe zone Android crops to.
 */
function markDistance(x, y, scale) {
  const px = 0.5 + (x - 0.5) / scale;
  const py = 0.5 + (y - 0.5) / scale;

  const plate = sdCircle(px, py, 0.5, 0.5, 0.33);
  const rim = sdCircle(px, py, 0.5, 0.5, 0.285);

  // Fork: a handle, a bridge across the tines, and three tines.
  const handle = sdRoundedRect(px, py, 0.5, 0.6, 0.022, 0.13, 0.022);
  const bridge = sdRoundedRect(px, py, 0.5, 0.47, 0.075, 0.022, 0.022);
  const tines = [-0.053, 0, 0.053].map((offset) =>
    sdRoundedRect(px, py, 0.5 + offset, 0.415, 0.018, 0.055, 0.018)
  );
  const fork = Math.min(handle, bridge, ...tines);

  return { plate, rim, fork };
}

/* -------------------------------------------------------------- rendering -- */

/** Coverage of a shape at one sample, softened over roughly one device pixel. */
function coverage(distance, size) {
  const edge = 1 / size;
  return Math.min(1, Math.max(0, 0.5 - distance / edge));
}

function over(dst, src, alpha) {
  return [0, 1, 2].map((i) => dst[i] * (1 - alpha) + src[i] * alpha);
}

/**
 * One icon as raw RGBA rows.
 *
 * `background` fills the whole square for the maskable variant (Android draws its own shape
 * over it); the `any` variant instead rounds its own corners, which is what a desktop
 * launcher and a browser tab expect.
 */
function render(size, { markScale, rounded }) {
  const samples = 3;
  const rows = [];

  for (let py = 0; py < size; py += 1) {
    const row = Buffer.alloc(size * 4);
    for (let px = 0; px < size; px += 1) {
      let color = [0, 0, 0];
      let alpha = 0;

      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const x = (px + (sx + 0.5) / samples) / size;
          const y = (py + (sy + 0.5) / samples) / size;

          const bg = rounded ? sdRoundedRect(x, y, 0.5, 0.5, 0.5, 0.5, 0.22) : -1;
          const bgAlpha = coverage(bg, size);

          const { plate, rim, fork } = markDistance(x, y, markScale);
          let sample = ACCENT;
          sample = over(sample, INK, coverage(plate, size));
          sample = over(sample, ACCENT_DARK, coverage(rim, size) * 0.14);
          sample = over(sample, ACCENT, coverage(fork, size));

          color = [0, 1, 2].map((i) => color[i] + sample[i] * bgAlpha);
          alpha += bgAlpha;
        }
      }

      const total = samples * samples;
      const a = alpha / total;
      const offset = px * 4;
      // Straight (un-premultiplied) alpha: divide the accumulated colour by its own coverage.
      for (let i = 0; i < 3; i += 1) {
        row[offset + i] = Math.round(a === 0 ? 0 : color[i] / alpha);
      }
      row[offset + 3] = Math.round(a * 255);
    }
    rows.push(row);
  }

  return rows;
}

/* ------------------------------------------------------------------- PNG -- */

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** Minimal 8-bit RGBA PNG. Filter type 0 on every row — the images are small and flat. */
function encodePng(size, rows) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  const raw = Buffer.concat(rows.map((row) => Buffer.concat([Buffer.from([0]), row])));

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ------------------------------------------------------------------ main -- */

/**
 * `maskable` fills the square and keeps the mark inside the safe zone; `any` rounds its own
 * corners. Chrome wants both a 192 and a 512 for installability; iOS reads the 180 and
 * ignores the manifest.
 */
const ICONS = [
  { file: 'icon-192.png', size: 192, markScale: 1, rounded: true },
  { file: 'icon-512.png', size: 512, markScale: 1, rounded: true },
  { file: 'icon-maskable-512.png', size: 512, markScale: 0.72, rounded: false },
  { file: 'apple-touch-icon.png', size: 180, markScale: 0.88, rounded: false },
  { file: 'favicon-32.png', size: 32, markScale: 1, rounded: true }
];

mkdirSync(OUT_DIR, { recursive: true });

for (const icon of ICONS) {
  const png = encodePng(icon.size, render(icon.size, icon));
  writeFileSync(join(OUT_DIR, icon.file), png);
  console.log(`${icon.file} — ${icon.size}px, ${png.length} bytes`);
}
