/* Community Map service worker (classic script).
 * - App shell: cache-first; local previews fetch current files with an offline fallback.
 * - GET /api/*: network-first, falling back to the cached copy (marked with x-cm-stale: 1).
 * - Never cached: non-GET requests and the SSE notification stream.
 */
const VERSION = "v12";
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
  const isLocal = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  event.respondWith(
    isApi
      ? networkFirst(req)
      : isLocal
        ? fetch(req, { cache: "no-store" }).catch(() => cacheFirst(req))
        : cacheFirst(req),
  );
});

/**
 * Store a response copy without letting a cache failure (e.g. quota exceeded)
 * break the response already being returned to the page.
 * @param {Cache} cache destination cache
 * @param {Request} req request key
 * @param {Response} res response copy to store (already cloned by the caller)
 * @returns {Promise<void>} always resolves
 */
function cacheResponseQuietly(cache, req, res) {
  return cache.put(req, res).catch((err) => {
    console.warn("Service worker could not cache", req.url, err);
  });
}

async function networkFirst(req) {
  const cache = await caches.open(API_CACHE);
  try {
    const res = await fetch(req);
    if (res.ok) void cacheResponseQuietly(cache, req, res.clone());
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
  if (res.ok)
    void cacheResponseQuietly(await caches.open(SHELL_CACHE), req, res.clone());
  return res;
}
