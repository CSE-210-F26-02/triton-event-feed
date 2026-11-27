/**
 * HTTP client for the Community Map AppView (docs/CONTRACTS.md).
 *
 * Every GET resolves to `{data, stale}`. On network failure, timeout or 5xx, a GET falls
 * back to the last cached response with `stale: true` (and `savedAt`). Writes never fall back.
 * @module api
 */
import { createCache } from "./cache.js";

/** Error for non-2xx responses (and offline with nothing cached). */
export class ApiError extends Error {
  /**
   * @param {string} message
   * @param {{status?: number, body?: any, offline?: boolean}} [info]
   */
  constructor(message, { status = 0, body = null, offline = false } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
    this.offline = offline;
  }
}

/**
 * Serialize params; arrays become repeated keys, empty values are dropped.
 * @param {Record<string, any>} [params]
 * @returns {string} query string including leading "?" (or "")
 */
export function toQueryString(params = {}) {
  const searchParams = new URLSearchParams();
  for (const [paramName, paramValue] of Object.entries(params)) {
    for (const singleValue of Array.isArray(paramValue)
      ? paramValue
      : [paramValue]) {
      if (singleValue != null && singleValue !== "")
        searchParams.append(paramName, String(singleValue));
    }
  }
  const queryString = searchParams.toString();
  return queryString ? `?${queryString}` : "";
}

/**
 * @typedef {{data: any, stale: boolean, savedAt?: number}} GetResult
 */

/**
 * Create the API client.
 * @param {{baseUrl?: string, fetchImpl?: typeof fetch, cache?: import('./cache.js').Cache,
 *          timeoutMs?: number}} [opts]
 */
export function createApi({
  baseUrl = "",
  fetchImpl = (...fetchArguments) => fetch(...fetchArguments),
  cache = createCache(),
  timeoutMs = 8000,
} = {}) {
  const root = baseUrl.replace(/\/$/, "");
  const url = (path, params) => `${root}${path}${toQueryString(params)}`;

  async function request(method, requestUrl, body) {
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), timeoutMs);
    try {
      const requestInit = {
        method,
        signal: abortController.signal,
        headers: { Accept: "application/json" },
      };
      if (body !== undefined) {
        requestInit.headers["Content-Type"] = "application/json";
        requestInit.body = JSON.stringify(body);
      }
      return await fetchImpl(requestUrl, requestInit);
    } finally {
      clearTimeout(timer);
    }
  }

  async function parse(response) {
    if (response.status === 204) return null;
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  async function errorFrom(response) {
    let body = null;
    try {
      body = await parse(response);
    } catch {
      /* non-JSON error body */
    }
    return new ApiError(`HTTP ${response.status}`, {
      status: response.status,
      body,
    });
  }

  /** GET with cache write-through and stale fallback. */
  async function get(path, params, { useCache = true } = {}) {
    const requestUrl = url(path, params);
    let response;
    try {
      response = await request("GET", requestUrl);
    } catch (error) {
      return fallback(requestUrl, useCache, error);
    }
    if (response.status >= 500)
      return fallback(requestUrl, useCache, await errorFrom(response));
    if (!response.ok) throw await errorFrom(response);
    const responseBody = await parse(response);
    // The service worker marks responses it served from its own cache.
    const swStale = response.headers?.get?.("x-cm-stale") === "1";
    if (useCache && !swStale) cache.set(requestUrl, responseBody);
    return swStale
      ? { data: responseBody, stale: true }
      : { data: responseBody, stale: false };
  }

  function fallback(requestUrl, useCache, error) {
    const cachedEntry = useCache ? cache.get(requestUrl) : null;
    if (cachedEntry)
      return {
        data: cachedEntry.value,
        stale: true,
        savedAt: cachedEntry.savedAt,
      };
    if (error instanceof ApiError) throw error;
    throw new ApiError("Network unavailable", { offline: true });
  }

  async function send(method, path, body) {
    let response;
    try {
      response = await request(method, url(path), body);
    } catch {
      throw new ApiError("Network unavailable", { offline: true });
    }
    if (!response.ok) throw await errorFrom(response);
    return parse(response);
  }

  return {
    /** @returns {Promise<GetResult>} `{ok:true}` */
    health: () => get("/api/health", undefined, { useCache: false }),
    /** @returns {Promise<GetResult>} `{devMode, jetstreamEnabled, eventNsid, listenerNsid}` */
    config: () => get("/api/config"),
    /**
     * @param {{tag?: string[], group?: string, q?: string, before?: string, after?: string,
     *          limit?: number, cursor?: string}} [params]
     * @returns {Promise<GetResult>} `{events, cursor}`
     */
    listEvents: (params) => get("/api/events", params),
    /** @param {string} uri @returns {Promise<GetResult>} EventView & {updates} */
    getEvent: (uri) => get("/api/event", { uri }),
    /** @returns {Promise<GetResult>} `[{value,count}]` */
    tags: () => get("/api/tags"),
    /** @returns {Promise<GetResult>} `[{value,count}]` */
    groups: () => get("/api/groups"),
    // Subscriptions (#19) are app.communitymap.subscription records on the user's PDS
    // (see atproto.js / subscriptions.js), so there are no subscription endpoints here.
    /**
     * STUB(#5): not served by the backend yet. `subscriberId` is the subscriber's DID.
     * @param {string} subscriberId @param {number|null} [since] notification id
     * @returns {Promise<GetResult>} `[Notification]` (never served from cache)
     */
    notifications: (subscriberId, since) =>
      get("/api/notifications", { subscriberId, since }, { useCache: false }),
    /** @param {string} subscriberId @returns {string} SSE URL for EventSource */
    notificationStreamUrl: (subscriberId) =>
      url("/api/notifications/stream", { subscriberId }),
    /** @param {string} icalUrl @returns {Promise<{imported:number}>} */
    importIcal: (icalUrl) => send("POST", "/api/import/ical", { url: icalUrl }),
    /** @param {object} commit Jetstream-shaped commit @returns {Promise<{ok:true}>} */
    postDevRecord: (commit) => send("POST", "/api/dev/records", commit),
  };
}
