import { describe, expect, it } from 'vitest';
import { holdIngredients, ingredientsHeld, whenIngredientsWritable } from './gate';

/** Resolve-or-not, without waiting on a timer: settled by the end of the microtask queue. */
async function settled(promise: Promise<void>): Promise<boolean> {
  let done = false;
  void promise.then(() => (done = true));
  await Promise.resolve();
  await Promise.resolve();
  return done;
}

describe('the ingredient gate', () => {
  it('is open, and costs nothing, while nothing is importing', async () => {
    expect(ingredientsHeld()).toBe(false);
    expect(await settled(whenIngredientsWritable())).toBe(true);
  });

  it('holds a waiter until the import lets go', async () => {
    const release = holdIngredients();
    expect(ingredientsHeld()).toBe(true);

    const waiting = whenIngredientsWritable();
    expect(await settled(waiting)).toBe(false);

    release();
    expect(ingredientsHeld()).toBe(false);
    await expect(waiting).resolves.toBeUndefined();
  });

  it('releases everyone who queued behind it', async () => {
    const release = holdIngredients();
    const waiters = [whenIngredientsWritable(), whenIngredientsWritable()];
    release();
    await expect(Promise.all(waiters)).resolves.toEqual([undefined, undefined]);
  });

  it('stays shut until the last holder releases', async () => {
    const first = holdIngredients();
    const second = holdIngredients();
    const waiting = whenIngredientsWritable();

    first();
    expect(ingredientsHeld()).toBe(true);
    expect(await settled(waiting)).toBe(false);

    second();
    expect(ingredientsHeld()).toBe(false);
    await expect(waiting).resolves.toBeUndefined();
  });

  it('ignores a release run twice, so a stray call cannot open someone else’s gate', async () => {
    const release = holdIngredients();
    release();
    release();

    const second = holdIngredients();
    expect(ingredientsHeld()).toBe(true);
    expect(await settled(whenIngredientsWritable())).toBe(false);
    second();
  });
});
