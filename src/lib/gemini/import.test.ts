import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EatMyWayDb } from '../db';
import { createRepository, type Repository } from '../repository';
import { createIngredientIndex, type IngredientIndex } from '../ingredients';
import { at, chicken, egg, freshDb, ingredients, oil, seqIds } from '../../test/fixtures';
import type { Ingredient } from '../types';
import { GeminiError } from './client';
import { importRecipe, rememberCorrection, type ImportedRecipe } from './import';

/**
 * The import, end to end, against a fake Gemini and a real (in-memory) database.
 *
 * The fake dispatches on the system instruction, which is what actually distinguishes the
 * three calls the import can make: read a page, parse a recipe, pick ingredient ids.
 */

interface Call {
  url: string;
  key: string | null;
  system: string;
  prompt: string;
  tools: unknown;
}

interface Canned {
  /** Answer to the `url_context` call. */
  page?: string;
  /** Answer to the parse call. */
  recipe?: unknown;
  /** Answer to the id-picking call. */
  matches?: unknown;
  /** When set, every call fails with this HTTP status instead. */
  status?: number;
  /** `totalTokenCount` to report on each answered call. */
  tokens?: number;
}

function fakeGemini(canned: Canned) {
  const calls: Call[] = [];

  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    const body = JSON.parse(String(init.body ?? '{}')) as {
      systemInstruction?: { parts?: { text?: string }[] };
      contents?: { parts?: { text?: string }[] }[];
      tools?: unknown;
    };
    const system = body.systemInstruction?.parts?.[0]?.text ?? '';
    calls.push({
      url: String(input),
      key: headers.get('x-goog-api-key'),
      system,
      prompt: body.contents?.[0]?.parts?.[0]?.text ?? '',
      tools: body.tools
    });

    if (canned.status !== undefined) {
      return new Response(JSON.stringify({ error: { message: 'nope' } }), {
        status: canned.status
      });
    }

    const text = system.startsWith('Otwórz podany adres')
      ? (canned.page ?? '')
      : system.startsWith('Dopasowujesz')
        ? JSON.stringify(canned.matches ?? { matches: [] })
        : JSON.stringify(canned.recipe ?? {});

    return new Response(
      JSON.stringify({
        candidates: [{ content: { parts: [{ text }] } }],
        ...(canned.tokens === undefined ? {} : { usageMetadata: { totalTokenCount: canned.tokens } })
      })
    );
  }) as typeof fetch;

  return { calls, fetchImpl };
}

/** Await an import that is expected to fail and hand back the `GeminiError` it threw. */
async function failure(run: Promise<unknown>): Promise<GeminiError> {
  try {
    await run;
  } catch (caught) {
    if (caught instanceof GeminiError) return caught;
    throw caught;
  }
  throw new Error('the import was expected to fail and did not');
}

/** „Naleśniki" as a page would write it, with the fat given as a household measure. */
const PANCAKES_TEXT = [
  'Naleśniki na 2 porcje',
  '2 jajka',
  '200 g mąki pszennej',
  'oliwa do smażenia',
  'Wymieszaj i usmaż.'
].join('\n');

/** What a model returns for it: fats quantified, units normalized, no nutrition numbers. */
const PANCAKES_JSON = {
  name: 'Naleśniki',
  portions: 2,
  instructions: 'Wymieszaj i usmaż.',
  ingredients: [
    { name: 'Jajko', amount: 2, unit: 'szt', state: 'raw', gramsPerUnit: 55 },
    { name: 'mąka pszenna', amount: 200, unit: 'g', state: 'raw' },
    { name: 'oliwa do smażenia', amount: 20, unit: 'g', state: 'raw' }
  ]
};

/** The model picks the olive oil out of the list it was offered. */
const PANCAKES_MATCHES = {
  matches: [
    { name: 'mąka pszenna', id: null },
    { name: 'oliwa do smażenia', id: oil.id }
  ]
};

let db: EatMyWayDb;
let repo: Repository;
let index: IngredientIndex;

/** Row keys are compared across runs, so they restart at 1 for every import. */
const deps = (fetchImpl: typeof fetch, model = 'gemini-2.5-flash') => ({
  apiKey: 'AIza-secret',
  model,
  index,
  repository: repo,
  fetchImpl,
  nextId: seqIds('row')
});

