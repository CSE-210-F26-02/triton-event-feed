/**
 * Small generic utilities.
 * @module util
 */

/**
 * Debounce a function.
 * @template {(...a: any[]) => void} F
 * @param {F} callback
 * @param {number} delayMs
 * @returns {F & {cancel: () => void}}
 */
export function debounce(callback, delayMs) {
  let timer;
  const debounced = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => callback(...args), delayMs);
  };
  debounced.cancel = () => clearTimeout(timer);
  return debounced;
}

/**
 * Random lowercase base32-ish id (uses crypto when available).
 * @param {number} [length=16]
 * @returns {string}
 */
export function randomId(length = 16) {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  const bytes = new Uint8Array(length);
  if (globalThis.crypto?.getRandomValues)
    globalThis.crypto.getRandomValues(bytes);
  else
    for (let index = 0; index < length; index++)
      bytes[index] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (randomByte) => alphabet[randomByte % 32]).join("");
}

/**
 * Safely obtain a Web Storage object (access itself can throw in private modes).
 * @param {'localStorage'|'sessionStorage'} name
 * @returns {Storage|null}
 */
export function getStorage(name) {
  try {
    return globalThis[name] ?? null;
  } catch {
    return null;
  }
}

/**
 * Storage read that never throws.
 * @param {Storage|null} storage
 * @param {string} key
 * @returns {string|null}
 */
export function storageGet(storage, key) {
  try {
    return storage ? storage.getItem(key) : null;
  } catch {
    return null;
  }
}

/**
 * Storage write that never throws. Returns false if it failed.
 * @param {Storage|null} storage
 * @param {string} key
 * @param {string|null} value null removes the key
 * @returns {boolean}
 */
export function storageSet(storage, key, value) {
  try {
    if (!storage) return false;
    if (value == null) storage.removeItem(key);
    else storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}
