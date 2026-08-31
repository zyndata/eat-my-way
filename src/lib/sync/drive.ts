import {
  NotAuthenticatedError,
  RemoteChangedError,
  type AccountInfo,
  type RemoteContent,
  type RemoteFile,
  type RemoteVersion,
  type StorageBackend
} from './backend';
import {
  forgetAccessToken,
  getAccessToken,
  hasAccessToken,
  revokeAccess
} from './google-auth';

/**
 * Google Drive `appDataFolder` backend.
 *
 * `appDataFolder` is a per-user, per-application space: the user cannot see it in their Drive,
 * other apps cannot read it, and the grant needed for it (`drive.appdata`) gives us no access
 * to anything else they own. Nothing here ever asks for a broader scope.
 *
 * The folder is flat. `days/2026-09.json` is a literal file *name* containing a slash, not a
 * subfolder — Drive names are arbitrary strings, and a real folder would cost an extra
 * round trip and an id to keep in step for no gain (STATE.md decision 91).
 */

const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const DRIVE_ABOUT = 'https://www.googleapis.com/drive/v3/about';

const VERSION_FIELDS = 'id,modifiedTime';

interface DriveFileResource {
  id?: string;
  name?: string;
  modifiedTime?: string;
}

/** Drive's own error envelope, used only to turn 401/403 into a readable message. */
interface DriveErrorBody {
  error?: { message?: string; errors?: { reason?: string }[] };
}

export interface DriveBackendOptions {
  /** Injected in tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injected in tests, so nothing has to stub Google Identity Services. */
  token?: (options: { interactive?: boolean }) => Promise<string>;
}

