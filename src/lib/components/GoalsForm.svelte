<script lang="ts">
  import type { Macros } from '../types';
  import {
    ACTIVITY_LEVELS,
    DEFAULT_BODY,
    areGoalsUsable,
    deriveGoals,
    isBodyUsable,
    isSplitUsable,
    splitOf,
    type ActivityKey,
    type BodyData,
    type MacroSplit,
    type Sex
  } from '../goals';

  /**
   * Daily goals, with the Mifflin-St Jeor calculator folded away behind a toggle. The
   * calculator only ever *fills* the four fields — it never saves anything itself, so a
   * calculated number is as editable as a typed one (PLAN.md: "overridable").
   *
   * Its inputs are no longer component-local (Phase 19): they arrive as `body` from the
   * profile and go back out through `onsave`, so the panel does not ask for sex, age, height
   * and weight again every time it is opened. Nothing here writes to the database — the save
   * button under the four fields still is the only thing that does.
   */

  let {
    goals = $bindable(),
    body,
    onsave,
    saving = false
  }: {
    goals: Macros;
    body?: BodyData | undefined;
    onsave?: (goals: Macros, body: BodyData) => void;
    saving?: boolean;
  } = $props();

  /**
   * Seeded once, deliberately: the panel opens on what the profile last saved, and a Drive pull
   * arriving under an open screen must not overwrite what is being typed into it — the same
   * rule Settings applies to the four goal fields (STATE.md decision 227).
   */
  // svelte-ignore state_referenced_locally
  const initial: BodyData = body ?? DEFAULT_BODY;

  let calculatorOpen = $state(false);
  let sex = $state<Sex>(initial.sex);
  let age = $state(initial.age);
  let height = $state(initial.height);
  let weight = $state(initial.weight);
  let activity = $state<ActivityKey>(initial.activity);
  let split = $state<MacroSplit>({ ...splitOf(initial) });

  const input = $derived({ sex, age, height, weight, activity });
  const splitValid = $derived(isSplitUsable(split));
  const splitSum = $derived(split.protein + split.carbs + split.fat);
  const bodyValid = $derived(isBodyUsable(input));
  const valid = $derived(areGoalsUsable(goals) && splitValid);

  /** Live, so the derivation under the result follows the fields rather than the last press. */
  const derivation = $derived(bodyValid && splitValid ? deriveGoals(input, split) : null);

  /** What travels with the save press. The split rides along; see `BodyData`. */
  const currentBody = $derived<BodyData>({ ...input, split: { ...split } });

  function fillFromCalculator(): void {
    if (derivation === null) return;
    goals = derivation.goals;
  }

  /** „1 234" and „1,375" — the Polish separators the rest of the app uses. */
  function number(value: number, decimals = 0): string {
    return value.toLocaleString('pl-PL', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals
    });
  }

  const fields = [
    { key: 'kcal', label: 'Kalorie', unit: 'kcal' },
    { key: 'protein', label: 'Białko', unit: 'g' },
    { key: 'carbs', label: 'Węglowodany', unit: 'g' },
    { key: 'fat', label: 'Tłuszcz', unit: 'g' }
  ] as const;

  const splitFields = [
    { key: 'protein', label: 'Białko' },
    { key: 'carbs', label: 'Węglowodany' },
    { key: 'fat', label: 'Tłuszcz' }
  ] as const;

  const inputClass =
    'mt-1 w-full rounded-lg border border-(--color-border) bg-(--color-surface-raised) px-3 py-2 text-base font-normal outline-none focus:border-(--color-accent)';
</script>

