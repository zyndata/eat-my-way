import { downscaleToJpeg, ImageReadError, type InlineImage } from '../image';
import { isOffline } from '../net';
import { repository as defaultRepository, type Repository } from '../repository';
import { scheduleSync } from '../sync/state.svelte';
import { geminiApiKey, requestUnlock, vaultState } from '../vault/session.svelte';
import { GeminiError, generateJson } from './client';
import { LABEL_SCHEMA, SCAN_PROMPT, SCAN_SYSTEM, readScannedLabel, type ScannedLabel } from './scan';
import { recordGeminiUsage } from './usage';

/**
 * „Zeskanuj opakowanie", end to end — the one code path both callers of
 * `CustomIngredientForm` hand to it (PLAN.md Phase 12 task 1).
 *
 * `import.ts` is the model for the shape: `scan.ts` holds the prompt, the schema and the pure
 * reader, and everything with a side effect lives here — the vault, the key, the profile, the
 * counter and the single `generateContent` call. The form itself performs no I/O, which is why
 * the recipe editor's inline use and „Składniki"'s bottom sheet share one implementation
 * instead of two.
 *
 * Nothing here writes an ingredient. The result is a proposal for a draft the user is looking
 * at; „Zapisz składnik" stays the only path to IndexedDB. The photograph is never stored: it
 * is downscaled, sent once, and dropped.
 *
 * Throws `GeminiError` only. Every message on it is Polish, safe to show, and carries no key.
 */

/** What the scan is doing right now, so a wait of many seconds does not look frozen. */
export type ScanStage = 'preparing' | 'reading' | 'retrying';

/**
 * The one setting that is worth sending, measured against a real package on 2026-09-04 with a
 * live key (decision 251): `MEDIA_RESOLUTION_MEDIUM` takes the prompt from 1540 tokens to 1016
 * and the label still reads correctly, which is half the daily quota per scan. It buys tokens
 * rather than seconds — see `SCAN_RETRY_MS` for where the seconds actually go.
 *
 * It is a per-model API feature and the model is free text in Settings, so `scanLabelImage`
 * falls back to a plain call if it is refused.
 */
const FAST_SCAN = { mediaResolution: 'MEDIA_RESOLUTION_MEDIUM' } as const;

/**
 * How long to wait before the one automatic retry of an overloaded model.
 *
 * The free tier answers „This model is currently experiencing high demand" often enough to be
 * the normal case rather than the exception: on the evening of 2026-09-04, three of eight
 * byte-identical scans came back 503, and every one of them succeeded on the second attempt.
 * A user who has already waited half a minute should not be sent back to press the button
 * again for a condition the app can see and survive (decision 253).
 */
const SCAN_RETRY_MS = 1200;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One `generateContent` call with a picture attached, plus two bounded retries of different
 * kinds — each for a failure that was actually observed against the live API, not imagined:
 *
 * - **`rejected` (400)** → try once without `FAST_SCAN`. A model that does not know the field
 *   would otherwise tell the user their API key was refused, which is what a 400 means
 *   everywhere else in this app and would be a lie here.
 * - **`unavailable` (503)** → wait `SCAN_RETRY_MS` and try once more. This is the common one.
 *
 * Nothing else is retried: a quota error, a bad key and an unreadable answer all mean the same
 * thing on the second attempt as on the first.
 */
export async function scanLabelImage(
  image: InlineImage,
  deps: {
    apiKey: string;
    model: string;
    fetchImpl?: typeof fetch;
    /** Called once per answered call, exactly as the import counts (decision 127). */
    onusage?: (spent: { requests: number; tokens: number }) => void;
    /** Told when an overloaded model is being tried again, so the screen can say so. */
    onstage?: (stage: ScanStage) => void;
  }
): Promise<ScannedLabel> {
  const call = async (tuned: boolean): Promise<unknown> =>
    generateJson<unknown>({
      apiKey: deps.apiKey,
      model: deps.model,
      system: SCAN_SYSTEM,
      prompt: SCAN_PROMPT,
      image,
      schema: LABEL_SCHEMA,
      ...(tuned ? FAST_SCAN : {}),
      // Reported before the JSON is parsed, so a request Google answered is counted even when
      // the answer turns out to be unreadable — the quota was spent either way.
      onusage: (tokens) => deps.onusage?.({ requests: 1, tokens }),
      ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl })
    });

  let tuned = true;
  for (let attempt = 0; ; attempt++) {
    try {
      return readScannedLabel(await call(tuned));
    } catch (caught) {
      if (attempt > 0 || !(caught instanceof GeminiError)) throw caught;
      if (caught.kind === 'rejected') {
        tuned = false;
        continue;
      }
      if (caught.kind !== 'unavailable') throw caught;
      deps.onstage?.('retrying');
      await delay(SCAN_RETRY_MS);
    }
  }
}

/**
 * The three states that make the scan unavailable are answered where they occur rather than as
 * one generic failure, and each says that the rest of the form still works — the point of the
 * feature is fewer fields to type, not a dead end when the camera path is closed.
 */
export async function scanPackage(
  file: Blob,
  options: {
    repository?: Repository;
    fetchImpl?: typeof fetch;
    /** Told what is happening, so the wait for the model is not a frozen button. */
    onstage?: (stage: ScanStage) => void;
  } = {}
): Promise<ScannedLabel> {
  if (isOffline()) {
    throw new GeminiError(
      'network',
      'Jesteś offline. Skanowanie opakowania wymaga połączenia z internetem — wartości możesz ' +
        'wpisać ręcznie, reszta formularza działa normalnie.'
    );
  }

  // The unlock prompt belongs to the moment the key is actually needed — the same rule the
  // recipe import follows, so the library and the calendar never trigger it.
  if (vaultState.status !== 'unlocked') {
    const opened = await requestUnlock();
    if (!opened) {
      throw new GeminiError(
        'no-key',
        'Skanowanie wymaga klucza Gemini z sejfu. Odblokuj sejf i spróbuj ponownie albo wpisz ' +
          'wartości ręcznie.'
      );
    }
  }

  const apiKey = geminiApiKey();
  if (apiKey === undefined || apiKey.trim() === '') {
    throw new GeminiError(
      'no-key',
      'W sejfie nie ma klucza API Gemini. Dodaj go w Ustawieniach — bez niego wartości trzeba ' +
        'wpisać ręcznie.'
    );
  }

  let image: InlineImage;
  try {
    options.onstage?.('preparing');
    image = await downscaleToJpeg(file);
  } catch (caught) {
    if (caught instanceof ImageReadError) {
      throw new GeminiError(
        'bad-response',
        'Nie udało się odczytać tego zdjęcia. Zrób je jeszcze raz albo wybierz inny plik.'
      );
    }
    throw caught;
  }

  const repository = options.repository ?? defaultRepository;
  const profile = await repository.getProfile();

  options.onstage?.('reading');
  return scanLabelImage(image, {
    ...(options.onstage === undefined ? {} : { onstage: options.onstage }),
    apiKey,
    model: profile.geminiModel,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    // The tally travels in profile.json so the free tier is counted across every device on the
    // account, and against the model that was actually called (decisions 127 and 129).
    onusage: (spent) =>
      void recordGeminiUsage(spent, profile.geminiModel).then(() => scheduleSync())
  });
}
