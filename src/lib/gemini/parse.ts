import type { IngredientState, Unit } from '../types';
import type { ResponseSchema } from './client';

/**
 * The prompts and the readers for the recipe-import call. Pure: no `fetch`, no key, no
 * IndexedDB — so every rule below (units, quantified fats, "never nutrition numbers") is
 * testable without a network.
 *
 * The model's job is deliberately small. It reads a recipe and says what goes into it and how
 * it is made; it does not weigh anything against a database and it never returns kcal or
 * macros. Those come from the local USDA subset and only from there, because the same meal has
 * to compute identically every time (PLAN.md "Gemini").
 */

/** One ingredient line as the model returns it, before anything is matched. */
export interface ParsedIngredient {
  /** Polish, singular, no amount in the text — „mąka pszenna", not „2 szklanki mąki". */
  name: string;
  /** In `unit`. Always a number: the prompt forbids „odrobina". */
  amount: number;
  unit: Unit;
  state: IngredientState;
  /** Grams in one piece, when `unit` is `szt` and the model could say. */
  gramsPerUnit?: number;
}

export interface ParsedRecipe {
  /** The dish's name as the source calls it; `''` when the source gives none. */
  name: string;
  /** How many portions the amounts below describe. At least 1. */
  portions: number;
  ingredients: ParsedIngredient[];
  instructions: string;
}

/**
 * What the app will accept back. There is no field for kcal, protein, carbs or fat anywhere in
 * this schema — the structure itself is the first half of "never nutrition numbers", and the
 * system instruction is the second.
 */
export const RECIPE_SCHEMA: ResponseSchema = {
  type: 'object',
  required: ['name', 'portions', 'ingredients', 'instructions'],
  propertyOrdering: ['name', 'portions', 'ingredients', 'instructions'],
  properties: {
    name: { type: 'string', description: 'Nazwa dania po polsku.' },
    portions: { type: 'integer', description: 'Na ile porcji są podane ilości.' },
    ingredients: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'amount', 'unit', 'state'],
        propertyOrdering: ['name', 'amount', 'unit', 'state', 'gramsPerUnit'],
        properties: {
          name: {
            type: 'string',
            description: 'Polska nazwa składnika w mianowniku liczby pojedynczej, bez ilości.'
          },
          amount: { type: 'number', description: 'Liczba, nigdy zakres ani słowo.' },
          unit: { type: 'string', enum: ['g', 'ml', 'szt'] },
          state: {
            type: 'string',
            enum: ['raw', 'cooked'],
            description: 'Czy podana ilość dotyczy produktu surowego czy już ugotowanego.'
          },
          gramsPerUnit: {
            type: 'number',
            description: 'Waga jednej sztuki w gramach, gdy unit to szt.'
          }
        }
      }
    },
    instructions: { type: 'string', description: 'Sposób przygotowania, po polsku.' }
  }
};

/**
 * The rules that matter, in the order they matter. „Quantified fats" is called out by name
 * because it is the one omission that silently costs hundreds of kilocalories: a recipe that
 * says „skropić oliwą" and imports as nothing at all looks correct and is not.
 */
export const PARSE_SYSTEM = [
  'Jesteś parserem przepisów kulinarnych. Zwracasz wyłącznie JSON zgodny ze schematem.',
  'Zasady, w tej kolejności:',
  '1. NIGDY nie podawaj wartości odżywczych: żadnych kalorii, białka, węglowodanów ani tłuszczu.',
  '   Aplikacja liczy je sama z własnej bazy. Podajesz tylko składniki i sposób przygotowania.',
  '2. Każdy składnik musi mieć konkretną liczbę. Zamień „odrobina oliwy”, „szczypta soli”,',
  '   „do smaku” na rozsądną wartość liczbową (np. 10 g oliwy). Tłuszcze — oliwa, masło, olej,',
  '   smalec — muszą być podane ZAWSZE, nawet jeśli przepis pisze tylko „natłuścić patelnię”.',
  '3. Przelicz miary domowe na gramy lub mililitry: łyżka oliwy ≈ 12 g, łyżeczka ≈ 5 g,',
  '   szklanka mąki ≈ 130 g, szklanka płynu = 250 ml. Jednostka to wyłącznie g, ml albo szt.',
  '   Dla „szt” podaj gramsPerUnit — wagę jednej sztuki.',
  '4. Nazwa składnika po polsku, w mianowniku liczby pojedynczej, bez ilości i bez marki:',
  '   „mąka pszenna”, „jajko kurze”, „ser żółty”. Nie łącz dwóch produktów w jedną nazwę.',
  '5. state = "cooked" tylko wtedy, gdy przepis wyraźnie podaje ilość produktu już ugotowanego',
  '   (np. „300 g ugotowanego ryżu”). W każdym innym wypadku "raw".',
  '6. portions to liczba porcji, której dotyczą podane ilości. Jeśli przepis nie mówi, wpisz 1.',
  '7. Nie wymyślaj składników, których w przepisie nie ma.',
  '8. Pomiń wodę i lód — nie wnoszą wartości odżywczych, a zaśmiecają listę składników.'
].join('\n');

export function parsePrompt(recipeText: string): string {
  return `Przetwórz ten przepis:\n\n${recipeText}`;
}

/**
 * Step one of the link path (decision 113): read the page and give back its recipe as text.
 * Nothing is parsed here — the text then goes through the very same call a paste would, which
 * is what makes „a link produces the same draft as its pasted text" true by construction.
 */
