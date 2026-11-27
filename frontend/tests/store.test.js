import { describe, expect, it, vi } from "vitest";
import { createStore } from "../src/store.js";

describe("store", () => {
  it("merges patches and notifies with prev state", () => {
    const store = createStore({ count: 1, label: 2 });
    const listener = vi.fn();
    store.subscribe(listener);
    store.set({ count: 3 });
    expect(store.get()).toEqual({ count: 3, label: 2 });
    expect(listener).toHaveBeenCalledWith(
      { count: 3, label: 2 },
      { count: 1, label: 2 },
    );
  });

  it("supports functional updates and unsubscribe", () => {
    const store = createStore({ counter: 1 });
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.set((state) => ({ counter: state.counter + 1 }));
    unsubscribe();
    store.set({ counter: 10 });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.get().counter).toBe(10);
  });

  it("does not mutate the initial object", () => {
    const initialState = { counter: 1 };
    createStore(initialState).set({ counter: 2 });
    expect(initialState.counter).toBe(1);
  });
});
