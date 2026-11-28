/**
 * The Subscribe / "Subscribed ✓" toggle (#19), shared by the detail page, feed cards and
 * the My subscriptions page so they always look and behave the same.
 *
 * Rules: an ended event shows no button (you can't subscribe to it), unless the user is
 * already subscribed, in which case "Subscribed ✓" stays so they can still unsubscribe.
 * The privacy note (subscriptions are public records in the user's account) is the button's tooltip and,
 * on the detail page, visible help text linked with aria-describedby.
 * @module views/subscribeButton
 */
import { createElementTree } from "../dom.js";

export const SUBSCRIBE_LABEL = "Subscribe";
export const SUBSCRIBED_LABEL = "Subscribed ✓";

/** Shown as a tooltip on every Subscribe button and as help text on the detail page. */
export const SUBSCRIPTION_PRIVACY_NOTE =
  "Subscriptions are public: each one is saved as a record on your Bluesky account " +
  "(your PDS), like everything on the AT Protocol.";

/** Extra tooltip text while subscribed. */
export const UNSUBSCRIBE_HINT = "Click to unsubscribe.";

/** id of the detail page's visible privacy note (target of aria-describedby). */
export const PRIVACY_NOTE_ID = "subscribe-privacy-note";

/** CSS modifier per button variant when not subscribed. */
const VARIANT_CLASS = Object.freeze({ primary: "btn--primary", plain: "" });

/**
 * @typedef {object} SubscribeButtonOpts
 * @property {boolean} [subscribed]
 * @property {boolean} [ended] the event is over (button hidden unless subscribed)
 * @property {(event: object) => void} [onToggle] receives the EventView
 * @property {"primary"|"plain"} [variant] look when not subscribed (default "primary")
 * @property {Record<string, string>} [dataset] extra data-* attributes
 * @property {string} [describedBy] id of visible help text
 */

/**
 * Render the toggle for one event, or null when it should not be shown.
 * @param {object} event EventView (passed back to onToggle, so it keeps its cid)
 * @param {SubscribeButtonOpts} [options]
 * @returns {HTMLButtonElement|null}
 */
export function renderSubscribeButton(event, options = {}) {
  const subscribed = Boolean(options.subscribed);
  if (options.ended && !subscribed) return null;
  const variant = VARIANT_CLASS[options.variant] ?? VARIANT_CLASS.primary;
  return createElementTree(
    "button",
    {
      type: "button",
      class: `btn ${subscribed ? "btn--on" : variant}`.trim(),
      "aria-pressed": String(subscribed),
      title: subscribed
        ? `${UNSUBSCRIBE_HINT} ${SUBSCRIPTION_PRIVACY_NOTE}`
        : SUBSCRIPTION_PRIVACY_NOTE,
      "aria-describedby": options.describedBy,
      dataset: { action: "subscribe", ...options.dataset },
      onclick: () => options.onToggle?.(event),
    },
    subscribed ? SUBSCRIBED_LABEL : SUBSCRIBE_LABEL,
  );
}

/**
 * Visible privacy help text (detail page).
 * @param {string} [id]
 * @returns {HTMLElement}
 */
export const renderPrivacyNote = (id = PRIVACY_NOTE_ID) =>
  createElementTree(
    "p",
    { id, class: "hint detail__privacy" },
    SUBSCRIPTION_PRIVACY_NOTE,
  );
