/**
 * Bridge between the AppView's EventView (what GET /api/event and GET /api/events return)
 * and the app.communitymap.event lexicon (lexicons/app/communitymap/event.json).
 *
 * An EventView is the lexicon record's fields flattened next to AppView metadata
 * (uri, cid, authorDid, authorHandle, indexedAt, updatedAt, status, updates, ...).
 * This module:
 *   1. pulls the lexicon record back out of an EventView and validates it with the
 *      shared validator (validateEvent.js), so views can flag records that break the
 *      schema instead of trusting them; and
 *   2. turns an EventView, valid or not, into a "display event" whose every field has a
 *      safe, known type, so a malformed record renders best-effort instead of crashing.
 *
 * Nothing here talks to the network; every function is pure.
 * @module lexicon/eventView
 */
import { parseAtUri } from "../records.js";
import { EVENT_NSID, validateEvent } from "./validateEvent.js";

/** The record fields defined by the lexicon (everything else on an EventView is metadata). */
export const LEXICON_RECORD_FIELDS = Object.freeze([
  "name",
  "description",
  "startsAt",
  "endsAt",
  "location",
  "tags",
  "group",
  "createdAt",
]);

/** Title shown when a record has no usable name. */
export const UNTITLED_EVENT_NAME = "Untitled event";

/** Issue reported when the value handed to this module is not an object at all. */
const NOT_AN_OBJECT_ISSUE = Object.freeze({
  path: "",
  message: "Event must be an object",
});

/**
 * @typedef {import('./validateEvent.js').ValidationIssue} ValidationIssue
 */

/**
 * @typedef {object} DisplayGroup
 * @property {string} label Human-readable text for the group.
 * @property {string|null} uri at:// URI of the group record, or null for legacy string groups.
 */

/**
 * @typedef {object} DisplayLocation
 * @property {string} name Place name ("" when missing).
 * @property {string} address Street address ("" when missing).
 * @property {string|null} lat Latitude string as stored in the record, or null.
 * @property {string|null} lng Longitude string as stored in the record, or null.
 */

/**
 * @typedef {object} DisplayUpdate
 * @property {string} text Announcement text.
 * @property {string} createdAt ISO datetime the announcement was posted.
 */

/**
 * @typedef {object} DisplayEvent
 * @property {string|null} uri
 * @property {string} name Never empty (falls back to UNTITLED_EVENT_NAME).
 * @property {string} description
 * @property {string|null} startsAt Parseable datetime string, or null.
 * @property {string|null} endsAt Parseable datetime string, or null.
 * @property {DisplayLocation} location
 * @property {string[]} tags
 * @property {DisplayGroup|null} group
 * @property {string|null} authorDid
 * @property {string|null} authorHandle
 * @property {string|null} status AppView status (upcoming / live / ending_soon / ended).
 * @property {string|null} indexedAt
 * @property {string|null} updatedAt
 * @property {string|null} sourceUrl
 * @property {DisplayUpdate[]} updates Only well-formed announcements.
 * @property {ValidationIssue[]} issues Lexicon problems with the record (empty = valid).
 */

/**
 * True for plain objects (not null, not arrays).
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
export const isPlainObject = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The value when it is a string, otherwise "".
 * @param {unknown} value
 * @returns {string}
 */
const stringOrEmpty = (value) => (typeof value === "string" ? value : "");

/**
 * The value when it is a non-empty string, otherwise null.
 * @param {unknown} value
 * @returns {string|null}
 */
const stringOrNull = (value) =>
  typeof value === "string" && value !== "" ? value : null;

/**
 * The value when it is a string that Date can parse, otherwise null.
 * @param {unknown} value
 * @returns {string|null}
 */
const parseableDateOrNull = (value) =>
  typeof value === "string" && Number.isFinite(Date.parse(value))
    ? value
    : null;

/**
 * True when `uri` is an at:// URI that points at an app.communitymap.event record.
 * @param {unknown} uri
 * @returns {boolean}
 */
export function isEventUri(uri) {
  if (typeof uri !== "string") return false;
  return parseAtUri(uri)?.collection === EVENT_NSID;
}

