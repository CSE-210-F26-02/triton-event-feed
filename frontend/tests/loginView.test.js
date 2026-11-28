import { describe, expect, it, vi } from "vitest";
import { createLoginView } from "../src/views/loginView.js";

const flush = () => new Promise((resolveFlush) => setTimeout(resolveFlush, 0));

/** Fill in and submit the dialog's form. */
async function submit(dialog, id = "alice.test", password = "pw") {
  const form = dialog.querySelector("form");
  form.elements.identifier.value = id;
  form.elements.password.value = password;
  form.dispatchEvent(new Event("submit", { cancelable: true }));
  await flush();
}

describe("loginView", () => {
  it("shows the reason it was opened for", () => {
    const view = createLoginView({ login: vi.fn() });
    view.open({ reason: "Log in to subscribe to this event." });
    expect(view.element.querySelector("#login-reason").textContent).toBe(
      "Log in to subscribe to this event.",
    );
    view.open();
    expect(view.element.querySelector("#login-reason")).toBeNull();
  });

  it("never shows stray text such as 'undefined' when there is no reason", () => {
    const view = createLoginView({ login: vi.fn() });
    for (const request of [
      undefined,
      {},
      { reason: "" },
      { reason: "   " },
      { reason: 42 },
    ]) {
      view.open(request);
      expect(view.element.querySelector("#login-reason")).toBeNull();
      expect(view.element.textContent).not.toMatch(/undefined|null|false|42/);
      // Only element children: the title, then the form.
      const childNodes = [...view.element.childNodes];
      expect(
        childNodes.every((node) => node.nodeType === Node.ELEMENT_NODE),
      ).toBe(true);
      expect(childNodes.map((node) => node.tagName)).toEqual(["H2", "FORM"]);
    }
  });

  it("trims the reason before showing it", () => {
    const view = createLoginView({ login: vi.fn() });
    view.open({ reason: "  Log in to see your subscriptions.  " });
    expect(view.element.querySelector("#login-reason").textContent).toBe(
      "Log in to see your subscriptions.",
    );
  });

  it("runs the global, then the per-open callback after a successful login", async () => {
    const order = [];
    const view = createLoginView({
      login: vi.fn(async () => {}),
      onLoggedIn: async () => order.push("global"),
    });
    view.open({ onLoggedIn: () => order.push("this open") });
    await submit(view.element);
    expect(order).toEqual(["global", "this open"]);
  });

  it("does not run callbacks when login fails, and shows the error", async () => {
    const onLoggedIn = vi.fn();
    const afterThis = vi.fn();
    const view = createLoginView({
      login: vi.fn(async () => {
        throw new Error("Invalid password");
      }),
      onLoggedIn,
    });
    view.open({ onLoggedIn: afterThis });
    await submit(view.element);
    expect(view.element.textContent).toContain(
      "Login failed: Invalid password",
    );
    expect(onLoggedIn).not.toHaveBeenCalled();
    expect(afterThis).not.toHaveBeenCalled();
    expect(view.element.querySelector("button[type=submit]").disabled).toBe(
      false,
    );
  });

  it("forgets a previous open's callback when reopened", async () => {
    const firstCallback = vi.fn();
    const view = createLoginView({ login: vi.fn(async () => {}) });
    view.open({ onLoggedIn: firstCallback });
    view.open(); // e.g. cancelled, then opened from the header
    await submit(view.element);
    expect(firstCallback).not.toHaveBeenCalled();
  });
});
