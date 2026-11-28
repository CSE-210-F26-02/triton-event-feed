/* Community Map service worker (classic script).
 * - App shell: cache-first; local previews fetch current files with an offline fallback.
 * - GET /api/*: network-first, falling back to the cached copy (marked with x-cm-stale: 1).
 * - Never cached: non-GET requests and the SSE notification stream.
 */
const VERSION = "v15";
const SHELL_CACHE = `cm-shell-${VERSION}`;
const API_CACHE = `cm-api-${VERSION}`;
const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./manifest.webmanifest",
  "./icon.svg",
  "./assets/triton.jpg",
  "./assets/page-background.jpg",
  "./src/app.js",
  "./src/api.js",
  "./src/atproto.js",
  "./src/cache.js",
  "./src/devWriter.js",
  "./src/dom.js",
  "./src/filters.js",
  "./src/format.js",
  "./src/geo.js",
  "./src/records.js",
  "./src/router.js",
  "./src/store.js",
  "./src/subscriptions.js",
  "./src/toast.js",
  "./src/util.js",
  "./src/views/composeView.js",
  "./src/views/detailView.js",
  "./src/views/filterBar.js",
  "./src/views/listView.js",
  "./src/views/loginView.js",
  "./src/views/mapView.js",
  "./src/views/dateFilter.js",
  "./src/views/statusBadges.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  const currentCacheNames = new Set([SHELL_CACHE, API_CACHE]);
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter(
              (cacheName) =>
                cacheName.startsWith("cm-") &&
                !currentCacheNames.has(cacheName),
            )
            .map((cacheName) => caches.delete(cacheName)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // Leaflet/tiles: browser default
  const isApi = url.pathname.includes("/api/");
  if (
    isApi &&
    (url.pathname.endsWith("/api/notifications/stream") ||
      (request.headers.get("accept") || "").includes("text/event-stream"))
  )
    return;
  const isLocal = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  event.respondWith(
    isApi
      ? networkFirst(request)
      : isLocal
        ? fetch(request, { cache: "no-store" }).catch(() => cacheFirst(request))
        : cacheFirst(request),
  );
});

async function networkFirst(request) {
  const cache = await caches.open(API_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) putInCacheBestEffort(API_CACHE, request, response.clone());
    return response;
  } catch (error) {
    const cachedResponse = await cache.match(request);
    if (!cachedResponse) throw error; // let the page's own cache fallback handle it
    const headers = new Headers(cachedResponse.headers);
    headers.set("x-cm-stale", "1");
    return new Response(await cachedResponse.blob(), {
      status: cachedResponse.status,
      statusText: cachedResponse.statusText,
      headers,
    });
  }
}

async function cacheFirst(request) {
  const cachedResponse = await caches.match(request, { ignoreSearch: true });
  if (cachedResponse) return cachedResponse;
  const response = await fetch(request);
  if (response.ok) putInCacheBestEffort(SHELL_CACHE, request, response.clone());
  return response;
}

/**
 * Save a response copy without delaying the response itself. Caching is best-effort:
 * a failed write (e.g. storage quota exceeded) is logged and must never fail the fetch.
 * @param {string} cacheName e.g. API_CACHE or SHELL_CACHE
 * @param {Request} request
 * @param {Response} response a clone the cache may consume
 * @returns {void}
 */
function putInCacheBestEffort(cacheName, request, response) {
  caches
    .open(cacheName)
    .then((cache) => cache.put(request, response))
    .catch((error) => console.warn(`Could not cache ${request.url}:`, error));
}
