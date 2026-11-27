/**
 * Login dialog (Bluesky handle + app password).
 * @module views/loginView
 */
import { closeDialog, h, openDialog } from "../dom.js";

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
  const dialog = h("dialog", {
    class: "dialog",
    "aria-labelledby": "login-title",
  });

  /** @param {LoginRequest} [request] */
  function open({ reason, onLoggedIn: afterThisLogin } = {}) {
    const status = h("p", { class: "form-status", role: "status" });
    const submit = h(
      "button",
      { type: "submit", class: "btn btn--gold" },
      "Log in",
    );
    const form = h(
      "form",
      { class: "compose" },
      h(
        "div",
        { class: "field" },
        h("label", { for: "l-id" }, "Bluesky handle"),
        h("input", {
          id: "l-id",
          name: "identifier",
          required: true,
          autocomplete: "username",
          autocapitalize: "none",
          placeholder: "you.bsky.social",
        }),
      ),
      h(
        "div",
        { class: "field" },
        h("label", { for: "l-pw" }, "App password"),
        h(
          "p",
          { class: "hint", id: "l-pw-hint" },
          "Create one in Bluesky → Settings → Privacy and security → App passwords. Never use your main password.",
        ),
        h("input", {
          id: "l-pw",
          name: "password",
          type: "password",
          required: true,
          autocomplete: "current-password",
          "aria-describedby": "l-pw-hint",
        }),
      ),
      status,
      h(
        "div",
        { class: "card__actions" },
        submit,
        h(
          "button",
          { type: "button", class: "btn", onclick: () => closeDialog(dialog) },
          "Cancel",
        ),
      ),
    );
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      submit.disabled = true;
      status.textContent = "Logging in…";
      try {
        await login(
          form.elements.identifier.value,
          form.elements.password.value,
        );
      } catch (err) {
        status.textContent = `Login failed: ${err.message}`;
        return;
      } finally {
        submit.disabled = false;
      }
      closeDialog(dialog);
      await onLoggedIn?.();
      await afterThisLogin?.();
    });
    dialog.replaceChildren(
      h("h2", { id: "login-title" }, "Log in with Bluesky"),
      reason && h("p", { class: "hint", id: "login-reason" }, reason),
      form,
    );
    openDialog(dialog);
  }

  return { open, element: dialog };
}
