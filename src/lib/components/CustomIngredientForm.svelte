<script lang="ts">
  import type { Ingredient } from '../types';
  import type { IngredientDraft } from '../custom-ingredients';
  import { draftProblem, draftToIngredient, emptyIngredientDraft } from '../custom-ingredients';
  import Spinner from './Spinner.svelte';
  import { GeminiError } from '../gemini/client';
  import {
    applyScannedLabel,
    labelIsEmpty,
    type ScannedField,
    type ScannedLabel
  } from '../gemini/scan';
  import type { ScanStage } from '../gemini/scan-run';

  /**
   * The one form for a `custom:*` ingredient. Values are per 100 g, like every other
   * ingredient in the database (STATE.md decision 53). The form only *builds* the ingredient —
   * the caller persists it and invalidates the search index.
   *
   * It is used from two places and belongs to neither: the recipe editor opens it inline when
   * the autocomplete finds nothing, and „Składniki" opens it in a bottom sheet to create, to
   * edit, and to copy a bundled row. That is why the draft comes in as a prop rather than
   * being assembled here.
   *
   * Phase 10 changed one rule: **every macro must be entered, and `0` counts as entered.** The
   * old form mapped an untouched field to `0`, so an ingredient saved „to finish later" read
   * as 0 kcal in every recipe using it and nothing ever said so (decision 178). The reason is
   * always printed next to the disabled button — „the button is grey" is not an answer.
   *
   * Phase 12 adds „Zeskanuj opakowanie", and it changes none of that. The form renders the
   * button and the result; the caller supplies the function that performs the scan, so the
   * form still owns no I/O and both places that use it stay on one code path. A scan writes a
   * *proposal* into the draft — nothing is persisted until the ordinary „Zapisz składnik" —
   * and a field the scan could not read stays empty rather than becoming `0`, which is the
   * same rule as above seen from the other side.
   */

  let {
    initialName = '',
    initial,
    editingId,
    heading = 'Nowy własny składnik',
    submitLabel = 'Zapisz składnik',
    framed = true,
    onscan,
    onsave,
    oncancel
  }: {
    /** Seed for a brand-new ingredient — the text the user had typed into the autocomplete. */
    initialName?: string;
    /** A whole draft to start from: an existing ingredient, or a copy of a bundled one. */
    initial?: IngredientDraft;
    /** Set when editing: the id the saved ingredient keeps. Absent means a fresh id. */
    editingId?: string;
    heading?: string;
    submitLabel?: string;
    /** The recipe editor renders the form as a card of its own; a sheet supplies its own. */
    framed?: boolean;
    /**
     * Read a photographed package into a proposal. Supplied by the caller — the form performs
     * no I/O of its own. Absent means no scan button at all, which is what a test that has no
     * network wants.
     */
    onscan?: (
      file: File,
      options: { onstage: (stage: ScanStage) => void }
    ) => Promise<ScannedLabel>;
    onsave: (ingredient: Ingredient) => void;
    oncancel: () => void;
  } = $props();

  // The form is created fresh for each row and for each sheet, so seeding once is the point.
  // svelte-ignore state_referenced_locally
  let draft = $state<IngredientDraft>(initial ?? emptyIngredientDraft(initialName));

  const problem = $derived(draftProblem(draft));

  /**
   * Fields the user has typed into. A scan never overwrites one of them, so a second scan
   * replaces its own proposal without undoing a correction.
   *
   * The name starts protected whenever it arrives non-empty: in the recipe editor it is what
   * the user typed into the autocomplete, and in „Składniki" it is the row they chose to edit
   * — their own words either way. The macros do not, because re-reading the package is exactly
   * what scanning during an edit is for.
   */
  // svelte-ignore state_referenced_locally
  let touched = $state<Partial<Record<ScannedField, boolean>>>(
    (initial?.name ?? initialName).trim() === '' ? {} : { name: true }
  );

  /** Fields whose current value came from the last scan, so they can be marked on screen. */
  let scanned = $state<Partial<Record<ScannedField, boolean>>>({});

  let scanning = $state(false);
  /** What the scan is waiting for. A model call takes seconds; a dead button explains none. */
  let stage = $state('');
  let scanError = $state('');
  let scanNote = $state('');
  let fileInput = $state<HTMLInputElement | null>(null);

  const STAGES: Record<ScanStage, string> = {
    preparing: 'Przygotowuję zdjęcie…',
    reading: 'Czytam etykietę…'
  };

  const SCAN_LABELS: Record<ScannedField, string> = {
    name: 'nazwa',
    kcal: 'kcal',
    protein: 'białko',
    carbs: 'węglowodany',
    fat: 'tłuszcz'
  };

  /** Typing into a field claims it: the scan stops owning it and stops marking it. */
  function claim(field: ScannedField): void {
    touched[field] = true;
    scanned[field] = false;
  }

  const scannedClass = (field: ScannedField): string =>
    scanned[field] === true ? ' border-(--color-accent)' : '';

  async function runScan(file: File): Promise<void> {
    if (onscan === undefined || scanning) return;
    scanning = true;
    scanError = '';
    scanNote = '';
    stage = '';
    try {
      const label = await onscan(file, { onstage: (next) => (stage = STAGES[next]) });
      if (labelIsEmpty(label)) {
        scanError =
          'Nie udało się odczytać z tego zdjęcia żadnej wartości. Zrób je z bliska, na wprost ' +
          'tabeli „w 100 g”, albo wpisz wartości ręcznie.';
        return;
      }
      const applied = applyScannedLabel(draft, label, touched);
      draft = applied.draft;
      scanned = Object.fromEntries(applied.filled.map((field) => [field, true]));
      scanNote =
        applied.filled.length === 0
          ? 'Ze zdjęcia nie doszło nic nowego — wypełnione pola zostawiamy tak, jak je poprawiłaś/eś.'
          : `Ze zdjęcia: ${applied.filled.map((field) => SCAN_LABELS[field]).join(', ')}. ` +
            'Sprawdź wartości — to odczyt z etykiety, nie wyrocznia.';
    } catch (caught) {
      // `GeminiError` messages are Polish and carry no key; anything else is a bug, not a
      // response, so it is reported without quoting it.
      scanError =
        caught instanceof GeminiError
          ? caught.message
          : 'Nie udało się odczytać opakowania. Spróbuj ponownie albo wpisz wartości ręcznie.';
    } finally {
      scanning = false;
      stage = '';
    }
  }

  function pickFile(event: Event): void {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    // Cleared straight away, so photographing the same package twice fires `change` again.
    input.value = '';
    if (file !== undefined) void runScan(file);
  }

  const fieldClass =
    'mt-1 w-full rounded-lg border border-(--color-border) bg-(--color-surface-raised) px-3 py-2 text-base font-normal outline-none focus:border-(--color-accent)';

  function save(): void {
    if (problem !== null) return;
    onsave(draftToIngredient(draft, editingId === undefined ? {} : { id: editingId }));
  }