beforeEach(async () => {
  db = freshDb();
  await db.open();
  repo = createRepository(db);
  index = createIngredientIndex(repo);
  await repo.putIngredients(ingredients);
});

afterEach(async () => {
  db.close();
  await db.delete();
});

describe('importing pasted text', () => {
  it('produces a draft with matched ingredients, amounts, units and a quantified fat', async () => {
    const { fetchImpl } = fakeGemini({ recipe: PANCAKES_JSON, matches: PANCAKES_MATCHES });

    const result = await importRecipe(PANCAKES_TEXT, deps(fetchImpl));

    expect(result.name).toBe('Naleśniki');
    expect(result.instructions).toBe('Wymieszaj i usmaż.');
    expect(result.sourcePortions).toBe(2);
    expect(result.items).toEqual([
      // Halved, because the page described two portions and a recipe stores one.
      {
        id: 'row-1',
        ingredientId: egg.id,
        amount: 1,
        unit: 'szt',
        gramsPerUnit: 55,
        macroOverride: null,
        sourceName: 'Jajko'
      },
      {
        id: 'row-2',
        ingredientId: '',
        amount: 100,
        unit: 'g',
        gramsPerUnit: null,
        macroOverride: null,
        sourceName: 'mąka pszenna'
      },
      {
        id: 'row-3',
        // „oliwa do smażenia" is not in the database under that name; the model picked it.
        ingredientId: oil.id,
        amount: 10,
        unit: 'g',
        gramsPerUnit: null,
        macroOverride: null,
        sourceName: 'oliwa do smażenia'
      }
    ]);
    expect(result.unmatched).toBe(1);
  });

  it('carries no nutrition value of its own — the ingredients come from the local database', async () => {
    const { fetchImpl } = fakeGemini({
      // A model that ignores the rule and returns macros anyway.
      recipe: {
        ...PANCAKES_JSON,
        kcal: 980,
        ingredients: PANCAKES_JSON.ingredients.map((row) => ({ ...row, kcal: 123, fat: 9 }))
      },
      matches: PANCAKES_MATCHES
    });

    const result = await importRecipe(PANCAKES_TEXT, deps(fetchImpl));

    expect(JSON.stringify(result.items)).not.toContain('123');
    expect(JSON.stringify(result.items)).not.toContain('980');
    // The only macros in the result are the ones read out of IndexedDB.
    expect(result.ingredientsById[oil.id]?.per100g).toEqual(oil.per100g);
  });

  it('yields an identical draft when the same text is imported twice', async () => {
    const first = await importRecipe(
      PANCAKES_TEXT,
      deps(fakeGemini({ recipe: PANCAKES_JSON, matches: PANCAKES_MATCHES }).fetchImpl)
    );
    const second = await importRecipe(
      PANCAKES_TEXT,
      deps(fakeGemini({ recipe: PANCAKES_JSON, matches: PANCAKES_MATCHES }).fetchImpl)
    );

    expect(second).toEqual(first);
  });

  it('uses the model named in the profile, whatever it is', async () => {
    const { calls, fetchImpl } = fakeGemini({ recipe: PANCAKES_JSON, matches: PANCAKES_MATCHES });

    await importRecipe(PANCAKES_TEXT, deps(fetchImpl, 'gemini-9.9-imaginary'));

    expect(calls).not.toHaveLength(0);
    for (const call of calls) {
      expect(call.url).toContain('/models/gemini-9.9-imaginary:generateContent');
    }
  });

  it('refuses an empty input without calling out', async () => {
    const { calls, fetchImpl } = fakeGemini({});
    await expect(importRecipe('   ', deps(fetchImpl))).rejects.toBeInstanceOf(GeminiError);
    expect(calls).toEqual([]);
  });

  it('does not call out at all when the vault holds no key', async () => {
    const { calls, fetchImpl } = fakeGemini({ recipe: PANCAKES_JSON });

    const error = await failure(importRecipe(PANCAKES_TEXT, { ...deps(fetchImpl), apiKey: '' }));

    expect(error.kind).toBe('no-key');
    expect(calls).toEqual([]);
  });

  it('says so when the text held no ingredients at all', async () => {
    const { fetchImpl } = fakeGemini({
      recipe: { name: '', portions: 1, instructions: '', ingredients: [] }
    });

    const error = await failure(importRecipe('lorem ipsum', deps(fetchImpl)));

    expect(error.message).toContain('składników');
  });
});

