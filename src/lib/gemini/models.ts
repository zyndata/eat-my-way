/**
 * The model list, fetched from the user's own key.
 *
 * PLAN.md forbids hardcoding a model catalogue — „free-tier catalogs change" — and decision 120
 * is what that looks like when ignored: the default this app shipped was retired and every
 * import broke. So the dropdown in Settings is built from `models.list` at runtime, and typing
 * a name by hand stays available for a model too new to be listed.
 *
 * One thing this list cannot tell you: whether a model still *works*. `gemini-2.5-flash` is
 * returned here, claims to support `generateContent`, and answers 404 to an actual call
 * (decision 120). The 404 message names the replacement, which is the recovery path.
 */

const MODELS_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=200';

export interface GeminiModel {
  /** The name to store in the profile, e.g. `gemini-3.6-flash`. */
  id: string;
  /** Google's own label, e.g. „Gemini 3.6 Flash". Falls back to the id. */
  label: string;
}

interface ModelsResponse {
  models?: {
    name?: string;
    displayName?: string;
    supportedGenerationMethods?: string[];
  }[];
}

/**
 * A model this app could actually import a recipe with.
 *
 * `models.list` answers with everything the key can reach — 41 entries on a personal key, of
 * which the app can use 17. The rest are other products that happen to speak `generateContent`:
 * „Nano Banana" draws pictures, Lyria writes music, there is a text-to-speech pair, a
 * transcriber, a robotics model, computer-use, deep-research agents and Gemma. Offering them in
 * the dropdown is offering the user a way to break their import.
 *
 * Two rules, both read off the API rather than off a list of names this app would have to keep
 * current (PLAN.md: „free-tier catalogs change, never hardcode"):
 *
 *   1. `generateContent` **and** `createCachedContent` — context caching is offered on the
 *      mainline text models and on nothing else, which is what removes the image, speech,
 *      music, transcription and agent lines, and Gemma with them.
 *   2. a `gemini-` name with no capability word in it — caching alone lets the robotics model
 *      through, and `nano-banana-pro-preview` is not even called `gemini-`.
 *
 * Neither rule can tell whether a model still *works*: `gemini-2.5-flash` passes both and
 * answers 404 (decision 120). And a text model that ships without caching would be filtered out
 * wrongly — which is what „Wpisz nazwę ręcznie" in Settings is for, and why it stays.
 */
const SPECIALIZED =
  /(^|-)(image|tts|transcribe|robotics|computer-use|embedding|audio|live|omni)(-|$)/;

function isUsableForImport(id: string, methods: readonly string[]): boolean {
  if (!id.startsWith('gemini-') || SPECIALIZED.test(id)) return false;
  return methods.includes('generateContent') && methods.includes('createCachedContent');
}

/**
 * Newest-looking model first.
 *
 * Google's names carry their version (`gemini-3.7-flash` > `gemini-3.6-flash`), so a descending
 * sort puts the current generation on top. Everything in the list is a `gemini-` text model by
 * the time it gets here.
 */
function byUsefulness(a: GeminiModel, b: GeminiModel): number {
  return b.id.localeCompare(a.id);
}

/** Models the key can see that this app can import a recipe with. Never throws; `[]` on failure. */
export async function listGeminiModels(
  apiKey: string,
  fetchImpl: typeof fetch = fetch
): Promise<GeminiModel[]> {
  const key = apiKey.trim();
  if (key === '') return [];

  let response: Response;
  try {
    // The key travels in the header, as everywhere else — never in the URL.
    response = await fetchImpl(MODELS_ENDPOINT, { headers: { 'x-goog-api-key': key } });
  } catch {
    return [];
  }
  if (!response.ok) return [];

  const body = (await response.json().catch(() => ({}))) as ModelsResponse;

  return (body.models ?? [])
    .map((model) => {
      const id = (model.name ?? '').replace(/^models\//, '');
      const methods = model.supportedGenerationMethods ?? [];
      return { id, label: model.displayName ?? id, methods };
    })
    .filter((model) => isUsableForImport(model.id, model.methods))
    .map(({ id, label }) => ({ id, label }))
    .sort(byUsefulness);
}

/** The list to render, with `current` guaranteed present even when the fetch found nothing. */
export function withCurrentModel(models: readonly GeminiModel[], current: string): GeminiModel[] {
  const name = current.trim();
  if (name === '' || models.some((model) => model.id === name)) return [...models];
  // A name typed by hand, or one Google has stopped listing: it must stay selectable, or
  // opening Settings would silently switch the user to a different model.
  return [{ id: name, label: name }, ...models];
}
