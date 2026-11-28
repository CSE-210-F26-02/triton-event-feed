/**
 * Validator and builder for app.communitymap.subscription records (#19).
 *
 * A subscription record means "notify me when this event changes". It is saved in the
 * subscriber's own AT Protocol account (on their PDS, the server that stores it), not in
 * our database. Its schema, its "lexicon", lives in
 * lexicons/app/communitymap/subscription.json at the repo root and is read through the
 * shared registry (registry.js), so this can never drift from it.
 *
 * The record points at the event with a "strongRef" (com.atproto.repo.strongRef):
 * {uri, cid}, the event record's address (AT URI) plus a fingerprint (CID) of the exact
 * version the user saw. Like every AT Protocol record it is public; the UI says so next
 * to the Subscribe button. Terms: docs/projects/triton-event-feed/AT_PROTOCOL_GLOSSARY.md
 *
 * Validation happens in two stages, like validateEvent.js:
 *   1. Lexicon rules (required fields, strongRef shape, at-uri / cid / datetime formats)
 *      are checked by @atproto/lexicon.
 *   2. A rule the lexicon language can't express is checked by hand: the subject must be
 *      an app.communitymap.event record, not any other kind of record.
 *
 * The backend's twin is backend/lexicon/subscription.py; both run fixtures/subscription/.
 * @module lexicon/validateSubscription
 */
import { parseAtUri } from "../records.js";
import { lexiconIssues } from "./registry.js";
import { EVENT_NSID } from "./validateEvent.js";

export const SUBSCRIPTION_NSID = "app.communitymap.subscription";

/**
 * @typedef {import('./registry.js').ValidationIssue} ValidationIssue
 * @typedef {import('./validateEvent.js').StrongRef} StrongRef
 */

/**
 * @typedef {object} SubscriptionRecord
 * @property {"app.communitymap.subscription"} $type
 * @property {StrongRef} subject The app.communitymap.event being followed.
 * @property {string} createdAt ISO datetime with timezone.
 */

/**
 * @typedef {{ ok: true } | { ok: false, errors: ValidationIssue[] }} ValidationResult
 */

/** Issue reported when the subject points at something other than an event record. */
const SUBJECT_NOT_EVENT_ISSUE = Object.freeze({
  path: "subject.uri",
  message: `subject.uri must point at an ${EVENT_NSID} record`,
});

/**
 * Stage 2: the subject must be an event record. Skipped when the subject or its uri is
 * missing / not a string, because stage 1 already reports that.
 * @param {unknown} record
 * @returns {ValidationIssue[]}
 */
function subjectCollectionIssues(record) {
  const uri = /** @type {any} */ (record)?.subject?.uri;
  if (typeof uri !== "string") return [];
  const parsed = parseAtUri(uri);
  return parsed?.collection === EVENT_NSID
    ? []
    : [{ ...SUBJECT_NOT_EVENT_ISSUE }];
}

/**
 * Validates an app.communitymap.subscription record.
 *
 * @param {unknown} record The record to check (before saving it with createRecord, or
 *   one read back from a user's account).
 * @returns {ValidationResult} { ok: true } if valid; otherwise { ok: false, errors }.
 *
 * @example
 * const result = validateSubscription(record);
 * if (!result.ok) console.log(result.errors[0].message);
 */
export function validateSubscription(record) {
  const errors = [
    ...lexiconIssues(SUBSCRIPTION_NSID, record),
    ...(record && typeof record === "object"
      ? subjectCollectionIssues(record)
      : []),
  ];
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

/**
 * Build a subscription record for an event. Does not validate; call
 * validateSubscription on the result before publishing it.
 * @param {{uri?: unknown, cid?: unknown}} event the EventView being subscribed to
 * @param {string} [createdAt] ISO datetime; defaults to now
 * @returns {SubscriptionRecord}
 */
export function buildSubscriptionRecord(
  event,
  createdAt = new Date().toISOString(),
) {
  return {
    $type: SUBSCRIPTION_NSID,
    subject: { uri: event?.uri, cid: event?.cid },
    createdAt,
  };
}
