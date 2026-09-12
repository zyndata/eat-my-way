/**
 * The shopping departments, and the USDA food category they are derived from.
 *
 * A second home for a list that already lives in `src/lib/departments.ts`, for the reason
 * `measures.mjs` exists: the build script is `.mjs` and cannot import a `.ts` module, and
 * `build-nutrition.mjs` calls `main()` at import time so it cannot be imported by a test
 * either. `src/lib/departments.test.ts` imports both and fails the moment they drift
 * (STATE.md decisions 350 and 358).
 *
 * Keep this list byte-identical to `DEPARTMENTS` in `src/lib/departments.ts`, in the same
 * order — that order is the order a shop is walked and therefore the order of every list.
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
];

/**
 * USDA `food_category_id` -> department. Twenty-eight decisions, taken once and reviewed by
 * hand, instead of 1 344 typed into the TSV (STATE.md decision 328). Both pinned releases —
 * SR Legacy 2018-04 and Foundation 2026-04-30 — carry `food_category_id` in `food.csv` against
 * the same 28-row `food_category.csv`, which is the precondition decision 328 asked to be
 * verified before this was built; it holds, and all 1 344 mapped rows have a non-blank id.
 *
 * The table is a starting point, not an oracle: a category is a description of a *food*, and a
 * department is a place in a building. Where the two disagree — juice among the fruit, tofu
 * among the dried beans, anything frozen at all — the TSV's sixth column overrides it per row.
 * Nothing derives `mrozonki`: „frozen" is a form, not a USDA category, so every row in it got
 * there by an override.
 *
 * Keys are strings because that is what the CSV reader produces.
 *
 * @type {Record<string, string>}
 */
export const USDA_CATEGORY_DEPARTMENTS = {
  '1': 'nabial', //  Dairy and Egg Products
  '2': 'przyprawy', //  Spices and Herbs
  '3': 'inne', //  Baby Foods
  '4': 'przyprawy', //  Fats and Oils — oil, margarine, mayonnaise, dressings
  '5': 'mieso', //  Poultry Products
  '6': 'przyprawy', //  Soups, Sauces, and Gravies — stock cubes and jars of sauce
  '7': 'mieso', //  Sausages and Luncheon Meats — „wędliny" is in the department's own name
  '8': 'sypkie', //  Breakfast Cereals
  '9': 'warzywa', //  Fruits and Fruit Juices — the juices are overridden per row
  '10': 'mieso', //  Pork Products
  '11': 'warzywa', //  Vegetables and Vegetable Products
  '12': 'sypkie', //  Nut and Seed Products — nuts and seeds sit with the dry goods
  '13': 'mieso', //  Beef Products
  '14': 'napoje', //  Beverages
  '15': 'mieso', //  Finfish and Shellfish Products — „ryby", same department
  '16': 'sypkie', //  Legumes and Legume Products — dried pulses; tofu is overridden
  '17': 'mieso', //  Lamb, Veal, and Game Products
  '18': 'pieczywo', //  Baked Products
  '19': 'przyprawy', //  Sweets — sugar, honey, jam, chocolate: the „dodatki" shelf
  '20': 'sypkie', //  Cereal Grains and Pasta
  '21': 'inne', //  Fast Foods
  '22': 'inne', //  Meals, Entrees, and Side Dishes
  '23': 'inne', //  Snacks
  '24': 'inne', //  American Indian/Alaska Native Foods
  '25': 'inne', //  Restaurant Foods
  '26': 'inne', //  Branded Food Products Database
  '27': 'inne', //  Quality Control Materials
  '28': 'napoje' //  Alcoholic Beverages
};

/**
 * The department a USDA category implies.
 *
 * An unknown or blank category **throws**: a refreshed release that adds a category must fail
 * the build loudly rather than quietly filing a shelf's worth of food under „Inne" — which is
 * exactly the kind of fault that would look like a sync bug months later.
 *
 * @param {string | undefined} categoryId `food_category_id` as read from `food.csv`
 * @param {string} where `file:line` or an fdcId, for the message
 * @returns {string} one of DEPARTMENTS
 */
export function departmentForCategory(categoryId, where) {
  if (categoryId === undefined || categoryId === '') {
    throw new Error(`${where}: USDA row has no food_category_id`);
  }
  const department = USDA_CATEGORY_DEPARTMENTS[categoryId];
  if (department === undefined) {
    throw new Error(
      `${where}: USDA food_category_id ${categoryId} is not in the department table — ` +
        'add it to scripts/departments.mjs deliberately'
    );
  }
  return department;
}

/**
 * Parse the TSV's department column: one department id, or empty for „use the derived one".
 *
 * @param {string} field the raw column
 * @param {string} where `file:line`, for the message
 * @returns {string | undefined} one of DEPARTMENTS, or undefined when the row says nothing
 */
export function parseDepartment(field, where) {
  const value = field.trim();
  if (value === '') return undefined;
  if (!DEPARTMENTS.includes(value)) {
    throw new Error(
      `${where}: unknown department "${value}" — expected one of ${DEPARTMENTS.join(', ')}`
    );
  }
  return value;
}
