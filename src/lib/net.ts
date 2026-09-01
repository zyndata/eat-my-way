/**
 * „Is there a network at all?"
 *
 * Two things in this app need one — Drive sync and Gemini — and everything else works without
 * it. When the browser already knows it is offline, saying so is worth more than a generic
 * failure: „sprawdź połączenie" reads like an accusation when the user is on a train and knows
 * perfectly well why it failed.
 *
 * `navigator.onLine` is only ever trusted in this direction. `false` means there is certainly
 * no connection; `true` means very little, so a request is attempted and its own error stands.
 */
export function isOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}
