/**
 * The live key check PLAN.md puts in wizard step 4 and in settings. Deliberately the smallest
 * possible call — listing the models the key can see — so "does this key work" is answered
 * without generating anything.
 *
 * The key travels in the `x-goog-api-key` header, never in the URL: a query string ends up in
 * browser history, in referrers and in every error message that quotes a URL. Nothing in this
 * file logs, throws or returns the key, and the caller gets a Polish sentence, not a response
 * body (PLAN.md security: "the API key must never leak into logs or error reporters").
 */

import { isOffline } from '../net';

const MODELS_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

export type KeyTestStatus = 'ok' | 'rejected' | 'legacy-key' | 'network' | 'unknown';

export interface KeyTestResult {
  status: KeyTestStatus;
  /** Polish, ready to show. */
  message: string;
  /** Model names the key can reach, on success. */
  models?: string[];
}

interface ModelsResponse {
  models?: { name?: string }[];
  error?: { message?: string; status?: string };
}

/** Strips the `models/` prefix Gemini puts on every name. */
function shortName(name: string): string {
  return name.startsWith('models/') ? name.slice('models/'.length) : name;
}

export async function testGeminiKey(
  apiKey: string,
  fetchImpl: typeof fetch = fetch
): Promise<KeyTestResult> {
  if (apiKey.trim() === '') {
    return { status: 'rejected', message: 'Wpisz klucz API.' };
  }

  let response: Response;
  try {
    response = await fetchImpl(MODELS_ENDPOINT, {
      headers: { 'x-goog-api-key': apiKey.trim() }
    });
  } catch {
    // Never include the caught error: it can quote the request, and the request carries the key.
    return {
      status: 'network',
      message: isOffline()
        ? 'Jesteś offline. Sprawdzenie klucza wymaga połączenia z internetem.'
        : 'Nie udało się połączyć z Gemini. Sprawdź połączenie z internetem i spróbuj ponownie.'
    };
  }

  const body = (await response.json().catch(() => ({}))) as ModelsResponse;

  if (response.ok) {
    const models = (body.models ?? [])
      .map((model) => model.name)
      .filter((name): name is string => typeof name === 'string')
      .map(shortName);
    return { status: 'ok', message: 'Klucz działa.', models };
  }

  const reason = body.error?.message ?? '';

  // Google stopped accepting the old "Standard" AI Studio keys in September 2026; the API
  // answers with a generic 400/403, so the message has to say what actually has to be done.
  if (/api key not valid|api_key_invalid|expired|blocked/i.test(reason) || response.status === 400) {
    return {
      status: 'legacy-key',
      message:
        'Gemini odrzucił ten klucz. Starsze klucze „Standard” z AI Studio nie są już obsługiwane — ' +
        'utwórz nowy klucz w Google AI Studio i wklej go tutaj.'
    };
  }
  if (response.status === 401 || response.status === 403) {
    return {
      status: 'rejected',
      message: 'Gemini nie przyjął tego klucza. Sprawdź, czy skopiowałeś go w całości.'
    };
  }
  if (response.status === 429) {
    return {
      status: 'rejected',
      message: 'Limit zapytań Gemini został wyczerpany. Spróbuj ponownie za chwilę.'
    };
  }

  return {
    status: 'unknown',
    message: `Gemini odpowiedział błędem (${response.status}). Spróbuj ponownie za chwilę.`
  };
}
