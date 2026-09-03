<script lang="ts">
  import ConfirmDialog from './ConfirmDialog.svelte';
  import { pluralPl } from '../text';
  import { repository } from '../repository';
  import { vaultState } from '../vault/session.svelte';
  import {
    BackupError,
    backupFileName,
    buildBackup,
    readBackup,
    summarizeBackup,
    type BackupDocument,
    type BackupSummary
  } from '../backup';

  /**
   * „Kopia danych" — the export PLAN.md puts in settings, and the restore that makes it worth
   * having. A file the user cannot read back is a file, not a backup.
   *
   * The whole exchange is a plain JSON download and a plain file picker: no server, no share
   * target, nothing that leaves the device unless the user sends the file somewhere
   * themselves. What travels is in `backup.ts` — and from Phase 10 that includes the vault,
   * because a copy the user has to complete by hand afterwards is not a copy (STATE.md
   * decision 184).
   *
   * Which is why this screen says, at the moment of export and not in small print, which of
   * two files it is about to produce: with encryption on, the Gemini key travels sealed and
   * the password never enters the file; with encryption off, the key is in there in the clear
   * and the file has to be treated like a password.
   */

  let exporting = $state(false);
  let exportedName = $state('');
  let error = $state('');

  /** Parsed and validated, waiting for the user to confirm that it replaces what is here. */
  let pending: BackupDocument | null = null;
  let summary = $state<BackupSummary | null>(null);
  /**
   * What this device holds right now, counted the same way as the file. „What you are about to
   * lose" is the half of the sentence that actually stops a mistake (STATE.md decision 154).
   */
  let current = $state<BackupSummary | null>(null);
  let restoring = $state(false);

  let fileInput = $state<HTMLInputElement | null>(null);

  async function saveBackup(): Promise<void> {
    exporting = true;
    error = '';
    try {
      const backup = buildBackup(await repository.backupInput());
      const name = backupFileName();
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' })
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = name;
      link.click();
      // The blob would otherwise be held for the lifetime of the document.
      URL.revokeObjectURL(url);
      exportedName = name;
    } finally {
      exporting = false;
    }
  }

  async function pickFile(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    // Chosen, then cleared, so picking the same file twice in a row still fires `change`.
    input.value = '';
    if (file === undefined) return;

    error = '';
    exportedName = '';
    try {
      const backup = readBackup(await file.text());
      pending = backup;
      current = summarizeBackup(buildBackup(await repository.backupInput()));
      summary = summarizeBackup(backup);
    } catch (cause) {
      pending = null;
      summary = null;
      current = null;
      error =
        cause instanceof BackupError
          ? cause.message
          : 'Nie udało się odczytać tego pliku.';
    }
  }

  async function restore(): Promise<void> {
    const backup = pending;
    if (backup === null) return;
    restoring = true;
    try {
      await repository.restoreBackup(backup);
      pending = null;
      summary = null;
      // Every screen, the autocomplete index and the sync state hold data that no longer
      // exists. Reloading is both the simplest and the most honest way to start from the
      // restored database; the next load pushes it to Drive if an account is connected.
      window.location.reload();
    } finally {
      restoring = false;
    }
  }

  function formatDate(iso: string): string {
    if (iso === '') return 'nieznanej daty';
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? 'nieznanej daty' : date.toLocaleString('pl-PL');
  }

  /**
   * What the exported file will contain, said in the user's terms. Three states, because
   * „contains your API key" is true in two very different ways and false in the third.
   */
  const vaultNote = $derived.by(() => {
    if (vaultState.status === 'absent') {
      return 'Na tym urządzeniu nie ma jeszcze sejfu, więc w kopii nie będzie żadnego klucza API.';
    }
    if (vaultState.encrypted) {
      return 'Kopia zawiera sejf z kluczem API Gemini — w takiej postaci, w jakiej trzyma go to urządzenie, czyli zaszyfrowany hasłem głównym. Samo hasło nie trafia do pliku: podasz je przy pierwszym imporcie po wczytaniu kopii.';
    }
    return 'Uwaga: sejf na tym urządzeniu nie jest zaszyfrowany, więc klucz API Gemini znajdzie się w pliku otwartym tekstem. Traktuj taki plik jak hasło — nie wysyłaj go mailem i nie zostawiaj w chmurze. Szyfrowanie sejfu włączysz wyżej, w sekcji „Sejf".';
  });

  const buttonClass =
    'rounded-lg bg-(--color-accent) px-3 py-2 text-sm font-medium text-(--color-accent-ink) disabled:opacity-50';
  const secondaryClass = 'rounded-lg border border-(--color-border) px-3 py-2 text-sm font-medium';