<div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
  {#each fields as field (field.key)}
    <label class="text-sm font-medium">
      {field.label}
      <span class="text-(--color-ink-muted)">({field.unit})</span>
      <input
        class={inputClass}
        type="number"
        min="0"
        step="1"
        inputmode="numeric"
        value={goals[field.key]}
        oninput={(event) => {
          goals = { ...goals, [field.key]: event.currentTarget.valueAsNumber };
        }}
      />
    </label>
  {/each}
</div>

<button
  type="button"
  class="pt-3 text-sm text-(--color-accent) underline"
  aria-expanded={calculatorOpen}
  onclick={() => (calculatorOpen = !calculatorOpen)}
>
  {calculatorOpen ? 'Ukryj kalkulator' : 'Policz za mnie (Mifflin-St Jeor)'}
</button>

{#if calculatorOpen}
  <div class="mt-3 rounded-xl border border-(--color-border) p-3">
    <p class="text-sm text-(--color-ink-muted)">
      Kalkulator tylko wypełnia pola powyżej — każdą wartość możesz potem zmienić. Dane sylwetki
      zapisują się razem z celami, przyciskiem „Zapisz cele".
    </p>
    <div class="grid grid-cols-2 gap-3 pt-3 sm:grid-cols-4">
      <label class="text-sm font-medium">
        Płeć
        <select class={inputClass} bind:value={sex}>
          <option value="female">Kobieta</option>
          <option value="male">Mężczyzna</option>
        </select>
      </label>
      <label class="text-sm font-medium">
        Wiek <span class="text-(--color-ink-muted)">(lata)</span>
        <input class={inputClass} type="number" min="1" inputmode="numeric" bind:value={age} />
      </label>
      <label class="text-sm font-medium">
        Wzrost <span class="text-(--color-ink-muted)">(cm)</span>
        <input class={inputClass} type="number" min="1" inputmode="numeric" bind:value={height} />
      </label>
      <label class="text-sm font-medium">
        Waga <span class="text-(--color-ink-muted)">(kg)</span>
        <input class={inputClass} type="number" min="1" inputmode="numeric" bind:value={weight} />
      </label>
    </div>
    <label class="mt-3 block text-sm font-medium">
      Aktywność
      <select class={inputClass} bind:value={activity}>
        {#each ACTIVITY_LEVELS as level (level.key)}
          <option value={level.key}>{level.label}</option>
        {/each}
      </select>
    </label>

    <!-- ---- the split ---------------------------------------------------------------- -->
    <h4 class="pt-4 text-sm font-semibold">Podział energii</h4>
    <p class="pt-1 text-sm text-(--color-ink-muted)">
      Ile procent kalorii ma pochodzić z każdego makroskładnika. Suma musi wynosić 100%.
    </p>
    <div class="grid grid-cols-3 gap-3 pt-2">
      {#each splitFields as field (field.key)}
        <label class="text-sm font-medium">
          {field.label} <span class="text-(--color-ink-muted)">(%)</span>
          <input
            class={inputClass}
            type="number"
            min="0"
            max="100"
            step="1"
            inputmode="numeric"
            value={split[field.key]}
            oninput={(event) => {
              split = { ...split, [field.key]: event.currentTarget.valueAsNumber };
            }}
          />
        </label>
      {/each}
    </div>
    {#if !splitValid}
      <p class="pt-2 text-sm text-(--color-danger)" role="alert">
        Suma wynosi {Number.isFinite(splitSum) ? number(splitSum) : '—'}% zamiast 100%. Popraw
        udziały, żeby policzyć cele.
      </p>
    {/if}

    <!-- ---- the derivation ----------------------------------------------------------- -->
    {#if derivation !== null}
      <div class="mt-3 rounded-lg bg-(--color-surface) p-3 text-sm" data-testid="derivation">
        <p class="font-medium">Skąd ten wynik</p>
        <ul class="pt-1 text-(--color-ink-muted)">
          <li>Podstawowa przemiana materii (PPM): <b>{number(Math.round(derivation.bmr))} kcal</b></li>
          <li>× współczynnik aktywności: <b>{number(derivation.factor, 3)}</b></li>
          <li>= zapotrzebowanie dzienne: <b>{number(derivation.goals.kcal)} kcal</b></li>
          <li>
            Podział: białko {number(derivation.split.protein)}% =
            <b>{number(derivation.goals.protein)} g</b>, węglowodany
            {number(derivation.split.carbs)}% = <b>{number(derivation.goals.carbs)} g</b>, tłuszcz
            {number(derivation.split.fat)}% = <b>{number(derivation.goals.fat)} g</b>
          </li>
        </ul>
      </div>
    {:else if !bodyValid}
      <p class="pt-2 text-sm text-(--color-danger)" role="alert">
        Wiek, wzrost i waga muszą być liczbami większymi od zera.
      </p>
    {/if}

    <button
      type="button"
      class="mt-3 rounded-lg border border-(--color-border) px-3 py-2 text-sm font-medium disabled:opacity-50"
      disabled={derivation === null}
      onclick={fillFromCalculator}
    >
      Wypełnij pola
    </button>
  </div>
{/if}

{#if onsave}
  <button
    type="button"
    class="mt-4 rounded-lg bg-(--color-accent) px-3 py-2 text-sm font-medium text-(--color-accent-ink) disabled:opacity-50"
    disabled={!valid || saving}
    onclick={() => onsave?.(goals, currentBody)}
  >
    {saving ? 'Zapisywanie…' : 'Zapisz cele'}
  </button>
  {#if !areGoalsUsable(goals)}
    <p class="pt-2 text-sm text-(--color-danger)">Wszystkie wartości muszą być liczbami nieujemnymi.</p>
  {:else if !splitValid}
    <p class="pt-2 text-sm text-(--color-danger)">
      Podział energii w kalkulatorze musi sumować się do 100%.
    </p>
  {/if}
{/if}
