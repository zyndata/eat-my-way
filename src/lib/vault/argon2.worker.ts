/// <reference lib="webworker" />
import { argon2id } from 'hash-wasm';
import type { Argon2Params } from './format';

/**
 * Argon2id at PLAN.md's cost (64 MB, 3 iterations) takes roughly a second and allocates
 * 64 MB while it runs. On the UI thread that is a frozen app; here it is a worker that the
 * main thread awaits.
 *
 * hash-wasm carries its WebAssembly inline as base64 and instantiates it from bytes, so this
 * makes no network request — but compiling WebAssembly at all needs `'wasm-unsafe-eval'` in
 * the production `script-src` (STATE.md decision 87).
 */

export interface Argon2Request {
  id: number;
  password: string;
  salt: Uint8Array;
  params: Argon2Params;
}

export type Argon2Response =
  | { id: number; ok: true; hash: Uint8Array }
  | { id: number; ok: false; message: string };

self.onmessage = async (event: MessageEvent<Argon2Request>) => {
  const { id, password, salt, params } = event.data;
  try {
    const hash = await argon2id({
      password,
      salt,
      parallelism: params.parallelism,
      iterations: params.iterations,
      memorySize: params.memorySize,
      hashLength: params.hashLength,
      outputType: 'binary'
    });
    const response: Argon2Response = { id, ok: true, hash };
    (self as unknown as Worker).postMessage(response, [hash.buffer]);
  } catch (error) {
    // The password is in scope here; only the error text is ever sent back.
    const response: Argon2Response = {
      id,
      ok: false,
      message: error instanceof Error ? error.message : 'Argon2 failed'
    };
    (self as unknown as Worker).postMessage(response);
  }
};
