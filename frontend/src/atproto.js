/**
 * Minimal AT Protocol client (no SDK): login via app password and write records to the
 * user's own PDS. Session lives in memory + sessionStorage (cleared when the tab closes).
 * @module atproto
 */
import { SUBSCRIPTION_NSID } from "./lexicon/validateSubscription.js";
import { EVENT_NSID, LISTENER_NSID, buildListenerRecord } from "./records.js";
import { getStorage, storageGet, storageSet } from "./util.js";

const SESSION_KEY = "cm:atproto-session";

/** Records requested per com.atproto.repo.listRecords page (the XRPC maximum). */
export const LIST_RECORDS_PAGE_LIMIT = 100;

/**
 * Safety cap on listRecords pages (100 × 50 = 5000 records), so a PDS that keeps
 * returning cursors cannot keep the client looping forever.
 */
export const LIST_RECORDS_MAX_PAGES = 50;

/**
 * @typedef {{uri: string, cid: string, value: object}} ListedRecord
 * One entry of com.atproto.repo.listRecords.
 */

/** Error from an XRPC call. */
export class XrpcError extends Error {
  /** @param {number} status @param {string} error @param {string} [message] */
  constructor(status, error, message) {
    super(message || error || `XRPC ${status}`);
    this.name = "XrpcError";
    this.status = status;
    this.error = error;
  }
}

/**
 * Resolve the PDS endpoint from a DID document.
 * @param {object} doc
 * @returns {string|null}
 */
export function pdsFromDidDoc(doc) {
  const svc = (doc?.service || []).find(
    (s) =>
      (s.id === "#atproto_pds" || s.id?.endsWith("#atproto_pds")) &&
      s.type === "AtprotoPersonalDataServer",
  );
  return svc?.serviceEndpoint
    ? String(svc.serviceEndpoint).replace(/\/$/, "")
    : null;
}

/**
 * URL of a DID document for did:plc / did:web.
 * @param {string} did
 * @param {string} plcBase PLC directory URL (VITE_ATPROTO_PLC_DIRECTORY_URL)
 * @returns {string}
 */
export function didDocUrl(did, plcBase) {
  if (did.startsWith("did:plc:")) {
    if (typeof plcBase !== "string" || !plcBase)
      throw new TypeError("didDocUrl needs the PLC directory URL");
    return `${plcBase}/${did}`;
  }
  if (did.startsWith("did:web:")) {
    const [host, ...path] = did.slice(8).split(":").map(decodeURIComponent);
    return path.length
      ? `https://${host}/${path.join("/")}/did.json`
      : `https://${host}/.well-known/did.json`;
  }
  throw new Error(`Unsupported DID method: ${did}`);
}

/**
 * Check the AT Protocol service URLs (from the app config) are present.
 * @param {unknown} resolverBases
 * @param {unknown} plcBase
 * @throws {TypeError}
 */
function assertServiceUrls(resolverBases, plcBase) {
  const hasResolvers =
    Array.isArray(resolverBases) &&
    resolverBases.length > 0 &&
    resolverBases.every((base) => typeof base === "string" && base);
  if (!hasResolvers || typeof plcBase !== "string" || !plcBase)
    throw new TypeError(
      "createAtprotoWriter needs resolverBases and plcBase (see src/config.js)",
    );
}

/**
 * Create the PDS writer. The service URLs come from the app config
 * (VITE_ATPROTO_HANDLE_RESOLVER_URLS / VITE_ATPROTO_PLC_DIRECTORY_URL).
 * @param {{resolverBases: string[], plcBase: string, fetchImpl?: typeof fetch,
 *   storage?: Storage|null}} opts
 * @throws {TypeError} when a service URL is missing
 */
