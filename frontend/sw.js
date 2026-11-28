/* Community Map service worker (classic script).
 * - App shell: cache-first.
 * - GET /api/*: network-first, falling back to the cached copy (marked with x-cm-stale: 1).
 * - Never cached: non-GET requests and the SSE notification stream.
 */
const VERSION = "v3";
const SHELL_CACHE = `cm-shell-${VERSION}`;
const API_CACHE = `cm-api-${VERSION}`;
const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./manifest.webmanifest",
  "./icon.svg",
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
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  const keep = new Set([SHELL_CACHE, API_CACHE]);
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith("cm-") && !keep.has(k))
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // Leaflet/tiles: browser default
  const isApi = url.pathname.includes("/api/");
  if (
    isApi &&
    (url.pathname.endsWith("/api/notifications/stream") ||
      (req.headers.get("accept") || "").includes("text/event-stream"))
  )
    return;
  event.respondWith(isApi ? networkFirst(req) : cacheFirst(req));
});

async function networkFirst(req) {
  const cache = await caches.open(API_CACHE);
  try {
    const res = await fetch(req);
    if (res.ok) putInCacheBestEffort(API_CACHE, req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req);
    if (!hit) throw err; // let the page's own cache fallback handle it
    const headers = new Headers(hit.headers);
    headers.set("x-cm-stale", "1");
    return new Response(await hit.blob(), {
      status: hit.status,
      statusText: hit.statusText,
      headers,
    });
  }
}

async function cacheFirst(req) {
  const hit = await caches.match(req, { ignoreSearch: true });
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) putInCacheBestEffort(SHELL_CACHE, req, res.clone());
  return res;
}

/**
 * Save a response copy without delaying the response itself. Caching is best-effort:
 * a failed write (e.g. storage quota exceeded) is logged and must never fail the fetch.
 * @param {string} cacheName e.g. API_CACHE or SHELL_CACHE
 * @param {Request} req
 * @param {Response} res a clone the cache may consume
 * @returns {void}
 */
function putInCacheBestEffort(cacheName, req, res) {
  caches
    .open(cacheName)
    .then((cache) => cache.put(req, res))
    .catch((error) => console.warn(`Could not cache ${req.url}:`, error));
}
