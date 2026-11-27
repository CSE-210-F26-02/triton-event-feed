import { describe, expect, it, vi } from "vitest";
import fullFixture from "../../fixtures/event/valid/full.json";
import {
  EMPTY_TEXT,
  LOGGED_OUT_TEXT,
  UNAVAILABLE_TITLE,
  createSubscriptionsView,
  loadSubscribedEvent,
  partitionSubscriptions,
} from "../src/views/subscriptionsView.js";
import { SUBSCRIBED_LABEL } from "../src/views/subscribeButton.js";
import { lexiconEventView } from "./helpers.js";

const NOW = new Date("2026-12-01T00:00:00Z");
const uriOf = (rkey) => `at://did:plc:host/app.communitymap.event/${rkey}`;

/** An upcoming event (full fixture) with its own URI and start time. */
const upcoming = (rkey, startsAt, name = rkey) =>
  lexiconEventView(fullFixture.record, {
    uri: uriOf(rkey),
    name,
    startsAt,
    endsAt: "2026-12-20T00:00:00.000Z",
  });
const ended = (rkey) =>
  lexiconEventView(fullFixture.record, {
    uri: uriOf(rkey),
    startsAt: "2026-11-01T00:00:00.000Z",
    endsAt: "2026-11-02T00:00:00.000Z",
  });

describe("partitionSubscriptions", () => {
  it("lists upcoming events soonest first and drops ended ones", () => {
    const later = upcoming("b", "2026-12-10T00:00:00.000Z");
    const sooner = upcoming("a", "2026-12-05T00:00:00.000Z");
    const loaded = new Map([
      [later.uri, { event: later }],
      [sooner.uri, { event: sooner }],
      [uriOf("old"), { event: ended("old") }],
    ]);
    const parts = partitionSubscriptions(
      [later.uri, sooner.uri, uriOf("old")],
      loaded,
      NOW,
    );
    expect(parts.upcoming.map((ev) => ev.uri)).toEqual([sooner.uri, later.uri]);
    expect(parts).toMatchObject({ unavailable: [], loading: 0 });
  });

  it("separates unavailable (gone / failed) and still-loading URIs", () => {
    const loaded = new Map([
      [uriOf("gone"), { gone: true }],
      [uriOf("failed"), { failed: true }],
    ]);
    const parts = partitionSubscriptions(
      [uriOf("gone"), uriOf("failed"), uriOf("pending")],
      loaded,
      NOW,
    );
    expect(parts).toEqual({
      upcoming: [],
      unavailable: [uriOf("gone"), uriOf("failed")],
      loading: 1,
    });
  });

  it("puts events with unusable start times last", () => {
    const broken = upcoming("x", "whenever");
    const fine = upcoming("y", "2026-12-05T00:00:00.000Z");
    const loaded = new Map([
      [broken.uri, { event: broken }],
      [fine.uri, { event: fine }],
    ]);
    expect(
      partitionSubscriptions([broken.uri, fine.uri], loaded, NOW).upcoming.map(
        (ev) => ev.uri,
      ),
    ).toEqual([fine.uri, broken.uri]);
  });
});

describe("loadSubscribedEvent", () => {
  const event = upcoming("a", "2026-12-05T00:00:00.000Z");

  it("uses the feed copy without a request when there is one", async () => {
    const api = { getEvent: vi.fn() };
    await expect(
      loadSubscribedEvent(event.uri, { api, findEvent: () => event }),
    ).resolves.toEqual({ event });
    expect(api.getEvent).not.toHaveBeenCalled();
  });

  it("falls back to GET /api/event and fills in a missing URI", async () => {
    const { uri: _uri, ...withoutUri } = event;
    const api = { getEvent: vi.fn(async () => ({ data: withoutUri })) };
    const entry = await loadSubscribedEvent(event.uri, {
      api,
      findEvent: () => null,
    });
    expect(entry.event.uri).toBe(event.uri);
  });

  it.each([
    ["404", { status: 404 }, { gone: true }],
    ["400", { status: 400 }, { gone: true }],
    ["503", { status: 503 }, { failed: true }],
    ["offline", new Error("offline"), { failed: true }],
  ])("maps a %s error", async (_label, error, expected) => {
    const api = {
      getEvent: vi.fn(async () => {
        throw error;
      }),
    };
    await expect(
      loadSubscribedEvent(event.uri, { api, findEvent: () => null }),
    ).resolves.toEqual(expected);
  });

  it.each([null, "event", [], undefined])(
    "treats a non-object response (%j) as gone",
    async (data) => {
      const api = { getEvent: vi.fn(async () => ({ data })) };
      await expect(
        loadSubscribedEvent(event.uri, { api, findEvent: () => null }),
      ).resolves.toEqual({ gone: true });
    },
  );
});

