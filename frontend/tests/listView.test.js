import { beforeEach, describe, expect, it, vi } from "vitest";
import { createListView, renderCard } from "../src/views/listView.js";
import { sampleEvent } from "./helpers.js";

describe("renderCard", () => {
  it("renders name, time, OSM pin link, group, tags, subscribe toggle", () => {
    const card = renderCard(sampleEvent(), {
      timeZone: "America/Los_Angeles",
      locale: "en-US",
    });
    expect(card.querySelector("h3").textContent).toBe("Taco Tuesday");
    expect(card.querySelector("time").getAttribute("datetime")).toBe(
      "2026-11-11T19:00:00Z",
    );
    expect(card.querySelector("time").textContent).toBe("11:00 AM – 1:00 PM");
    const a = card.querySelector(".card__loc a");
    expect(a.href).toContain("openstreetmap.org/?mlat=32.8797&mlon=-117.2362");
    expect(a.rel).toContain("noopener");
    expect(card.textContent).toContain("Triton Eats");
    expect(
      [...card.querySelectorAll(".chip")].map((c) => c.textContent),
    ).toEqual(["#food", "#free"]);
    const sub = card.querySelector("[aria-pressed]:not(.chip)");
    expect(sub.textContent).toBe("Subscribe");
  });

  it("falls back to address search when no coordinates", () => {
    const card = renderCard(
      sampleEvent({ location: { name: "Geisel", address: "9500 Gilman Dr" } }),
    );
    expect(card.querySelector(".card__loc a").href).toBe(
      "https://www.openstreetmap.org/search?query=9500%20Gilman%20Dr",
    );
  });

  it("shows status badge, updated marker and subscribed state", () => {
    const ev = sampleEvent({
      status: "ending_soon",
      updatedAt: "2026-11-10T05:00:00Z",
    });
    const card = renderCard(ev, { subscribed: new Set([ev.uri]) });
    const badges = [...card.querySelectorAll(".badge")].map(
      (b) => b.textContent,
    );
    // An event that is ending soon is still happening, so it gets both badges.
    expect(badges).toEqual(["Happening now", "Ending soon", "Updated"]);
    expect(card.querySelector(".btn").getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(
      renderCard(sampleEvent({ status: "live" })).querySelector(".badge")
        .textContent,
    ).toBe("Happening now");
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
    const ev = sampleEvent();
    const card = renderCard(ev, {
      onTagClick,
      onOpen,
      onToggleSubscribe,
      activeTags: ["food"],
    });
    const chip = card.querySelector(".chip");
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    chip.click();
    card.querySelector("h3 button").click();
    card.querySelector(".card__actions button").click();
    expect(onTagClick).toHaveBeenCalledWith("food");
    expect(onOpen).toHaveBeenCalledWith(ev.uri);
    expect(onToggleSubscribe).toHaveBeenCalledWith(ev.uri);
  });
});

describe("createListView", () => {
  let root;
  beforeEach(() => {
    document.body.innerHTML = '<div id="r"></div>';
    root = document.getElementById("r");
  });
  const now = new Date(2026, 10, 11, 8);
  const ev = (i, day) =>
    sampleEvent({
      uri: `at://d/c/${i}`,
      name: `E${i}`,
      startsAt: new Date(2026, 10, day, 10).toISOString(),
      endsAt: new Date(2026, 10, day, 11).toISOString(),
    });

  it("groups cards by day with headings", () => {
    createListView(root, { IntersectionObserverImpl: null }).render({
      events: [ev(1, 11), ev(2, 12), ev(3, 12)],
      now,
    });
    expect([...root.querySelectorAll("h2")].map((x) => x.textContent)).toEqual([
      "Today",
      "Tomorrow",
    ]);
    expect(
      root.querySelectorAll("section")[1].querySelectorAll("article"),
    ).toHaveLength(2);
  });

  it("shows the empty state", () => {
    createListView(root, { IntersectionObserverImpl: null }).render({
      events: [],
      now,
    });
    expect(root.querySelector(".empty")).not.toBeNull();
  });

  it("shows the stale/offline banner and errors", () => {
    const v = createListView(root, { IntersectionObserverImpl: null });
    v.render({ events: [ev(1, 11)], stale: true, savedAt: Date.now(), now });
    expect(root.querySelector(".notice--stale").textContent).toMatch(/offline/);
    v.render({ events: [], error: "Boom", now });
    expect(root.querySelector("[role=alert]").textContent).toBe("Boom");
    expect(root.querySelector(".empty")).toBeNull();
  });

  it("Load more button and IntersectionObserver call onLoadMore (not while loading)", () => {
    let cb;
    const observe = vi.fn();
    class IO {
      constructor(fn) {
        cb = fn;
      }
      observe(el) {
        observe(el);
      }
      disconnect() {}
    }
    const onLoadMore = vi.fn();
    const v = createListView(root, {
      onLoadMore,
      IntersectionObserverImpl: IO,
    });
    v.render({ events: [ev(1, 11)], hasMore: true, now });
    const btn = root.querySelector(".load-more");
    expect(observe).toHaveBeenCalledWith(btn);
    btn.click();
    cb([{ isIntersecting: true }]);
    expect(onLoadMore).toHaveBeenCalledTimes(2);
    v.render({ events: [ev(1, 11)], hasMore: true, loading: true, now });
    cb([{ isIntersecting: true }]);
    expect(onLoadMore).toHaveBeenCalledTimes(2);
    expect(root.querySelector(".load-more").disabled).toBe(true);
  });

  it("restores focus to the same control after re-render", () => {
    const v = createListView(root, { IntersectionObserverImpl: null });
    const e = ev(1, 11);
    v.render({ events: [e], now });
    root.querySelector(".card__actions button").focus();
    v.render({ events: [e], subscribed: new Set([e.uri]), now });
    expect(document.activeElement.textContent).toBe("Subscribed");
  });
});

/**
 * The card title id hash before it switched to Math.imul, kept here as the reference
 * so the ids (used by aria-labelledby) are proven unchanged.
 * @param {string} text
 * @returns {string}
 */
function legacyHashId(text) {
  let hash = 0;
  for (let index = 0; index < text.length; index++)
    hash = (hash * 31 + text.charCodeAt(index)) | 0;
  return (hash >>> 0).toString(36);
}

describe("renderCard title ids", () => {
  it("are unchanged from the original hash, including for long URIs", () => {
    const uris = [
      "",
      "at://did:plc:abc/app.communitymap.event/3kabc",
      `ical://${"f".repeat(12)}/${"e".repeat(16)}`,
      `at://did:plc:${"x".repeat(5000)}/app.communitymap.event/${"\u00e9".repeat(50)}`,
    ];
    for (const uri of uris) {
      const card = renderCard(sampleEvent({ uri }));
      expect(card.querySelector("h3").id).toBe(`ev-${legacyHashId(uri)}`);
      expect(card.getAttribute("aria-labelledby")).toBe(
        card.querySelector("h3").id,
      );
    }
  });
});
