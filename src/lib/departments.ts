/**
 * Where a thing is bought, and the order a shop is walked in (PLAN.md Phase 17).
 *
 * This module is the **only** place the order of a shopping list is decided. `shopping.ts`
 * used to order lines by the order the ingredients were first met, „so a list reads like the
 * recipes it came from"; that was right while the app knew nothing about what an ingredient
 * *is*, and wrong in a shop, where the list is actually read and flour between two vegetables
 * costs a walk back across the building. STATE.md decision 329 records the reversal — within a
 * department the old order is kept, so a department still reads the way the whole list used to.
 *
 * Nine names, one level, not a taxonomy (decision 327): a two-level one earns its keep when it
 * filters a search, and ours does not — ingredient search works on names and aliases.
 *
 * The ids are ASCII and stable, because they are written into IndexedDB, into the Drive
 * document and into a backup file; only the labels below are Polish and only they are read.
 */

/**
 * The nine departments, **in the order a shop is walked**. This array is the walk order:
 * nothing else sorts a shopping list, and reordering it here reorders every list in the app.
 */
export const DEPARTMENTS = [
  'warzywa',
  'nabial',
  'mieso',
  'pieczywo',
  'sypkie',
  'przyprawy',
  'mrozonki',
  'napoje',
  'inne'
] as const;

export type Department = (typeof DEPARTMENTS)[number];

/** The heading each department is printed under, on screen and in the shared text. */
export const DEPARTMENT_LABELS: Record<Department, string> = {
  warzywa: 'Warzywa i owoce',
  nabial: 'Nabiał i jaja',
  mieso: 'Mięso, ryby i wędliny',
  pieczywo: 'Pieczywo',
  sypkie: 'Sypkie i makarony',
  przyprawy: 'Przyprawy i dodatki',
  mrozonki: 'Mrożonki',
  napoje: 'Napoje',
  inne: 'Inne'
};

/**
 * What an ingredient with no department counts as (decision 330).
 *
 * The field is optional and nothing about saving an ingredient ever blocks on it — the form
 * that takes it is the same form that takes a reading off a photographed package, and it has
 * to stay fast. So „missing" is not an error state to be reported anywhere; it is „Inne".
 */
export const DEFAULT_DEPARTMENT: Department = 'inne';

/** True for a value read back out of storage that is still one of the nine. */
export function isDepartment(value: unknown): value is Department {
  return typeof value === 'string' && (DEPARTMENTS as readonly string[]).includes(value);
}

/**
 * The department a row is filed under: its own, or „Inne".
 *
 * Takes the shape rather than an `Ingredient` so that a line, a draft or a row read from an
 * older build all go through one function. A value that is not one of the nine — written by a
 * newer build, or edited by hand in a backup file — falls back rather than being trusted.
 */
export function departmentOf(row: { department?: string } | undefined): Department {
  const value = row?.department;
  return isDepartment(value) ? value : DEFAULT_DEPARTMENT;
}

/** Position in the walk order. Used to sort; never stored. */
export function departmentIndex(department: Department): number {
  return DEPARTMENTS.indexOf(department);
}

/** The Polish heading, for a value that may have come from anywhere. */
export function departmentLabel(value: unknown): string {
  return DEPARTMENT_LABELS[isDepartment(value) ? value : DEFAULT_DEPARTMENT];
}
