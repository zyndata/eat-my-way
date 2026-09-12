/**
 * The first-run nutrition import holds the `ingredients` table for as long as it takes to
 * write 1 344 rows — about six seconds on Chromium and about twenty-four on WebKit (STATE.md
 * open question 31). On WebKit any other transaction that touches the table while that runs
 * never returns, which is how a Drive sync started inside that window stops for good at
 * „Odczyt i zapis plików na Dysku…".
 *
 * So the import raises a gate and every other writer waits at it. This is the „seal the
 * window" half of the phase 21 design call: it makes the first minute correct at whatever
 * speed the engine manages, where shortening the import only makes the window smaller.
 *
 * Deliberately dependency-free and framework-free — `repository.ts` sits below the UI and
 * must be able to reach it without importing a rune or the import itself (which would be a
 * cycle, since the import writes through the repository).
 */

/** Resolved while nothing is importing, so the common case costs one microtask. */
const OPEN: Promise<void> = Promise.resolve();

let gate: Promise<void> = OPEN;
let openGate: (() => void) | null = null;
/** Counted rather than a flag, so two overlapping holders cannot release each other's gate. */
let holders = 0;

/**
 * Close the gate for the duration of an import. Returns the release, which the caller must
 * run in a `finally`: a failed import that never reopened the gate would hang every later
 * write, which is worse than the defect this fixes. Releasing twice is a no-op.
 */
export function holdIngredients(): () => void {
  if (holders === 0) {
    gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
  }
  holders += 1;

  let released = false;
  return () => {
    if (released) return;
    released = true;
    holders -= 1;
    if (holders > 0) return;
    const resolve = openGate;
    gate = OPEN;
    openGate = null;
    resolve?.();
  };
}

/**
 * Settles when the `ingredients` table is free. Awaited by everything that opens a
 * transaction over it — never by the import itself, which would wait on its own gate.
 */
export function whenIngredientsWritable(): Promise<void> {
  return gate;
}

/** Whether a caller is about to wait, so the UI can say why in Polish before it does. */
export function ingredientsHeld(): boolean {
  return holders > 0;
}
