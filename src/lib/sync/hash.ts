/**
 * Content hashing for the three-way merge.
 *
 * Sync needs to answer "did *this side* change this entity since the last sync", which needs a
 * baseline. Keeping a full copy of the last-synced data would double the database; keeping one
 * short hash per entity answers the same question for a few dozen bytes.
 *
 * The hash is FNV-1a over a canonical JSON rendering, so it is deterministic across machines
 * and browsers, and synchronous — which keeps `merge.ts` pure and trivially testable. It is a
 * change detector, not a security primitive: nothing here defends against a crafted collision,
 * and nothing needs to, because both sides of a comparison are the user's own data.
 */

/**
 * JSON with object keys in a fixed order. Two structurally equal values always render to the
 * same string, whatever order their properties happen to have been built in.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    // `undefined` disappears in JSON, so it must not affect the rendering either.
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
}

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;

/** FNV-1a, 64 bit, over the UTF-8 bytes of `text`. Rendered as 16 hex digits. */
export function hashString(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let hash = FNV_OFFSET;
  for (const byte of bytes) {
    hash = ((hash ^ BigInt(byte)) * FNV_PRIME) & MASK_64;
  }
  return hash.toString(16).padStart(16, '0');
}

/** The hash of any JSON-shaped value. */
export function hashValue(value: unknown): string {
  return hashString(canonicalJson(value));
}
