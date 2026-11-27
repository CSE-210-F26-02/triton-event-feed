/**
 * The one @atproto/lexicon registry shared by every validator in src/lexicon/.
 *
 * Each of this app's lexicons is read straight from lexicons/ at the repo root, so the
 * validators can never drift from the schemas. To add a lexicon: import its JSON here,
 * add it to the registry, and write a validate<Name>.js next to validateEvent.js.
 * @module lexicon/registry
 */
import { Lexicons } from "@atproto/lexicon";
import eventLexicon from "../../../lexicons/app/communitymap/event.json";
import subscriptionLexicon from "../../../lexicons/app/communitymap/subscription.json";

/**
 * The standard AT Protocol strongRef lexicon (a record's uri + cid). The event's `group`
 * and the subscription's `subject` point to it, so the registry needs to know it.
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

/** Registry used by validateEvent.js and validateSubscription.js. */
export const lexicons = new Lexicons([
  eventLexicon,
  subscriptionLexicon,
  strongRefLexicon,
]);

/** The raw lexicon documents, for code that reads limits or required fields. */
export { eventLexicon, subscriptionLexicon };

/**
 * @typedef {object} ValidationIssue
 * @property {string} path Where the problem is, e.g. "location.lat" ("" if unknown).
 * @property {string} message Human-readable description of the problem.
 */

/**
 * Turns a @atproto/lexicon error message into { path, message }.
 * Its messages look like 'Record/location must have the property "lat"'.
 *
 * @param {string} message
 * @returns {ValidationIssue}
 */
export function toIssue(message) {
  const match = /^Record((?:\/[^\s/]+)*)(?:\s|$)/.exec(message);
  const parts = match ? match[1].split("/").filter(Boolean) : [];
  // For a missing field, point at the field itself, e.g. "location.lat".
  const missing = /must have the property "([^"]+)"/.exec(message);
  if (missing) parts.push(missing[1]);
  return { path: parts.join("."), message };
}

/**
 * Run the lexicon rules for one record type. assertValidRecord stops at the first
 * problem, so this returns at most one issue.
 * @param {string} nsid e.g. "app.communitymap.event"
 * @param {unknown} record
 * @returns {ValidationIssue[]}
 */
export function lexiconIssues(nsid, record) {
  try {
    lexicons.assertValidRecord(nsid, record);
    return [];
  } catch (err) {
    return [toIssue(err instanceof Error ? err.message : String(err))];
  }
}
