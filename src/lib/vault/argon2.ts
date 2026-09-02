import type { Argon2Kdf } from './crypto';
import type { Argon2Params } from './format';
import type { Argon2Request, Argon2Response } from './argon2.worker';

/**
 * The browser-side `Argon2Kdf`: one lazily created Web Worker, shared by every derivation.
 *
 * The worker is kept alive between calls because creating it costs a WebAssembly compile,
 * and unlocking, changing a password and enabling encryption all happen in quick succession.
 */

let worker: Worker | null = null;
let nextRequestId = 0;

function ensureWorker(): Worker {
  worker ??= new Worker(new URL('./argon2.worker.ts', import.meta.url), { type: 'module' });
  return worker;
}

/** Drops the worker, and with it the 64 MB it may still be holding. */
export function stopArgon2Worker(): void {
  worker?.terminate();
  worker = null;
}

export const argon2Kdf: Argon2Kdf = (password: string, salt: Uint8Array, params: Argon2Params) =>
  new Promise<Uint8Array>((resolve, reject) => {
    const active = ensureWorker();
    const id = (nextRequestId += 1);

    const onMessage = (event: MessageEvent<Argon2Response>) => {
      if (event.data.id !== id) return;
      active.removeEventListener('message', onMessage);
      active.removeEventListener('error', onError);
      if (event.data.ok) resolve(event.data.hash);
      else reject(new Error(event.data.message));
    };
    const onError = (event: ErrorEvent) => {
      active.removeEventListener('message', onMessage);
      active.removeEventListener('error', onError);
      reject(new Error(event.message || 'The Argon2 worker failed to start'));
    };

    active.addEventListener('message', onMessage);
    active.addEventListener('error', onError);

    // The salt is copied rather than transferred: the caller keeps using it to write the file.
    const request: Argon2Request = { id, password, salt, params };
    active.postMessage(request);
  });
