/**
 * Primary (accessible) list view: event cards grouped by day, with "Load more"
 * + IntersectionObserver infinite scroll, and empty / loading / offline states.
 * @module views/listView
 */
import { createElementTree } from "../dom.js";
import {
  SORT_ORDERS,
  groupByDay,
  isEnded,
  isUpdated,
  normalizeSortOrder,
} from "../filters.js";
import { describeGroup } from "../lexicon/eventView.js";
import { renderStatusBadges } from "./statusBadges.js";
import { renderSubscribeButton } from "./subscribeButton.js";
import {
  displayStatus,
  formatDistance,
  formatTimeWindow,
  osmUrl,
} from "../format.js";

/** Heading (and its element id) of the single section used by the "newest" order. */
export const NEWEST_SECTION_TITLE = "Newest";
const NEWEST_SECTION_ID = "sort-newest";

/** Shown when there are no events to list. */
export const EMPTY_LIST_MESSAGE =
  "No events match your filters. Try clearing a tag or search.";

/**
 * @typedef {{onOpen?: (uri: string) => void, onTagClick?: (tag: string) => void,
 *   onToggleSubscribe?: (event: object) => void, activeTags?: string[],
 *   subscribed?: Set<string>, locale?: string, timeZone?: string, now?: Date,
 *   idPrefix?: string}} CardOpts
 * `idPrefix` keeps element ids unique when the same event is shown in two places at once
 * (e.g. the feed and My subscriptions); it defaults to CARD_ID_PREFIX.
 */

/** Default prefix of card title ids. */
export const CARD_ID_PREFIX = "ev";

/**
 * Group line on a card. Lexicon strongRef groups keep their record URI on the element
 * (data-group-uri) so #17 can replace the placeholder label with the group's name.
 * @param {import('../lexicon/eventView.js').DisplayGroup} group
 * @returns {HTMLElement}
 */
const renderCardGroup = (group) =>
  createElementTree(
    "p",
    {
      class: "card__group",
      dataset: group.uri ? { groupUri: group.uri } : null,
    },
    group.label,
  );

/**
 * Render one event card.
 * @param {object} event EventView
 * @param {CardOpts} [options]
 * @returns {HTMLElement}
 */
export function renderCard(event, options = {}) {
  const {
    onOpen,
    onTagClick,
    onToggleSubscribe,
    activeTags = [],
    subscribed = new Set(),
    idPrefix = CARD_ID_PREFIX,
  } = options;
  const titleId = `${idPrefix}-${hashId(event.uri)}`;
  const ended = isEnded(event, options.now);
  const href = osmUrl(event);
  const isSub = subscribed.has(event.uri);
  const distance = formatDistance(event.distanceKm);
  const group = describeGroup(event.group); // lexicon strongRef or legacy string

  return createElementTree(
    "article",
    { class: "card", "aria-labelledby": titleId, dataset: { uri: event.uri } },
    createElementTree(
      "div",
      { class: "card__badges" },
      ...renderStatusBadges(displayStatus(event, ended)),
      isUpdated(event) &&
        createElementTree("span", { class: "badge badge--updated" }, "Updated"),
    ),
    createElementTree(
      "h3",
      { class: "card__title", id: titleId },
      createElementTree(
        "button",
        {
          type: "button",
          class: "linklike",
          dataset: { focusKey: `open:${event.uri}` },
          onclick: () => onOpen?.(event.uri),
        },
        event.name,
      ),
    ),
    createElementTree(
      "p",
      { class: "card__time" },
      createElementTree(
        "time",
        { datetime: event.startsAt },
        formatTimeWindow(event.startsAt, event.endsAt, options),
      ),
    ),
    createElementTree(
      "p",
      { class: "card__loc" },
      href
        ? createElementTree(
            "a",
            { href, target: "_blank", rel: "noopener noreferrer" },
            event.location?.name || "Map",
          )
        : event.location?.name,
      distance &&
        createElementTree("span", { class: "card__dist" }, ` · ${distance}`),
    ),
    group && renderCardGroup(group),
    event.tags?.length &&
      createElementTree(
        "ul",
        { class: "chips", "aria-label": "Tags" },
        event.tags.map((tag) =>
          createElementTree(
            "li",
            null,
            createElementTree(
              "button",
              {
                type: "button",
                class: "chip",
                "aria-pressed": String(activeTags.includes(tag)),
                "aria-label": `Filter by tag ${tag}`,
                dataset: { focusKey: `tag:${event.uri}:${tag}` },
                onclick: () => onTagClick?.(tag),
              },
              `#${tag}`,
            ),
          ),
        ),
      ),
    createElementTree(
      "div",
      { class: "card__actions" },
      renderSubscribeButton(event, {
        subscribed: isSub,
        ended,
        variant: "plain",
        dataset: { focusKey: `sub:${event.uri}` },
        onToggle: onToggleSubscribe,
      }),
    ),
  );
}

