<script lang="ts">
  import BottomSheet from './BottomSheet.svelte';
  import { repository } from '../repository';
  import { GeminiError } from '../gemini/client';
  import { importRecipe, type ImportStage, type ImportedRecipe } from '../gemini/import';
  import { looksLikeUrl } from '../gemini/parse';
  import { recordGeminiUsage } from '../gemini/usage';
  import { scheduleSync } from '../sync/state.svelte';
  import { geminiApiKey, requestUnlock, vaultState } from '../vault/session.svelte';

  /**
   * „Wklej przepis z internetu" (PLAN.md Phase 7 task 3).
   *
   * One field, because one look at the string says whether it is a link or a recipe. The sheet
   * writes nothing: it hands an `ImportedRecipe` to the editor, and the editor's own „Zapisz
   * przepis" stays the only path to IndexedDB.
   *
   * The vault is unlocked here and nowhere earlier — PLAN.md reserves the unlock prompt for the
   * moment a Gemini call actually needs the key, so the calendar and the library never trigger it.
   */

  let {
    open = false,
    onclose,
    onimport,
    nextKey
  }: {
    open?: boolean;
    onclose: () => void;
    onimport: (result: ImportedRecipe) => void;
    /** Row keys, so imported rows share the editor's `{#each}` identity space. */
    nextKey: () => string;
  } = $props();

  const STAGES: Record<ImportStage, string> = {
    'reading-page': 'Czytam stronę…',
    parsing: 'Rozpisuję składniki…',
    matching: 'Dopasowuję składniki do bazy…'
  };

  let input = $state('');
  let busy = $state(false);
  /** What the user is waiting for, so a three-call import does not look frozen. */
  let stage = $state('');
  let error = $state('');

  const isLink = $derived(looksLikeUrl(input));

  function reset(): void {
    input = '';
    busy = false;
    stage = '';
    error = '';
  }

  async function run(): Promise<void> {
    if (busy || input.trim() === '') return;
    error = '';
    busy = true;
    try {
      if (vaultState.status !== 'unlocked') {
        stage = 'Czekam na odblokowanie sejfu…';
        const opened = await requestUnlock();
        if (!opened) {
          error = 'Import wymaga klucza Gemini z sejfu. Odblokuj sejf i spróbuj ponownie.';
          return;
        }
      }

      const apiKey = geminiApiKey();
      if (apiKey === undefined || apiKey.trim() === '') {
        error =
          'W sejfie nie ma klucza API Gemini. Dodaj go w Ustawieniach — import to jedyna funkcja, ' +
          'która go potrzebuje.';
        return;
      }

      const profile = await repository.getProfile();

      const result = await importRecipe(input, {
        apiKey,
        model: profile.geminiModel,
        nextKey,
        onstage: (next) => (stage = STAGES[next]),
        // The tally travels in profile.json so the free tier's 20/day is counted across every
        // device on the account, not per browser (STATE.md decision 127).
        // Tallied against the model that was actually called: the quota is charged per model,
        // and the per-model limits differ by more than 20x (STATE.md decision 129).
        onusage: (spent) =>
          void recordGeminiUsage(spent, profile.geminiModel).then(() => scheduleSync())
      });

      onimport(result);
      reset();
    } catch (caught) {
      // `GeminiError` messages are Polish and carry no key; anything else is a bug, not a
      // response, so it is reported without quoting it.
      error =
        caught instanceof GeminiError
          ? caught.message
          : 'Import nie powiódł się. Spróbuj ponownie za chwilę.';
    } finally {
      busy = false;
      stage = '';
    }
  }
</script>

<BottomSheet {open} title="Wklej przepis z internetu" onclose={onclose}>
  <div class="flex flex-col gap-4">
    <label class="block text-sm font-medium">
      Link do przepisu albo jego treść
      <textarea
        class="mt-1 w-full rounded-lg border border-(--color-border) bg-(--color-surface-raised) px-3 py-2 text-base font-normal outline-none focus:border-(--color-accent)"
        rows="6"
        placeholder="https://… albo wklej cały przepis"
        disabled={busy}
        bind:value={input}
      ></textarea>
    </label>

    <p class="text-xs text-(--color-ink-muted)">
      {#if isLink}
        Stronę otwiera Gemini, nie ta aplikacja. Jeśli przepis jest za logowaniem albo strona nie
        da się odczytać, skopiuj treść i wklej ją tutaj.
      {:else}
        Gemini rozpisze składniki i sposób przygotowania. Kalorie i makroskładniki liczymy sami,
        z lokalnej bazy — model nigdy ich nie podaje, żeby ten sam posiłek zawsze wychodził
        tak samo.
      {/if}
    </p>

    {#if error !== ''}
      <p class="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
        {error}
      </p>
    {/if}

    {#if busy}
      <p class="text-sm text-(--color-ink-muted)">{stage === '' ? 'Pracuję…' : stage}</p>
    {/if}

    <div class="flex flex-wrap items-center gap-2">
      <button
        type="button"
        class="rounded-lg bg-(--color-accent) px-4 py-2 text-sm font-medium text-(--color-accent-ink) disabled:opacity-50"
        disabled={busy || input.trim() === ''}
        onclick={() => void run()}
      >
        {busy ? 'Importuję…' : 'Importuj'}
      </button>
      <button
        type="button"
        class="rounded-lg border border-(--color-border) px-4 py-2 text-sm font-medium"
        disabled={busy}
        onclick={onclose}
      >
        Anuluj
      </button>
    </div>
  </div>
</BottomSheet>
