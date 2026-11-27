/**
 * Frontend configuration, read from Vite environment variables.
 *
 * Every deployment-specific value (API location, AT Protocol services, map tiles, the
 * default map view, ...) lives in frontend/.env, never in code. frontend/.env.example
 * lists every variable with a working value: copy it to frontend/.env and edit.
 *
 * IMPORTANT: Vite copies VITE_* variables into the JavaScript it serves, so anyone can
 * read them. This file is for configuration only. Never put secrets (API keys,
 * passwords, tokens) in frontend/.env; they belong on the backend.
 *
 * loadConfig() is pure: it takes the env object (import.meta.env in the app, a plain
 * object in tests), validates every variable, and reports all problems at once.
 * @module config
 */

/** Every variable the frontend reads, by config field. */
export const ENV_KEYS = Object.freeze({
  apiBaseUrl: "VITE_API_BASE_URL",
  plcDirectoryUrl: "VITE_ATPROTO_PLC_DIRECTORY_URL",
  handleResolverUrls: "VITE_ATPROTO_HANDLE_RESOLVER_URLS",
  leafletJsUrl: "VITE_LEAFLET_JS_URL",
  leafletCssUrl: "VITE_LEAFLET_CSS_URL",
  mapTileUrl: "VITE_MAP_TILE_URL",
  mapTileAttribution: "VITE_MAP_TILE_ATTRIBUTION",
  mapMaxZoom: "VITE_MAP_MAX_ZOOM",
  mapCenterLat: "VITE_MAP_CENTER_LAT",
  mapCenterLng: "VITE_MAP_CENTER_LNG",
  mapDefaultZoom: "VITE_MAP_DEFAULT_ZOOM",
});

/**
 * Variables used only in `?mock` demo mode (stubs/mockPds.js). Kept separate from
 * ENV_KEYS so production builds never need them; loadMockConfig() reads them.
 */
export const MOCK_ENV_KEYS = Object.freeze({
  accessTokenPrefix: "VITE_MOCK_PDS_ACCESS_TOKEN_PREFIX",
  refreshTokenPrefix: "VITE_MOCK_PDS_REFRESH_TOKEN_PREFIX",
});

/** Characters allowed in a mock token prefix (safe in an Authorization header). */
const TOKEN_PREFIX_PATTERN = /^[A-Za-z0-9._~-]+$/;

/** Placeholders a tile URL must contain (Leaflet fills them in per tile). */
const TILE_PLACEHOLDERS = Object.freeze(["{z}", "{x}", "{y}"]);
/** Leaflet zoom levels accepted for the zoom variables. */
const ZOOM_RANGE = Object.freeze({ min: 0, max: 22 });
const LATITUDE_RANGE = Object.freeze({ min: -90, max: 90 });
const LONGITUDE_RANGE = Object.freeze({ min: -180, max: 180 });

/** Raised when variables are missing or invalid; `problems` has one entry per variable. */
export class ConfigError extends Error {
  /** @param {string[]} problems */
  constructor(problems) {
    super(
      `Invalid frontend configuration (see frontend/.env.example):\n  - ${problems.join("\n  - ")}`,
    );
    this.name = "ConfigError";
    this.problems = problems;
  }
}

/**
 * @typedef {object} MapConfig
 * @property {string} leafletJs URL of leaflet.js
 * @property {string} leafletCss URL of leaflet.css
 * @property {string} tileUrl tile URL template with {z}/{x}/{y}
 * @property {string} attribution HTML credit required by the tile provider
 * @property {number} maxZoom
 * @property {[number, number]} center default [lat, lng]
 * @property {number} zoom default zoom
 */

/**
 * @typedef {object} AppConfig
 * @property {string} apiBaseUrl AppView origin/prefix; "" means same origin
 * @property {{plcBase: string, resolverBases: string[]}} atproto
 * @property {MapConfig} map
 */

/**
 * Collects problems while reading variables from one env object.
 * @param {Record<string, unknown>} env
 */
function createReader(env) {
  const problems = [];

  /** Trimmed string value, or null (recording "is required") when absent/blank. */
  function required(name) {
    const value = env?.[name];
    if (typeof value !== "string" || value.trim() === "") {
      problems.push(`${name} is required`);
      return null;
    }
    return value.trim();
  }

  /** Record a problem and return null. */
  function fail(name, message, value) {
    problems.push(`${name} ${message}, got ${JSON.stringify(value)}`);
    return null;
  }

  return { problems, required, fail };
}

/**
 * True for an absolute http(s) URL.
 * @param {string} value
 * @returns {boolean}
 */
function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** Absolute http(s) URL without a trailing slash. */
function readHttpUrl(reader, name) {
  const value = reader.required(name);
  if (value === null) return null;
  if (!isHttpUrl(value))
    return reader.fail(name, "must be an http(s) URL", value);
  return value.replace(/\/+$/, "");
}

/** Comma-separated list of http(s) URLs (at least one). */
function readHttpUrlList(reader, name) {
  const value = reader.required(name);
  if (value === null) return null;
  const urls = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (!urls.length || !urls.every(isHttpUrl))
    return reader.fail(name, "must be comma-separated http(s) URLs", value);
  return urls.map((url) => url.replace(/\/+$/, ""));
}

