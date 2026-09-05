<script lang="ts">
  import { flip } from 'svelte/animate';
  import {
    SHADOW_PLACEHOLDER_ITEM_ID,
    dragHandleZone,
    dragHandle,
    type DndEvent
  } from 'svelte-dnd-action';
  import type { MealPlanTemplate, MealSlot, Tag } from '../types';
  import { MAX_BATCH_DAYS, clampBatchDays, defaultMealPlan, templateOf } from '../planner';
  import { newId } from '../ids';
  import { toTagKeys } from '../tags';
  import { repository } from '../repository';
  import { scheduleSync, syncState } from '../sync/state.svelte';
  import ConfirmDialog from './ConfirmDialog.svelte';
  import NavIcon from './NavIcon.svelte';
  import TagInput from './TagInput.svelte';

  /**
   * The meal-plan template (PLAN.md Phase 13 task 9) — the rules the planner follows, edited
   * as rows rather than typed as a mini-language (STATE.md decision 257).
   *
   * Three things a row says: which recipes may fill it (tags, read as alternatives — an empty
   * field means „any recipe"), how much of the day it is worth (a share, normalized rather
   * than validated), and how many days one cook in it usually covers.
   *
   * Beneath the rows, the seven weekdays: each either „normalnie" or its own run length. That
   * table is `cookDays`, and it is where „w niedzielę gotuję na 3 dni" is said (decision 272).
   *
   * It all lives on `profile.mealPlan`, so it rides the `profile.json` path to Drive and costs
   * no file, no table and no schema version.
   */

  const GRIP = 'M9 6h.01M9 12h.01M9 18h.01M15 6h.01M15 12h.01M15 18h.01';
  const FLIP_MS = 180;
  const TOUCH_DELAY_MS = 200;

  /** Monday first, as `weekdayIndex` numbers the week (decision 74). */
  const WEEKDAYS = [
    'Poniedziałek',
    'Wtorek',
    'Środa',
    'Czwartek',
    'Piątek',
    'Sobota',
    'Niedziela'
  ];

  /** One row while it is being edited: the stored slot plus the tag labels as typed. */
  interface SlotDraft extends MealSlot {
    /** Labels for `tagKeys`, so the field shows „Śniadanie" and not „sniadanie". */
    tagLabels: string[];
  }

  let loading = $state(true);
  let saving = $state(false);
  let saved = $state(false);
  let resetOpen = $state(false);

  let rows = $state<SlotDraft[]>([]);
  let cookDays = $state<Record<number, number>>({});
  let tags = $state<Tag[]>([]);

  /** What `load` last put on screen, so a background sync cannot tread on an edit. */
  let shown: string | null = null;

  function labelFor(key: string, known: readonly Tag[]): string {
    return known.find((tag) => tag.key === key)?.label ?? key;
  }

  function toDrafts(template: MealPlanTemplate, known: readonly Tag[]): SlotDraft[] {
    return template.slots.map((slot) => ({
      ...slot,
      tagKeys: [...slot.tagKeys],
      tagLabels: slot.tagKeys.map((key) => labelFor(key, known))
    }));
  }

  /** The rows and the weekday table, as one value the sync guard can compare. */
  function snapshot(): string {
    return JSON.stringify({ rows, cookDays });
  }

  async function load(): Promise<void> {
    const [profile, known] = await Promise.all([repository.getProfile(), repository.allTags()]);
    tags = known;

    const template = templateOf(profile.mealPlan);
    // A pull rewrites the profile under an open screen, but an unsaved edit outranks anything
    // the background just fetched — the same rule the goals field follows (decision 227).
    if (shown === null || snapshot() === shown) {
      rows = toDrafts(template, known);
      cookDays = { ...(template.cookDays ?? {}) };
    }
    shown = snapshot();
    loading = false;
  }

  $effect(() => {
    syncState.dataVersion;
    void load();
  });

  function addRow(): void {
    rows = [
      ...rows,
      { id: newId(), label: 'Nowy posiłek', tagKeys: [], tagLabels: [], share: 0.25, batchDays: 1 }
    ];
    saved = false;
  }

  function removeRow(id: string): void {
    rows = rows.filter((row) => row.id !== id);
    saved = false;
  }

  function setBatchDays(id: string, value: number): void {
    rows = rows.map((row) => (row.id === id ? { ...row, batchDays: clampBatchDays(value) } : row));
    saved = false;
  }

  /** „normalnie" is the absence of an entry, not a zero — the slot's own number then wins. */
  function setCookDay(weekday: number, value: number | null): void {
    const next = { ...cookDays };
    if (value === null) delete next[weekday];
    else next[weekday] = clampBatchDays(value);
    cookDays = next;
    saved = false;
  }

  const isPlaceholder = (row: SlotDraft): boolean => row.id === SHADOW_PLACEHOLDER_ITEM_ID;

  function consider(event: CustomEvent<DndEvent<SlotDraft>>): void {
    rows = event.detail.items;
  }

  function finalize(event: CustomEvent<DndEvent<SlotDraft>>): void {
    rows = event.detail.items.filter((row) => !isPlaceholder(row));
    saved = false;
  }

  /** Percentages on screen, fractions in storage — the share column is read as „40%". */
  function setShare(id: string, percent: number): void {
    const share = Number.isFinite(percent) && percent > 0 ? percent / 100 : 0;
    rows = rows.map((row) => (row.id === id ? { ...row, share } : row));
    saved = false;
  }

  async function save(): Promise<void> {
    saving = true;
    const template: MealPlanTemplate = {
      slots: rows.map((row) => ({
        id: row.id,
        label: row.label.trim() === '' ? 'Posiłek' : row.label.trim(),
        // Normalized on save, exactly as the recipe editor normalizes its tags.
        tagKeys: toTagKeys(row.tagLabels),
        share: row.share,
        batchDays: clampBatchDays(row.batchDays)
      })),
      ...(Object.keys(cookDays).length === 0 ? {} : { cookDays })
    };

    await repository.setMealPlan(template);
    shown = snapshot();
    saving = false;
    saved = true;
    scheduleSync();
  }

  async function reset(): Promise<void> {
    resetOpen = false;
    const template = defaultMealPlan();
    rows = toDrafts(template, tags);
    cookDays = {};
    await save();
  }
