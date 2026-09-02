<script lang="ts">
  import type { Macros } from '../types';
  import { ACTIVITY_LEVELS, areGoalsUsable, calculateGoals, type ActivityKey, type Sex } from '../goals';

  /**
   * Daily goals, with the Mifflin-St Jeor calculator folded away behind a toggle. The
   * calculator only ever *fills* the four fields — it never saves anything itself, so a
   * calculated number is as editable as a typed one (PLAN.md: "overridable").
   */

  let {
    goals = $bindable(),
    onsave,
    saving = false
  }: { goals: Macros; onsave?: (goals: Macros) => void; saving?: boolean } = $props();

  let calculatorOpen = $state(false);
  let sex = $state<Sex>('female');
  let age = $state(30);
  let height = $state(170);
  let weight = $state(70);
  let activity = $state<ActivityKey>('light');

  const valid = $derived(areGoalsUsable(goals));

  function fillFromCalculator(): void {
    goals = calculateGoals({ sex, age, height, weight, activity });
    calculatorOpen = false;
  }

  const fields = [
    { key: 'kcal', label: 'Kalorie', unit: 'kcal' },
    { key: 'protein', label: 'Białko', unit: 'g' },
    { key: 'carbs', label: 'Węglowodany', unit: 'g' },
    { key: 'fat', label: 'Tłuszcz', unit: 'g' }
  ] as const;
</script>

<div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
  {#each fields as field (field.key)}
    <label class="text-sm font-medium">
      {field.label}
      <span class="text-(--color-ink-muted)">({field.unit})</span>
      <input
        class="mt-1 w-full rounded-lg border border-(--color-border) bg-(--color-surface-raised) px-3 py-2 text-base font-normal outline-none focus:border-(--color-accent)"
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
      Kalkulator tylko wypełnia pola powyżej — każdą wartość możesz potem zmienić.
    </p>
    <div class="grid grid-cols-2 gap-3 pt-3 sm:grid-cols-4">
      <label class="text-sm font-medium">
        Płeć
        <select
          class="mt-1 w-full rounded-lg border border-(--color-border) bg-(--color-surface-raised) px-3 py-2 text-base font-normal"
          bind:value={sex}
        >
          <option value="female">Kobieta</option>
          <option value="male">Mężczyzna</option>
        </select>
      </label>
      <label class="text-sm font-medium">
        Wiek <span class="text-(--color-ink-muted)">(lata)</span>
        <input
          class="mt-1 w-full rounded-lg border border-(--color-border) bg-(--color-surface-raised) px-3 py-2 text-base font-normal"
          type="number"
          min="1"
          inputmode="numeric"
          bind:value={age}
        />
      </label>
      <label class="text-sm font-medium">
        Wzrost <span class="text-(--color-ink-muted)">(cm)</span>
        <input
          class="mt-1 w-full rounded-lg border border-(--color-border) bg-(--color-surface-raised) px-3 py-2 text-base font-normal"
          type="number"
          min="1"
          inputmode="numeric"
          bind:value={height}
        />
      </label>
      <label class="text-sm font-medium">
        Waga <span class="text-(--color-ink-muted)">(kg)</span>
        <input
          class="mt-1 w-full rounded-lg border border-(--color-border) bg-(--color-surface-raised) px-3 py-2 text-base font-normal"
          type="number"
          min="1"
          inputmode="numeric"
          bind:value={weight}
        />
      </label>
    </div>
    <label class="mt-3 block text-sm font-medium">
      Aktywność
      <select
        class="mt-1 w-full rounded-lg border border-(--color-border) bg-(--color-surface-raised) px-3 py-2 text-base font-normal"
        bind:value={activity}
      >
        {#each ACTIVITY_LEVELS as level (level.key)}
          <option value={level.key}>{level.label}</option>
        {/each}
      </select>
    </label>
    <button
      type="button"
      class="mt-3 rounded-lg border border-(--color-border) px-3 py-2 text-sm font-medium"
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
    onclick={() => onsave?.(goals)}
  >
    {saving ? 'Zapisywanie…' : 'Zapisz cele'}
  </button>
  {#if !valid}
    <p class="pt-2 text-sm text-red-700">Wszystkie wartości muszą być liczbami nieujemnymi.</p>
  {/if}
{/if}
