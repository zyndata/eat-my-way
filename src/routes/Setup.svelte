<script lang="ts">
  import { push } from 'svelte-spa-router';
  import Screen from '../lib/components/Screen.svelte';
  import GoalsForm from '../lib/components/GoalsForm.svelte';
  import Spinner from '../lib/components/Spinner.svelte';
  import type { Macros } from '../lib/types';
  import { DEFAULT_GOALS } from '../lib/db';
  import { repository } from '../lib/repository';
  import { AI_STUDIO_KEY_URL, testGeminiKey, type KeyTestResult } from '../lib/gemini/key-test';
  import {
    STAGE_LABELS,
    connectDrive,
    syncNow,
    syncState,
    useDifferentAccount
  } from '../lib/sync/state.svelte';
  import { createVault, saveSecrets, vaultState } from '../lib/vault/session.svelte';

  /**
   * The first-run wizard (PLAN.md "First-run wizard", steps 1–6).
   *
   * The order matters and is not arbitrary: the master password comes *before* the API key,
   * because the key goes inside the vault the password protects. Every step after Drive is
   * skippable — a user who wants to start planning meals immediately can, and finish this in
   * settings later.
   *
   * From Phase 11 the wizard is also reachable without Drive at all (`isNeverUsed`, in
   * `App.svelte`), so leaving it writes the `setupDone` meta key: the Drive-driven flag lives
   * in memory and is re-set by every sync, and a locally triggered wizard has nothing to re-set
   * it — without the key, every reload would reopen it (STATE.md decision 193).
   */

  type Step = 'drive' | 'profile' | 'password' | 'key' | 'goals' | 'done';

  let step = $state<Step>('drive');
  let error = $state('');

  let encrypt = $state(true);
  let password = $state('');
  let repeat = $state('');
  let acknowledgedPlaintext = $state(false);

  let apiKey = $state('');
  let keyResult = $state<KeyTestResult | null>(null);
  let testing = $state(false);

  let goals = $state<Macros>({ ...DEFAULT_GOALS });

  /**
   * Leaving the wizard clears the in-memory flag and records, on this device, that the wizard
   * has been through. `meta` never travels to Drive, which is exactly right: what is recorded
   * is that *this browser* has been offered the wizard, not that the account has.
   */
  function leave(target: string): void {
    syncState.setupNeeded = false;
    void repository.setMeta('setupDone', true);
    void push(target);
  }

  async function connect(): Promise<void> {
    error = '';
    const outcome = await connectDrive();
    if (outcome.status === 'ok') {
      step = 'profile';
      return;
    }
    if (outcome.status === 'foreign-account') return; // handled by its own panel below
    error =
      syncState.message === ''
        ? 'Nie udało się połączyć z Dyskiem Google. Spróbuj ponownie.'
        : syncState.message;
  }

  async function makeVault(): Promise<void> {
    error = '';
    if (encrypt) {
      if (password.length < 8) {
        error = 'Hasło musi mieć co najmniej 8 znaków.';
        return;
      }
      if (password !== repeat) {
        error = 'Hasła nie są identyczne.';
        return;
      }
    } else if (!acknowledgedPlaintext) {
      error = 'Zaznacz, że rozumiesz konsekwencje.';
      return;
    }

    await createVault(encrypt, password);
    password = '';
    repeat = '';
    void syncNow();
    step = 'key';
  }

  async function checkKey(): Promise<void> {
    testing = true;
    keyResult = await testGeminiKey(apiKey);
    testing = false;
    if (keyResult.status !== 'ok') return;
    await saveSecrets({ geminiApiKey: apiKey.trim() });
    apiKey = '';
    void syncNow();
    step = 'goals';
  }

  async function saveGoals(next: Macros): Promise<void> {
    await repository.setGoals(next);
    void syncNow();
    step = 'done';
  }

  const inputClass =
    'mt-1 w-full rounded-lg border border-(--color-border) bg-(--color-surface-raised) px-3 py-2 text-base font-normal outline-none focus:border-(--color-accent)';
  const buttonClass =
    'rounded-lg bg-(--color-accent) px-3 py-2 text-sm font-medium text-(--color-accent-ink) disabled:opacity-50';
  const secondaryClass = 'rounded-lg border border-(--color-border) px-3 py-2 text-sm font-medium';

  const steps: { key: Step; label: string }[] = [
    { key: 'drive', label: 'Dysk' },
    { key: 'profile', label: 'Profil' },
    { key: 'password', label: 'Hasło' },
    { key: 'key', label: 'Gemini' },
    { key: 'goals', label: 'Cele' }
  ];
  const currentIndex = $derived(steps.findIndex((entry) => entry.key === step));
