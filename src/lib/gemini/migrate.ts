import { DEFAULT_GEMINI_MODEL, PREVIOUS_DEFAULT_GEMINI_MODEL } from '../db';
import { repository as defaultRepository, type Repository } from '../repository';

/**
 * One-time repair of a default this app got wrong.
 *
 * A profile written by the first builds holds `gemini-2.5-flash` — not a choice anyone made,
 * but the default of the day, which Google has since stopped serving to new keys. Left alone it
 * makes every import fail with a 404 until the user edits Settings by hand, and the current
 * default never reaches them because a stored profile always wins over `DEFAULT_PROFILE`.
 *
 * Only that one dead name is repaired. A later default change is *not* migrated: when
 * `DEFAULT_GEMINI_MODEL` moved from `gemini-3.6-flash` to the lite model (decision 171), every
 * profile already holding `gemini-3.6-flash` kept it, because that model still works and
 * swapping a working model under someone is worse than leaving the choice in Settings.
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