/**
 * One titled section of event cards.
 * @param {string} sectionId id of the section heading
 * @param {string} title heading text
 * @param {object[]} events EventViews
 * @param {CardOpts} options
 * @returns {HTMLElement}
 */
function renderEventSection(sectionId, title, events, options) {
  return createElementTree(
    "section",
    { class: "day", "aria-labelledby": sectionId },
    createElementTree("h2", { class: "day__title", id: sectionId }, title),
    createElementTree(
      "div",
      { class: "grid" },
      events.map((event) => renderCard(event, options)),
    ),
  );
}

/**
 * Sections for the list. "newest" keeps the AppView's order in a single section (day
 * headings would repeat out of order); every other order groups cards by day.
 * @param {object[]} events EventViews, in the order to show them
 * @param {ListState} state
 * @returns {HTMLElement[]}
 */
export function renderEventSections(events, state) {
  if (normalizeSortOrder(state.sort) === SORT_ORDERS.NEWEST) {
    return [
      renderEventSection(
        NEWEST_SECTION_ID,
        NEWEST_SECTION_TITLE,
        events,
        state,
      ),
    ];
  }
  return groupByDay(events, { now: state.now, locale: state.locale }).map(
    (dayGroup) =>
      renderEventSection(
        `day-${dayGroup.key}`,
        dayGroup.label,
        dayGroup.events,
        state,
      ),
  );
}

function hashId(text) {
  let hash = 0;
  for (let index = 0; index < text.length; index++)
    hash = (hash * 31 + text.charCodeAt(index)) | 0;
  return (hash >>> 0).toString(36);
}

/**
 * @typedef {{events: object[], hasMore?: boolean, loading?: boolean, stale?: boolean,
 *   savedAt?: number, error?: string|null, now?: Date, sort?: string} & CardOpts} ListState
 * `sort` is a filters.SORT_ORDERS value (missing / unknown means the default order).
 */

/**
 * Create the list view.
 * @param {HTMLElement} root
 * @param {{onLoadMore?: () => void, IntersectionObserverImpl?: typeof IntersectionObserver|null}} [options]
 * @returns {{render(state: ListState): void, destroy(): void}}
 */
export function createListView(
  root,
  {
    onLoadMore,
    IntersectionObserverImpl = globalThis.IntersectionObserver ?? null,
  } = {},
) {
  let loading = false;
  let hasMore = false;
  const more = () => {
    if (!loading && hasMore) onLoadMore?.();
  };
  const observer = IntersectionObserverImpl
    ? new IntersectionObserverImpl(
        (entries) => entries.some((entry) => entry.isIntersecting) && more(),
        { rootMargin: "400px" },
      )
    : null;

  function render(state) {
    loading = Boolean(state.loading);
    hasMore = Boolean(state.hasMore);
    const focusKey = document.activeElement?.dataset?.focusKey;
    observer?.disconnect();
    root.setAttribute("aria-busy", String(loading));
    root.replaceChildren(...listContent(state));
    if (focusKey)
      [...root.querySelectorAll("[data-focus-key]")]
        .find((focusable) => focusable.dataset.focusKey === focusKey)
        ?.focus();
    const sentinel = root.querySelector(".load-more");
    if (sentinel && observer) observer.observe(sentinel);
  }

  function listContent(state) {
    const nodes = [];
    if (state.stale) nodes.push(staleBanner(state.savedAt));
    if (state.error)
      nodes.push(
        createElementTree(
          "p",
          { class: "notice notice--error", role: "alert" },
          state.error,
        ),
      );
    const events = state.events || [];
    if (!events.length && !state.loading && !state.error) {
      nodes.push(
        createElementTree("p", { class: "empty" }, EMPTY_LIST_MESSAGE),
      );
    }
    if (events.length) nodes.push(...renderEventSections(events, state));
    if (state.loading)
      nodes.push(
        createElementTree(
          "p",
          { class: "loading", role: "status" },
          "Loading events…",
        ),
      );
    if (state.hasMore) {
      nodes.push(
        createElementTree(
          "button",
          {
            type: "button",
            class: "btn load-more",
            disabled: loading,
            dataset: { focusKey: "load-more" },
            onclick: more,
          },
          loading ? "Loading…" : "Load more",
        ),
      );
    }
    return nodes;
  }

  function staleBanner(savedAt) {
    const when = savedAt
      ? ` from ${new Date(savedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
      : "";
    return createElementTree(
      "p",
      { class: "notice notice--stale", role: "status" },
      `You're offline or the connection is poor — showing saved events${when}.`,
    );
  }

  return { render, destroy: () => observer?.disconnect() };
}
