import type { IngredientDraft } from '../custom-ingredients';
import type { Department } from '../departments';
import { DEPARTMENTS, isDepartment } from '../departments';
import type { ResponseSchema } from './client';

/**
 * Reading a nutrition table off a photographed package (PLAN.md Phase 12, stage A).
 *
 * Pure, like `parse.ts`: no `fetch`, no key, no IndexedDB — so every rule the prompt is written
 * against is testable without a network and without spending a request.
 *
 * **Why this is allowed to return numbers at all.** PLAN.md's Gemini section forbids the model
 * from returning nutrition values, because a meal's macros must not depend on what a model
 * guessed on a given day. Nothing here computes anything: the numbers are printed on the
 * package by law, the model transcribes them, the user reads and corrects them in the form, and
 * the save produces an ordinary `custom:*` row whose values are then fixed forever. PLAN.md
 * carries the exception explicitly and STATE.md decision 239 records it.
 *
 * **The one rule that outranks the rest**: a value that could not be read comes back `null`,
 * never `0`. `IngredientDraft` models the macros as `number | null` precisely because „nie
 * wpisano" and „zero" are different facts (decision 178), and a scan that quietly returned `0`
 * would recreate that bug with a photograph as its alibi. `readScannedLabel` enforces it on the
 * way out of the model, whatever the model actually sent.
 *
 * **Phase 17 adds the shopping department, and it costs no extra request.** One nullable,
 * enumerated property on the schema and one rule in the prompt, both riding on the scan that is
 * already being made — which is the whole reason it is acceptable here and a dedicated call is
 * not (decision 330). A classification into nine shelves is not a nutrition value, so this does
 * not touch the rule above; and like every scanned field it arrives as a proposal, marked „ze
 * zdjęcia", which the user sees and can change. A scan that cannot tell the department leaves
 * the field empty rather than guessing „Inne".
 */

/** What one scan produced. Every macro is per 100 g; `null` is „could not read it". */
export interface ScannedLabel {
  /** The product name off the front of the pack. `''` when the model could not read one. */
  name: string;
  kcal: number | null;
  protein: number | null;
  carbs: number | null;
  fat: number | null;
  /**
   * Which part of the shop the product is bought in, or `null` when the model could not tell.
   *
   * `null`, never `'inne'`: „I could not tell" and „it belongs on the miscellaneous shelf" are
   * different answers, and only the first one leaves the field alone. The same shape of rule as
   * the macros' „null is not 0", for the same reason.
   */
  department: Department | null;
}

/** The fields a scan may fill. Everything else in the draft stays the user's. */
export const SCANNED_FIELDS = ['name', 'kcal', 'protein', 'carbs', 'fat', 'department'] as const;

export type ScannedField = (typeof SCANNED_FIELDS)[number];

/**
 * The answer shape. `state` is deliberately absent: raw versus cooked is not printed on a
 * label, so it stays the user's choice and keeps the form's own default.
 */
export const LABEL_SCHEMA: ResponseSchema = {
  type: 'object',
  required: ['name', 'kcal', 'protein', 'carbs', 'fat', 'category'],
  propertyOrdering: ['name', 'kcal', 'protein', 'carbs', 'fat', 'category'],
  properties: {
    name: {
      type: 'string',
      nullable: true,
      description: 'Nazwa produktu z przodu opakowania, po polsku. null, jeśli nie widać.'
    },
    kcal: { type: 'number', nullable: true, description: 'Kilokalorie w 100 g. null, jeśli nie widać.' },
    protein: { type: 'number', nullable: true, description: 'Białko w gramach na 100 g.' },
    carbs: { type: 'number', nullable: true, description: 'Węglowodany w gramach na 100 g.' },
    fat: { type: 'number', nullable: true, description: 'Tłuszcz w gramach na 100 g.' },
    // Enumerated rather than free text: the nine ids are a closed vocabulary the app stores
    // verbatim, and anything else that comes back anyway is dropped by `readScannedLabel`.
    category: {
      type: 'string',
      nullable: true,
      enum: [...DEPARTMENTS],
      description:
        'Dział sklepu, w którym kupuje się ten produkt. null, jeśli nie da się tego ocenić.'
    }
  }
};

/**
 * The rules, in the order they matter. None of them is about OCR — they are all about the
 * layout of an EU nutrition label, which is where a naive read goes wrong.
 */
