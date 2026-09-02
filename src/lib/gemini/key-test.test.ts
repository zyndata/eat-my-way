import { describe, expect, it } from 'vitest';
import { testGeminiKey } from './key-test';

const respond = (body: unknown, status = 200): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;

describe('the Gemini key check', () => {
  it('sends the key in a header, never in the URL', async () => {
    let seen: { url: string; key: string | null } | null = null;
    const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      seen = { url: String(input), key: headers.get('x-goog-api-key') };
      return new Response(JSON.stringify({ models: [{ name: 'models/gemini-2.5-flash' }] }));
    }) as typeof fetch;

    await testGeminiKey('AIza-secret', fetchImpl);

    expect(seen!.key).toBe('AIza-secret');
    expect(seen!.url).not.toContain('AIza-secret');
  });

  it('reports the models it can reach on success', async () => {
    const result = await testGeminiKey(
      'k',
      respond({ models: [{ name: 'models/gemini-2.5-flash' }, { name: 'models/gemini-2.5-pro' }] })
    );

    expect(result.status).toBe('ok');
    expect(result.models).toEqual(['gemini-2.5-flash', 'gemini-2.5-pro']);
  });

  it('names the retired "Standard" key when the API rejects one', async () => {
    const result = await testGeminiKey('k', respond({ error: { message: 'API key not valid' } }, 400));

    expect(result.status).toBe('legacy-key');
    expect(result.message).toContain('Standard');
  });

  it('never puts the key in the message it returns', async () => {
    for (const responder of [
      respond({ error: { message: 'API key not valid' } }, 400),
      respond({}, 403),
      respond({}, 500),
      (async () => {
        throw new Error('boom');
      }) as typeof fetch
    ]) {
      const result = await testGeminiKey('AIza-secret', responder);
      expect(result.message).not.toContain('AIza-secret');
    }
  });

  it('asks for a key rather than calling out when the field is empty', async () => {
    const result = await testGeminiKey('   ', () => {
      throw new Error('should not be called');
    });
    expect(result.status).toBe('rejected');
  });
});
