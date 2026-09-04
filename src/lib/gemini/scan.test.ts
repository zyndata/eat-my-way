import { describe, expect, it } from 'vitest';
import { emptyIngredientDraft, draftProblem } from '../custom-ingredients';
import {
  LABEL_SCHEMA,
  SCAN_SYSTEM,
  applyScannedLabel,
  labelIsEmpty,
  readScannedLabel
} from './scan';

/**
 * The reader is where „a scan never invents a number" is actually enforced. The prompt asks
 * for the right column, the right unit and a `null` it cannot read; these tests assume it is
 * sometimes ignored, which is the only safe assumption to make about a model.
 */

describe('readScannedLabel', () => {
  it('takes the four macros and the name as sent', () => {
    expect(
      readScannedLabel({ name: '  Masło extra  ', kcal: 735, protein: 0.7, carbs: 0.8, fat: 82 })
    ).toEqual({ name: 'Masło extra', kcal: 735, protein: 0.7, carbs: 0.8, fat: 82 });
  });

  it('maps a value it could not read to null, never to 0', () => {
    const label = readScannedLabel({ name: 'Płatki', kcal: 379, protein: null, carbs: 84, fat: 2 });
    expect(label.protein).toBeNull();
    // The whole point of decision 178, restated: `null` is not `0`.
    expect(label.protein).not.toBe(0);
  });

  it('keeps a printed zero, because 0 on a label is a value', () => {
    expect(readScannedLabel({ kcal: 0, protein: 0, carbs: 0, fat: 0 })).toEqual({
      name: '',
      kcal: 0,
      protein: 0,
      carbs: 0,
      fat: 0
    });
  });

  it('reads a string where a number belongs, comma included', () => {
    const label = readScannedLabel({ kcal: '539', protein: '12,5', carbs: '1,0', fat: '0,5' });
    expect(label).toMatchObject({ kcal: 539, protein: 12.5, carbs: 1, fat: 0.5 });
  });

  it('resolves „<0,5" and a range to the number a person would write', () => {
    expect(readScannedLabel({ fat: '<0,5' }).fat).toBe(0.5);
    expect(readScannedLabel({ carbs: '10-12 g' }).carbs).toBe(10);
  });

  it('rejects anything that is not a usable number', () => {
    for (const value of ['brak', '', {}, [], true, Number.NaN, Infinity, -3]) {
      expect(readScannedLabel({ kcal: value }).kcal).toBeNull();
    }
  });

  it('survives an answer that is not an object at all', () => {
    for (const answer of [null, undefined, 'nie wiem', 42]) {
      expect(labelIsEmpty(readScannedLabel(answer))).toBe(true);
    }
  });

  it('ignores fields the schema does not ask for, including a nested sub-entry', () => {
    const label = readScannedLabel({
      name: 'Jogurt',
      kcal: 61,
      protein: 3.5,
      carbs: 4.7,
      // „w tym cukry" is a sub-entry of carbohydrates, not a macro; it must not become one.
      sugars: 4.7,
      fat: 3.2,
      saturated: 2.1,
      per_portion: { kcal: 110 }
    });
    expect(label).toEqual({ name: 'Jogurt', kcal: 61, protein: 3.5, carbs: 4.7, fat: 3.2 });
  });
});

describe('the prompt and the schema', () => {
  it('asks for the 100 g column, kcal over kJ, and null over zero', () => {
    expect(SCAN_SYSTEM).toContain('w 100 g');
    expect(SCAN_SYSTEM).toContain('kcal');
    expect(SCAN_SYSTEM).toContain('NIGDY nie wpisuj 0');
  });

  it('has no field for `state` — raw versus cooked is not printed on a label', () => {
    expect(Object.keys(LABEL_SCHEMA.properties ?? {})).toEqual([
      'name',
      'kcal',
      'protein',
      'carbs',
      'fat'
    ]);
  });
});

describe('applyScannedLabel', () => {
  const label = { name: 'Masło extra', kcal: 735, protein: 0.7, carbs: 0.8, fat: 82 };

  it('fills an empty draft and reports what it filled', () => {
    const { draft, filled } = applyScannedLabel(emptyIngredientDraft(), label);
    expect(draft).toMatchObject({ name: 'Masło extra', kcal: 735, protein: 0.7, fat: 82 });
    expect(filled).toEqual(['name', 'kcal', 'protein', 'carbs', 'fat']);
    // Filled completely, so the ordinary save becomes possible — nothing else changed.
    expect(draftProblem(draft)).toBeNull();
    expect(draft.state).toBe('raw');
  });

  it('leaves a field the scan could not read empty, and the save disabled', () => {
    const partial = { ...label, protein: null };
    const { draft, filled } = applyScannedLabel(emptyIngredientDraft(), partial);
    expect(draft.protein).toBeNull();
    expect(filled).not.toContain('protein');
    expect(draftProblem(draft)).toBe(
      'Podaj wszystkie wartości na 100 g. Jeśli składnik czegoś nie zawiera, wpisz 0.'
    );
  });

  it('never overwrites a field the user edited by hand', () => {
    const edited = { ...emptyIngredientDraft('Moje masło'), kcal: 700 };
    const { draft, filled } = applyScannedLabel(edited, label, { name: true, kcal: true });
    expect(draft.name).toBe('Moje masło');
    expect(draft.kcal).toBe(700);
    expect(filled).toEqual(['protein', 'carbs', 'fat']);
  });

  it('replaces its own earlier proposal on a second scan', () => {
    const first = applyScannedLabel(emptyIngredientDraft(), { ...label, kcal: 700 });
    const second = applyScannedLabel(first.draft, label);
    expect(second.draft.kcal).toBe(735);
  });

  it('does not blank a filled field when the second scan reads nothing there', () => {
    const first = applyScannedLabel(emptyIngredientDraft(), label);
    const second = applyScannedLabel(first.draft, {
      name: '',
      kcal: null,
      protein: null,
      carbs: null,
      fat: null
    });
    expect(second.draft).toEqual(first.draft);
    expect(second.filled).toEqual([]);
  });
});
