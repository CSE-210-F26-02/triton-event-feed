/**
 * Event detail pane: replaces the big map while an event is open (#14). Shows everything
 * about one event (when, where, what, who) plus a small pin map and the action slots for
 * Subscribe (#20), host Edit/Delete (#9), Get directions (#22) and Add to calendar (#23).
 * @module views/detailView
 */
import { h, safeHttpUrl } from "../dom.js";
import { isEnded, isUpdated } from "../filters.js";
import {
  blueskyProfileUrl,
  formatDateTime,
  formatEventWhen,
  osmUrl,
  statusLabel,
} from "../format.js";
import { createPinMap } from "./mapView.js";

/**
 * @typedef {{canEdit?: boolean, subscribed?: boolean, ended?: boolean,
 *   onToggleSubscribe?: (uri: string) => void, onEdit?: (ev: object) => void,
 *   onDelete?: (ev: object) => void}} ActionOpts
 */

/**
 * @typedef {ActionOpts & {stale?: boolean, now?: Date, locale?: string, timeZone?: string,
 *   onClose?: () => void, onCopyLink?: (uri: string) => void}} DetailOpts
 */

/**
 * Toolbar with "Back" and (optionally) "Copy link".
 * @param {{onClose?: () => void, onCopyLink?: (uri: string) => void}} handlers
 * @param {string} [eventUri] omitted on the not-found page
 * @returns {HTMLElement}
 */
function renderToolbar({ onClose, onCopyLink }, eventUri) {
  return h(
    "div",
    { class: "detail__toolbar" },
    h(
      "button",
      { type: "button", class: "btn", onclick: () => onClose?.() },
      "← Back to map",
    ),
    eventUri &&
      onCopyLink &&
      h(
        "button",
        { type: "button", class: "btn", onclick: () => onCopyLink(eventUri) },
        "Copy link",
      ),
  );
}

/**
 * Header: status badges, title, "This event has ended", and "Updated <time>".
 * @param {object} ev EventView
 * @param {DetailOpts} opts
 * @returns {HTMLElement}
 */
function renderHeader(ev, opts) {
  const ended = isEnded(ev, opts.now);
  const status = ended ? null : statusLabel(ev.status);
  return h(
    "header",
    { class: "detail__header" },
    h(
      "div",
      { class: "card__badges" },
      status && h("span", { class: `badge badge--${ev.status}` }, status),
      opts.stale && h("span", { class: "badge" }, "Saved copy"),
    ),
    h(
      "h2",
      { id: "detail-title", class: "detail__title", tabindex: "-1" },
      ev.name,
    ),
    ended &&
      h(
        "p",
        { class: "notice detail__ended", role: "status" },
        "This event has ended",
      ),
    isUpdated(ev) &&
      h(
        "p",
        { class: "detail__updated muted" },
        "Updated ",
        h(
          "time",
          { datetime: ev.updatedAt },
          formatDateTime(ev.updatedAt, opts),
        ),
      ),
  );
}

/**
 * Location: name (linked to OpenStreetMap when possible) and address on its own line.
 * @param {object} ev
 * @returns {HTMLElement[]}
 */
function renderLocation(ev) {
  const href = osmUrl(ev);
  const name = ev.location?.name || "Location not specified";
  return [
    href
      ? h("a", { href, target: "_blank", rel: "noopener noreferrer" }, name)
      : h("span", null, name),
    ev.location?.address &&
      h("span", { class: "detail__address muted" }, ev.location.address),
  ];
}

/**
 * Host handle linked to their Bluesky profile.
 * @param {object} ev
 * @returns {HTMLElement|string}
 */
function renderHost(ev) {
  const label = ev.authorHandle
    ? `@${ev.authorHandle}`
    : ev.authorDid || "Unknown";
  const href = blueskyProfileUrl(ev.authorHandle, ev.authorDid);
  return href
    ? h(
        "a",
        {
          href,
          target: "_blank",
          rel: "noopener noreferrer",
          class: "detail__host",
        },
        label,
      )
    : label;
}

