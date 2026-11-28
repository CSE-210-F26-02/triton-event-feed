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
 * Random lowercase base32 id from the Web Crypto CSPRNG (crypto.getRandomValues).
 * @param {number} [length=16] number of characters; a positive integer
 * @returns {string}
 * @throws {RangeError} when `length` is not a positive integer
 * @throws {Error} when crypto.getRandomValues is unavailable
 */
export function randomId(length = 16) {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  if (!Number.isInteger(length) || length < 1)
    throw new RangeError(
      `randomId length must be a positive integer, got ${length}`,
    );
  // Only the Web Crypto CSPRNG is used: Math.random() is predictable, and these ids
  // name records and subscribers. Every supported browser (and Node 19+) has it.
  if (typeof globalThis.crypto?.getRandomValues !== "function")
    throw new Error(
      "randomId needs crypto.getRandomValues, which is unavailable",
    );
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(length));
  // 256 is a multiple of 32, so `% 32` picks every character with equal probability.
  return Array.from(
    bytes,
    (randomByte) => alphabet[randomByte % alphabet.length],
  ).join("");
}

/**
 * Start an async task without waiting for it ("fire and forget"), and log it if it
 * fails, so a rejection is never silently dropped. Use for work whose result the
 * caller does not need, such as refreshing data in the background.
 * @param {Promise<unknown>|unknown} task the promise (or value) the task returned
 * @param {string} description what the task does, for the log, e.g. "Loading events"
 * @param {{logError?: (message: string, error: unknown) => void}} [options]
 *   logError defaults to console.error (tests pass a spy)
 * @returns {void}
 */
export function runInBackground(
  task,
  description,
  { logError = console.error } = {},
) {
  Promise.resolve(task).catch((error) =>
    logError(`${description} failed:`, error),
  );
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
