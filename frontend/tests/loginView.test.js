import { describe, expect, it, vi } from "vitest";
import { createLoginView } from "../src/views/loginView.js";

const flush = () => new Promise((r) => setTimeout(r, 0));

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
    const first = vi.fn();
    const view = createLoginView({ login: vi.fn(async () => {}) });
    view.open({ onLoggedIn: first });
    view.open(); // e.g. cancelled, then opened from the header
    await submit(view.element);
    expect(first).not.toHaveBeenCalled();
  });
});
