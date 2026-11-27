/**
 * Tiny DOM helpers. All user content goes through text nodes, never innerHTML.
 * @module dom
 */

const DOM_PROPERTY_NAMES = new Set([
  "value",
  "checked",
  "selected",
  "disabled",
  "hidden",
  "open",
]);

/**
 * Create an element. Strings/numbers become text nodes (auto-escaped).
 * @param {string} tag
 * @param {Object<string, any>} [props] attributes; `class`, `dataset`, `onX` handlers supported
 * @param {...any} children nodes, strings, arrays, or null/false (skipped)
 * @returns {HTMLElement}
 */
export function createElementTree(tag, props, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {}))
    setProp(element, key, value);
  append(element, children);
  return element;
}

function setProp(element, key, value) {
  if (value == null || value === false) return;
  if (key === "class") element.className = value;
  else if (key === "dataset") Object.assign(element.dataset, value);
  else if (key.startsWith("on") && typeof value === "function") {
    element.addEventListener(key.slice(2).toLowerCase(), value);
  } else if (DOM_PROPERTY_NAMES.has(key)) element[key] = value;
  else element.setAttribute(key, value === true ? "" : String(value));
}

/**
 * Append children (flattening arrays, skipping null/false).
 * @param {Node} parent
 * @param {any[]} children
 */
export function append(parent, children) {
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    parent.append(
      child instanceof Node ? child : document.createTextNode(String(child)),
    );
  }
}

/**
 * Return `url` only if it is an absolute http(s) URL, else null (blocks javascript: etc).
 * @param {string} url
 * @returns {string|null}
 */
export function safeHttpUrl(url) {
  try {
    const parsedUrl = new URL(url);
    return parsedUrl.protocol === "http:" || parsedUrl.protocol === "https:"
      ? parsedUrl.href
      : null;
  } catch {
    return null;
  }
}

/**
 * Open a <dialog> modally, with a fallback for environments lacking showModal.
 * @param {HTMLDialogElement} dialog
 */
export function openDialog(dialog) {
  if (!dialog.isConnected) document.body.append(dialog);
  if (typeof dialog.showModal === "function") {
    if (!dialog.open) dialog.showModal();
  } else dialog.setAttribute("open", "");
}

/**
 * Close a <dialog> (with fallback).
 * @param {HTMLDialogElement} dialog
 */
export function closeDialog(dialog) {
  if (typeof dialog.close === "function") dialog.close();
  else dialog.removeAttribute("open");
}
