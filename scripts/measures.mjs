/**
 * The closed household-measure vocabulary, and the parser for the TSV's measure column.
 *
 * A second home for a list that already lives in `src/lib/text.ts`. The build script is
 * `.mjs` and cannot import a `.ts` module; `build-nutrition.mjs` calls `main()` at import
 * time and so cannot be imported by a test either. Hence a small module of its own beside
 * `csv.mjs` and `usda-zip.mjs`, with `src/lib/nutrition/measures.test.ts` importing both this
 * and `text.ts` and failing the moment the two lists drift (STATE.md decision 350).
 *
 * Keep this list byte-identical to `MEASURE_NAMES` in `src/lib/text.ts`, in the same order.
 */
export const MEASURE_NAMES = [
  'szt.',
  'mała szt.',
  'średnia szt.',
  'duża szt.',
  'ząbek',
  'kromka',
  'plaster',
  'garść',
  'łyżka',
  'łyżeczka',
  'szklanka',
  'kubek',
  'pęczek',
  'gałązka',
  'opakowanie',
  'porcja'
];

/**
 * Parse the TSV's measure column: `nazwa:gramy` pairs separated by `|`, e.g.
 * `ząbek:5|duża szt.:16`. An empty field means the row offers no measure, which is the normal
 * case — measures are filled in for the subset where a piece means something (decision 326).
 *
 * Everything invalid throws, so an unknown name or a weight of zero fails the build rather
 * than reaching the app (PLAN.md Phase 16 task 2).
 *
 * @param {string} field the raw column
 * @param {string} where `file:line`, for the message
 * @returns {{name: string, grams: number}[]}
 */
export function parseMeasures(field, where) {
  if (field.trim() === '') return [];

  const measures = [];
  const seen = new Set();

  for (const pair of field.split('|')) {
    if (pair.trim() === '') continue;
    // `lastIndexOf`, not `split`: no name holds a colon today, and a name that one day does
    // must fail as an unknown name rather than be silently cut in half.
    const colon = pair.lastIndexOf(':');
    if (colon === -1) throw new Error(`${where}: measure "${pair}" is not "nazwa:gramy"`);

    const name = pair.slice(0, colon).trim();
    const grams = Number(pair.slice(colon + 1).trim());

    if (!MEASURE_NAMES.includes(name)) {
      throw new Error(`${where}: unknown measure name "${name}"`);
    }
    if (!Number.isFinite(grams) || grams <= 0) {
      throw new Error(`${where}: measure "${name}" must weigh more than 0 g, got "${grams}"`);
    }
    if (seen.has(name)) throw new Error(`${where}: measure "${name}" is listed twice`);

    seen.add(name);
    // Two decimals, like every other number the bundle carries, so the output stays a pure
    // function of the inputs on every machine.
    measures.push({ name, grams: Math.round(grams * 100) / 100 });
  }

  return measures;
}
