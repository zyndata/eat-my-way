<script lang="ts">
  import type { Tag } from '../types';
  import { rankTags, tagKey } from '../tags';
  import { clampActive, keyAction, moveActive } from '../autocomplete';

  /**
   * Tag field: chips for what the recipe already carries, plus a text input that suggests
   * tags from the library. Labels are kept exactly as typed — normalization to a `key`
   * happens on save, in the repository, so „Śniadanie" and „sniadanie" become one tag.
   *
   * Same combobox conventions as the ingredient autocomplete: focus stays in the input and
   * options commit on `pointerdown`, before the blur that closes the list.
   */

  let {
    id = 'recipe-tags',
    labels = $bindable<string[]>([]),
    tags = [],
    limit = 8
  }: {
    id?: string;
    labels: string[];
    /** Every tag in the library, for suggestions. */
    tags?: Tag[];
    limit?: number;
  } = $props();

  let query = $state('');
  let open = $state(false);
  let active = $state(-1);

  const chosenKeys = $derived(labels.map(tagKey));
  const suggestions = $derived(rankTags(query, tags, { exclude: chosenKeys, limit }));
  const listboxId = $derived(`${id}-listbox`);

  $effect(() => {
    active = clampActive(active, suggestions.length);
  });

  function add(label: string): void {
    const key = tagKey(label);
    if (key === '' || chosenKeys.includes(key)) {
      query = '';
      return;
    }
    labels = [...labels, label.trim()];
    query = '';
    active = -1;
  }

  function remove(index: number): void {
    labels = labels.filter((_, position) => position !== index);
  }

  function onKeydown(event: KeyboardEvent): void {
    // Comma is the other habitual way to end a tag; it never belongs inside one.
    if (event.key === ',') {
      event.preventDefault();
      add(query);
      return;
    }
    if (event.key === 'Backspace' && query === '' && labels.length > 0) {
      remove(labels.length - 1);
      return;
    }

    const action = keyAction(event.key, open);
    if (action === 'none') {
      // Enter on a closed list still commits what was typed instead of submitting the form.
      if (event.key === 'Enter') {
        event.preventDefault();
        add(query);
      }
      return;
    }

    if (action === 'close') {
      if (event.key === 'Escape') event.preventDefault();
      open = false;
      active = -1;
      return;
    }

    event.preventDefault();

    if (action === 'open') {
      open = true;
      return;
    }
    if (action === 'select') {
      // Nothing highlighted means "take what I typed", not "take the first guess".
      add(suggestions[active]?.label ?? query);
      return;
    }
    active = moveActive(active, suggestions.length, action);
  }
</script>

<div>
  <label class="block text-sm font-medium" for={id}>Tagi</label>

  {#if labels.length > 0}
    <ul class="flex flex-wrap gap-2 pt-2">
      {#each labels as label, index (label)}
        <li
          class="flex items-center gap-1 rounded-full bg-(--color-accent) py-1 pr-1 pl-3 text-sm text-(--color-accent-ink)"
        >
          {label}
          <button
            type="button"
            class="rounded-full px-1.5 leading-none"
            aria-label="Usuń tag {label}"
            onclick={() => remove(index)}
          >
            ×
          </button>
        </li>
      {/each}
    </ul>
  {/if}

  <div class="relative pt-2">
    <!-- svelte-ignore a11y_autocomplete_valid -- 'list' is the ARIA combobox convention here -->
    <input
      {id}
      class="w-full rounded-lg border border-(--color-border) bg-(--color-surface-raised) px-3 py-2 text-base outline-none focus:border-(--color-accent)"
      type="text"
      role="combobox"
      autocomplete="off"
      aria-expanded={open}
      aria-controls={listboxId}
      aria-autocomplete="list"
      aria-activedescendant={open && active >= 0 ? `${id}-option-${active}` : undefined}
      placeholder="np. obiad, szybkie"
      bind:value={query}
      oninput={() => {
        open = true;
        active = -1;
      }}
      onkeydown={onKeydown}
      onfocus={() => (open = true)}
      onblur={() => (open = false)}
    />

    {#if open && suggestions.length > 0}
      <ul
        id={listboxId}
        class="absolute inset-x-0 top-full z-10 mt-1 max-h-60 overflow-y-auto overscroll-contain rounded-lg border border-(--color-border) bg-(--color-surface-raised) py-1 shadow-lg"
        role="listbox"
        aria-label="Podpowiedzi tagów"
      >
        {#each suggestions as tag, position (tag.key)}
          <li
            id="{id}-option-{position}"
            class="cursor-pointer px-3 py-2 text-sm {position === active
              ? 'bg-(--color-accent) text-(--color-accent-ink)'
              : ''}"
            role="option"
            aria-selected={position === active}
            onpointerdown={(event) => {
              event.preventDefault();
              add(tag.label);
            }}
            onpointerenter={() => (active = position)}
          >
            {tag.label}
            <span class={position === active ? 'text-(--color-accent-ink)/80' : 'text-(--color-ink-muted)'}>
              · {tag.useCount}
            </span>
          </li>
        {/each}
      </ul>
    {/if}
  </div>

  <p class="pt-1 text-xs text-(--color-ink-muted)">
    Enter lub przecinek dodaje tag. Wielkość liter i polskie znaki nie tworzą duplikatów.
  </p>
</div>
