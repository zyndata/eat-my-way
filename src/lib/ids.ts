/** Id generation. Injected as a factory wherever a pure function needs new ids. */

/** Produces a fresh unique id. Tests substitute a deterministic one. */
export type IdFactory = () => string;

/** `crypto.randomUUID` is available in every target browser and in Node >= 22. */
export const newId: IdFactory = () => crypto.randomUUID();

/** Namespaced id for an ingredient the user typed themselves. */
export function newCustomIngredientId(nextId: IdFactory = newId): string {
  return `custom:${nextId()}`;
}