describe('what the user is told while it runs', () => {
  it('reports each stage in the order it happens', async () => {
    const stages: string[] = [];
    const { fetchImpl } = fakeGemini({
      page: PANCAKES_TEXT,
      recipe: PANCAKES_JSON,
      matches: PANCAKES_MATCHES
    });

    await importRecipe('https://example.com/nalesniki', {
      ...deps(fetchImpl),
      onstage: (stage) => stages.push(stage)
    });

    expect(stages).toEqual(['reading-page', 'parsing', 'matching']);
  });

  it('skips the retrieval stage for pasted text', async () => {
    const stages: string[] = [];
    const { fetchImpl } = fakeGemini({ recipe: PANCAKES_JSON, matches: PANCAKES_MATCHES });

    await importRecipe(PANCAKES_TEXT, {
      ...deps(fetchImpl),
      onstage: (stage) => stages.push(stage)
    });

    expect(stages).toEqual(['parsing', 'matching']);
  });
});

describe('what an import spends', () => {
  it('reports one request per answered call, with the tokens Google charged', async () => {
    const spent: { requests: number; tokens: number }[] = [];
    const { fetchImpl } = fakeGemini({
      page: PANCAKES_TEXT,
      recipe: PANCAKES_JSON,
      matches: PANCAKES_MATCHES,
      tokens: 120
    });

    await importRecipe('https://example.com/nalesniki', {
      ...deps(fetchImpl),
      onusage: (usage) => spent.push(usage)
    });

    // Retrieval, parse, match — a link import is three, which is what makes the free tier's
    // 20 a day work out to about six link imports.
    expect(spent).toEqual([{ requests: 3, tokens: 360 }]);
  });

  it('charges a paste two requests, not three', async () => {
    const spent: { requests: number; tokens: number }[] = [];
    const { fetchImpl } = fakeGemini({
      recipe: PANCAKES_JSON,
      matches: PANCAKES_MATCHES,
      tokens: 50
    });

    await importRecipe(PANCAKES_TEXT, { ...deps(fetchImpl), onusage: (usage) => spent.push(usage) });

    expect(spent).toEqual([{ requests: 2, tokens: 100 }]);
  });

  it('still reports what a failed import already paid for', async () => {
    const spent: { requests: number; tokens: number }[] = [];
    // The page is read, then the parse comes back with nothing usable.
    const { fetchImpl } = fakeGemini({
      page: PANCAKES_TEXT,
      recipe: { name: '', portions: 1, instructions: '', ingredients: [] },
      tokens: 80
    });

    await importRecipe('https://example.com/nalesniki', {
      ...deps(fetchImpl),
      onusage: (usage) => spent.push(usage)
    }).catch(() => undefined);

    // Two calls were answered before it gave up; both cost quota.
    expect(spent).toEqual([{ requests: 2, tokens: 160 }]);
  });

  it('reports nothing when no request ever reached Google', async () => {
    const spent: unknown[] = [];
    const { fetchImpl } = fakeGemini({ status: 403 });

    await importRecipe(PANCAKES_TEXT, {
      ...deps(fetchImpl),
      onusage: (usage) => spent.push(usage)
    }).catch(() => undefined);

    expect(spent).toEqual([]);
  });
});

