import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  EMPTY_LIST_MESSAGE,
  NEWEST_SECTION_TITLE,
  createListView,
  renderCard,
} from "../src/views/listView.js";
import {
  SUBSCRIBED_LABEL,
  SUBSCRIBE_LABEL,
  SUBSCRIPTION_PRIVACY_NOTE,
} from "../src/views/subscribeButton.js";

/** Before sampleEvent() ends, so its Subscribe button is shown. */
const BEFORE_SAMPLE_ENDS = new Date("2026-11-11T12:00:00Z");
/** After sampleEvent() ended. */
const AFTER_SAMPLE_ENDS = new Date("2026-11-12T00:00:00Z");
import fullFixture from "../../fixtures/event/valid/full.json";
import { lexiconEventView, sampleEvent } from "./helpers.js";

describe("renderCard", () => {
  it("labels a lexicon strongRef group with its record key and keeps its URI", () => {
    const card = renderCard(lexiconEventView(fullFixture.record));
    const group = card.querySelector(".card__group");
    expect(group.textContent).toBe("3lbxq7k2mzs2a");
    expect(group.dataset.groupUri).toBe(fullFixture.record.group.uri);
    expect(card.textContent).not.toContain("[object Object]");
  });

  it("omits the group line when the group is missing or unusable", () => {
    for (const group of [undefined, "", { cid: "bafy" }, 12]) {
      expect(
        renderCard(sampleEvent({ group })).querySelector(".card__group"),
      ).toBeNull();
    }
  });

  it("renders name, time, OSM pin link, group, tags, subscribe toggle", () => {
    const card = renderCard(sampleEvent(), {
      timeZone: "America/Los_Angeles",
      locale: "en-US",
      now: BEFORE_SAMPLE_ENDS,
    });
    expect(card.querySelector("h3").textContent).toBe("Taco Tuesday");
    expect(card.querySelector("time").getAttribute("datetime")).toBe(
      "2026-11-11T19:00:00Z",
    );
    expect(card.querySelector("time").textContent).toBe("11:00 AM – 1:00 PM");
    const locationLink = card.querySelector(".card__loc a");
    expect(locationLink.href).toContain(
      "openstreetmap.org/?mlat=32.8797&mlon=-117.2362",
    );
    expect(locationLink.rel).toContain("noopener");
    expect(card.textContent).toContain("Triton Eats");
    expect(
      [...card.querySelectorAll(".chip")].map((chip) => chip.textContent),
    ).toEqual(["#food", "#free"]);
    const subscribeButton = card.querySelector("[aria-pressed]:not(.chip)");
    expect(subscribeButton.textContent).toBe(SUBSCRIBE_LABEL);
    expect(subscribeButton.dataset.action).toBe("subscribe");
    expect(subscribeButton.title).toBe(SUBSCRIPTION_PRIVACY_NOTE);
  });

  it("falls back to address search when no coordinates", () => {
    const card = renderCard(
      sampleEvent({ location: { name: "Geisel", address: "9500 Gilman Dr" } }),
    );
    expect(card.querySelector(".card__loc a").href).toBe(
      "https://www.openstreetmap.org/search?query=9500%20Gilman%20Dr",
    );
  });

  it("shows status badges, updated marker and subscribed state", () => {
    const event = sampleEvent({
      status: "ending_soon",
      updatedAt: "2026-11-10T05:00:00Z",
    });
    const card = renderCard(event, {
      subscribed: new Set([event.uri]),
      now: BEFORE_SAMPLE_ENDS,
    });
    const badges = [...card.querySelectorAll(".badge")].map(
      (badge) => badge.textContent,
    );
    // An event that is ending soon is still happening, so it gets both badges.
    expect(badges).toEqual(["Happening now", "Ending soon", "Updated"]);
    expect(card.querySelector(".btn").getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(
      renderCard(sampleEvent({ status: "live" }), {
        now: BEFORE_SAMPLE_ENDS,
      }).querySelector(".badge").textContent,
    ).toBe("Happening now");
  });

  it("shows no status badge for upcoming events", () => {
    const card = renderCard(sampleEvent({ status: "upcoming" }), {
      now: BEFORE_SAMPLE_ENDS,
    });
    expect(card.querySelector(".badge--live")).toBeNull();
    expect(card.querySelector(".badge--ended")).toBeNull();
  });

  it("badges ended events as Ended, from the AppView status or the end time", () => {
    const markedEnded = renderCard(sampleEvent({ status: "ended" }), {
      now: BEFORE_SAMPLE_ENDS,
    });
    expect(markedEnded.querySelector(".badge--ended").textContent).toBe(
      "Ended",
    );
    // Not yet marked by the AppView, but its end time has passed.
    const pastEndTime = renderCard(sampleEvent({ status: "live" }), {
      now: AFTER_SAMPLE_ENDS,
    });
    expect(pastEndTime.querySelector(".badge--ended")).not.toBeNull();
    expect(pastEndTime.querySelector(".badge--live")).toBeNull();
  });

  it("escapes user content", () => {
    const card = renderCard(
      sampleEvent({ name: "<script>x</script>", group: "<b>g</b>" }),
    );
    expect(card.querySelector("script")).toBeNull();
    expect(card.querySelector("b")).toBeNull();
    expect(card.querySelector("h3").textContent).toBe("<script>x</script>");
  });

  it("fires tag, open and subscribe callbacks", () => {
    const onTagClick = vi.fn();
    const onOpen = vi.fn();
    const onToggleSubscribe = vi.fn();
    const event = sampleEvent();
    const card = renderCard(event, {
      onTagClick,
      onOpen,
      onToggleSubscribe,
      activeTags: ["food"],
      now: BEFORE_SAMPLE_ENDS,
    });
    const chip = card.querySelector(".chip");
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    chip.click();
    card.querySelector("h3 button").click();
    card.querySelector(".card__actions button").click();
    expect(onTagClick).toHaveBeenCalledWith("food");
    expect(onOpen).toHaveBeenCalledWith(event.uri);
    // The whole EventView is passed, so the subscription record can use its cid.
    expect(onToggleSubscribe).toHaveBeenCalledWith(event);
  });

  it("hides Subscribe on ended events, but keeps Subscribed ✓ so you can unsubscribe", () => {
    const event = sampleEvent();
    expect(
      renderCard(event, { now: AFTER_SAMPLE_ENDS }).querySelector(
        "[data-action=subscribe]",
      ),
    ).toBeNull();
    const subscribed = renderCard(event, {
      now: AFTER_SAMPLE_ENDS,
      subscribed: new Set([event.uri]),
    }).querySelector("[data-action=subscribe]");
    expect(subscribed.textContent).toBe(SUBSCRIBED_LABEL);
  });

  it("prefixes title ids so the same event can appear twice on a page", () => {
    const event = sampleEvent();
    const feedId = renderCard(event).querySelector("h3").id;
    const otherId = renderCard(event, { idPrefix: "sub" }).querySelector(
      "h3",
    ).id;
    expect(feedId).toMatch(/^ev-/);
    expect(otherId).toMatch(/^sub-/);
    expect(otherId).not.toBe(feedId);
  });
});

describe("createListView", () => {
  let root;
  beforeEach(() => {
    document.body.innerHTML = '<div id="r"></div>';
    root = document.getElementById("r");
  });
  const now = new Date(2026, 10, 11, 8);
  const makeEvent = (eventNumber, day) =>
    sampleEvent({
      uri: `at://d/c/${eventNumber}`,
      name: `E${eventNumber}`,
      startsAt: new Date(2026, 10, day, 10).toISOString(),
      endsAt: new Date(2026, 10, day, 11).toISOString(),
    });

  it("groups cards by day with headings", () => {
    createListView(root, { IntersectionObserverImpl: null }).render({
      events: [makeEvent(1, 11), makeEvent(2, 12), makeEvent(3, 12)],
      now,
    });
    expect(
      [...root.querySelectorAll("h2")].map((heading) => heading.textContent),
    ).toEqual(["Today", "Tomorrow"]);
    expect(
      root.querySelectorAll("section")[1].querySelectorAll("article"),
    ).toHaveLength(2);
  });

  it("shows the empty state", () => {
    createListView(root, { IntersectionObserverImpl: null }).render({
      events: [],
      now,
    });
    expect(root.querySelector(".empty").textContent).toBe(EMPTY_LIST_MESSAGE);
  });

  it("shows the empty state for the newest order too", () => {
    createListView(root, { IntersectionObserverImpl: null }).render({
      events: [],
      now,
      sort: "newest",
    });
    expect(root.querySelector(".empty")).not.toBeNull();
    expect(root.querySelector("section")).toBeNull();
  });

  it("newest order keeps the AppView order in one section without day headings", () => {
    createListView(root, { IntersectionObserverImpl: null }).render({
      events: [makeEvent(3, 12), makeEvent(1, 11), makeEvent(2, 12)],
      now,
      sort: "newest",
    });
    const sections = root.querySelectorAll("section");
    expect(sections).toHaveLength(1);
    expect(sections[0].querySelector("h2").textContent).toBe(
      NEWEST_SECTION_TITLE,
    );
    expect(
      [...sections[0].querySelectorAll("h3")].map((title) => title.textContent),
    ).toEqual(["E3", "E1", "E2"]);
  });

  it("groups by day for the soonest order and for unknown or missing orders", () => {
    for (const sort of ["soonest", "bogus", undefined, null]) {
      createListView(root, { IntersectionObserverImpl: null }).render({
        events: [makeEvent(1, 11), makeEvent(2, 12)],
        now,
        sort,
      });
      expect(
        [...root.querySelectorAll("h2")].map((heading) => heading.textContent),
      ).toEqual(["Today", "Tomorrow"]);
    }
  });

  it("shows the stale/offline banner and errors", () => {
    const listView = createListView(root, { IntersectionObserverImpl: null });
    listView.render({
      events: [makeEvent(1, 11)],
      stale: true,
      savedAt: Date.now(),
      now,
    });
    expect(root.querySelector(".notice--stale").textContent).toMatch(/offline/);
    listView.render({ events: [], error: "Boom", now });
    expect(root.querySelector("[role=alert]").textContent).toBe("Boom");
    expect(root.querySelector(".empty")).toBeNull();
  });

  it("Load more button and IntersectionObserver call onLoadMore (not while loading)", () => {
    let observerCallback;
    const observe = vi.fn();
    class FakeIntersectionObserver {
      constructor(callback) {
        observerCallback = callback;
      }
      observe(observedElement) {
        observe(observedElement);
      }
      disconnect() {}
    }
    const onLoadMore = vi.fn();
    const listView = createListView(root, {
      onLoadMore,
      IntersectionObserverImpl: FakeIntersectionObserver,
    });
    listView.render({ events: [makeEvent(1, 11)], hasMore: true, now });
    const button = root.querySelector(".load-more");
    expect(observe).toHaveBeenCalledWith(button);
    button.click();
    observerCallback([{ isIntersecting: true }]);
    expect(onLoadMore).toHaveBeenCalledTimes(2);
    listView.render({
      events: [makeEvent(1, 11)],
      hasMore: true,
      loading: true,
      now,
    });
    observerCallback([{ isIntersecting: true }]);
    expect(onLoadMore).toHaveBeenCalledTimes(2);
    expect(root.querySelector(".load-more").disabled).toBe(true);
  });

  it("restores focus to the same control after re-render", () => {
    const listView = createListView(root, { IntersectionObserverImpl: null });
    const event = makeEvent(1, 11);
    listView.render({ events: [event], now });
    root.querySelector(".card__actions button").focus();
    listView.render({ events: [event], subscribed: new Set([event.uri]), now });
    expect(document.activeElement.textContent).toBe(SUBSCRIBED_LABEL);
  });
});
