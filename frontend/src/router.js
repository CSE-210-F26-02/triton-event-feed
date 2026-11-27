/**
 * Hash-based routing so every event has a shareable URL that works on static hosting
 * (no server rewrites needed). Event routes look like `#/event/<did>/<rkey>`; the
 * collection is always EVENT_NSID, so the AT URI can be rebuilt from the hash alone.
 * `#/subscriptions` is the signed-in user's "My subscriptions" page (#19).
 * Hashes that are not routes (e.g. the "#main" skip link) are ignored.
 * @module router
 */
import { EVENT_NSID, parseAtUri } from "./records.js";

/** Prefix shared by all event routes. */
export const EVENT_ROUTE_PREFIX = "#/event/";

/** Hash of the "My subscriptions" page (#19). */
export const SUBSCRIPTIONS_ROUTE = "#/subscriptions";

/**
 * @typedef {{view: "list"} | {view: "event", uri: string|null} |
 *   {view: "subscriptions"}} Route
 * `uri: null` means the hash looked like an event route but could not be parsed.
 */

/**
 * Encode one path segment, keeping ":" readable (DIDs are full of them).
 * @param {string} segment
 * @returns {string}
 */
const encodeSegment = (segment) =>
  encodeURIComponent(segment).replace(/%3A/gi, ":");

/**
 * Decode one path segment, or null when it is malformed (e.g. a stray "%").
 * @param {string} segment
 * @returns {string|null}
 */
function decodeSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/**
 * Build the hash for an event's detail page.
 * @param {string} eventUri at:// URI of an EVENT_NSID record
 * @returns {string|null} e.g. "#/event/did:plc:abc/3kabc", or null for non-event URIs
 */
export function eventHash(eventUri) {
  const parsed = parseAtUri(eventUri);
  if (!parsed || parsed.collection !== EVENT_NSID) return null;
  return `${EVENT_ROUTE_PREFIX}${encodeSegment(parsed.did)}/${encodeSegment(parsed.rkey)}`;
}

/**
 * Parse a location hash into a route.
 * @param {string} hash e.g. window.location.hash
 * @returns {Route|null} null when the hash is not a route and should be ignored
 */
export function parseHash(hash = "") {
  if (hash === "" || hash === "#" || hash === "#/") return { view: "list" };
  if (hash === SUBSCRIPTIONS_ROUTE) return { view: "subscriptions" };
  if (!hash.startsWith(EVENT_ROUTE_PREFIX)) return null;
  const segments = hash.slice(EVENT_ROUTE_PREFIX.length).split("/");
  if (segments.length !== 2) return { view: "event", uri: null };
  const [did, rkey] = segments.map(decodeSegment);
  const looksValid = did?.startsWith("did:") && rkey && !/[/?#\s]/.test(rkey);
  if (!looksValid) return { view: "event", uri: null };
  return { view: "event", uri: `at://${did}/${EVENT_NSID}/${rkey}` };
}

/**
 * Absolute, shareable URL for an event (for "Copy link").
 * @param {string} eventUri
 * @param {{origin: string, pathname: string, search: string}} [location]
 * @returns {string|null}
 */
export function shareUrl(eventUri, location = globalThis.location) {
  const hash = eventHash(eventUri);
  if (!hash) return null;
  const { origin, pathname, search } = location;
  return `${origin}${pathname}${search}${hash}`;
}

/**
 * Create the router. Calls `onChange(route)` on start and on every route change.
 * @param {{onChange: (route: Route) => void, win?: Window}} deps
 * @returns {{start(): void, openEvent(uri: string): void, openSubscriptions(): void,
 *   home(): void, current(): Route}}
 */
export function createRouter({ onChange, win = globalThis.window }) {
  let route = { view: "list" };

  /** Re-read the hash; non-route hashes keep the current route. */
  const sync = () => {
    const next = parseHash(win.location.hash);
    if (!next) return;
    route = next;
    onChange(route);
  };

  return {
    start() {
      win.addEventListener("hashchange", sync);
      sync();
    },
    /** Navigate to an event (a no-op for URIs that are not events). */
    openEvent(uri) {
      const hash = eventHash(uri);
      if (hash && win.location.hash !== hash) win.location.hash = hash;
      else if (hash) sync();
    },
    /** Navigate to "My subscriptions" (re-syncs when already there). */
    openSubscriptions() {
      if (win.location.hash !== SUBSCRIPTIONS_ROUTE)
        win.location.hash = SUBSCRIPTIONS_ROUTE;
      else sync();
    },
    /** Navigate back to the list/map, leaving a clean URL (no trailing "#"). */
    home() {
      const { pathname, search } = win.location;
      win.history.pushState(null, "", `${pathname}${search}`);
      sync();
    },
    current: () => route,
  };
}