</script>

<div
  id="custom-ingredient-form"
  class={framed ? 'rounded-xl border border-(--color-border) bg-(--color-surface) p-3' : ''}
>
  {#if heading !== ''}
    <h3 class="text-sm font-semibold">{heading}</h3>
  {/if}
  <p class="pt-1 text-xs text-(--color-ink-muted)">
    Wartości podaj na 100 g. Składnik zapisujemy lokalnie i synchronizujemy z Dyskiem, więc
    będzie dostępny w innych przepisach i na innych urządzeniach.
  </p>

  {#if onscan !== undefined}
    <!-- The camera is reached with `capture`, not `getUserMedia`: on a phone that opens the
         system camera, with framing, focus and a confirm step already built, and it asks
         nothing of `Permissions-Policy: camera=()`. On a laptop it opens a file picker, which
         is the honest behaviour there (STATE.md decision 241). -->
    <div class="pt-3">
      <input
        class="hidden"
        type="file"
        accept="image/*"
        capture="environment"
        aria-hidden="true"
        tabindex="-1"
        bind:this={fileInput}
        onchange={pickFile}
      />
      <button
        type="button"
        class="inline-flex items-center gap-2 rounded-lg border border-(--color-border) px-3 py-2 text-sm font-medium disabled:opacity-50"
        disabled={scanning}
        onclick={() => fileInput?.click()}
      >
        {#if scanning}
          <Spinner />
        {/if}
        {scanning ? (stage === '' ? 'Odczytuję zdjęcie…' : stage) : 'Zeskanuj opakowanie'}
      </button>
      <p class="pt-1 text-xs text-(--color-ink-muted)">
        Zdjęcie tabeli wartości odżywczych wypełni pola poniżej. Wysyłamy je do Gemini Twoim
        własnym kluczem, tylko po naciśnięciu tego przycisku, i nigdzie go nie zapisujemy.
        Wartości sprawdź przed zapisaniem — czego nie da się odczytać, zostaje puste.
      </p>
      {#if scanError !== ''}
        <p
          class="mt-2 rounded-lg border border-(--color-danger-border) bg-(--color-danger-surface) px-3 py-2 text-sm text-(--color-danger)"
        >
          {scanError}
        </p>
      {:else if scanNote !== ''}
        <p class="pt-1 text-xs text-(--color-accent)">{scanNote}</p>
      {/if}
    </div>
  {/if}

  <div class="grid gap-3 pt-3 sm:grid-cols-2">
    <label class="block text-sm font-medium">
      Nazwa
      <input
        class={fieldClass + scannedClass('name')}
        type="text"
        bind:value={draft.name}
        oninput={() => claim('name')}
      />
    </label>

    <label class="block text-sm font-medium">
      Postać
      <select class={fieldClass} bind:value={draft.state}>
        <option value="raw">surowy</option>
        <option value="cooked">po ugotowaniu</option>
      </select>
    </label>
  </div>

  <div class="grid grid-cols-2 gap-3 pt-3 sm:grid-cols-4">
    <label class="block text-sm font-medium">
      kcal
      <input
        class={fieldClass + scannedClass('kcal')}
        type="number"
        inputmode="decimal"
        min="0"
        step="any"
        bind:value={draft.kcal}
        oninput={() => claim('kcal')}
      />
    </label>
    <label class="block text-sm font-medium">
      Białko (g)
      <input
        class={fieldClass + scannedClass('protein')}
        type="number"
        inputmode="decimal"
        min="0"
        step="any"
        bind:value={draft.protein}
        oninput={() => claim('protein')}
      />
    </label>
    <label class="block text-sm font-medium">
      Węgl. (g)
      <input
        class={fieldClass + scannedClass('carbs')}
        type="number"
        inputmode="decimal"
        min="0"
        step="any"
        bind:value={draft.carbs}
        oninput={() => claim('carbs')}
      />
    </label>
    <label class="block text-sm font-medium">
      Tłuszcz (g)
      <input
        class={fieldClass + scannedClass('fat')}
        type="number"
        inputmode="decimal"
        min="0"
        step="any"
        bind:value={draft.fat}
        oninput={() => claim('fat')}
      />
    </label>
  </div>

  <!-- Aliases were indexed from schema v2 on and until now had no way of ever being filled.
       They widen both the autocomplete and Gemini's ingredient matching. -->
  <label class="block pt-3 text-sm font-medium">
    Inne nazwy
    <input
      class={fieldClass}
      type="text"
      placeholder="np. twarożek, twarog chudy"
      bind:value={draft.aliases}
    />
  </label>
  <p class="pt-1 text-xs text-(--color-ink-muted)">
    Oddziel przecinkami. Po tych nazwach też znajdziesz składnik w wyszukiwarce, a import
    przepisu łatwiej go dopasuje.
  </p>

  <div class="flex flex-wrap gap-2 pt-4">
    <button
      type="button"
      class="rounded-lg bg-(--color-accent) px-3 py-2 text-sm font-medium text-(--color-accent-ink) disabled:opacity-50"
      disabled={problem !== null}
      onclick={save}
    >
      {submitLabel}
    </button>
    <button
      type="button"
      class="rounded-lg border border-(--color-border) px-3 py-2 text-sm font-medium"
      onclick={oncancel}
    >
      Anuluj
    </button>
  </div>

  {#if problem !== null}
    <p class="pt-2 text-xs text-(--color-ink-muted)">{problem}</p>
  {/if}
</div>
