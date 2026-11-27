import { describe, expect, it, vi } from "vitest";
import { ApiError, createApi } from "../src/api.js";
import { createCache } from "../src/cache.js";
import { jsonResponse, memoryStorage } from "./helpers.js";

const makeApi = (fetchImpl, overrideResponse = {}) =>
  createApi({
    fetchImpl,
    cache: createCache({ storage: memoryStorage(), now: () => 1000 }),
    ...overrideResponse,
  });

describe("api", () => {
  it("builds GET URLs with baseUrl and repeated tags", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ events: [], cursor: null }),
    );
    const api = makeApi(fetchMock, { baseUrl: "https://x.test/" });
    const result = await api.listEvents({
      tag: ["a", "b"],
      q: "hi",
      limit: 10,
    });
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://x.test/api/events?tag=a&tag=b&q=hi&limit=10",
    );
    expect(fetchMock.mock.calls[0][1].method).toBe("GET");
    expect(result).toEqual({
      data: { events: [], cursor: null },
      stale: false,
    });
  });

  it("wraps every endpoint path from CONTRACTS.md", async () => {
    const fetchMock = vi.fn(async () => jsonResponse([]));
    const api = makeApi(fetchMock);
    await api.health();
    await api.config();
    await api.getEvent("at://x/y/z");
    await api.tags();
    await api.groups();
    await api.notifications("s1", 7);
    const urls = fetchMock.mock.calls.map((call) => call[0]);
    expect(urls).toEqual([
      "/api/health",
      "/api/config",
      "/api/event?uri=at%3A%2F%2Fx%2Fy%2Fz",
      "/api/tags",
      "/api/groups",
      "/api/notifications?subscriberId=s1&since=7",
    ]);
    expect(api.notificationStreamUrl("s 1")).toBe(
      "/api/notifications/stream?subscriberId=s+1",
    );
  });

  it("sends JSON bodies for writes and handles 204", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(undefined, 204));
    const api = makeApi(fetchMock);
    expect(await api.importIcal("https://cal.test/x.ics")).toBeNull();
    await api.postDevRecord({ did: "d" });
    const calls = fetchMock.mock.calls.map(([url, requestInit]) => [
      requestInit.method,
      url,
      JSON.parse(requestInit.body),
    ]);
    expect(calls).toEqual([
      ["POST", "/api/import/ical", { url: "https://cal.test/x.ics" }],
      ["POST", "/api/dev/records", { did: "d" }],
    ]);
    expect(fetchMock.mock.calls[0][1].headers["Content-Type"]).toBe(
      "application/json",
    );
  });

  it("falls back to the cached response on network failure, marked stale", async () => {
    let online = true;
    const fetchMock = vi.fn(async () => {
      if (!online) throw new TypeError("Failed to fetch");
      return jsonResponse([{ value: "food", count: 3 }]);
    });
    const api = makeApi(fetchMock);
    await api.tags();
    online = false;
    expect(await api.tags()).toEqual({
      data: [{ value: "food", count: 3 }],
      stale: true,
      savedAt: 1000,
    });
  });

  it("falls back on 5xx but throws on 4xx", async () => {
    const responses = [
      jsonResponse({ uri: "u" }),
      jsonResponse({ detail: "x" }, 503),
      jsonResponse({ detail: "nf" }, 404),
    ];
    const api = makeApi(vi.fn(async () => responses.shift()));
    await api.getEvent("u");
    expect((await api.getEvent("u")).stale).toBe(true);
    await expect(api.getEvent("u")).rejects.toMatchObject({
      status: 404,
      body: { detail: "nf" },
    });
  });

  it("throws an offline ApiError when nothing is cached", async () => {
    const api = makeApi(
      vi.fn(async () => {
        throw new TypeError("offline");
      }),
    );
    const error = await api.config().catch((error) => error);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.offline).toBe(true);
  });

  it("times out via AbortController and falls back", async () => {
    vi.useFakeTimers();
    const successfulFetch = vi.fn(async () => jsonResponse({ devMode: true }));
    const cache = createCache({ storage: memoryStorage() });
    await createApi({ fetchImpl: successfulFetch, cache }).config();
    const neverRespondingFetch = (url, requestInit) =>
      new Promise((_unusedResolve, reject) =>
        requestInit.signal.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        ),
      );
    const configRequest = createApi({
      fetchImpl: neverRespondingFetch,
      cache,
      timeoutMs: 50,
    }).config();
    await vi.advanceTimersByTimeAsync(60);
    expect(await configRequest).toMatchObject({
      data: { devMode: true },
      stale: true,
    });
    vi.useRealTimers();
  });

  it("marks service-worker cache hits stale and does not re-cache them", async () => {
    const api = makeApi(
      vi.fn(async () => jsonResponse({ ok: true }, 200, { "x-cm-stale": "1" })),
    );
    expect(await api.config()).toEqual({ data: { ok: true }, stale: true });
  });

  it("does not serve notifications from cache", async () => {
    let callCount = 0;
    const api = makeApi(
      vi.fn(async () => {
        if (callCount++) throw new TypeError("off");
        return jsonResponse([{ id: 1 }]);
      }),
    );
    await api.notifications("s", null);
    await expect(api.notifications("s", null)).rejects.toMatchObject({
      offline: true,
    });
  });

  it("writes do not fall back and report offline", async () => {
    const api = makeApi(
      vi.fn(async () => {
        throw new TypeError("off");
      }),
    );
    await expect(
      api.importIcal("https://cal.test/x.ics"),
    ).rejects.toMatchObject({
      offline: true,
    });
  });
});
