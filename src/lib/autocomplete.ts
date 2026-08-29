/**
 * Headless keyboard logic for the ingredient autocomplete. Pure and DOM-free, so the
 * behaviour is tested directly and the Svelte component only has to render.
 *
 * Follows the WAI-ARIA combobox pattern: the input keeps focus, the listbox is separate,
 * and the active option is pointed at by `aria-activedescendant` rather than being focused.
 */

/** What a key press means for the list. Anything else is left to the input itself. */
export type AutocompleteAction = 'next' | 'previous' | 'first' | 'last' | 'select' | 'close' | 'open' | 'none';

/**
 * Map a key to an action. `open` is separate from `next` because ArrowDown on a closed
 * list should reveal it without skipping the first option.
 */
export function keyAction(key: string, open: boolean): AutocompleteAction {
  switch (key) {
    case 'ArrowDown':
      return open ? 'next' : 'open';
    case 'ArrowUp':
      return open ? 'previous' : 'open';
    case 'Home':
      return open ? 'first' : 'none';
    case 'End':
      return open ? 'last' : 'none';
    case 'Enter':
      return open ? 'select' : 'none';
    case 'Tab':
      return open ? 'close' : 'none';
    case 'Escape':
      return 'close';
    default:
      return 'none';
  }
}

/**
 * Where the highlight lands. `-1` means "nothing active", which is the state a fresh query
 * starts in so that Enter never picks a suggestion the user has not looked at.
 *
 * Navigation wraps, and stepping back off the first option returns to "nothing active" —
 * the way a native datalist behaves, and the only way back to the raw typed text.
 */
export function moveActive(current: number, count: number, action: AutocompleteAction): number {
  if (count <= 0) return -1;

  switch (action) {
    case 'next':
      return current + 1 >= count ? 0 : current + 1;
    case 'previous':
      return current <= -1 ? count - 1 : current - 1;
    case 'first':
      return 0;
    case 'last':
      return count - 1;
    default:
      return clampActive(current, count);
  }
}

/** Keep an index valid after the result list changed under it. */
export function clampActive(current: number, count: number): number {
  if (count <= 0 || current < 0) return -1;
  return current >= count ? count - 1 : current;
}
