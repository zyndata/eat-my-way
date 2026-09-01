import { describe, expect, it } from 'vitest';
import type { Ingredient } from '../types';
import type { IngredientMatch } from '../ingredients';
import { MatchTier } from '../search';
import { at, chicken, egg, oil } from '../../test/fixtures';
import {
  MATCH_SCHEMA,
  MATCH_SYSTEM,
  attachMatches,
  classifyName,
  correctionMap,
  gatherCandidates,
  matchPrompt,
  readMatchResponse,
  type MatchTarget
} from './match';

const ranked = (ingredients: Ingredient[], tier: MatchTier = MatchTier.Infix): IngredientMatch[] =>
  ingredients.map((ingredient) => ({ ingredient, useCount: 0, tier }));

const NONE = new Map<string, string>();

describe('classifyName', () => {
  it('takes a stored correction and asks nobody', () => {
    const corrections = correctionMap([
      { nameKey: 'oliwa extra vergine', ingredientId: oil.id, updatedAt: '2026-09-01T00:00:00.000Z' }
    ]);

    const outcome = classifyName('Oliwa Extra Vergine', ranked([chicken]), corrections);

    expect(outcome.resolved).toEqual({
      nameKey: 'oliwa extra vergine',
      ingredientId: oil.id,
      via: 'correction'
    });
    expect(outcome.target).toBeUndefined();
  });

  it('takes an exact name match without spending a request on it', () => {
    const outcome = classifyName('jajko', ranked([egg, chicken]), NONE);

    expect(outcome.resolved).toEqual({ nameKey: 'jajko', ingredientId: egg.id, via: 'exact' });
  });

  it('matches an exact name typed without Polish letters', () => {
    const outcome = classifyName('Oliwa z oliwek', ranked([oil]), NONE);
    expect(outcome.resolved?.ingredientId).toBe(oil.id);
  });

  it('offers the rest as a candidate list', () => {
    const outcome = classifyName('filet z kurczaka', ranked([chicken, egg]), NONE);

    expect(outcome.resolved).toBeUndefined();
    expect(outcome.target).toEqual({
      name: 'filet z kurczaka',
      nameKey: 'filet z kurczaka',
      candidates: [chicken, egg]
    });
  });

  it('caps the list at eight', () => {
    const many = ranked(
      Array.from({ length: 20 }, (_, index) => ({ ...chicken, id: `usda:${index}` }))
    );
    expect(classifyName('cokolwiek', many, NONE).target?.candidates).toHaveLength(8);
  });

  it('sends nothing when the database has no candidates at all', () => {
    expect(classifyName('kimchi', [], NONE)).toEqual({});
  });
});

describe('matchPrompt', () => {
  it('shows the model the ids it is allowed to answer with', () => {
    const prompt = matchPrompt([
      { name: 'filet z kurczaka', nameKey: 'filet z kurczaka', candidates: [chicken, egg] }
    ]);

    expect(prompt).toContain('"filet z kurczaka"');
    expect(prompt).toContain(`id: ${chicken.id}`);
    expect(prompt).toContain(`id: ${egg.id}`);
  });

  it('never shows the model a nutrition value', () => {
    const prompt = matchPrompt([
      { name: 'oliwa', nameKey: 'oliwa', candidates: [oil, chicken] }
    ]);
    expect(prompt).not.toContain('900');
    expect(prompt).not.toContain('kcal');
  });

  it('asks for the plainest form rather than a null when the forms are the same product', () => {
    // A live import returned null for „kolendra", „seler" and „bazylia" — all three present in
    // the database, but each in a fresh and a dried variant (STATE.md decision 125).
    expect(MATCH_SYSTEM).toContain('TEN SAM produkt w innej postaci');
    // …without collapsing the distinction that actually matters.
    expect(MATCH_SYSTEM).toContain('inny produkt');
  });

  it('lets the model say "none"', () => {
    expect(MATCH_SCHEMA.properties?.matches?.items?.properties?.id?.nullable).toBe(true);
  });
});

describe('readMatchResponse', () => {
  const targets: MatchTarget[] = [
    { name: 'filet z kurczaka', nameKey: 'filet z kurczaka', candidates: [chicken, egg] }
  ];

  it('accepts an id that was actually offered', () => {
    const matches = readMatchResponse(
      { matches: [{ name: 'filet z kurczaka', id: chicken.id }] },
      targets
    );
    expect(matches).toEqual([
      { nameKey: 'filet z kurczaka', ingredientId: chicken.id, via: 'model' }
    ]);
  });

  it('discards an id the model invented', () => {
    expect(
      readMatchResponse({ matches: [{ name: 'filet z kurczaka', id: 'usda:9999' }] }, targets)
    ).toEqual([]);
  });

  it('discards a null and a name nobody asked about', () => {
    expect(
      readMatchResponse(
        {
          matches: [
            { name: 'filet z kurczaka', id: null },
            { name: 'coś innego', id: chicken.id }
          ]
        },
        targets
      )
    ).toEqual([]);
  });

  it('keeps only the first answer for a name', () => {
    const matches = readMatchResponse(
      {
        matches: [
          { name: 'filet z kurczaka', id: chicken.id },
          { name: 'Filet z kurczaka', id: egg.id }
        ]
      },
      targets
    );
    expect(matches).toHaveLength(1);
    expect(at(matches).ingredientId).toBe(chicken.id);
  });

  it('survives rubbish', () => {
    expect(readMatchResponse(null, targets)).toEqual([]);
    expect(readMatchResponse({ matches: 'nope' }, targets)).toEqual([]);
  });
});

describe('attachMatches', () => {
  it('keeps the recipe order and leaves unmatched rows open', () => {
    const attached = attachMatches(
      [
        { name: 'Jajko', amount: 1, unit: 'szt', state: 'raw' },
        { name: 'kimchi', amount: 50, unit: 'g', state: 'raw' }
      ],
      [{ nameKey: 'jajko', ingredientId: egg.id, via: 'exact' }]
    );

    expect(at(attached, 0).ingredientId).toBe(egg.id);
    expect(at(attached, 1).ingredientId).toBeUndefined();
    expect(attached.map((row) => row.parsed.name)).toEqual(['Jajko', 'kimchi']);
  });
});

describe('gatherCandidates', () => {
  /** The Phase 3 ranker's rule: every query word must hit the same name. */
  const search = async (query: string): Promise<IngredientMatch[]> => {
    const words = query.toLowerCase().split(' ').filter((word) => word !== '');
    return ranked(
      [chicken, egg, oil].filter((ingredient) =>
        words.every((word) => ingredient.name.toLowerCase().includes(word))
      )
    );
  };

  it('uses the whole name when the whole name matches', async () => {
    const found = await gatherCandidates('oliwa z oliwek', search);
    expect(found.map((match) => match.ingredient.id)).toEqual([oil.id]);
  });

  it('falls back word by word for a name off a recipe page', async () => {
    // Nothing in the database contains „do" or „smażenia" — the head noun has to carry it.
    const found = await gatherCandidates('oliwa do smażenia', search);
    expect(found.map((match) => match.ingredient.id)).toEqual([oil.id]);
  });

  it('skips words too short to narrow anything down', async () => {
    const queries: string[] = [];
    await gatherCandidates('ser z do na', async (query) => {
      queries.push(query);
      return [];
    });
    expect(queries).toEqual(['ser z do na', 'ser']);
  });

  it('returns nothing when the database holds nothing like it', async () => {
    expect(await gatherCandidates('kimchi', search)).toEqual([]);
  });
});
