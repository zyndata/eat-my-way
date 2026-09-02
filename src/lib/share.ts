/**
 * Getting text out of the app and into whatever the user actually uses.
 *
 * `navigator.share()` where the browser has it — on Android that is the system share sheet,
 * which reaches any app registered as a text share target, Listonic and the Home Assistant
 * companion included. Everywhere else (most desktop browsers) the text goes to the clipboard.
 *
 * Neither is a network request, so `connect-src` is untouched and nothing here may ever
 * widen it (STATE.md decision 144). Web Share additionally needs a secure context and a user
 * gesture; both hold — this is only ever called from a button.
 */

export type ShareOutcome =
  /** Handed to the system share sheet. */
  | 'shared'
  /** The share sheet was opened and dismissed without choosing anything. */
  | 'cancelled'
  /** No Web Share here, so the text went to the clipboard instead. */
  | 'copied'
  /** Neither route worked. The caller should show the text so it can be copied by hand. */
  | 'failed';

/** `AbortError` is the user closing the sheet — a normal outcome, not a failure. */
function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

export async function shareText(title: string, text: string): Promise<ShareOutcome> {
  if (typeof navigator.share === 'function') {
    try {
      await navigator.share({ title, text });
      return 'shared';
    } catch (error) {
      if (isAbort(error)) return 'cancelled';
      // Anything else — no share target, a permission refusal — falls through to the
      // clipboard rather than leaving the user with nothing.
    }
  }

  try {
    await navigator.clipboard.writeText(text);
    return 'copied';
  } catch {
    return 'failed';
  }
}
