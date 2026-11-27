/**
 * STUB / DEV ONLY: an in-browser fake of a Bluesky PDS (plus handle and DID resolution),
 * so login and subscriptions (#19) can be previewed, and e2e-tested, without a real
 * account. Enabled only with `?mock` in the page URL, alongside stubs/mockApi.js.
 *
 * - Any handle logs in with any non-empty password ("app password").
 * - The fake tokens it issues come from frontend/.env (VITE_MOCK_PDS_*_TOKEN_PREFIX,
 *   read by loadMockConfig in src/config.js): each is the prefix + the user's DID.
 * - Records live in localStorage, so they survive reloads (e.g. "Subscribed ✓" stays).
 * - Only the XRPC calls the app makes are implemented.
 * @module stubs/mockPds
 */
import { generateTid } from "../devWriter.js";
import { getStorage, storageGet, storageSet } from "../util.js";

/** Origin of the fake PDS (never contacted: every request is answered in-page). */
export const MOCK_PDS_ORIGIN = "https://pds.mock.test";
/** localStorage key holding every mock repo. */
export const MOCK_PDS_STORAGE_KEY = "cm:mock-pds";
/** A well-formed CID returned for every mock record (never resolved). */
const MOCK_RECORD_CID =
  "bafyreihooyosut5ztb3xty23uwoyij5ovnqr5qldanntxmah33quatfwoy";
/** Page size when listRecords is called without `limit`. */
const DEFAULT_LIST_LIMIT = 50;

/**
 * Deterministic fake DID for a handle, e.g. "you.demo.test" → "did:plc:mock-you-demo-test".
 * @param {string} handle
 * @returns {string}
 */
export const mockDidForHandle = (handle) =>
  `did:plc:mock-${String(handle)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")}`;

/** HTTP Authorization scheme used by the atproto client. */
const BEARER_PREFIX = "Bearer ";

/**
 * Issues and checks the mock PDS's fake tokens (prefix + DID).
 * @param {{accessTokenPrefix: string, refreshTokenPrefix: string}} prefixes from .env
 * @throws {TypeError} when a prefix is missing
 */
export function createTokenIssuer(prefixes) {
  const { accessTokenPrefix, refreshTokenPrefix } = prefixes ?? {};
  if (!accessTokenPrefix || !refreshTokenPrefix)
    throw new TypeError(
      "Mock PDS needs accessTokenPrefix and refreshTokenPrefix (see loadMockConfig)",
    );
  const bearer = (init) => {
    const header = init?.headers?.Authorization;
    return typeof header === "string" && header.startsWith(BEARER_PREFIX)
      ? header.slice(BEARER_PREFIX.length)
      : null;
  };
  return {
    /** Tokens for a new or refreshed session. */
    sessionFor: (did) => ({
      did,
      accessJwt: `${accessTokenPrefix}${did}`,
      refreshJwt: `${refreshTokenPrefix}${did}`,
    }),
    /** True when the request carries the access token for `did`. */
    isAccessFor: (init, did) =>
      Boolean(did) && bearer(init) === `${accessTokenPrefix}${did}`,
    /** DID inside a refresh token, or null when it is not one of ours. */
    didFromRefresh(init) {
      const token = bearer(init);
      if (!token?.startsWith(refreshTokenPrefix)) return null;
      return token.slice(refreshTokenPrefix.length) || null;
    },
  };
}

/**
 * JSON Response understood by the atproto client.
 * @param {any} body @param {number} [status]
 * @returns {Response}
 */
const respond = (body, status = 200) =>
  new Response(JSON.stringify(body ?? {}), {
    status,
    headers: { "content-type": "application/json" },
  });

/** XRPC-style error Response. */
const xrpcError = (status, error, message) =>
  respond({ error, message }, status);

/**
 * Read / write the persisted repos: {[did]: {[collection]: {[rkey]: {cid, value}}}}.
 * @param {Storage|null} storage
 */
function createRepoStore(storage) {
  const read = () => {
    try {
      return JSON.parse(storageGet(storage, MOCK_PDS_STORAGE_KEY) || "{}");
    } catch {
      return {};
    }
  };
  const write = (repos) =>
    storageSet(storage, MOCK_PDS_STORAGE_KEY, JSON.stringify(repos));
  return {
    collection(did, collection) {
      return read()[did]?.[collection] ?? {};
    },
    put(did, collection, rkey, entry) {
      const repos = read();
      repos[did] ??= {};
      repos[did][collection] ??= {};
      repos[did][collection][rkey] = entry;
      write(repos);
    },
    remove(did, collection, rkey) {
      const repos = read();
      delete repos[did]?.[collection]?.[rkey];
      write(repos);
    },
  };
}

/**
 * Parse a request body as JSON (empty object when absent or malformed).
 * @param {RequestInit} [init]
 * @returns {object}
 */
function bodyOf(init) {
  try {
    return JSON.parse(init?.body || "{}");
  } catch {
    return {};
  }
}

/**
 * Session handlers: createSession / refreshSession / deleteSession.
 * @param {ReturnType<typeof createTokenIssuer>} tokens
 * @returns {Record<string, (url: URL, init?: RequestInit) => Response>}
 */
