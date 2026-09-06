/**
 * Development seed: writes a backup file carrying ~20 ready recipes, so the planner can be
 * exercised without typing a library by hand („Ustawienia" -> „Wczytaj kopię").
 *
 * Not part of the build and never imported by the app. Two things it deliberately does:
 *
 * - **Ingredients are the bundled USDA rows**, resolved by exact Polish name out of
 *   `src/lib/nutrition/ingredients.json`. So the file adds no custom ingredients, every
 *   recipe shows real per-100 g values, and nothing new travels to Drive on the next sync.
 * - **`--from` merges into an existing export** instead of replacing it. A restore *clears*
 *   recipes, tags and days (`restoreBackup` in src/lib/repository.ts), so the safe route is:
 *   export from the app, run this over that file, restore the result. Seeded recipes carry
 *   `seed-` ids, so a re-run over an already-seeded export replaces them, never duplicates.
 *
 * Usage:
 *   node scripts/seed-recipes.mjs --from eat-my-way-2026-09-05.json --out seed.json
 *   node scripts/seed-recipes.mjs --out seed.json      # standalone: resets profile + days too
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE = path.join(here, '..', 'src', 'lib', 'nutrition', 'ingredients.json');

/** Same rule as `normalizeKey` in src/lib/text.ts — `ł` carries a stroke, so NFD misses it. */
function normalizeKey(value) {
  return value
    .replace(/[łŁ]/g, (ch) => (ch === 'ł' ? 'l' : 'L'))
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The recipes. Amounts are grams **for exactly one portion**, as `Recipe.items` always are.
 * Tags are the labels a user would type; the planner's slot rows match on their keys.
 */
const RECIPES = [
  {
    name: 'Owsianka z bananem i masłem orzechowym',
    tags: ['śniadanie', 'szybkie', 'wege'],
    instructions: 'Płatki zalej mlekiem i gotuj 5 minut. Dodaj pokrojonego banana i masło orzechowe.',
    items: [['Płatki owsiane', 60], ['Mleko 2%', 250], ['Banan', 100], ['Masło orzechowe', 20]]
  },
  {
    name: 'Jajecznica na maśle z chlebem',
    tags: ['śniadanie', 'szybkie'],
    instructions: 'Roztop masło, wbij jajka, mieszaj na małym ogniu. Podawaj z pieczywem.',
    items: [['Jajko kurze', 150], ['Masło', 10], ['Chleb pszenny', 60]]
  },
  {
    name: 'Kanapki z twarogiem i pomidorem',
    tags: ['śniadanie', 'szybkie', 'wege'],
    instructions: 'Serek wymieszaj ze szczypiorkiem, rozsmaruj na chlebie, ułóż plastry pomidora.',
    items: [['Chleb żytni', 80], ['Serek wiejski', 100], ['Pomidory', 80], ['Szczypiorek', 5]]
  },
  {
    name: 'Jogurt z granolą i borówkami',
    tags: ['śniadanie', 'podwieczorek', 'szybkie', 'wege'],
    instructions: 'Przełóż jogurt z granolą i owocami do miski.',
    items: [['Jogurt naturalny', 200], ['Granola domowa', 50], ['Borówki amerykańskie', 80]]
  },
  {
    name: 'Omlet ze szpinakiem i serem',
    tags: ['śniadanie', 'wege'],
    instructions: 'Jajka rozbełtaj, wylej na patelnię z oliwą, dodaj szpinak i ser, złóż na pół.',
    items: [['Jajko kurze', 150], ['Szpinak', 60], ['Ser żółty gouda', 30], ['Oliwa z oliwek', 5]]
  },
  {
    name: 'Naleśniki z serem',
    tags: ['śniadanie', 'wege'],
    instructions: 'Zrób ciasto z mąki, mleka i jajka. Usmaż naleśniki, nadziej serkiem.',
    items: [
      ['Mąka pszenna biała', 60],
      ['Mleko 2%', 150],
      ['Jajko kurze', 50],
      ['Serek wiejski', 80],
      ['Masło', 5]
    ]
  },
  {
    name: 'Kurczak z ryżem i brokułami',
    tags: ['obiad'],
    instructions: 'Ryż ugotuj, brokuły ugotuj na parze, pierś podsmaż na oliwie.',
    items: [['Pierś z kurczaka', 180], ['Ryż biały', 80], ['Brokuły', 150], ['Oliwa z oliwek', 10]]
  },
  {
    name: 'Spaghetti bolognese',
    tags: ['obiad'],
    instructions: 'Podsmaż cebulę i mięso, dodaj pomidory, duś 30 minut. Podaj z makaronem.',
    items: [
      ['Makaron pszenny', 90],
      ['Mięso mielone wołowe 10% tłuszczu', 120],
      ['Pomidory krojone z puszki', 150],
      ['Cebula', 40],
      ['Oliwa z oliwek', 10]
    ]
  },
  {
    name: 'Gulasz wieprzowy z kaszą',
    tags: ['obiad'],
    instructions: 'Mięso obsmaż, dodaj warzywa i duś pod przykryciem godzinę. Podaj z kaszą.',
    items: [
      ['Łopatka wieprzowa', 150],
      ['Kasza gryczana', 80],
      ['Marchew', 60],
      ['Cebula', 40],
      ['Olej rzepakowy', 10]
    ]
  },
  {
    name: 'Łosoś pieczony z ziemniakami',
    tags: ['obiad'],
    instructions: 'Łososia piecz 18 minut w 200°C. Ziemniaki ugotuj, polej masłem, posyp koperkiem.',
    items: [
      ['Łosoś atlantycki hodowlany', 150],
      ['Ziemniaki', 250],
      ['Masło', 10],
      ['Koperek świeży', 5]
    ]
  },
  {
    name: 'Zupa pomidorowa z ryżem',
    tags: ['obiad'],
    instructions: 'Ugotuj wywar na kurczaku i marchwi, dodaj pomidory, zabiel śmietaną, podaj z ryżem.',
    items: [
      ['Pomidory', 200],
      ['Ryż biały', 40],
      ['Śmietana 18%', 30],
      ['Marchew', 50],
      ['Pierś z kurczaka', 60]
    ]
  },
  {
    name: 'Chili con carne',
    tags: ['obiad'],
    instructions: 'Mięso z cebulą obsmaż, dodaj fasolę i pomidory, duś 40 minut. Podaj z ryżem.',
    items: [
      ['Mięso mielone wołowe 10% tłuszczu', 120],
      ['Fasola czerwona', 60],
      ['Pomidory krojone z puszki', 150],
      ['Cebula', 50],
      ['Ryż biały', 60]
    ]
  },
  {
    name: 'Kotlety mielone z ziemniakami',
    tags: ['obiad'],
    instructions: 'Mięso wymieszaj z bułką tartą i jajkiem, uformuj kotlety, usmaż. Podaj z ziemniakami.',
    items: [
      ['Mięso mielone wieprzowe', 150],
      ['Bułka tarta', 20],
      ['Jajko kurze', 25],
      ['Ziemniaki', 250],
      ['Olej rzepakowy', 10]
    ]
  },
  {
    name: 'Curry z ciecierzycą',
    tags: ['obiad', 'wege'],
    instructions: 'Cebulę zeszklij, dodaj ciecierzycę i mleko kokosowe, gotuj 20 minut. Podaj z ryżem.',
    items: [
      ['Ciecierzyca', 80],
      ['Mleko kokosowe z puszki', 100],
      ['Ryż biały', 70],
      ['Cebula', 40],
      ['Oliwa z oliwek', 10]
    ]
  },
  {
    name: 'Makaron z tuńczykiem',
    tags: ['obiad', 'szybkie'],
    instructions: 'Ugotuj makaron, wymieszaj z tuńczykiem i podsmażonymi pomidorami.',
    items: [['Makaron pszenny', 90], ['Tuńczyk w wodzie', 120], ['Pomidory', 120], ['Oliwa z oliwek', 10]]
  },
  {
    name: 'Sałatka grecka z fetą',
    tags: ['kolacja', 'szybkie', 'wege'],
    instructions: 'Warzywa pokrój, wymieszaj z fetą, skrop oliwą.',
    items: [['Ogórek', 100], ['Pomidory', 150], ['Ser feta', 60], ['Cebula', 30], ['Oliwa z oliwek', 15]]
  },
  {
    name: 'Kanapki z szynką i serem',
    tags: ['kolacja', 'śniadanie', 'szybkie'],
    instructions: 'Pieczywo posmaruj masłem, ułóż szynkę i ser.',
    items: [
      ['Chleb pszenny', 80],
      ['Szynka gotowana chuda', 60],
      ['Ser żółty cheddar', 40],
      ['Masło', 10]
    ]
  },
  {
    name: 'Tortilla z kurczakiem',
    tags: ['kolacja', 'szybkie'],
    instructions: 'Kurczaka i paprykę podsmaż, zawiń w tortillę z jogurtem.',
    items: [
      ['Tortilla pszenna', 80],
      ['Pierś z kurczaka', 120],
      ['Papryka czerwona', 60],
      ['Jogurt naturalny', 30]
    ]
  },
  {
    name: 'Twarożek z rzodkiewką',
    tags: ['kolacja', 'szybkie', 'wege'],
    instructions: 'Serek wymieszaj z rzodkiewką i szczypiorkiem, podaj z pieczywem.',
    items: [['Serek wiejski', 150], ['Rzodkiewka', 50], ['Szczypiorek', 5], ['Chleb żytni', 60]]
  },
  {
    name: 'Jabłko z masłem orzechowym',
    tags: ['podwieczorek', 'szybkie', 'wege'],
    instructions: 'Jabłko pokrój w cząstki, podawaj z masłem orzechowym.',
    items: [['Jabłko', 180], ['Masło orzechowe', 20]]
  },
  {
    name: 'Koktajl bananowo-truskawkowy',
    tags: ['podwieczorek', 'szybkie', 'wege'],
    instructions: 'Zblenduj wszystko na gładko.',
    items: [['Banan', 100], ['Truskawki', 150], ['Jogurt naturalny', 150], ['Miód', 10]]
  },
  {
    name: 'Serek z orzechami i miodem',
    tags: ['podwieczorek', 'szybkie', 'wege'],
    instructions: 'Serek wymieszaj z posiekanymi orzechami, polej miodem.',
    items: [['Serek wiejski', 150], ['Orzechy włoskie', 20], ['Miód', 15]]
  }
];

/** `seed-owsianka-z-bananem-...` — stable, so a re-run replaces the row instead of adding one. */
function seedId(name) {
  return `seed-${normalizeKey(name).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
}

function parseArgs(argv) {
  const args = { from: undefined, out: 'seed-recipes.json' };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--from') args.from = argv[++i];
    else if (flag === '--out') args.out = argv[++i];
    else {
      console.error(`Nieznany argument: ${flag}`);
      process.exit(1);
    }
  }
  return args;
}

function build() {
  const args = parseArgs(process.argv.slice(2));
  const bundle = JSON.parse(readFileSync(BUNDLE, 'utf8'));
  const byName = new Map(bundle.ingredients.map((row) => [normalizeKey(row.name), row]));
  const byId = new Map(bundle.ingredients.map((row) => [row.id, row]));

  // One base date, staggered by an hour, so the library sorts like one that has been used.
  const base = Date.UTC(2026, 0, 1);
  const missing = new Set();
  const seedTags = new Map();

  const recipes = RECIPES.map((source, index) => {
    const items = source.items.map(([name, amount]) => {
      const ingredient = byName.get(normalizeKey(name));
      if (ingredient === undefined) missing.add(name);
      return { ingredientId: ingredient?.id ?? '', amount, unit: 'g' };
    });
    for (const label of source.tags) {
      const key = normalizeKey(label);
      const tag = seedTags.get(key) ?? { key, label, useCount: 0 };
      tag.useCount += 1;
      seedTags.set(key, tag);
    }
    const stamp = new Date(base + index * 3_600_000).toISOString();
    return {
      id: seedId(source.name),
      name: source.name,
      instructions: source.instructions,
      items,
      tags: source.tags.map(normalizeKey),
      createdAt: stamp,
      updatedAt: stamp
    };
  });

  if (missing.size > 0) {
    console.error(`Tych składników nie ma w pakiecie USDA:\n  ${[...missing].join('\n  ')}`);
    process.exit(1);
  }

  const previous = args.from === undefined ? undefined : JSON.parse(readFileSync(args.from, 'utf8'));
  if (previous !== undefined && previous.kind !== 'eat-my-way-backup') {
    console.error(`${args.from} nie jest kopią danych Eat My Way.`);
    process.exit(1);
  }

  // Existing tags win on label and count; the seed only adds keys that are not there yet.
  const tags = [...(previous?.tags ?? [])];
  const known = new Set(tags.map((tag) => tag.key));
  for (const tag of seedTags.values()) if (!known.has(tag.key)) tags.push(tag);

  const kept = (previous?.recipes ?? []).filter((recipe) => !recipe.id.startsWith('seed-'));

  const document = {
    kind: 'eat-my-way-backup',
    version: 1,
    exportedAt: new Date().toISOString(),
    schemaVersion: previous?.schemaVersion ?? 0,
    profile: previous?.profile ?? {
      goals: { kcal: 2000, protein: 100, carbs: 250, fat: 70 },
      geminiModel: 'gemini-3.6-flash',
      encryptVault: true,
      locale: 'pl'
    },
    recipes: [...kept, ...recipes],
    tags,
    ingredients: previous?.ingredients ?? [],
    corrections: previous?.corrections ?? [],
    days: previous?.days ?? [],
    ...(typeof previous?.vault === 'string' ? { vault: previous.vault } : {}),
    settings: previous?.settings ?? {}
  };

  writeFileSync(args.out, `${JSON.stringify(document, null, 2)}\n`, 'utf8');

  /** What one portion is worth, so the seed can be judged against the daily goal. */
  const kcal = (recipe) =>
    recipe.items.reduce(
      (total, item) => total + ((byId.get(item.ingredientId)?.per100g.kcal ?? 0) * item.amount) / 100,
      0
    );

  console.log(
    `${args.out}: ${document.recipes.length} przepisów ` +
      `(${recipes.length} zasianych, ${kept.length} zachowanych), ${tags.length} tagów.`
  );
  for (const recipe of recipes) {
    const label = `${Math.round(kcal(recipe))}`.padStart(4);
    console.log(`  ${label} kcal  ${recipe.tags.join(', ').padEnd(36)}${recipe.name}`);
  }
  if (previous === undefined) {
    console.log(
      '\nUWAGA: bez --from wczytanie tego pliku wyczysci takze dni, profil i cele.' +
        ' Najpierw zrob w aplikacji „Zapisz kopie" i podaj ten plik przez --from.'
    );
  }
}

build();
