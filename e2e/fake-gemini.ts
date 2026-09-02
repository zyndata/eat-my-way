import type { BrowserContext, Route } from '@playwright/test';

/**
 * Gemini, answered at the network boundary — the same rule as `fake-google.ts` (STATE.md
 * decision 107): the app under test is the shipped app, running its real `client.ts`, its real
 * prompts and its real readers, with no test-only seam anywhere in `src/`.
 *
 * Serving the answers from Google's own host means the run happens under the production
 * `connect-src` when it is pointed at the Caddy container, which is what makes „a link import
 * needs no CSP change" something the suite checks rather than something the plan asserts.
 */

const GEMINI = 'https://generativelanguage.googleapis.com/**';

export interface GeminiScript {
  /** Answer to the retrieval call. `undefined` makes it report that it read nothing. */
  page?: string;
  /** Answer to the parse call, as the object the app should receive. */
  recipe?: unknown;
  /** Parsed names the model refuses to match, so the row lands in the editor empty. */
  refuse?: string[];
  /** HTTP status for every call. 200 unless a test is checking a failure. */
  status?: number;
}

export interface FakeGemini {
  /** Every request the app made, newest last. */
  calls: { system: string; prompt: string; key: string | null }[];
  script: GeminiScript;
}

/** The candidate id the model is offered first for each name — what a good answer looks like. */
function pickFirstCandidates(
  prompt: string,
  refuse: readonly string[]
): { name: string; id: string | null }[] {
  const blocks = prompt.split('Składnik z przepisu: ').slice(1);
  return blocks.map((block) => {
    const name = /^"([^"]*)"/.exec(block)?.[1] ?? '';
    if (refuse.includes(name)) return { name, id: null };
    const id = /id: (\S+) \|/.exec(block)?.[1] ?? null;
    return { name, id };
  });
}

function answer(text: string): string {
  // A real answer carries token counts; the usage counter in Settings is built on them.
  return JSON.stringify({
    candidates: [{ content: { parts: [{ text }] } }],
    usageMetadata: { totalTokenCount: 100 }
  });
}

export function createFakeGemini(script: GeminiScript = {}): FakeGemini {
  return { calls: [], script };
}

/** Route one browser context's Gemini traffic into `fake`. Several contexts may share one. */
export async function installFakeGemini(context: BrowserContext, fake: FakeGemini): Promise<void> {
  await context.route(GEMINI, async (route: Route) => {
    const request = route.request();
    const key = request.headers()['x-goog-api-key'] ?? null;

    // The key check in the wizard and in settings: a plain GET for the model list.
    if (request.method() === 'GET') {
      fake.calls.push({ system: 'models', prompt: '', key });
      return route.fulfill({
        status: fake.script.status ?? 200,
        contentType: 'application/json',
        // Shaped like the real listing: Settings builds its model dropdown from this.
        body: JSON.stringify({
          models: [
            {
              name: 'models/gemini-3.6-flash',
              displayName: 'Gemini 3.6 Flash',
              supportedGenerationMethods: ['generateContent', 'countTokens', 'createCachedContent']
            },
            {
              name: 'models/gemini-3.5-flash-lite',
              displayName: 'Gemini 3.5 Flash Lite',
              supportedGenerationMethods: ['generateContent', 'countTokens', 'createCachedContent']
            },
            // A picture model, shaped exactly as the real listing returns it: it speaks
            // `generateContent` and belongs nowhere near a recipe import (decision 167).
            {
              name: 'models/gemini-3.1-flash-image',
              displayName: 'Nano Banana 2',
              supportedGenerationMethods: ['generateContent', 'countTokens']
            }
          ]
        })
      });
    }

    const body = JSON.parse(request.postData() ?? '{}') as {
      systemInstruction?: { parts?: { text?: string }[] };
      contents?: { parts?: { text?: string }[] }[];
    };
    const system = body.systemInstruction?.parts?.[0]?.text ?? '';
    const prompt = body.contents?.[0]?.parts?.[0]?.text ?? '';
    fake.calls.push({ system, prompt, key });

    if (fake.script.status !== undefined && fake.script.status !== 200) {
      return route.fulfill({
        status: fake.script.status,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: 'nope' } })
      });
    }

    if (system.startsWith('Otwórz podany adres')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: answer(fake.script.page ?? 'BRAK_PRZEPISU')
      });
    }

    if (system.startsWith('Dopasowujesz')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: answer(
          JSON.stringify({ matches: pickFirstCandidates(prompt, fake.script.refuse ?? []) })
        )
      });
    }

    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: answer(JSON.stringify(fake.script.recipe ?? {}))
    });
  });
}

/** Requests the app made that were actual model calls, not the key check. */
export function modelCalls(fake: FakeGemini): FakeGemini['calls'] {
  return fake.calls.filter((call) => call.system !== 'models');
}