/**
 * The API base may be empty (same origin), a path ("/api-prefix") or an http(s) URL.
 * It is the one variable allowed to be blank, but it must still be defined.
 */
function readApiBase(reader, name, env) {
  const value = env?.[name];
  if (typeof value !== "string") return reader.fail(name, "must be set", value);
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.startsWith("/") || isHttpUrl(trimmed))
    return trimmed.replace(/\/+$/, "");
  return reader.fail(name, 'must be "", a path or an http(s) URL', value);
}

/** Number within [min, max]; `integer` additionally requires a whole number. */
function readNumber(reader, name, { min, max, integer = false }) {
  const value = reader.required(name);
  if (value === null) return null;
  const number = Number(value);
  const ok =
    Number.isFinite(number) &&
    number >= min &&
    number <= max &&
    (!integer || Number.isInteger(number));
  const kind = integer ? "a whole number" : "a number";
  return ok
    ? number
    : reader.fail(name, `must be ${kind} ${min}–${max}`, value);
}

/** Tile URL template: an http(s) URL containing {z}, {x} and {y}. */
function readTileUrl(reader, name) {
  const value = reader.required(name);
  if (value === null) return null;
  const hasPlaceholders = TILE_PLACEHOLDERS.every((p) => value.includes(p));
  const withoutPlaceholders = value.replace(/\{[a-z]\}/g, "0");
  if (!hasPlaceholders || !isHttpUrl(withoutPlaceholders))
    return reader.fail(
      name,
      "must be an http(s) URL with {z}, {x}, {y}",
      value,
    );
  return value;
}

/**
 * Read the map settings.
 * @param {ReturnType<typeof createReader>} reader
 * @returns {MapConfig}
 */
function readMapConfig(reader) {
  const zoom = { ...ZOOM_RANGE, integer: true };
  return {
    leafletJs: readHttpUrl(reader, ENV_KEYS.leafletJsUrl),
    leafletCss: readHttpUrl(reader, ENV_KEYS.leafletCssUrl),
    tileUrl: readTileUrl(reader, ENV_KEYS.mapTileUrl),
    attribution: reader.required(ENV_KEYS.mapTileAttribution),
    maxZoom: readNumber(reader, ENV_KEYS.mapMaxZoom, zoom),
    center: [
      readNumber(reader, ENV_KEYS.mapCenterLat, LATITUDE_RANGE),
      readNumber(reader, ENV_KEYS.mapCenterLng, LONGITUDE_RANGE),
    ],
    zoom: readNumber(reader, ENV_KEYS.mapDefaultZoom, zoom),
  };
}

/**
 * Read and validate the whole frontend configuration.
 * @param {Record<string, unknown>} env usually import.meta.env
 * @returns {AppConfig} frozen
 * @throws {ConfigError} listing every missing or invalid variable
 */
export function loadConfig(env) {
  const reader = createReader(env);
  const config = {
    apiBaseUrl: readApiBase(reader, ENV_KEYS.apiBaseUrl, env),
    atproto: {
      plcBase: readHttpUrl(reader, ENV_KEYS.plcDirectoryUrl),
      resolverBases: readHttpUrlList(reader, ENV_KEYS.handleResolverUrls),
    },
    map: readMapConfig(reader),
  };
  if (reader.problems.length) throw new ConfigError(reader.problems);
  return deepFreeze(config);
}

/**
 * @typedef {object} MockConfig
 * @property {{accessTokenPrefix: string, refreshTokenPrefix: string}} pds fake token
 *   prefixes for the mock PDS; each token is the prefix followed by the user's DID
 */

/** A token prefix: required, header-safe characters only. */
function readTokenPrefix(reader, name) {
  const value = reader.required(name);
  if (value === null) return null;
  if (!TOKEN_PREFIX_PATTERN.test(value))
    return reader.fail(
      name,
      "may only contain letters, digits and ._~-",
      value,
    );
  return value;
}

/**
 * Read and validate the `?mock` demo-mode configuration. Only called in mock mode.
 * @param {Record<string, unknown>} env usually import.meta.env
 * @returns {MockConfig} frozen
 * @throws {ConfigError} listing every missing or invalid variable
 */
export function loadMockConfig(env) {
  const reader = createReader(env);
  const pds = {
    accessTokenPrefix: readTokenPrefix(reader, MOCK_ENV_KEYS.accessTokenPrefix),
    refreshTokenPrefix: readTokenPrefix(
      reader,
      MOCK_ENV_KEYS.refreshTokenPrefix,
    ),
  };
  // Equal prefixes would let a refresh token pass as an access token.
  if (pds.accessTokenPrefix && pds.accessTokenPrefix === pds.refreshTokenPrefix)
    reader.problems.push(
      `${MOCK_ENV_KEYS.refreshTokenPrefix} must differ from ${MOCK_ENV_KEYS.accessTokenPrefix}`,
    );
  if (reader.problems.length) throw new ConfigError(reader.problems);
  return deepFreeze({ pds });
}

/**
 * Freeze an object and everything inside it.
 * @template T
 * @param {T} value
 * @returns {T}
 */
function deepFreeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}
