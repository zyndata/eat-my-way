import { describe, expect, it } from 'vitest';
// The build script is `.mjs` and cannot import a `.ts` module, so the closed list lives in two
// places. This file is the join: it imports both and fails the moment they drift — the same
// arrangement `measures.test.ts` makes for the measure vocabulary (STATE.md decisions 350, 358).
import {
  DEPARTMENTS as SCRIPT_DEPARTMENTS,
  USDA_CATEGORY_DEPARTMENTS,
  departmentForCategory,
  parseDepartment
} from '../../scripts/departments.mjs';
import {
  DEFAULT_DEPARTMENT,
  DEPARTMENTS,
  DEPARTMENT_LABELS,
  departmentIndex,
  departmentLabel,
  departmentOf,
  isDepartment
} from './departments';

const WHERE = 'data/pl-ingredients.tsv:42';

describe('the build script and the app agree on the departments', () => {
  it('hold the same ids in the same order — the order is the walk order', () => {
    expect(SCRIPT_DEPARTMENTS).toEqual([...DEPARTMENTS]);
  });
});

describe('the list itself', () => {
  it('is the nine the plan names, in the order a shop is walked', () => {
    expect(DEPARTMENTS).toEqual([
      'warzywa',
      'nabial',
      'mieso',
      'pieczywo',
      'sypkie',
      'przyprawy',
      'mrozonki',
      'napoje',
      'inne'
    ]);
  });

  it('gives every one a Polish heading', () => {
    for (const department of DEPARTMENTS) {
      expect(DEPARTMENT_LABELS[department]).toMatch(/\S/);
    }
    expect(DEPARTMENT_LABELS.warzywa).toBe('Warzywa i owoce');
    expect(DEPARTMENT_LABELS.mieso).toBe('Mięso, ryby i wędliny');
  });

  it('ends the walk at „Inne", which is also what a missing value means', () => {
    expect(DEFAULT_DEPARTMENT).toBe('inne');
    expect(departmentIndex('inne')).toBe(DEPARTMENTS.length - 1);
  });
});

describe('departmentOf', () => {
  it('takes the row’s own department', () => {
    expect(departmentOf({ department: 'nabial' })).toBe('nabial');
  });

  it('files a row without one under „Inne" rather than reporting anything', () => {
    expect(departmentOf({})).toBe('inne');
    expect(departmentOf(undefined)).toBe('inne');
  });

  it('falls back rather than trusting a value it does not know', () => {
    // Written by a newer build, or edited by hand into a backup file. Either way the list has
    // to print it somewhere, and „Inne" is somewhere.
    expect(departmentOf({ department: 'delikatesy' })).toBe('inne');
    expect(isDepartment('delikatesy')).toBe(false);
    expect(departmentLabel('delikatesy')).toBe('Inne');
  });
});

describe('the USDA category mapping (decision 328)', () => {
  it('covers all 28 FDC food categories', () => {
    // Both pinned releases carry the same 28-row `food_category.csv`. A gap here would mean a
    // shelf's worth of food quietly filed under „Inne".
    const ids = Object.keys(USDA_CATEGORY_DEPARTMENTS).map(Number).sort((a, b) => a - b);
    expect(ids).toEqual(Array.from({ length: 28 }, (_, index) => index + 1));
  });

  it('maps every category to one of the nine', () => {
    for (const [id, department] of Object.entries(USDA_CATEGORY_DEPARTMENTS)) {
      expect(DEPARTMENTS, `category ${id}`).toContain(department);
    }
  });

  it('derives the obvious ones', () => {
    expect(departmentForCategory('11', WHERE)).toBe('warzywa'); // Vegetables
    expect(departmentForCategory('1', WHERE)).toBe('nabial'); // Dairy and Egg
    expect(departmentForCategory('15', WHERE)).toBe('mieso'); // Finfish and Shellfish
    expect(departmentForCategory('18', WHERE)).toBe('pieczywo'); // Baked Products
    expect(departmentForCategory('20', WHERE)).toBe('sypkie'); // Cereal Grains and Pasta
  });

  it('derives nothing at all into „Mrożonki", which is a form and not a category', () => {
    expect(Object.values(USDA_CATEGORY_DEPARTMENTS)).not.toContain('mrozonki');
  });

  it('throws on a category it has never seen, rather than filing it under „Inne"', () => {
    // What a refreshed USDA release that adds a category has to do: fail the build loudly.
    expect(() => departmentForCategory('99', WHERE)).toThrow(/not in the department table/);
    expect(() => departmentForCategory('', WHERE)).toThrow(/no food_category_id/);
    expect(() => departmentForCategory(undefined, WHERE)).toThrow(/no food_category_id/);
  });
});

describe('parseDepartment — the TSV’s override column', () => {
  it('reads one department id', () => {
    expect(parseDepartment('mrozonki', WHERE)).toBe('mrozonki');
    expect(parseDepartment('  napoje  ', WHERE)).toBe('napoje');
  });

  it('reads an empty column as „no override", which is the normal case', () => {
    expect(parseDepartment('', WHERE)).toBeUndefined();
    expect(parseDepartment('   ', WHERE)).toBeUndefined();
  });

  it('throws on a name that is not one of the nine', () => {
    expect(() => parseDepartment('delikatesy', WHERE)).toThrow(/unknown department/);
    // The Polish label is not the id: the file stores the id, and a near-miss must not pass.
    expect(() => parseDepartment('Warzywa i owoce', WHERE)).toThrow(/unknown department/);
  });
});
