/**
 * Display formatting shared by views (dates in the user's local time zone).
 * @module format
 */
import { coordsOf, dayKey } from "./filters.js";

/**
 * Format a start–end window, e.g. "3:00 PM – 5:00 PM" or with dates when multi-day.
 * @param {string} startsAt ISO
 * @param {string} endsAt ISO
 * @param {{locale?: string, timeZone?: string}} [options]
 * @returns {string}
 */
export function formatTimeWindow(startsAt, endsAt, { locale, timeZone } = {}) {
  const start = new Date(startsAt);
  const end = new Date(endsAt);
  const timeFormatter = new Intl.DateTimeFormat(locale, {
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  });
  const dateTimeFormatter = new Intl.DateTimeFormat(locale, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  });
  const sameDay = timeZone
    ? sameDayInZone(start, end, timeZone)
    : dayKey(start) === dayKey(end);
  return sameDay
    ? `${timeFormatter.format(start)} – ${timeFormatter.format(end)}`
    : `${dateTimeFormatter.format(start)} – ${dateTimeFormatter.format(end)}`;
}

function sameDayInZone(firstDate, secondDate, timeZone) {
  const calendarDayFormatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return (
    calendarDayFormatter.format(firstDate) ===
    calendarDayFormatter.format(secondDate)
  );
}

/**
 * Format a single timestamp (e.g. for announcements).
 * @param {string} isoDateTime @param {{locale?: string, timeZone?: string}} [options]
 * @returns {string}
 */
export function formatDateTime(isoDateTime, { locale, timeZone } = {}) {
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  }).format(new Date(isoDateTime));
}

/**
 * OpenStreetMap link: exact pin when lat/lng exist, else an address search, else null.
 * @param {object} event
 * @returns {string|null}
 */
export function osmUrl(event) {
  const coordinates = coordsOf(event);
  if (coordinates)
    return `https://www.openstreetmap.org/?mlat=${coordinates.lat}&mlon=${coordinates.lng}#map=18/${coordinates.lat}/${coordinates.lng}`;
  const address = event?.location?.address;
  return address
    ? `https://www.openstreetmap.org/search?query=${encodeURIComponent(address)}`
    : null;
}

/** EventView.status values sent by the AppView (docs/projects/triton-event-feed/CONTRACTS.md). */
export const EVENT_STATUS = Object.freeze({
  UPCOMING: "upcoming",
  LIVE: "live",
  ENDING_SOON: "ending_soon",
  ENDED: "ended",
});

/** Badge text per status; "upcoming" has no badge. */
const STATUS_LABELS = Object.freeze({
  [EVENT_STATUS.LIVE]: "Happening now",
  [EVENT_STATUS.ENDING_SOON]: "Ending soon",
  [EVENT_STATUS.ENDED]: "Ended",
});

/**
 * Badges per status, in display order. An event that is ending soon is also still
 * happening, so it gets both badges. Each `modifier` is the `badge--<modifier>` CSS class.
 */
const STATUS_BADGES = Object.freeze({
  [EVENT_STATUS.LIVE]: [EVENT_STATUS.LIVE],
  [EVENT_STATUS.ENDING_SOON]: [EVENT_STATUS.LIVE, EVENT_STATUS.ENDING_SOON],
  [EVENT_STATUS.ENDED]: [EVENT_STATUS.ENDED],
});

/**
 * Primary status badge text for EventView.status, or null for "upcoming" / unknown.
 * @param {string} status
 * @returns {string|null}
 */
export function statusLabel(status) {
  return Object.hasOwn(STATUS_LABELS, status) ? STATUS_LABELS[status] : null;
}

/**
 * Status badge descriptors for EventView.status (empty for "upcoming" / unknown).
 * @param {string} status
 * @returns {{label: string, modifier: string}[]}
 */
export function statusBadges(status) {
  const modifiers = Object.hasOwn(STATUS_BADGES, status)
    ? STATUS_BADGES[status]
    : [];
  return modifiers.map((modifier) => ({
    label: STATUS_LABELS[modifier],
    modifier,
  }));
}

/**
 * Status to badge an event with: "ended" whenever the event is over (even if the
 * AppView has not marked it yet), otherwise its EventView.status.
 * @param {{status?: string}} event
 * @param {boolean} ended result of filters.isEnded for this event
 * @returns {string|undefined}
 */
export function displayStatus(event, ended) {
  return ended ? EVENT_STATUS.ENDED : event?.status;
}

/**
 * Format a distance for display.
 * @param {number|null|undefined} distanceKm
 * @returns {string|null}
 */
export function formatDistance(distanceKm) {
  if (distanceKm == null) return null;
  return distanceKm < 1
    ? `${Math.round(distanceKm * 1000)} m away`
    : `${distanceKm.toFixed(1)} km away`;
}

/**
 * Full start–end window for the detail page, always including the date and time zone,
 * e.g. "Wednesday, November 11, 2026 · 7:00 PM – 9:00 PM UTC".
 * @param {string} startsAt ISO
 * @param {string} endsAt ISO
 * @param {{locale?: string, timeZone?: string}} [options]
 * @returns {string}
 */
export function formatEventWhen(startsAt, endsAt, { locale, timeZone } = {}) {
  const start = new Date(startsAt);
  const end = new Date(endsAt);
  const dateOptions = {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone,
  };
  const timeOptions = { hour: "numeric", minute: "2-digit", timeZone };
  const date = new Intl.DateTimeFormat(locale, dateOptions);
  const timeFormatter = new Intl.DateTimeFormat(locale, timeOptions);
  const timeWithZone = new Intl.DateTimeFormat(locale, {
    ...timeOptions,
    timeZoneName: "short",
  });
  const sameDay = date.format(start) === date.format(end);
  return sameDay
    ? `${date.format(start)} · ${timeFormatter.format(start)} – ${timeWithZone.format(end)}`
    : `${date.format(start)}, ${timeFormatter.format(start)} – ${date.format(end)}, ${timeWithZone.format(end)}`;
}

/**
 * Bluesky profile URL for a username (handle, preferred) or permanent account id (DID),
 * or null when neither is usable.
 * @param {string} [handle] e.g. "alice.bsky.social"
 * @param {string} [authorDid] e.g. "did:plc:abc"
 * @returns {string|null}
 */
export function blueskyProfileUrl(handle, authorDid) {
  const looksLikeHandle = (value) =>
    typeof value === "string" && /^[a-z0-9.-]+\.[a-z0-9-]+$/i.test(value);
  const actor = looksLikeHandle(handle)
    ? handle
    : authorDid?.startsWith("did:")
      ? authorDid
      : null;
  return actor
    ? `https://bsky.app/profile/${encodeURIComponent(actor).replace(/%3A/gi, ":")}`
    : null;
}