export function createAtprotoWriter({
  resolverBases,
  plcBase,
  fetchImpl = (...a) => fetch(...a),
  storage = getStorage("sessionStorage"),
}) {
  assertServiceUrls(resolverBases, plcBase);
  /** @type {{did: string, handle: string, accessJwt: string, refreshJwt: string, pds: string}|null} */
  let session = null;
  try {
    session = JSON.parse(storageGet(storage, SESSION_KEY) || "null");
  } catch {
    session = null;
  }

  async function json(res) {
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  }

  async function call(url, { method = "GET", body, token } = {}) {
    const headers = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetchImpl(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await json(res).catch(() => ({}));
    if (!res.ok) throw new XrpcError(res.status, data.error, data.message);
    return data;
  }

  async function resolveHandle(handle) {
    let lastErr;
    for (const base of resolverBases) {
      try {
        const q = encodeURIComponent(handle);
        const { did } = await call(
          `${base}/xrpc/com.atproto.identity.resolveHandle?handle=${q}`,
        );
        if (did) return did;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error(`Could not resolve handle ${handle}`);
  }

  async function resolvePds(did) {
    const doc = await call(didDocUrl(did, plcBase));
    const pds = pdsFromDidDoc(doc);
    if (!pds) throw new Error("No PDS found in DID document");
    return pds;
  }

  function save(next) {
    session = next;
    storageSet(storage, SESSION_KEY, next ? JSON.stringify(next) : null);
  }

  async function refresh() {
    const data = await call(
      `${session.pds}/xrpc/com.atproto.server.refreshSession`,
      {
        method: "POST",
        token: session.refreshJwt,
      },
    );
    save({
      ...session,
      accessJwt: data.accessJwt,
      refreshJwt: data.refreshJwt,
      handle: data.handle || session.handle,
    });
  }

  const isExpired = (err) =>
    err instanceof XrpcError &&
    (err.status === 401 || err.status === 400) &&
    err.error === "ExpiredToken";

  async function xrpcPost(nsid, body) {
    if (!session) throw new Error("Not logged in");
    const go = () =>
      call(`${session.pds}/xrpc/${nsid}`, {
        method: "POST",
        body,
        token: session.accessJwt,
      });
    try {
      return await go();
    } catch (err) {
      if (!isExpired(err)) throw err;
      await refresh();
      return go();
    }
  }

  const uriOf = (collection, rkey) =>
    `at://${session.did}/${collection}/${rkey}`;

  /** URL of one com.atproto.repo.listRecords page for the logged-in repo. */
  function listRecordsUrl(collection, cursor) {
    const params = new URLSearchParams({
      repo: session.did,
      collection,
      limit: String(LIST_RECORDS_PAGE_LIMIT),
    });
    if (cursor) params.set("cursor", cursor);
    return `${session.pds}/xrpc/com.atproto.repo.listRecords?${params}`;
  }

  /**
   * Every record in one of the logged-in user's collections, following cursors.
   * listRecords is a public read, so no token is sent (and none can expire).
   * @param {string} collection NSID
   * @returns {Promise<ListedRecord[]>}
   */
  async function listAllRecords(collection) {
    if (!session) throw new Error("Not logged in");
    const records = [];
    const seenCursors = new Set();
    let cursor;
    for (let page = 0; page < LIST_RECORDS_MAX_PAGES; page++) {
      const data = await call(listRecordsUrl(collection, cursor));
      if (Array.isArray(data.records)) records.push(...data.records);
      cursor = typeof data.cursor === "string" ? data.cursor : undefined;
      if (!cursor || seenCursors.has(cursor)) break;
      seenCursors.add(cursor);
    }
    return records;
  }

  return {
    kind: "atproto",
    /** @returns {string|null} logged-in DID */
    get did() {
      return session?.did ?? null;
    },
    /** @returns {string|null} logged-in handle */
    get handle() {
      return session?.handle ?? null;
    },
    /** @returns {boolean} */
    get loggedIn() {
      return Boolean(session);
    },
    /**
     * Log in: handle → DID → DID doc → PDS → createSession.
     * @param {string} identifier handle (e.g. alice.bsky.social) or DID
     * @param {string} appPassword
     * @returns {Promise<{did: string, handle: string}>}
     */
    async login(identifier, appPassword) {
      const id = identifier.trim().replace(/^@/, "");
      const did = id.startsWith("did:") ? id : await resolveHandle(id);
      const pds = await resolvePds(did);
      const data = await call(`${pds}/xrpc/com.atproto.server.createSession`, {
        method: "POST",
        body: { identifier: id, password: appPassword },
      });
      save({
        did: data.did,
        handle: data.handle,
        accessJwt: data.accessJwt,
        refreshJwt: data.refreshJwt,
        pds,
      });
      return { did: data.did, handle: data.handle };
    },
    /** Log out (best-effort server-side deleteSession) and clear local session. */
    async logout() {
      const s = session;
      save(null);
      if (s) {
        await call(`${s.pds}/xrpc/com.atproto.server.deleteSession`, {
          method: "POST",
          token: s.refreshJwt,
        }).catch(() => {});
      }
    },
    /**
     * @param {object} record app.communitymap.event record
     * @returns {Promise<{uri: string, cid: string}>}
     */
    createEvent(record) {
      return xrpcPost("com.atproto.repo.createRecord", {
        repo: session?.did,
        collection: EVENT_NSID,
        record: { ...record, $type: EVENT_NSID },
      });
    },
    /**
     * @param {string} rkey @param {object} record
     * @returns {Promise<{uri: string, cid: string}>}
     */
    updateEvent(rkey, record) {
      return xrpcPost("com.atproto.repo.putRecord", {
        repo: session?.did,
        collection: EVENT_NSID,
        rkey,
        record: { ...record, $type: EVENT_NSID },
      });
    },
    /** @param {string} rkey @returns {Promise<{uri: string}>} */
    async deleteEvent(rkey) {
      await xrpcPost("com.atproto.repo.deleteRecord", {
        repo: session?.did,
        collection: EVENT_NSID,
        rkey,
      });
      return { uri: uriOf(EVENT_NSID, rkey) };
    },
    /**
     * @param {string} eventUri @param {string} hashtag
     * @returns {Promise<{uri: string, cid: string}>}
     */
    createListener(eventUri, hashtag) {
      return xrpcPost("com.atproto.repo.createRecord", {
        repo: session?.did,
        collection: LISTENER_NSID,
        record: buildListenerRecord(eventUri, hashtag),
      });
    },
    /**
     * Publish an app.communitymap.subscription record (#19). Validate it first with
     * validateSubscription; the PDS does not know our lexicon (see the Event Lexicon ADR).
     * @param {object} record app.communitymap.subscription record
     * @returns {Promise<{uri: string, cid: string}>}
     */
    createSubscription(record) {
      return xrpcPost("com.atproto.repo.createRecord", {
        repo: session?.did,
        collection: SUBSCRIPTION_NSID,
        record: { ...record, $type: SUBSCRIPTION_NSID },
      });
    },
    /** @param {string} rkey subscription record key @returns {Promise<{uri: string}>} */
    async deleteSubscription(rkey) {
      await xrpcPost("com.atproto.repo.deleteRecord", {
        repo: session?.did,
        collection: SUBSCRIPTION_NSID,
        rkey,
      });
      return { uri: uriOf(SUBSCRIPTION_NSID, rkey) };
    },
    /**
     * All of the logged-in user's subscription records, unvalidated.
     * @returns {Promise<ListedRecord[]>}
     */
    listSubscriptions() {
      return listAllRecords(SUBSCRIPTION_NSID);
    },
  };
}
