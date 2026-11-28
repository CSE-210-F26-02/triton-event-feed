/**
 * Event detail pane: replaces the big map while an event is open (#14). Shows everything
 * about one event (when, where, what, who) plus a small pin map and the action slots for
 * Subscribe (#19), host Edit/Delete (#9), Get directions (#22) and Add to calendar (#23).
 *
 * Every event is read through the app.communitymap.event lexicon, the schema of an event
 * record (lexicon/eventView.js):
 * the view renders a sanitized "display event", and records that break the lexicon are
 * shown best-effort with a warning instead of being trusted blindly.
 * @module views/detailView
 */
import { createElementTree, safeHttpUrl } from "../dom.js";
import { isEnded, isUpdated } from "../filters.js";
import {
  blueskyProfileUrl,
  displayStatus,
  formatDateTime,
  formatEventWhen,
  osmUrl,
} from "../format.js";
import {
  findLexiconIssues,
  isEventUri,
  isPlainObject,
  toDisplayEvent,
} from "../lexicon/eventView.js";
import { createPinMap } from "./mapView.js";
import { renderStatusBadges } from "./statusBadges.js";
import {
  PRIVACY_NOTE_ID,
  SUBSCRIBE_LABEL,
  renderPrivacyNote,
  renderSubscribeButton,
} from "./subscribeButton.js";

/** Banner shown when an event's record does not match the lexicon. */
export const INVALID_RECORD_NOTICE =
  "Some details of this event may be missing or incorrect.";

/** "When" text for records without a usable start time. */
export const TIME_NOT_SPECIFIED = "Time not specified";

/**
 * GET /api/event statuses that mean "there is no such event": 404 for unknown records,
 * 400 for URIs the AppView rejects as malformed.
 */
const NOT_FOUND_STATUSES = new Set([400, 404]);

/**
 * Default handler for records that break the lexicon: log them so developers can see
 * which field is wrong, while users still get the best-effort page.
 * @param {string} uri
 * @param {import('../lexicon/eventView.js').ValidationIssue[]} issues
 */
const warnInvalidRecord = (uri, issues) =>
  console.warn(`Event ${uri} does not match the lexicon:`, issues);

/**
 * @typedef {{canEdit?: boolean, subscribed?: boolean, ended?: boolean,
 *   onToggleSubscribe?: (event: object) => void, onEdit?: (event: object) => void,
 *   onDelete?: (event: object) => void}} ActionOpts
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
  return createElementTree(
    "div",
    { class: "detail__toolbar" },
    createElementTree(
      "button",
      { type: "button", class: "btn", onclick: () => onClose?.() },
      "← Back to map",
    ),
    eventUri &&
      onCopyLink &&
      createElementTree(
        "button",
        { type: "button", class: "btn", onclick: () => onCopyLink(eventUri) },
        "Copy link",
      ),
  );
}

/**
 * Notices under the title: "This event has ended", the lexicon warning, and
 * "Updated <time>" (only when the event was edited).
 * @param {import('../lexicon/eventView.js').DisplayEvent} event
 * @param {DetailOpts} options
 * @param {boolean} ended
 * @returns {(HTMLElement|false)[]}
 */
const renderHeaderNotices = (event, options, ended) => [
  ended &&
    createElementTree(
      "p",
      { class: "notice detail__ended", role: "status" },
      "This event has ended",
    ),
  event.issues.length > 0 &&
    createElementTree(
      "p",
      { class: "notice detail__invalid" },
      INVALID_RECORD_NOTICE,
    ),
  isUpdated(event) &&
    createElementTree(
      "p",
      { class: "detail__updated muted" },
      "Updated ",
      createElementTree(
        "time",
        { datetime: event.updatedAt },
        formatDateTime(event.updatedAt, options),
      ),
    ),
];

/**
 * Header: status badges, title, and the notices from renderHeaderNotices.
 * @param {import('../lexicon/eventView.js').DisplayEvent} event
 * @param {DetailOpts} options
 * @returns {HTMLElement}
 */
