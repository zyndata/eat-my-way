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

/** One `generateContent` call with a picture attached. */
export async function scanLabelImage(
  image: InlineImage,
  deps: {
    apiKey: string;
    model: string;
    fetchImpl?: typeof fetch;
    /** Called once per answered call, exactly as the import counts (decision 127). */
    onusage?: (spent: { requests: number; tokens: number }) => void;
  }
): Promise<ScannedLabel> {
  const answer = await generateJson<unknown>({
    apiKey: deps.apiKey,
    model: deps.model,
    system: SCAN_SYSTEM,
    prompt: SCAN_PROMPT,
    image,
    schema: LABEL_SCHEMA,
    // Reported before the JSON is parsed, so a request Google answered is counted even when
    // the answer turns out to be unreadable — the quota was spent either way.
    onusage: (tokens) => deps.onusage?.({ requests: 1, tokens }),
    ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl })
  });
  return readScannedLabel(answer);
}

/**
 * The three states that make the scan unavailable are answered where they occur rather than as
 * one generic failure, and each says that the rest of the form still works — the point of the
 * feature is fewer fields to type, not a dead end when the camera path is closed.
 */
export async function scanPackage(
  file: Blob,
  options: { repository?: Repository; fetchImpl?: typeof fetch } = {}
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

  return scanLabelImage(image, {
    apiKey,
    model: profile.geminiModel,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    // The tally travels in profile.json so the free tier is counted across every device on the
    // account, and against the model that was actually called (decisions 127 and 129).
    onusage: (spent) =>
      void recordGeminiUsage(spent, profile.geminiModel).then(() => scheduleSync())
  });
}
