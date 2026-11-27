/**
 * Accessible toast messages rendered into an aria-live region.
 * @module toast
 */
import { createElementTree } from "./dom.js";

/**
 * @param {HTMLElement} liveRegion element with aria-live="polite"
 * @param {{timeoutMs?: number}} [options]
 * @returns {(message: string, options?: {kind?: 'info'|'error'}) => void}
 */
export function createToaster(liveRegion, { timeoutMs = 5000 } = {}) {
  return (message, { kind = "info" } = {}) => {
    const toastElement = createElementTree(
      "div",
      { class: `toast toast--${kind}` },
      message,
    );
    liveRegion.append(toastElement);
    setTimeout(() => toastElement.remove(), timeoutMs);
  };
}
