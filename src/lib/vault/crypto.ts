import {
  DEFAULT_ARGON2_PARAMS,
  EMPTY_SECRETS,
  VERIFIER_PLAINTEXT,
  VaultCorruptError,
  WrongPasswordError,
  isEncrypted,
  type Argon2Params,
  type EncryptedVaultFile,
  type PlainVaultFile,
  type Sealed,
  type VaultFile,
  type VaultSecrets
} from './format';

/**
 * Vault encryption: Argon2id for the key, AES-GCM for the bytes.
 *
 * The KDF arrives as a function rather than being imported here, for two reasons. In the
 * browser it is a Web Worker (64 MB of Argon2 must not run on the UI thread); in tests it is
 * a cheap stub, so the suite does not spend a second per case grinding memory.
 */

/** Derives raw key bytes from a password. `params` always come from the vault file. */
export type Argon2Kdf = (
  password: string,
  salt: Uint8Array,
  params: Argon2Params
) => Promise<Uint8Array>;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** AES-GCM nonce length in bytes; 96 bits is the size the algorithm is specified for. */
const IV_BYTES = 12;

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function fromBase64(value: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new VaultCorruptError('vault.json contains malformed base64');
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

async function importKey(raw: Uint8Array): Promise<CryptoKey> {
  // `false` for extractable: once derived, the key cannot be read back out of WebCrypto.
  return crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, [
    'encrypt',
    'decrypt'
  ]);
}

async function seal(key: CryptoKey, plaintext: string): Promise<Sealed> {
  const iv = randomBytes(IV_BYTES);
  const data = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    encoder.encode(plaintext) as BufferSource
  );
  return { iv: toBase64(iv), data: toBase64(new Uint8Array(data)) };
}

/** Returns `undefined` when the tag does not verify — the caller decides what that means. */
async function open(key: CryptoKey, sealed: Sealed): Promise<string | undefined> {
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(sealed.iv) as BufferSource },
      key,
      fromBase64(sealed.data) as BufferSource
    );
    return decoder.decode(plaintext);
  } catch {
    return undefined;
  }
}

/**
 * An unlocked vault. `key` never leaves memory: it is not extractable, is not persisted, and
 * is dropped when the session locks (PLAN.md "decrypted vault key lives only in memory").
 */
export interface UnlockedVault {
  secrets: VaultSecrets;
  /** Absent for an unencrypted vault, which has no key at all. */
  key?: CryptoKey;
  /** The parameters the file was written with — reused verbatim when it is rewritten. */
  params?: Argon2Params;
  salt?: string;
  encrypted: boolean;
}

function parseSecrets(text: string): VaultSecrets {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new VaultCorruptError('The vault decrypted into something that is not JSON');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new VaultCorruptError('The vault decrypted into something that is not a secret set');
  }
  return value as VaultSecrets;
}

/** Encrypt `secrets` under a password, using `params` (defaults to PLAN.md's cost). */
export async function createEncryptedVault(
  secrets: VaultSecrets,
  password: string,
  kdf: Argon2Kdf,
  params: Argon2Params = DEFAULT_ARGON2_PARAMS
): Promise<{ file: EncryptedVaultFile; unlocked: UnlockedVault }> {
  const salt = randomBytes(16);
  const key = await importKey(await kdf(password, salt, params));
  const body = await seal(key, JSON.stringify(secrets));
  const verifier = await seal(key, VERIFIER_PLAINTEXT);
  const saltText = toBase64(salt);

  return {
    file: { v: 1, kdf: 'argon2id', params, salt: saltText, iv: body.iv, data: body.data, verifier },
    unlocked: { secrets, key, params, salt: saltText, encrypted: true }
  };
}

export function createPlainVault(secrets: VaultSecrets): {
  file: PlainVaultFile;
  unlocked: UnlockedVault;
} {
  return { file: { v: 1, kdf: 'none', data: secrets }, unlocked: { secrets, encrypted: false } };
}

/**
 * Open a vault file. The verifier is decrypted first: if it fails the password is wrong, and
 * if it succeeds but the body does not decrypt, the file itself is damaged.
 */
export async function unlockVault(
  file: VaultFile,
  password: string,
  kdf: Argon2Kdf
): Promise<UnlockedVault> {
  if (!isEncrypted(file)) return { secrets: file.data, encrypted: false };

  const key = await importKey(await kdf(password, fromBase64(file.salt), file.params));

  const verifier = await open(key, file.verifier);
  if (verifier === undefined) throw new WrongPasswordError();
  if (verifier !== VERIFIER_PLAINTEXT) {
    throw new VaultCorruptError('The vault verifier holds unexpected content');
  }

  const body = await open(key, { iv: file.iv, data: file.data });
  if (body === undefined) {
    throw new VaultCorruptError('The vault opened but its contents could not be decrypted');
  }

  return { secrets: parseSecrets(body), key, params: file.params, salt: file.salt, encrypted: true };
}

/**
 * Rewrite an unlocked vault with new secrets, reusing its existing key, salt and parameters.
 * This is the ordinary "save the Gemini key" path: no password is needed, because the key is
 * already in memory.
 */
export async function resealVault(
  unlocked: UnlockedVault,
  secrets: VaultSecrets
): Promise<{ file: VaultFile; unlocked: UnlockedVault }> {
  if (!unlocked.encrypted) return createPlainVault(secrets);

  const { key, params, salt } = unlocked;
  if (key === undefined || params === undefined || salt === undefined) {
    throw new Error('An encrypted vault cannot be resealed without its key');
  }

  const body = await seal(key, JSON.stringify(secrets));
  const verifier = await seal(key, VERIFIER_PLAINTEXT);
  return {
    file: { v: 1, kdf: 'argon2id', params, salt, iv: body.iv, data: body.data, verifier },
    unlocked: { ...unlocked, secrets }
  };
}

/**
 * Mode transitions (PLAN.md): enabling encryption, changing the password and disabling
 * encryption are all the same act — read the secrets, then write a fresh file. A password
 * change deliberately draws a new salt, so the old file's ciphertext is unrelated to the new.
 */
export async function encryptVault(
  secrets: VaultSecrets,
  password: string,
  kdf: Argon2Kdf,
  params: Argon2Params = DEFAULT_ARGON2_PARAMS
): Promise<{ file: VaultFile; unlocked: UnlockedVault }> {
  return createEncryptedVault(secrets, password, kdf, params);
}

export function decryptVault(secrets: VaultSecrets): { file: VaultFile; unlocked: UnlockedVault } {
  return createPlainVault(secrets);
}

/** A brand new, empty vault in whichever mode the user chose. */
export async function newVault(
  encrypt: boolean,
  password: string,
  kdf: Argon2Kdf
): Promise<{ file: VaultFile; unlocked: UnlockedVault }> {
  return encrypt ? createEncryptedVault(EMPTY_SECRETS, password, kdf) : createPlainVault(EMPTY_SECRETS);
}
