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
 * @param {object} didDocument
 * @returns {string|null}
 */
export function pdsUrlFromDidDocument(didDocument) {
  const pdsService = (didDocument?.service || []).find(
    (service) =>
      (service.id === "#atproto_pds" || service.id?.endsWith("#atproto_pds")) &&
      service.type === "AtprotoPersonalDataServer",
  );
  return pdsService?.serviceEndpoint
    ? String(pdsService.serviceEndpoint).replace(/\/$/, "")
    : null;
}

/**
 * URL of a DID document for did:plc / did:web.
 * @param {string} accountDid
 * @param {string} plcBase PLC directory URL (VITE_ATPROTO_PLC_DIRECTORY_URL)
 * @returns {string}
 */
export function didDocumentUrl(accountDid, plcBase) {
  if (accountDid.startsWith("did:plc:")) {
    if (typeof plcBase !== "string" || !plcBase)
      throw new TypeError("didDocUrl needs the PLC directory URL");
    return `${plcBase}/${accountDid}`;
  }
  if (accountDid.startsWith("did:web:")) {
    const [host, ...path] = accountDid
      .slice(8)
      .split(":")
      .map(decodeURIComponent);
    return path.length
      ? `https://${host}/${path.join("/")}/did.json`
      : `https://${host}/.well-known/did.json`;
  }
  throw new Error(`Unsupported DID method: ${accountDid}`);
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
  fetchImpl = (...fetchArguments) => fetch(...fetchArguments),
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

  async function parseJsonBody(response) {
    const text = await response.text();
    return text ? JSON.parse(text) : {};
  }

  async function call(url, { method = "GET", body, token } = {}) {
    const headers = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetchImpl(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const responseBody = await parseJsonBody(response).catch(() => ({}));
    if (!response.ok)
      throw new XrpcError(
        response.status,
        responseBody.error,
        responseBody.message,
      );
    return responseBody;
  }

  async function resolveHandle(handle) {
    let lastError;
    for (const base of resolverBases) {
      try {
        const encodedHandle = encodeURIComponent(handle);
        const { did: resolvedDid } = await call(
          `${base}/xrpc/com.atproto.identity.resolveHandle?handle=${encodedHandle}`,
        );
        if (resolvedDid) return resolvedDid;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error(`Could not resolve handle ${handle}`);
  }

  async function resolvePdsUrl(accountDid) {
    const didDocument = await call(didDocumentUrl(accountDid, plcBase));
    const pdsUrl = pdsUrlFromDidDocument(didDocument);
    if (!pdsUrl) throw new Error("No PDS found in DID document");
    return pdsUrl;
  }

  function save(nextSession) {
    session = nextSession;
    storageSet(
      storage,
      SESSION_KEY,
      nextSession ? JSON.stringify(nextSession) : null,
    );
  }

  async function refresh() {
    const refreshed = await call(
      `${session.pds}/xrpc/com.atproto.server.refreshSession`,
      {
        method: "POST",
        token: session.refreshJwt,
      },
    );
    save({
      ...session,
      accessJwt: refreshed.accessJwt,
      refreshJwt: refreshed.refreshJwt,
      handle: refreshed.handle || session.handle,
    });
  }

  const isExpired = (error) =>
    error instanceof XrpcError &&
    (error.status === 401 || error.status === 400) &&
    error.error === "ExpiredToken";

  async function xrpcPost(xrpcMethod, body) {
    if (!session) throw new Error("Not logged in");
    const sendRequest = () =>
      call(`${session.pds}/xrpc/${xrpcMethod}`, {
        method: "POST",
        body,
        token: session.accessJwt,
      });
    try {
      return await sendRequest();
    } catch (error) {
      if (!isExpired(error)) throw error;
      await refresh();
      return sendRequest();
    }
  }

  const recordUri = (collection, recordKey) =>
    `at://${session.did}/${collection}/${recordKey}`;

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
      const listedPage = await call(listRecordsUrl(collection, cursor));
      if (Array.isArray(listedPage.records))
        records.push(...listedPage.records);
      cursor =
        typeof listedPage.cursor === "string" ? listedPage.cursor : undefined;
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
      const accountDid = id.startsWith("did:") ? id : await resolveHandle(id);
      const pdsUrl = await resolvePdsUrl(accountDid);
      const createdSession = await call(
        `${pdsUrl}/xrpc/com.atproto.server.createSession`,
        {
          method: "POST",
          body: { identifier: id, password: appPassword },
        },
      );
      save({
        did: createdSession.did,
        handle: createdSession.handle,
        accessJwt: createdSession.accessJwt,
        refreshJwt: createdSession.refreshJwt,
        pds: pdsUrl,
      });
      return { did: createdSession.did, handle: createdSession.handle };
    },
    /** Log out (best-effort server-side deleteSession) and clear local session. */
    async logout() {
      const endedSession = session;
      save(null);
      if (endedSession) {
        await call(
          `${endedSession.pds}/xrpc/com.atproto.server.deleteSession`,
          {
            method: "POST",
            token: endedSession.refreshJwt,
          },
        ).catch(() => {});
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
     * @param {string} recordKey @param {object} record
     * @returns {Promise<{uri: string, cid: string}>}
     */
    updateEvent(recordKey, record) {
      return xrpcPost("com.atproto.repo.putRecord", {
        repo: session?.did,
        collection: EVENT_NSID,
        rkey: recordKey,
        record: { ...record, $type: EVENT_NSID },
      });
    },
    /** @param {string} recordKey @returns {Promise<{uri: string}>} */
    async deleteEvent(recordKey) {
      await xrpcPost("com.atproto.repo.deleteRecord", {
        repo: session?.did,
        collection: EVENT_NSID,
        rkey: recordKey,
      });
      return { uri: recordUri(EVENT_NSID, recordKey) };
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
    /** @param {string} recordKey subscription record key @returns {Promise<{uri: string}>} */
    async deleteSubscription(recordKey) {
      await xrpcPost("com.atproto.repo.deleteRecord", {
        repo: session?.did,
        collection: SUBSCRIPTION_NSID,
        rkey: recordKey,
      });
      return { uri: recordUri(SUBSCRIPTION_NSID, recordKey) };
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