</script>

<Screen title="Pierwsze uruchomienie" lead="Kilka kroków i możesz planować.">
  <ol class="flex flex-wrap gap-2 text-xs" aria-label="Kroki kreatora">
    {#each steps as entry, index (entry.key)}
      <li
        class="rounded-full border px-2 py-1 {index <= currentIndex
          ? 'border-(--color-accent) text-(--color-accent)'
          : 'border-(--color-border) text-(--color-ink-muted)'}"
        aria-current={entry.key === step ? 'step' : undefined}
      >
        {index + 1}. {entry.label}
      </li>
    {/each}
  </ol>

  <div class="mt-4 rounded-xl border border-(--color-border) bg-(--color-surface-raised) p-4">
    {#if step === 'drive'}
      <h2 class="text-base font-semibold">1. Połącz Dysk Google</h2>
      <p class="pt-2 text-sm text-(--color-ink-muted)">
        Dane trafiają do prywatnego folderu aplikacji na Twoim Dysku. Aplikacja nie widzi żadnych
        innych Twoich plików. Bez tego kroku wszystko działa, ale tylko na tym urządzeniu.
      </p>

      {#if syncState.foreignAccount !== null}
        <div class="mt-3 rounded-lg border border-(--color-warn-border) bg-(--color-warn-surface) p-3 text-sm">
          <p class="font-medium">To konto Google jest inne niż to, z którego pochodzą dane tutaj.</p>
          <p class="pt-1 text-(--color-ink-muted)">
            Nie zakładamy po cichu nowego profilu. Wybierz świadomie.
          </p>
          <div class="flex flex-wrap gap-2 pt-3">
            <button
              type="button"
              class={buttonClass}
              onclick={async () => {
                if ((await useDifferentAccount()).status === 'ok') step = 'profile';
              }}
            >
              Używaj tego konta
            </button>
          </div>
        </div>
      {/if}

      {#if error !== ''}
        <p class="pt-2 text-sm text-(--color-danger)" role="alert">{error}</p>
      {/if}

      <div class="flex flex-wrap gap-2 pt-4">
        <button
          type="button"
          class="{buttonClass} inline-flex items-center gap-2"
          disabled={!syncState.configured || syncState.phase === 'syncing'}
          onclick={() => void connect()}
        >
          {#if syncState.phase === 'syncing'}
            <Spinner />
            {syncState.stage === null ? 'Łączenie…' : STAGE_LABELS[syncState.stage]}
          {:else}
            Połącz Dysk Google
          {/if}
        </button>
        <button type="button" class={secondaryClass} onclick={() => (step = 'password')}>
          Pomiń — tylko to urządzenie
        </button>
      </div>
    {:else if step === 'profile'}
      <h2 class="text-base font-semibold">2. Twój profil</h2>
      <p class="pt-2 text-sm text-(--color-ink-muted)">
        W folderze aplikacji na tym koncie nie ma jeszcze żadnych danych.
      </p>
      <div class="flex flex-wrap gap-2 pt-4">
        <button type="button" class={buttonClass} onclick={() => (step = 'password')}>
          Utwórz nowy profil
        </button>
        <button type="button" class={secondaryClass} onclick={() => (step = 'drive')}>
          Mam już dane na innym koncie
        </button>
      </div>
      <p class="pt-2 text-xs text-(--color-ink-muted)">
        Jeśli Twoje dane są na innym koncie Google, wróć do kroku 1 i połącz tamto konto.
      </p>
    {:else if step === 'password'}
      <h2 class="text-base font-semibold">3. Hasło główne</h2>
      <p class="pt-2 text-sm text-(--color-ink-muted)">
        Hasło chroni sejf, w którym trzymamy klucz API do Gemini. Kalendarz i przepisy są poza
        sejfem i działają bez tego hasła.
      </p>
      <p class="pt-2 text-sm font-medium">
        Hasła głównego nie da się odzyskać — nikt go nie przechowuje.
      </p>

      <label class="flex items-center gap-2 pt-4 text-sm">
        <input type="checkbox" bind:checked={encrypt} />
        Szyfruj sejf hasłem (zalecane)
      </label>

      {#if encrypt}
        <label class="block pt-3 text-sm font-medium">
          Hasło główne
          <input class={inputClass} type="password" autocomplete="new-password" bind:value={password} />
        </label>
        <label class="block pt-2 text-sm font-medium">
          Powtórz hasło
          <input class={inputClass} type="password" autocomplete="new-password" bind:value={repeat} />
        </label>
      {:else}
        <div class="mt-3 rounded-lg border border-(--color-warn-border) bg-(--color-warn-surface) p-3 text-sm">
          <p class="font-medium">Sejf bez szyfrowania</p>
          <p class="pt-1 text-(--color-ink-muted)">
            Klucz Gemini będzie zapisany otwartym tekstem na tym urządzeniu i na Twoim Dysku
            Google. Każdy, kto ma do nich dostęp, będzie mógł go odczytać.
          </p>
          <label class="flex items-center gap-2 pt-3">
            <input type="checkbox" bind:checked={acknowledgedPlaintext} />
            Rozumiem i chcę tak zrobić
          </label>
        </div>
      {/if}

      {#if error !== ''}
        <p class="pt-2 text-sm text-(--color-danger)" role="alert">{error}</p>
      {/if}

      <div class="flex flex-wrap gap-2 pt-4">
        <button type="button" class={buttonClass} disabled={vaultState.busy} onclick={() => void makeVault()}>
          {vaultState.busy ? 'Tworzenie sejfu…' : 'Dalej'}
        </button>
      </div>
    {:else if step === 'key'}
      <h2 class="text-base font-semibold">4. Klucz API Gemini</h2>
      <p class="pt-2 text-sm text-(--color-ink-muted)">
        Klucz jest potrzebny tylko do importu przepisów z internetu. Utworzysz go w Google AI
        Studio —
        <a
          class="font-medium text-(--color-accent) underline"
          href={AI_STUDIO_KEY_URL}
          target="_blank"
          rel="noopener noreferrer">aistudio.google.com/apikey</a>. Sprawdzimy go od razu i
        zapiszemy dopiero, gdy zadziała.
      </p>
      <label class="block pt-3 text-sm font-medium">
        Klucz API
        <input class={inputClass} type="password" autocomplete="off" bind:value={apiKey} />
      </label>

      {#if keyResult !== null}
        <p
          class="pt-2 text-sm {keyResult.status === 'ok' ? 'text-(--color-ink-muted)' : 'text-(--color-danger)'}"
          role="status"
        >
          {keyResult.message}
        </p>
      {/if}

      <div class="flex flex-wrap gap-2 pt-4">
        <button type="button" class={buttonClass} disabled={testing} onclick={() => void checkKey()}>
          {testing ? 'Sprawdzanie…' : 'Sprawdź i zapisz'}
        </button>
        <button type="button" class={secondaryClass} onclick={() => (step = 'goals')}>
          Ustawię później
        </button>
      </div>
    {:else if step === 'goals'}
      <h2 class="text-base font-semibold">5. Cele dzienne</h2>
      <p class="pt-2 text-sm text-(--color-ink-muted)">
        Możesz je wpisać teraz albo zostawić domyślne i zmienić kiedykolwiek w Ustawieniach.
      </p>
      <div class="pt-3">
        <GoalsForm bind:goals onsave={(next) => void saveGoals(next)} />
      </div>
      <button type="button" class="{secondaryClass} mt-3" onclick={() => (step = 'done')}>
        Ustawię później
      </button>
    {:else}
      <h2 class="text-base font-semibold">Gotowe</h2>
      <p class="pt-2 text-sm text-(--color-ink-muted)">
        Wszystko przygotowane. Możesz zacząć planować posiłki.
      </p>
      <button type="button" class="{buttonClass} mt-4" onclick={() => leave('/')}>
        Przejdź do dzisiaj
      </button>
    {/if}
  </div>

  {#if step !== 'done'}
    <button type="button" class="pt-3 text-sm text-(--color-accent) underline" onclick={() => leave('/')}>
      Pomiń kreator
    </button>
  {/if}
</Screen>
