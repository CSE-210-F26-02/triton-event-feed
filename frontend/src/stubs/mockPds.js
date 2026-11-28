/**
 * STUB / DEV ONLY: an in-browser fake of a Bluesky account server, so login and
 * subscriptions (#19) can be previewed, and e2e-tested, without a real account. Enabled
 * only with `?mock` in the page URL, alongside stubs/mockApi.js.
 *
 * What it fakes (AT Protocol terms: docs/projects/triton-event-feed/AT_PROTOCOL_GLOSSARY.md):
 *   - a PDS (Personal Data Server): the server that stores a user's account ("repo")
 *     and its JSON records, such as their subscriptions;
 *   - handle and DID resolution: turning a username (handle, e.g. you.demo.test) into a
 *     permanent account id (DID) and finding which server stores that account.
 * It answers the same XRPC requests (HTTP calls to /xrpc/<method name>) a real one does,
 * so src/atproto.js runs unchanged against it.
 *
 * - Any handle logs in with any non-empty password ("app password").
 * - The fake tokens it issues come from frontend/.env (VITE_MOCK_PDS_*_TOKEN_PREFIX,
 *   read by loadMockConfig in src/config.js): each is the prefix + the user's DID.
 * - Records live in localStorage, so they survive reloads (e.g. "Subscribed ✓" stays).
 * - Only the XRPC calls the app makes are implemented.
 * @module stubs/mockPds
 */
import { generateTimestampRecordKey } from "../devWriter.js";
import { getStorage, storageGet, storageSet } from "../util.js";