/**
 * Pull the lexicon record out of an EventView. Only lexicon fields that are present are
 * copied. `$type` is added when the AppView left it off, so the validator can run.
 * @param {unknown} eventView
 * @returns {Record<string, unknown>|null} null when `eventView` is not an object
 */
export function extractEventRecord(eventView) {
  if (!isPlainObject(eventView)) return null;
  const record = { $type: eventView.$type ?? EVENT_NSID };
  for (const field of LEXICON_RECORD_FIELDS) {
    if (eventView[field] !== undefined) record[field] = eventView[field];
  }
  return record;
}

/**
 * Validate the lexicon record inside an EventView.
 * @param {unknown} eventView
 * @returns {ValidationIssue[]} empty when the record matches the lexicon
 */
export function findLexiconIssues(eventView) {
  const record = extractEventRecord(eventView);
  if (!record) return [{ ...NOT_AN_OBJECT_ISSUE }];
  const result = validateEvent(record);
  return result.ok ? [] : result.errors;
}

/**
 * Describe an event's group for display.
 *
 * The lexicon stores `group` as a com.atproto.repo.strongRef ({uri, cid}) pointing at an
 * app.communitymap.group record. STUB(#17): that lexicon is not defined yet, so there is
 * no group name to look up; the group's record key stands in as its label until #17 can
 * resolve the latest group record by `uri` (see the Event Lexicon ADR). Plain strings,
 * from events indexed before the lexicon change, are still shown as-is.
 * @param {unknown} group
 * @returns {DisplayGroup|null} null when there is no usable group
 */
export function describeGroup(group) {
  if (typeof group === "string") {
    const label = group.trim();
    return label ? { label, uri: null } : null;
  }
  if (!isPlainObject(group) || typeof group.uri !== "string") return null;
  const parsed = parseAtUri(group.uri);
  return parsed ? { label: parsed.rkey, uri: group.uri } : null;
}

/**
 * Keep only string tags that are not empty.
 * @param {unknown} tags
 * @returns {string[]}
 */
function sanitizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  return tags.filter((tag) => typeof tag === "string" && tag.trim() !== "");
}

/**
 * Copy the location's fields, keeping only values of the expected type.
 * @param {unknown} location
 * @returns {DisplayLocation}
 */
function sanitizeLocation(location) {
  const source = isPlainObject(location) ? location : {};
  return {
    name: stringOrEmpty(source.name).trim(),
    address: stringOrEmpty(source.address).trim(),
    lat: stringOrNull(source.lat),
    lng: stringOrNull(source.lng),
  };
}

/**
 * Keep only announcements with text and a parseable timestamp.
 * @param {unknown} updates
 * @returns {DisplayUpdate[]}
 */
function sanitizeUpdates(updates) {
  if (!Array.isArray(updates)) return [];
  return updates
    .filter(isPlainObject)
    .filter((update) => stringOrEmpty(update.text).trim() !== "")
    .filter((update) => parseableDateOrNull(update.createdAt) !== null)
    .map((update) => ({ text: update.text, createdAt: update.createdAt }));
}

/**
 * Turn an EventView into a DisplayEvent: every field has a safe type, so views can
 * render it without further checks, and `issues` lists what broke the lexicon.
 * @param {unknown} eventView
 * @returns {DisplayEvent}
 */
export function toDisplayEvent(eventView) {
  const source = isPlainObject(eventView) ? eventView : {};
  return {
    uri: stringOrNull(source.uri),
    name: stringOrEmpty(source.name).trim() || UNTITLED_EVENT_NAME,
    description: stringOrEmpty(source.description),
    startsAt: parseableDateOrNull(source.startsAt),
    endsAt: parseableDateOrNull(source.endsAt),
    location: sanitizeLocation(source.location),
    tags: sanitizeTags(source.tags),
    group: describeGroup(source.group),
    authorDid: stringOrNull(source.authorDid),
    authorHandle: stringOrNull(source.authorHandle),
    status: stringOrNull(source.status),
    indexedAt: parseableDateOrNull(source.indexedAt),
    updatedAt: parseableDateOrNull(source.updatedAt),
    sourceUrl: stringOrNull(source.sourceUrl),
    updates: sanitizeUpdates(source.updates),
    issues: findLexiconIssues(eventView),
  };
}
