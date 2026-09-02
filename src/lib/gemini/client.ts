/**
 * The one place the app talks to `generativelanguage.googleapis.com`.
 *
 * Everything about the key is the same rule as in `key-test.ts`: it travels in the
 * `x-goog-api-key` header so it never reaches browser history or a referrer, and nothing here
 * logs it, throws it or puts it in a returned message. Callers get a `GeminiError` carrying a
 * Polish sentence and a coarse `kind`, never a response body — a body can quote the request
 * (PLAN.md security: "the API key must never leak into logs or error reporters").
 *
 * The model name is a parameter, always. `DEFAULT_GEMINI_MODEL` lives in `db.ts` as the
 * profile default and is not duplicated here, so changing the model in settings changes every
 * call without a code change (PLAN.md Phase 7 task 1).
 */

import { isOffline } from '../net';

const API_ROOT = 'https://generativelanguage.googleapis.com/v1beta/models';

export type GeminiErrorKind =
  /** No key in the vault, or the vault is locked. */
  | 'no-key'
  /** The key was refused. */
  | 'rejected'
  /** Quota or rate limit. */
  | 'quota'
  /** The request never reached Google. */
  | 'network'
  /** Google answered, but not with something usable. */
  | 'bad-response'
  /** Google is up but overloaded — worth retrying, unlike everything above. */
  | 'unavailable'
  /** Anything else. */
  | 'unknown';

/** The only error type this module throws. `message` is Polish and ready to show. */
export class GeminiError extends Error {
  readonly kind: GeminiErrorKind;

  constructor(kind: GeminiErrorKind, message: string) {
    super(message);
    this.name = 'GeminiError';
    this.kind = kind;
  }
}

/** A JSON Schema subset, as `responseSchema` accepts it. */
export interface ResponseSchema {
  type: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean';
  properties?: Record<string, ResponseSchema>;
  items?: ResponseSchema;
  required?: string[];
  enum?: string[];
  nullable?: boolean;
  description?: string;
  propertyOrdering?: string[];
}

export interface GeminiRequest {
  apiKey: string;
  model: string;
  /** System-level framing. Sent as `systemInstruction`. */
  system?: string;
  /** The user turn. */
  prompt: string;
  /** When given, the answer is asked for as JSON in this shape. */
  schema?: ResponseSchema;
  /** Let the model retrieve the URLs mentioned in the prompt (server-side, decision 113). */
  urlContext?: boolean;
  /**
   * Called once per call that Google actually answered, with the tokens it reported. Only a
   * 200 reaches it: a request that failed is not spend the user should be shown.
   */
  onusage?: (tokens: number) => void;
  fetchImpl?: typeof fetch;
}

/**
 * Greedy decoding, fixed seed: everything the API offers towards "the same input twice gives
 * the same output" (decision 115). It is not a guarantee Google makes, which is why the
 * deterministic half of the import lives in pure functions on this side of the call.
 */
const DETERMINISTIC = { temperature: 0, topK: 1, seed: 7 } as const;

/** One `google.rpc` detail off an error. Only `QuotaFailure` and `RetryInfo` are read. */
interface ErrorDetail {
  '@type'?: string;
  violations?: { quotaId?: string; quotaValue?: string; quotaMetric?: string }[];
  retryDelay?: string;
}

interface GeminiResponse {
  candidates?: {
    content?: { parts?: { text?: string }[] };
    finishReason?: string;
  }[];
  promptFeedback?: { blockReason?: string };
  error?: { message?: string; status?: string; details?: ErrorDetail[] };
  /** Token counts Google reports for a successful call. */
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
}

/**
 * What a 429 actually says, reduced to two facts. Google puts real numbers in the response —
 * the limit that was hit, whether it is a per-day or a per-minute quota, and how long to wait —
 * and „spróbuj za kilka minut" throws all of it away. On the free tier the daily cap is small
 * enough (20 requests per model at the time of writing) that „wait a moment" is actively
 * misleading: the answer is „tomorrow".
 *
 * Only an integer and a boolean are taken. Nothing else from the body is read, so a message
 * that quotes the request cannot reach the user.
 */
