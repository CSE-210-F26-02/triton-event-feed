/**
 * Small generic utilities.
 * @module util
 */

/**
 * Debounce a function.
 * @template {(...a: any[]) => void} F
 * @param {F} fn
 * @param {number} ms
 * @returns {F & {cancel: () => void}}
 */
export function debounce(fn, ms) {
  let t;
  const wrapped = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  wrapped.cancel = () => clearTimeout(t);
  return wrapped;
}

const RANDOM_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const DEFAULT_RANDOM_ID_LENGTH = 16;

/**
 * Random lowercase base32 id drawn from the Web Crypto CSPRNG.
 * There is deliberately no `Math.random` fallback: ids may identify subscribers,
 * so a predictable generator is unsafe. Web Crypto exists in every supported
 * browser and in Node 19+.
 * @param {number} [length=16] number of characters (a positive integer)
 * @param {{getRandomValues?: Function}|undefined} [cryptoImpl=globalThis.crypto]
 * @returns {string}
 * @throws {RangeError} when `length` is not a positive integer
 * @throws {Error} when no secure random number generator is available
 */
export function randomId(
  length = DEFAULT_RANDOM_ID_LENGTH,
  cryptoImpl = globalThis.crypto,
) {
  if (!Number.isInteger(length) || length <= 0)
    throw new RangeError(
      `randomId length must be a positive integer, got ${length}`,
    );
  if (typeof cryptoImpl?.getRandomValues !== "function")
    throw new Error("randomId requires crypto.getRandomValues (Web Crypto)");
  const bytes = cryptoImpl.getRandomValues(new Uint8Array(length));
  // 256 is a multiple of the 32-letter alphabet, so the modulo adds no bias.
  return Array.from(
    bytes,
    (byte) => RANDOM_ID_ALPHABET[byte % RANDOM_ID_ALPHABET.length],
  ).join("");
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