</script>

<section class="mt-4 rounded-xl border border-(--color-border) bg-(--color-surface-raised) p-4">
  <h2 class="text-base font-semibold">Kopia danych</h2>
  <p class="pt-2 text-sm text-(--color-ink-muted)">
    Jeden plik JSON z całą zawartością tego urządzenia: cele, przepisy, tagi, własne składniki i
    wszystkie zaplanowane dni. Przyda się, gdy nie korzystasz z Dysku Google — albo po prostu
    chcesz mieć własną kopię.
  </p>
  <p class="pt-2 text-sm {vaultState.status !== 'absent' && !vaultState.encrypted
    ? 'text-(--color-danger)'
    : 'text-(--color-ink-muted)'}">
    {vaultNote}
  </p>

  <div class="flex flex-wrap gap-2 pt-3">
    <button type="button" class={buttonClass} disabled={exporting} onclick={() => void saveBackup()}>
      {exporting ? 'Przygotowywanie…' : 'Zapisz kopię'}
    </button>
    <button type="button" class={secondaryClass} onclick={() => fileInput?.click()}>
      Wczytaj kopię…
    </button>
    <input
      bind:this={fileInput}
      class="hidden"
      type="file"
      accept="application/json,.json"
      onchange={(event) => void pickFile(event)}
    />
  </div>

  {#if exportedName !== ''}
    <p class="pt-2 text-sm text-(--color-ink-muted)" role="status">Zapisano plik {exportedName}.</p>
  {/if}
  {#if error !== ''}
    <p class="pt-2 text-sm text-(--color-danger)" role="alert">{error}</p>
  {/if}
</section>

<!-- A restore replaces everything, so it says what it is about to bring in and what goes. -->
<ConfirmDialog
  open={summary !== null}
  title="Wczytać kopię i zastąpić dane?"
  confirmLabel={restoring ? 'Wczytywanie…' : 'Tak, zastąp dane'}
  danger
  onconfirm={() => void restore()}
  oncancel={() => {
    pending = null;
    summary = null;
    current = null;
  }}
>
  {#if summary !== null}
    Kopia z {formatDate(summary.exportedAt)} zawiera
    {summary.recipes}
    {pluralPl(summary.recipes, { one: 'przepis', few: 'przepisy', many: 'przepisów' })},
    {summary.days}
    {pluralPl(summary.days, { one: 'zaplanowany dzień', few: 'zaplanowane dni', many: 'zaplanowanych dni' })}
    ({summary.meals}
    {pluralPl(summary.meals, { one: 'posiłek', few: 'posiłki', many: 'posiłków' })})
    i {summary.ingredients}
    {pluralPl(summary.ingredients, {
      one: 'własny składnik',
      few: 'własne składniki',
      many: 'własnych składników'
    })}.
  {/if}
  {#if current !== null && current.recipes === 0 && current.days === 0}
    Na tym urządzeniu nie ma jeszcze nic, co mogłoby zostać zastąpione.
  {:else if current !== null}
    Zastąpi to, co jest teraz na tym urządzeniu: {current.recipes}
    {pluralPl(current.recipes, { one: 'przepis', few: 'przepisy', many: 'przepisów' })}
    i {current.days}
    {pluralPl(current.days, {
      one: 'zaplanowany dzień',
      few: 'zaplanowane dni',
      many: 'zaplanowanych dni'
    })}
    ({current.meals}
    {pluralPl(current.meals, { one: 'posiłek', few: 'posiłki', many: 'posiłków' })}).
  {/if}
  {#if summary !== null && summary.vault}
    Kopia zawiera też sejf: zastąpi ten z tego urządzenia, a poprzedni zachowamy, żeby dało się
    to cofnąć — może mieć inne hasło główne.
  {:else}
    Sejf na tym urządzeniu zostanie nietknięty.
  {/if}
  Wbudowana baza składników, identyfikator tego urządzenia i połączenie z Dyskiem zostają bez
  zmian.
</ConfirmDialog>
