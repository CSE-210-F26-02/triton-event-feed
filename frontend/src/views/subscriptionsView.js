/**
 * "My subscriptions" page (#19): the signed-in user's subscribed upcoming events, shown in
 * the same pane as the event detail (it replaces the map while open).
 *
 * The subscribed URIs come from the user's PDS (subscriptions.js). Each event is taken
 * from the feed when it is already loaded, otherwise fetched with GET /api/event.
 * STUB(#5): the backend does not serve /api/event yet, so against the real backend only
 * events present in the feed resolve; the rest are listed as unavailable (still with an
 * Unsubscribe button). With ?mock every event resolves.
 *
 * Ended events are left out (the page lists upcoming events). Events that no longer
 * exist or failed to load are listed separately so the user can still unsubscribe.
 * @module views/subscriptionsView
 */
import { h } from "../dom.js";
import { isEnded } from "../filters.js";
import { isPlainObject } from "../lexicon/eventView.js";
import { renderCard } from "./listView.js";
import { renderPrivacyNote } from "./subscribeButton.js";

/** Prefix for card ids on this page (the feed uses the default prefix). */
const CARD_ID_PREFIX = "sub";
/** id of the visible privacy note on this page. */
const PRIVACY_NOTE_ID = "subscriptions-privacy-note";
/** GET /api/event statuses that mean the event no longer exists. */
const GONE_STATUSES = new Set([400, 404]);

export const SUBSCRIPTIONS_TITLE = "My subscriptions";
export const LOGGED_OUT_TEXT =
  "Log in with Bluesky to see the events you've subscribed to.";
export const EMPTY_TEXT =
  "You haven't subscribed to any upcoming events yet. Open an event and press Subscribe.";
export const LOADING_TEXT = "Loading your subscriptions…";
export const UNAVAILABLE_TITLE = "Unavailable events";

/**
 * @typedef {{event: object} | {gone: true} | {failed: true}} LoadedEntry
 * What is known about one subscribed event URI.
 */

/**
 * Pure: split subscribed URIs into upcoming events (soonest first), unavailable URIs
 * (gone or failed), and how many are still loading. Ended events are dropped.
 * @param {Iterable<string>} uris subscribed event URIs
 * @param {Map<string, LoadedEntry>} loaded
 * @param {Date} now
 * @returns {{upcoming: object[], unavailable: string[], loading: number}}
 */
export function partitionSubscriptions(uris, loaded, now) {
  const upcoming = [];
  const unavailable = [];
  let loading = 0;
  for (const uri of uris) {
    const entry = loaded.get(uri);
    if (!entry) loading++;
    else if (entry.event) {
      if (!isEnded(entry.event, now)) upcoming.push(entry.event);
    } else unavailable.push(uri);
  }
  const startOf = (ev) => Date.parse(ev.startsAt) || Number.POSITIVE_INFINITY;
  upcoming.sort((a, b) => startOf(a) - startOf(b));
  return { upcoming, unavailable, loading };
}

/**
 * Load one subscribed event: the feed copy if present, else GET /api/event.
 * @param {string} uri
 * @param {{api: {getEvent(uri: string): Promise<{data: any}>},
 *   findEvent: (uri: string) => object|null}} deps
 * @returns {Promise<LoadedEntry>}
 */
export async function loadSubscribedEvent(uri, { api, findEvent }) {
  const cached = findEvent(uri);
  if (isPlainObject(cached)) return { event: cached };
  try {
    const result = await api.getEvent(uri);
    const data = result?.data;
    if (!isPlainObject(data)) return { gone: true };
    return { event: typeof data.uri === "string" ? data : { ...data, uri } };
  } catch (error) {
    return GONE_STATUSES.has(error?.status) ? { gone: true } : { failed: true };
  }
}

/**
 * One unavailable subscription: a link to the event page plus an Unsubscribe button.
 * @param {string} uri
 * @param {{onOpen: (uri: string) => void, onUnsubscribe: (uri: string) => void}} deps
 * @returns {HTMLElement}
 */
const renderUnavailable = (uri, deps) =>
  h(
    "li",
    { class: "subscriptions__unavailable", dataset: { uri } },
    h(
      "button",
      { type: "button", class: "linklike", onclick: () => deps.onOpen(uri) },
      "An event that couldn't be loaded",
    ),
    h(
      "button",
      {
        type: "button",
        class: "btn",
        dataset: { action: "unsubscribe" },
        onclick: () => deps.onUnsubscribe(uri),
      },
      "Unsubscribe",
    ),
  );

/**
 * The list (or empty / loading state) for a logged-in user.
 * @param {{upcoming: object[], unavailable: string[], loading: number}} parts
 * @param {Set<string>} subscribed
 * @param {object} deps view deps
 * @param {Date} now
 * @returns {(HTMLElement|false)[]}
 */
function renderSubscribedContent(parts, subscribed, deps, now) {
  const { upcoming, unavailable, loading } = parts;
  const cardOpts = {
    subscribed,
    now,
    idPrefix: CARD_ID_PREFIX,
    onOpen: deps.onOpen,
    onToggleSubscribe: deps.onToggleSubscribe,
  };
  const nothing = !upcoming.length && !unavailable.length && !loading;
  return [
    upcoming.length > 0 &&
      h(
        "div",
        { class: "grid subscriptions__list" },
        upcoming.map((ev) => renderCard(ev, cardOpts)),
      ),
    loading > 0 && h("p", { class: "loading", role: "status" }, LOADING_TEXT),
    nothing && h("p", { class: "empty" }, EMPTY_TEXT),
    unavailable.length > 0 &&
      h(
        "section",
        { class: "detail__section", "aria-labelledby": "subs-unavailable" },
        h("h3", { id: "subs-unavailable" }, UNAVAILABLE_TITLE),
        h(
          "ul",
          { class: "subscriptions__unavailable-list" },
          unavailable.map((uri) => renderUnavailable(uri, deps)),
        ),
      ),
  ];
}

