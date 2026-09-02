<script lang="ts">
  import type { Tag } from '../types';
  import { planTagRename } from '../tags';
  import { pluralPl } from '../text';
  import { repository } from '../repository';
  import { scheduleSync } from '../sync/state.svelte';
  import ConfirmDialog from './ConfirmDialog.svelte';

  /**
   * Tag management (PLAN.md Phase 9 task 2): rename, delete, merge.
   *
   * Until this existed a typo in a tag could only be fixed recipe by recipe (STATE.md
   * decision 60). All three operations rewrite the recipes that carry the key and then let
   * the repository **recount** `useCount` from the recipes themselves — never patch it, or a
   * merge of two tags a recipe already carried both of would count it twice.
   *
   * A rename whose new spelling normalizes to a key another tag already holds is not a
   * rename, it is a merge, and it is asked about rather than performed quietly:
   * „Sniadanie” and „Śniadanie” are one key.
   */

  let tags = $state<Tag[]>([]);
  let loading = $state(true);
  let busy = $state(false);

  /** Tag being renamed, and the text in its field. */
  let editingKey = $state<string | null>(null);
  let editingLabel = $state('');
  let error = $state('');

  let deleting = $state<Tag | null>(null);
  /** A rename that turned out to be a merge, waiting for the answer. */
  let mergeFrom = $state<Tag | null>(null);
  let mergeInto = $state<Tag | null>(null);

  async function load(): Promise<void> {
    loading = true;
    tags = await repository.allTags();
    loading = false;
  }

  function startEdit(tag: Tag): void {
    editingKey = tag.key;
    editingLabel = tag.label;
    error = '';
  }

  function cancelEdit(): void {
    editingKey = null;
    editingLabel = '';
    error = '';
  }

  async function applyRename(tag: Tag): Promise<void> {
    const plan = planTagRename(tag, editingLabel, tags);

    if (plan.kind === 'invalid') {
      error = 'Tag musi mieć nazwę.';
      return;
    }
    if (plan.kind === 'noop') {
      cancelEdit();
      return;
    }
    if (plan.kind === 'merge') {
      // The spelling collides with a tag that already exists — ask before folding them.
      mergeFrom = tag;
      mergeInto = tags.find((other) => other.key === plan.to) ?? null;
      return;
    }

    busy = true;
    try {
      await repository.renameTag(tag.key, editingLabel);
      scheduleSync();
      cancelEdit();
      await load();
    } finally {
      busy = false;
    }
  }

  async function confirmMerge(): Promise<void> {
    const from = mergeFrom;
    const into = mergeInto;
    mergeFrom = null;
    mergeInto = null;
    if (from === null || into === null) return;

    busy = true;
    try {
      await repository.mergeTags(from.key, into.key);
      scheduleSync();
      cancelEdit();
      await load();
    } finally {
      busy = false;
    }
  }

  async function confirmDelete(): Promise<void> {
    const tag = deleting;
    deleting = null;
    if (tag === null) return;

    busy = true;
    try {
      await repository.deleteTag(tag.key);
      scheduleSync();
      await load();
    } finally {
      busy = false;
    }
  }

  function recipeCount(count: number): string {
    return `${count} ${pluralPl(count, {
      one: 'przepis',
      few: 'przepisy',
      many: 'przepisów'
    })}`;
  }

  void load();
</script>

