/**
 * Lexicon record building + validation (mirrors lexicons/*.json), shared by both writers.
 * @module records
 */

export const EVENT_NSID = "app.communitymap.event";
export const LISTENER_NSID = "app.communitymap.listener";

const bytes = (text) => new TextEncoder().encode(text).length; // lexicon maxLength = UTF-8 bytes

/**
 * Normalize a comma-separated tag string (strip "#", lowercase, dedupe), like the backend.
 * @param {string|string[]} input
 * @returns {string[]}
 */
export function parseTags(input) {
  const tagCandidates = Array.isArray(input)
    ? input
    : String(input || "").split(",");
  const normalizedTags = [];
  for (const rawTag of tagCandidates) {
    const tag = rawTag.trim().replace(/^#+/, "").toLowerCase();
    if (tag && !normalizedTags.includes(tag)) normalizedTags.push(tag);
  }
  return normalizedTags;
}

/**
 * Build an app.communitymap.event record from form-ish input. Optional empty fields are
 * omitted; lat/lng become strings; `createdAt` defaults to now.
 * @param {{name: string, description?: string, startsAt: string, endsAt: string,
 *   locationName: string, address?: string, lat?: string|number, lng?: string|number,
 *   tags?: string|string[], group?: string, sourceUrl?: string, createdAt?: string}} input
 * @returns {object}
 */
export function buildEventRecord(input) {
  const toTrimmedString = (value) =>
    value == null ? "" : String(value).trim();
  const location = { name: toTrimmedString(input.locationName) };
  if (toTrimmedString(input.address))
    location.address = toTrimmedString(input.address);
  if (toTrimmedString(input.lat) !== "" && toTrimmedString(input.lng) !== "") {
    location.lat = String(Number(toTrimmedString(input.lat)));
    location.lng = String(Number(toTrimmedString(input.lng)));
  }
  const record = {
    $type: EVENT_NSID,
    name: toTrimmedString(input.name),
    startsAt: input.startsAt,
    endsAt: input.endsAt,
    location,
    createdAt: input.createdAt || new Date().toISOString(),
  };
  if (toTrimmedString(input.description))
    record.description = toTrimmedString(input.description);
  const tags = parseTags(input.tags || []);
  if (tags.length) record.tags = tags;
  if (toTrimmedString(input.group)) record.group = toTrimmedString(input.group);
  if (toTrimmedString(input.sourceUrl))
    record.sourceUrl = toTrimmedString(input.sourceUrl);
  return record;
}

/**
 * Build an app.communitymap.listener record.
 * @param {string} subject at:// URI of the event
 * @param {string} hashtag with or without leading "#"
 * @returns {object}
 */
export function buildListenerRecord(subject, hashtag) {
  return {
    $type: LISTENER_NSID,
    subject,
    hashtag: String(hashtag).trim().replace(/^#+/, "").toLowerCase(),
    createdAt: new Date().toISOString(),
  };
}

const isDate = (value) =>
  typeof value === "string" && value !== "" && !Number.isNaN(Date.parse(value));

/**
 * Validate an event record against the lexicon. Returns field → message (empty = valid).
 * Field keys: name, description, startsAt, endsAt, locationName, address, coords, tags, group.
 * @param {object} record event record
 * @returns {Record<string, string>}
 */
export function validateEventRecord(record) {
  const errors = {};
  if (!record.name) errors.name = "Name is required.";
  else if (bytes(record.name) > 200)
    errors.name = "Name is too long (max 200).";
  if (record.description && bytes(record.description) > 3000)
    errors.description = "Description is too long (max 3000).";
  if (!isDate(record.startsAt)) errors.startsAt = "Start time is required.";
  if (!isDate(record.endsAt)) errors.endsAt = "End time is required.";
  else if (
    isDate(record.startsAt) &&
    Date.parse(record.endsAt) < Date.parse(record.startsAt)
  ) {
    errors.endsAt = "End must be at or after start.";
  }
  const eventLocation = record.location || {};
  if (!eventLocation.name) errors.locationName = "Location name is required.";
  else if (bytes(eventLocation.name) > 200)
    errors.locationName = "Location name is too long (max 200).";
  if (eventLocation.address && bytes(eventLocation.address) > 300)
    errors.address = "Address is too long (max 300).";
  const coordinatesError = validateCoords(eventLocation.lat, eventLocation.lng);
  if (coordinatesError) errors.coords = coordinatesError;
  const tags = record.tags || [];
  if (tags.length > 10) errors.tags = "At most 10 tags.";
  else if (tags.some((tag) => bytes(tag) > 32))
    errors.tags = "Each tag must be 32 characters or fewer.";
  if (record.group && bytes(record.group) > 100)
    errors.group = "Group is too long (max 100).";
  return errors;
}

function validateCoords(lat, lng) {
  if (lat == null && lng == null) return null;
  if (lat == null || lng == null)
    return "Enter both latitude and longitude, or neither.";
  const latitude = Number(lat);
  const longitude = Number(lng);
  if (!Number.isFinite(latitude) || Math.abs(latitude) > 90)
    return "Latitude must be between -90 and 90.";
  if (!Number.isFinite(longitude) || Math.abs(longitude) > 180)
    return "Longitude must be between -180 and 180.";
  return null;
}

/**
 * Validate a hashtag for a listener record ("" means none, which is valid).
 * @param {string} tag
 * @returns {string|null} error message
 */
export function validateHashtag(tag) {
  const normalizedTag = String(tag || "")
    .trim()
    .replace(/^#+/, "");
  if (!normalizedTag) return null;
  if (bytes(normalizedTag) > 64) return "Hashtag is too long (max 64).";
  if (/\s/.test(normalizedTag)) return "Hashtag cannot contain spaces.";
  return null;
}

/**
 * Parse an at:// URI (at://<repo DID>/<collection NSID>/<record key>).
 * @param {string} uri
 * @returns {{repoDid: string, collection: string, recordKey: string}|null}
 *   repoDid: the DID of the account whose repository holds the record;
 *   collection: the record type, e.g. "app.communitymap.event";
 *   recordKey: the record's key within that collection (AT Protocol "rkey")
 */
export function parseAtUri(uri) {
  const match = /^at:\/\/([^/]+)\/([^/]+)\/([^/?#]+)$/.exec(uri || "");
  return match
    ? { repoDid: match[1], collection: match[2], recordKey: match[3] }
    : null;
}
