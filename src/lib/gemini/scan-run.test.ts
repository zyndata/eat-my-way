import { describe, expect, it } from 'vitest';
import { at } from '../../test/fixtures';
import { GeminiError } from './client';
import { scanLabelImage } from './scan-run';

/**
 * The call itself: one request, the picture attached, and the counter told the truth even when
 * the answer turns out to be unreadable — the same rule the import follows (decision 127).
 * Everything above it (`scanPackage`) is vault, profile and camera and is driven end to end by
 * `e2e/scan.spec.ts` instead.
 */

function recorder(body: unknown, status = 200) {
  const seen: { body: Record<string, unknown> }[] = [];
  const fetchImpl = (async (_input: RequestInfo | URL, init: RequestInit = {}) => {
    seen.push({ body: JSON.parse(String(init.body ?? '{}')) as Record<string, unknown> });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { seen, fetchImpl };
}

/** A `fetch` that answers each call from `answers` in order. */
function sequence(answers: { body: unknown; status: number }[]) {
  const seen: { body: Record<string, unknown> }[] = [];
  const fetchImpl = (async (_input: RequestInfo | URL, init: RequestInit = {}) => {
    seen.push({ body: JSON.parse(String(init.body ?? '{}')) as Record<string, unknown> });
    const next = answers[seen.length - 1] ?? answers[answers.length - 1];
    return new Response(JSON.stringify(next?.body ?? {}), { status: next?.status ?? 200 });
  }) as typeof fetch;
  return { seen, fetchImpl };
}

const config = (call: { body: Record<string, unknown> }): Record<string, unknown> =>
  call.body.generationConfig as Record<string, unknown>;

const answer = (text: string): unknown => ({
  candidates: [{ content: { parts: [{ text }] } }],
  usageMetadata: { totalTokenCount: 512 }
});

const IMAGE = { mimeType: 'image/jpeg', data: 'AAEC' };

describe('scanLabelImage', () => {
  it('sends one request carrying the picture, and reads the answer', async () => {
    const { seen, fetchImpl } = recorder(
      answer(JSON.stringify({ name: 'Masło', kcal: 735, protein: 0.7, carbs: 0.8, fat: 82 }))
    );
    const spent: { requests: number; tokens: number }[] = [];

    const label = await scanLabelImage(IMAGE, {
      apiKey: 'k',
      model: 'm',
      fetchImpl,
      onusage: (one) => spent.push(one)
    });

    expect(label).toEqual({ name: 'Masło', kcal: 735, protein: 0.7, carbs: 0.8, fat: 82 });
    expect(seen).toHaveLength(1);
    const contents = at(seen).body.contents as { parts: Record<string, unknown>[] }[];
    expect(contents[0]?.parts?.[1]).toEqual({ inlineData: IMAGE });
    expect(spent).toEqual([{ requests: 1, tokens: 512 }]);
  });

  it('asks for minimal thinking and half-resolution media — the two things that make it fast', async () => {
    const { seen, fetchImpl } = recorder(answer(JSON.stringify({ kcal: 100 })));

    await scanLabelImage(IMAGE, { apiKey: 'k', model: 'm', fetchImpl });

    expect(config(at(seen))).toMatchObject({
      thinkingLevel: 'minimal',
      mediaResolution: 'MEDIA_RESOLUTION_MEDIUM'
    });
  });

  it('falls back to a plain call when a model refuses the tuning, rather than blaming the key', async () => {
    const { seen, fetchImpl } = sequence([
      { body: { error: { message: 'Unknown name "thinkingLevel"' } }, status: 400 },
      { body: answer(JSON.stringify({ name: 'Masło', kcal: 735 })), status: 200 }
    ]);

    const label = await scanLabelImage(IMAGE, { apiKey: 'k', model: 'gemini-1.0-antyk', fetchImpl });

    expect(label.kcal).toBe(735);
    expect(seen).toHaveLength(2);
    expect(config(seen[0]!)).toHaveProperty('thinkingLevel');
    // The second attempt drops both, and nothing else about the request changes.
    expect(config(seen[1]!)).not.toHaveProperty('thinkingLevel');
    expect(config(seen[1]!)).not.toHaveProperty('mediaResolution');
    expect(config(seen[1]!)).toMatchObject({ temperature: 0 });
  });

  it('retries exactly once, and only for a refusal', async () => {
    const refused = { body: { error: { message: 'nope' } }, status: 400 };
    const { seen, fetchImpl } = sequence([refused, refused]);

    await expect(
      scanLabelImage(IMAGE, { apiKey: 'k', model: 'm', fetchImpl })
    ).rejects.toBeInstanceOf(GeminiError);
    expect(seen).toHaveLength(2);

    // An overloaded Gemini is not a tuning problem, so it is not retried here.
    const overloaded = sequence([{ body: { error: { message: 'busy' } }, status: 503 }]);
    await expect(
      scanLabelImage(IMAGE, { apiKey: 'k', model: 'm', fetchImpl: overloaded.fetchImpl })
    ).rejects.toBeInstanceOf(GeminiError);
    expect(overloaded.seen).toHaveLength(1);
  });

  it('still counts the request when the answer cannot be parsed', async () => {
    const { fetchImpl } = recorder(answer('nie wiem, co to za zdjęcie'));
    const spent: { requests: number; tokens: number }[] = [];

    await expect(
      scanLabelImage(IMAGE, { apiKey: 'k', model: 'm', fetchImpl, onusage: (one) => spent.push(one) })
    ).rejects.toBeInstanceOf(GeminiError);

    // Google answered, so the quota was spent — whether or not the answer was usable.
    expect(spent).toEqual([{ requests: 1, tokens: 512 }]);
  });

  it('counts nothing when the request itself failed', async () => {
    const { fetchImpl } = recorder({ error: { message: 'nope' } }, 429);
    const spent: { requests: number; tokens: number }[] = [];

    await expect(
      scanLabelImage(IMAGE, { apiKey: 'k', model: 'm', fetchImpl, onusage: (one) => spent.push(one) })
    ).rejects.toBeInstanceOf(GeminiError);

    expect(spent).toEqual([]);
  });
});
