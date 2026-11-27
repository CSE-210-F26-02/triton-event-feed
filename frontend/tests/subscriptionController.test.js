import { describe, expect, it, vi } from "vitest";
import {
  LOAD_FAILED_TOAST,
  LOGIN_TO_SUBSCRIBE_REASON,
  NETWORK_FAILED_TOAST,
  SUBSCRIBED_TOAST,
  UNSUBSCRIBED_TOAST,
  createSubscriptionController,
  subscriptionErrorMessage,
} from "../src/subscriptionController.js";
import { SUBSCRIPTION_ERROR, SubscriptionError } from "../src/subscriptions.js";

const EVENT = { uri: "at://did:plc:h/app.communitymap.event/3k", cid: "c" };

/** Controller with a fake subscription store; `loggedIn` can be flipped later. */
function setup({ loggedIn = true, subscribed = false } = {}) {
  const state = { loggedIn, subscribed };
  const subscriptions = {
    load: vi.fn(async () => {}),
    has: vi.fn(() => state.subscribed),
    subscribe: vi.fn(async () => (state.subscribed = true)),
    unsubscribe: vi.fn(async () => (state.subscribed = false)),
    toggle: vi.fn(async () => (state.subscribed = !state.subscribed)),
  };
  const deps = {
    subscriptions,
    notifications: { askPermissionOnce: vi.fn(async () => {}) },
    toast: vi.fn(),
    isLoggedIn: () => state.loggedIn,
    requestLogin: vi.fn(),
    openEvent: vi.fn(),
  };
  return { state, deps, controller: createSubscriptionController(deps) };
}

describe("subscriptionErrorMessage", () => {
  it("uses the SubscriptionError's own message", () => {
    const error = new SubscriptionError(SUBSCRIPTION_ERROR.eventEnded, "Over");
    expect(subscriptionErrorMessage(error)).toBe("Over");
  });

  it.each([new Error("fetch failed"), null, "x"])(
    "falls back to a connection message for %j",
    (error) => {
      expect(subscriptionErrorMessage(error)).toBe(NETWORK_FAILED_TOAST);
    },
  );
});

describe("createSubscriptionController", () => {
  it("toggles when logged in and toasts the result", async () => {
    const { controller, deps } = setup();
    await expect(controller.toggle(EVENT)).resolves.toBe(true);
    expect(deps.subscriptions.toggle).toHaveBeenCalledWith(EVENT);
    expect(deps.toast).toHaveBeenCalledWith(SUBSCRIBED_TOAST);
    expect(deps.notifications.askPermissionOnce).toHaveBeenCalled();
    await expect(controller.toggle(EVENT)).resolves.toBe(false);
    expect(deps.toast).toHaveBeenLastCalledWith(UNSUBSCRIBED_TOAST);
  });

  it("toasts errors and resolves to null", async () => {
    const { controller, deps } = setup();
    deps.subscriptions.toggle.mockRejectedValueOnce(new Error("offline"));
    await expect(controller.toggle(EVENT)).resolves.toBeNull();
    expect(deps.toast).toHaveBeenCalledWith(NETWORK_FAILED_TOAST, {
      kind: "error",
    });
  });

  it("asks a logged-out user to log in, and changes nothing yet", async () => {
    const { controller, deps } = setup({ loggedIn: false });
    await expect(controller.toggle(EVENT)).resolves.toBeNull();
    expect(deps.requestLogin).toHaveBeenCalledWith({
      reason: LOGIN_TO_SUBSCRIBE_REASON,
      onLoggedIn: expect.any(Function),
    });
    expect(deps.subscriptions.toggle).not.toHaveBeenCalled();
  });

  it("after login: returns to the event, reloads, then subscribes", async () => {
    const { controller, deps, state } = setup({ loggedIn: false });
    await controller.toggle(EVENT);
    state.loggedIn = true;
    await deps.requestLogin.mock.calls[0][0].onLoggedIn();
    expect(deps.openEvent).toHaveBeenCalledWith(EVENT.uri);
    expect(deps.subscriptions.load).toHaveBeenCalled();
    expect(deps.subscriptions.subscribe).toHaveBeenCalledWith(EVENT);
  });

  it("after login: never unsubscribes someone already subscribed elsewhere", async () => {
    const { controller, deps, state } = setup({ loggedIn: false });
    await controller.toggle(EVENT);
    state.loggedIn = true;
    state.subscribed = true; // e.g. subscribed from their phone earlier
    await deps.requestLogin.mock.calls[0][0].onLoggedIn();
    expect(deps.subscriptions.subscribe).not.toHaveBeenCalled();
    expect(deps.subscriptions.unsubscribe).not.toHaveBeenCalled();
    expect(deps.subscriptions.toggle).not.toHaveBeenCalled();
  });

  it("after login: stops if the subscriptions can't be loaded", async () => {
    const { controller, deps, state } = setup({ loggedIn: false });
    await controller.toggle(EVENT);
    state.loggedIn = true;
    deps.subscriptions.load.mockRejectedValueOnce(new Error("offline"));
    await deps.requestLogin.mock.calls[0][0].onLoggedIn();
    expect(deps.toast).toHaveBeenCalledWith(LOAD_FAILED_TOAST, {
      kind: "error",
    });
    expect(deps.subscriptions.subscribe).not.toHaveBeenCalled();
  });

  it("reload() resolves to whether loading worked", async () => {
    const { controller, deps } = setup();
    await expect(controller.reload()).resolves.toBe(true);
    deps.subscriptions.load.mockRejectedValueOnce(new Error("offline"));
    await expect(controller.reload()).resolves.toBe(false);
  });

  it("unsubscribe(uri) works by URI, and is a no-op when logged out", async () => {
    const { controller, deps, state } = setup({ subscribed: true });
    await expect(controller.unsubscribe(EVENT.uri)).resolves.toBe(false);
    expect(deps.subscriptions.unsubscribe).toHaveBeenCalledWith(EVENT.uri);
    state.loggedIn = false;
    await expect(controller.unsubscribe(EVENT.uri)).resolves.toBeNull();
    expect(deps.subscriptions.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("works without a notifications client", async () => {
    const { deps } = setup();
    const controller = createSubscriptionController({
      ...deps,
      notifications: undefined,
    });
    await expect(controller.toggle(EVENT)).resolves.toBe(true);
  });
});