export const SCAN_SYSTEM = [
  'Odczytujesz tabelę wartości odżywczych ze zdjęcia opakowania. Zwracasz wyłącznie JSON',
  'zgodny ze schematem. Przepisujesz to, co jest wydrukowane — niczego nie szacujesz',
  'i niczego nie dopowiadasz z wiedzy o produkcie.',
  'Zasady, w tej kolejności:',
  '1. Bierzesz WYŁĄCZNIE kolumnę „w 100 g” (albo „w 100 ml”). Nigdy „na porcję”,',
  '   „na opakowanie” ani „%RWS/GDA” — nawet jeśli stoją obok.',
  '2. Energia w kilokaloriach (kcal), nie w kilodżulach. Etykieta zwykle podaje oba,',
  '   np. „2252 kJ / 539 kcal” — wtedy kcal to 539.',
  '3. „w tym cukry” i „w tym kwasy tłuszczowe nasycone” to pozycje podrzędne. Nie dodawaj ich',
  '   do węglowodanów ani do tłuszczu — te sumy są już wydrukowane osobno.',
  '4. Przecinek dziesiętny zamień na kropkę. Wartość podana jako zakres albo jako „<0,5”',
  '   zapisz jako liczbę (0.5). Nie zwracaj jednostek ani tekstu — tylko liczby.',
  '5. name to nazwa produktu z przodu opakowania, po polsku, bez gramatury i bez sloganów.',
  '   Nie przepisuj nazwy prawnej drobnym drukiem, jeśli jest inna nazwa handlowa.',
  '6. category to dział sklepu, w którym kupuje się ten produkt: warzywa (warzywa i owoce),',
  '   nabial (nabiał i jaja), mieso (mięso, ryby, wędliny), pieczywo, sypkie (kasze, makarony,',
  '   mąka, cukier), przyprawy (przyprawy, oleje, sosy, dodatki), mrozonki (produkty mrożone),',
  '   napoje, inne. Jeśli z opakowania nie da się tego ocenić — wpisz null, a nie „inne”.',
  '7. NAJWAŻNIEJSZE: jeśli którejś wartości nie widać, nie da się jej odczytać albo nie ma jej',
  '   na zdjęciu — wpisz null. NIGDY nie wpisuj 0 zamiast wartości, której nie odczytałeś,',
  '   i nigdy nie zgaduj. 0 wpisz tylko wtedy, gdy na opakowaniu naprawdę wydrukowano 0.'
].join('\n');

/** The user turn. The picture rides alongside it as `inlineData` (see `client.ts`). */
export const SCAN_PROMPT =
  'Odczytaj z tego zdjęcia nazwę produktu, wartości odżywcze w 100 g i dział sklepu.';

// ---- readers ------------------------------------------------------------------------------

/**
 * A number the app is willing to put in a form field, or `null`.
 *
 * Strings are accepted defensively — a model told to return a number occasionally returns
 * „12,5" or „<0,5" anyway — and the first number in the text is taken, which is what „<0,5"
 * and „10-12 g" both mean to a person filling in one field. Anything that is not a finite,
 * non-negative number ends as `null`: no fallback to `0` exists anywhere in this file.
 */
function readMacro(value: unknown): number | null {
  let parsed: number | undefined;
  if (typeof value === 'number') parsed = value;
  if (typeof value === 'string') {
    const found = /-?\d+(?:[.,]\d+)?/.exec(value.replace(/\s/g, ''));
    if (found !== null) parsed = Number.parseFloat(found[0].replace(',', '.'));
  }
  if (parsed === undefined || !Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

/**
 * The department the model named, or `null`.
 *
 * Anything outside the nine — a Polish label instead of an id, a shelf we do not have, a whole
 * sentence — is `null`, which leaves the field alone. There is deliberately no coercion to
 * `'inne'`: a wrong guess the user has to notice is worse than an empty field they fill in.
 */
function readDepartment(value: unknown): Department | null {
  return isDepartment(value) ? value : null;
}

/** Whatever came back, as a `ScannedLabel`. Never throws; an unreadable answer is all-`null`. */
export function readScannedLabel(value: unknown): ScannedLabel {
  const doc = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  return {
    name: typeof doc.name === 'string' ? doc.name.trim() : '',
    kcal: readMacro(doc.kcal),
    protein: readMacro(doc.protein),
    carbs: readMacro(doc.carbs),
    fat: readMacro(doc.fat),
    department: readDepartment(doc.category)
  };
}

/** True when the scan read nothing at all — a photo of a table it could not see. */
export function labelIsEmpty(label: ScannedLabel): boolean {
  // `department` is deliberately not counted: a photo that yielded a shelf and nothing else is
  // a photo of a table the model could not read, and the form has to say so rather than quietly
  // filing an otherwise empty ingredient.
  return (
    label.name === '' &&
    label.kcal === null &&
    label.protein === null &&
    label.carbs === null &&
    label.fat === null
  );
}

/**
 * Write a scan into the draft the user is looking at, and say which fields it filled.
 *
 * Two rules, both from PLAN.md task 5:
 *
 * - **A field the user edited by hand is never overwritten.** `protectedFields` carries them,
 *   so a second scan replaces the proposal without undoing a correction.
 * - **A field the scan could not read is left exactly as it was.** It is not blanked and it is
 *   certainly not zeroed; if it was empty it stays empty, `draftProblem` keeps the save button
 *   disabled, and the form prints the sentence it already prints.
 */
export function applyScannedLabel(
  draft: IngredientDraft,
  label: ScannedLabel,
  protectedFields: Partial<Record<ScannedField, boolean>> = {}
): { draft: IngredientDraft; filled: ScannedField[] } {
  const next: IngredientDraft = { ...draft };
  const filled: ScannedField[] = [];

  if (protectedFields.name !== true && label.name !== '') {
    next.name = label.name;
    filled.push('name');
  }
  for (const field of ['kcal', 'protein', 'carbs', 'fat'] as const) {
    const value = label[field];
    if (protectedFields[field] === true || value === null) continue;
    next[field] = value;
    filled.push(field);
  }
  // Same two rules as the macros: a field the user chose is never overwritten, and a department
  // the scan could not tell is left exactly as it was rather than blanked or defaulted.
  if (protectedFields.department !== true && label.department !== null) {
    next.department = label.department;
    filled.push('department');
  }

  return { draft: next, filled };
}