function renderHeader(event, options) {
  const ended = isEnded(event, options.now);
  return createElementTree(
    "header",
    { class: "detail__header" },
    createElementTree(
      "div",
      { class: "card__badges" },
      ...renderStatusBadges(displayStatus(event, ended)),
      options.stale &&
        createElementTree("span", { class: "badge" }, "Saved copy"),
    ),
    createElementTree(
      "h2",
      { id: "detail-title", class: "detail__title", tabindex: "-1" },
      event.name,
    ),
    renderHeaderNotices(event, options, ended),
  );
}

/**
 * "When" value in local time. Falls back gracefully when the record's times are unusable:
 * no start → TIME_NOT_SPECIFIED; a start but no end → just the start.
 * @param {import('../lexicon/eventView.js').DisplayEvent} event
 * @param {DetailOpts} options
 * @returns {HTMLElement}
 */
function renderWhen(event, options) {
  if (!event.startsAt)
    return createElementTree(
      "span",
      { class: "detail__when muted" },
      TIME_NOT_SPECIFIED,
    );
  const text = event.endsAt
    ? formatEventWhen(event.startsAt, event.endsAt, options)
    : formatDateTime(event.startsAt, options);
  return createElementTree(
    "time",
    { datetime: event.startsAt, class: "detail__when" },
    text,
  );
}

/**
 * Location: name (linked to OpenStreetMap when possible) and address on its own line.
 * @param {import('../lexicon/eventView.js').DisplayEvent} event
 * @returns {HTMLElement[]}
 */
function renderLocation(event) {
  const href = osmUrl(event);
  const name = event.location.name || "Location not specified";
  return [
    href
      ? createElementTree(
          "a",
          { href, target: "_blank", rel: "noopener noreferrer" },
          name,
        )
      : createElementTree("span", null, name),
    event.location.address &&
      createElementTree(
        "span",
        { class: "detail__address muted" },
        event.location.address,
      ),
  ];
}

/**
 * Group label. For lexicon strongRefs the group record's URI is kept on the element
 * (data-group-uri) so #17 can swap the placeholder label for the group's real name.
 * @param {import('../lexicon/eventView.js').DisplayGroup} group
 * @returns {HTMLElement}
 */
const renderGroup = (group) =>
  createElementTree(
    "span",
    {
      class: "detail__group",
      dataset: group.uri ? { groupUri: group.uri } : null,
    },
    group.label,
  );

/**
 * Host handle linked to their Bluesky profile.
 * @param {import('../lexicon/eventView.js').DisplayEvent} event
 * @returns {HTMLElement|string}
 */
