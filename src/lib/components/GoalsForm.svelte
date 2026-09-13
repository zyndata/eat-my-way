<script lang="ts">
  import type { Macros } from '../types';
  import {
    ACTIVITY_LEVELS,
    DEFAULT_BODY,
    PROTEIN_HINT_G_PER_KG,
    WEIGHT_GOALS,
    areGoalsUsable,
    deriveGoals,
    energyOffset,
    goalOption,
    isBodyUsable,
    isProteinLow,
    isRateAggressive,
    isSplitUsable,
    minimumKcal,
    proteinPerKg,
    splitOf,
    targetOf,
    type ActivityKey,
    type BodyData,
    type MacroSplit,
    type Sex,
    type WeightGoal,
    type WeightTarget
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

  // Phase 23. `rate` always holds a number so the select has something to show; it only counts
  // when the goal is not maintain.
  const initialTarget = targetOf(initial);
  let goal = $state<WeightGoal>(initialTarget.goal);
  let rate = $state<number>(initialTarget.rate ?? goalOption('lose').defaultRate ?? 0.5);

  /**
   * A goal change always selects the new goal's default rate (decision 424) — a reduction
   * opens on its own pace, not on one carried over from a gain.
   */
  function changeGoal(next: WeightGoal): void {
    goal = next;
    rate = goalOption(next).defaultRate ?? rate;
  }

  const input = $derived({ sex, age, height, weight, activity });
  const target = $derived<WeightTarget>(goal === 'maintain' ? { goal } : { goal, rate });
  const splitValid = $derived(isSplitUsable(split));
  const splitSum = $derived(split.protein + split.carbs + split.fat);
  const bodyValid = $derived(isBodyUsable(input));
  const valid = $derived(areGoalsUsable(goals) && splitValid);

  /** Live, so the derivation under the result follows the fields rather than the last press. */
  const derivation = $derived(bodyValid && splitValid ? deriveGoals(input, split, target) : null);

  /** What travels with the save press. The split and the goal ride along; see `BodyData`. */
  const currentBody = $derived<BodyData>({ ...input, split: { ...split }, ...target });

  const minimum = $derived(minimumKcal(sex));

  /**
   * What the last press filled in, for the confirmation under the button — `null` once it has
   * timed out.
   *
   * This exists because the press was reported as a broken button (Phase 20 UI audit), and it
   * was not: it filled the four fields at the top of the section, which by then had scrolled
   * out of sight behind the calculator panel. Nothing moved anywhere the eye was looking.
   *
   * Naming the four numbers here rather than scrolling the page back up is the deliberate
   * choice — a calculator that yanks the viewport away from the fields being tuned is worse
   * than one that is quiet. It also answers the question the panel's own preamble only hints
   * at, and which „Wypełnij pola" invites: no, this has not saved anything yet.
   */
  let filled = $state<Macros | null>(null);
  let filledTimer: ReturnType<typeof setTimeout> | undefined;

  function fillFromCalculator(): void {
    if (derivation === null) return;
    goals = derivation.goals;

    // Re-armed on every press, so pressing twice re-announces rather than going silent.
    filled = derivation.goals;
    clearTimeout(filledTimer);
    filledTimer = setTimeout(() => (filled = null), 8000);
  }

  $effect(() => () => clearTimeout(filledTimer));

  /** „1 234" and „1,375" — the Polish separators the rest of the app uses. */
  function number(value: number, decimals = 0): string {
    return value.toLocaleString('pl-PL', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals
    });
  }

  /** „0,25", „0,5", „1" — a rate as a kilogram figure, without trailing zeroes. */
  function kg(value: number): string {
    return value.toLocaleString('pl-PL', { maximumFractionDigits: 2 });
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
  class="emw-press emw-btn-link pt-3 text-sm"
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
    <div class="grid gap-3 pt-3 sm:grid-cols-2">
      <label class="text-sm font-medium">
        Cel
        <select class={inputClass} bind:value={() => goal, changeGoal}>
          {#each WEIGHT_GOALS as option (option.key)}
            <option value={option.key}>{option.label}</option>
          {/each}
        </select>
      </label>
      {#if goal !== 'maintain'}
        <label class="text-sm font-medium">
          Tempo
          <select class={inputClass} bind:value={rate}>
            {#each goalOption(goal).rates as option (option)}
              <option value={option}>
                {kg(option)} kg na tydzień — ok. {number(Math.abs(energyOffset(goal, option)))} kcal dziennie
              </option>
            {/each}
          </select>
        </label>
      {/if}
    </div>

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
          <li>
            = zapotrzebowanie na utrzymanie wagi: <b>{number(derivation.maintenance)} kcal</b>
          </li>
          {#if derivation.target.goal === 'lose'}
            <li>
              − deficyt na redukcję ({kg(derivation.target.rate ?? 0)} kg/tydz.):
              <b>{number(-derivation.offset)} kcal</b>
            </li>
          {:else if derivation.target.goal === 'gain'}
            <li>
              + nadwyżka na budowę masy ({kg(derivation.target.rate ?? 0)} kg/tydz.):
              <b>{number(derivation.offset)} kcal</b>
            </li>
          {/if}
          {#if derivation.floorApplied}
            <li>
              {derivation.goals.kcal === minimum
                ? `podniesiono do minimum ${number(minimum)} kcal`
                : 'podniesiono do zapotrzebowania na utrzymanie wagi'}
            </li>
          {/if}
          {#if derivation.target.goal !== 'maintain'}
            <li>= cel dzienny: <b>{number(derivation.goals.kcal)} kcal</b></li>
          {/if}
          <li>
            Podział: białko {number(derivation.split.protein)}% =
            <b>{number(derivation.goals.protein)} g</b>, węglowodany
            {number(derivation.split.carbs)}% = <b>{number(derivation.goals.carbs)} g</b>, tłuszcz
            {number(derivation.split.fat)}% = <b>{number(derivation.goals.fat)} g</b>
          </li>
          <li>
            Białko na kilogram masy ciała:
            <b>≈ {number(proteinPerKg(derivation.goals, input), 1)} g/kg</b>
          </li>
        </ul>
      </div>

      {#if derivation.floorApplied}
        <p class="pt-2 text-sm text-(--color-warn)" data-testid="floor-note">
          {#if derivation.goals.kcal === minimum}
            Przy redukcji kalkulator nie proponuje mniej niż {number(minimum)} kcal dziennie. Niżej
            warto schodzić tylko pod opieką lekarza lub dietetyka.
          {:else}
            Zapotrzebowanie na utrzymanie wagi jest już niższe niż {number(minimum)} kcal, więc
            kalkulator nie proponuje deficytu. Redukcję warto w takiej sytuacji prowadzić pod
            opieką lekarza lub dietetyka.
          {/if}
        </p>
      {/if}
      {#if isRateAggressive(currentBody)}
        <p class="pt-2 text-sm text-(--color-warn)" data-testid="pace-warning">
          {kg(rate)} kg na tydzień to ponad 1% masy ciała tygodniowo. Przy szybszej redukcji traci
          się więcej mięśni, a wynik trudniej utrzymać — rozważ wolniejsze tempo.
        </p>
      {/if}
      {#if isProteinLow(derivation.goals, currentBody)}
        <p class="pt-2 text-sm text-(--color-ink-muted)" data-testid="protein-hint">
          Przy {goal === 'lose' ? 'redukcji' : 'budowie masy'} zwykle zaleca się co najmniej
          {number(PROTEIN_HINT_G_PER_KG, 1)} g białka na kilogram masy ciała. Rozważ większy udział
          białka w podziale energii.
        </p>
      {/if}
    {:else if !bodyValid}
      <p class="pt-2 text-sm text-(--color-danger)" role="alert">
        Wiek, wzrost i waga muszą być liczbami większymi od zera.
      </p>
    {/if}

    <button
      type="button"
      class="mt-3 emw-press emw-btn emw-btn-secondary disabled:opacity-50"
      disabled={derivation === null}
      onclick={fillFromCalculator}
    >
      Wypełnij pola
    </button>

    {#if filled !== null}
      <p class="pt-2 text-sm text-(--color-accent)" role="status" data-testid="fill-confirmation">
        Wypełniono pola powyżej: {number(filled.kcal)} kcal, {number(filled.protein)} g białka,
        {number(filled.carbs)} g węglowodanów, {number(filled.fat)} g tłuszczu. Nic jeszcze nie
        zostało zapisane — zrobi to przycisk „Zapisz cele".
      </p>
    {/if}
  </div>
{/if}

{#if onsave}
  <button
    type="button"
    class="mt-4 emw-press emw-btn emw-btn-primary disabled:opacity-50"
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