function sessionHandlers(tokens) {
  return {
    "com.atproto.server.createSession": (_url, init) => {
      const { identifier, password } = bodyOf(init);
      if (!identifier || !password)
        return xrpcError(401, "AuthenticationRequired", "Invalid password");
      const handle = String(identifier).replace(/^@/, "");
      return respond({
        ...tokens.sessionFor(mockDidForHandle(handle)),
        handle,
      });
    },
    "com.atproto.server.refreshSession": (_url, init) => {
      const did = tokens.didFromRefresh(init);
      if (!did) return xrpcError(401, "InvalidToken", "Bad refresh token");
      // No handle in the reply: the client keeps the one it has.
      return respond(tokens.sessionFor(did));
    },
    "com.atproto.server.deleteSession": () => respond({}),
  };
}

/**
 * Repo handlers: createRecord / putRecord / deleteRecord / listRecords.
 * @param {ReturnType<typeof createRepoStore>} store
 * @param {ReturnType<typeof createTokenIssuer>} tokens
 * @returns {Record<string, (url: URL, init?: RequestInit) => Response>}
 */
function repoHandlers(store, tokens) {
  const write = (init, rkeyOf) => {
    const { repo, collection, record, rkey } = bodyOf(init);
    if (!tokens.isAccessFor(init, repo))
      return xrpcError(401, "AuthenticationRequired", "Bad token");
    const key = rkeyOf(rkey);
    store.put(repo, collection, key, { cid: MOCK_RECORD_CID, value: record });
    return respond({
      uri: `at://${repo}/${collection}/${key}`,
      cid: MOCK_RECORD_CID,
    });
  };
  return {
    "com.atproto.repo.createRecord": (_url, init) =>
      write(init, () => generateTid()),
    "com.atproto.repo.putRecord": (_url, init) => write(init, (rkey) => rkey),
    "com.atproto.repo.deleteRecord": (_url, init) => {
      const { repo, collection, rkey } = bodyOf(init);
      if (!tokens.isAccessFor(init, repo))
        return xrpcError(401, "AuthenticationRequired", "Bad token");
      store.remove(repo, collection, rkey);
      return respond({});
    },
    "com.atproto.repo.listRecords": (url) => listRecords(store, url),
  };
}

/**
 * com.atproto.repo.listRecords with limit + cursor (the cursor is the next offset).
 * @param {ReturnType<typeof createRepoStore>} store
 * @param {URL} url
 * @returns {Response}
 */
function listRecords(store, url) {
  const repo = url.searchParams.get("repo");
  const collection = url.searchParams.get("collection");
  const limit = Number(url.searchParams.get("limit")) || DEFAULT_LIST_LIMIT;
  const offset = Number(url.searchParams.get("cursor")) || 0;
  const all = Object.entries(store.collection(repo, collection)).map(
    ([rkey, entry]) => ({
      uri: `at://${repo}/${collection}/${rkey}`,
      cid: entry.cid,
      value: entry.value,
    }),
  );
  const records = all.slice(offset, offset + limit);
  const next = offset + limit < all.length ? String(offset + limit) : undefined;
  return respond({ records, cursor: next });
}

/**
 * Answer handle / DID resolution, which happens on hosts other than the PDS.
 * @param {URL} url
 * @returns {Response|null}
 */
function resolveIdentity(url) {
  if (url.pathname.endsWith("/com.atproto.identity.resolveHandle"))
    return respond({ did: mockDidForHandle(url.searchParams.get("handle")) });
  if (url.hostname === "plc.directory") {
    const did = decodeURIComponent(url.pathname.slice(1));
    return respond({
      id: did,
      service: [
        {
          id: "#atproto_pds",
          type: "AtprotoPersonalDataServer",
          serviceEndpoint: MOCK_PDS_ORIGIN,
        },
      ],
    });
  }
  return null;
}

/**
 * Create a fetch replacement for createAtprotoWriter({fetchImpl}).
 * @param {{tokens: {accessTokenPrefix: string, refreshTokenPrefix: string},
 *   storage?: Storage|null}} opts `tokens` is loadMockConfig(env).pds
 * @returns {(url: string, init?: RequestInit) => Promise<Response>}
 * @throws {TypeError} when the token prefixes are missing
 */
export function createMockPdsFetch({
  tokens,
  storage = getStorage("localStorage"),
}) {
  const issuer = createTokenIssuer(tokens);
  const handlers = {
    ...sessionHandlers(issuer),
    ...repoHandlers(createRepoStore(storage), issuer),
  };
  return async (url, init) => {
    const parsed = new URL(url);
    const identity = resolveIdentity(parsed);
    if (identity) return identity;
    const nsid = parsed.pathname.replace(/^\/xrpc\//, "");
    const handler = parsed.origin === MOCK_PDS_ORIGIN ? handlers[nsid] : null;
    return handler
      ? handler(parsed, init)
      : xrpcError(404, "MethodNotImplemented", `Mock PDS: ${nsid}`);
  };
}
