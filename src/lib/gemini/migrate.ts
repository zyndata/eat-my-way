import { DEFAULT_GEMINI_MODEL, PREVIOUS_DEFAULT_GEMINI_MODEL } from '../db';
import { repository as defaultRepository, type Repository } from '../repository';

/**
 * One-time repair of a default this app got wrong.
 *
 * A profile written before `gemini-3.6-flash` holds `gemini-2.5-flash` — not a choice anyone
 * made, but the default of the day, which Google has since stopped serving to new keys. Left
 * alone it makes every import fail with a 404 until the user edits Settings by hand, and the
 * new default never reaches them because a stored profile always wins over `DEFAULT_PROFILE`.
 *
 * Narrow on purpose: it rewrites that exact string and nothing else. A model the user typed —
 * including a deliberate `gemini-2.5-pro`, or a name this build has never heard of — is left
 * exactly as it is. Idempotent, so running it on every start costs one read.
 */
export async function migrateRetiredDefaultModel(
  repository: Repository = defaultRepository
): Promise<boolean> {
  const profile = await repository.getProfile();
  if (profile.geminiModel !== PREVIOUS_DEFAULT_GEMINI_MODEL) return false;

  await repository.saveProfile({ ...profile, geminiModel: DEFAULT_GEMINI_MODEL });
  return true;
}
