import { describe, expect, it } from 'vitest';
import { at } from '../../test/fixtures';
import { GeminiError, extractJson, generateJson, generateText } from './client';

/** A `fetch` that records the one request it is given and answers with `body`. */
function recorder(body: unknown, status = 200) {
  const seen: { url: string; key: string | null; body: Record<string, unknown> }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    seen.push({
      url: String(input),
      key: headers.get('x-goog-api-key'),
      body: JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>
    });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { seen, fetchImpl };
}

const answer = (text: string): unknown => ({
  candidates: [{ content: { parts: [{ text }] } }]
});

describe('the Gemini client', () => {
  it('sends the key in a header and never in the URL', async () => {
    const { seen, fetchImpl } = recorder(answer('ok'));

    await generateText({ apiKey: 'AIza-secret', model: 'gemini-2.5-flash', prompt: 'hi', fetchImpl });

    expect(at(seen).key).toBe('AIza-secret');
    expect(at(seen).url).not.toContain('AIza-secret');
    expect(JSON.stringify(at(seen).body)).not.toContain('AIza-secret');
  });

  it('calls the model it was given, so settings decide it without a code change', async () => {
    const { seen, fetchImpl } = recorder(answer('ok'));

    await generateText({ apiKey: 'k', model: 'gemini-3.0-pro', prompt: 'hi', fetchImpl });

    expect(at(seen).url).toContain('/models/gemini-3.0-pro:generateContent');
  });

  it('percent-encodes the model name, which is user input from settings', async () => {
    const { seen, fetchImpl } = recorder(answer('ok'));

    await generateText({ apiKey: 'k', model: 'a/b?c', prompt: 'hi', fetchImpl });

    expect(at(seen).url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/a%2Fb%3Fc:generateContent'
    );
  });

  it('asks for greedy decoding on every call', async () => {
    const { seen, fetchImpl } = recorder(answer('ok'));

    await generateText({ apiKey: 'k', model: 'm', prompt: 'hi', fetchImpl });

    expect(at(seen).body.generationConfig).toMatchObject({ temperature: 0, topK: 1 });
  });

  it('adds the url_context tool only when asked to read a page', async () => {
    const plain = recorder(answer('ok'));
    await generateText({ apiKey: 'k', model: 'm', prompt: 'hi', fetchImpl: plain.fetchImpl });
    expect(at(plain.seen).body.tools).toBeUndefined();

    const reading = recorder(answer('ok'));
    await generateText({
      apiKey: 'k',
      model: 'm',
      prompt: 'hi',
      urlContext: true,
      fetchImpl: reading.fetchImpl
    });
    expect(at(reading.seen).body.tools).toEqual([{ url_context: {} }]);
  });

  it('sends a picture as inlineData, after the text', async () => {
    const { seen, fetchImpl } = recorder(answer('ok'));

    await generateText({
      apiKey: 'k',
      model: 'm',
      prompt: 'odczytaj',
      image: { mimeType: 'image/jpeg', data: 'AAEC' },
      fetchImpl
    });

    const contents = at(seen).body.contents as { parts: Record<string, unknown>[] }[];
    expect(contents[0]?.parts).toEqual([
      { text: 'odczytaj' },
      { inlineData: { mimeType: 'image/jpeg', data: 'AAEC' } }
    ]);
  });

  it('sends no image part when there is no picture', async () => {
    const { seen, fetchImpl } = recorder(answer('ok'));

    await generateText({ apiKey: 'k', model: 'm', prompt: 'hi', fetchImpl });

    const contents = at(seen).body.contents as { parts: Record<string, unknown>[] }[];
    expect(contents[0]?.parts).toEqual([{ text: 'hi' }]);
  });

  it('passes the media resolution when it is asked for', async () => {
    const { seen, fetchImpl } = recorder(answer('ok'));

    await generateText({
      apiKey: 'k',
      model: 'm',
      prompt: 'hi',
      mediaResolution: 'MEDIA_RESOLUTION_MEDIUM',
      fetchImpl
    });

    expect(at(seen).body.generationConfig).toMatchObject({
      mediaResolution: 'MEDIA_RESOLUTION_MEDIUM'
    });
  });

  it('sends none when it is not asked for, so the import keeps the model’s defaults', async () => {
    const { seen, fetchImpl } = recorder(answer('ok'));

    await generateText({ apiKey: 'k', model: 'm', prompt: 'hi', fetchImpl });

    const config = at(seen).body.generationConfig as Record<string, unknown>;
    expect(config.mediaResolution).toBeUndefined();
  });

  it('refuses to call out at all without a key', async () => {
    const failing = (() => {
      throw new Error('should not be called');
    }) as unknown as typeof fetch;

    await expect(
      generateText({ apiKey: '   ', model: 'm', prompt: 'hi', fetchImpl: failing })
    ).rejects.toMatchObject({ kind: 'no-key' });
  });

  it('turns each failure into a Polish sentence that never quotes the key', async () => {
    const cases: { status: number; kind: string }[] = [
      { status: 400, kind: 'rejected' },
      { status: 403, kind: 'rejected' },
      { status: 404, kind: 'rejected' },
      { status: 429, kind: 'quota' },
      { status: 503, kind: 'unavailable' },
      { status: 418, kind: 'unknown' }
    ];

    for (const { status, kind } of cases) {
      const { fetchImpl } = recorder({ error: { message: 'key AIza-secret is bad' } }, status);
      const failure = await generateText({
        apiKey: 'AIza-secret',
        model: 'm',
        prompt: 'hi',
        fetchImpl
      }).catch((error: unknown) => error as GeminiError);

      expect(failure).toBeInstanceOf(GeminiError);
      expect((failure as GeminiError).kind).toBe(kind);
      expect((failure as GeminiError).message).not.toContain('AIza-secret');
      expect((failure as GeminiError).message).toMatch(/[ąćęłńóśźż]|Gemini|Limit/);
    }
  });

  it('names the replacement model Google suggests when one is retired', async () => {
    // Verbatim shape of the 404 a key issued in September 2026 gets for gemini-2.5-flash.
    const { fetchImpl } = recorder(
      {
        error: {
          message:
            'This model models/gemini-2.5-flash is no longer available to new users. Please ' +
            'update your code to use models/gemini-3.6-flash for the latest features.'
        }
      },
      404
    );

    const failure = await generateText({
      apiKey: 'AIza-secret',
      model: 'gemini-2.5-flash',
      prompt: 'hi',
      fetchImpl
    }).catch((error: unknown) => error as GeminiError);

    expect((failure as GeminiError).kind).toBe('rejected');
    // The dead model is named as the problem and the live one as the fix — not the reverse.
    expect((failure as GeminiError).message).toContain('„gemini-2.5-flash”');
    expect((failure as GeminiError).message).toContain('„gemini-3.6-flash”');
    expect((failure as GeminiError).message).toContain('Ustawieniach');
  });

  it('still says something useful when the 404 suggests nothing', async () => {
    const { fetchImpl } = recorder({ error: { message: 'not found' } }, 404);

    const failure = await generateText({
      apiKey: 'k',
      model: 'gemini-nieistniejacy',
      prompt: 'hi',
      fetchImpl
    }).catch((error: unknown) => error as GeminiError);

    expect((failure as GeminiError).message).toContain('„gemini-nieistniejacy”');
    expect((failure as GeminiError).message).toContain('Ustawieniach');
  });

  it('reads nothing but a model name out of an error body', async () => {
    // A body that quotes the request. Only the `models/…` token may ever come through.
    const { fetchImpl } = recorder(
      {
        error: {
          message:
            'request to models/old failed with x-goog-api-key: AIza-secret; use models/new instead'
        }
      },
      404
    );

    const failure = await generateText({
      apiKey: 'AIza-secret',
      model: 'old',
      prompt: 'hi',
      fetchImpl
    }).catch((error: unknown) => error as GeminiError);

    expect((failure as GeminiError).message).toContain('„new”');
    expect((failure as GeminiError).message).not.toContain('AIza-secret');
    expect((failure as GeminiError).message).not.toContain('x-goog-api-key');
  });

  it('turns a daily quota 429 into "tomorrow", not "in a moment"', async () => {
    // The body Google actually returns on the free tier, trimmed to the parts that are read.
    const { fetchImpl } = recorder(
      {
        error: {
          message: 'You exceeded your current quota',
          details: [
            {
              '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
              violations: [
                {
                  quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests',
                  quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier',
                  quotaValue: '20'
                }
              ]
            },
            { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '0s' }
          ]
        }
      },
      429
    );

    const failure = await generateText({ apiKey: 'k', model: 'm', prompt: 'hi', fetchImpl }).catch(
      (error: unknown) => error as GeminiError
    );

    expect((failure as GeminiError).kind).toBe('quota');
    expect((failure as GeminiError).message).toContain('dzienny');
    expect((failure as GeminiError).message).toContain('20');
    expect((failure as GeminiError).message).toContain('jutro');
  });

  it('names the wait for a short-window 429', async () => {
    const { fetchImpl } = recorder(
      {
        error: {
          message: 'Please retry in 41.05s.',
          details: [
            {
              '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
              violations: [{ quotaId: 'GenerateRequestsPerMinutePerProject-FreeTier', quotaValue: '10' }]
            },
            { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '41.055669712s' }
          ]
        }
      },
      429
    );

    const failure = await generateText({ apiKey: 'k', model: 'm', prompt: 'hi', fetchImpl }).catch(
      (error: unknown) => error as GeminiError
    );

    expect((failure as GeminiError).message).toContain('42 s');
    expect((failure as GeminiError).message).not.toContain('jutro');
  });

  it('still says something when a 429 carries no details at all', async () => {
    const { fetchImpl } = recorder({ error: { message: 'slow down' } }, 429);

    const failure = await generateText({ apiKey: 'k', model: 'm', prompt: 'hi', fetchImpl }).catch(
      (error: unknown) => error as GeminiError
    );

    expect((failure as GeminiError).kind).toBe('quota');
    expect((failure as GeminiError).message).toContain('Za dużo zapytań');
  });

  it('marks an overloaded Gemini as worth retrying', async () => {
    const { fetchImpl } = recorder({ error: { message: 'high demand' } }, 503);

    const failure = await generateText({ apiKey: 'k', model: 'm', prompt: 'hi', fetchImpl }).catch(
      (error: unknown) => error as GeminiError
    );

    expect((failure as GeminiError).kind).toBe('unavailable');
    expect((failure as GeminiError).message).toContain('przeciążony');
  });

  it('reports a lost connection without quoting the request', async () => {
    const fetchImpl = (async () => {
      throw new Error('POST https://…?key=AIza-secret failed');
    }) as typeof fetch;

    const failure = await generateText({
      apiKey: 'AIza-secret',
      model: 'm',
      prompt: 'hi',
      fetchImpl
    }).catch((error: unknown) => error as GeminiError);

    expect((failure as GeminiError).kind).toBe('network');
    expect((failure as GeminiError).message).not.toContain('AIza-secret');
  });

  it('treats a blocked prompt and an empty answer as bad responses', async () => {
    const blocked = recorder({ promptFeedback: { blockReason: 'SAFETY' } });
    await expect(
      generateText({ apiKey: 'k', model: 'm', prompt: 'hi', fetchImpl: blocked.fetchImpl })
    ).rejects.toMatchObject({ kind: 'bad-response' });

    const empty = recorder(answer('   '));
    await expect(
      generateText({ apiKey: 'k', model: 'm', prompt: 'hi', fetchImpl: empty.fetchImpl })
    ).rejects.toMatchObject({ kind: 'bad-response' });
  });

  describe('a page the url_context tool could not open', () => {
    /** An answer whose retrieval metadata says what happened to each URL. */
    const retrieved = (...statuses: string[]): unknown => ({
      candidates: [
        {
          content: { parts: [{ text: 'BRAK_PRZEPISU' }] },
          urlContextMetadata: {
            urlMetadata: statuses.map((status) => ({
              retrievedUrl: 'https://example.com/przepis',
              urlRetrievalStatus: status
            }))
          }
        }
      ]
    });

    const read = (body: unknown): Promise<string> =>
      generateText({
        apiKey: 'k',
        model: 'm',
        prompt: 'hi',
        urlContext: true,
        fetchImpl: recorder(body).fetchImpl
      });

    it('says a login wall is a login wall, because pasting the text works around it', async () => {
      await expect(read(retrieved('URL_RETRIEVAL_STATUS_PAYWALL'))).rejects.toMatchObject({
        kind: 'bad-response',
        message: expect.stringContaining('za logowaniem')
      });
    });

    it('says when Google refused the page as unsafe', async () => {
      await expect(read(retrieved('URL_RETRIEVAL_STATUS_UNSAFE'))).rejects.toMatchObject({
        message: expect.stringContaining('niebezpieczną')
      });
    });

    it('falls back to the general sentence for an error, or a status it has never seen', async () => {
      await expect(read(retrieved('URL_RETRIEVAL_STATUS_ERROR'))).rejects.toMatchObject({
        message: expect.stringContaining('nie zdołał pobrać')
      });
      await expect(read(retrieved('SOMETHING_GOOGLE_ADDED_LATER'))).rejects.toMatchObject({
        message: expect.stringContaining('nie zdołał pobrać')
      });
    });

    it('stays quiet when one URL was read, whatever happened to the others', async () => {
      const body = {
        candidates: [
          {
            content: { parts: [{ text: 'przepis' }] },
            urlContextMetadata: {
              urlMetadata: [
                { urlRetrievalStatus: 'URL_RETRIEVAL_STATUS_ERROR' },
                { urlRetrievalStatus: 'URL_RETRIEVAL_STATUS_SUCCESS' }
              ]
            }
          }
        ]
      };
      await expect(read(body)).resolves.toBe('przepis');
    });

    it('stays quiet when the response carries no retrieval metadata at all', async () => {
      await expect(read(answer('przepis'))).resolves.toBe('przepis');
    });

    it('reports the tokens Google charged before refusing, because they were spent', async () => {
      const spent: number[] = [];
      const body = {
        ...(retrieved('URL_RETRIEVAL_STATUS_ERROR') as Record<string, unknown>),
        usageMetadata: { totalTokenCount: 812 }
      };
      await expect(
        generateText({
          apiKey: 'k',
          model: 'm',
          prompt: 'hi',
          urlContext: true,
          onusage: (tokens) => spent.push(tokens),
          fetchImpl: recorder(body).fetchImpl
        })
      ).rejects.toMatchObject({ kind: 'bad-response' });
      expect(spent).toEqual([812]);
    });
  });
});

describe('extractJson', () => {
  it('takes the object out of a fenced block', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('drops a sentence before and after the object', () => {
    expect(extractJson('Oto wynik: {"a":1} — gotowe.')).toBe('{"a":1}');
  });

  it('leaves clean JSON alone', () => {
    expect(extractJson('{"a":1}')).toBe('{"a":1}');
  });
});

describe('generateJson', () => {
  it('parses the answer', async () => {
    const { fetchImpl } = recorder(answer('{"a":1}'));
    await expect(
      generateJson<{ a: number }>({ apiKey: 'k', model: 'm', prompt: 'hi', fetchImpl })
    ).resolves.toEqual({ a: 1 });
  });

  it('reports unparseable JSON as a bad response', async () => {
    const { fetchImpl } = recorder(answer('nie wiem'));
    await expect(
      generateJson({ apiKey: 'k', model: 'm', prompt: 'hi', fetchImpl })
    ).rejects.toMatchObject({ kind: 'bad-response' });
  });
});
