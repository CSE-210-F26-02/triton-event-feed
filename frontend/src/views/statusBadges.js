/**
 * Status badges ("Happening now", "Ending soon", "Ended") shared by the event card
 * (listView) and the event detail pane (detailView), so both always agree.
 * @module views/statusBadges
 */
import { createElementTree } from "../dom.js";
import { statusBadges } from "../format.js";

/**
 * Render the status badge elements for an EventView.status.
 * @param {string|undefined} status e.g. from format.displayStatus
 * @returns {HTMLElement[]} one `<span class="badge badge--<modifier>">` per badge;
 *   empty for "upcoming" or an unknown status
 */
export function renderStatusBadges(status) {
  return statusBadges(status).map((badge) =>
    createElementTree(
      "span",
      { class: `badge badge--${badge.modifier}` },
      badge.label,
    ),
  );
}
