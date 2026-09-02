#!/usr/bin/env node
/**
 * Build the bundled nutrition subset.
 *
 *   node scripts/build-nutrition.mjs [--check] [--offline]
 *
 * Inputs
 *   - data/pl-ingredients.tsv  the hand-curated Polish name -> fdcId mapping. It decides
 *     BOTH which USDA entries are bundled and what they are called in the UI.
 *   - two pinned USDA FoodData Central releases, downloaded into data/usda/ (gitignored)
 *     and verified against the SHA-256 digests below.
 *
 * Output
 *   - src/lib/nutrition/ingredients.json, committed, loaded into IndexedDB on first run.
 *   - src/lib/nutrition/meta.ts, committed, so the app knows the data version and the
 *     attribution text without fetching the JSON first.
 *
 * The output is a pure function of those inputs: the URLs are pinned to a dated release,
 * the archives are checked by digest, rows are emitted in fdcId order and every number is
 * rounded the same way. Same inputs -> byte-identical JSON.
 *
 * This runs at dev time only. Nothing in `npm run build` or in the browser touches it, and
 * the app makes no network call for nutrition data ever.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv } from './csv.mjs';
import { readZipIndex, readZipMemberByBaseName } from './usda-zip.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = path.join(ROOT, 'data', 'usda');
const MAPPING_FILE = path.join(ROOT, 'data', 'pl-ingredients.tsv');
const OUTPUT_FILE = path.join(ROOT, 'src', 'lib', 'nutrition', 'ingredients.json');
const META_FILE = path.join(ROOT, 'src', 'lib', 'nutrition', 'meta.ts');

/**
 * Bump when the shape of the output changes or a release below is replaced. The app stores
 * it in IndexedDB and re-imports only when the stored value is lower.
 */
const DATA_VERSION = 2;

/**
 * Pinned USDA releases. SR Legacy has been frozen since 2018 and will not move again;
 * Foundation Foods is refreshed twice a year, so bumping it is a deliberate act that
 * changes the digest, the release id and DATA_VERSION together.
 */
const DATASETS = [
  {
    id: 'sr_legacy_2018-04',
    file: 'FoodData_Central_sr_legacy_food_csv_2018-04.zip',
    url: 'https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_sr_legacy_food_csv_2018-04.zip',
    sha256: 'b80817294b8850530aaedf2e515c02593b1824f763a0ff356e5c2081643e6fd0'
  },
  {
    id: 'foundation_2026-04-30',
    file: 'FoodData_Central_foundation_food_csv_2026-04-30.zip',
    url: 'https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_foundation_food_csv_2026-04-30.zip',
    sha256: '70457ee9d9342f43bda2010318c85f04210c689fdeb9cd2da4c513b0e8dbc655'
  }
];

/**
 * FDC nutrient ids. Energy is listed in preference order: Foundation entries often carry
 * only the Atwater-derived values, SR Legacy carries id 1008.
 */
const ENERGY_IDS = ['1008', '2047', '2048'];
/** Listed in the order `Macros` declares them, which is the order they are written out. */
const MACRO_IDS = [
  ['1003', 'protein'],
  ['1005', 'carbs'],
  ['1004', 'fat']
];
const NUTRIENT_IDS = new Set([...ENERGY_IDS, ...MACRO_IDS.map(([id]) => id)]);

const ATTRIBUTION =
  'Dane o wartościach odżywczych: U.S. Department of Agriculture, Agricultural Research ' +
  'Service, FoodData Central (fdc.nal.usda.gov). Domena publiczna (CC0).';

/**
 * Macros keep two decimals: enough for a per-100 g figure, and identical on every machine.
 *
 * Clamped at zero because "carbohydrate, by difference" is exactly that — a subtraction —
 * and lands slightly negative for very fatty cuts (pork belly comes out at -0.7 g). Letting
 * that through would make a recipe's carbohydrates fall when bacon is added to it.
 */
