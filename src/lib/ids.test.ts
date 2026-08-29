import { describe, expect, it } from 'vitest';
import { newCustomIngredientId, newId } from './ids';
import { seqIds } from '../test/fixtures';

describe('newId', () => {
  it('produces a fresh id every call', () => {
    expect(newId()).not.toBe(newId());
  });
});

describe('newCustomIngredientId', () => {
  it('namespaces the id so its source is readable from the id alone', () => {
    expect(newCustomIngredientId(seqIds('u'))).toBe('custom:u-1');
  });

  it('uses the real id factory by default', () => {
    expect(newCustomIngredientId()).toMatch(/^custom:[0-9a-f-]{36}$/);
  });
});
