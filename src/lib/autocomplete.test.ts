import { describe, expect, it } from 'vitest';
import { clampActive, keyAction, moveActive } from './autocomplete';

describe('keyAction', () => {
  it('opens the list on an arrow key before stepping through it', () => {
    expect(keyAction('ArrowDown', false)).toBe('open');
    expect(keyAction('ArrowDown', true)).toBe('next');
    expect(keyAction('ArrowUp', false)).toBe('open');
    expect(keyAction('ArrowUp', true)).toBe('previous');
  });

  it('only acts on Enter, Home and End while the list is open', () => {
    expect(keyAction('Enter', true)).toBe('select');
    expect(keyAction('Enter', false)).toBe('none');
    expect(keyAction('Home', true)).toBe('first');
    expect(keyAction('End', false)).toBe('none');
  });

  it('closes on Escape whether or not the list is open', () => {
    expect(keyAction('Escape', true)).toBe('close');
    expect(keyAction('Escape', false)).toBe('close');
  });

  it('leaves ordinary typing alone', () => {
    expect(keyAction('a', true)).toBe('none');
    expect(keyAction('Backspace', true)).toBe('none');
  });
});

describe('moveActive', () => {
  it('starts at the first option and wraps at the end', () => {
    expect(moveActive(-1, 3, 'next')).toBe(0);
    expect(moveActive(2, 3, 'next')).toBe(0);
  });

  it('steps back off the first option to nothing active, then to the last', () => {
    expect(moveActive(0, 3, 'previous')).toBe(-1);
    expect(moveActive(-1, 3, 'previous')).toBe(2);
  });

  it('jumps to the ends', () => {
    expect(moveActive(1, 4, 'first')).toBe(0);
    expect(moveActive(1, 4, 'last')).toBe(3);
  });

  it('has nothing active when the list is empty', () => {
    expect(moveActive(0, 0, 'next')).toBe(-1);
    expect(moveActive(-1, 0, 'last')).toBe(-1);
  });
});

describe('clampActive', () => {
  it('keeps the index inside a list that shrank', () => {
    expect(clampActive(7, 3)).toBe(2);
    expect(clampActive(1, 3)).toBe(1);
  });

  it('leaves "nothing active" alone', () => {
    expect(clampActive(-1, 3)).toBe(-1);
    expect(clampActive(2, 0)).toBe(-1);
  });
});
