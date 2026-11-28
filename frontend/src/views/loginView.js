/**
 * Login dialog (Bluesky handle + app password).
 * @module views/loginView
 */
import { closeDialog, createElementTree, openDialog } from "../dom.js";

/**
 * @typedef {object} LoginRequest
 * @property {string} [reason] why login is needed, shown above the form
 *   (e.g. "Log in to subscribe to this event.")
 * @property {() => (void|Promise<void>)} [onLoggedIn] runs once after a successful login
 *   from this dialog, after the global onLoggedIn; never runs if the dialog is cancelled
 */

/**
 * @param {{login: (identifier: string, password: string) => Promise<any>,
 *   onLoggedIn?: () => (void|Promise<void>)}} deps
 * @returns {{open(request?: LoginRequest): void, element: HTMLDialogElement}}
 */
export function createLoginView({ login, onLoggedIn }) {
  const dialog = createElementTree("dialog", {
    class: "dialog",
    "aria-labelledby": "login-title",
  });

  /** @param {LoginRequest} [request] */
  function open({ reason, onLoggedIn: afterThisLogin } = {}) {
    const status = createElementTree("p", {
      class: "form-status",
      role: "status",
    });
    const submit = createElementTree(
      "button",
      { type: "submit", class: "btn btn--gold" },
      "Log in",
    );
    const form = createElementTree(
      "form",
      { class: "compose" },
      createElementTree(
        "div",
        { class: "field" },
        createElementTree("label", { for: "l-id" }, "Bluesky handle"),
        createElementTree("input", {
          id: "l-id",
          name: "identifier",
          required: true,
          autocomplete: "username",
          autocapitalize: "none",
          placeholder: "you.bsky.social",
        }),
      ),
      createElementTree(
        "div",
        { class: "field" },
        createElementTree("label", { for: "l-pw" }, "App password"),
        createElementTree(
          "p",
          { class: "hint", id: "l-pw-hint" },
          "Create one in Bluesky → Settings → Privacy and security → App passwords. Never use your main password.",
        ),
        createElementTree("input", {
          id: "l-pw",
          name: "password",
          type: "password",
          required: true,
          autocomplete: "current-password",
          "aria-describedby": "l-pw-hint",
        }),
      ),
      status,
      createElementTree(
        "div",
        { class: "card__actions" },
        submit,
        createElementTree(
          "button",
          { type: "button", class: "btn", onclick: () => closeDialog(dialog) },
          "Cancel",
        ),
      ),
    );
    form.addEventListener("submit", async (submitEvent) => {
      submitEvent.preventDefault();
      submit.disabled = true;
      status.textContent = "Logging in…";
      try {
        await login(
          form.elements.identifier.value,
          form.elements.password.value,
        );
      } catch (error) {
        status.textContent = `Login failed: ${error.message}`;
        return;
      } finally {
        submit.disabled = false;
      }
      closeDialog(dialog);
      await onLoggedIn?.();
      await afterThisLogin?.();
    });
    // Native replaceChildren() turns non-node values into text, so a missing reason
    // must be left out entirely (passing `undefined` would show the word "undefined").
    const reasonNotice = renderLoginReason(reason);
    dialog.replaceChildren(
      createElementTree("h2", { id: "login-title" }, "Log in with Bluesky"),
      ...(reasonNotice ? [reasonNotice] : []),
      form,
    );
    openDialog(dialog);
  }

  return { open, element: dialog };
}

/**
 * The "why log in" line shown under the dialog title.
 * @param {unknown} reason LoginRequest.reason
 * @returns {HTMLElement|null} null when there is no reason to show (missing, not a
 *   string, or only whitespace)
 */
function renderLoginReason(reason) {
  if (typeof reason !== "string" || !reason.trim()) return null;
  return createElementTree(
    "p",
    { class: "hint", id: "login-reason" },
    reason.trim(),
  );
}
