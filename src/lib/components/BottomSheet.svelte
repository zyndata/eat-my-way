<script lang="ts">
  import type { Snippet } from 'svelte';

  /**
   * Modal sheet: full width at the bottom on a phone, a centred panel from `md` up. Built on
   * the platform `<dialog>` for the same reasons as `ConfirmDialog` — it brings its own focus
   * trap, background inertness and Escape handling, and needs no positioning through a
   * `style` attribute, which the production CSP would block (STATE.md decisions 44 and 71).
   */

  let {
    open = false,
    title,
    onclose,
    children
  }: {
    open?: boolean;
    title: string;
    onclose: () => void;
    children?: Snippet;
  } = $props();

  let dialog = $state<HTMLDialogElement>();

  // The parent owns `open`; this only mirrors it onto the element.
  $effect(() => {
    const element = dialog;
    if (element === undefined) return;
    if (open && !element.open) element.showModal();
    else if (!open && element.open) element.close();
  });
</script>

<dialog
  bind:this={dialog}
  class="mt-auto mb-0 max-h-[85dvh] w-full max-w-2xl rounded-t-2xl border border-(--color-border) bg-(--color-surface-raised) p-0 text-(--color-ink) shadow-xl backdrop:bg-black/40 md:m-auto md:rounded-2xl"
  aria-labelledby="bottom-sheet-title"
  oncancel={(event) => {
    event.preventDefault();
    onclose();
  }}
>
  <div class="flex max-h-[85dvh] flex-col">
    <header
      class="flex items-center justify-between gap-3 border-b border-(--color-border) px-4 py-3"
    >
      <h2 id="bottom-sheet-title" class="text-base font-semibold">{title}</h2>
      <button
        type="button"
        class="rounded-lg border border-(--color-border) px-3 py-1.5 text-sm font-medium"
        onclick={onclose}
      >
        Zamknij
      </button>
    </header>

    <div class="min-h-0 flex-1 overflow-y-auto p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
      {#if children}{@render children()}{/if}
    </div>
  </div>
</dialog>
