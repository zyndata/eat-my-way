#!/usr/bin/env node
/**
 * Generate the PWA icon set into `public/icons/` from the brand SVGs in `data/`.
 *
 * The set used to be *drawn* here as signed distance fields, then resampled from a single
 * 1024px PNG once a brand mark existed. Both were answers to the same question — how to get
 * icons without an image library — and the SVG makes the question go away: the only renderer
 * involved is the Chromium that `@playwright/test` already installs for the e2e suite, and it
 * draws each icon at its final size instead of shrinking one bitmap into all of them. Nothing
 * is resampled, so nothing is soft, and the sources are text a diff can show.
 *
 * Two sources, because one image cannot serve every size. `icon-source.svg` is the lockup —
 * mark plus wordmark — and carries the brand wherever the icon is drawn large enough to read
 * three lines of type. `icon-mark.svg` drops the wordmark and fills the frame with the sprig
 * alone; at 32px the lockup's type is four pixels tall and reads as texture, so the favicon
 * takes the mark.
 *
 * Run: `npm run build:icons`. The output is committed, because the production image is built
 * from `dist/` in CI and must not depend on this script — or a browser — having run there.
 */

import { chromium } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(ROOT, 'data');
const OUT_DIR = join(ROOT, 'public', 'icons');

/**
 * Chrome wants both a 192 and a 512 for installability; iOS reads the 180 and ignores the
 * manifest. `icon-maskable-512` is the one with a rule attached: Android crops a maskable icon
 * to a shape of its choosing and only the middle 80 % is guaranteed to survive, so the artwork
 * is scaled into that safe zone and the ground fills the rest.
 *
 * `rounded` cuts the corners off, which is what a browser tab and a desktop launcher expect of
 * a `purpose: any` icon. A maskable icon must not — Android draws its own shape over it — and
 * neither must the Apple one, which iOS rounds itself and would otherwise darken at the edge.
 *
 * `scale` is how much of the square the artwork spans. Above 1 it overflows and is cropped,
 * which is how the favicon buys a little more mark at a size that has pixels to spare.
 */
const ICONS = [
  { file: 'icon-192.png', size: 192, source: 'icon-source.svg', scale: 1, rounded: true },
  { file: 'icon-512.png', size: 512, source: 'icon-source.svg', scale: 1, rounded: true },
  { file: 'icon-maskable-512.png', size: 512, source: 'icon-source.svg', scale: 0.8, rounded: false },
  { file: 'apple-touch-icon.png', size: 180, source: 'icon-source.svg', scale: 1, rounded: false },
  { file: 'favicon-32.png', size: 32, source: 'icon-mark.svg', scale: 1.06, rounded: true }
];

/** The colour the mark sits on, read from the source itself so the two can never drift apart. */
function groundColor(svg) {
  const match = svg.match(/<rect[^>]*\bfill="(#[0-9a-fA-F]{3,8})"/);
  if (match === null) throw new Error('No ground colour: the source needs a background <rect fill="#…">');
  return match[1];
}

/**
 * One icon, drawn by the browser at its final size.
 *
 * The rounding is a CSS `border-radius` on the artwork rather than a shape subtracted from it
 * afterwards, so the corner is antialiased by the same rasteriser that drew everything else,
 * and `omitBackground` lets the transparency outside it through to the PNG.
 */
async function render(page, svg, { size, scale, rounded }) {
  const ground = groundColor(svg);
  const span = Math.round(size * scale);
  const offset = Math.round((size - span) / 2);

  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<style>
       html, body { margin: 0; padding: 0; background: ${rounded ? 'transparent' : ground}; }
       #frame {
         position: absolute; inset: 0; overflow: hidden;
         background: ${ground};
         ${rounded ? `border-radius: ${(0.22 * size).toFixed(2)}px;` : ''}
       }
       svg { position: absolute; left: ${offset}px; top: ${offset}px; width: ${span}px; height: ${span}px; }
     </style>
     <div id="frame">${svg}</div>`
  );
  await page.evaluate(() => document.fonts.ready);

  return page.screenshot({ type: 'png', omitBackground: rounded });
}

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });

mkdirSync(OUT_DIR, { recursive: true });

const sources = new Map();
for (const icon of ICONS) {
  if (!sources.has(icon.source)) sources.set(icon.source, readFileSync(join(DATA_DIR, icon.source), 'utf8'));
  const png = await render(page, sources.get(icon.source), icon);
  writeFileSync(join(OUT_DIR, icon.file), png);
  console.log(`${icon.file} — ${icon.size}px from ${icon.source}, ${png.length} bytes`);
}

// The one icon that ships as itself. A browser that understands `image/svg+xml` prefers it and
// draws the mark sharp at whatever size the tab, the bookmark bar or a 200 % display asks for;
// one that does not falls back to `favicon-32.png`, which is the same artwork. Copied rather
// than written by hand so the served file cannot drift from the source it came from.
const favicon = sources.get('icon-mark.svg');
writeFileSync(join(OUT_DIR, 'favicon.svg'), favicon);
console.log(`favicon.svg — vector from icon-mark.svg, ${Buffer.byteLength(favicon)} bytes`);

await browser.close();
