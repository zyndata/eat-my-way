#!/usr/bin/env node
/**
 * Generate the PWA icon set into `public/icons/` from `data/icon-source.png`.
 *
 * The set used to be *drawn* here — a plate and a fork as signed distance fields — so that no
 * binary nobody could regenerate lived in the repo. The brand mark replaced it, and the
 * premise survives the change: there is exactly one source image, it is committed next to the
 * other build inputs, and every icon in `public/icons/` is reproduced from it by this script.
 * What it does is resample, not draw.
 *
 * Still no image library, and none is needed: the source is written as a plain 8-bit
 * non-interlaced PNG, which `node:zlib` plus about forty lines of unfiltering can read, and
 * the encoder was already here.
 *
 * Run: `npm run build:icons`. The output is committed, because the production image is built
 * from `dist/` in CI and must not depend on this script having run.
 */

import { deflateSync, inflateSync } from 'node:zlib';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(ROOT, 'data', 'icon-source.png');
const OUT_DIR = join(ROOT, 'public', 'icons');

/* --------------------------------------------------------------- decoding -- */

/**
 * Enough of PNG to read one file we write ourselves: 8 bits per channel, colour type 2 or 6,
 * no interlacing. Anything else is refused loudly rather than guessed at.
 */
function decodePng(buffer) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!buffer.subarray(0, 8).equals(signature)) throw new Error('Not a PNG');

  let width = 0;
  let height = 0;
  let channels = 0;
  const parts = [];

  for (let offset = 8; offset < buffer.length; ) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const depth = data[8];
      const colorType = data[9];
      const interlace = data[12];
      if (depth !== 8) throw new Error(`Unsupported bit depth ${depth}`);
      if (colorType !== 2 && colorType !== 6) throw new Error(`Unsupported colour type ${colorType}`);
      if (interlace !== 0) throw new Error('Interlaced PNG is not supported');
      channels = colorType === 2 ? 3 : 4;
    } else if (type === 'IDAT') {
      parts.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }

  const raw = inflateSync(Buffer.concat(parts));
  const stride = width * channels;
  const pixels = Buffer.alloc(height * stride);

  // Undo the per-row filters. Each row is preceded by its filter type byte.
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = pixels.subarray(y * stride, (y + 1) * stride);
    const prior = y === 0 ? null : pixels.subarray((y - 1) * stride, y * stride);

    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? out[x - channels] : 0;
      const up = prior === null ? 0 : prior[x];
      const upLeft = prior === null || x < channels ? 0 : prior[x - channels];
      let value = line[x];

      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) {
        // Paeth: pick whichever neighbour the gradient predicts best.
        const p = left + up - upLeft;
        const dLeft = Math.abs(p - left);
        const dUp = Math.abs(p - up);
        const dUpLeft = Math.abs(p - upLeft);
        value += dLeft <= dUp && dLeft <= dUpLeft ? left : dUp <= dUpLeft ? up : upLeft;
      } else if (filter !== 0) {
        throw new Error(`Unknown row filter ${filter}`);
      }

      out[x] = value & 0xff;
    }
  }

  return { width, height, channels, pixels };
}

/* -------------------------------------------------------------- rendering -- */

/** The colour the mark sits on, read from the source itself so the two can never drift apart. */
function groundColor(image) {
  return [image.pixels[0], image.pixels[1], image.pixels[2]];
}

/**
 * The average of the source over one target pixel — a box filter, which is the right one for
 * shrinking and needs no window function. `scale` is how much of the target the source spans;
 * everything outside it is the ground.
 */
function sample(image, ground, size, scale, px, py) {
  const span = size * scale;
  const origin = (size - span) / 2;
  const x0 = ((px - origin) / span) * image.width;
  const x1 = ((px + 1 - origin) / span) * image.width;
  const y0 = ((py - origin) / span) * image.height;
  const y1 = ((py + 1 - origin) / span) * image.height;

  const left = Math.max(0, Math.floor(x0));
  const right = Math.min(image.width, Math.ceil(x1));
  const top = Math.max(0, Math.floor(y0));
  const bottom = Math.min(image.height, Math.ceil(y1));
  if (left >= right || top >= bottom) return ground;

  const total = [0, 0, 0];
  let count = 0;
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const offset = (y * image.width + x) * image.channels;
      total[0] += image.pixels[offset];
      total[1] += image.pixels[offset + 1];
      total[2] += image.pixels[offset + 2];
      count += 1;
    }
  }
  return [total[0] / count, total[1] / count, total[2] / count];
}

