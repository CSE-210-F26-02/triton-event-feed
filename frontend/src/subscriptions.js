/**
 * Event subscriptions (#19), stored as app.communitymap.subscription records on the
 * subscriber's own PDS: subscribing is createRecord, unsubscribing is deleteRecord, and
 * the list comes from com.atproto.repo.listRecords. Because the records live on the PDS,
 * subscriptions survive reloads and follow the user to other devices and apps.
 *
 * Reading the PDS directly means this works before the indexer (#5) exists. Once #5
 * ingests the same records, the backend will know who to notify; nothing here changes.
 * Records that break the lexicon (e.g. written by another app) are ignored.
 * @module subscriptions
 */
import { isEnded } from "./filters.js";
import { isPlainObject } from "./lexicon/eventView.js";
import {
  buildSubscriptionRecord,
  validateSubscription,
} from "./lexicon/validateSubscription.js";
import { parseAtUri } from "./records.js";

/** Why a subscribe / unsubscribe request was refused before reaching the PDS. */
export const SUBSCRIPTION_ERROR = Object.freeze({
  loginRequired: "login-required",
  eventEnded: "event-ended",
  invalidEvent: "invalid-event",
});

/** Error with a SUBSCRIPTION_ERROR `code`, so the UI can pick the right message. */
export class SubscriptionError extends Error {
  /**
   * @param {string} code one of SUBSCRIPTION_ERROR
   * @param {string} message
   * @param {import('./lexicon/registry.js').ValidationIssue[]} [issues]
   */
  constructor(code, message, issues = []) {
    super(message);
    this.name = "SubscriptionError";
    this.code = code;
    this.issues = issues;
  }
}

/**
 * The part of a PDS writer this module needs (createAtprotoWriter implements it).
 * @typedef {object} SubscriptionRepo
 * @property {string} did the logged-in user's DID
 * @property {() => Promise<import('./atproto.js').ListedRecord[]>} listSubscriptions
 * @property {(record: object) => Promise<{uri: string, cid: string}>} createSubscription
 * @property {(recordKey: string) => Promise<unknown>} deleteSubscription
 */

/**
 * Pure: turn listed subscription records into eventUri → [subscription record keys].
 * An event can have several records (e.g. subscribed from two tabs at once); all are
 * kept so unsubscribing removes every one. Invalid records are counted, not kept.
 * @param {unknown} listed com.atproto.repo.listRecords entries
 * @returns {{recordKeysByEvent: Map<string, string[]>, skippedCount: number}}
 */
export function indexSubscriptionRecords(listed) {
  const recordKeysByEvent = new Map();
  let skippedCount = 0;
  for (const entry of Array.isArray(listed) ? listed : []) {
    const recordKey = parseAtUri(entry?.uri)?.recordKey;
    if (!recordKey || !validateSubscription(entry.value).ok) {
      skippedCount++;
      continue;
    }
    const eventUri = entry.value.subject.uri;
    recordKeysByEvent.set(eventUri, [
      ...(recordKeysByEvent.get(eventUri) ?? []),
      recordKey,
    ]);
  }
  return { recordKeysByEvent, skippedCount };
}

/**
 * Check an event can be subscribed to and build its validated record.
 * @param {unknown} event EventView
 * @param {Date} now
 * @returns {object} app.communitymap.subscription record
 * @throws {SubscriptionError} eventEnded or invalidEvent
 */
function subscriptionRecordFor(event, now) {
  if (!isPlainObject(event))
    throw new SubscriptionError(
      SUBSCRIPTION_ERROR.invalidEvent,
      "That event could not be found.",
    );
  if (isEnded(event, now))
    throw new SubscriptionError(
      SUBSCRIPTION_ERROR.eventEnded,
      "This event has ended, so it can't be subscribed to.",
    );
  const record = buildSubscriptionRecord(event, now.toISOString());
  const result = validateSubscription(record);
  if (!result.ok)
    throw new SubscriptionError(
      SUBSCRIPTION_ERROR.invalidEvent,
      "This event can't be subscribed to right now.",
      result.errors,
    );
  return record;
}

