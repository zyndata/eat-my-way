import { describe, expect, it } from 'vitest';
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
});
