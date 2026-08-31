<script lang="ts">
  import {
    ATTEMPTS_BEFORE_EXPLANATION,
    closeUnlockPrompt,
    unlock,
    unlockPrompt,
    vaultState
  } from '../vault/session.svelte';

  /**
   * The unlock screen. It is a modal rather than a route because it interrupts whatever the
   * user was doing (a recipe import) and hands control straight back afterwards — a route
   * would lose the half-filled editor behind it.
   *
   * Everything except a Gemini call works with the vault locked, so "Nie teraz" is a first
   * class answer and not a dead end.
   */

  let dialog = $state<HTMLDialogElement>();
  let password = $state('');

  $effect(() => {
    const element = dialog;
    if (element === undefined) return;
    if (unlockPrompt.open && !element.open) element.showModal();
    else if (!unlockPrompt.open && element.open) element.close();
  });

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const result = await unlock(password);
    if (result !== 'unlocked') return;
    password = '';
    closeUnlockPrompt(true);
  }

  function dismiss(): void {
    password = '';
    closeUnlockPrompt(false);
  }
</script>

<dialog
  bind:this={dialog}
  class="m-auto w-[min(26rem,calc(100vw-2rem))] rounded-2xl border border-(--color-border) bg-(--color-surface-raised) p-5 text-(--color-ink) shadow-xl backdrop:bg-black/40"
  aria-labelledby="vault-unlock-title"
  oncancel={(event) => {
    event.preventDefault();
    dismiss();
  }}
>
  <h2 id="vault-unlock-title" class="text-base font-semibold">Odblokuj sejf</h2>
  <p class="pt-2 text-sm text-(--color-ink-muted)">
    Klucz Gemini jest zaszyfrowany hasłem głównym. Kalendarz i przepisy działają bez tego —
    hasło jest potrzebne tylko do importu przepisów.
  </p>

  <form onsubmit={submit}>
    <label class="block pt-4 text-sm font-medium">
      Hasło główne
      <input
        class="mt-1 w-full rounded-lg border border-(--color-border) bg-(--color-surface) px-3 py-2 text-base font-normal outline-none focus:border-(--color-accent)"
        type="password"
        autocomplete="current-password"
        bind:value={password}
        disabled={vaultState.busy}
      />
    </label>

    {#if vaultState.message !== ''}
      <p class="pt-2 text-sm text-red-700" role="alert">{vaultState.message}</p>
    {/if}
    {#if vaultState.failedAttempts >= ATTEMPTS_BEFORE_EXPLANATION}
      <a class="mt-2 inline-block text-sm text-(--color-accent) underline" href="#/settings">
        Załóż sejf od nowa w Ustawieniach
      </a>
    {/if}

    <div class="flex flex-wrap justify-end gap-2 pt-5">
      <button
        type="button"
        class="rounded-lg border border-(--color-border) px-3 py-2 text-sm font-medium"
        onclick={dismiss}
      >
        Nie teraz
      </button>
      <button
        type="submit"
        class="rounded-lg bg-(--color-accent) px-3 py-2 text-sm font-medium text-(--color-accent-ink) disabled:opacity-50"
        disabled={vaultState.busy || password === ''}
      >
        {vaultState.busy ? 'Odszyfrowywanie…' : 'Odblokuj'}
      </button>
    </div>
  </form>
</dialog>