<section class="mt-4 rounded-xl border border-(--color-border) bg-(--color-surface-raised) p-4">
  <h2 class="text-base font-semibold">Tagi</h2>
  <p class="pt-2 text-sm text-(--color-ink-muted)">
    Zmiana nazwy, usunięcie i łączenie tagów. Każda z tych operacji przepisuje wszystkie
    przepisy, które ten tag noszą — same przepisy zostają nietknięte.
  </p>

  {#if loading}
    <p class="pt-3 text-sm text-(--color-ink-muted)">Wczytywanie…</p>
  {:else if tags.length === 0}
    <p class="pt-3 text-sm text-(--color-ink-muted)">
      Nie masz jeszcze żadnych tagów. Powstają same, kiedy nadasz je przepisowi.
    </p>
  {:else}
    <ul class="flex flex-col gap-2 pt-3">
      {#each tags as tag (tag.key)}
        <li class="rounded-lg border border-(--color-border) p-3">
          {#if editingKey === tag.key}
            <label class="block text-sm font-medium">
              Nowa nazwa tagu
              <input
                class="mt-1 w-full rounded-lg border border-(--color-border) bg-(--color-surface-raised) px-3 py-2 text-base font-normal outline-none focus:border-(--color-accent)"
                type="text"
                bind:value={editingLabel}
              />
            </label>
            {#if error !== ''}
              <p class="pt-1 text-xs text-red-700">{error}</p>
            {/if}
            <div class="flex flex-wrap gap-2 pt-2">
              <button
                type="button"
                class="rounded-lg bg-(--color-accent) px-3 py-2 text-sm font-medium text-(--color-accent-ink) disabled:opacity-50"
                disabled={busy}
                onclick={() => void applyRename(tag)}
              >
                Zapisz
              </button>
              <button
                type="button"
                class="rounded-lg border border-(--color-border) px-3 py-2 text-sm font-medium"
                onclick={cancelEdit}
              >
                Anuluj
              </button>
            </div>
          {:else}
            <div class="flex flex-wrap items-center justify-between gap-2">
              <div class="min-w-0">
                <p class="truncate text-sm font-medium">{tag.label}</p>
                <p class="text-xs text-(--color-ink-muted)">{recipeCount(tag.useCount)}</p>
              </div>
              <div class="flex shrink-0 gap-2">
                <button
                  type="button"
                  class="rounded-lg border border-(--color-border) px-3 py-1.5 text-sm font-medium disabled:opacity-50"
                  disabled={busy}
                  onclick={() => startEdit(tag)}
                >
                  Zmień nazwę
                </button>
                <button
                  type="button"
                  class="rounded-lg border border-red-600 px-3 py-1.5 text-sm font-medium text-red-700 disabled:opacity-50"
                  disabled={busy}
                  onclick={() => (deleting = tag)}
                >
                  Usuń
                </button>
              </div>
            </div>
          {/if}
        </li>
      {/each}
    </ul>

    {#if tags.length > 1}
      <div class="pt-4">
        <h3 class="text-sm font-semibold">Połącz dwa tagi</h3>
        <p class="pt-1 text-xs text-(--color-ink-muted)">
          Pierwszy tag zniknie, a wszystkie jego przepisy dostaną drugi.
        </p>
        <div class="flex flex-wrap items-end gap-2 pt-2">
          <label class="text-sm font-medium">
            <span class="block text-xs text-(--color-ink-muted)">Zniknie</span>
            <select
              class="mt-1 rounded-lg border border-(--color-border) bg-(--color-surface-raised) px-2 py-2 text-sm outline-none focus:border-(--color-accent)"
              value={mergeFrom?.key ?? ''}
              onchange={(event) =>
                (mergeFrom = tags.find((tag) => tag.key === event.currentTarget.value) ?? null)}
            >
              <option value="">—</option>
              {#each tags as tag (tag.key)}
                <option value={tag.key}>{tag.label}</option>
              {/each}
            </select>
          </label>
          <label class="text-sm font-medium">
            <span class="block text-xs text-(--color-ink-muted)">Zostanie</span>
            <select
              class="mt-1 rounded-lg border border-(--color-border) bg-(--color-surface-raised) px-2 py-2 text-sm outline-none focus:border-(--color-accent)"
              value={mergeInto?.key ?? ''}
              onchange={(event) =>
                (mergeInto = tags.find((tag) => tag.key === event.currentTarget.value) ?? null)}
            >
              <option value="">—</option>
              {#each tags as tag (tag.key)}
                <option value={tag.key}>{tag.label}</option>
              {/each}
            </select>
          </label>
        </div>
      </div>
    {/if}
  {/if}
</section>

<!-- One dialog for both routes into a merge: the picker above, and a rename that turned out
     to collide with a tag that already exists. -->
<ConfirmDialog
  open={mergeFrom !== null && mergeInto !== null && mergeFrom.key !== mergeInto.key}
  title="Połączyć tagi?"
  confirmLabel="Połącz"
  onconfirm={() => void confirmMerge()}
  oncancel={() => {
    mergeFrom = null;
    mergeInto = null;
  }}
>
  Tag „{mergeFrom?.label}” zniknie, a wszystkie jego przepisy dostaną „{mergeInto?.label}”.
  Przepis, który nosi oba, policzy się tylko raz.
</ConfirmDialog>

<ConfirmDialog
  open={deleting !== null}
  title="Usunąć tag?"
  confirmLabel="Usuń"
  danger
  onconfirm={() => void confirmDelete()}
  oncancel={() => (deleting = null)}
>
  Tag „{deleting?.label}” zniknie z {recipeCount(deleting?.useCount ?? 0)}. Same przepisy
  zostaną nietknięte.
</ConfirmDialog>
