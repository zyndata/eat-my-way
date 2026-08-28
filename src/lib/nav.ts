/** Primary navigation. UI text is Polish; identifiers stay English. */
export type NavItem = {
  href: string;
  /** Route prefix that marks this item active. */
  match: string;
  label: string;
  /** SVG path data for the item's icon (24x24 viewBox). */
  icon: string;
};

export const navItems: NavItem[] = [
  {
    href: '#/',
    match: '/',
    label: 'Kalendarz',
    icon: 'M7 3v3M17 3v3M3.5 9.5h17M5 6h14a1.5 1.5 0 0 1 1.5 1.5v12A1.5 1.5 0 0 1 19 21H5a1.5 1.5 0 0 1-1.5-1.5v-12A1.5 1.5 0 0 1 5 6Z'
  },
  {
    href: '#/recipes',
    match: '/recipes',
    label: 'Przepisy',
    icon: 'M5 4.5A1.5 1.5 0 0 1 6.5 3H18a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H6.5A1.5 1.5 0 0 1 5 19.5v-15ZM5 17h14M9 7.5h6'
  },
  {
    href: '#/settings',
    match: '/settings',
    label: 'Ustawienia',
    icon: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1v.3a2 2 0 1 1-4 0V21a1.6 1.6 0 0 0-2.7-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 3.4 14H3a2 2 0 1 1 0-4h.2a1.6 1.6 0 0 0 1.1-2.7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 10 3.4V3a2 2 0 1 1 4 0v.2a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7h.4a2 2 0 1 1 0 4H21a1.6 1.6 0 0 0-1.5 1Z'
  }
];

/** True when `path` (a svelte-spa-router location) belongs to `item`. */
export function isActive(path: string, item: NavItem): boolean {
  if (item.match === '/') return path === '/' || path.startsWith('/day');
  return path === item.match || path.startsWith(item.match + '/');
}
