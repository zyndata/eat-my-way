/**
 * The storage abstraction from PLAN.md's architecture: `read`, `write`, `getRemoteVersion`
 * and `authenticate`. Google Drive is the first implementation; the sync engine knows only
 * this interface, so a second backend never touches the merge rules.
 */

/** What `files.get(fields=modifiedTime,id)` returns for one file. */
export interface RemoteVersion {
  fileId: string;
  /** RFC 3339, as Drive reports it. Compared for equality only, never parsed as a clock. */
  modifiedTime: string;
}

export interface RemoteFile extends RemoteVersion {
  name: string;
}

export interface RemoteContent {
  content: string;
  version: RemoteVersion;
}

/** The connected account, as far as an appDataFolder-only grant can see it. */
export interface AccountInfo {
  /** Stable per-account id. Stored in `Profile.googleSub` (STATE.md decision 89). */
  id: string;
  /** For display only; may be absent depending on what the grant exposes. */
  label?: string;
}

/** Raised when the grant is gone: the user revoked it, or the session expired. */
export class NotAuthenticatedError extends Error {
  constructor(message = 'The Drive connection needs to be renewed') {
    super(message);
    this.name = 'NotAuthenticatedError';
  }
}

/** Raised when a file moved between the version we merged against and the write. */
export class RemoteChangedError extends Error {
  /** The logical file name, e.g. `days/2026-09.json`. */
  readonly file: string;

  constructor(file: string) {
    super(`${file} changed on Drive while it was being merged`);
    this.name = 'RemoteChangedError';
    this.file = file;
  }
}

export interface StorageBackend {
  /**
   * Obtain a usable session. `interactive: false` must never open a window — it is the
   * silent renewal used on load, and it throws `NotAuthenticatedError` when consent is
   * genuinely needed.
   */
  authenticate(options?: { interactive?: boolean }): Promise<AccountInfo>;

  /** Whether a session is currently usable, without asking for one. */
  isAuthenticated(): boolean;

  /** Forget the session. Local data is never touched by this. */
  signOut(): void;

  /** Every file in the app's own storage area. The engine discovers `days/*.json` here. */
  list(): Promise<RemoteFile[]>;

  /** `files.get` with `fields=modifiedTime,id`. `null` when the file does not exist yet. */
  getRemoteVersion(name: string): Promise<RemoteVersion | null>;

  /** `null` when the file does not exist yet. */
  read(name: string): Promise<RemoteContent | null>;

  /**
   * Write `content`. `expected` is the version the content was merged against: `null` means
   * "this file must not exist yet". A mismatch raises `RemoteChangedError` rather than
   * overwriting — the engine re-merges instead.
   */
  write(name: string, content: string, expected: RemoteVersion | null): Promise<RemoteVersion>;

  /** Remove a file. Used when a month ends up with no planned days left. */
  remove(name: string, expected: RemoteVersion): Promise<void>;
}
