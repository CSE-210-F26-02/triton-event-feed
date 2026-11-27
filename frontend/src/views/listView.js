/**
 * Primary (accessible) list view: event cards grouped by day, with "Load more"
 * + IntersectionObserver infinite scroll, and empty / loading / offline states.
 * @module views/listView
 */
import { h } from "../dom.js";
import { groupByDay, isEnded, isUpdated } from "../filters.js";
import { describeGroup } from "../lexicon/eventView.js";
import { renderSubscribeButton } from "./subscribeButton.js";
import {
  formatDistance,
  formatTimeWindow,
  osmUrl,
  statusLabel,
} from "../format.js";

/**
 * @typedef {{onOpen?: (uri: string) => void, onTagClick?: (tag: string) => void,
 *   onToggleSubscribe?: (ev: object) => void, activeTags?: string[],
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
  h(
    "p",
    {
      class: "card__group",
      dataset: group.uri ? { groupUri: group.uri } : null,
    },
    group.label,
  );

/**
 * Render one event card.
 * @param {object} ev EventView
 * @param {CardOpts} [opts]
 * @returns {HTMLElement}
 */
export function renderCard(ev, opts = {}) {
  const {
    onOpen,
    onTagClick,
    onToggleSubscribe,
    activeTags = [],
    subscribed = new Set(),
    idPrefix = CARD_ID_PREFIX,
  } = opts;
  const titleId = `${idPrefix}-${hashId(ev.uri)}`;
  const status = statusLabel(ev.status);
  const href = osmUrl(ev);
  const isSub = subscribed.has(ev.uri);
  const distance = formatDistance(ev.distanceKm);
  const group = describeGroup(ev.group); // lexicon strongRef or legacy string

  return h(
    "article",
    { class: "card", "aria-labelledby": titleId, dataset: { uri: ev.uri } },
    h(
      "div",
      { class: "card__badges" },
      status && h("span", { class: `badge badge--${ev.status}` }, status),
      isUpdated(ev) && h("span", { class: "badge badge--updated" }, "Updated"),
    ),
    h(
      "h3",
      { class: "card__title", id: titleId },
      h(
        "button",
        {
          type: "button",
          class: "linklike",
          dataset: { focusKey: `open:${ev.uri}` },
          onclick: () => onOpen?.(ev.uri),
        },
        ev.name,
      ),
    ),
    h(
      "p",
      { class: "card__time" },
      h(
        "time",
        { datetime: ev.startsAt },
        formatTimeWindow(ev.startsAt, ev.endsAt, opts),
      ),
    ),
    h(
      "p",
      { class: "card__loc" },
      href
        ? h(
            "a",
            { href, target: "_blank", rel: "noopener noreferrer" },
            ev.location?.name || "Map",
          )
        : ev.location?.name,
      distance && h("span", { class: "card__dist" }, ` · ${distance}`),
    ),
    group && renderCardGroup(group),
    ev.tags?.length &&
      h(
        "ul",
        { class: "chips", "aria-label": "Tags" },
        ev.tags.map((t) =>
          h(
            "li",
            null,
            h(
              "button",
              {
                type: "button",
                class: "chip",
                "aria-pressed": String(activeTags.includes(t)),
                "aria-label": `Filter by tag ${t}`,
                dataset: { focusKey: `tag:${ev.uri}:${t}` },
                onclick: () => onTagClick?.(t),
              },
              `#${t}`,
            ),
          ),
        ),
      ),
    h(
      "div",
      { class: "card__actions" },
      renderSubscribeButton(ev, {
        subscribed: isSub,
        ended: isEnded(ev, opts.now),
        variant: "plain",
        dataset: { focusKey: `sub:${ev.uri}` },
        onToggle: onToggleSubscribe,
      }),
    ),
  );
}

function hashId(s) {
  let x = 0;
  for (let i = 0; i < s.length; i++) x = (x * 31 + s.charCodeAt(i)) | 0;
  return (x >>> 0).toString(36);
}

/**
 * @typedef {{events: object[], hasMore?: boolean, loading?: boolean, stale?: boolean,
 *   savedAt?: number, error?: string|null, now?: Date} & CardOpts} ListState
 */

/**
 * Create the list view.
 * @param {HTMLElement} root
 * @param {{onLoadMore?: () => void, IntersectionObserverImpl?: typeof IntersectionObserver|null}} [opts]
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
        (entries) => entries.some((e) => e.isIntersecting) && more(),
        { rootMargin: "400px" },
      )
    : null;

  function render(state) {
    loading = Boolean(state.loading);
    hasMore = Boolean(state.hasMore);
    const focusKey = document.activeElement?.dataset?.focusKey;
    observer?.disconnect();
    root.setAttribute("aria-busy", String(loading));
    root.replaceChildren(...content(state));
    if (focusKey)
      [...root.querySelectorAll("[data-focus-key]")]
        .find((el) => el.dataset.focusKey === focusKey)
        ?.focus();
    const sentinel = root.querySelector(".load-more");
    if (sentinel && observer) observer.observe(sentinel);
  }

  function content(state) {
    const nodes = [];
    if (state.stale) nodes.push(staleBanner(state.savedAt));
    if (state.error)
      nodes.push(
        h("p", { class: "notice notice--error", role: "alert" }, state.error),
      );
    const groups = groupByDay(state.events || [], {
      now: state.now,
      locale: state.locale,
    });
    if (!groups.length && !state.loading && !state.error) {
      nodes.push(
        h(
          "p",
          { class: "empty" },
          "No events match your filters. Try clearing a tag or search.",
        ),
      );
    }
    for (const g of groups) {
      const id = `day-${g.key}`;
      nodes.push(
        h(
          "section",
          { class: "day", "aria-labelledby": id },
          h("h2", { class: "day__title", id }, g.label),
          h(
            "div",
            { class: "grid" },
            g.events.map((ev) => renderCard(ev, state)),
          ),
        ),
      );
    }
    if (state.loading)
      nodes.push(
        h("p", { class: "loading", role: "status" }, "Loading events…"),
      );
    if (state.hasMore) {
      nodes.push(
        h(
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
    return h(
      "p",
      { class: "notice notice--stale", role: "status" },
      `You're offline or the connection is poor — showing saved events${when}.`,
    );
  }

  return { render, destroy: () => observer?.disconnect() };
}
