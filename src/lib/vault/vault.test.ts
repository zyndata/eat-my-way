import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ARGON2_PARAMS,
  VaultCorruptError,
  WrongPasswordError,
  isEncrypted,
  parseVaultJson,
  serializeVaultFile,
  type Argon2Params
} from './format';
import {
  createEncryptedVault,
  createPlainVault,
  decryptVault,
  encryptVault,
  fromBase64,
  resealVault,
  toBase64,
  unlockVault,
  type Argon2Kdf
} from './crypto';

/**
 * The real KDF is 64 MB of Argon2id in a Web Worker; running it per test case would cost more
 * than the rest of the suite put together and would prove nothing about the vault format. It
 * is stubbed with something that still depends on the password, the salt *and* the parameters,
 * so "a vault written with different params still unlocks" is a real assertion.
 */
const stubKdf: Argon2Kdf = async (password, salt, params) => {
  const seed = `${password}|${toBase64(salt)}|${params.memorySize}|${params.iterations}|${params.parallelism}`;
  const bytes = new TextEncoder().encode(seed);
  const key = new Uint8Array(params.hashLength);
  for (let index = 0; index < key.length; index += 1) {
    let value = index * 31 + 7;
    for (const byte of bytes) value = (value * 33 + byte) & 0xff;
    key[index] = value;
  }
  return key;
};

const secrets = { geminiApiKey: 'AIza-test-key' };

describe('vault format', () => {
  it('round-trips an encrypted vault through JSON', async () => {
    const { file } = await createEncryptedVault(secrets, 'correct horse', stubKdf);
    const parsed = parseVaultJson(serializeVaultFile(file));

    expect(isEncrypted(parsed)).toBe(true);
    expect(parsed).toEqual(file);
  });

  it('stores the KDF parameters in the file, not in code', async () => {
    const { file } = await createEncryptedVault(secrets, 'pw', stubKdf);
    expect(isEncrypted(file) && file.params).toEqual(DEFAULT_ARGON2_PARAMS);
  });

  it('rejects an unknown format version as corruption', () => {
    expect(() => parseVaultJson('{"v":2,"kdf":"argon2id"}')).toThrow(VaultCorruptError);
  });

  it('rejects text that is not JSON as corruption', () => {
    expect(() => parseVaultJson('not json at all')).toThrow(VaultCorruptError);
  });

  it('rejects a vault whose salt is missing', () => {
    expect(() => parseVaultJson('{"v":1,"kdf":"argon2id","params":{},"data":"AAAA"}')).toThrow(
      VaultCorruptError
    );
  });
});

describe('unlocking', () => {
  it('opens with the right password', async () => {
    const { file } = await createEncryptedVault(secrets, 'right', stubKdf);
    const unlocked = await unlockVault(file, 'right', stubKdf);

    expect(unlocked.secrets).toEqual(secrets);
    expect(unlocked.encrypted).toBe(true);
  });

  it('reports a wrong password through the verifier, not a decode failure', async () => {
    const { file } = await createEncryptedVault(secrets, 'right', stubKdf);
    await expect(unlockVault(file, 'wrong', stubKdf)).rejects.toBeInstanceOf(WrongPasswordError);
  });

  it('reports damage separately when the verifier opens but the body does not', async () => {
    const { file } = await createEncryptedVault(secrets, 'right', stubKdf);
    if (!isEncrypted(file)) throw new Error('expected an encrypted vault');

    // Flip a byte of the ciphertext, leaving the verifier intact.
    const bytes = fromBase64(file.data);
    bytes.set([(bytes[0] ?? 0) ^ 0xff], 0);
    const damaged = { ...file, data: toBase64(bytes) };

    await expect(unlockVault(damaged, 'right', stubKdf)).rejects.toBeInstanceOf(VaultCorruptError);
  });

  it('unlocks a vault written with different KDF parameters', async () => {
    const cheaper: Argon2Params = { memorySize: 8192, iterations: 1, parallelism: 1, hashLength: 32 };
    const { file } = await createEncryptedVault(secrets, 'pw', stubKdf, cheaper);

    // The reader never sees `cheaper`; it reads the numbers out of the file.
    const unlocked = await unlockVault(parseVaultJson(serializeVaultFile(file)), 'pw', stubKdf);
    expect(unlocked.secrets).toEqual(secrets);
    expect(unlocked.params).toEqual(cheaper);
  });

  it('opens an unencrypted vault without a password', async () => {
    const { file } = createPlainVault(secrets);
    const unlocked = await unlockVault(file, '', stubKdf);

    expect(unlocked.secrets).toEqual(secrets);
    expect(unlocked.encrypted).toBe(false);
  });
});

describe('mode transitions', () => {
  it('preserves the Gemini key through encrypt -> decrypt -> re-encrypt', async () => {
    const first = await encryptVault(secrets, 'one', stubKdf);
    const opened = await unlockVault(first.file, 'one', stubKdf);

    const plain = decryptVault(opened.secrets);
    expect(isEncrypted(plain.file)).toBe(false);
    expect(plain.unlocked.secrets.geminiApiKey).toBe('AIza-test-key');

    const again = await encryptVault(plain.unlocked.secrets, 'two', stubKdf);
    const reopened = await unlockVault(again.file, 'two', stubKdf);
    expect(reopened.secrets.geminiApiKey).toBe('AIza-test-key');

    // The old password must not open the new file.
    await expect(unlockVault(again.file, 'one', stubKdf)).rejects.toBeInstanceOf(WrongPasswordError);
  });

  it('draws a fresh salt on a password change', async () => {
    const first = await createEncryptedVault(secrets, 'one', stubKdf);
    const second = await createEncryptedVault(secrets, 'two', stubKdf);
    expect(isEncrypted(first.file) && isEncrypted(second.file) && first.file.salt).not.toBe(
      isEncrypted(second.file) ? second.file.salt : ''
    );
  });

  it('reseals with the key already in memory, without the password', async () => {
    const { unlocked } = await createEncryptedVault({}, 'pw', stubKdf);
    const resealed = await resealVault(unlocked, { geminiApiKey: 'added-later' });

    const reopened = await unlockVault(resealed.file, 'pw', stubKdf);
    expect(reopened.secrets.geminiApiKey).toBe('added-later');
  });

  it('refuses to reseal an encrypted vault it does not hold the key for', async () => {
    await expect(
      resealVault({ secrets: {}, encrypted: true }, { geminiApiKey: 'x' })
    ).rejects.toThrow(/without its key/);
  });
});
