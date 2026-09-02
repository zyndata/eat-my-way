/**
 * The on-disk shape of `vault.json` (PLAN.md "Vault").
 *
 * The KDF parameters live *in the file*, never in code: a vault written by an older build,
 * or by a future one that raises the memory cost, must still unlock with the numbers it was
 * written with. Nothing here derives a key or touches WebCrypto — that is `crypto.ts`.
 */

/** What the vault protects. Grows as new credentials arrive (Cookidoo, later). */
export interface VaultSecrets {
  geminiApiKey?: string;
}

export const EMPTY_SECRETS: VaultSecrets = Object.freeze({});

/**
 * Encrypted under the derived key and decrypted first on every unlock. A key that decrypts
 * this string is the right key, so a failure here means "wrong password" and a failure
 * afterwards means "the file is damaged" — the distinction PLAN.md asks for.
 */
export const VERIFIER_PLAINTEXT = 'eat-my-way-vault-v1';

/** Argon2id cost, as PLAN.md specifies. `memorySize` is in KiB, so 65536 KiB = 64 MB. */
export interface Argon2Params {
  memorySize: number;
  iterations: number;
  parallelism: number;
  hashLength: number;
}

export const DEFAULT_ARGON2_PARAMS: Argon2Params = Object.freeze({
  memorySize: 65536,
  iterations: 3,
  parallelism: 1,
  hashLength: 32
});

/** One AES-GCM ciphertext: its own nonce plus the encrypted bytes, both base64. */
export interface Sealed {
  iv: string;
  data: string;
}

/** The encrypted default. `salt`, `iv` and `data` are base64. */
export interface EncryptedVaultFile {
  v: 1;
  kdf: 'argon2id';
  params: Argon2Params;
  salt: string;
  iv: string;
  data: string;
  /** `VERIFIER_PLAINTEXT` sealed under the same key — tells a wrong password from damage. */
  verifier: Sealed;
}

/** The conscious opt-out (PLAN.md): the same envelope with the secrets stored in the clear. */
export interface PlainVaultFile {
  v: 1;
  kdf: 'none';
  data: VaultSecrets;
}

export type VaultFile = EncryptedVaultFile | PlainVaultFile;

/** Thrown for a file we cannot even read as a vault, as opposed to a wrong password. */
export class VaultCorruptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultCorruptError';
  }
}

/** Thrown when the key derived from the entered password does not open the verifier. */
export class WrongPasswordError extends Error {
  constructor() {
    super('Wrong vault password');
    this.name = 'WrongPasswordError';
  }
}

export function isEncrypted(file: VaultFile): file is EncryptedVaultFile {
  return file.kdf === 'argon2id';
}

function isBase64(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}

function readParams(value: unknown): Argon2Params {
  const params = value as Partial<Argon2Params> | null;
  if (typeof params !== 'object' || params === null) {
    throw new VaultCorruptError('vault.json has no KDF parameters');
  }
  const read = (key: keyof Argon2Params): number => {
    const number = params[key];
    if (typeof number !== 'number' || !Number.isInteger(number) || number <= 0) {
      throw new VaultCorruptError(`vault.json has an invalid KDF parameter: ${key}`);
    }
    return number;
  };
  return {
    memorySize: read('memorySize'),
    iterations: read('iterations'),
    parallelism: read('parallelism'),
    hashLength: read('hashLength')
  };
}

function readSealed(value: unknown, what: string): Sealed {
  const sealed = value as Partial<Sealed> | null;
  if (typeof sealed !== 'object' || sealed === null || !isBase64(sealed.iv) || !isBase64(sealed.data)) {
    throw new VaultCorruptError(`vault.json has an unreadable ${what}`);
  }
  return { iv: sealed.iv, data: sealed.data };
}

/**
 * Validate a parsed `vault.json`. Everything that is not a well-formed vault raises
 * `VaultCorruptError` — including a truncated download or a file from a future format
 * version, both of which must not be mistaken for a typed-in password being wrong.
 */
export function parseVaultFile(value: unknown): VaultFile {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new VaultCorruptError('vault.json is not an object');
  }
  const file = value as Record<string, unknown>;
  if (file.v !== 1) throw new VaultCorruptError(`vault.json has an unsupported version: ${String(file.v)}`);


  if (file.kdf === 'none') {
    if (typeof file.data !== 'object' || file.data === null || Array.isArray(file.data)) {
      throw new VaultCorruptError('vault.json holds no readable secrets');
    }
    return { v: 1, kdf: 'none', data: file.data as VaultSecrets };
  }

  if (file.kdf !== 'argon2id') throw new VaultCorruptError(`vault.json has an unknown KDF: ${String(file.kdf)}`);
  if (!isBase64(file.salt)) throw new VaultCorruptError('vault.json has no usable salt');
  if (!isBase64(file.iv) || !isBase64(file.data)) throw new VaultCorruptError('vault.json has no usable ciphertext');

  return {
    v: 1,
    kdf: 'argon2id',
    params: readParams(file.params),
    salt: file.salt,
    iv: file.iv,
    data: file.data,
    verifier: readSealed(file.verifier, 'verifier')
  };
}

/** Parse the raw text of `vault.json`. Invalid JSON is corruption, not a wrong password. */
export function parseVaultJson(text: string): VaultFile {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new VaultCorruptError('vault.json is not valid JSON');
  }
  return parseVaultFile(value);
}

export function serializeVaultFile(file: VaultFile): string {
  return JSON.stringify(file);
}
