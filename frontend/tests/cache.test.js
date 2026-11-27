import { describe, expect, it } from "vitest";
import { createCache } from "../src/cache.js";
import { memoryStorage } from "./helpers.js";

describe("cache", () => {
  it("round-trips values with savedAt", () => {
    const cache = createCache({ storage: memoryStorage(), now: () => 42 });
    cache.set("a", { eventCount: 1 });
    expect(cache.get("a")).toEqual({ value: { eventCount: 1 }, savedAt: 42 });
    cache.remove("a");
    expect(cache.get("a")).toBeNull();
  });

  it("never throws when storage throws", () => {
    const failingStorage = {
      getItem() {
        throw new Error("denied");
      },
      setItem() {
        throw new Error("quota");
      },
      removeItem() {
        throw new Error("x");
      },
      get length() {
        throw new Error("x");
      },
    };
    const cache = createCache({ storage: failingStorage });
    expect(cache.set("a", 1)).toBe(false);
    expect(cache.get("a")).toBeNull();
    expect(() => cache.clear()).not.toThrow();
  });

  it("works with null storage and ignores corrupt entries", () => {
    expect(createCache({ storage: null }).get("a")).toBeNull();
    const storage = memoryStorage();
    storage.setItem("cm:cache:a", "{not json");
    expect(createCache({ storage: storage }).get("a")).toBeNull();
  });

  it("clears only its own prefix", () => {
    const storage = memoryStorage();
    storage.setItem("other", "1");
    const cache = createCache({ storage: storage });
    cache.set("a", 1);
    cache.clear();
    expect(storage.getItem("other")).toBe("1");
    expect(cache.get("a")).toBeNull();
  });
});
