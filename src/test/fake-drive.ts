import {
  RemoteChangedError,
  type AccountInfo,
  type RemoteContent,
  type RemoteFile,
  type RemoteVersion,
  type StorageBackend
} from '../lib/sync/backend';

/**
 * An in-memory stand-in for the `appDataFolder`. Two backends pointing at the same store are
 * two browsers signed in to the same Google account — which is exactly the situation PLAN.md's
 * first acceptance criterion describes.
 *
 * It enforces the one rule the real Drive cannot: a write whose `expected` version is stale
 * raises `RemoteChangedError`, so the engine's re-merge path is genuinely exercised.
 */

interface StoredFile {
  content: string;
  version: number;
}

export class FakeDrive {
  readonly files = new Map<string, StoredFile>();
  /** Bumped on every write, so `modifiedTime` is unique and ordered. */
  private clock = 0;

  version(name: string): RemoteVersion | null {
    const file = this.files.get(name);
    return file === undefined ? null : { fileId: name, modifiedTime: `t${file.version}` };
  }

  put(name: string, content: string): void {
    this.clock += 1;
    this.files.set(name, { content, version: this.clock });
  }

  /** What a browser would see in the folder. */
  snapshot(): Record<string, unknown> {
    return Object.fromEntries(
      [...this.files].map(([name, file]) => [name, JSON.parse(file.content) as unknown])
    );
  }
}

export interface FakeBackendOptions {
  account?: AccountInfo;
  /** Counts requests, so a test can assert that an unmoved file is not downloaded. */
  reads?: string[];
}

export function fakeBackend(drive: FakeDrive, options: FakeBackendOptions = {}): StorageBackend {
  const account = options.account ?? { id: 'account-1', label: 'test@example.com' };

  return {
    async authenticate(): Promise<AccountInfo> {
      return account;
    },
    isAuthenticated: () => true,
    signOut: () => undefined,

    async list(): Promise<RemoteFile[]> {
      return [...drive.files.keys()].map((name) => {
        const version = drive.version(name);
        if (version === null) throw new Error('unreachable');
        return { name, ...version };
      });
    },

    async getRemoteVersion(name: string): Promise<RemoteVersion | null> {
      return drive.version(name);
    },

    async read(name: string): Promise<RemoteContent | null> {
      const file = drive.files.get(name);
      if (file === undefined) return null;
      options.reads?.push(name);
      const version = drive.version(name);
      if (version === null) return null;
      return { content: file.content, version };
    },

    async write(name: string, content: string, expected: RemoteVersion | null): Promise<RemoteVersion> {
      const current = drive.version(name);
      if (expected === null && current !== null) throw new RemoteChangedError(name);
      if (expected !== null && current?.modifiedTime !== expected.modifiedTime) {
        throw new RemoteChangedError(name);
      }
      drive.put(name, content);
      const written = drive.version(name);
      if (written === null) throw new Error('unreachable');
      return written;
    },

    async remove(name: string, expected: RemoteVersion): Promise<void> {
      const current = drive.version(name);
      if (current?.modifiedTime !== expected.modifiedTime) throw new RemoteChangedError(name);
      drive.files.delete(name);
    }
  };
}
