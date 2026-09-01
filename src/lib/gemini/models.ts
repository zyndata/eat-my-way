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
 * Newest-looking Gemini models first, then everything else alphabetically.
 *
 * Google's names carry their version (`gemini-3.7-flash` > `gemini-3.6-flash`), so a descending
 * sort puts the current generation on top — but only within the `gemini-` family, or unrelated
 * products like `lyria-` and `nano-banana-` would outrank it on the letter alone. That prefix is
 * a display nicety, not a filter: everything the API returned is still in the list.
 */
function byUsefulness(a: GeminiModel, b: GeminiModel): number {
  const aGemini = a.id.startsWith('gemini-');
  const bGemini = b.id.startsWith('gemini-');
  if (aGemini !== bGemini) return aGemini ? -1 : 1;
  return aGemini ? b.id.localeCompare(a.id) : a.id.localeCompare(b.id);
}

/** Models the key can see that can actually generate text. Never throws; `[]` on any failure. */
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
    .filter((model) => (model.supportedGenerationMethods ?? []).includes('generateContent'))
    .map((model) => {
      const id = (model.name ?? '').replace(/^models\//, '');
      return { id, label: model.displayName ?? id };
    })
    .filter((model) => model.id !== '')
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