describe('importing a link', () => {
  it('reads the page on Gemini’s side and then imports it exactly like pasted text', async () => {
    const viaLink = fakeGemini({
      page: PANCAKES_TEXT,
      recipe: PANCAKES_JSON,
      matches: PANCAKES_MATCHES
    });
    const viaText = fakeGemini({ recipe: PANCAKES_JSON, matches: PANCAKES_MATCHES });

    const linked = await importRecipe(
      'https://example.com/nalesniki',
      deps(viaLink.fetchImpl)
    );
    const pasted = await importRecipe(PANCAKES_TEXT, deps(viaText.fetchImpl));

    expect(linked).toEqual(pasted);

    // The retrieval call is the only one carrying the tool, and the parse call that follows
    // it was given the page's text — which is why the two drafts are the same by construction.
    expect(at(viaLink.calls, 0).tools).toEqual([{ url_context: {} }]);
    expect(at(viaLink.calls, 0).prompt).toContain('https://example.com/nalesniki');
    expect(at(viaLink.calls, 1).tools).toBeUndefined();
    expect(at(viaLink.calls, 1).prompt).toContain(PANCAKES_TEXT);
  });

  it('adds the scheme a user leaves off', async () => {
    const { calls, fetchImpl } = fakeGemini({
      page: PANCAKES_TEXT,
      recipe: PANCAKES_JSON,
      matches: PANCAKES_MATCHES
    });

    await importRecipe('example.com/nalesniki', deps(fetchImpl));

    expect(at(calls).prompt).toContain('https://example.com/nalesniki');
  });

  it('points at pasting the text when the page cannot be read', async () => {
    const { calls, fetchImpl } = fakeGemini({ page: 'BRAK_PRZEPISU' });

    const error = await failure(importRecipe('https://example.com/za-loginem', deps(fetchImpl)));

    expect(error.message).toContain('wklej');
    // It stopped at the retrieval call rather than parsing a refusal into an empty recipe.
    expect(calls).toHaveLength(1);
  });
});

describe('corrections', () => {
  it('makes the next import of the same name match without asking the model', async () => {
    const before = fakeGemini({ recipe: PANCAKES_JSON, matches: { matches: [] } });
    const first = await importRecipe(PANCAKES_TEXT, deps(before.fetchImpl));
    expect(at(first.items, 1).ingredientId).toBe('');

    // What the editor does when the user picks an ingredient on an imported row.
    await rememberCorrection('mąka pszenna', chicken.id, repo);

    const after = fakeGemini({ recipe: PANCAKES_JSON, matches: { matches: [] } });
    const second = await importRecipe(PANCAKES_TEXT, deps(after.fetchImpl));

    expect(at(second.items, 1).ingredientId).toBe(chicken.id);
    // The corrected name is not even sent: it is settled before the request is built.
    const matchCall = after.calls.find((call) => call.system.startsWith('Dopasowujesz'));
    expect(matchCall?.prompt ?? '').not.toContain('mąka pszenna');
  });

  it('recognises a custom ingredient the user added for an unmatched row', async () => {
    // The real case from a live import: „ryż jaśminowy" is a varietal the bundled USDA subset
    // does not carry, so the model is offered candidates and declines.
    const RICE = {
      ...PANCAKES_JSON,
      ingredients: [{ name: 'ryż jaśminowy', amount: 200, unit: 'g', state: 'raw' }]
    };

    const first = fakeGemini({ recipe: RICE, matches: { matches: [{ name: 'ryż jaśminowy', id: null }] } });
    const before = await importRecipe(PANCAKES_TEXT, deps(first.fetchImpl));
    expect(at(before.items).ingredientId).toBe('');
    expect(at(before.items).sourceName).toBe('ryż jaśminowy');

    // Exactly what the editor does when the user fills that row with a hand-written
    // ingredient: store it, then record the correction against the name the model produced.
    const custom: Ingredient = {
      id: 'custom:rice-1',
      name: 'Ryż jaśminowy',
      aliases: [],
      state: 'raw',
      per100g: { kcal: 356, protein: 6.7, carbs: 79, fat: 0.6 },
      source: 'custom'
    };
    await repo.putIngredient(custom);
    index.invalidate();
    await rememberCorrection(at(before.items).sourceName ?? '', custom.id, repo);

    const second = fakeGemini({ recipe: RICE, matches: { matches: [] } });
    const after = await importRecipe(PANCAKES_TEXT, deps(second.fetchImpl));

    expect(at(after.items).ingredientId).toBe(custom.id);
    expect(after.ingredientsById[custom.id]?.name).toBe('Ryż jaśminowy');
    expect(after.unmatched).toBe(0);
    // Settled locally — the model was never asked about it again.
    expect(second.calls.some((call) => call.system.startsWith('Dopasowujesz'))).toBe(false);
  });

  it('finds a custom ingredient by name even with no correction stored', async () => {
    // The second safety net: a custom row whose name matches exactly is an `exact` hit, so a
    // correction is not the only thing holding this together.
    const custom: Ingredient = {
      id: 'custom:rice-2',
      name: 'Ryż jaśminowy',
      aliases: [],
      state: 'raw',
      per100g: { kcal: 356, protein: 6.7, carbs: 79, fat: 0.6 },
      source: 'custom'
    };
    await repo.putIngredient(custom);
    index.invalidate();

    const run = fakeGemini({
      recipe: { ...PANCAKES_JSON, ingredients: [{ name: 'ryż jaśminowy', amount: 200, unit: 'g', state: 'raw' }] },
      matches: { matches: [] }
    });
    const result = await importRecipe(PANCAKES_TEXT, deps(run.fetchImpl));

    expect(at(result.items).ingredientId).toBe(custom.id);
    expect(run.calls.some((call) => call.system.startsWith('Dopasowujesz'))).toBe(false);
  });

  it('misses when the model names the same ingredient differently next time', async () => {
    // The honest limit of a correction: it is keyed on the name the model produced, and the
    // model does not name things identically every run (STATE.md open question 21).
    // A rice row has to exist, or the drifted name would find no candidates at all and the
    // test would pass for the wrong reason.
    await repo.putIngredient({
      id: 'usda:rice',
      name: 'Ryż biały',
      aliases: [],
      state: 'raw',
      per100g: { kcal: 360, protein: 7, carbs: 79, fat: 0.6 },
      source: 'usda'
    });
    index.invalidate();
    await rememberCorrection('ryż jaśminowy', 'usda:rice', repo);

    const drifted = fakeGemini({
      recipe: { ...PANCAKES_JSON, ingredients: [{ name: 'ryż jaśminowy do sushi', amount: 200, unit: 'g', state: 'raw' }] },
      matches: { matches: [] }
    });
    const result = await importRecipe(PANCAKES_TEXT, deps(drifted.fetchImpl));

    // The stored correction does not cover the new spelling, so the row is offered to the
    // model — and lands empty when it declines, rather than silently taking the wrong id.
    expect(at(result.items).ingredientId).toBe('');
    expect(drifted.calls.some((call) => call.system.startsWith('Dopasowujesz'))).toBe(true);
  });

  it('stores the correction under the normalized name', async () => {
    await rememberCorrection('  Mąka   PSZENNA ', chicken.id, repo);
    expect(await repo.allCorrections()).toEqual([
      { nameKey: 'maka pszenna', ingredientId: chicken.id, updatedAt: expect.any(String) }
    ]);
  });

  it('ignores a correction with nothing to store', async () => {
    await rememberCorrection('   ', chicken.id, repo);
    await rememberCorrection('mąka', '', repo);
    expect(await repo.allCorrections()).toEqual([]);
  });
});

