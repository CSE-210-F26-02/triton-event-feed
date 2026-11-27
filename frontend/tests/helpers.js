/** Test helpers. */

/** In-memory Storage implementation. */
export function memoryStorage() {
  const storedItems = new Map();
  return {
    get length() {
      return storedItems.size;
    },
    key: (index) => [...storedItems.keys()][index] ?? null,
    getItem: (key) => (storedItems.has(key) ? storedItems.get(key) : null),
    setItem: (key, value) => storedItems.set(key, String(value)),
    removeItem: (key) => storedItems.delete(key),
    clear: () => storedItems.clear(),
  };
}

/** Minimal fetch Response stand-in. */
export function jsonResponse(body, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (headerName) => headers[headerName.toLowerCase()] ?? null },
    text: async () => (body === undefined ? "" : JSON.stringify(body)),
  };
}

/** AppView metadata the backend adds around a lexicon record to form an EventView. */
const APPVIEW_METADATA = Object.freeze({
  uri: "at://did:plc:host/app.communitymap.event/3lexicon",
  // A well-formed CID: subscriptions copy it into their strongRef, which is validated.
  cid: "bafyreihooyosut5ztb3xty23uwoyij5ovnqr5qldanntxmah33quatfwoy",
  authorDid: "did:plc:host",
  authorHandle: "host.test",
  source: "atproto",
  indexedAt: "2026-11-25T12:00:00.000Z",
  updatedAt: "2026-11-25T12:00:00.000Z",
  status: "upcoming",
  updates: [],
});

/**
 * EventView built from a lexicon record (e.g. one of the shared fixtures in
 * fixtures/event/), the way the AppView flattens a record next to its metadata.
 * `$type` is dropped because the AppView does not send it.
 * @param {object} record app.communitymap.event record
 * @param {object} [over] field overrides
 * @returns {object}
 */
export function lexiconEventView(record, over = {}) {
  const { $type: _type, ...fields } = record;
  return { ...APPVIEW_METADATA, ...fields, ...over };
}

/** Sample EventView (prototype shape: plain-string group, no createdAt). */
export function sampleEvent(over = {}) {
  return {
    uri: "at://did:plc:abc/app.communitymap.event/3kabc",
    cid: "bafy1",
    authorDid: "did:plc:abc",
    authorHandle: "alice.test",
    source: "atproto",
    name: "Taco Tuesday",
    description: "Free tacos",
    startsAt: "2026-11-11T19:00:00Z",
    endsAt: "2026-11-11T21:00:00Z",
    location: {
      name: "Price Center",
      address: "9500 Gilman Dr",
      lat: "32.8797",
      lng: "-117.2362",
    },
    tags: ["food", "free"],
    group: "Triton Eats",
    sourceUrl: null,
    indexedAt: "2026-11-10T00:00:00Z",
    updatedAt: "2026-11-10T00:00:00Z",
    status: "upcoming",
    ...over,
  };
}

/**
 * Frontend env used by every test, so tests never depend on a developer's .env.
 * Same shape as frontend/.env.example; hosts are .test so nothing real is contacted.
 */
export const TEST_ENV = Object.freeze({
  VITE_API_BASE_URL: "",
  VITE_ATPROTO_PLC_DIRECTORY_URL: "https://plc.directory",
  VITE_ATPROTO_HANDLE_RESOLVER_URLS:
    "https://public.api.bsky.app,https://bsky.social",
  VITE_LEAFLET_JS_URL: "https://leaflet.test/leaflet.js",
  VITE_LEAFLET_CSS_URL: "https://leaflet.test/leaflet.css",
  VITE_MAP_TILE_URL: "https://tiles.test/{z}/{x}/{y}.png",
  VITE_MAP_TILE_ATTRIBUTION: "&copy; Test tiles",
  VITE_MAP_MAX_ZOOM: "19",
  VITE_MAP_CENTER_LAT: "32.8801",
  VITE_MAP_CENTER_LNG: "-117.234",
  VITE_MAP_DEFAULT_ZOOM: "15",
  // ?mock demo mode only (stubs/mockPds.js).
  VITE_MOCK_PDS_ACCESS_TOKEN_PREFIX: "test-access-",
  VITE_MOCK_PDS_REFRESH_TOKEN_PREFIX: "test-refresh-",
});

/**
 * The validated config for TEST_ENV (with optional env overrides).
 * @param {Record<string, string>} [overrides]
 * @returns {import('../src/config.js').AppConfig}
 */
export async function testConfig(overrides = {}) {
  const { loadConfig } = await import("../src/config.js");
  return loadConfig({ ...TEST_ENV, ...overrides });
}

/**
 * The validated ?mock config (fake token prefixes) for TEST_ENV.
 * @param {Record<string, string>} [overrides]
 * @returns {Promise<import('../src/config.js').MockConfig>}
 */
export async function testMockConfig(overrides = {}) {
  const { loadMockConfig } = await import("../src/config.js");
  return loadMockConfig({ ...TEST_ENV, ...overrides });
}