/**
 * Create the subscription store.
 * @param {{getRepo: () => SubscriptionRepo|null, onChange?: (subscribed: Set<string>) => void,
 *   now?: () => Date}} deps `getRepo` returns the logged-in PDS writer, or null when
 *   logged out
 * @returns {{load(): Promise<void>, subscribe(event: object): Promise<boolean>,
 *   unsubscribe(uri: string): Promise<boolean>, toggle(event: object): Promise<boolean>,
 *   clear(): void, has(uri: string): boolean, readonly subscribed: Set<string>,
 *   readonly ownerDid: string|null}}
 */
export function createSubscriptions({
  getRepo,
  onChange = () => {},
  now = () => new Date(),
}) {
  let recordKeysByEvent = new Map();
  let ownerDid = null;
  let loadSequence = 0;
  const pending = new Set(); // event URIs with a request in flight

  const changed = () => onChange(new Set(recordKeysByEvent.keys()));

  function requireRepo() {
    const repo = getRepo();
    if (repo) return repo;
    throw new SubscriptionError(
      SUBSCRIPTION_ERROR.loginRequired,
      "Log in to subscribe to events.",
    );
  }

  /** Replace local state with the logged-in user's records (empty when logged out). */
  async function load() {
    const sequence = ++loadSequence;
    const repo = getRepo();
    const listed = repo ? await repo.listSubscriptions() : [];
    if (sequence !== loadSequence) return; // a newer load / clear won
    recordKeysByEvent = indexSubscriptionRecords(listed).recordKeysByEvent;
    ownerDid = repo?.did ?? null;
    changed();
  }

  /** Subscribe to `event` (no-op when already subscribed). Resolves to true. */
  async function subscribe(event) {
    const repo = requireRepo();
    const uri = event?.uri;
    if (recordKeysByEvent.has(uri) || pending.has(uri)) return true;
    const record = subscriptionRecordFor(event, now());
    pending.add(uri);
    try {
      const created = await repo.createSubscription(record);
      const recordKey = parseAtUri(created?.uri)?.recordKey;
      if (recordKey) recordKeysByEvent.set(uri, [recordKey]);
      else await load(); // created, but the PDS gave no URI: re-list to learn its record key
    } finally {
      pending.delete(uri);
    }
    changed();
    return true;
  }

  /** Delete every subscription record for `uri`. Resolves to false (not subscribed). */
  async function unsubscribe(uri) {
    const repo = requireRepo();
    if (pending.has(uri)) return recordKeysByEvent.has(uri);
    pending.add(uri);
    try {
      for (const recordKey of [...(recordKeysByEvent.get(uri) ?? [])]) {
        await repo.deleteSubscription(recordKey);
        const remainingKeys =
          recordKeysByEvent.get(uri)?.filter((key) => key !== recordKey) ?? [];
        if (remainingKeys.length) recordKeysByEvent.set(uri, remainingKeys);
        else recordKeysByEvent.delete(uri);
      }
    } finally {
      pending.delete(uri);
      changed();
    }
    return false;
  }

  return {
    load,
    subscribe,
    unsubscribe,
    /** Subscribe, or unsubscribe when already subscribed. Resolves to the new state. */
    toggle: (event) =>
      recordKeysByEvent.has(event?.uri)
        ? unsubscribe(event.uri)
        : subscribe(event),
    /** Forget everything (on logout); cancels an in-flight load. */
    clear() {
      loadSequence++;
      recordKeysByEvent = new Map();
      ownerDid = null;
      changed();
    },
    has: (uri) => recordKeysByEvent.has(uri),
    get subscribed() {
      return new Set(recordKeysByEvent.keys());
    },
    get ownerDid() {
      return ownerDid;
    },
  };
}