</script>

<section class="mt-4 rounded-xl border border-(--color-border) bg-(--color-surface-raised) p-4">
  <h2 class="text-base font-semibold">Planer posiłków</h2>
  <p class="pt-2 text-sm text-(--color-ink-muted)">
    Z czego składa się Twój dzień. Tagi w wierszu to alternatywy — „którykolwiek z nich"; pusty
    wiersz przyjmuje dowolny przepis. Udziały nie muszą sumować się do 100% — przeliczamy je.
    Przepis z tagiem „nie-planuj" nigdy nie trafi do propozycji.
  </p>

  {#if loading}
    <p class="pt-3 text-sm text-(--color-ink-muted)">Wczytywanie…</p>
  {:else}
    <ul
      class="flex flex-col gap-3 pt-4"
      aria-label="Posiłki w planerze"
      use:dragHandleZone={{
        items: rows,
        flipDurationMs: FLIP_MS,
        delayTouchStart: TOUCH_DELAY_MS,
        dropTargetStyle: {},
        dropTargetClasses: ['rounded-2xl', 'outline-2', 'outline-dashed', 'outline-(--color-accent)']
      }}
      onconsider={consider}
      onfinalize={finalize}
    >
      {#each rows as row, index (row.id)}
        <li animate:flip={{ duration: FLIP_MS }}>
          {#if isPlaceholder(row)}
            <div class="h-32 rounded-xl border border-dashed border-(--color-border)"></div>
          {:else}
            <div class="flex items-stretch gap-2">
              <div
                use:dragHandle
                class="flex shrink-0 cursor-grab items-center rounded-lg px-1 text-(--color-ink-muted)"
                aria-label="Przenieś posiłek {index + 1}"
              >
                <NavIcon path={GRIP} class="size-5" />
              </div>

              <div class="min-w-0 flex-1 rounded-xl border border-(--color-border) p-3">
                <div class="flex flex-wrap items-end gap-3">
                  <div class="min-w-40 flex-1">
                    <label class="block text-sm font-medium" for="slot-name-{row.id}">Nazwa</label>
                    <input
                      id="slot-name-{row.id}"
                      class="mt-1 w-full rounded-lg border border-(--color-border) bg-(--color-surface-raised) px-3 py-2 text-base outline-none focus:border-(--color-accent)"
                      type="text"
                      bind:value={row.label}
                      oninput={() => (saved = false)}
                    />
                  </div>

                  <div class="w-24">
                    <label class="block text-sm font-medium" for="slot-share-{row.id}">Udział</label>
                    <div class="mt-1 flex items-center gap-1">
                      <input
                        id="slot-share-{row.id}"
                        class="w-full rounded-lg border border-(--color-border) bg-(--color-surface-raised) px-3 py-2 text-base tabular-nums outline-none focus:border-(--color-accent)"
                        type="number"
                        min="0"
                        max="100"
                        step="5"
                        value={Math.round(row.share * 100)}
                        oninput={(event) => setShare(row.id, event.currentTarget.valueAsNumber)}
                      />
                      <span class="text-sm text-(--color-ink-muted)">%</span>
                    </div>
                  </div>

                  <div>
                    <span class="block text-sm font-medium" id="slot-batch-{row.id}">Gotuję na</span>
                    <div
                      class="mt-1 flex overflow-hidden rounded-lg border border-(--color-border)"
                      role="group"
                      aria-labelledby="slot-batch-{row.id}"
                    >
                      {#each [1, 2, MAX_BATCH_DAYS] as length (length)}
                        <button
                          type="button"
                          class="px-3 py-2 text-sm tabular-nums {row.batchDays === length
                            ? 'bg-(--color-accent) text-(--color-accent-ink)'
                            : ''}"
                          aria-pressed={row.batchDays === length}
                          aria-label="{row.label}: gotuję na {length} {length === 1 ? 'dzień' : 'dni'}"
                          onclick={() => setBatchDays(row.id, length)}
                        >
                          {length}
                        </button>
                      {/each}
                    </div>
                  </div>

                  <button
                    type="button"
                    class="rounded-lg border border-(--color-danger-border) px-3 py-2 text-sm font-medium text-(--color-danger)"
                    onclick={() => removeRow(row.id)}
                  >
                    Usuń
                  </button>
                </div>

                <div class="pt-3">
                  <TagInput
                    id="slot-tags-{row.id}"
                    bind:labels={row.tagLabels}
                    {tags}
                  />
                </div>
              </div>
            </div>
          {/if}
        </li>
      {/each}
    </ul>

    <button
      type="button"
      class="mt-3 rounded-lg border border-(--color-border) px-3 py-2 text-sm font-medium"
      onclick={addRow}
    >
      Dodaj posiłek
    </button>

    <h3 class="pt-6 text-sm font-semibold">Dni, w których gotuję inaczej</h3>
    <p class="pt-1 text-sm text-(--color-ink-muted)">
      Niedziela to nie środa: w wolne popołudnie gotuje się garnek na pół tygodnia, a w roboczą
      środę nie gotuje się wcale. Dzień ustawiony tutaj przebija ustawienie posiłku.
    </p>

    <ul class="pt-3">
      {#each WEEKDAYS as name, weekday (name)}
        <li class="flex items-center justify-between gap-3 border-b border-(--color-border) py-2 last:border-b-0">
          <span class="text-sm">{name}</span>
          <div class="flex overflow-hidden rounded-lg border border-(--color-border)" role="group" aria-label="{name}: długość gotowania">
            <button
              type="button"
              class="px-3 py-1.5 text-xs {cookDays[weekday] === undefined
                ? 'bg-(--color-accent) text-(--color-accent-ink)'
                : ''}"
              aria-pressed={cookDays[weekday] === undefined}
              onclick={() => setCookDay(weekday, null)}
            >
              normalnie
            </button>
            {#each [1, 2, MAX_BATCH_DAYS] as length (length)}
              <button
                type="button"
                class="px-3 py-1.5 text-xs tabular-nums {cookDays[weekday] === length
                  ? 'bg-(--color-accent) text-(--color-accent-ink)'
                  : ''}"
                aria-pressed={cookDays[weekday] === length}
                aria-label="{name}: gotuję na {length} {length === 1 ? 'dzień' : 'dni'}"
                onclick={() => setCookDay(weekday, length)}
              >
                {length}
              </button>
            {/each}
          </div>
        </li>
      {/each}
    </ul>

    <div class="flex flex-wrap items-center gap-2 pt-4">
      <button
        type="button"
        class="rounded-lg bg-(--color-accent) px-4 py-2 text-sm font-medium text-(--color-accent-ink) disabled:opacity-40"
        disabled={saving || rows.length === 0}
        onclick={() => void save()}
      >
        {saving ? 'Zapisywanie…' : 'Zapisz planer'}
      </button>
      <button
        type="button"
        class="rounded-lg border border-(--color-border) px-3 py-2 text-sm font-medium"
        onclick={() => (resetOpen = true)}
      >
        Przywróć domyślny
      </button>
      {#if saved}
        <span class="text-sm text-(--color-ink-muted)">Zapisano.</span>
      {/if}
    </div>
  {/if}
</section>

<ConfirmDialog
  open={resetOpen}
  title="Przywrócić domyślny planer?"
  confirmLabel="Przywróć"
  onconfirm={() => void reset()}
  oncancel={() => (resetOpen = false)}
>
  Wrócimy do czterech posiłków (25/40/10/25%), z obiadem gotowanym na 2 dni, i wyczyścimy dni
  gotowane inaczej. Przepisy i plan w kalendarzu zostaną nietknięte.
</ConfirmDialog>