describe('a key the API refuses', () => {
  it('fails with a Polish sentence that does not contain the key', async () => {
    const { fetchImpl } = fakeGemini({ status: 403 });

    const error = await failure(importRecipe(PANCAKES_TEXT, deps(fetchImpl)));

    expect(error.kind).toBe('rejected');
    expect(error.message).not.toContain('AIza-secret');
    expect(error.message).toContain('Ustawieniach');
  });

  it('never puts the key anywhere but the header', async () => {
    const { calls, fetchImpl } = fakeGemini({
      page: PANCAKES_TEXT,
      recipe: PANCAKES_JSON,
      matches: PANCAKES_MATCHES
    });

    await importRecipe('https://example.com/nalesniki', deps(fetchImpl));

    for (const call of calls) {
      expect(call.key).toBe('AIza-secret');
      expect(call.url).not.toContain('AIza-secret');
      expect(call.prompt).not.toContain('AIza-secret');
      expect(call.system).not.toContain('AIza-secret');
    }
  });
});

describe('what the import returns to the editor', () => {
  it('hands back the ingredients it matched, so the editor need not re-read them', async () => {
    const { fetchImpl } = fakeGemini({ recipe: PANCAKES_JSON, matches: PANCAKES_MATCHES });

    const result: ImportedRecipe = await importRecipe(PANCAKES_TEXT, deps(fetchImpl));

    expect(Object.keys(result.ingredientsById).sort()).toEqual([egg.id, oil.id].sort());
  });

  it('writes nothing — the editor’s save is still the only path to storage', async () => {
    const { fetchImpl } = fakeGemini({ recipe: PANCAKES_JSON, matches: PANCAKES_MATCHES });

    await importRecipe(PANCAKES_TEXT, deps(fetchImpl));

    expect(await repo.allRecipes()).toEqual([]);
  });
});