/** Distance to a rounded square in unit coordinates; negative inside. */
function sdRoundedRect(x, y, radius) {
  const dx = Math.abs(x - 0.5) - (0.5 - radius);
  const dy = Math.abs(y - 0.5) - (0.5 - radius);
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - radius;
}

/**
 * One icon as raw RGBA rows.
 *
 * `rounded` cuts the corners off, which is what a browser tab and a desktop launcher expect of
 * a `purpose: any` icon. The maskable variant instead fills the whole square — Android draws
 * its own shape over it — and shrinks the mark into the safe zone it crops to.
 */
function render(image, size, { scale, rounded }) {
  const ground = groundColor(image);
  const samples = 3;
  const rows = [];

  for (let py = 0; py < size; py += 1) {
    const row = Buffer.alloc(size * 4);
    for (let px = 0; px < size; px += 1) {
      const color = sample(image, ground, size, scale, px, py);

      let alpha = 1;
      if (rounded) {
        // Supersampled only where it matters: the corner cut, not the image itself.
        let covered = 0;
        for (let sy = 0; sy < samples; sy += 1) {
          for (let sx = 0; sx < samples; sx += 1) {
            const x = (px + (sx + 0.5) / samples) / size;
            const y = (py + (sy + 0.5) / samples) / size;
            covered += sdRoundedRect(x, y, 0.22) <= 0 ? 1 : 0;
          }
        }
        alpha = covered / (samples * samples);
      }

      const offset = px * 4;
      row[offset] = Math.round(color[0]);
      row[offset + 1] = Math.round(color[1]);
      row[offset + 2] = Math.round(color[2]);
      row[offset + 3] = Math.round(alpha * 255);
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

/**
 * Minimal PNG, 8 bits per channel.
 *
 * Written as RGB when every pixel is opaque, which is every icon that does not round its own
 * corners — a quarter of the bytes of the set, and the service worker precaches all of it.
 * (Choosing a row filter per row was tried here too, by the specification's own
 * sum-of-absolute-differences heuristic: it saved 2 % on these smooth images and cost bytes on
 * the small ones, so the rows stay unfiltered.)
 */
function encodePng(size, rows) {
  const opaque = rows.every((row) => {
    for (let x = 3; x < row.length; x += 4) if (row[x] !== 255) return false;
    return true;
  });

  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = opaque ? 2 : 6; // colour type: RGB or RGBA

  const raw = Buffer.concat(
    rows.map((row) => {
      if (!opaque) return Buffer.concat([Buffer.from([0]), row]);
      const rgb = Buffer.alloc(size * 3);
      for (let px = 0; px < size; px += 1) row.copy(rgb, px * 3, px * 4, px * 4 + 3);
      return Buffer.concat([Buffer.from([0]), rgb]);
    })
  );

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ------------------------------------------------------------------ main -- */

/**
 * Chrome wants both a 192 and a 512 for installability; iOS reads the 180 and ignores the
 * manifest. `icon-maskable-512` is the one with a rule attached: Android crops a maskable icon
 * to a shape of its choosing and only the middle 80 % is guaranteed to survive, so the mark is
 * scaled into it — the plate then sits well inside the circle, name and all.
 */
const ICONS = [
  { file: 'icon-192.png', size: 192, scale: 1, rounded: true },
  { file: 'icon-512.png', size: 512, scale: 1, rounded: true },
  { file: 'icon-maskable-512.png', size: 512, scale: 0.8, rounded: false },
  { file: 'apple-touch-icon.png', size: 180, scale: 1, rounded: false },
  { file: 'favicon-32.png', size: 32, scale: 1.15, rounded: true }
];

const image = decodePng(readFileSync(SOURCE));
console.log(`source: ${image.width}×${image.height}, ${image.channels} channels`);

mkdirSync(OUT_DIR, { recursive: true });

for (const icon of ICONS) {
  const png = encodePng(icon.size, render(image, icon.size, icon));
  writeFileSync(join(OUT_DIR, icon.file), png);
  console.log(`${icon.file} — ${icon.size}px, ${png.length} bytes`);
}
