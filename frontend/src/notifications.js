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
 * @param {{id: number}[]} received
 * @returns {{fresh: object[], lastId: number|null}}
 */
export function mergeNotifications(lastId, received) {
  const seen = new Set();
  const fresh = (Array.isArray(received) ? received : [])
    .filter(
      (notification) =>
        typeof notification?.id === "number" &&
        (lastId == null || notification.id > lastId),
    )
    .filter(
      (notification) => !seen.has(notification.id) && seen.add(notification.id),
    )
    .sort(
      (firstNotification, secondNotification) =>
        firstNotification.id - secondNotification.id,
    );
  const newestId = fresh.length ? fresh[fresh.length - 1].id : lastId;
  return { fresh, lastId: newestId };
}

/**
 * Backoff delay for reconnect attempt `n` (0-based): 1s, 2s, 4s… capped.
 * @param {number} attempt @param {number} [baseMs] @param {number} [maxMs]
 * @returns {number}
 */
export function backoffMs(
  attempt,
  baseMs = DEFAULT_BASE_DELAY_MS,
  maxMs = MAX_BACKOFF_MS,
) {
  return Math.min(maxMs, baseMs * 2 ** attempt);
}

/**
 * Parse a stored notification id, or null.
 * @param {string|null} value
 * @returns {number|null}
 */
function parseLastId(value) {
  const parsedNumber = value == null ? NaN : Number(value);
  return Number.isFinite(parsedNumber) ? parsedNumber : null;
}

/**
 * Show one notification: a toast, plus a system notification when the tab is hidden and
 * permission was granted.
 * @param {{id: number, message: string}} notification
 * @param {{toast: (message: string) => void, NotificationImpl: typeof Notification|null}} dependencies
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
 *   toast?: (message: string) => void, onNotification?: (notification: object) => void,
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
  let eventSource = null;
  let attempts = 0;
  let timer = null;

  const lastKey = () => `${LAST_KEY_PREFIX}:${subscriberId}`;

  function setLast(id) {
    lastId = id;
    storageSet(storage, lastKey(), id == null ? null : String(id));
  }

  function deliverNotifications(received) {
    const { fresh, lastId: newestId } = mergeNotifications(lastId, received);
    setLast(newestId);
    fresh.forEach((notification) => {
      showNotification(notification, { toast, NotificationImpl });
      onNotification(notification);
    });
  }

  /** Fetch notifications missed while disconnected. First run only records a baseline. */
  async function catchUp() {
    if (!subscriberId) return;
    try {
      const { data: missedNotifications } = await api.notifications(
        subscriberId,
        lastId,
      );
      if (lastId == null)
        setLast(mergeNotifications(null, missedNotifications).lastId ?? 0);
      else deliverNotifications(missedNotifications);
    } catch {
      /* offline (or STUB: endpoint missing); the next reconnect retries */
    }
  }

  function connect() {
    if (!EventSourceImpl || eventSource || !subscriberId) return;
    clearTimeout(timer);
    eventSource = new EventSourceImpl(api.notificationStreamUrl(subscriberId));
    eventSource.onopen = () => {
      attempts = 0;
      catchUp();
    };
    eventSource.onmessage = (event) => {
      try {
        deliverNotifications([JSON.parse(event.data)]);
      } catch {
        /* ignore malformed message */
      }
    };
    eventSource.onerror = () => {
      disconnect();
      timer = setTimeout(connect, backoffMs(attempts++, baseDelayMs));
    };
  }

  function disconnect() {
    clearTimeout(timer);
    if (eventSource) eventSource.close();
    eventSource = null;
  }

  /**
   * Start (or keep) the stream for `id`, or stop it for null. Switching ids reconnects.
   * @param {string|null} id the subscriber's DID
   */
  function watch(id) {
    const nextSubscriberId = typeof id === "string" && id ? id : null;
    if (nextSubscriberId === subscriberId)
      return nextSubscriberId ? connect() : undefined;
    disconnect();
    subscriberId = nextSubscriberId;
    attempts = 0;
    lastId = nextSubscriberId
      ? parseLastId(storageGet(storage, lastKey()))
      : null;
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
