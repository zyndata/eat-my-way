import { repository } from '../repository';
import { argon2Kdf } from './argon2';
import {
  createEncryptedVault,
  createPlainVault,
  resealVault,
  unlockVault,
  type UnlockedVault
} from './crypto';
import {
  VaultCorruptError,
  WrongPasswordError,
  isEncrypted,
  parseVaultJson,
  serializeVaultFile,
  type VaultFile,
  type VaultSecrets
} from './format';

/**
 * The vault as the rest of the app sees it: a small piece of state plus the handful of acts a
 * user can perform on it.
 *
 * The derived key lives in `unlocked` and nowhere else — not in `localStorage`, not in
 * IndexedDB, not in a Svelte store that gets serialized. Reloading the page locks the vault
 * again, which is the intended cost of not persisting a key.
 *
 * The calendar and the recipe library never touch any of this. A locked vault is a completely
 * normal state and blocks exactly one thing: talking to Gemini (PLAN.md).
 */

export type VaultStatus =
  /** Not read from IndexedDB yet. */
  | 'unknown'
  /** No vault exists on this device — the first-run wizard creates one. */
  | 'absent'
  /** A vault exists, is encrypted, and no key is held. */
  | 'locked'
  /** Secrets are readable: either unlocked, or the vault is in unencrypted mode. */
  | 'unlocked'
  /** `vault.json` is unreadable. Never the same thing as a wrong password. */
  | 'corrupt';

/** After this many wrong passwords the UI stops being terse and explains the situation. */
export const ATTEMPTS_BEFORE_EXPLANATION = 3;

export const vaultState = $state<{
  status: VaultStatus;
  /** Whether the stored vault is in encrypted mode. Meaningless while `absent`. */
  encrypted: boolean;
  failedAttempts: number;
  /** Polish message for the user, or `''`. */
  message: string;
  /** True while an Argon2 derivation is running — it takes about a second. */
  busy: boolean;
  /**
   * A vault this device held before sync adopted Drive's copy is still around, so the swap
   * can be undone (decision 150). Survives a reload, because the offer has to outlive the
   * sync that made it.
   */
  replaced: boolean;
}>({
  status: 'unknown',
  encrypted: true,
  failedAttempts: 0,
  message: '',
  busy: false,
  replaced: false
});

/** The parsed file, kept so a reseal reuses its salt and parameters. */
let file: VaultFile | null = null;
/** The exact text `file` was parsed from, so `loadVault` can tell a changed file from a reread. */
let loadedText: string | null = null;
/** The decrypted contents and the key. Cleared by `lockVault`. */
let unlocked: UnlockedVault | null = null;

/** What a caller reads once the vault is open. `undefined` while it is locked. */
export function vaultSecrets(): VaultSecrets | undefined {
  return unlocked?.secrets;
}

/** The Gemini key, or `undefined` when there is none or the vault is locked (Phase 7). */
export function geminiApiKey(): string | undefined {
  return unlocked?.secrets.geminiApiKey;
}

async function persist(next: VaultFile, opened: UnlockedVault | null): Promise<void> {
  const text = serializeVaultFile(next);
  file = next;
  loadedText = text;
  unlocked = opened;
  await repository.setMeta('vaultFile', text);
  // Writing a vault deliberately is the user taking charge of this device's secrets, which
  // retires the undo offer from an earlier adoption.
  await forgetReplacedVault();
  vaultState.encrypted = isEncrypted(next);
  vaultState.status = opened === null ? 'locked' : 'unlocked';
  vaultState.failedAttempts = 0;
  vaultState.message = '';
}

/** Drop the kept pre-adoption copy, if there is one. */
async function forgetReplacedVault(): Promise<void> {
  if (!vaultState.replaced) return;
  vaultState.replaced = false;
  await repository.deleteMeta('vaultFileReplaced');
}

/**
 * Put back the vault this device held before sync adopted Drive's copy (decision 150). The
 * restored file differs from the baseline the last sync recorded, so the next sync uploads it
 * and Drive's copy loses in turn — which is exactly what "undo" has to mean here.
 */
export async function restoreReplacedVault(): Promise<VaultStatus> {
  const text = await repository.getMeta('vaultFileReplaced');
  if (text === undefined) {
    vaultState.replaced = false;
    return vaultState.status;
  }
  await repository.setMeta('vaultFile', text);
  await repository.deleteMeta('vaultFileReplaced');
  vaultState.replaced = false;
  vaultState.failedAttempts = 0;
  vaultState.message = '';
  return loadVault();
}

/** Read `vault.json` out of IndexedDB. Safe to call repeatedly. */
export async function loadVault(): Promise<VaultStatus> {
  vaultState.replaced = (await repository.getMeta('vaultFileReplaced')) !== undefined;
  const text = await repository.getMeta('vaultFile');
  if (text === undefined) {
    file = null;
    loadedText = null;
    unlocked = null;
    vaultState.status = 'absent';
    return 'absent';
  }

  // A different file means a different key. This happens when sync adopts the copy from
  // Drive: holding on to the key derived from the old one would leave the vault "open" with
  // a key that cannot decrypt anything in it.
  if (loadedText !== null && loadedText !== text) unlocked = null;
  loadedText = text;

  try {
    file = parseVaultJson(text);
  } catch (error) {
    file = null;
    unlocked = null;
    vaultState.status = 'corrupt';
    vaultState.message =
      error instanceof VaultCorruptError
        ? 'Plik sejfu jest uszkodzony i nie da się go odczytać. To nie jest kwestia hasła.'
        : 'Nie udało się odczytać sejfu.';
    return 'corrupt';
  }

  vaultState.encrypted = isEncrypted(file);
  if (!isEncrypted(file)) {
    unlocked = { secrets: file.data, encrypted: false };
    vaultState.status = 'unlocked';
    return 'unlocked';
  }

  // An encrypted vault always starts locked: the key is never persisted anywhere.
  if (unlocked === null) vaultState.status = 'locked';
  return vaultState.status;
}

