/**
 * "Demo mode" writer: same interface as the atproto writer, but needs no account.
 *
 * Normally a host's event is saved in their own AT Protocol account, and the backend
 * hears about it from Jetstream, the live feed of every record change ("commit") on the
 * network. In demo mode this writer skips both: it builds a message shaped exactly like
 * a Jetstream commit and posts it to POST /api/dev/records, which feeds it to the backend
 * as if it came from the network. The fake author is a made-up account id (DID) saved
 * in localStorage. Terms: docs/projects/triton-event-feed/AT_PROTOCOL_GLOSSARY.md
 * @module devWriter
 */
import { EVENT_NSID, LISTENER_NSID, buildListenerRecord } from "./records.js";
import { getStorage, randomId, storageGet, storageSet } from "./util.js";

const DEMO_DID_STORAGE_KEY = "cm:demo-did";
const BASE32_SORTABLE_ALPHABET = "234567abcdefghijklmnopqrstuvwxyz";

let lastTimestampMicros = 0n;
const clockId = BigInt(Math.floor(Math.random() * 1024));

/**
 * Generate a record key (a record's name within its type, like a file name) in the
 * format real accounts use, a "TID" (timestamp id): 13 chars of base32-sortable encoding
 * of (microsecond timestamp << 10 | clock id), so later keys sort after earlier ones.
 * Monotonic within this page.
 * @param {number} [nowMs]
 * @returns {string}
 */
export function generateTimestampRecordKey(nowMs = Date.now()) {
  let timestampMicros = BigInt(Math.floor(nowMs)) * 1000n;
  if (timestampMicros <= lastTimestampMicros)
    timestampMicros = lastTimestampMicros + 1n;
  lastTimestampMicros = timestampMicros;
  let remainingBits = ((timestampMicros & ((1n << 53n) - 1n)) << 10n) | clockId;
  let encodedRecordKey = "";
  for (let characterIndex = 0; characterIndex < 13; characterIndex++) {
    encodedRecordKey =
      BASE32_SORTABLE_ALPHABET[Number(remainingBits & 31n)] + encodedRecordKey;
    remainingBits >>= 5n;
  }
  return encodedRecordKey;
}

/**
 * Build a message shaped like a Jetstream commit: one record created, updated or deleted
 * (see CONTRACTS.md).
 * @param {{did: string, operation: 'create'|'update'|'delete', collection: string,
 *   rkey: string, record?: object, nowMs?: number}} commitFields field names
 *   follow Jetstream: `did` is the account id of the record's owner, `collection` the
 *   record type (NSID), `rkey` the record key
 * @returns {object}
 */
export function buildCommit({
  did: repoDid,
  operation,
  collection,
  rkey: recordKey,
  record,
  nowMs = Date.now(),
}) {
  const commit = { operation, collection, rkey: recordKey };
  if (operation !== "delete") {
    commit.cid = `bafydev${randomId(24)}`;
    commit.record = record;
  }
  return {
    did: repoDid,
    time_us: Math.floor(nowMs) * 1000,
    kind: "commit",
    commit,
  };
}

/**
 * @param {{api: {postDevRecord(commit: object): Promise<any>}, storage?: Storage|null}} options
 */
export function createDevWriter({ api, storage = getStorage("localStorage") }) {
  let demoDid = storageGet(storage, DEMO_DID_STORAGE_KEY);
  if (!demoDid) {
    demoDid = `did:plc:demo-${randomId(12)}`;
    storageSet(storage, DEMO_DID_STORAGE_KEY, demoDid);
  }

  async function commit(operation, collection, recordKey, record) {
    const jetstreamCommit = buildCommit({
      did: demoDid,
      operation,
      collection,
      rkey: recordKey,
      record,
    });
    await api.postDevRecord(jetstreamCommit);
    return {
      uri: `at://${demoDid}/${collection}/${recordKey}`,
      cid: jetstreamCommit.commit.cid,
    };
  }

  return {
    kind: "dev",
    did: demoDid,
    handle: "demo",
    loggedIn: false,
    /** @param {object} record @returns {Promise<{uri: string, cid: string}>} */
    createEvent: (record) =>
      commit("create", EVENT_NSID, generateTimestampRecordKey(), {
        ...record,
        $type: EVENT_NSID,
      }),
    /** @param {string} recordKey @param {object} record */
    updateEvent: (recordKey, record) =>
      commit("update", EVENT_NSID, recordKey, { ...record, $type: EVENT_NSID }),
    /** @param {string} recordKey */
    deleteEvent: (recordKey) => commit("delete", EVENT_NSID, recordKey),
    /** @param {string} eventUri @param {string} hashtag */
    createListener: (eventUri, hashtag) =>
      commit(
        "create",
        LISTENER_NSID,
        generateTimestampRecordKey(),
        buildListenerRecord(eventUri, hashtag),
      ),
  };
}