function renderHost(event) {
  const label = event.authorHandle
    ? `@${event.authorHandle}`
    : event.authorDid || "Unknown";
  const href = blueskyProfileUrl(event.authorHandle, event.authorDid);
  return href
    ? createElementTree(
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
 * @param {import('../lexicon/eventView.js').DisplayEvent} event
 * @param {DetailOpts} options
 * @returns {HTMLElement}
 */
function renderFacts(event, options) {
  const fact = (term, ...value) => [
    createElementTree("dt", null, term),
    createElementTree("dd", null, ...value),
  ];
  return createElementTree(
    "dl",
    { class: "detail__facts" },
    fact("When", renderWhen(event, options)),
    fact("Where", ...renderLocation(event)),
    event.group && fact("Group", renderGroup(event.group)),
    fact("Host", renderHost(event)),
  );
}

/**
 * Read-only tag list.
 * @param {string[]} [tags]
 * @returns {HTMLElement|null}
 */
const renderTags = (tags) =>
  tags?.length
    ? createElementTree(
        "ul",
        { class: "chips detail__tags", "aria-label": "Tags" },
        tags.map((tag) =>
          createElementTree("li", { class: "chip chip--static" }, `#${tag}`),
        ),
      )
    : null;

/**
 * Subscribe slot (#19): the shared toggle (views/subscribeButton.js), or a disabled
 * placeholder when no handler is wired. Hidden for ended events unless already subscribed.
 * @param {object} event EventView (handed to the handler, so the subscription gets its cid)
 * @param {ActionOpts} options
 * @returns {HTMLElement|null}
 */
function renderSubscribe(event, options) {
  if (options.ended && !options.subscribed) return null;
  if (!options.onToggleSubscribe)
    return createElementTree(
      "button",
      {
        type: "button",
        class: "btn",
        disabled: true,
        title: "Subscriptions are unavailable",
      },
      SUBSCRIBE_LABEL,
    );
  return renderSubscribeButton(event, {
    subscribed: options.subscribed,
    ended: options.ended,
    onToggle: options.onToggleSubscribe,
    describedBy: PRIVACY_NOTE_ID,
  });
}

/**
 * STUB(#22, #23): reserved slots for stretch actions. Replace each disabled button with the
 * real implementation when its issue lands; the layout already has room for them.
 * @returns {HTMLElement[]}
 */
const renderStretchActions = () => [
  createElementTree(
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
  createElementTree(
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
 * @param {object} event
 * @param {ActionOpts} options
 * @returns {HTMLElement[]}
 */
const renderHostActions = (event, options) =>
  options.canEdit
    ? [
        createElementTree(
          "button",
          {
            type: "button",
            class: "btn",
            dataset: { action: "edit" },
            onclick: () => options.onEdit?.(event),
          },
          "Edit",
        ),
        createElementTree(
          "button",
          {
            type: "button",
            class: "btn btn--danger",
            dataset: { action: "delete" },
            onclick: () => options.onDelete?.(event),
          },
          "Delete",
        ),
      ]
    : [];

/**
 * All action buttons for an event, in slot order.
 * @param {object} event
 * @param {ActionOpts} [options]
 * @returns {HTMLElement[]}
 */
export const renderActions = (event, options = {}) =>
  [
    renderSubscribe(event, options),
    ...renderStretchActions(),
    ...renderHostActions(event, options),
  ].filter(Boolean);

/**
 * Announcements, newest first.
 * @param {{text: string, createdAt: string}[]} [updates]
 * @param {DetailOpts} options
 * @returns {HTMLElement}
 */
function renderUpdates(updates = [], options = {}) {
  const sorted = [...updates].sort(
    (firstUpdate, secondUpdate) =>
      Date.parse(secondUpdate.createdAt) - Date.parse(firstUpdate.createdAt),
  );
  const updateItems = sorted.map((update) =>
    createElementTree(
      "li",
      null,
      createElementTree(
        "time",
        { datetime: update.createdAt, class: "muted" },
        formatDateTime(update.createdAt, options),
      ),
      createElementTree("p", null, update.text),
    ),
  );
  return createElementTree(
    "section",
    { class: "detail__section", "aria-labelledby": "detail-updates" },
    createElementTree("h3", { id: "detail-updates" }, "Updates"),
    updateItems.length
      ? createElementTree("ol", { class: "updates" }, updateItems)
      : createElementTree("p", { class: "muted" }, "No announcements yet."),
  );
}

/**
 * Render the full detail article for an event. The `.detail__map` container is filled in
 * by the controller (the map needs Leaflet). Display fields come from the sanitized
 * display event; the action buttons receive the original EventView, so Edit / Delete
 * hand the host's real record to the compose modal.
 * @param {object} event EventView & {updates}
 * @param {DetailOpts} [options]
 * @returns {HTMLElement}
 */
export function renderDetail(event, options = {}) {
  const view = toDisplayEvent(event);
  const sourceLink = safeHttpUrl(view.sourceUrl);
  const ended = isEnded(view, options.now);
  return createElementTree(
    "article",
    {
      class: "detail",
      "aria-labelledby": "detail-title",
      dataset: {
        ...(view.uri ? { uri: view.uri } : {}),
        lexiconValid: String(view.issues.length === 0),
      },
    },
    renderToolbar(options, view.uri),
    renderHeader(view, options),
    renderFacts(view, options),
    renderTags(view.tags),
    createElementTree(
      "div",
      { class: "detail__actions" },
      renderActions(event, { ...options, ended }),
    ),
    options.onToggleSubscribe && !ended && renderPrivacyNote(),
    createElementTree("div", {
      class: "detail__map",
      "aria-label": "Event location map",
    }),
    view.description &&
      createElementTree("p", { class: "detail__desc" }, view.description),
    sourceLink &&
      createElementTree(
        "p",
        null,
        createElementTree(
          "a",
          { href: sourceLink, target: "_blank", rel: "noopener noreferrer" },
          "Event page",
        ),
      ),
    renderUpdates(view.updates, options),
  );
}

/**
 * Friendly page for unknown / deleted / malformed event links.
 * @param {{onClose?: () => void}} [options]
 * @returns {HTMLElement}
 */
export const renderNotFound = (options = {}) =>
  createElementTree(
    "article",
    { class: "detail detail--missing", "aria-labelledby": "detail-title" },
    renderToolbar(options),
    createElementTree(
      "h2",
      { id: "detail-title", class: "detail__title", tabindex: "-1" },
      "Event not found",
    ),
    createElementTree(
      "p",
      null,
      "This event may have been deleted, or the link may be mistyped.",
    ),
    createElementTree(
      "button",
      {
        type: "button",
        class: "btn btn--primary",
        onclick: () => options.onClose?.(),
      },
      "Browse all events",
    ),
  );

/**
 * Error page for failures other than "not found" (offline, server error).
 * @param {{onClose?: () => void, onRetry?: () => void}} options
 * @returns {HTMLElement}
 */
const renderLoadError = (options) =>
  createElementTree(
    "article",
    { class: "detail detail--error", "aria-labelledby": "detail-title" },
    renderToolbar(options),
    createElementTree(
      "h2",
      { id: "detail-title", class: "detail__title", tabindex: "-1" },
      "Could not load this event",
    ),
    createElementTree(
      "p",
      { role: "alert" },
      "Check your connection and try again.",
    ),
    createElementTree(
      "button",
      { type: "button", class: "btn", onclick: () => options.onRetry?.() },
      "Try again",
    ),
  );

/**
 * @typedef {{api: {getEvent(uri: string): Promise<{data: object, stale: boolean}>},
 *   findEvent?: (uri: string) => object|null, canEdit?: (event: object) => boolean,
 *   isSubscribed?: (uri: string) => boolean, onToggleSubscribe?: (event: object) => void,
 *   onEdit?: (event: object) => void, onDelete?: (event: object) => void, onClose?: () => void,
 *   onCopyLink?: (uri: string) => void, mapConfig?: import('../config.js').MapConfig,
 *   pinMapFactory?: (root: HTMLElement) => ReturnType<typeof createPinMap>,
 *   now?: () => Date, onInvalidRecord?: (uri: string,
 *   issues: import('../lexicon/eventView.js').ValidationIssue[]) => void}} DetailDeps
 */

/**
 * Make sure a fetched EventView carries a URI: when the AppView leaves `uri` off, fall
 * back to the URI that was requested, so "Copy link" and subscriptions keep working.
 * @param {object} eventView
 * @param {string} requestedUri
 * @returns {object}
 */
const withRequestedUri = (eventView, requestedUri) =>
  typeof eventView.uri === "string"
    ? eventView
    : { ...eventView, uri: requestedUri };

/**
 * Create the detail pane controller.
 *
 * Loading strategy (good on poor Wi-Fi): render the copy already in the feed immediately
 * (`findEvent`), then refresh from GET /api/event for the full record + announcements.
 * STUB: the backend does not implement GET /api/event yet; until it does, events opened
 * from the feed still render from the feed copy, while deep links show "Could not load".
 *
 * Only at:// URIs of app.communitymap.event records are fetched; anything else shows
 * "Event not found" without a request. Records that break the lexicon are reported to
 * `onInvalidRecord` (default: console.warn) and still rendered best-effort.
 * @param {HTMLElement} root
 * @param {DetailDeps} dependencies
 * @returns {{open(uri: string|null): Promise<void>, close(): void, refreshActions(): void,
 *   readonly currentUri: string|null, readonly currentEvent: object|null}}
 */
export function createDetailView(root, dependencies) {
  const {
    api,
    findEvent = () => null,
    pinMapFactory = (container) =>
      createPinMap(container, { config: dependencies.mapConfig }),
    now = () => new Date(),
    onInvalidRecord = warnInvalidRecord,
  } = dependencies;
  let displayed = null; // {uri, event, stale}
  let pinMap = null;
  let loadSequence = 0;

  /** Per-render action options derived from the latest app state. */
  const actionOpts = (event) => ({
    canEdit: Boolean(dependencies.canEdit?.(event)),
    subscribed: Boolean(dependencies.isSubscribed?.(event.uri)),
    ended: isEnded(event, now()),
    onToggleSubscribe: dependencies.onToggleSubscribe,
    onEdit: dependencies.onEdit,
    onDelete: dependencies.onDelete,
  });

  /** Swap the pane content, releasing the old pin map; optionally focus the title. */
  function mount(node, { focus = true } = {}) {
    pinMap?.destroy();
    pinMap = null;
    root.replaceChildren(node);
    if (focus) node.querySelector("#detail-title")?.focus();
  }

  /** Report lexicon problems with an event (rendering continues regardless). */
  function reportLexiconIssues(event) {
    const issues = findLexiconIssues(event);
    if (issues.length) onInvalidRecord(event.uri, issues);
  }

  /** Render an event (and its pin map). */
  function showEvent(event, stale, options) {
    displayed = { uri: event.uri, event, stale };
    reportLexiconIssues(event);
    const article = renderDetail(event, {
      stale,
      now: now(),
      onClose: dependencies.onClose,
      onCopyLink: dependencies.onCopyLink,
      ...actionOpts(event),
    });
    mount(article, options);
    pinMap = pinMapFactory(article.querySelector(".detail__map"));
    pinMap.show(toDisplayEvent(event)).catch(() => {
      /* createPinMap renders its own error notice */
    });
  }

  const showMissing = () => {
    displayed = null;
    mount(renderNotFound({ onClose: dependencies.onClose }));
  };

  /** Apply the GET /api/event result (or failure) for the current open() call. */
  function settle({ data: fetchedEvent, stale, error } = {}, uri, cached) {
    const notFound = NOT_FOUND_STATUSES.has(error?.status);
    if (notFound || (!error && !isPlainObject(fetchedEvent)))
      return showMissing();
    if (!error) {
      const focus = !cached || root.contains(document.activeElement);
      return showEvent(withRequestedUri(fetchedEvent, uri), stale, { focus });
    }
    if (cached)
      return showEvent(cached, true, {
        focus: root.contains(document.activeElement),
      });
    mount(
      renderLoadError({
        onClose: dependencies.onClose,
        onRetry: () => open(uri),
      }),
    );
  }

  /**
   * Open an event by AT URI. `null` (a malformed link) or a URI that is not an
   * app.communitymap.event record shows "Event not found".
   * @param {string|null} uri
   */
  async function open(uri) {
    const sequence = ++loadSequence;
    if (!isEventUri(uri)) return showMissing();
    displayed = { uri, event: null, stale: false };
    const cached = findEvent(uri);
    if (cached) showEvent(cached, false, { focus: true });
    else
      mount(
        createElementTree(
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
    if (sequence === loadSequence) settle(result ?? undefined, uri, cached);
  }

  /** Re-render only the action buttons (subscription / edit rights changed). */
  function refreshActions() {
    const slot = root.querySelector(".detail__actions");
    if (!slot || !displayed?.event) return;
    const focusedAction = document.activeElement?.dataset?.action;
    slot.replaceChildren(
      ...renderActions(displayed.event, actionOpts(displayed.event)),
    );
    if (focusedAction)
      slot.querySelector(`[data-action="${focusedAction}"]`)?.focus();
  }

  /** Clear the pane and cancel any in-flight load. */
  function close() {
    loadSequence++;
    displayed = null;
    pinMap?.destroy();
    pinMap = null;
    root.replaceChildren();
  }

  return {
    open,
    close,
    refreshActions,
    get currentUri() {
      return displayed?.uri ?? null;
    },
    get currentEvent() {
      return displayed?.event ?? null;
    },
  };
}
