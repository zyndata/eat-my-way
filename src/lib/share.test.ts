import { afterEach, describe, expect, it, vi } from 'vitest';
import { shareText } from './share';

/**
 * The one way text leaves this app (PLAN.md Phase 9 task 7, Phase 18 task C).
 *
 * Neither route is a network request, which is why the shopping list and the menu cost no CSP
 * change at all (STATE.md decisions 144 and 158). What matters here is the order: the system
 * share sheet where a browser has one, the clipboard where it does not, and a plain failure
 * the caller can answer by leaving the text on screen to be copied by hand.
 */

/** `navigator` with exactly the members the two routes need, and no more. */
function withNavigator(share: unknown, clipboard: unknown): void {
  vi.stubGlobal('navigator', {
    ...(share === undefined ? {} : { share }),
    ...(clipboard === undefined ? {} : { clipboard })
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('shareText', () => {
  it('hands the text to the system share sheet where there is one', async () => {
    const share = vi.fn(async () => undefined);
    withNavigator(share, { writeText: vi.fn(async () => undefined) });

    expect(await shareText('Jadłospis', 'poniedziałek')).toBe('shared');
    expect(share).toHaveBeenCalledWith({ title: 'Jadłospis', text: 'poniedziałek' });
  });

  it('reports a dismissed sheet as cancelled, not as a failure', async () => {
    const abort = new DOMException('cancelled', 'AbortError');
    const writeText = vi.fn(async () => undefined);
    withNavigator(
      vi.fn(async () => {
        throw abort;
      }),
      { writeText }
    );

    expect(await shareText('Jadłospis', 'poniedziałek')).toBe('cancelled');
    // Deliberately nothing on the clipboard: the user closed the sheet on purpose.
    expect(writeText).not.toHaveBeenCalled();
  });

  it('falls back to the clipboard where there is no share sheet', async () => {
    const writeText = vi.fn(async () => undefined);
    withNavigator(undefined, { writeText });

    expect(await shareText('Jadłospis', 'poniedziałek')).toBe('copied');
    expect(writeText).toHaveBeenCalledWith('poniedziałek');
  });

  it('falls back to the clipboard when the sheet fails for any other reason', async () => {
    const writeText = vi.fn(async () => undefined);
    withNavigator(
      vi.fn(async () => {
        throw new Error('no share target');
      }),
      { writeText }
    );

    expect(await shareText('Jadłospis', 'poniedziałek')).toBe('copied');
    expect(writeText).toHaveBeenCalledWith('poniedziałek');
  });

  it('fails plainly when neither works, so the caller can offer the text itself', async () => {
    withNavigator(undefined, {
      writeText: vi.fn(async () => {
        throw new Error('denied');
      })
    });

    expect(await shareText('Jadłospis', 'poniedziałek')).toBe('failed');
  });
});
