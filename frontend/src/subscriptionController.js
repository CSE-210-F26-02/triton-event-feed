/**
 * What happens when someone presses Subscribe (#19), independent of any one view:
 *
 * - Logged in: toggle the subscription record on their PDS and report failures.
 * - Logged out: ask them to log in (`requestLogin`), return them to the event, and then
 *   finish the subscription. It only ever subscribes; if they turn out to be subscribed
 *   already (from another device), nothing is toggled off. Cancelling login does nothing.
 *
 * `requestLogin` is a hook so the login flow (still being built) can change, e.g. from
 * today's dialog to a login page, without touching this module.
 * @module subscriptionController
 */
import { SubscriptionError } from "./subscriptions.js";

export const LOGIN_TO_SUBSCRIBE_REASON = "Log in to subscribe to this event.";
export const SUBSCRIBED_TOAST =
  "Subscribed. You'll be notified when it changes.";
export const UNSUBSCRIBED_TOAST = "Unsubscribed.";
export const LOAD_FAILED_TOAST =
  "Could not load your subscriptions — check your connection.";
export const NETWORK_FAILED_TOAST =
  "Could not update your subscription — check your connection.";

/**
 * Pure: user-facing message for a failed subscribe / unsubscribe.
 * @param {unknown} error
 * @returns {string}
 */
export function subscriptionErrorMessage(error) {
  if (error instanceof SubscriptionError) return error.message;
  return NETWORK_FAILED_TOAST;
}

/**
 * @typedef {object} SubscriptionControllerDeps
 * @property {ReturnType<typeof import('./subscriptions.js').createSubscriptions>} subscriptions
 * @property {{askPermissionOnce(): Promise<void>}} [notifications]
 * @property {() => boolean} isLoggedIn
 * @property {(request: import('./views/loginView.js').LoginRequest) => void} requestLogin
 * @property {(uri: string) => void} openEvent navigate to an event's detail page
 * @property {(message: string, opts?: {kind?: string}) => void} toast
 */

/**
 * Run a subscription change, toasting the outcome; asks for notification permission
 * after a successful subscribe.
 * @param {SubscriptionControllerDeps} deps
 * @param {() => Promise<boolean>} change
 * @returns {Promise<boolean|null>} the new state, or null when it failed
 */
async function attemptChange(deps, change) {
  try {
    const subscribed = await change();
    deps.toast(subscribed ? SUBSCRIBED_TOAST : UNSUBSCRIBED_TOAST);
    if (subscribed) deps.notifications?.askPermissionOnce();
    return subscribed;
  } catch (error) {
    deps.toast(subscriptionErrorMessage(error), { kind: "error" });
    return null;
  }
}

/**
 * Reload the user's subscriptions from their PDS, toasting a failure.
 * @param {SubscriptionControllerDeps} deps
 * @returns {Promise<boolean>} true on success
 */
async function reloadSubscriptions(deps) {
  try {
    await deps.subscriptions.load();
    return true;
  } catch {
    deps.toast(LOAD_FAILED_TOAST, { kind: "error" });
    return false;
  }
}

/**
 * After a login started by Subscribe: back to the event, then make sure it's on.
 * @param {SubscriptionControllerDeps} deps
 * @param {object} event EventView
 */
async function subscribeAfterLogin(deps, event) {
  deps.openEvent(event.uri);
  if (!(await reloadSubscriptions(deps))) return;
  if (deps.subscriptions.has(event.uri)) return;
  await attemptChange(deps, () => deps.subscriptions.subscribe(event));
}

/**
 * Create the controller.
 * @param {SubscriptionControllerDeps} deps
 * @returns {{toggle(event: object): Promise<boolean|null>,
 *   unsubscribe(uri: string): Promise<boolean|null>, reload(): Promise<boolean>}}
 */
export function createSubscriptionController(deps) {
  return {
    /**
     * Subscribe button handler.
     * @param {object} event EventView
     * @returns {Promise<boolean|null>} new state; null when it failed or login is pending
     */
    async toggle(event) {
      if (deps.isLoggedIn())
        return attemptChange(deps, () => deps.subscriptions.toggle(event));
      deps.requestLogin({
        reason: LOGIN_TO_SUBSCRIBE_REASON,
        onLoggedIn: () => subscribeAfterLogin(deps, event),
      });
      return null;
    },
    /**
     * Unsubscribe by URI only (for events that could not be loaded).
     * @param {string} uri
     * @returns {Promise<boolean|null>}
     */
    unsubscribe: (uri) =>
      deps.isLoggedIn()
        ? attemptChange(deps, () => deps.subscriptions.unsubscribe(uri))
        : Promise.resolve(null),
    /** Reload from the PDS. @returns {Promise<boolean>} */
    reload: () => reloadSubscriptions(deps),
  };
}
