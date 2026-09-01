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
  fetchImpl?: typeof fetch;
}

/**
 * Greedy decoding, fixed seed: everything the API offers towards "the same input twice gives
 * the same output" (decision 115). It is not a guarantee Google makes, which is why the
 * deterministic half of the import lives in pure functions on this side of the call.
 */
const DETERMINISTIC = { temperature: 0, topK: 1, seed: 7 } as const;

interface GeminiResponse {
  candidates?: {
    content?: { parts?: { text?: string }[] };
    finishReason?: string;
  }[];
  promptFeedback?: { blockReason?: string };
  error?: { message?: string; status?: string };
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
function httpError(status: number, reason: string, model: string): GeminiError {
  if (status === 400 || status === 401 || status === 403) {
    return new GeminiError(
      'rejected',
      'Gemini nie przyjął klucza API. Sprawdź go w Ustawieniach — starsze klucze „Standard” ' +
        'z AI Studio nie są już obsługiwane.'
    );
  }
  if (status === 429) {
    return new GeminiError(
      'quota',
      'Limit zapytań Gemini został wyczerpany. Spróbuj ponownie za kilka minut.'
    );
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
      'Nie udało się połączyć z Gemini. Sprawdź połączenie z internetem i spróbuj ponownie.'
    );
  }

  if (!response.ok) {
    const failed = (await response.json().catch(() => ({}))) as GeminiResponse;
    throw httpError(response.status, failed.error?.message ?? '', model);
  }

  const parsed = (await response.json().catch(() => ({}))) as GeminiResponse;

  const blocked = parsed.promptFeedback?.blockReason;
  if (blocked !== undefined) {
    throw new GeminiError(
      'bad-response',
      'Gemini odmówił przetworzenia tej treści. Spróbuj wkleić sam przepis, bez reszty strony.'
    );
  }

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