function readQuota(details: readonly ErrorDetail[] | undefined): {
  limit?: number;
  perDay: boolean;
  retryAfterSeconds?: number;
} {
  let limit: number | undefined;
  let perDay = false;
  let retryAfterSeconds: number | undefined;

  for (const detail of details ?? []) {
    for (const violation of detail.violations ?? []) {
      if (/perday/i.test(violation.quotaId ?? '')) perDay = true;
      const value = Number.parseInt(violation.quotaValue ?? '', 10);
      if (Number.isFinite(value) && value > 0 && limit === undefined) limit = value;
    }
    const delay = /^(\d+(?:\.\d+)?)s$/.exec(detail.retryDelay ?? '');
    if (delay !== null) retryAfterSeconds = Math.ceil(Number.parseFloat(delay[1] ?? '0'));
  }

  return { perDay, ...(limit === undefined ? {} : { limit }), ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }) };
}

/** Concatenate the text parts of the first candidate. Non-text parts are ignored. */
function candidateText(body: GeminiResponse): string {
  const parts = body.candidates?.[0]?.content?.parts ?? [];
  return parts
    .map((part) => part.text)
    .filter((text): text is string => typeof text === 'string')
    .join('');
}

/**
 * The model Google names as the replacement in a 404, when it names one.
 *
 * A retired model answers „This model models/X is no longer available to new users. Please
 * update your code to use models/Y" — the fix is in the error and it would be perverse to
 * throw it away. Only a `models/…` token is taken, and only one that is not the model just
 * asked for, so what reaches the user is a model name and nothing else: an API key cannot
 * match this shape, and no other part of the body is read.
 */
function suggestedModel(reason: string, requested: string): string | undefined {
  const named = [...reason.matchAll(/models\/([a-z0-9][a-z0-9.-]{2,48})/gi)].map((match) => match[1]);
  return named.find((name) => name !== undefined && name !== requested);
}

/**
 * Map an HTTP status onto a Polish sentence. The response body is never quoted; the one thing
 * read out of it is a suggested model name, under the bounded pattern above.
 */
function httpError(
  status: number,
  reason: string,
  model: string,
  details?: readonly ErrorDetail[]
): GeminiError {
  if (status === 400 || status === 401 || status === 403) {
    return new GeminiError(
      'rejected',
      'Gemini nie przyjął klucza API. Sprawdź go w Ustawieniach — starsze klucze „Standard” ' +
        'z AI Studio nie są już obsługiwane.'
    );
  }
  if (status === 429) {
    const quota = readQuota(details);
    const cap = quota.limit === undefined ? '' : ` (${quota.limit} zapytań na dobę na model)`;
    if (quota.perDay) {
      return new GeminiError(
        'quota',
        `Wyczerpał się dzienny limit darmowego Gemini${cap}. Odnowi się jutro — do tego czasu ` +
          'możesz dodać przepis ręcznie albo wpisać w Ustawieniach inny model.'
      );
    }
    const wait =
      quota.retryAfterSeconds === undefined
        ? 'za chwilę'
        : `za około ${Math.max(1, quota.retryAfterSeconds)} s`;
    return new GeminiError('quota', `Za dużo zapytań do Gemini naraz. Spróbuj ponownie ${wait}.`);
  }
  if (status === 404) {
    // Seen for real: a model the key can still *list* but no longer call (decision 120).
    const suggestion = suggestedModel(reason, model);
    return new GeminiError(
      'rejected',
      suggestion === undefined
        ? `Gemini nie udostępnia już modelu „${model}”. Wpisz w Ustawieniach inną nazwę modelu.`
        : `Gemini nie udostępnia już modelu „${model}”. Google podpowiada „${suggestion}” — ` +
          'wpisz tę nazwę w Ustawieniach, w polu „Model Gemini”.'
    );
  }
  if (status === 500 || status === 502 || status === 503 || status === 504) {
    return new GeminiError(
      'unavailable',
      'Gemini jest chwilowo przeciążony. To zwykle mija po kilku minutach — spróbuj ponownie.'
    );
  }
  return new GeminiError(
    'unknown',
    `Gemini odpowiedział błędem (${status}). Spróbuj ponownie za chwilę.`
  );
}