export function createDriveBackend(options: DriveBackendOptions = {}): StorageBackend {
  const doFetch = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const token = options.token ?? getAccessToken;

  /** Names are cached because the flat folder holds a handful of files and ids never change. */
  const fileIds = new Map<string, string>();

  async function request(url: string, init: RequestInit = {}): Promise<Response> {
    const accessToken = await token({ interactive: false });
    const response = await doFetch(url, {
      ...init,
      headers: { ...(init.headers ?? {}), Authorization: `Bearer ${accessToken}` }
    });

    if (response.status === 401 || response.status === 403) {
      const body = (await response.json().catch(() => ({}))) as DriveErrorBody;
      // 403 also covers quota; only an auth reason should drop the session.
      const reason = body.error?.errors?.[0]?.reason ?? '';
      if (response.status === 401 || reason === 'authError' || reason === 'insufficientPermissions') {
        forgetAccessToken();
        throw new NotAuthenticatedError(body.error?.message ?? 'Drive refused the request');
      }
      throw new Error(`Drive request failed (${response.status}): ${body.error?.message ?? ''}`);
    }

    return response;
  }

  async function requestJson<T>(url: string, init: RequestInit = {}): Promise<T> {
    const response = await request(url, init);
    if (!response.ok) {
      throw new Error(`Drive request failed (${response.status}) for ${url}`);
    }
    return (await response.json()) as T;
  }

  function query(params: Record<string, string>): string {
    return new URLSearchParams(params).toString();
  }

  async function findId(name: string): Promise<string | null> {
    const cached = fileIds.get(name);
    if (cached !== undefined) return cached;

    const escaped = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const result = await requestJson<{ files?: DriveFileResource[] }>(
      `${DRIVE_FILES}?${query({
        spaces: 'appDataFolder',
        q: `name = '${escaped}' and trashed = false`,
        fields: `files(${VERSION_FIELDS})`,
        pageSize: '1'
      })}`
    );

    const id = result.files?.[0]?.id;
    if (id === undefined) return null;
    fileIds.set(name, id);
    return id;
  }

  async function versionOf(id: string): Promise<RemoteVersion | null> {
    const response = await request(`${DRIVE_FILES}/${id}?${query({ fields: VERSION_FIELDS })}`);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Drive metadata read failed (${response.status})`);
    const file = (await response.json()) as DriveFileResource;
    if (file.id === undefined || file.modifiedTime === undefined) return null;
    return { fileId: file.id, modifiedTime: file.modifiedTime };
  }

  /**
   * The write guard PLAN.md asks for: re-read `modifiedTime` immediately before uploading and
   * refuse if it is not the one the merge was built on. It is a narrow window, not a lock —
   * but Drive offers no conditional write, and the alternative is a silent overwrite.
   */
  async function assertUnchanged(name: string, expected: RemoteVersion | null): Promise<string | null> {
    const id = expected?.fileId ?? (await findId(name));
    if (id === null) {
      if (expected !== null) throw new RemoteChangedError(name);
      return null;
    }

    const current = await versionOf(id);
    if (expected === null) {
      // We believed the file did not exist and it does: someone else created it.
      if (current !== null) throw new RemoteChangedError(name);
      return null;
    }
    if (current === null || current.modifiedTime !== expected.modifiedTime) {
      throw new RemoteChangedError(name);
    }
    return id;
  }

  function multipartBody(metadata: object, content: string, boundary: string): string {
    return [
      `--${boundary}`,
      'Content-Type: application/json; charset=UTF-8',
      '',
      JSON.stringify(metadata),
      `--${boundary}`,
      'Content-Type: application/json; charset=UTF-8',
      '',
      content,
      `--${boundary}--`,
      ''
    ].join('\r\n');
  }

  return {
    async authenticate(authOptions = {}): Promise<AccountInfo> {
      await token({ interactive: authOptions.interactive === true });

      // `about.get` is inside the appdata grant and is the only identity this scope exposes:
      // no ID token, no email unless Drive chooses to return one. See STATE.md decision 89.
      const about = await requestJson<{
        user?: { permissionId?: string; emailAddress?: string; displayName?: string };
      }>(`${DRIVE_ABOUT}?${query({ fields: 'user(permissionId,emailAddress,displayName)' })}`);

      const id = about.user?.permissionId;
      if (id === undefined) throw new NotAuthenticatedError('Drive did not identify the account');
      const label = about.user?.emailAddress ?? about.user?.displayName;
      return label === undefined ? { id } : { id, label };
    },

    isAuthenticated: hasAccessToken,

    signOut(): void {
      fileIds.clear();
      void revokeAccess();
    },

    async list(): Promise<RemoteFile[]> {
      const files: RemoteFile[] = [];
      let pageToken: string | undefined;

      do {
        const page = await requestJson<{ files?: DriveFileResource[]; nextPageToken?: string }>(
          `${DRIVE_FILES}?${query({
            spaces: 'appDataFolder',
            q: 'trashed = false',
            fields: `nextPageToken, files(${VERSION_FIELDS},name)`,
            pageSize: '1000',
            ...(pageToken === undefined ? {} : { pageToken })
          })}`
        );
        for (const file of page.files ?? []) {
          if (file.id === undefined || file.name === undefined || file.modifiedTime === undefined) continue;
          files.push({ fileId: file.id, name: file.name, modifiedTime: file.modifiedTime });
          fileIds.set(file.name, file.id);
        }
        pageToken = page.nextPageToken;
      } while (pageToken !== undefined);

      return files;
    },

    async getRemoteVersion(name: string): Promise<RemoteVersion | null> {
      const id = await findId(name);
      return id === null ? null : versionOf(id);
    },

    async read(name: string): Promise<RemoteContent | null> {
      const id = await findId(name);
      if (id === null) return null;

      const version = await versionOf(id);
      if (version === null) return null;

      const response = await request(`${DRIVE_FILES}/${id}?${query({ alt: 'media' })}`);
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`Drive download failed (${response.status}) for ${name}`);
      return { content: await response.text(), version };
    },

    async write(name: string, content: string, expected: RemoteVersion | null): Promise<RemoteVersion> {
      const id = await assertUnchanged(name, expected);

      const boundary = `emw-${crypto.randomUUID()}`;
      const url =
        id === null
          ? `${DRIVE_UPLOAD}?${query({ uploadType: 'multipart', fields: VERSION_FIELDS })}`
          : `${DRIVE_UPLOAD}/${id}?${query({ uploadType: 'multipart', fields: VERSION_FIELDS })}`;

      const metadata = id === null ? { name, parents: ['appDataFolder'] } : { name };
      const response = await request(url, {
        method: id === null ? 'POST' : 'PATCH',
        headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
        body: multipartBody(metadata, content, boundary)
      });

      if (!response.ok) throw new Error(`Drive upload failed (${response.status}) for ${name}`);
      const file = (await response.json()) as DriveFileResource;
      if (file.id === undefined || file.modifiedTime === undefined) {
        throw new Error(`Drive accepted ${name} but returned no version`);
      }
      fileIds.set(name, file.id);
      return { fileId: file.id, modifiedTime: file.modifiedTime };
    },

    async remove(name: string, expected: RemoteVersion): Promise<void> {
      const id = await assertUnchanged(name, expected);
      if (id === null) return;
      const response = await request(`${DRIVE_FILES}/${id}`, { method: 'DELETE' });
      if (!response.ok && response.status !== 404) {
        throw new Error(`Drive delete failed (${response.status}) for ${name}`);
      }
      fileIds.delete(name);
    }
  };
}
