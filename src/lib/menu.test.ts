import { describe, expect, it } from 'vitest';
import type { Day, Macros, PlannedMeal } from './types';
import { formatMenu, formatMenuDay, formatMenuTotals, menuDays } from './menu';
import { macros } from '../test/fixtures';

/**
 * „Jadłospis" — PLAN.md Phase 18 task C. The rules are the shopping list's, applied to meals:
 * plain text, a day's own goals where it froze some, and no ingredients anywhere in it
 * (STATE.md decision 334).
 */

const GOALS: Macros = macros(2000, 130, 220, 70);

function meal(recipeId: string, snapshot: Macros, portionsEaten = 1): PlannedMeal {
  return { id: `m-${recipeId}-${portionsEaten}`, recipeId, cookingScale: 1, portionsEaten, macroSnapshot: snapshot };
}

const NAMES: Record<string, string> = { r1: 'Owsianka', r2: 'Kurczak z ryżem' };
const nameOf = (planned: PlannedMeal): string => NAMES[planned.recipeId] ?? 'Usunięty przepis';

const monday: Day = {
  date: '2026-09-07',
  meals: [meal('r1', macros(400, 15, 60, 10)), meal('r2', macros(600, 45, 50, 20), 0.5)]
};

describe('menuDays', () => {
  it('carries the meals, their portions and the day totals', () => {
    const [day] = menuDays(['2026-09-07'], [monday], GOALS, nameOf);
    expect(day?.meals).toEqual([
      { name: 'Owsianka', portionsEaten: 1 },
      { name: 'Kurczak z ryżem', portionsEaten: 0.5 }
    ]);
    // 400 + half of 600.
    expect(day?.totals.kcal).toBe(700);
    expect(day?.goals).toEqual(GOALS);
  });

  it('keeps a day with nothing on it, so a week export is a whole week', () => {
    const days = menuDays(['2026-09-07', '2026-09-08'], [monday], GOALS, nameOf);
    expect(days).toHaveLength(2);
    expect(days[1]?.meals).toEqual([]);
  });

  it('judges a day against its own frozen goals, not against today’s', () => {
    const frozen: Day = { ...monday, goalSnapshot: macros(1800, 120, 200, 60) };
    expect(menuDays([frozen.date], [frozen], GOALS, nameOf)[0]?.goals.kcal).toBe(1800);
  });

  it('names a meal whose recipe is gone rather than dropping it', () => {
    const orphan: Day = { date: '2026-09-07', meals: [meal('gone', macros(300, 10, 40, 5))] };
    expect(menuDays([orphan.date], [orphan], GOALS, nameOf)[0]?.meals[0]?.name).toBe(
      'Usunięty przepis'
    );
  });
});

describe('formatMenuTotals', () => {
  it('prints each value against its goal', () => {
    expect(formatMenuTotals(macros(700, 37.5, 85, 20), GOALS)).toBe(
      'Razem: 700 / 2000 kcal · B 38 / 130 g · W 85 / 220 g · T 20 / 70 g'
    );
  });

  it('drops the target where no goal was ever set — 0 is „not set", not „eat nothing"', () => {
    expect(formatMenuTotals(macros(700, 38, 85, 20), macros(0, 0, 0, 0))).toBe(
      'Razem: 700 kcal · B 38 g · W 85 g · T 20 g'
    );
  });
});

describe('formatMenuDay', () => {
  it('is a date, the meals with their portions, and one totals line', () => {
    const [day] = menuDays([monday.date], [monday], GOALS, nameOf);
    expect(formatMenuDay(day!)).toBe(
      'poniedziałek, 7 września\n' +
        '• Owsianka — 1 porcja\n' +
        '• Kurczak z ryżem — 0,5 porcji\n' +
        'Razem: 700 / 2000 kcal · B 38 / 130 g · W 85 / 220 g · T 20 / 70 g'
    );
  });

  it('says so when a day holds nothing, and totals nothing', () => {
    const [empty] = menuDays(['2026-09-08'], [], GOALS, nameOf);
    expect(formatMenuDay(empty!)).toBe('wtorek, 8 września\nNic nie zaplanowano.');
  });
});

describe('formatMenu', () => {
  it('is the title, a blank line, and the days separated by blank lines', () => {
    const days = menuDays(['2026-09-07', '2026-09-08'], [monday], GOALS, nameOf);
    const text = formatMenu('Jadłospis — tydzień', days);
    expect(text.startsWith('Jadłospis — tydzień\n\n')).toBe(true);
    expect(text).toContain('\n\nwtorek, 8 września\nNic nie zaplanowano.\n');
    expect(text.endsWith('\n')).toBe(true);
  });

  it('holds one bullet per meal and nothing else — no ingredients (decision 334)', () => {
    const text = formatMenu('Jadłospis', menuDays([monday.date], [monday], GOALS, nameOf));
    // Five non-blank lines: the title, the date, the two meals, the totals. Ingredients are
    // the shopping list's, and there is no room here for them to have crept in.
    expect(text.trim().split('\n').filter((line) => line !== '')).toHaveLength(5);
    expect(text.split('\n').filter((line) => line.startsWith('• '))).toHaveLength(2);
  });

  it('says so for a range with no days at all', () => {
    expect(formatMenu('Jadłospis', [])).toBe('Jadłospis\n\nNic nie zaplanowano.\n');
  });
});
