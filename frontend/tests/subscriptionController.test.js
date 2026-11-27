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
  const dependencies = {
    subscriptions,
    notifications: { askPermissionOnce: vi.fn(async () => {}) },
    toast: vi.fn(),
    isLoggedIn: () => state.loggedIn,
    requestLogin: vi.fn(),
    openEvent: vi.fn(),
  };
  return {
    state,
    deps: dependencies,
    controller: createSubscriptionController(dependencies),
  };
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
    const { controller, deps: dependencies } = setup();
    await expect(controller.toggle(EVENT)).resolves.toBe(true);
    expect(dependencies.subscriptions.toggle).toHaveBeenCalledWith(EVENT);
    expect(dependencies.toast).toHaveBeenCalledWith(SUBSCRIBED_TOAST);
    expect(dependencies.notifications.askPermissionOnce).toHaveBeenCalled();
    await expect(controller.toggle(EVENT)).resolves.toBe(false);
    expect(dependencies.toast).toHaveBeenLastCalledWith(UNSUBSCRIBED_TOAST);
  });

  it("toasts errors and resolves to null", async () => {
    const { controller, deps: dependencies } = setup();
    dependencies.subscriptions.toggle.mockRejectedValueOnce(
      new Error("offline"),
    );
    await expect(controller.toggle(EVENT)).resolves.toBeNull();
    expect(dependencies.toast).toHaveBeenCalledWith(NETWORK_FAILED_TOAST, {
      kind: "error",
    });
  });

  it("asks a logged-out user to log in, and changes nothing yet", async () => {
    const { controller, deps: dependencies } = setup({ loggedIn: false });
    await expect(controller.toggle(EVENT)).resolves.toBeNull();
    expect(dependencies.requestLogin).toHaveBeenCalledWith({
      reason: LOGIN_TO_SUBSCRIBE_REASON,
      onLoggedIn: expect.any(Function),
    });
    expect(dependencies.subscriptions.toggle).not.toHaveBeenCalled();
  });

  it("after login: returns to the event, reloads, then subscribes", async () => {
    const {
      controller,
      deps: dependencies,
      state,
    } = setup({ loggedIn: false });
    await controller.toggle(EVENT);
    state.loggedIn = true;
    await dependencies.requestLogin.mock.calls[0][0].onLoggedIn();
    expect(dependencies.openEvent).toHaveBeenCalledWith(EVENT.uri);
    expect(dependencies.subscriptions.load).toHaveBeenCalled();
    expect(dependencies.subscriptions.subscribe).toHaveBeenCalledWith(EVENT);
  });

  it("after login: never unsubscribes someone already subscribed elsewhere", async () => {
    const {
      controller,
      deps: dependencies,
      state,
    } = setup({ loggedIn: false });
    await controller.toggle(EVENT);
    state.loggedIn = true;
    state.subscribed = true; // e.g. subscribed from their phone earlier
    await dependencies.requestLogin.mock.calls[0][0].onLoggedIn();
    expect(dependencies.subscriptions.subscribe).not.toHaveBeenCalled();
    expect(dependencies.subscriptions.unsubscribe).not.toHaveBeenCalled();
    expect(dependencies.subscriptions.toggle).not.toHaveBeenCalled();
  });

  it("after login: stops if the subscriptions can't be loaded", async () => {
    const {
      controller,
      deps: dependencies,
      state,
    } = setup({ loggedIn: false });
    await controller.toggle(EVENT);
    state.loggedIn = true;
    dependencies.subscriptions.load.mockRejectedValueOnce(new Error("offline"));
    await dependencies.requestLogin.mock.calls[0][0].onLoggedIn();
    expect(dependencies.toast).toHaveBeenCalledWith(LOAD_FAILED_TOAST, {
      kind: "error",
    });
    expect(dependencies.subscriptions.subscribe).not.toHaveBeenCalled();
  });

  it("reload() resolves to whether loading worked", async () => {
    const { controller, deps: dependencies } = setup();
    await expect(controller.reload()).resolves.toBe(true);
    dependencies.subscriptions.load.mockRejectedValueOnce(new Error("offline"));
    await expect(controller.reload()).resolves.toBe(false);
  });

  it("unsubscribe(uri) works by URI, and is a no-op when logged out", async () => {
    const {
      controller,
      deps: dependencies,
      state,
    } = setup({ subscribed: true });
    await expect(controller.unsubscribe(EVENT.uri)).resolves.toBe(false);
    expect(dependencies.subscriptions.unsubscribe).toHaveBeenCalledWith(
      EVENT.uri,
    );
    state.loggedIn = false;
    await expect(controller.unsubscribe(EVENT.uri)).resolves.toBeNull();
    expect(dependencies.subscriptions.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("works without a notifications client", async () => {
    const { deps: dependencies } = setup();
    const controller = createSubscriptionController({
      ...dependencies,
      notifications: undefined,
    });
    await expect(controller.toggle(EVENT)).resolves.toBe(true);
  });
});
