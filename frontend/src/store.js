/**
 * Tiny observable state store — the app's entire "framework".
 * @module store
 */

/**
 * @template T
 * @typedef {{get(): T, set(patch: Partial<T> | ((state: T) => Partial<T>)): void,
 *            subscribe(listener: (state: T, previousState: T) => void): () => void}} Store
 */

/**
 * Create a store holding a plain object. `set` shallow-merges and notifies subscribers.
 * @template {object} T
 * @param {T} initial
 * @returns {Store<T>}
 */
export function createStore(initial) {
  let state = { ...initial };
  const listeners = new Set();

  return {
    get: () => state,
    set(patch) {
      const previousState = state;
      const stateChanges =
        typeof patch === "function" ? patch(previousState) : patch;
      state = { ...previousState, ...stateChanges };
      for (const listener of [...listeners]) listener(state, previousState);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
