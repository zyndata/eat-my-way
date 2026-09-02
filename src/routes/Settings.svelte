<script lang="ts">
  import Screen from '../lib/components/Screen.svelte';
  import ConfirmDialog from '../lib/components/ConfirmDialog.svelte';
  import GoalsForm from '../lib/components/GoalsForm.svelte';
  import BackupSection from '../lib/components/BackupSection.svelte';
  import InstallSection from '../lib/components/InstallSection.svelte';
  import TagSection from '../lib/components/TagSection.svelte';
  import type { Macros, Profile } from '../lib/types';
  import { repository } from '../lib/repository';
  import { DEFAULT_GEMINI_MODEL } from '../lib/db';
  import { testGeminiKey, type KeyTestResult } from '../lib/gemini/key-test';
  import { REQUESTS_PER_IMPORT, quotaDay } from '../lib/gemini/usage';
  import { listGeminiModels, withCurrentModel, type GeminiModel } from '../lib/gemini/models';
  import { geminiUsageByModel, modelGeminiUsage } from '../lib/sync/documents';
  import { pluralPl } from '../lib/text';
  import {
    connectDrive,
    disconnectDrive,
    syncNow,
    syncState,
    useDifferentAccount
  } from '../lib/sync/state.svelte';
  import {
    createVault,
    disableEncryption,
    geminiApiKey,
    lockVault,
    requestUnlock,
    forgetVault,
    restoreReplacedVault,
    saveSecrets,
    setPassword,
    vaultState
  } from '../lib/vault/session.svelte';

  /**
   * Settings. Three independent sections — Drive, the vault, the goals — and none of them can
   * break the other two: the calendar keeps working with Drive disconnected and the vault
   * locked, which is the whole point of keeping IndexedDB as the source of truth.
   */

  let profile = $state<Profile | null>(null);
  let goals = $state<Macros>({ kcal: 0, protein: 0, carbs: 0, fat: 0 });
  let savingGoals = $state(false);
  let goalsSaved = $state(false);

  let model = $state(DEFAULT_GEMINI_MODEL);
  let modelSaved = $state(false);

  let apiKey = $state('');
  let keyResult = $state<KeyTestResult | null>(null);
  let testingKey = $state(false);

  let newPassword = $state('');
  let repeatPassword = $state('');
  let passwordMessage = $state('');

  /** Disabling encryption asks twice (PLAN.md); `1` is the first question, `2` the second. */
  let disableStep = $state(0);
  let resetStep = $state(0);
  let createPassword = $state('');
  let createEncrypted = $state(true);

  async function load(): Promise<void> {
    const loaded = await repository.getProfile();
    profile = loaded;
    goals = loaded.goals;
    model = loaded.geminiModel;
  }

  /**
   * What this account has spent on Gemini in the current quota window. Counted by the app
   * itself — Google exposes no endpoint for the real remaining quota — and summed across every
   * device, because the free tier counts per project (STATE.md decision 127). A tally left over
   * from a previous day is shown as zero rather than as today's spend.
   */
  const todaysUsage = $derived(
    profile?.geminiUsage?.day === quotaDay() ? profile.geminiUsage : undefined
  );
  /** The number that can be compared against a quota: this model's, not every model's. */
  const usage = $derived(modelGeminiUsage(todaysUsage, model));
  /** The other models spent on today, so switching away does not hide what it cost. */
  const otherModels = $derived(
    geminiUsageByModel(todaysUsage).filter((row) => row.model !== model)
  );

  /**
   * The model list comes from the key, never from a constant (PLAN.md: „free-tier catalogs
   * change"). An empty list is a normal state — offline, no key yet — and the free-text field
   * below is what keeps a brand-new model reachable in that case.
   */
  let models = $state<GeminiModel[]>([]);
  let typingModel = $state(false);
  const modelOptions = $derived(withCurrentModel(models, model));

  async function loadModels(): Promise<void> {
    if (vaultState.status !== 'unlocked') return;
    const key = geminiApiKey();
    if (key === undefined || key.trim() === '') return;
    models = await listGeminiModels(key);
  }

  // Runs once the vault opens, which is when a key first becomes readable.
  $effect(() => {
    if (vaultState.status === 'unlocked' && models.length === 0) void loadModels();
  });

  /**
   * The key field follows the vault, not the screen: unlocking happens after this screen has
   * already mounted, so filling the field once at load would leave it permanently blank for
   * anyone who unlocks from here.
   */
  let keyFieldFilled = $state(false);
  $effect(() => {
    if (vaultState.status !== 'unlocked') {
      keyFieldFilled = false;
    } else if (!keyFieldFilled) {
      apiKey = geminiApiKey() ?? '';
      keyFieldFilled = true;
    }
  });

  async function saveGoals(next: Macros): Promise<void> {
    savingGoals = true;
    await repository.setGoals(next);
    savingGoals = false;
    goalsSaved = true;
    void syncNow();
  }

  async function saveModel(): Promise<void> {
    if (profile === null) return;
    const trimmed = model.trim() === '' ? DEFAULT_GEMINI_MODEL : model.trim();
    model = trimmed;
    profile = await repository.saveProfile({ ...profile, geminiModel: trimmed });
    modelSaved = true;
    void syncNow();
  }

  async function saveKey(): Promise<void> {
    testingKey = true;
    keyResult = await testGeminiKey(apiKey);
    testingKey = false;
    if (keyResult.status !== 'ok') return;
    await saveSecrets({ geminiApiKey: apiKey.trim() });
    // The model list needs a key, and the effect below already ran — when the vault opened,
    // which is before the very first key exists. Without this the dropdown would stay empty
    // until the next page load.
    void loadModels();
    void syncNow();
  }

  async function changePassword(): Promise<void> {
    if (newPassword !== repeatPassword) {
      passwordMessage = 'Hasła nie są identyczne.';
      return;
    }
    if (newPassword.length < 8) {
      passwordMessage = 'Hasło musi mieć co najmniej 8 znaków.';
      return;
    }
    await setPassword(newPassword);
    newPassword = '';
    repeatPassword = '';
    passwordMessage = 'Hasło zmienione.';
    void syncNow();
  }

  async function turnEncryptionOff(): Promise<void> {
    disableStep = 0;
    await disableEncryption();
    void syncNow();
  }

  async function enableEncryption(): Promise<void> {
    if (newPassword !== repeatPassword) {
      passwordMessage = 'Hasła nie są identyczne.';
      return;
    }
    if (newPassword.length < 8) {
      passwordMessage = 'Hasło musi mieć co najmniej 8 znaków.';
      return;
    }
    await setPassword(newPassword);
    newPassword = '';
    repeatPassword = '';
    passwordMessage = 'Sejf jest teraz zaszyfrowany.';
    void syncNow();
  }

  async function makeVault(): Promise<void> {
    if (createEncrypted && createPassword.length < 8) {
      passwordMessage = 'Hasło musi mieć co najmniej 8 znaków.';
      return;
    }
    await createVault(createEncrypted, createPassword);
    createPassword = '';
    passwordMessage = '';
    apiKey = '';
    void syncNow();
  }

  /**
   * Discard the vault and fall back to the creation form. No sync is triggered here on
   * purpose: the device now has no vault, and a sync in that state would simply fetch the
   * old one back from Drive. Creating the replacement uploads it and overwrites the old.
   */
  async function startOver(): Promise<void> {
    resetStep = 0;
    await forgetVault();
    createPassword = '';
    apiKey = '';
    keyFieldFilled = false;
  }

  const inputClass =
    'mt-1 w-full rounded-lg border border-(--color-border) bg-(--color-surface-raised) px-3 py-2 text-base font-normal outline-none focus:border-(--color-accent)';
  const buttonClass =
    'rounded-lg bg-(--color-accent) px-3 py-2 text-sm font-medium text-(--color-accent-ink) disabled:opacity-50';
  const secondaryClass = 'rounded-lg border border-(--color-border) px-3 py-2 text-sm font-medium';

  void load();
