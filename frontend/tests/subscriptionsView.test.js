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
const eventUriFor = (recordKey) =>
  `at://did:plc:host/app.communitymap.event/${recordKey}`;

/** An upcoming event (full fixture) with its own URI and start time. */
const upcoming = (recordKey, startsAt, name = recordKey) =>
  lexiconEventView(fullFixture.record, {
    uri: eventUriFor(recordKey),
    name,
    startsAt,
    endsAt: "2026-12-20T00:00:00.000Z",
  });
const ended = (recordKey) =>
  lexiconEventView(fullFixture.record, {
    uri: eventUriFor(recordKey),
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
      [eventUriFor("old"), { event: ended("old") }],
    ]);
    const partition = partitionSubscriptions(
      [later.uri, sooner.uri, eventUriFor("old")],
      loaded,
      NOW,
    );
    expect(partition.upcoming.map((event) => event.uri)).toEqual([
      sooner.uri,
      later.uri,
    ]);
    expect(partition).toMatchObject({ unavailable: [], loading: 0 });
  });

  it("separates unavailable (gone / failed) and still-loading URIs", () => {
    const loaded = new Map([
      [eventUriFor("gone"), { gone: true }],
      [eventUriFor("failed"), { failed: true }],
    ]);
    const partition = partitionSubscriptions(
      [eventUriFor("gone"), eventUriFor("failed"), eventUriFor("pending")],
      loaded,
      NOW,
    );
    expect(partition).toEqual({
      upcoming: [],
      unavailable: [eventUriFor("gone"), eventUriFor("failed")],
      loading: 1,
    });
  });

  it("puts events with unusable start times last", () => {
    const broken = upcoming("x", "whenever");
    const datedEvent = upcoming("y", "2026-12-05T00:00:00.000Z");
    const loaded = new Map([
      [broken.uri, { event: broken }],
      [datedEvent.uri, { event: datedEvent }],
    ]);
    expect(
      partitionSubscriptions(
        [broken.uri, datedEvent.uri],
        loaded,
        NOW,
      ).upcoming.map((event) => event.uri),
    ).toEqual([datedEvent.uri, broken.uri]);
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
    async (responseData) => {
      const api = { getEvent: vi.fn(async () => ({ data: responseData })) };
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
    const byUri = new Map(events.map((event) => [event.uri, event]));
    const dependencies = {
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
    return {
      root,
      state,
      deps: dependencies,
      view: createSubscriptionsView(root, dependencies),
    };
  }

  const titles = (root) =>
    [...root.querySelectorAll(".card h3")].map(
      (heading) => heading.textContent,
    );

  it("lists subscribed upcoming events with Subscribed ✓ toggles", async () => {
    const tacoNight = upcoming("a", "2026-12-05T00:00:00.000Z", "Taco night");
    const {
      root,
      view,
      deps: dependencies,
    } = setup({
      events: [tacoNight],
      subscribed: [tacoNight.uri],
    });
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
    expect(dependencies.onToggleSubscribe).toHaveBeenCalledWith(tacoNight);
    expect(root.querySelector(".card h3").id).toMatch(/^sub-/);
  });

  it("shows the privacy note and the empty state", async () => {
    const { root, view } = setup();
    await view.open();
    expect(root.textContent).toContain("Subscriptions are public");
    expect(root.querySelector(".empty").textContent).toBe(EMPTY_TEXT);
  });

  it("asks logged-out users to log in, without fetching", async () => {
    const {
      root,
      view,
      deps: dependencies,
    } = setup({
      loggedIn: false,
      subscribed: [eventUriFor("a")],
    });
    await view.open();
    expect(root.textContent).toContain(LOGGED_OUT_TEXT);
    root.querySelector("[data-action=login]").click();
    expect(dependencies.onLogin).toHaveBeenCalled();
    expect(dependencies.api.getEvent).not.toHaveBeenCalled();
  });

  it("lists events that couldn't be loaded, with an Unsubscribe button", async () => {
    const {
      root,
      view,
      deps: dependencies,
    } = setup({ subscribed: [eventUriFor("deleted")] });
    await view.open();
    expect(root.textContent).toContain(UNAVAILABLE_TITLE);
    root.querySelector("[data-action=unsubscribe]").click();
    expect(dependencies.onUnsubscribe).toHaveBeenCalledWith(
      eventUriFor("deleted"),
    );
    root.querySelector(".subscriptions__unavailable .linklike").click();
    expect(dependencies.onOpen).toHaveBeenCalledWith(eventUriFor("deleted"));
  });

  it("hides ended events (the page lists upcoming events)", async () => {
    const endedEvent = ended("old");
    const { root, view } = setup({
      events: [endedEvent],
      subscribed: [endedEvent.uri],
    });
    await view.open();
    expect(titles(root)).toEqual([]);
    expect(root.querySelector(".empty")).not.toBeNull();
  });

  it("refresh() drops unsubscribed events without refetching the rest", async () => {
    const firstEvent = upcoming("a", "2026-12-05T00:00:00.000Z", "A");
    const secondEvent = upcoming("b", "2026-12-06T00:00:00.000Z", "B");
    const {
      root,
      view,
      deps: dependencies,
      state,
    } = setup({
      events: [firstEvent, secondEvent],
      subscribed: [firstEvent.uri, secondEvent.uri],
    });
    await view.open();
    expect(titles(root)).toEqual(["A", "B"]);
    state.subscribed = new Set([secondEvent.uri]);
    await view.refresh();
    expect(titles(root)).toEqual(["B"]);
    expect(dependencies.api.getEvent).toHaveBeenCalledTimes(2);
  });

  it("does not fetch the same event twice when refreshed mid-load", async () => {
    const onlyEvent = upcoming("a", "2026-12-05T00:00:00.000Z", "A");
    const {
      root,
      view,
      deps: dependencies,
    } = setup({
      events: [onlyEvent],
      subscribed: [onlyEvent.uri],
    });
    const opening = view.open();
    await view.refresh(); // e.g. a store change while the first fetch is in flight
    await opening;
    expect(dependencies.api.getEvent).toHaveBeenCalledTimes(1);
    expect(titles(root)).toEqual(["A"]);
  });

  it("does nothing while closed, and close() clears the pane", async () => {
    const onlyEvent = upcoming("a", "2026-12-05T00:00:00.000Z");
    const {
      root,
      view,
      deps: dependencies,
    } = setup({
      events: [onlyEvent],
      subscribed: [onlyEvent.uri],
    });
    await view.refresh();
    expect(root.children).toHaveLength(0);
    expect(dependencies.api.getEvent).not.toHaveBeenCalled();
    await view.open();
    expect(view.isOpen).toBe(true);
    view.close();
    expect(root.children).toHaveLength(0);
    expect(view.isOpen).toBe(false);
  });

  it("ignores events that arrive after the page was closed", async () => {
    const onlyEvent = upcoming("a", "2026-12-05T00:00:00.000Z");
    const { root, view } = setup({
      events: [onlyEvent],
      subscribed: [onlyEvent.uri],
    });
    const opening = view.open();
    view.close();
    await opening;
    expect(root.children).toHaveLength(0);
  });

  it("Back returns to the map", async () => {
    const { root, view, deps: dependencies } = setup();
    await view.open();
    [...root.querySelectorAll("button")]
      .find((button) => button.textContent.includes("Back"))
      .click();
    expect(dependencies.onClose).toHaveBeenCalled();
  });
});
