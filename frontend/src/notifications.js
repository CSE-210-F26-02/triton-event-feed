/**
 * Live notifications for subscribed events: SSE stream with reconnect + backoff, catch-up
 * of anything missed while disconnected, toasts, and (when the tab is hidden) system
 * notifications. Split out of subscriptions.js when subscriptions moved to PDS records (#19).
 *
 * STUB(#5 / delivery): the backend does not serve /api/notifications yet. The stream is
 * keyed by the subscriber's DID, because the indexer (#5) will learn who to notify from
 * the app.communitymap.subscription records on each user's PDS. Until then the stream
 * simply fails to connect and retries with backoff, which is harmless.
 * @module notifications
 */
import { getStorage, storageGet, storageSet } from "./util.js";

/** Prefix of the per-subscriber "last notification id seen" storage key. */
const LAST_KEY_PREFIX = "cm:last-notification-id";
const ASKED_KEY = "cm:notify-asked";

/** Default first reconnect delay (doubles each attempt). */
const DEFAULT_BASE_DELAY_MS = 1000;
/** Longest wait between reconnect attempts. */
const MAX_BACKOFF_MS = 30000;
/** Title of system notifications. */
const NOTIFICATION_TITLE = "Community Map";

/**
 * Pure catch-up merge: keep notifications newer than `lastId`, sorted by id, deduped.
 * @param {number|null} lastId
 * @param {{id: number}[]} list
 * @returns {{fresh: object[], lastId: number|null}}
 */
export function mergeNotifications(lastId, list) {
  const seen = new Set();
  const fresh = (Array.isArray(list) ? list : [])
    .filter(
      (n) => typeof n?.id === "number" && (lastId == null || n.id > lastId),
    )
    .filter((n) => !seen.has(n.id) && seen.add(n.id))
    .sort((a, b) => a.id - b.id);
  const next = fresh.length ? fresh[fresh.length - 1].id : lastId;
  return { fresh, lastId: next };
}

/**
 * Backoff delay for reconnect attempt `n` (0-based): 1s, 2s, 4s… capped.
 * @param {number} n @param {number} [baseMs] @param {number} [maxMs]
 * @returns {number}
 */
export function backoffMs(
  n,
  baseMs = DEFAULT_BASE_DELAY_MS,
  maxMs = MAX_BACKOFF_MS,
) {
  return Math.min(maxMs, baseMs * 2 ** n);
}

/**
 * Parse a stored notification id, or null.
 * @param {string|null} value
 * @returns {number|null}
 */
function parseLastId(value) {
  const n = value == null ? NaN : Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Show one notification: a toast, plus a system notification when the tab is hidden and
 * permission was granted.
 * @param {{id: number, message: string}} notification
 * @param {{toast: (msg: string) => void, NotificationImpl: typeof Notification|null}} deps
 */
function showNotification(notification, { toast, NotificationImpl }) {
  toast(notification.message);
  const hidden = globalThis.document?.hidden;
  if (!hidden || NotificationImpl?.permission !== "granted") return;
  try {
    new NotificationImpl(NOTIFICATION_TITLE, {
      body: notification.message,
      tag: `cm-${notification.id}`,
    });
  } catch {
    /* some platforms only allow notifications from a service worker */
  }
}

/**
 * Create the notification client. Call `watch(did)` while the user has subscriptions and
 * `watch(null)` otherwise.
 * @param {{api: {notifications(id: string, since: number|null): Promise<{data: any}>,
 *   notificationStreamUrl(id: string): string}, storage?: Storage|null,
 *   EventSourceImpl?: typeof EventSource|null, NotificationImpl?: typeof Notification|null,
 *   toast?: (msg: string) => void, onNotification?: (n: object) => void,
 *   baseDelayMs?: number}} opts
 * @returns {{watch(subscriberId: string|null): void, reconnectNow(): void,
 *   catchUp(): Promise<void>, askPermissionOnce(): Promise<void>, disconnect(): void,
 *   readonly subscriberId: string|null}}
 */
export function createNotifications({
  api,
  storage = getStorage("localStorage"),
  EventSourceImpl = globalThis.EventSource ?? null,
  NotificationImpl = globalThis.Notification ?? null,
  toast = () => {},
  onNotification = () => {},
  baseDelayMs = DEFAULT_BASE_DELAY_MS,
}) {
  let subscriberId = null;
  let lastId = null;
  let source = null;
  let attempts = 0;
  let timer = null;

  const lastKey = () => `${LAST_KEY_PREFIX}:${subscriberId}`;

  function setLast(id) {
    lastId = id;
    storageSet(storage, lastKey(), id == null ? null : String(id));
  }

  function handle(list) {
    const { fresh, lastId: next } = mergeNotifications(lastId, list);
    setLast(next);
    fresh.forEach((n) => {
      showNotification(n, { toast, NotificationImpl });
      onNotification(n);
    });
  }

  /** Fetch notifications missed while disconnected. First run only records a baseline. */
  async function catchUp() {
    if (!subscriberId) return;
    try {
      const { data } = await api.notifications(subscriberId, lastId);
      if (lastId == null) setLast(mergeNotifications(null, data).lastId ?? 0);
      else handle(data);
    } catch {
      /* offline (or STUB: endpoint missing); the next reconnect retries */
    }
  }

  function connect() {
    if (!EventSourceImpl || source || !subscriberId) return;
    clearTimeout(timer);
    source = new EventSourceImpl(api.notificationStreamUrl(subscriberId));
    source.onopen = () => {
      attempts = 0;
      catchUp();
    };
    source.onmessage = (ev) => {
      try {
        handle([JSON.parse(ev.data)]);
      } catch {
        /* ignore malformed message */
      }
    };
    source.onerror = () => {
      disconnect();
      timer = setTimeout(connect, backoffMs(attempts++, baseDelayMs));
    };
  }

  function disconnect() {
    clearTimeout(timer);
    if (source) source.close();
    source = null;
  }

  /**
   * Start (or keep) the stream for `id`, or stop it for null. Switching ids reconnects.
   * @param {string|null} id the subscriber's DID
   */
  function watch(id) {
    const next = typeof id === "string" && id ? id : null;
    if (next === subscriberId) return next ? connect() : undefined;
    disconnect();
    subscriberId = next;
    attempts = 0;
    lastId = next ? parseLastId(storageGet(storage, lastKey())) : null;
    connect();
  }

  /** Ask for system-notification permission once per browser (first subscribe). */
  async function askPermissionOnce() {
    if (!NotificationImpl || NotificationImpl.permission !== "default") return;
    if (storageGet(storage, ASKED_KEY)) return;
    storageSet(storage, ASKED_KEY, "1");
    try {
      await NotificationImpl.requestPermission();
    } catch {
      /* ignore */
    }
  }

  return {
    watch,
    /** Reconnect immediately (e.g. on the window "online" event). */
    reconnectNow() {
      attempts = 0;
      disconnect();
      connect();
    },
    catchUp,
    askPermissionOnce,
    disconnect,
    get subscriberId() {
      return subscriberId;
    },
  };
}
