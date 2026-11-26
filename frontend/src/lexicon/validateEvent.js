/**
 * Validator for app.communitymap.event records.
 *
 * The schema itself lives in lexicons/app/communitymap/event.json at the repo
 * root. This file reads that JSON directly, so the validator can never drift
 * from the schema. See docs/adr/0001-event-lexicon.md for the reasoning.
 *
 * Validation happens in two stages:
 *   1. Lexicon rules (required fields, types, lengths, datetime format) are
 *      checked by @atproto/lexicon.
 *   2. Rules the lexicon language can't express are checked here by hand:
 *      endsAt must be after startsAt, and lat/lng must be in range.
 *
 * "Start can't be in the past" is intentionally NOT checked here. It is a
 * create-event form rule (issue #6); otherwise every event that has already
 * happened would become invalid.
 */
import { Lexicons } from "@atproto/lexicon";
import eventLexicon from "../../../lexicons/app/communitymap/event.json";

export const EVENT_NSID = "app.communitymap.event";

/**
 * The standard AT Protocol strongRef lexicon (a record's uri + cid).
 * Our event's `group` field points to it, so the validator needs to know it.
 * Copied from the official definition in the atproto repo.
 */
const strongRefLexicon = {
  lexicon: 1,
  id: "com.atproto.repo.strongRef",
  description: "A URI with a content-hash fingerprint.",
  defs: {
    main: {
      type: "object",
      required: ["uri", "cid"],
      properties: {
        uri: { type: "string", format: "at-uri" },
        cid: { type: "string", format: "cid" },
      },
    },
  },
};

const lexicons = new Lexicons([eventLexicon, strongRefLexicon]);

/**
 * @typedef {object} Location
 * @property {string} lat Decimal degrees as a string, -90 to 90, e.g. "32.8801".
 * @property {string} lng Decimal degrees as a string, -180 to 180.
 * @property {string} [name] Place name, e.g. "Price Center". Max 100 characters.
 * @property {string} [address] Street address. Max 300 characters.
 */

/**
 * @typedef {object} StrongRef
 * @property {string} uri at:// address of the record.
 * @property {string} cid Fingerprint of one exact version of the record.
 */

/**
 * @typedef {object} EventRecord
 * @property {"app.communitymap.event"} $type
 * @property {string} name Event title, 1-100 characters.
 * @property {string} [description] Max 3000 characters.
 * @property {string} startsAt ISO datetime with timezone, e.g. "2026-12-01T18:00:00.000Z".
 * @property {string} endsAt ISO datetime with timezone. Must be after startsAt.
 * @property {Location} location
 * @property {string[]} [tags] At most 10 tags, each 1-32 characters.
 * @property {StrongRef} [group] The app.communitymap.group record this event belongs to.
 * @property {string} createdAt ISO datetime with timezone.
 */

/**
 * @typedef {object} ValidationIssue
 * @property {string} path Where the problem is, e.g. "location.lat" ("" if unknown).
 * @property {string} message Human-readable description of the problem.
 */

/**
 * @typedef {{ ok: true } | { ok: false, errors: ValidationIssue[] }} ValidationResult
 */

const eventProps = eventLexicon.defs.main.record.properties;
const locationProps = eventLexicon.defs.location.properties;

/**
 * Size limits read from the lexicon, for character counters in the
 * create-event form (#6). "Graphemes" are characters as a person sees them
 * (one emoji = 1). Because they're read from the JSON, they can't go stale.
 */
export const EVENT_LIMITS = Object.freeze({
  nameMaxGraphemes: eventProps.name.maxGraphemes,
  descriptionMaxGraphemes: eventProps.description.maxGraphemes,
  tagsMaxCount: eventProps.tags.maxLength,
  tagMaxGraphemes: eventProps.tags.items.maxGraphemes,
  locationNameMaxGraphemes: locationProps.name.maxGraphemes,
  addressMaxGraphemes: locationProps.address.maxGraphemes,
});

// A plain decimal number such as "32.8801" or "-117.2375". Stricter than
// Number(), which would also accept "", "0x20" or "1e2".
const DECIMAL_RE = /^-?\d+(\.\d+)?$/;

/**
 * Turns a @atproto/lexicon error message into { path, message }.
 * Its messages look like 'Record/location must have the property "lat"'.
 *
 * @param {string} message
 * @returns {ValidationIssue}
 */
function toIssue(message) {
  const match = /^Record((?:\/[^\s/]+)*)(?:\s|$)/.exec(message);
  const parts = match ? match[1].split("/").filter(Boolean) : [];
  // For a missing field, point at the field itself, e.g. "location.lat".
  const missing = /must have the property "([^"]+)"/.exec(message);
  if (missing) parts.push(missing[1]);
  return { path: parts.join("."), message };
}

/**
 * Checks that a lat/lng string is a decimal number within [min, max].
 *
 * @param {unknown} value
 * @param {string} field "lat" or "lng"
 * @param {number} min
 * @param {number} max
 * @returns {ValidationIssue | null}
 */
function checkCoordinate(value, field, min, max) {
  const path = `location.${field}`;
  if (typeof value !== "string" || !DECIMAL_RE.test(value)) {
    return { path, message: `${field} must be a decimal number` };
  }
  const n = Number(value);
  if (n < min || n > max) {
    return { path, message: `${field} must be between ${min} and ${max}` };
  }
  return null;
}

/**
 * Validates an app.communitymap.event record.
 *
 * @param {unknown} record The record to check (for example, a form's output
 *   before publishing, or a record read from a PDS).
 * @returns {ValidationResult} { ok: true } if valid; otherwise
 *   { ok: false, errors } where each error has a path and a message.
 *
 * @example
 * const result = validateEvent(record);
 * if (!result.ok) console.log(result.errors[0].message);
 */
export function validateEvent(record) {
  /** @type {ValidationIssue[]} */
  const errors = [];

  // Stage 1: lexicon rules. assertValidRecord throws on the first problem.
  try {
    lexicons.assertValidRecord(EVENT_NSID, record);
  } catch (err) {
    errors.push(toIssue(err instanceof Error ? err.message : String(err)));
  }

  // Stage 2: rules the lexicon can't express. These check their own inputs,
  // so they're safe to run even when stage 1 found a problem.
  if (record && typeof record === "object") {
    const { startsAt, endsAt, location } = /** @type {any} */ (record);

    const start = typeof startsAt === "string" ? Date.parse(startsAt) : NaN;
    const end = typeof endsAt === "string" ? Date.parse(endsAt) : NaN;
    if (!Number.isNaN(start) && !Number.isNaN(end) && end <= start) {
      errors.push({ path: "endsAt", message: "endsAt must be after startsAt" });
    }

    if (location && typeof location === "object") {
      // Missing lat/lng is already reported by stage 1.
      if (location.lat !== undefined) {
        const issue = checkCoordinate(location.lat, "lat", -90, 90);
        if (issue) errors.push(issue);
      }
      if (location.lng !== undefined) {
        const issue = checkCoordinate(location.lng, "lng", -180, 180);
        if (issue) errors.push(issue);
      }
    }
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}