/**
 * Render the whole page.
 * @param {{loggedIn: boolean, parts?: object, subscribed?: Set<string>, now: Date}} state
 * @param {object} deps view deps
 * @returns {HTMLElement}
 */
export function renderSubscriptionsPage(state, deps) {
  const body = state.loggedIn
    ? renderSubscribedContent(state.parts, state.subscribed, deps, state.now)
    : [
        h("p", null, LOGGED_OUT_TEXT),
        h(
          "button",
          {
            type: "button",
            class: "btn btn--gold",
            dataset: { action: "login" },
            onclick: () => deps.onLogin(),
          },
          "Log in",
        ),
      ];
  return h(
    "article",
    { class: "detail subscriptions", "aria-labelledby": "subscriptions-title" },
    h(
      "div",
      { class: "detail__toolbar" },
      h(
        "button",
        { type: "button", class: "btn", onclick: () => deps.onClose() },
        "← Back to map",
      ),
    ),
    h(
      "h2",
      { id: "subscriptions-title", class: "detail__title", tabindex: "-1" },
      SUBSCRIPTIONS_TITLE,
    ),
    renderPrivacyNote(PRIVACY_NOTE_ID),
    body,
  );
}

/**
 * Fetch the subscribed events that are neither loaded nor already in flight, marking
 * them in flight meanwhile so overlapping refreshes don't fetch them twice.
 * @param {Iterable<string>} subscribed
 * @param {Map<string, LoadedEntry>} loaded
 * @param {Set<string>} inFlight mutated while fetching
 * @param {Parameters<typeof loadSubscribedEvent>[1]} loadDeps
 * @returns {Promise<Map<string, LoadedEntry>>} what was fetched (empty if nothing was)
 */
async function fetchMissing(subscribed, loaded, inFlight, loadDeps) {
  const missing = [...subscribed].filter(
    (uri) => !loaded.has(uri) && !inFlight.has(uri),
  );
  missing.forEach((uri) => inFlight.add(uri));
  const entries = await Promise.all(
    missing.map((uri) => loadSubscribedEvent(uri, loadDeps)),
  );
  missing.forEach((uri) => inFlight.delete(uri));
  return new Map(missing.map((uri, i) => [uri, entries[i]]));
}

/**
 * Render the page into `root` from current state, keeping focus on the title if it had it.
 * @param {HTMLElement} root
 * @param {SubscriptionsViewDeps} deps
 * @param {Map<string, LoadedEntry>} loaded
 * @param {Date} now
 */
function paintPage(root, deps, loaded, now) {
  const hadFocus = document.activeElement?.id === "subscriptions-title";
  const subscribed = deps.getSubscribed();
  const page = renderSubscriptionsPage(
    {
      loggedIn: deps.isLoggedIn(),
      parts: partitionSubscriptions(subscribed, loaded, now),
      subscribed,
      now,
    },
    deps,
  );
  root.replaceChildren(page);
  if (hadFocus) page.querySelector("#subscriptions-title")?.focus();
}

/**
 * @typedef {object} SubscriptionsViewDeps
 * @property {{getEvent(uri: string): Promise<{data: any}>}} api
 * @property {() => Set<string>} getSubscribed subscribed event URIs
 * @property {() => boolean} isLoggedIn
 * @property {(uri: string) => object|null} [findEvent] feed copy of an event
 * @property {() => void} onLogin
 * @property {() => void} onClose
 * @property {(uri: string) => void} onOpen open an event's detail page
 * @property {(event: object) => void} onToggleSubscribe
 * @property {(uri: string) => void} onUnsubscribe for events that couldn't be loaded
 * @property {() => Date} [now]
 */

/**
 * Create the My subscriptions controller.
 * @param {HTMLElement} root
 * @param {SubscriptionsViewDeps} deps
 * @returns {{open(): Promise<void>, refresh(): Promise<void>, close(): void,
 *   readonly isOpen: boolean}}
 */
export function createSubscriptionsView(root, deps) {
  const { findEvent = () => null, now = () => new Date() } = deps;
  const loaded = new Map(); // uri → LoadedEntry, kept while the page is open
  let isOpen = false;
  let generation = 0; // bumped on open/close so stale loads are discarded
  let inFlight = new Set(); // URIs being fetched in the current generation

  const paint = () => paintPage(root, deps, loaded, now());

  /**
   * Re-render now, then fetch subscribed events that are neither loaded nor already
   * being fetched, and render again once they arrive.
   */
  async function refresh() {
    if (!isOpen) return;
    paint();
    if (!deps.isLoggedIn()) return;
    const mine = generation;
    const fetched = await fetchMissing(deps.getSubscribed(), loaded, inFlight, {
      api: deps.api,
      findEvent,
    });
    if (!fetched.size || mine !== generation || !isOpen) return;
    fetched.forEach((entry, uri) => loaded.set(uri, entry));
    paint();
  }

  /** Start a new generation: forget loaded events and in-flight fetches. */
  function reset() {
    generation++;
    inFlight = new Set();
    loaded.clear();
  }

  return {
    /** Show the page with fresh data and focus its title. */
    async open() {
      isOpen = true;
      reset();
      const pending = refresh();
      root.querySelector("#subscriptions-title")?.focus();
      await pending;
    },
    refresh,
    /** Clear the pane and drop loaded events. */
    close() {
      isOpen = false;
      reset();
      root.replaceChildren();
    },
    get isOpen() {
      return isOpen;
    },
  };
}
