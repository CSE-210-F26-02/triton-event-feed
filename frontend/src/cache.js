/**
 * Small localStorage-backed response cache. Every storage access is guarded.
 * @module cache
 */
import { getStorage, storageGet, storageSet } from "./util.js";

/**
 * @typedef {{value: any, savedAt: number}} CacheEntry
 * @typedef {{get(key: string): CacheEntry|null, set(key: string, value: any): boolean,
 *            remove(key: string): void, clear(): void}} Cache
 */

/**
 * Create a cache.
 * @param {{storage?: Storage|null, prefix?: string, now?: () => number}} [options]
 * @returns {Cache}
 */
export function createCache({
  storage = getStorage("localStorage"),
  prefix = "cm:cache:",
  now = Date.now,
} = {}) {
  const keyOf = (key) => prefix + key;

  function get(key) {
    const storedJson = storageGet(storage, keyOf(key));
    if (!storedJson) return null;
    try {
      const entry = JSON.parse(storedJson);
      return entry && "value" in entry ? entry : null;
    } catch {
      return null;
    }
  }

  function set(key, value) {
    const serializedEntry = JSON.stringify({ value, savedAt: now() });
    if (storageSet(storage, keyOf(key), serializedEntry)) return true;
    clear(); // probably quota: drop our old entries and retry once
    return storageSet(storage, keyOf(key), serializedEntry);
  }

  function remove(key) {
    storageSet(storage, keyOf(key), null);
  }

  function clear() {
    try {
      for (let index = storage.length - 1; index >= 0; index--) {
        const storageKey = storage.key(index);
        if (storageKey && storageKey.startsWith(prefix))
          storage.removeItem(storageKey);
      }
    } catch {
      /* storage unavailable */
    }
  }

  return { get, set, remove, clear };
}
