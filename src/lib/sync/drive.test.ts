import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDriveBackend } from './drive';
import { NotAuthenticatedError, RemoteChangedError } from './backend';

/**
 * The Drive client against a scripted `fetch`. What is worth asserting here is not that Google
 * works, but that this client keeps its two promises: it re-reads `modifiedTime` immediately
 * before every write (PLAN.md task 3), and it never asks for anything outside `appDataFolder`.
 */

interface Call {
  url: string;
  method: string;
}

function scripted(handlers: ((url: string, init: RequestInit) => Response | undefined)[]) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, method: init.method ?? 'GET' });
    for (const handler of handlers) {
      const response = handler(url, init);
      if (response !== undefined) return response;
    }
    throw new Error(`Unscripted request: ${init.method ?? 'GET'} ${url}`);
  }) as typeof fetch;

  return { calls, fetchImpl };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const token = async () => 'test-token';

describe('drive backend', () => {
  it('scopes every listing to appDataFolder', async () => {
    const { calls, fetchImpl } = scripted([
      (url) => (url.includes('/drive/v3/files?') ? json({ files: [] }) : undefined)
    ]);
    const backend = createDriveBackend({ fetchImpl, token });

    await backend.list();
    expect(calls[0]?.url).toContain('spaces=appDataFolder');
  });

  it('re-reads the version immediately before writing', async () => {
    const { calls, fetchImpl } = scripted([
      (url) =>
        url.includes('/drive/v3/files?') && url.includes('name+%3D')
          ? json({ files: [{ id: 'file-1', modifiedTime: 't1' }] })
          : undefined,
      (url) =>
        url.includes('/drive/v3/files/file-1?fields=') ? json({ id: 'file-1', modifiedTime: 't1' }) : undefined,
      (url) => (url.includes('/upload/drive/v3/files') ? json({ id: 'file-1', modifiedTime: 't2' }) : undefined)
    ]);
    const backend = createDriveBackend({ fetchImpl, token });

    const version = await backend.write('profile.json', '{}', { fileId: 'file-1', modifiedTime: 't1' });

    expect(version).toEqual({ fileId: 'file-1', modifiedTime: 't2' });
    // The metadata read has to come before the upload, or the guard is theatre.
    const metadataIndex = calls.findIndex((call) => call.url.includes('/files/file-1?fields='));
    const uploadIndex = calls.findIndex((call) => call.url.includes('/upload/'));
    expect(metadataIndex).toBeGreaterThanOrEqual(0);
    expect(metadataIndex).toBeLessThan(uploadIndex);
  });

  it('refuses the write when the file moved underneath it', async () => {
    const { calls, fetchImpl } = scripted([
      (url) =>
        url.includes('/drive/v3/files/file-1?fields=') ? json({ id: 'file-1', modifiedTime: 't9' }) : undefined
    ]);
    const backend = createDriveBackend({ fetchImpl, token });

    await expect(
      backend.write('profile.json', '{}', { fileId: 'file-1', modifiedTime: 't1' })
    ).rejects.toBeInstanceOf(RemoteChangedError);
    expect(calls.some((call) => call.url.includes('/upload/'))).toBe(false);
  });

  it('refuses to create a file that turns out to exist already', async () => {
    const { fetchImpl } = scripted([
      (url) =>
        url.includes('/drive/v3/files?') ? json({ files: [{ id: 'file-1', modifiedTime: 't1' }] }) : undefined,
      (url) =>
        url.includes('/drive/v3/files/file-1?fields=') ? json({ id: 'file-1', modifiedTime: 't1' }) : undefined
    ]);
    const backend = createDriveBackend({ fetchImpl, token });

    await expect(backend.write('profile.json', '{}', null)).rejects.toBeInstanceOf(RemoteChangedError);
  });

  it('turns a 401 into a re-authentication, not a generic failure', async () => {
    const { fetchImpl } = scripted([() => json({ error: { message: 'Invalid Credentials' } }, 401)]);
    const backend = createDriveBackend({ fetchImpl, token });

    await expect(backend.list()).rejects.toBeInstanceOf(NotAuthenticatedError);
  });

  it('reads the account identity from about.get, the only identity the scope exposes', async () => {
    const { fetchImpl } = scripted([
      (url) =>
        url.includes('/drive/v3/about')
          ? json({ user: { permissionId: '1122', emailAddress: 'me@example.com' } })
          : undefined
    ]);
    const backend = createDriveBackend({ fetchImpl, token });

    expect(await backend.authenticate()).toEqual({ id: '1122', label: 'me@example.com' });
  });

  it('reads the storage figures from the same call, and asks for them by name', async () => {
    const { calls, fetchImpl } = scripted([
      (url) =>
        url.includes('/drive/v3/about')
          ? json({
              user: { permissionId: '1122', emailAddress: 'me@example.com' },
              // Drive sends 64-bit counts as strings, because JSON numbers are not.
              storageQuota: { limit: '16106127360', usage: '5368709120' }
            })
          : undefined
    ]);
    const backend = createDriveBackend({ fetchImpl, token });

    expect(await backend.authenticate()).toEqual({
      id: '1122',
      label: 'me@example.com',
      storage: { usage: 5_368_709_120, limit: 16_106_127_360 }
    });
    // One request for identity and quota together: the figure costs no extra round trip.
    expect(calls).toHaveLength(1);
    expect(decodeURIComponent(calls[0]?.url ?? '')).toContain('storageQuota(limit,usage)');
  });

  it('reports an account with no fixed limit, and says nothing when Drive says nothing', async () => {
    const unlimited = scripted([
      (url) =>
        url.includes('/drive/v3/about')
          ? json({ user: { permissionId: '1122' }, storageQuota: { usage: '1024' } })
          : undefined
    ]);
    expect(await createDriveBackend({ fetchImpl: unlimited.fetchImpl, token }).authenticate()).toEqual({
      id: '1122',
      storage: { usage: 1024 }
    });

    // No `storageQuota` at all, or one that cannot be read: the settings row stays away
    // rather than claiming a confident „0 B".
    const silent = scripted([
      (url) =>
        url.includes('/drive/v3/about')
          ? json({ user: { permissionId: '1122' }, storageQuota: { usage: 'nonsense' } })
          : undefined
    ]);
    expect(await createDriveBackend({ fetchImpl: silent.fetchImpl, token }).authenticate()).toEqual({
      id: '1122'
    });
  });
});

/**
 * „Slow down" and „try again" are not failures of this device, and a sync that gave up on one
 * left the two sides apart until the next timer (STATE.md decision 232).
 */
describe('a Drive that asks for a moment', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries a 429 and succeeds, honouring Retry-After', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const { calls, fetchImpl } = scripted([
      (url) => {
        if (!url.includes('/drive/v3/files?')) return undefined;
        attempts += 1;
        return attempts === 1
          ? new Response('{}', { status: 429, headers: { 'Retry-After': '1' } })
          : json({ files: [] });
      }
    ]);

    const backend = createDriveBackend({ fetchImpl, token });
    const listing = backend.list();
    await vi.advanceTimersByTimeAsync(1000);

    await expect(listing).resolves.toEqual([]);
    expect(calls).toHaveLength(2);
  });

  it('gives up after two retries rather than hammering Google', async () => {
    vi.useFakeTimers();
    const { calls, fetchImpl } = scripted([
      (url) => (url.includes('/drive/v3/files?') ? json({}, 503) : undefined)
    ]);

    const backend = createDriveBackend({ fetchImpl, token });
    const listing = backend.list().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(5000);

    await expect(listing).resolves.toBeInstanceOf(Error);
    expect(calls).toHaveLength(3);
  });
});