/**
 * Definition list of the key facts (when / where / group / host).
 * @param {object} ev
 * @param {DetailOpts} opts
 * @returns {HTMLElement}
 */
function renderFacts(ev, opts) {
  const fact = (term, ...value) => [
    h("dt", null, term),
    h("dd", null, ...value),
  ];
  return h(
    "dl",
    { class: "detail__facts" },
    fact(
      "When",
      h(
        "time",
        { datetime: ev.startsAt, class: "detail__when" },
        formatEventWhen(ev.startsAt, ev.endsAt, opts),
      ),
    ),
    fact("Where", ...renderLocation(ev)),
    ev.group && fact("Group", h("span", { class: "detail__group" }, ev.group)),
    fact("Host", renderHost(ev)),
  );
}

/**
 * Read-only tag list.
 * @param {string[]} [tags]
 * @returns {HTMLElement|null}
 */
const renderTags = (tags) =>
  tags?.length
    ? h(
        "ul",
        { class: "chips detail__tags", "aria-label": "Tags" },
        tags.map((tag) => h("li", { class: "chip chip--static" }, `#${tag}`)),
      )
    : null;

/**
 * Subscribe slot (#20). Uses the existing subscriptions client when a handler is given;
 * otherwise renders a disabled placeholder. Hidden for ended events unless already subscribed.
 * @param {object} ev
 * @param {ActionOpts} opts
 * @returns {HTMLElement|null}
 */
function renderSubscribe(ev, opts) {
  if (opts.ended && !opts.subscribed) return null;
  if (!opts.onToggleSubscribe)
    return h(
      "button",
      {
        type: "button",
        class: "btn",
        disabled: true,
        title: "Coming soon (#20)",
      },
      "Subscribe",
    );
  return h(
    "button",
    {
      type: "button",
      class: `btn ${opts.subscribed ? "btn--on" : "btn--primary"}`,
      "aria-pressed": String(Boolean(opts.subscribed)),
      dataset: { action: "subscribe" },
      onclick: () => opts.onToggleSubscribe(ev.uri),
    },
    opts.subscribed ? "Subscribed" : "Subscribe to updates",
  );
}

/**
 * STUB(#22, #23): reserved slots for stretch actions. Replace each disabled button with the
 * real implementation when its issue lands; the layout already has room for them.
 * @returns {HTMLElement[]}
 */
const renderStretchActions = () => [
  h(
    "button",
    {
      type: "button",
      class: "btn",
      disabled: true,
      title: "Coming soon (#22)",
      dataset: { slot: "directions" },
    },
    "Get directions",
  ),
  h(
    "button",
    {
      type: "button",
      class: "btn",
      disabled: true,
      title: "Coming soon (#23)",
      dataset: { slot: "calendar" },
    },
    "Add to calendar",
  ),
];

/**
 * Host-only Edit / Delete slot (#9). Edit opens the existing compose modal in edit mode.
 * @param {object} ev
 * @param {ActionOpts} opts
 * @returns {HTMLElement[]}
 */
const renderHostActions = (ev, opts) =>
  opts.canEdit
    ? [
        h(
          "button",
          {
            type: "button",
            class: "btn",
            dataset: { action: "edit" },
            onclick: () => opts.onEdit?.(ev),
          },
          "Edit",
        ),
        h(
          "button",
          {
            type: "button",
            class: "btn btn--danger",
            dataset: { action: "delete" },
            onclick: () => opts.onDelete?.(ev),
          },
          "Delete",
        ),
      ]
    : [];

/**
 * All action buttons for an event, in slot order.
 * @param {object} ev
 * @param {ActionOpts} [opts]
 * @returns {HTMLElement[]}
 */
export const renderActions = (ev, opts = {}) =>
  [
    renderSubscribe(ev, opts),
    ...renderStretchActions(),
    ...renderHostActions(ev, opts),
  ].filter(Boolean);

/**
 * Announcements, newest first.
 * @param {{text: string, createdAt: string}[]} [updates]
 * @param {DetailOpts} opts
 * @returns {HTMLElement}
 */
