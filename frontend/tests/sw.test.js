import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const SERVICE_WORKER_SOURCE = readFileSync(
  resolve(__dirname, "../sw.js"),
  "utf8",
);
const ORIGIN = "https://feed.example";
const flush = () => new Promise((r) => setTimeout(r, 0));

/**
 * Fake Cache whose `put` can be made to reject (e.g. storage quota exceeded).
 * @param {{putError?: Error}} [opts]
 * @returns {{put: import("vitest").Mock, match: import("vitest").Mock}}
 */
function fakeCache({ putError } = {}) {
  return {
    put: vi.fn(() => (putError ? Promise.reject(putError) : Promise.resolve())),
    match: vi.fn(async () => undefined),
  };
}

/**
 * Evaluate sw.js in an isolated context with fake worker globals.
 * Top-level function declarations become properties of the returned sandbox.
 * @param {{cache: object, fetchImpl: Function}} deps
 * @returns {{sandbox: object, listeners: Record<string, Function>, warn: import("vitest").Mock}}
 */
function loadServiceWorker({ cache, fetchImpl }) {
  const listeners = {};
  const warn = vi.fn();
  const sandbox = {
    self: {
      location: { origin: ORIGIN },
      addEventListener: (type, fn) => (listeners[type] = fn),
    },
    caches: {
      open: vi.fn(async () => cache),
      match: vi.fn(async () => undefined),
    },
    fetch: fetchImpl,
    console: { warn },
    URL,
    Headers,
    Response,
  };
  runInNewContext(SERVICE_WORKER_SOURCE, sandbox);
  return { sandbox, listeners, warn };
}

/**
 * Dispatch a fake fetch event and return the promise passed to respondWith.
 * @param {Function} fetchListener the worker's "fetch" listener
 * @param {string} path same-origin path to request
 * @returns {Promise<Response>}
 */
function dispatchFetch(fetchListener, path) {
  let responsePromise = null;
  fetchListener({
    request: new Request(`${ORIGIN}${path}`),
    respondWith: (promise) => (responsePromise = promise),
  });
  return responsePromise;
}

describe("service worker cache writes", () => {
  it("cacheResponseQuietly resolves and logs when cache.put rejects", async () => {
    const cache = fakeCache({ putError: new Error("QuotaExceededError") });
    const { sandbox, warn } = loadServiceWorker({ cache, fetchImpl: vi.fn() });
    const req = new Request(`${ORIGIN}/api/events`);
    await expect(
      sandbox.cacheResponseQuietly(cache, req, new Response("x")),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("could not cache"),
      req.url,
      expect.any(Error),
    );
  });

  it("cacheResponseQuietly stores the response when the cache is healthy", async () => {
    const cache = fakeCache();
    const { sandbox, warn } = loadServiceWorker({ cache, fetchImpl: vi.fn() });
    const req = new Request(`${ORIGIN}/index.html`);
    const res = new Response("ok");
    await sandbox.cacheResponseQuietly(cache, req, res);
    expect(cache.put).toHaveBeenCalledWith(req, res);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    ["network-first API", "/api/events"],
    ["cache-first shell", "/styles.css"],
  ])(
    "%s still returns the network response when caching fails",
    async (_label, path) => {
      const cache = fakeCache({ putError: new Error("quota") });
      const fetchImpl = vi.fn(async () => new Response("fresh"));
      const { listeners, warn } = loadServiceWorker({ cache, fetchImpl });
      const res = await dispatchFetch(listeners.fetch, path);
      expect(await res.text()).toBe("fresh");
      await flush();
      expect(cache.put).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledOnce();
    },
  );

  it("does not cache non-OK responses", async () => {
    const cache = fakeCache();
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 500 }));
    const { listeners } = loadServiceWorker({ cache, fetchImpl });
    const res = await dispatchFetch(listeners.fetch, "/api/events");
    expect(res.status).toBe(500);
    expect(cache.put).not.toHaveBeenCalled();
  });
});