/** Create the vault the wizard asks for. `password` is ignored in unencrypted mode. */
export async function createVault(encrypt: boolean, password: string): Promise<void> {
  vaultState.busy = true;
  try {
    const created = encrypt
      ? await createEncryptedVault({}, password, argon2Kdf)
      : createPlainVault({});
    await persist(created.file, created.unlocked);
  } finally {
    vaultState.busy = false;
  }
}

export type UnlockResult = 'unlocked' | 'wrong-password' | 'corrupt' | 'absent';

/**
 * Try a password. A wrong one is counted so the screen can explain, after three tries, that
 * the password cannot be recovered — and that starting over costs only the vault's contents.
 */
export async function unlock(password: string): Promise<UnlockResult> {
  if (file === null) await loadVault();
  if (file === null) return 'absent';

  vaultState.busy = true;
  try {
    unlocked = await unlockVault(file, password, argon2Kdf);
    vaultState.status = 'unlocked';
    vaultState.failedAttempts = 0;
    vaultState.message = '';
    return 'unlocked';
  } catch (error) {
    if (error instanceof WrongPasswordError) {
      vaultState.failedAttempts += 1;
      vaultState.message =
        vaultState.failedAttempts >= ATTEMPTS_BEFORE_EXPLANATION
          ? 'Nieprawidłowe hasło. Hasła głównego nie da się odzyskać — nikt go nie przechowuje. ' +
            'Jeśli go nie pamiętasz, możesz założyć sejf od nowa: stracisz tylko klucz Gemini, ' +
            'a kalendarz i przepisy zostaną nietknięte.'
          : 'Nieprawidłowe hasło.';
      return 'wrong-password';
    }
    vaultState.status = 'corrupt';
    vaultState.message =
      'Plik sejfu jest uszkodzony i nie da się go odczytać. To nie jest kwestia hasła.';
    return 'corrupt';
  } finally {
    vaultState.busy = false;
  }
}

/** Drop the key. Called on sign-out; the vault file itself is untouched. */
export function lockVault(): void {
  unlocked = null;
  if (vaultState.status === 'unlocked' && vaultState.encrypted) vaultState.status = 'locked';
}

/** Store a secret. Requires an open vault; reuses the key already in memory. */
export async function saveSecrets(changes: Partial<VaultSecrets>): Promise<void> {
  if (unlocked === null) throw new Error('The vault is locked');
  const secrets: VaultSecrets = { ...unlocked.secrets, ...changes };
  const resealed = await resealVault(unlocked, secrets);
  await persist(resealed.file, resealed.unlocked);
}

/**
 * Every mode transition is the same three steps: read the secrets out, build a new file, write
 * it. Nothing is ever re-derived from a half-written state, so an interrupted transition
 * leaves the previous file in place.
 */
export async function setPassword(password: string): Promise<void> {
  if (unlocked === null) throw new Error('The vault is locked');
  vaultState.busy = true;
  try {
    const created = await createEncryptedVault(unlocked.secrets, password, argon2Kdf);
    await persist(created.file, created.unlocked);
  } finally {
    vaultState.busy = false;
  }
}

/** Turn encryption off. The UI asks twice before calling this (PLAN.md). */
export async function disableEncryption(): Promise<void> {
  if (unlocked === null) throw new Error('The vault is locked');
  const plain = createPlainVault(unlocked.secrets);
  await persist(plain.file, plain.unlocked);
}

/**
 * Throw the vault away — the only answer to a forgotten password, and to a corrupted file.
 * The device is left with no vault at all, so the ordinary creation form comes back and the
 * user chooses the mode and password again; this deliberately does not create a replacement
 * on their behalf, because there is no password it could reasonably pick.
 *
 * Nothing outside the vault is touched. The calendar, the recipes and the ingredients are not
 * stored in it and do not know it exists — which is exactly what makes losing it survivable.
 */
export async function forgetVault(): Promise<void> {
  file = null;
  loadedText = null;
  unlocked = null;
  vaultState.failedAttempts = 0;
  vaultState.message = '';
  vaultState.encrypted = true;
  vaultState.status = 'absent';
  await repository.deleteMeta('vaultFile');
  await forgetReplacedVault();
}

/**
 * The unlock prompt, opened on demand rather than on start-up: PLAN.md says the unlock screen
 * appears "only when a Gemini call needs the key", so nothing in the calendar or the recipe
 * library ever triggers it. Phase 7 awaits `requestUnlock()` before its first API call.
 */
export const unlockPrompt = $state<{ open: boolean }>({ open: false });

let settleUnlock: ((opened: boolean) => void) | null = null;

/** Resolves `true` once the vault is open, `false` if the user gave up. */
export function requestUnlock(): Promise<boolean> {
  if (vaultState.status === 'unlocked') return Promise.resolve(true);
  if (settleUnlock !== null) return Promise.resolve(false);

  unlockPrompt.open = true;
  return new Promise<boolean>((resolve) => {
    settleUnlock = resolve;
  });
}

/** Closes the prompt. Called by the dialog, either after a successful unlock or on dismissal. */
export function closeUnlockPrompt(opened: boolean): void {
  unlockPrompt.open = false;
  const settle = settleUnlock;
  settleUnlock = null;
  settle?.(opened);
}
