<script lang="ts">
  import type { Day } from '../types';
  import type { DayConflict } from '../sync/engine';
  import { dayTotals } from '../macros';
  import { formatDayLong } from '../dates';

  /**
   * The same-day conflict prompt. PLAN.md is explicit that the app must never guess here, so
   * both versions are shown side by side — how many meals, how many kcal, and the names — and
   * nothing is written until every day has an answer. Dismissing the dialog aborts the whole
   * sync rather than applying half of it.
   */

  let {
    conflicts,
    onresolve,
    oncancel
  }: {
    conflicts: DayConflict[];
    onresolve: (choices: Map<string, 'local' | 'remote'>) => void;
    oncancel: () => void;
  } = $props();

  let dialog = $state<HTMLDialogElement>();
  let choices = $state(new Map<string, 'local' | 'remote'>());

  $effect(() => {
    const element = dialog;
    if (element === undefined) return;
    if (conflicts.length > 0 && !element.open) element.showModal();
    else if (conflicts.length === 0 && element.open) element.close();
  });

  // A day the user has not answered yet blocks the button, so no side is applied by default.
  const answered = $derived(conflicts.every((conflict) => choices.has(conflict.date)));

  function choose(date: string, side: 'local' | 'remote'): void {
    const next = new Map(choices);
    next.set(date, side);
    choices = next;
  }

  function summary(day: Day | undefined): string {
    if (day === undefined || day.meals.length === 0) return 'Dzień pusty';
    const totals = dayTotals(day);
    const meals = day.meals.length === 1 ? '1 posiłek' : `${day.meals.length} posiłki`;
    return `${meals} · ${Math.round(totals.kcal)} kcal`;
  }
</script>

<dialog
  bind:this={dialog}
  class="m-auto w-[min(34rem,calc(100vw-2rem))] rounded-2xl border border-(--color-border) bg-(--color-surface-raised) p-5 text-(--color-ink) shadow-xl backdrop:bg-black/40"
  aria-labelledby="conflict-dialog-title"
  oncancel={(event) => {
    event.preventDefault();
    oncancel();
  }}
>
  <h2 id="conflict-dialog-title" class="text-base font-semibold">Ten sam dzień zmieniony w dwóch miejscach</h2>
  <p class="pt-2 text-sm text-(--color-ink-muted)">
    Wybierz, którą wersję zachować. Do czasu wyboru nic nie zostało zapisane — ani tutaj, ani na
    Dysku.
  </p>

  <ul class="flex max-h-[50vh] flex-col gap-3 overflow-y-auto pt-4">
    {#each conflicts as conflict (conflict.date)}
      {@const picked = choices.get(conflict.date)}
      <li class="rounded-xl border border-(--color-border) p-3">
        <p class="font-medium">{formatDayLong(conflict.date)}</p>
        <div class="flex flex-col gap-2 pt-2 sm:flex-row">
          <button
            type="button"
            class="flex-1 rounded-lg border p-3 text-left text-sm {picked === 'local'
              ? 'border-(--color-accent) bg-(--color-accent)/10'
              : 'border-(--color-border)'}"
            aria-pressed={picked === 'local'}
            onclick={() => choose(conflict.date, 'local')}
          >
            <span class="block font-medium">Ta wersja (to urządzenie)</span>
            <span class="block pt-1 text-(--color-ink-muted)">{summary(conflict.local)}</span>
            {#if conflict.local !== undefined && conflict.local.meals.length > 0}
              <span class="block pt-1 text-(--color-ink-muted)">
                {conflict.local.meals.length} poz.
              </span>
            {/if}
          </button>
          <button
            type="button"
            class="flex-1 rounded-lg border p-3 text-left text-sm {picked === 'remote'
              ? 'border-(--color-accent) bg-(--color-accent)/10'
              : 'border-(--color-border)'}"
            aria-pressed={picked === 'remote'}
            onclick={() => choose(conflict.date, 'remote')}
          >
            <span class="block font-medium">Wersja z Dysku</span>
            <span class="block pt-1 text-(--color-ink-muted)">{summary(conflict.remote)}</span>
            {#if conflict.remote !== undefined && conflict.remote.meals.length > 0}
              <span class="block pt-1 text-(--color-ink-muted)">
                {conflict.remote.meals.length} poz.
              </span>
            {/if}
          </button>
        </div>
      </li>
    {/each}
  </ul>

  <div class="flex flex-wrap justify-end gap-2 pt-5">
    <button
      type="button"
      class="rounded-lg border border-(--color-border) px-3 py-2 text-sm font-medium"
      onclick={oncancel}
    >
      Anuluj synchronizację
    </button>
    <button
      type="button"
      class="rounded-lg bg-(--color-accent) px-3 py-2 text-sm font-medium text-(--color-accent-ink) disabled:opacity-50"
      disabled={!answered}
      onclick={() => onresolve(new Map(choices))}
    >
      Zapisz wybór
    </button>
  </div>
</dialog>
