/**
 * Pure functions over filter state and event lists.
 * @module filters
 */

/**
 * @typedef {{tags: string[], group: string, searchText: string, nearMe: boolean}} FilterState
 */

/** @type {FilterState} */
export const EMPTY_FILTERS = Object.freeze({
  tags: [],
  group: "",
  searchText: "",
  nearMe: false,
});

/**
 * Build GET /api/events params from filter state. `nearMe` is never sent (privacy).
 * @param {FilterState} filters
 * @param {{cursor?: string|null, limit?: number}} [page]
 * @returns {Record<string, any>}
 */
export function buildEventQuery(filters, { cursor = null, limit = 20 } = {}) {
  const params = { limit };
  if (filters.tags?.length) params.tag = [...filters.tags];
  if (filters.group) params.group = filters.group;
  const searchText = (filters.searchText || "").trim();
  // "q" is the AppView's name for the search query parameter (GET /api/events?q=).
  if (searchText) params.q = searchText;
  if (cursor) params.cursor = cursor;
  return params;
}

/**
 * Toggle a tag in a tag list (returns a new array).
 * @param {string[]} tags
 * @param {string} tag
 * @returns {string[]}
 */
export function toggleTag(tags, tag) {
  return tags.includes(tag)
    ? tags.filter((existingTag) => existingTag !== tag)
    : [...tags, tag];
}

/**
 * Parse an event's string lat/lng into numbers, or null if absent/invalid.
 * @param {{location?: {lat?: string, lng?: string}}} event
 * @returns {{lat: number, lng: number}|null}
 */
export function coordsOf(event) {
  const eventLocation = event?.location;
  if (
    !eventLocation ||
    eventLocation.lat == null ||
    eventLocation.lng == null ||
    eventLocation.lat === "" ||
    eventLocation.lng === ""
  )
    return null;
  const lat = Number(eventLocation.lat);
  const lng = Number(eventLocation.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

/**
 * Great-circle distance in km (haversine).
 * @param {{lat: number, lng: number}} pointA
 * @param {{lat: number, lng: number}} pointB
 * @returns {number}
 */
export function haversineKm(pointA, pointB) {
  const earthRadiusKm = 6371;
  const toRadians = (degrees) => (degrees * Math.PI) / 180;
  const latitudeDelta = toRadians(pointB.lat - pointA.lat);
  const longitudeDelta = toRadians(pointB.lng - pointA.lng);
  const haversineTerm =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(toRadians(pointA.lat)) *
      Math.cos(toRadians(pointB.lat)) *
      Math.sin(longitudeDelta / 2) ** 2;
  return 2 * earthRadiusKm * Math.asin(Math.min(1, Math.sqrt(haversineTerm)));
}

/**
 * Sort events nearest-first from `origin`; events without coordinates go last (stable).
 * Returns copies annotated with `distanceKm` (null when unknown).
 * @param {object[]} events
 * @param {{lat: number, lng: number}} origin
 * @returns {object[]}
 */
export function sortByDistance(events, origin) {
  return events
    .map((event, originalIndex) => {
      const coordinates = coordsOf(event);
      const distanceKm = coordinates ? haversineKm(origin, coordinates) : null;
      return { event: { ...event, distanceKm }, originalIndex };
    })
    .sort((first, second) => {
      const firstDistance = first.event.distanceKm ?? Infinity;
      const secondDistance = second.event.distanceKm ?? Infinity;
      // Equal distances (including "unknown") keep their original order.
      return firstDistance === secondDistance
        ? first.originalIndex - second.originalIndex
        : firstDistance - secondDistance;
    })
    .map((entry) => entry.event);
}

/**
 * Local-date key "YYYY-MM-DD".
 * @param {Date} date
 * @returns {string}
 */
export function dayKey(date) {
  const padToTwoDigits = (number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${padToTwoDigits(date.getMonth() + 1)}-${padToTwoDigits(date.getDate())}`;
}

/** Match any event overlapping a selected local calendar day (end is exclusive). */
export function filterEventsByDate(events, selection) {
  if (!selection) return events;
  const interval = (start, end = start) => {
    const from = new Date(`${start}T00:00:00`);
    const until = new Date(`${end}T00:00:00`);
    until.setDate(until.getDate() + 1);
    return [from.getTime(), until.getTime()];
  };
  const windows =
    selection.mode === "range"
      ? [interval(selection.start, selection.end)]
      : selection.dates.map((day) => interval(day));
  return events.filter((event) => {
    const start = new Date(event.startsAt).getTime();
    const end = event.endsAt ? new Date(event.endsAt).getTime() : start;
    return windows.some(
      ([from, until]) =>
        start < until && (end > from || (start === end && start >= from)),
    );
  });
}

/**
 * Human label for a day relative to `now`: Today, Tomorrow, weekday (within a week), or date.
 * @param {Date} day
 * @param {Date} now
 * @param {string} [locale]
 * @returns {string}
 */
export function dayLabel(day, now, locale) {
  const startOf = (date) =>
    new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const dayDifference = Math.round((startOf(day) - startOf(now)) / 86400000);
  if (dayDifference <= 0) return "Today";
  if (dayDifference === 1) return "Tomorrow";
  if (dayDifference < 7)
    return new Intl.DateTimeFormat(locale, { weekday: "long" }).format(day);
  return new Intl.DateTimeFormat(locale, {
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(day);
}

/**
 * Group events by local day. Events already in progress are grouped under today.
 * Groups are chronological; order within a group is preserved (e.g. distance order).
 * @param {object[]} events
 * @param {{now?: Date, locale?: string}} [options]
 * @returns {{key: string, label: string, events: object[]}[]}
 */
export function groupByDay(events, { now = new Date(), locale } = {}) {
  const groups = new Map();
  for (const event of events) {
    const start = new Date(event.startsAt);
    const day = start < now ? now : start;
    const key = dayKey(day);
    if (!groups.has(key))
      groups.set(key, { key, label: dayLabel(day, now, locale), events: [] });
    groups.get(key).events.push(event);
  }
  return [...groups.values()].sort((firstGroup, secondGroup) =>
    firstGroup.key < secondGroup.key
      ? -1
      : firstGroup.key > secondGroup.key
        ? 1
        : 0,
  );
}

/**
 * True when the event was edited after it was first indexed.
 * @param {{updatedAt?: string, indexedAt?: string}} event
 * @returns {boolean}
 */
export function isUpdated(event) {
  if (!event?.updatedAt || !event?.indexedAt) return false;
  return new Date(event.updatedAt) > new Date(event.indexedAt);
}

/**
 * True when the event is over: the backend marked it "ended" (#10), or its end time passed.
 * STUB(#10): until the backend expires events, the client-side end-time check does the work.
 * @param {{status?: string, endsAt?: string}} event
 * @param {Date} [now]
 * @returns {boolean}
 */
export function isEnded(event, now = new Date()) {
  if (event?.status === "ended") return true;
  const endTime = Date.parse(event?.endsAt);
  return Number.isFinite(endTime) && endTime <= now.getTime();
}