export const FETCH_SYSTEM = [
  'Otwórz podany adres i przepisz z niego przepis kulinarny jako zwykły tekst:',
  'nazwa dania, liczba porcji, lista składników z ilościami, sposób przygotowania.',
  'Przepisujesz, nie streszczasz i nie komentujesz — zachowaj wszystkie ilości dokładnie tak,',
  'jak podaje strona. Nie dodawaj wartości odżywczych.',
  'Jeśli nie możesz otworzyć strony albo nie ma na niej przepisu, odpowiedz jednym słowem:',
  'BRAK_PRZEPISU'
].join('\n');

/** The sentinel the fetch step answers with when it could not read the page. */
export const NO_RECIPE = 'BRAK_PRZEPISU';

export function fetchPrompt(url: string): string {
  return `Adres strony: ${url}`;
}

/** True for something the user typed that is meant as a link rather than a recipe. */
export function looksLikeUrl(input: string): boolean {
  const trimmed = input.trim();
  if (/\s/.test(trimmed)) return false;
  return /^https?:\/\/\S+\.\S+/i.test(trimmed) || /^[\w-]+(\.[\w-]+)+\/\S*$/i.test(trimmed);
}

/** Add the scheme a user leaves out when they paste `example.com/przepis`. */
export function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

// ---- readers ----------------------------------------------------------------------------

/**
 * Household and metric units the model may return despite the enum, mapped to a unit the app
 * stores plus the factor to multiply the amount by. Defensive only: the schema asks for
 * g/ml/szt, and this is what keeps a stray „kg" from importing as 0.5 g.
 */
const UNIT_ALIASES: Record<string, { unit: Unit; factor: number }> = {
  g: { unit: 'g', factor: 1 },
  gram: { unit: 'g', factor: 1 },
  gramy: { unit: 'g', factor: 1 },
  gramow: { unit: 'g', factor: 1 },
  dag: { unit: 'g', factor: 10 },
  kg: { unit: 'g', factor: 1000 },
  ml: { unit: 'ml', factor: 1 },
  mililitr: { unit: 'ml', factor: 1 },
  cl: { unit: 'ml', factor: 10 },
  dl: { unit: 'ml', factor: 100 },
  l: { unit: 'ml', factor: 1000 },
  litr: { unit: 'ml', factor: 1000 },
  szt: { unit: 'szt', factor: 1 },
  sztuka: { unit: 'szt', factor: 1 },
  sztuki: { unit: 'szt', factor: 1 },
  sztuk: { unit: 'szt', factor: 1 }
};

/** `undefined` for a unit nothing sensible can be done with — the row is then dropped. */
export function readUnit(value: unknown): { unit: Unit; factor: number } | undefined {
  if (typeof value !== 'string') return undefined;
  const key = value.trim().toLowerCase().replace(/\.$/, '');
  return UNIT_ALIASES[key];
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  // A model told to return a number occasionally returns "1,5" anyway.
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value.replace(',', '.'));
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Turn whatever came back into a `ParsedRecipe`, or throw nothing and return an empty
 * ingredient list — the caller decides what an empty import means.
 *
 * Rows without a usable name or amount are dropped rather than repaired: a row with a name and
 * no quantity is exactly the „odrobina oliwy" the prompt forbids, and importing it as 0 g would
 * hide the omission behind a number that looks deliberate. Unknown properties — including any
 * nutrition field a model volunteers despite the schema — are ignored here and never reach the
 * editor.
 */
export function readParsedRecipe(value: unknown): ParsedRecipe {
  const doc = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;

  const portions = readNumber(doc.portions);
  const rows = Array.isArray(doc.ingredients) ? doc.ingredients : [];

  const ingredients: ParsedIngredient[] = [];
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue;
    const item = row as Record<string, unknown>;

    const name = readString(item.name);
    const amount = readNumber(item.amount);
    const unit = readUnit(item.unit);
    if (name === '' || amount === undefined || amount <= 0 || unit === undefined) continue;

    const parsed: ParsedIngredient = {
      name,
      amount: amount * unit.factor,
      unit: unit.unit,
      state: item.state === 'cooked' ? 'cooked' : 'raw'
    };
    const gramsPerUnit = readNumber(item.gramsPerUnit);
    if (unit.unit === 'szt' && gramsPerUnit !== undefined && gramsPerUnit > 0) {
      parsed.gramsPerUnit = gramsPerUnit;
    }
    ingredients.push(parsed);
  }

  return {
    name: readString(doc.name),
    portions: portions !== undefined && portions >= 1 ? Math.round(portions) : 1,
    ingredients,
    instructions: readString(doc.instructions)
  };
}

/**
 * Recipes are stored for exactly one portion (PLAN.md), and a page saying „na 4 porcje" is the
 * normal case — so the division happens on import rather than being left to the user. `szt`
 * rows divide too: a quarter of an egg is honest arithmetic, and the alternative is a recipe
 * whose macros are four times too large.
 */
export function toSinglePortion(recipe: ParsedRecipe): ParsedRecipe {
  if (recipe.portions <= 1) return { ...recipe, portions: 1 };
  const divisor = recipe.portions;
  return {
    ...recipe,
    portions: 1,
    ingredients: recipe.ingredients.map((item) => ({
      ...item,
      // Two decimals: enough for a quarter of an egg, short of pretending to milligrams.
      amount: Math.round((item.amount / divisor) * 100) / 100
    }))
  };
}
