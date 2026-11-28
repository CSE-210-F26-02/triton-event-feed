import { afterEach, describe, expect, it, vi } from "vitest";
import { randomId, runInBackground } from "../src/util.js";

const ID_ALPHABET = /^[a-z2-7]+$/;
const flush = () => new Promise((resolveFlush) => setTimeout(resolveFlush, 0));

describe("randomId", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns an id of the requested length from the base32 alphabet", () => {
    expect(randomId()).toHaveLength(16);
    const id = randomId(24);
    expect(id).toHaveLength(24);
    expect(id).toMatch(ID_ALPHABET);
  });

  it("draws its bytes from crypto.getRandomValues", () => {
    const getRandomValues = vi.fn((bytes) => bytes.fill(33));
    vi.stubGlobal("crypto", { getRandomValues });
    expect(randomId(4)).toBe("bbbb"); // 33 % 32 = 1 -> "b"
    expect(getRandomValues).toHaveBeenCalledTimes(1);
  });

  it("never falls back to Math.random when crypto is unavailable", () => {
    vi.stubGlobal("crypto", undefined);
    const mathRandom = vi.spyOn(Math, "random");
    expect(() => randomId(8)).toThrow(/crypto\.getRandomValues/);
    expect(mathRandom).not.toHaveBeenCalled();
    mathRandom.mockRestore();
  });

  it("rejects lengths that are not positive integers", () => {
    for (const badLength of [0, -1, 1.5, Number.NaN, "8", null])
      expect(() => randomId(badLength)).toThrow(RangeError);
  });
});

describe("runInBackground", () => {
  it("logs a rejected task with its description", async () => {
    const logError = vi.fn();
    const failure = new Error("offline");
    runInBackground(Promise.reject(failure), "Loading events", { logError });
    await flush();
    expect(logError).toHaveBeenCalledWith("Loading events failed:", failure);
  });

  it("logs nothing when the task succeeds", async () => {
    const logError = vi.fn();
    runInBackground(Promise.resolve("done"), "Loading events", { logError });
    await flush();
    expect(logError).not.toHaveBeenCalled();
  });

  it("accepts a plain (non-promise) value, e.g. from a synchronous function", async () => {
    const logError = vi.fn();
    expect(runInBackground(undefined, "Nothing", { logError })).toBeUndefined();
    await flush();
    expect(logError).not.toHaveBeenCalled();
  });

  it("logs to console.error by default", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    runInBackground(Promise.reject(new Error("x")), "Starting the app");
    await flush();
    expect(consoleError).toHaveBeenCalledWith(
      "Starting the app failed:",
      expect.any(Error),
    );
    consoleError.mockRestore();
  });
});
