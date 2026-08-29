// Dexie needs a real IndexedDB. `fake-indexeddb/auto` installs an in-memory one on
// globalThis before any test module is imported, so `db.ts` can construct its Dexie
// instance at import time exactly as it does in the browser.
import 'fake-indexeddb/auto';
