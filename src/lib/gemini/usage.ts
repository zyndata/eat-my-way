import type { GeminiUsage, Profile } from '../types';
import { newId } from '../ids';
import { repository as defaultRepository, type Repository } from '../repository';

/**
 * Counting what this account spends on Gemini.
 *
 * There is no endpoint that reports remaining quota — Google's own 429 points at a web page
 * (`ai.dev/rate-limit`) — so the only honest number the app can show is **its own** spend. It
 * is not authoritative: a request made from AI Studio, or from another app on the same key,
 * is invisible here. The screen says so.
 *
 * What makes it worth showing anyway is how small the free tier is: 20 requests per day per
 * model, against 2 requests for a pasted import and 3 for a link (STATE.md decision 124).
 */

/**
 * Google's free-tier daily quota resets at midnight Pacific, not in the user's timezone — nine
 * hours apart from Poland, so bucketing by local date would zero the counter at the wrong time
 * and, worse, keep showing "0" through a morning that is still yesterday's exhausted window.
 */
const QUOTA_TIMEZONE = 'America/Los_Angeles';

/**
 * Requests one import costs: two for pasted text (parse, match), three for a link (retrieval
 * first) — and one for a package scan, which is a single call with a picture attached
 * (PLAN.md Phase 12 task 6). Used only to turn a request count into „about N recipes" on screen.
 *
 * There is deliberately no constant for the daily cap. It is **not** one number: Google's own
 * dashboard shows 20 requests a day for `gemini-3.6-flash` and 500 for `gemini-3.5-flash-lite`,
 * and nothing in the API reports it until a 429 arrives (STATE.md decision 129). Printing „20"
 * as a fact would be wrong for most models.
 */
export const REQUESTS_PER_IMPORT = { paste: 2, link: 3, scan: 1 } as const;

/** `YYYY-MM-DD` of the current quota window. `en-CA` is ISO order by definition. */
export function quotaDay(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: QUOTA_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(now);
}

/** This device's id, minted once. Local-only: it is a map key, never an identity. */
export async function deviceId(repository: Repository = defaultRepository): Promise<string> {
  const stored = await repository.getMeta('deviceId');
  if (stored !== undefined && stored !== '') return stored;
  const minted = newId();
  await repository.setMeta('deviceId', minted);
  return minted;
}

/**
 * Add one device's spend to the profile. A tally from an earlier quota day is not carried
 * forward — it is replaced, because the window it counted has closed.
 *
 * Only this device's entry is ever written, which is what lets `mergeGeminiUsage` union two
 * profiles without a coordinator (types.ts).
 */
export function addUsage(
  usage: GeminiUsage | undefined,
  id: string,
  spent: { requests: number; tokens: number },
  day: string,
  model: string
): GeminiUsage {
  const current = usage?.day === day ? usage : { day, models: {} };
  const byDevice = current.models[model] ?? {};
  const mine = byDevice[id] ?? { requests: 0, tokens: 0 };
  return {
    day,
    models: {
      ...current.models,
      [model]: {
        ...byDevice,
        [id]: { requests: mine.requests + spent.requests, tokens: mine.tokens + spent.tokens }
      }
    }
  };
}

/**
 * Record what an import just spent. Returns the profile it wrote, or `undefined` when there
 * was nothing to record — a failed import that never reached Google costs no quota.
 */
export async function recordGeminiUsage(
  spent: { requests: number; tokens: number },
  model: string,
  options: { repository?: Repository; now?: Date } = {}
): Promise<Profile | undefined> {
  if (spent.requests <= 0 || model.trim() === '') return undefined;
  const repository = options.repository ?? defaultRepository;

  const [profile, id] = await Promise.all([repository.getProfile(), deviceId(repository)]);
  const geminiUsage = addUsage(profile.geminiUsage, id, spent, quotaDay(options.now), model.trim());
  return repository.saveProfile({ ...profile, geminiUsage });
}
