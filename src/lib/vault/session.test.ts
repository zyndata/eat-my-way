import { beforeEach, describe, expect, it, vi } from 'vitest';
import { repository } from '../repository';

/**
 * The undo path for STATE.md decision 150: when sync adopts Drive's vault, the copy this
 * device held is kept in `vaultFileReplaced` so the swap is reversible.
 *
 * `session.svelte.ts` keeps the parsed file and the derived key in module scope, so every test
 * imports a fresh copy. Only unencrypted vaults are used here — the KDF is covered by
 * `vault.test.ts`, and Argon2 in a worker has nothing to do with what is under test.
 */

type Session = typeof import('./session.svelte');

const A = '{"v":1,"kdf":"none","data":{"geminiApiKey":"local"}}';
const B = '{"v":1,"kdf":"none","data":{"geminiApiKey":"from-drive"}}';

async function load(): Promise<Session> {
  vi.resetModules();
  return import('./session.svelte');
}

beforeEach(async () => {
  await repository.deleteMeta('vaultFile');
  await repository.deleteMeta('vaultFileReplaced');
});

describe('a vault replaced by the copy from Drive', () => {
  it('offers the undo on a later load, not only while the sync is fresh', async () => {
    await repository.setMeta('vaultFile', B);
    await repository.setMeta('vaultFileReplaced', A);

    const session = await load();
    expect(await session.loadVault()).toBe('unlocked');
    expect(session.vaultState.replaced).toBe(true);
  });

  it('puts the local vault back and leaves nothing to undo twice', async () => {
    await repository.setMeta('vaultFile', B);
    await repository.setMeta('vaultFileReplaced', A);

    const session = await load();
    await session.loadVault();
    await session.restoreReplacedVault();

    expect(await repository.getMeta('vaultFile')).toBe(A);
    expect(await repository.getMeta('vaultFileReplaced')).toBeUndefined();
    expect(session.vaultState.replaced).toBe(false);
    expect(session.geminiApiKey()).toBe('local');
  });

  it('retires the offer once the user writes a vault on this device', async () => {
    await repository.setMeta('vaultFile', B);
    await repository.setMeta('vaultFileReplaced', A);

    const session = await load();
    await session.loadVault();
    await session.saveSecrets({ geminiApiKey: 'chosen-here' });

    expect(session.vaultState.replaced).toBe(false);
    expect(await repository.getMeta('vaultFileReplaced')).toBeUndefined();
  });

  it('says nothing when no vault was replaced', async () => {
    await repository.setMeta('vaultFile', A);

    const session = await load();
    await session.loadVault();
    expect(session.vaultState.replaced).toBe(false);
  });
});