</script>

<Screen title="Ustawienia" lead="Konto Google, sejf na klucz Gemini, cele dzienne i tagi.">
  <!-- ---- Google Drive ------------------------------------------------------------- -->
  <section class="rounded-xl border border-(--color-border) bg-(--color-surface-raised) p-4">
    <h2 class="text-base font-semibold">Dysk Google</h2>

    {#if !syncState.configured}
      <p class="pt-2 text-sm text-(--color-ink-muted)">
        Ta wersja aplikacji nie ma skonfigurowanego identyfikatora klienta Google, więc
        synchronizacja jest niedostępna. Wszystko inne działa lokalnie.
      </p>
    {:else}
      <p class="pt-2 text-sm text-(--color-ink-muted)">
        Aplikacja zapisuje dane w prywatnym folderze aplikacji na Twoim Dysku. Nie widzi i nie
        może otworzyć żadnego innego Twojego pliku.
      </p>

      {#if syncState.foreignAccount !== null}
        <div class="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm">
          <p class="font-medium">To jest inne konto Google niż poprzednio.</p>
          <p class="pt-1 text-(--color-ink-muted)">
            Dane na tym urządzeniu pochodzą z innego konta. Nie tworzymy po cichu nowego profilu —
            zdecyduj sam.
          </p>
          <div class="flex flex-wrap gap-2 pt-3">
            <button type="button" class={buttonClass} onclick={() => void useDifferentAccount()}>
              Używaj tego konta
            </button>
            <button type="button" class={secondaryClass} onclick={disconnectDrive}>
              Rozłącz
            </button>
          </div>
        </div>
      {/if}

      <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 pt-3 text-sm">
        <dt class="text-(--color-ink-muted)">Stan</dt>
        <dd>
          {#if syncState.phase === 'syncing'}
            Synchronizacja…
          {:else if syncState.connected}
            Połączono{syncState.account?.label ? ` — ${syncState.account.label}` : ''}
          {:else}
            Niepołączono
          {/if}
        </dd>
        <dt class="text-(--color-ink-muted)">Ostatnia synchronizacja</dt>
        <dd>
          {syncState.lastSyncedAt === undefined
            ? 'nigdy'
            : new Date(syncState.lastSyncedAt).toLocaleString('pl-PL')}
        </dd>
      </dl>

      {#if syncState.message !== ''}
        <p class="pt-2 text-sm text-red-700" role="status">{syncState.message}</p>
      {/if}
      {#if syncState.vaultAdopted}
        <p class="pt-2 text-sm text-(--color-ink-muted)" role="status">
          Sejf z Dysku zastąpił kopię z tego urządzenia — szczegóły i cofnięcie w sekcji „Sejf".
        </p>
      {/if}

      <div class="flex flex-wrap gap-2 pt-3">
        {#if syncState.connected}
          <button
            type="button"
            class={buttonClass}
            disabled={syncState.phase === 'syncing'}
            onclick={() => void syncNow({ interactive: true })}
          >
            Synchronizuj teraz
          </button>
          <button
            type="button"
            class={secondaryClass}
            onclick={() => {
              disconnectDrive();
              lockVault();
            }}
          >
            Rozłącz konto
          </button>
        {:else}
          <button
            type="button"
            class={buttonClass}
            disabled={syncState.phase === 'syncing'}
            onclick={() => void connectDrive()}
          >
            Połącz Dysk Google
          </button>
        {/if}
      </div>
      <p class="pt-2 text-xs text-(--color-ink-muted)">
        Rozłączenie nie usuwa niczego z tego urządzenia — kalendarz i przepisy zostają.
      </p>
    {/if}
  </section>

  <!-- ---- the vault ----------------------------------------------------------------- -->
  <section class="mt-4 rounded-xl border border-(--color-border) bg-(--color-surface-raised) p-4">
    <h2 class="text-base font-semibold">Sejf</h2>
    <p class="pt-2 text-sm text-(--color-ink-muted)">
      W sejfie trzymamy klucz API do Gemini. Kalendarz i przepisy nie są w sejfie i działają, gdy
      jest zamknięty.
    </p>

    {#if vaultState.replaced}
      <!-- The swap can lock this device out of its own secrets, so it is stated in full and
           kept until the user answers it — not only while the sync that caused it is fresh. -->
      <p class="pt-3 text-sm text-amber-700" role="status">
        Sejf z Dysku zastąpił ten z tego urządzenia. Jeśli hasła główne były różne, ten sejf
        otworzy tylko hasło z drugiego urządzenia.
      </p>
      <p class="pt-2 text-sm text-(--color-ink-muted)">
        Poprzedni sejf nadal jest na tym urządzeniu i nigdzie nie został wysłany. Możesz go
        przywrócić — wtedy przy następnej synchronizacji zastąpi ten na Dysku.
      </p>
      <button
        type="button"
        class="{secondaryClass} mt-3"
        disabled={vaultState.busy}
        onclick={() => void restoreReplacedVault()}
      >
        Przywróć poprzedni sejf
      </button>
    {/if}

    {#if vaultState.status === 'unknown'}
      <p class="pt-3 text-sm text-(--color-ink-muted)">Wczytywanie…</p>
    {:else if vaultState.status === 'corrupt'}
      <p class="pt-3 text-sm text-red-700" role="alert">{vaultState.message}</p>
      <button type="button" class="{secondaryClass} mt-3" onclick={() => (resetStep = 1)}>
        Załóż sejf od nowa
      </button>
    {:else if vaultState.status === 'absent'}
      <p class="pt-3 text-sm">Nie masz jeszcze sejfu na tym urządzeniu.</p>
      <label class="flex items-center gap-2 pt-3 text-sm">
        <input type="checkbox" bind:checked={createEncrypted} />
        Szyfruj sejf hasłem głównym (zalecane)
      </label>
      {#if createEncrypted}
        <label class="block pt-3 text-sm font-medium">
          Hasło główne
          <input class={inputClass} type="password" autocomplete="new-password" bind:value={createPassword} />
        </label>
        <p class="pt-2 text-sm text-(--color-ink-muted)">
          Hasła głównego nie da się odzyskać — nikt go nie przechowuje.
        </p>
      {:else}
        <p class="pt-2 text-sm text-amber-700">
          Bez szyfrowania klucz Gemini będzie zapisany otwartym tekstem na tym urządzeniu i na
          Twoim Dysku.
        </p>
      {/if}
      <button type="button" class="{buttonClass} mt-3" disabled={vaultState.busy} onclick={() => void makeVault()}>
        {vaultState.busy ? 'Tworzenie…' : 'Utwórz sejf'}
      </button>
    {:else if vaultState.status === 'locked'}
      <p class="pt-3 text-sm">Sejf jest zamknięty.</p>
      <button type="button" class="{buttonClass} mt-3" onclick={() => void requestUnlock()}>
        Odblokuj sejf
      </button>
      <button type="button" class="{secondaryClass} mt-3 ml-2" onclick={() => (resetStep = 1)}>
        Nie pamiętam hasła
      </button>
    {:else}
      <p class="pt-3 text-sm">
        Sejf jest otwarty ({vaultState.encrypted ? 'zaszyfrowany' : 'bez szyfrowania'}).
      </p>

      <label class="block pt-4 text-sm font-medium">
        Klucz API Gemini
        <input class={inputClass} type="password" autocomplete="off" bind:value={apiKey} />
      </label>
      <p class="pt-1 text-xs text-(--color-ink-muted)">
        Klucz utworzysz w Google AI Studio (aistudio.google.com). Zapisujemy go dopiero po
        udanym teście.
      </p>
      <button type="button" class="{buttonClass} mt-3" disabled={testingKey} onclick={() => void saveKey()}>
        {testingKey ? 'Sprawdzanie…' : 'Sprawdź i zapisz klucz'}
      </button>
      {#if keyResult !== null}
        <p
          class="pt-2 text-sm {keyResult.status === 'ok' ? 'text-(--color-ink-muted)' : 'text-red-700'}"
          role="status"
        >
          {keyResult.message}
        </p>
      {/if}

      <label class="block pt-4 text-sm font-medium" for="gemini-model">Model Gemini</label>
      {#if typingModel || modelOptions.length === 0}
        <input
          id="gemini-model"
          class={inputClass}
          type="text"
          bind:value={model}
          onchange={() => (modelSaved = false)}
        />
        {#if modelOptions.length > 0}
          <button
            type="button"
            class="pt-1 text-sm text-(--color-accent) underline"
            onclick={() => (typingModel = false)}
          >
            Wybierz z listy
          </button>
        {/if}
      {:else}
        <select
          id="gemini-model"
          class={inputClass}
          bind:value={model}
          onchange={() => (modelSaved = false)}
        >
          {#each modelOptions as option (option.id)}
            <option value={option.id}>{option.label} — {option.id}</option>
          {/each}
        </select>
        <button
          type="button"
          class="pt-1 text-sm text-(--color-accent) underline"
          onclick={() => (typingModel = true)}
        >
          Wpisz nazwę ręcznie
        </button>
      {/if}
      <p class="pt-1 text-xs text-(--color-ink-muted)">
        Domyślnie {DEFAULT_GEMINI_MODEL}. Lista pochodzi z Twojego klucza i pokazuje tylko modele
        tekstowe — te, którymi da się czytać przepisy. Modele do obrazów, mowy, muzyki czy
        transkrypcji są pomijane, bo import by na nich nie zadziałał; jeśli szukasz modelu, którego
        tu nie ma, wpisz jego nazwę ręcznie. Bywa też, że model jest na liście, a mimo to nie da
        się go już wywołać — wtedy komunikat błędu podpowie nazwę zamiennika.
      </p>
      <button type="button" class="{secondaryClass} mt-3" onclick={() => void saveModel()}>
        Zapisz model
      </button>
      {#if modelSaved}
        <span class="pl-2 text-sm text-(--color-ink-muted)">Zapisano.</span>
      {/if}

      <h3 class="pt-6 text-sm font-semibold">Zużycie Gemini</h3>
      <p class="pt-2 text-sm">
        Dziś, model <span class="font-medium">{model}</span>:
        <span class="font-medium">{usage.requests}</span>
        {pluralPl(usage.requests, { one: 'zapytanie', few: 'zapytania', many: 'zapytań' })}
        {#if usage.tokens > 0}
          · {usage.tokens.toLocaleString('pl-PL')} tokenów
        {/if}
      </p>
      {#if otherModels.length > 0}
        <ul class="pt-1 text-xs text-(--color-ink-muted)">
          {#each otherModels as row (row.model)}
            <li>
              {row.model}: {row.usage.requests}
              {pluralPl(row.usage.requests, { one: 'zapytanie', few: 'zapytania', many: 'zapytań' })}
            </li>
          {/each}
        </ul>
      {/if}
      <p class="pt-2 text-xs text-(--color-ink-muted)">
        Limit liczy się <strong>osobno dla każdego modelu</strong> i bardzo się między nimi różni
        — jeden model może mieć 20 zapytań na dobę, inny 500. Gdy jeden się wyczerpie, wybierz
        wyżej inny i pracuj dalej. Jeden import to
        {REQUESTS_PER_IMPORT.paste} zapytania (wklejony tekst) albo {REQUESTS_PER_IMPORT.link} (link).
      </p>
      <p class="pt-1 text-xs text-(--color-ink-muted)">
        To licznik tej aplikacji, nie odczyt z Google: zapytania wysłane skądinąd na ten sam
        klucz nie są tu widoczne, a licznik zeruje się o północy czasu pacyficznego. Liczy tylko
        odpowiedzi, które przyszły — a do limitu Google wlicza też próby zakończone błędem, więc
        w dniu, w którym model bywa przeciążony, zużycie jest wyższe niż ta liczba. Prawdziwe
        limity i zużycie pokazuje
        <a
          class="font-medium text-(--color-accent) underline"
          href="https://ai.dev/rate-limit"
          target="_blank"
          rel="noreferrer noopener"
        >ai.dev/rate-limit</a>.
      </p>

      <h3 class="pt-6 text-sm font-semibold">
        {vaultState.encrypted ? 'Zmiana hasła' : 'Włączenie szyfrowania'}
      </h3>
      <label class="block pt-2 text-sm font-medium">
        Nowe hasło
        <input class={inputClass} type="password" autocomplete="new-password" bind:value={newPassword} />
      </label>
      <label class="block pt-2 text-sm font-medium">
        Powtórz hasło
        <input class={inputClass} type="password" autocomplete="new-password" bind:value={repeatPassword} />
      </label>
      {#if passwordMessage !== ''}
        <p class="pt-2 text-sm text-(--color-ink-muted)" role="status">{passwordMessage}</p>
      {/if}
      <button
        type="button"
        class="{buttonClass} mt-3"
        disabled={vaultState.busy || newPassword === ''}
        onclick={() => void (vaultState.encrypted ? changePassword() : enableEncryption())}
      >
        {vaultState.busy ? 'Szyfrowanie…' : vaultState.encrypted ? 'Zmień hasło' : 'Włącz szyfrowanie'}
      </button>

      {#if vaultState.encrypted}
        <h3 class="pt-6 text-sm font-semibold">Wyłączenie szyfrowania</h3>
        <p class="pt-2 text-sm text-(--color-ink-muted)">
          Klucz Gemini będzie wtedy zapisany otwartym tekstem.
        </p>
        <button type="button" class="{secondaryClass} mt-3" onclick={() => (disableStep = 1)}>
          Wyłącz szyfrowanie
        </button>
      {/if}
    {/if}
  </section>

  <!-- ---- goals --------------------------------------------------------------------- -->
  <section class="mt-4 rounded-xl border border-(--color-border) bg-(--color-surface-raised) p-4">
    <h2 class="text-base font-semibold">Cele dzienne</h2>
    {#if profile === null}
      <p class="pt-2 text-sm text-(--color-ink-muted)">Wczytywanie…</p>
    {:else}
      <div class="pt-3">
        <GoalsForm bind:goals saving={savingGoals} onsave={(next) => void saveGoals(next)} />
      </div>
      {#if goalsSaved}
        <p class="pt-2 text-sm text-(--color-ink-muted)" role="status">Zapisano.</p>
      {/if}
    {/if}
  </section>

  <TagSection />

  <BackupSection />

  <InstallSection />

  <a class="mt-4 inline-block text-sm font-medium text-(--color-accent) underline" href="#/about">
    O aplikacji i źródłach danych
  </a>
</Screen>

<!-- Disabling encryption asks twice: once for the intent, once for the consequence. -->
<ConfirmDialog
  open={disableStep === 1}
  title="Wyłączyć szyfrowanie sejfu?"
  confirmLabel="Tak, dalej"
  danger
  onconfirm={() => (disableStep = 2)}
  oncancel={() => (disableStep = 0)}
>
  Klucz Gemini przestanie być chroniony hasłem.
</ConfirmDialog>
<ConfirmDialog
  open={disableStep === 2}
  title="Na pewno? Klucz będzie zapisany otwartym tekstem"
  confirmLabel="Tak, wyłącz szyfrowanie"
  danger
  onconfirm={() => void turnEncryptionOff()}
  oncancel={() => (disableStep = 0)}
>
  Zapiszemy go bez szyfrowania na tym urządzeniu i na Twoim Dysku Google. Każdy, kto ma dostęp do
  tego urządzenia lub do Twojego konta Google, będzie mógł go odczytać.
</ConfirmDialog>

<ConfirmDialog
  open={resetStep === 1}
  title="Założyć sejf od nowa?"
  confirmLabel="Załóż od nowa"
  danger
  onconfirm={() => void startOver()}
  oncancel={() => (resetStep = 0)}
>
  Stracisz tylko zawartość sejfu, czyli klucz Gemini — trzeba go będzie wpisać ponownie.
  Kalendarz, przepisy i składniki są poza sejfem i zostaną nietknięte.
</ConfirmDialog>