/**
 * One `generateContent` call. Returns the model's text, or throws a `GeminiError`.
 *
 * `model` is interpolated into the path, so it is percent-encoded: a name typed into settings
 * is user input and must not be able to reshape the URL.
 */
export async function generateText(request: GeminiRequest): Promise<string> {
  const key = request.apiKey.trim();
  if (key === '') {
    throw new GeminiError('no-key', 'Brak klucza API Gemini. Dodaj go w Ustawieniach.');
  }

  const model = request.model.trim();
  const url = `${API_ROOT}/${encodeURIComponent(model)}:generateContent`;

  const body: Record<string, unknown> = {
    contents: [{ role: 'user', parts: [{ text: request.prompt }] }],
    generationConfig: {
      ...DETERMINISTIC,
      ...(request.schema === undefined
        ? {}
        : { responseMimeType: 'application/json', responseSchema: request.schema })
    }
  };
  if (request.system !== undefined) {
    body.systemInstruction = { parts: [{ text: request.system }] };
  }
  // Retrieval happens on Google's side; the browser never fetches the recipe page, so
  // `connect-src` is untouched (STATE.md decisions 63 and 112).
  if (request.urlContext === true) body.tools = [{ url_context: {} }];

  const fetchImpl = request.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(body)
    });
  } catch {
    // The caught error can quote the request, and the request carries the key.
    throw new GeminiError(
      'network',
      isOffline()
        ? 'Jesteś offline. Import przepisu wymaga połączenia z internetem — reszta aplikacji działa bez niego.'
        : 'Nie udało się połączyć z Gemini. Sprawdź połączenie z internetem i spróbuj ponownie.'
    );
  }

  if (!response.ok) {
    const failed = (await response.json().catch(() => ({}))) as GeminiResponse;
    throw httpError(response.status, failed.error?.message ?? '', model, failed.error?.details);
  }

  const parsed = (await response.json().catch(() => ({}))) as GeminiResponse;

  const blocked = parsed.promptFeedback?.blockReason;
  if (blocked !== undefined) {
    throw new GeminiError(
      'bad-response',
      'Gemini odmówił przetworzenia tej treści. Spróbuj wkleić sam przepis, bez reszty strony.'
    );
  }

  // Reported before the emptiness check below: Google answered, so the quota was spent.
  request.onusage?.(parsed.usageMetadata?.totalTokenCount ?? 0);

  const text = candidateText(parsed);
  if (text.trim() === '') {
    throw new GeminiError(
      'bad-response',
      'Gemini nie zwrócił żadnej treści. Spróbuj ponownie lub wklej przepis jako tekst.'
    );
  }
  return text;
}

/**
 * Strip what a model puts around JSON even when asked not to: a ``` fence, a leading sentence,
 * a trailing one. Anything outside the outermost braces is dropped rather than parsed.
 */
export function extractJson(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = (fenced?.[1] ?? text).trim();
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end <= start) return body;
  return body.slice(start, end + 1);
}

/** `generateText` plus a forgiving JSON parse. A body that is not JSON is a `bad-response`. */
export async function generateJson<T>(request: GeminiRequest): Promise<T> {
  const text = await generateText(request);
  try {
    return JSON.parse(extractJson(text)) as T;
  } catch {
    throw new GeminiError(
      'bad-response',
      'Gemini zwrócił odpowiedź, której nie udało się odczytać. Spróbuj ponownie.'
    );
  }
}