/** Origin of the fake PDS (never contacted: every request is answered in-page). */
export const MOCK_PDS_ORIGIN = "https://pds.mock.test";
/** localStorage key holding every mock account's records (its "repo"). */
export const MOCK_PDS_STORAGE_KEY = "cm:mock-pds";
/**
 * A well-formed CID (version fingerprint of a record) returned for every mock record.
 * Real PDSes compute it from the record's content; the app never checks it.
 */
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
  const bearer = (requestInit) => {
    const header = requestInit?.headers?.Authorization;
    return typeof header === "string" && header.startsWith(BEARER_PREFIX)
      ? header.slice(BEARER_PREFIX.length)
      : null;
  };
  return {
    /** Tokens for a new or refreshed session. */
    sessionFor: (accountDid) => ({
      did: accountDid,
      accessJwt: `${accessTokenPrefix}${accountDid}`,
      refreshJwt: `${refreshTokenPrefix}${accountDid}`,
    }),
    /** True when the request carries the access token for `did`. */
    isAccessFor: (requestInit, repoDid) =>
      Boolean(repoDid) &&
      bearer(requestInit) === `${accessTokenPrefix}${repoDid}`,
    /** DID inside a refresh token, or null when it is not one of ours. */
    didFromRefresh(requestInit) {
      const token = bearer(requestInit);
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

/** Error Response shaped like a real PDS's: {error: name, message: explanation}. */
const xrpcError = (status, error, message) =>
  respond({ error, message }, status);

/**
 * Read / write every mock account's records, saved in localStorage as
 * {[account DID]: {[record type NSID]: {[record key]: {cid, value}}}}.
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
    collection(repoDid, collection) {
      return read()[repoDid]?.[collection] ?? {};
    },
    put(repoDid, collection, recordKey, entry) {
      const repos = read();
      repos[repoDid] ??= {};
      repos[repoDid][collection] ??= {};
      repos[repoDid][collection][recordKey] = entry;
      write(repos);
    },
    remove(repoDid, collection, recordKey) {
      const repos = read();
      delete repos[repoDid]?.[collection]?.[recordKey];
      write(repos);
    },
  };
}

/**
 * Parse a request body as JSON (empty object when absent or malformed).
 * @param {RequestInit} [requestInit]
 * @returns {object}
 */
function bodyOf(requestInit) {
  try {
    return JSON.parse(requestInit?.body || "{}");
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
    "com.atproto.server.createSession": (_url, requestInit) => {
      const { identifier, password } = bodyOf(requestInit);
      if (!identifier || !password)
        return xrpcError(401, "AuthenticationRequired", "Invalid password");
      const handle = String(identifier).replace(/^@/, "");
      return respond({
        ...tokens.sessionFor(mockDidForHandle(handle)),
        handle,
      });
    },
    "com.atproto.server.refreshSession": (_url, requestInit) => {
      const refreshedDid = tokens.didFromRefresh(requestInit);
      if (!refreshedDid)
        return xrpcError(401, "InvalidToken", "Bad refresh token");
      // No handle in the reply: the client keeps the one it has.
      return respond(tokens.sessionFor(refreshedDid));
    },
    "com.atproto.server.deleteSession": () => respond({}),
  };
}

/**
 * Record handlers (save new, replace, delete, list): createRecord / putRecord /
 * deleteRecord / listRecords.
 * @param {ReturnType<typeof createRepoStore>} store
 * @param {ReturnType<typeof createTokenIssuer>} tokens
 * @returns {Record<string, (url: URL, init?: RequestInit) => Response>}
 */
function repoHandlers(store, tokens) {
  const write = (requestInit, chooseRecordKey) => {
    const {
      repo,
      collection,
      record,
      rkey: requestedRecordKey,
    } = bodyOf(requestInit);
    if (!tokens.isAccessFor(requestInit, repo))
      return xrpcError(401, "AuthenticationRequired", "Bad token");
    const key = chooseRecordKey(requestedRecordKey);
    store.put(repo, collection, key, { cid: MOCK_RECORD_CID, value: record });
    return respond({
      uri: `at://${repo}/${collection}/${key}`,
      cid: MOCK_RECORD_CID,
    });
  };
  return {
    "com.atproto.repo.createRecord": (_url, requestInit) =>
      write(requestInit, () => generateTimestampRecordKey()),
    "com.atproto.repo.putRecord": (_url, requestInit) =>
      write(requestInit, (requestedRecordKey) => requestedRecordKey),
    "com.atproto.repo.deleteRecord": (_url, requestInit) => {
      const { repo, collection, rkey: recordKey } = bodyOf(requestInit);
      if (!tokens.isAccessFor(requestInit, repo))
        return xrpcError(401, "AuthenticationRequired", "Bad token");
      store.remove(repo, collection, recordKey);
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
  const allRecords = Object.entries(store.collection(repo, collection)).map(
    ([recordKey, entry]) => ({
      uri: `at://${repo}/${collection}/${recordKey}`,
      cid: entry.cid,
      value: entry.value,
    }),
  );
  const records = allRecords.slice(offset, offset + limit);
  const nextCursor =
    offset + limit < allRecords.length ? String(offset + limit) : undefined;
  return respond({ records, cursor: nextCursor });
}

/**
 * Answer the lookups made before login: username (handle) → account id (DID), and
 * DID → DID document (which names the account's PDS). Real ones are served by other
 * hosts than the PDS (a handle resolver and the PLC directory).
 * @param {URL} url
 * @returns {Response|null}
 */
function resolveIdentity(url) {
  if (url.pathname.endsWith("/com.atproto.identity.resolveHandle"))
    return respond({ did: mockDidForHandle(url.searchParams.get("handle")) });
  if (url.hostname === "plc.directory") {
    const requestedDid = decodeURIComponent(url.pathname.slice(1));
    return respond({
      id: requestedDid,
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
  return async (url, requestInit) => {
    const parsed = new URL(url);
    const identity = resolveIdentity(parsed);
    if (identity) return identity;
    const xrpcMethod = parsed.pathname.replace(/^\/xrpc\//, "");
    const handler =
      parsed.origin === MOCK_PDS_ORIGIN ? handlers[xrpcMethod] : null;
    return handler
      ? handler(parsed, requestInit)
      : xrpcError(404, "MethodNotImplemented", `Mock PDS: ${xrpcMethod}`);
  };
}
