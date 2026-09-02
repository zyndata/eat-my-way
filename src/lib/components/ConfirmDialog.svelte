<script lang="ts">
  import type { Snippet } from 'svelte';

  /**
   * Modal question with two answers. Built on the platform `<dialog>` element, which brings
   * its own focus trap, background inertness and Escape handling — and, unlike a floating
   * layer positioned from JavaScript, needs no `style` attribute, which the production CSP
   * (`style-src 'self'`) would block. See STATE.md decision 44.
   */

  let {
    open = false,
    title,
    confirmLabel,
    cancelLabel = 'Anuluj',
    danger = false,
    onconfirm,
    oncancel,
    children
  }: {
    open?: boolean;
    title: string;
    confirmLabel: string;
    cancelLabel?: string;
    /** Renders the confirming action as destructive. */
    danger?: boolean;
    onconfirm: () => void;
    oncancel: () => void;
    children?: Snippet;
  } = $props();

  let dialog = $state<HTMLDialogElement>();

  /**
   * Unique per instance. A hardcoded id was fine while one screen held one dialog and became
   * wrong the moment a second appeared: every `aria-labelledby` on the page then resolved to
   * the *first* matching heading, so all of Settings' dialogs announced one title.
   */
  const uid = $props.id();
  const titleId = `confirm-dialog-title-${uid}`;

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
  class="m-auto w-[min(28rem,calc(100vw-2rem))] rounded-2xl border border-(--color-border) bg-(--color-surface-raised) p-5 text-(--color-ink) shadow-xl backdrop:bg-black/40"
  aria-labelledby={titleId}
  oncancel={(event) => {
    // Escape: let the parent close it by flipping `open`, so both paths behave alike.
    event.preventDefault();
    oncancel();
  }}
>
  <h2 id={titleId} class="text-base font-semibold">{title}</h2>

  {#if children}
    <div class="pt-2 text-sm text-(--color-ink-muted)">{@render children()}</div>
  {/if}

  <div class="flex flex-wrap justify-end gap-2 pt-5">
    <button
      type="button"
      class="rounded-lg border border-(--color-border) px-3 py-2 text-sm font-medium"
      onclick={oncancel}
    >
      {cancelLabel}
    </button>
    <button
      type="button"
      class="rounded-lg px-3 py-2 text-sm font-medium text-(--color-accent-ink) {danger
        ? 'bg-red-600'
        : 'bg-(--color-accent)'}"
      onclick={onconfirm}
    >
      {confirmLabel}
    </button>
  </div>
</dialog>
