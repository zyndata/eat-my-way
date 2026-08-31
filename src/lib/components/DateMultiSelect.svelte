<script lang="ts">
  import { isSameMonth, monthWeeks, nextWeekDates } from '../calendar';
  import {
    addDays,
    dayOfMonth,
    formatDayLong,
    formatMonthYear,
    formatWeekdayShort
  } from '../dates';
  import BottomSheet from './BottomSheet.svelte';
  import NavIcon from './NavIcon.svelte';

  /**
   * The shared date multi-select of PLAN.md task 6: a mini calendar plus the two shortcuts
   * („jutro", „cały przyszły tydzień"). One component behind both „Kopiuj posiłek do…" and
   * „Kopiuj dzień do…", so the two never drift apart.
   *
   * `source` is excluded from the selection — copying a day onto itself is not a thing the
   * repository does, and offering it would only produce a silent no-op.
   */

  const CHEVRON_LEFT = 'M15 5l-7 7 7 7';
  const CHEVRON_RIGHT = 'M9 5l7 7-7 7';

  let {
    open = false,
    title,
    confirmLabel = 'Kopiuj',
    single = false,
    source,
    today,
    onconfirm,
    oncancel
  }: {
    open?: boolean;
    title: string;
    confirmLabel?: string;
    /** Pick exactly one day — used by „Skopiuj z innego dnia", which needs a source. */
    single?: boolean;
    /** The day on the other end of the copy; never selectable. */
    source: string;
    today: string;
    onconfirm: (dates: string[]) => void;
    oncancel: () => void;
  } = $props();

  // Opening the sheet re-anchors it; this is only the value before the first open.
  // svelte-ignore state_referenced_locally
  let anchor = $state(source);
  let selected = $state<string[]>([]);

  // Reopening starts from a clean slate, anchored on the day being copied.
  $effect(() => {
    if (open) {
      anchor = source;
      selected = [];
    }
  });

  const weeks = $derived(monthWeeks(anchor));
  const weekdays = $derived((weeks[0] ?? []).map(formatWeekdayShort));
  /** Sorted so the caller — and the summary line — always sees chronological order. */
  const chosen = $derived([...selected].sort());

  function toggle(date: string): void {
    if (date === source) return;
    if (single) {
      selected = selected.includes(date) ? [] : [date];
      return;
    }
    selected = selected.includes(date)
      ? selected.filter((value) => value !== date)
      : [...selected, date];
  }

  /** Shortcuts add to the selection rather than replacing it. */
  function addAll(dates: readonly string[]): void {
    const merged = new Set(selected);
    for (const date of dates) if (date !== source) merged.add(date);
    selected = [...merged];
  }
</script>

<BottomSheet {open} {title} onclose={oncancel}>
  <div class="flex flex-wrap gap-2 {single ? 'hidden' : ''}">
    <button
      type="button"
      class="rounded-full border border-(--color-border) px-3 py-1.5 text-sm font-medium"
      onclick={() => addAll([addDays(today, 1)])}
    >
      Jutro
    </button>
    <button
      type="button"
      class="rounded-full border border-(--color-border) px-3 py-1.5 text-sm font-medium"
      onclick={() => addAll(nextWeekDates(today))}
    >
      Cały przyszły tydzień
    </button>
    {#if selected.length > 0}
      <button
        type="button"
        class="rounded-full px-3 py-1.5 text-sm text-(--color-accent) underline"
        onclick={() => (selected = [])}
      >
        Wyczyść wybór
      </button>
    {/if}
  </div>

  <section class="pt-4">
    <header class="flex items-center justify-between gap-2">
      <button
        type="button"
        class="rounded-lg p-2 text-(--color-ink-muted)"
        aria-label="Poprzedni miesiąc"
        onclick={() => (anchor = addDays(`${anchor.slice(0, 7)}-01`, -1))}
      >
        <NavIcon path={CHEVRON_LEFT} class="size-5" />
      </button>
      <h3 class="text-sm font-semibold first-letter:uppercase">{formatMonthYear(anchor)}</h3>
      <button
        type="button"
        class="rounded-lg p-2 text-(--color-ink-muted)"
        aria-label="Następny miesiąc"
        onclick={() => (anchor = addDays(`${anchor.slice(0, 7)}-01`, 32))}
      >
        <NavIcon path={CHEVRON_RIGHT} class="size-5" />
      </button>
    </header>

    <div class="grid grid-cols-7 gap-1 pt-2 text-center text-xs text-(--color-ink-muted)">
      {#each weekdays as name, index (index)}
        <span>{name}</span>
      {/each}
    </div>

    {#each weeks as week, index (index)}
      <div class="grid grid-cols-7 gap-1 pt-1">
        {#each week as date (date)}
          {@const on = selected.includes(date)}
          {@const isSource = date === source}
          <button
            type="button"
            class="rounded-lg py-2 text-sm tabular-nums {on
              ? 'bg-(--color-accent) font-semibold text-(--color-accent-ink)'
              : 'border border-(--color-border)'} {isSameMonth(date, anchor)
              ? ''
              : 'opacity-40'} {date === today && !on ? 'text-(--color-accent)' : ''}"
            aria-pressed={on}
            aria-label={formatDayLong(date)}
            disabled={isSource}
            onclick={() => toggle(date)}
          >
            {dayOfMonth(date)}
          </button>
        {/each}
      </div>
    {/each}
  </section>

  <p class="pt-4 text-sm text-(--color-ink-muted)">
    {#if chosen.length === 0}
      {single ? 'Wybierz dzień, z którego skopiować posiłki.' : 'Wybierz dni, do których skopiować.'}
    {:else if single}
      Wybrano {formatDayLong(chosen[0] ?? '')}.
    {:else}
      Wybrano {chosen.length}
      {chosen.length === 1 ? 'dzień' : 'dni'}: {chosen.map(formatDayLong).join(', ')}.
    {/if}
  </p>

  <div class="flex flex-wrap justify-end gap-2 pt-4">
    <button
      type="button"
      class="rounded-lg border border-(--color-border) px-3 py-2 text-sm font-medium"
      onclick={oncancel}
    >
      Anuluj
    </button>
    <button
      type="button"
      class="rounded-lg bg-(--color-accent) px-4 py-2 text-sm font-medium text-(--color-accent-ink) disabled:opacity-50"
      disabled={chosen.length === 0}
      onclick={() => onconfirm(chosen)}
    >
      {confirmLabel}
    </button>
  </div>
</BottomSheet>