function renderUpdates(updates = [], opts = {}) {
  const sorted = [...updates].sort(
    (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
  );
  const items = sorted.map((update) =>
    h(
      "li",
      null,
      h(
        "time",
        { datetime: update.createdAt, class: "muted" },
        formatDateTime(update.createdAt, opts),
      ),
      h("p", null, update.text),
    ),
  );
  return h(
    "section",
    { class: "detail__section", "aria-labelledby": "detail-updates" },
    h("h3", { id: "detail-updates" }, "Updates"),
    items.length
      ? h("ol", { class: "updates" }, items)
      : h("p", { class: "muted" }, "No announcements yet."),
  );
}

/**
 * Render the full detail article for an event. The `.detail__map` and `.detail__actions`
 * containers are filled in by the controller (map needs Leaflet; actions re-render often).
 * @param {object} ev EventView & {updates}
 * @param {DetailOpts} [opts]
 * @returns {HTMLElement}
 */
export function renderDetail(ev, opts = {}) {
  const source = safeHttpUrl(ev.sourceUrl);
  const ended = isEnded(ev, opts.now);
  return h(
    "article",
    {
      class: "detail",
      "aria-labelledby": "detail-title",
      dataset: { uri: ev.uri },
    },
    renderToolbar(opts, ev.uri),
    renderHeader(ev, opts),
    renderFacts(ev, opts),
    renderTags(ev.tags),
    h(
      "div",
      { class: "detail__actions" },
      renderActions(ev, { ...opts, ended }),
    ),
    h("div", { class: "detail__map", "aria-label": "Event location map" }),
    ev.description && h("p", { class: "detail__desc" }, ev.description),
    source &&
      h(
        "p",
        null,
        h(
          "a",
          { href: source, target: "_blank", rel: "noopener noreferrer" },
          "Event page",
        ),
      ),
    renderUpdates(ev.updates, opts),
  );
}

/**
 * Friendly page for unknown / deleted / malformed event links.
 * @param {{onClose?: () => void}} [opts]
 * @returns {HTMLElement}
 */
export const renderNotFound = (opts = {}) =>
  h(
    "article",
    { class: "detail detail--missing", "aria-labelledby": "detail-title" },
    renderToolbar(opts),
    h(
      "h2",
      { id: "detail-title", class: "detail__title", tabindex: "-1" },
      "Event not found",
    ),
    h(
      "p",
      null,
      "This event may have been deleted, or the link may be mistyped.",
    ),
    h(
      "button",
      {
        type: "button",
        class: "btn btn--primary",
        onclick: () => opts.onClose?.(),
      },
      "Browse all events",
    ),
  );

/**
 * Error page for failures other than "not found" (offline, server error).
 * @param {{onClose?: () => void, onRetry?: () => void}} opts
 * @returns {HTMLElement}
 */
const renderLoadError = (opts) =>
  h(
    "article",
    { class: "detail detail--error", "aria-labelledby": "detail-title" },
    renderToolbar(opts),
    h(
      "h2",
      { id: "detail-title", class: "detail__title", tabindex: "-1" },
      "Could not load this event",
    ),
    h("p", { role: "alert" }, "Check your connection and try again."),
    h(
      "button",
      { type: "button", class: "btn", onclick: () => opts.onRetry?.() },
      "Try again",
    ),
  );

/**
 * @typedef {{api: {getEvent(uri: string): Promise<{data: object, stale: boolean}>},
 *   findEvent?: (uri: string) => object|null, canEdit?: (ev: object) => boolean,
 *   isSubscribed?: (uri: string) => boolean, onToggleSubscribe?: (uri: string) => void,
 *   onEdit?: (ev: object) => void, onDelete?: (ev: object) => void, onClose?: () => void,
 *   onCopyLink?: (uri: string) => void, pinMapFactory?: typeof createPinMap,
 *   now?: () => Date}} DetailDeps
 */

/**
 * Create the detail pane controller.
 *
 * Loading strategy (good on poor Wi-Fi): render the copy already in the feed immediately
 * (`findEvent`), then refresh from GET /api/event for the full record + announcements.
 * STUB: the backend does not implement GET /api/event yet; until it does, events opened
 * from the feed still render from the feed copy, while deep links show "Could not load".
 * @param {HTMLElement} root
 * @param {DetailDeps} deps
 * @returns {{open(uri: string|null): Promise<void>, close(): void, refreshActions(): void,
 *   readonly currentUri: string|null, readonly currentEvent: object|null}}
 */
export function createDetailView(root, deps) {
  const {
    api,
    findEvent = () => null,
    pinMapFactory = createPinMap,
    now = () => new Date(),
  } = deps;
  let current = null; // {uri, event, stale}
  let pinMap = null;
  let loadSequence = 0;

  /** Per-render action options derived from the latest app state. */
  const actionOpts = (ev) => ({
    canEdit: Boolean(deps.canEdit?.(ev)),
    subscribed: Boolean(deps.isSubscribed?.(ev.uri)),
    ended: isEnded(ev, now()),
    onToggleSubscribe: deps.onToggleSubscribe,
    onEdit: deps.onEdit,
    onDelete: deps.onDelete,
  });

  /** Swap the pane content, releasing the old pin map; optionally focus the title. */
  function mount(node, { focus = true } = {}) {
    pinMap?.destroy();
    pinMap = null;
    root.replaceChildren(node);
    if (focus) node.querySelector("#detail-title")?.focus();
  }

  /** Render an event (and its pin map). */
  function showEvent(event, stale, options) {
    current = { uri: event.uri, event, stale };
    const article = renderDetail(event, {
      stale,
      now: now(),
      onClose: deps.onClose,
      onCopyLink: deps.onCopyLink,
      ...actionOpts(event),
    });
    mount(article, options);
    pinMap = pinMapFactory(article.querySelector(".detail__map"));
    pinMap.show(event).catch(() => {
      /* createPinMap renders its own error notice */
    });
  }

  const showMissing = () => {
    current = null;
    mount(renderNotFound({ onClose: deps.onClose }));
  };

  /** Apply the GET /api/event result (or failure) for the current open() call. */
  function settle({ data, stale, error }, uri, cached) {
    if (error?.status === 404 || (!error && !data)) return showMissing();
    if (data) {
      const focus = !cached || root.contains(document.activeElement);
      return showEvent(data, stale, { focus });
    }
    if (cached)
      return showEvent(cached, true, {
        focus: root.contains(document.activeElement),
      });
    mount(renderLoadError({ onClose: deps.onClose, onRetry: () => open(uri) }));
  }

  /**
   * Open an event by AT URI. `null` (a malformed link) shows "Event not found".
   * @param {string|null} uri
   */
  async function open(uri) {
    const sequence = ++loadSequence;
    if (!uri) return showMissing();
    current = { uri, event: null, stale: false };
    const cached = findEvent(uri);
    if (cached) showEvent(cached, false, { focus: true });
    else
      mount(
        h(
          "p",
          {
            id: "detail-title",
            class: "loading",
            role: "status",
            tabindex: "-1",
          },
          "Loading event…",
        ),
      );
    let result;
    try {
      result = await api.getEvent(uri);
    } catch (error) {
      result = { error };
    }
    if (sequence === loadSequence) settle(result, uri, cached);
  }

  /** Re-render only the action buttons (subscription / edit rights changed). */
  function refreshActions() {
    const slot = root.querySelector(".detail__actions");
    if (!slot || !current?.event) return;
    const focusedAction = document.activeElement?.dataset?.action;
    slot.replaceChildren(
      ...renderActions(current.event, actionOpts(current.event)),
    );
    if (focusedAction)
      slot.querySelector(`[data-action="${focusedAction}"]`)?.focus();
  }

  /** Clear the pane and cancel any in-flight load. */
  function close() {
    loadSequence++;
    current = null;
    pinMap?.destroy();
    pinMap = null;
    root.replaceChildren();
  }

  return {
    open,
    close,
    refreshActions,
    get currentUri() {
      return current?.uri ?? null;
    },
    get currentEvent() {
      return current?.event ?? null;
    },
  };
}