function round2(value) {
  return Math.max(0, Math.round(value * 100) / 100);
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/** Read the curated mapping. Comments start with `#`; blank lines are skipped. */
async function readMapping() {
  const text = await readFile(MAPPING_FILE, 'utf8');
  const entries = new Map();

  text.split('\n').forEach((rawLine, index) => {
    const line = rawLine.replace(/\r$/, '');
    if (line.trim() === '' || line.trimStart().startsWith('#')) return;

    const where = `${path.relative(ROOT, MAPPING_FILE)}:${index + 1}`;
    const columns = line.split('\t');
    if (columns.length !== 4) {
      throw new Error(`${where}: expected 4 tab-separated columns, got ${columns.length}`);
    }

    const [fdcId, name, aliasField, state] = columns.map((column) => column.trim());
    if (!/^\d+$/.test(fdcId)) throw new Error(`${where}: fdcId must be digits, got "${fdcId}"`);
    if (name === '') throw new Error(`${where}: name is empty`);
    if (state !== 'raw' && state !== 'cooked') throw new Error(`${where}: bad state "${state}"`);
    if (entries.has(fdcId)) throw new Error(`${where}: fdcId ${fdcId} is already mapped`);

    const aliases = aliasField
      .split('|')
      .map((alias) => alias.trim())
      .filter((alias) => alias !== '');

    entries.set(fdcId, { fdcId, name, aliases, state });
  });

  return entries;
}

/** Fetch an archive into the cache, or reuse it. Either way, verify the digest. */
async function ensureArchive(dataset, { offline }) {
  await mkdir(CACHE_DIR, { recursive: true });
  const target = path.join(CACHE_DIR, dataset.file);

  if (!existsSync(target)) {
    if (offline) throw new Error(`${dataset.file} is not cached and --offline was given`);
    process.stderr.write(`downloading ${dataset.url}\n`);
    const response = await fetch(dataset.url);
    if (!response.ok) throw new Error(`${dataset.url} -> HTTP ${response.status}`);
    await writeFile(target, Buffer.from(await response.arrayBuffer()));
  }

  const buffer = await readFile(target);
  const digest = sha256(buffer);
  if (digest !== dataset.sha256) {
    throw new Error(
      `${dataset.file}: SHA-256 mismatch\n  expected ${dataset.sha256}\n  actual   ${digest}\n` +
        'The pinned release changed under us. Delete the file to re-download, or update ' +
        'the digest in this script deliberately.'
    );
  }
  return buffer;
}

/**
 * Pull the four macros for the wanted fdcIds out of one archive.
 * @returns {Map<string, {kcal: number, protein: number, carbs: number, fat: number}>}
 */
function extractMacros(archive, wanted) {
  const index = readZipIndex(archive);
  const decoder = new TextDecoder('utf-8');

  const found = new Map();
  parseCsv(decoder.decode(readZipMemberByBaseName(archive, index, 'food.csv')), (row) => {
    if (wanted.has(row.fdc_id)) found.set(row.fdc_id, {});
  });

  parseCsv(decoder.decode(readZipMemberByBaseName(archive, index, 'food_nutrient.csv')), (row) => {
    const amounts = found.get(row.fdc_id);
    if (amounts === undefined || !NUTRIENT_IDS.has(row.nutrient_id)) return;
    if (row.amount === '') return;
    amounts[row.nutrient_id] = Number(row.amount);
  });

  const macros = new Map();
  for (const [fdcId, amounts] of found) {
    const energyId = ENERGY_IDS.find((id) => amounts[id] !== undefined);
    if (energyId === undefined) continue;

    const values = { kcal: round2(amounts[energyId]) };
    let complete = true;
    for (const [nutrientId, key] of MACRO_IDS) {
      if (amounts[nutrientId] === undefined) complete = false;
      else values[key] = round2(amounts[nutrientId]);
    }
    if (complete) macros.set(fdcId, values);
  }
  return macros;
}

/**
 * Serialize with one ingredient per line. Deliberately hand-rolled rather than
 * `JSON.stringify(value, null, 2)`: the file is committed, and a one-line-per-row diff is
 * readable, while a fully indented one would be eight times longer for no gain.
 */
function serialize(document) {
  const lines = document.ingredients.map((ingredient) => `    ${JSON.stringify(ingredient)}`);
  return (
    '{\n' +
    `  "dataVersion": ${JSON.stringify(document.dataVersion)},\n` +
    `  "sources": ${JSON.stringify(document.sources)},\n` +
    `  "attribution": ${JSON.stringify(document.attribution)},\n` +
    '  "ingredients": [\n' +
    lines.join(',\n') +
    '\n  ]\n}\n'
  );
}

/**
 * The companion TypeScript constants. Generated rather than hand-kept in sync: the app has
 * to know the data version before it decides whether to fetch the JSON at all, and a
 * constant that drifts from the file it guards would re-import (or fail to) silently.
 */
function serializeMeta(document, count) {
  return `/**
 * GENERATED by scripts/build-nutrition.mjs — do not edit.
 *
 * Companion constants for ./ingredients.json, so the first-run import can decide whether
 * it needs the file before fetching it.
 */

/** Bumped whenever the bundled data changes; IndexedDB stores the value it imported. */
export const NUTRITION_DATA_VERSION = ${document.dataVersion};

/** How many ingredients the bundle holds. */
export const NUTRITION_INGREDIENT_COUNT = ${count};

/** The pinned USDA FoodData Central releases the bundle was built from. */
export const NUTRITION_SOURCES = ${JSON.stringify(document.sources)} as const;

/** Polish attribution shown on the credits screen. FDC is CC0; attribution is requested. */
export const NUTRITION_ATTRIBUTION =
  ${JSON.stringify(document.attribution)};
`;
}

async function main() {
  const check = process.argv.includes('--check');
  const offline = process.argv.includes('--offline');

  const mapping = await readMapping();
  const wanted = new Set(mapping.keys());

  /** fdcId -> macros, plus which dataset it came from, so a double match can be reported. */
  const macros = new Map();
  const origin = new Map();

  for (const dataset of DATASETS) {
    const archive = await ensureArchive(dataset, { offline });
    for (const [fdcId, values] of extractMacros(archive, wanted)) {
      if (macros.has(fdcId)) {
        throw new Error(`fdcId ${fdcId} appears in both ${origin.get(fdcId)} and ${dataset.id}`);
      }
      macros.set(fdcId, values);
      origin.set(fdcId, dataset.id);
    }
  }

  const missing = [...wanted].filter((fdcId) => !macros.has(fdcId));
  if (missing.length > 0) {
    throw new Error(
      `${missing.length} mapped fdcId(s) have no complete macros in the pinned releases: ` +
        missing.slice(0, 20).join(', ')
    );
  }

  // Numeric fdcId order, so the file's row order never depends on the mapping's layout.
  const ingredients = [...mapping.values()]
    .sort((a, b) => Number(a.fdcId) - Number(b.fdcId))
    .map((entry) => ({
      id: `usda:${entry.fdcId}`,
      name: entry.name,
      aliases: entry.aliases,
      state: entry.state,
      per100g: macros.get(entry.fdcId),
      source: 'usda'
    }));

  const document = {
    dataVersion: DATA_VERSION,
    sources: DATASETS.map((dataset) => dataset.id),
    attribution: ATTRIBUTION,
    ingredients
  };

  const files = [
    [OUTPUT_FILE, serialize(document)],
    [META_FILE, serializeMeta(document, ingredients.length)]
  ];

  const bytes = Buffer.byteLength(files[0][1]);
  const stale = [];
  for (const [file, content] of files) {
    const previous = existsSync(file) ? await readFile(file, 'utf8') : null;
    if (previous !== content) stale.push(file);
  }

  if (check) {
    if (stale.length > 0) {
      throw new Error(
        `stale, re-run without --check: ${stale.map((f) => path.relative(ROOT, f)).join(', ')}`
      );
    }
    process.stdout.write(`up to date: ${ingredients.length} ingredients, ${bytes} bytes\n`);
    return;
  }

  for (const [file, content] of files) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content, 'utf8');
  }
  process.stdout.write(
    `${stale.length === 0 ? 'unchanged' : 'wrote'}: ${ingredients.length} ingredients, ` +
      `${bytes} bytes in ${path.relative(ROOT, OUTPUT_FILE)}\n`
  );
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
