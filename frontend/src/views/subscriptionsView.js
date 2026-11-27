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
import { createElementTree } from "../dom.js";
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
  const startOf = (event) =>
    Date.parse(event.startsAt) || Number.POSITIVE_INFINITY;
  upcoming.sort(
    (firstEvent, secondEvent) => startOf(firstEvent) - startOf(secondEvent),
  );
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
    const fetchedEvent = result?.data;
    if (!isPlainObject(fetchedEvent)) return { gone: true };
    return {
      event:
        typeof fetchedEvent.uri === "string"
          ? fetchedEvent
          : { ...fetchedEvent, uri },
    };
  } catch (error) {
    return GONE_STATUSES.has(error?.status) ? { gone: true } : { failed: true };
  }
}

/**
 * One unavailable subscription: a link to the event page plus an Unsubscribe button.
 * @param {string} uri
 * @param {{onOpen: (uri: string) => void, onUnsubscribe: (uri: string) => void}} dependencies
 * @returns {HTMLElement}
 */
const renderUnavailable = (uri, dependencies) =>
  createElementTree(
    "li",
    { class: "subscriptions__unavailable", dataset: { uri } },
    createElementTree(
      "button",
      {
        type: "button",
        class: "linklike",
        onclick: () => dependencies.onOpen(uri),
      },
      "An event that couldn't be loaded",
    ),
    createElementTree(
      "button",
      {
        type: "button",
        class: "btn",
        dataset: { action: "unsubscribe" },
        onclick: () => dependencies.onUnsubscribe(uri),
      },
      "Unsubscribe",
    ),
  );

/**
 * The list (or empty / loading state) for a logged-in user.
 * @param {{upcoming: object[], unavailable: string[], loading: number}} partition
 * @param {Set<string>} subscribed
 * @param {object} dependencies view deps
 * @param {Date} now
 * @returns {(HTMLElement|false)[]}
 */
function renderSubscribedContent(partition, subscribed, dependencies, now) {
  const { upcoming, unavailable, loading } = partition;
  const cardOpts = {
    subscribed,
    now,
    idPrefix: CARD_ID_PREFIX,
    onOpen: dependencies.onOpen,
    onToggleSubscribe: dependencies.onToggleSubscribe,
  };
  const nothing = !upcoming.length && !unavailable.length && !loading;
  return [
    upcoming.length > 0 &&
      createElementTree(
        "div",
        { class: "grid subscriptions__list" },
        upcoming.map((event) => renderCard(event, cardOpts)),
      ),
    loading > 0 &&
      createElementTree(
        "p",
        { class: "loading", role: "status" },
        LOADING_TEXT,
      ),
    nothing && createElementTree("p", { class: "empty" }, EMPTY_TEXT),
    unavailable.length > 0 &&
      createElementTree(
        "section",
        { class: "detail__section", "aria-labelledby": "subs-unavailable" },
        createElementTree("h3", { id: "subs-unavailable" }, UNAVAILABLE_TITLE),
        createElementTree(
          "ul",
          { class: "subscriptions__unavailable-list" },
          unavailable.map((uri) => renderUnavailable(uri, dependencies)),
        ),
      ),
  ];
}

/**
 * Render the whole page.
 * @param {{loggedIn: boolean, parts?: object, subscribed?: Set<string>, now: Date}} state
 * @param {object} dependencies view deps
 * @returns {HTMLElement}
 */
export function renderSubscriptionsPage(state, dependencies) {
  const body = state.loggedIn
    ? renderSubscribedContent(
        state.parts,
        state.subscribed,
        dependencies,
        state.now,
      )
    : [
        createElementTree("p", null, LOGGED_OUT_TEXT),
        createElementTree(
          "button",
          {
            type: "button",
            class: "btn btn--gold",
            dataset: { action: "login" },
            onclick: () => dependencies.onLogin(),
          },
          "Log in",
        ),
      ];
  return createElementTree(
    "article",
    { class: "detail subscriptions", "aria-labelledby": "subscriptions-title" },
    createElementTree(
      "div",
      { class: "detail__toolbar" },
      createElementTree(
        "button",
        { type: "button", class: "btn", onclick: () => dependencies.onClose() },
        "← Back to map",
      ),
    ),
    createElementTree(
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
  const loadedEntries = await Promise.all(
    missing.map((uri) => loadSubscribedEvent(uri, loadDeps)),
  );
  missing.forEach((uri) => inFlight.delete(uri));
  return new Map(missing.map((uri, index) => [uri, loadedEntries[index]]));
}

/**
 * Render the page into `root` from current state, keeping focus on the title if it had it.
 * @param {HTMLElement} root
 * @param {SubscriptionsViewDeps} dependencies
 * @param {Map<string, LoadedEntry>} loaded
 * @param {Date} now
 */
function paintPage(root, dependencies, loaded, now) {
  const hadFocus = document.activeElement?.id === "subscriptions-title";
  const subscribed = dependencies.getSubscribed();
  const page = renderSubscriptionsPage(
    {
      loggedIn: dependencies.isLoggedIn(),
      parts: partitionSubscriptions(subscribed, loaded, now),
      subscribed,
      now,
    },
    dependencies,
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
 * @param {SubscriptionsViewDeps} dependencies
 * @returns {{open(): Promise<void>, refresh(): Promise<void>, close(): void,
 *   readonly isOpen: boolean}}
 */
export function createSubscriptionsView(root, dependencies) {
  const { findEvent = () => null, now = () => new Date() } = dependencies;
  const loaded = new Map(); // uri → LoadedEntry, kept while the page is open
  let isOpen = false;
  let generation = 0; // bumped on open/close so stale loads are discarded
  let inFlight = new Set(); // URIs being fetched in the current generation

  const paint = () => paintPage(root, dependencies, loaded, now());

  /**
   * Re-render now, then fetch subscribed events that are neither loaded nor already
   * being fetched, and render again once they arrive.
   */
  async function refresh() {
    if (!isOpen) return;
    paint();
    if (!dependencies.isLoggedIn()) return;
    const thisGeneration = generation;
    const fetched = await fetchMissing(
      dependencies.getSubscribed(),
      loaded,
      inFlight,
      {
        api: dependencies.api,
        findEvent,
      },
    );
    if (!fetched.size || thisGeneration !== generation || !isOpen) return;
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