describe("createSubscriptionsView", () => {
  /** Controller over a fake API that serves `events` by URI. */
  function setup({ events = [], subscribed = [], loggedIn = true } = {}) {
    const root = document.createElement("div");
    document.body.replaceChildren(root);
    const state = { subscribed: new Set(subscribed), loggedIn };
    const byUri = new Map(events.map((ev) => [ev.uri, ev]));
    const deps = {
      api: {
        getEvent: vi.fn(async (uri) => {
          if (byUri.has(uri)) return { data: byUri.get(uri) };
          throw Object.assign(new Error("nf"), { status: 404 });
        }),
      },
      getSubscribed: () => state.subscribed,
      isLoggedIn: () => state.loggedIn,
      onLogin: vi.fn(),
      onClose: vi.fn(),
      onOpen: vi.fn(),
      onToggleSubscribe: vi.fn(),
      onUnsubscribe: vi.fn(),
      now: () => NOW,
    };
    return { root, state, deps, view: createSubscriptionsView(root, deps) };
  }

  const titles = (root) =>
    [...root.querySelectorAll(".card h3")].map((h) => h.textContent);

  it("lists subscribed upcoming events with Subscribed ✓ toggles", async () => {
    const a = upcoming("a", "2026-12-05T00:00:00.000Z", "Taco night");
    const { root, view, deps } = setup({ events: [a], subscribed: [a.uri] });
    await view.open();
    expect(root.querySelector("#subscriptions-title").textContent).toBe(
      "My subscriptions",
    );
    expect(document.activeElement).toBe(
      root.querySelector("#subscriptions-title"),
    );
    expect(titles(root)).toEqual(["Taco night"]);
    const toggle = root.querySelector("[data-action=subscribe]");
    expect(toggle.textContent).toBe(SUBSCRIBED_LABEL);
    toggle.click();
    expect(deps.onToggleSubscribe).toHaveBeenCalledWith(a);
    expect(root.querySelector(".card h3").id).toMatch(/^sub-/);
  });

  it("shows the privacy note and the empty state", async () => {
    const { root, view } = setup();
    await view.open();
    expect(root.textContent).toContain("Subscriptions are public");
    expect(root.querySelector(".empty").textContent).toBe(EMPTY_TEXT);
  });

  it("asks logged-out users to log in, without fetching", async () => {
    const { root, view, deps } = setup({
      loggedIn: false,
      subscribed: [uriOf("a")],
    });
    await view.open();
    expect(root.textContent).toContain(LOGGED_OUT_TEXT);
    root.querySelector("[data-action=login]").click();
    expect(deps.onLogin).toHaveBeenCalled();
    expect(deps.api.getEvent).not.toHaveBeenCalled();
  });

  it("lists events that couldn't be loaded, with an Unsubscribe button", async () => {
    const { root, view, deps } = setup({ subscribed: [uriOf("deleted")] });
    await view.open();
    expect(root.textContent).toContain(UNAVAILABLE_TITLE);
    root.querySelector("[data-action=unsubscribe]").click();
    expect(deps.onUnsubscribe).toHaveBeenCalledWith(uriOf("deleted"));
    root.querySelector(".subscriptions__unavailable .linklike").click();
    expect(deps.onOpen).toHaveBeenCalledWith(uriOf("deleted"));
  });

  it("hides ended events (the page lists upcoming events)", async () => {
    const old = ended("old");
    const { root, view } = setup({ events: [old], subscribed: [old.uri] });
    await view.open();
    expect(titles(root)).toEqual([]);
    expect(root.querySelector(".empty")).not.toBeNull();
  });

  it("refresh() drops unsubscribed events without refetching the rest", async () => {
    const a = upcoming("a", "2026-12-05T00:00:00.000Z", "A");
    const b = upcoming("b", "2026-12-06T00:00:00.000Z", "B");
    const { root, view, deps, state } = setup({
      events: [a, b],
      subscribed: [a.uri, b.uri],
    });
    await view.open();
    expect(titles(root)).toEqual(["A", "B"]);
    state.subscribed = new Set([b.uri]);
    await view.refresh();
    expect(titles(root)).toEqual(["B"]);
    expect(deps.api.getEvent).toHaveBeenCalledTimes(2);
  });

  it("does not fetch the same event twice when refreshed mid-load", async () => {
    const a = upcoming("a", "2026-12-05T00:00:00.000Z", "A");
    const { root, view, deps } = setup({ events: [a], subscribed: [a.uri] });
    const opening = view.open();
    await view.refresh(); // e.g. a store change while the first fetch is in flight
    await opening;
    expect(deps.api.getEvent).toHaveBeenCalledTimes(1);
    expect(titles(root)).toEqual(["A"]);
  });

  it("does nothing while closed, and close() clears the pane", async () => {
    const a = upcoming("a", "2026-12-05T00:00:00.000Z");
    const { root, view, deps } = setup({ events: [a], subscribed: [a.uri] });
    await view.refresh();
    expect(root.children).toHaveLength(0);
    expect(deps.api.getEvent).not.toHaveBeenCalled();
    await view.open();
    expect(view.isOpen).toBe(true);
    view.close();
    expect(root.children).toHaveLength(0);
    expect(view.isOpen).toBe(false);
  });

  it("ignores events that arrive after the page was closed", async () => {
    const a = upcoming("a", "2026-12-05T00:00:00.000Z");
    const { root, view } = setup({ events: [a], subscribed: [a.uri] });
    const opening = view.open();
    view.close();
    await opening;
    expect(root.children).toHaveLength(0);
  });

  it("Back returns to the map", async () => {
    const { root, view, deps } = setup();
    await view.open();
    [...root.querySelectorAll("button")]
      .find((b) => b.textContent.includes("Back"))
      .click();
    expect(deps.onClose).toHaveBeenCalled();
  });
});
