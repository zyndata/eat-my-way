import { describe, expect, it } from 'vitest';
import { listGeminiModels, withCurrentModel } from './models';

const respond = (body: unknown, status = 200): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;

const model = (name: string, displayName: string, methods = ['generateContent']) => ({
  name: `models/${name}`,
  displayName,
  supportedGenerationMethods: methods
});

describe('listGeminiModels', () => {
  it('sends the key in a header, never in the URL', async () => {
    let seen: { url: string; key: string | null } | null = null;
    const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      seen = { url: String(input), key: new Headers(init.headers).get('x-goog-api-key') };
      return new Response(JSON.stringify({ models: [] }));
    }) as typeof fetch;

    await listGeminiModels('AQ-secret', fetchImpl);

    expect(seen!.key).toBe('AQ-secret');
    expect(seen!.url).not.toContain('AQ-secret');
  });

  it('keeps only models that can generate text', async () => {
    const found = await listGeminiModels(
      'k',
      respond({
        models: [
          model('gemini-3.6-flash', 'Gemini 3.6 Flash'),
          model('text-embedding-004', 'Embeddings', ['embedContent']),
          model('imagen-x', 'Imagen', ['predict'])
        ]
      })
    );

    expect(found.map((row) => row.id)).toEqual(['gemini-3.6-flash']);
  });

  it('puts the newest Gemini first and other products after', async () => {
    const found = await listGeminiModels(
      'k',
      respond({
        models: [
          model('lyria-3-pro-preview', 'Lyria 3'),
          model('gemini-2.5-flash', 'Gemini 2.5 Flash'),
          model('gemini-3.7-flash', 'Gemini 3.7 Flash'),
          model('gemini-3.6-flash', 'Gemini 3.6 Flash')
        ]
      })
    );

    expect(found.map((row) => row.id)).toEqual([
      'gemini-3.7-flash',
      'gemini-3.6-flash',
      'gemini-2.5-flash',
      'lyria-3-pro-preview'
    ]);
  });

  it('carries Google’s own label, falling back to the id', async () => {
    const found = await listGeminiModels(
      'k',
      respond({ models: [model('gemini-3.6-flash', 'Gemini 3.6 Flash'), { name: 'models/bare', supportedGenerationMethods: ['generateContent'] }] })
    );

    expect(found).toContainEqual({ id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash' });
    expect(found).toContainEqual({ id: 'bare', label: 'bare' });
  });

  it('degrades to an empty list rather than throwing', async () => {
    expect(await listGeminiModels('', respond({}))).toEqual([]);
    expect(await listGeminiModels('k', respond({}, 403))).toEqual([]);
    expect(
      await listGeminiModels('k', (async () => {
        throw new Error('offline');
      }) as typeof fetch)
    ).toEqual([]);
  });
});

describe('withCurrentModel', () => {
  const listed = [{ id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash' }];

  it('leaves a listed model where it is', () => {
    expect(withCurrentModel(listed, 'gemini-3.6-flash')).toEqual(listed);
  });

  it('keeps a hand-typed or retired name selectable', () => {
    // Otherwise opening Settings would silently switch the user to another model.
    expect(withCurrentModel(listed, 'gemini-2.5-flash')[0]).toEqual({
      id: 'gemini-2.5-flash',
      label: 'gemini-2.5-flash'
    });
  });

  it('adds nothing for an empty current model', () => {
    expect(withCurrentModel(listed, '  ')).toEqual(listed);
  });
});
