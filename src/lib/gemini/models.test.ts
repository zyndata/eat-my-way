import { describe, expect, it } from 'vitest';
import { listGeminiModels, withCurrentModel } from './models';

const respond = (body: unknown, status = 200): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;

const model = (
  name: string,
  displayName: string,
  methods = ['generateContent', 'countTokens', 'createCachedContent']
) => ({
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

  it('drops the products that speak generateContent but cannot import a recipe', async () => {
    // Every name here came back from a real personal key on 2026-09-02 (decision 157).
    const found = await listGeminiModels(
      'k',
      respond({
        models: [
          model('gemini-3.6-flash', 'Gemini 3.6 Flash'),
          // No context caching: pictures, speech, music, transcription, agents, Gemma.
          model('gemini-3.1-flash-image', 'Nano Banana 2', ['generateContent', 'countTokens']),
          model('nano-banana-pro-preview', 'Nano Banana Pro', ['generateContent', 'countTokens']),
          model('gemini-2.5-flash-preview-tts', 'TTS', ['countTokens', 'generateContent']),
          model('lyria-3-pro-preview', 'Lyria 3', ['generateContent', 'countTokens']),
          model('gemini-3.5-transcribe', 'Transcribe', ['generateContent', 'countTokens']),
          model('gemini-omni-flash-preview', 'Omni', ['generateContent', 'countTokens']),
          model('deep-research-preview-04-2026', 'Deep Research', ['generateContent']),
          model('antigravity-preview-05-2026', 'Antigravity', ['generateContent']),
          model('gemma-4-31b-it', 'Gemma 4', ['generateContent', 'countTokens']),
          // Caching, but a specialty the importer has no use for.
          model('gemini-robotics-er-2-preview', 'Robotics-ER 2'),
          model('gemini-2.5-computer-use-preview-10-2025', 'Computer Use')
        ]
      })
    );

    expect(found.map((row) => row.id)).toEqual(['gemini-3.6-flash']);
  });

  it('keeps the text models a person would actually pick between', async () => {
    const found = await listGeminiModels(
      'k',
      respond({
        models: [
          model('gemini-3.5-flash-lite', 'Gemini 3.5 Flash Lite'),
          model('gemini-flash-lite-latest', 'Gemini Flash-Lite Latest'),
          model('gemini-2.5-pro', 'Gemini 2.5 Pro'),
          model('gemini-3.1-pro-preview', 'Gemini 3.1 Pro Preview')
        ]
      })
    );

    expect(found.map((row) => row.id)).toHaveLength(4);
  });

  it('puts the newest model first', async () => {
    const found = await listGeminiModels(
      'k',
      respond({
        models: [
          model('gemini-2.5-flash', 'Gemini 2.5 Flash'),
          model('gemini-3.7-flash', 'Gemini 3.7 Flash'),
          model('gemini-3.6-flash', 'Gemini 3.6 Flash')
        ]
      })
    );

    expect(found.map((row) => row.id)).toEqual([
      'gemini-3.7-flash',
      'gemini-3.6-flash',
      'gemini-2.5-flash'
    ]);
  });

  it('carries Google’s own label, falling back to the id', async () => {
    const found = await listGeminiModels(
      'k',
      respond({
        models: [
          model('gemini-3.6-flash', 'Gemini 3.6 Flash'),
          {
            name: 'models/gemini-bare',
            supportedGenerationMethods: ['generateContent', 'createCachedContent']
          }
        ]
      })
    );

    expect(found).toContainEqual({ id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash' });
    expect(found).toContainEqual({ id: 'gemini-bare', label: 'gemini-bare' });
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
