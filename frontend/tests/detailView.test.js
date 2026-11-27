import { describe, expect, it, vi } from "vitest";
import fullFixture from "../../fixtures/event/valid/full.json";
import minimalFixture from "../../fixtures/event/valid/minimal.json";
import missingLatFixture from "../../fixtures/event/invalid/missing-lat.json";
import { UNTITLED_EVENT_NAME } from "../src/lexicon/eventView.js";
import {
  INVALID_RECORD_NOTICE,
  TIME_NOT_SPECIFIED,
  createDetailView,
  renderActions,
  renderDetail,
  renderNotFound,
} from "../src/views/detailView.js";
import { lexiconEventView, sampleEvent } from "./helpers.js";

const BEFORE_EVENT = new Date("2026-11-11T12:00:00Z");
const AFTER_EVENT = new Date("2026-11-12T00:00:00Z");
const UTC = { locale: "en-US", timeZone: "UTC", now: BEFORE_EVENT };

/** Pin map stand-in so tests never load Leaflet. */
const fakePinMap = () => ({ show: vi.fn(async () => {}), destroy: vi.fn() });

describe("detailView.renderDetail", () => {
  it("shows title, local time, location, tags, group and linked host", () => {
    const article = renderDetail(sampleEvent(), UTC);
    expect(article.querySelector("#detail-title").textContent).toBe(
      "Taco Tuesday",
    );
    expect(article.querySelector(".detail__when").textContent).toBe(
      "Wednesday, November 11, 2026 · 7:00 PM – 9:00 PM UTC",
    );
    expect(article.textContent).toContain("Price Center");
    expect(article.querySelector(".detail__address").textContent).toBe(
      "9500 Gilman Dr",
    );
    expect(
      [...article.querySelectorAll(".detail__tags li")].map(
        (li) => li.textContent,
      ),
    ).toEqual(["#food", "#free"]);
    expect(article.querySelector(".detail__group").textContent).toBe(
      "Triton Eats",
    );
    const host = article.querySelector(".detail__host");
    expect(host.textContent).toBe("@alice.test");
    expect(host.getAttribute("href")).toBe(
      "https://bsky.app/profile/alice.test",
    );
    expect(article.querySelector(".detail__map")).not.toBeNull();
  });

  it("escapes the description and lists updates newest first", () => {
    const article = renderDetail(
      sampleEvent({
        description: "<b>Bring</b> a plate",
        updates: [
          { text: "Moved inside", createdAt: "2026-11-11T18:00:00Z" },
          { text: "Starting soon!", createdAt: "2026-11-11T18:30:00Z" },
        ],
      }),
      UTC,
    );
    expect(article.querySelector(".detail__desc").textContent).toBe(
      "<b>Bring</b> a plate",
    );
    expect(article.querySelector("b")).toBeNull();
    expect(
      [...article.querySelectorAll(".updates p")].map((p) => p.textContent),
    ).toEqual(["Starting soon!", "Moved inside"]);
  });

  it('shows "Updated <time>" only when the event was edited', () => {
    expect(
      renderDetail(sampleEvent(), UTC).querySelector(".detail__updated"),
    ).toBeNull();
    const edited = renderDetail(
      sampleEvent({ updatedAt: "2026-11-10T15:30:00Z" }),
      UTC,
    );
    expect(edited.querySelector(".detail__updated").textContent).toBe(
      "Updated Nov 10, 3:30 PM",
    );
  });

  it('shows "This event has ended" for past events and hides Subscribe', () => {
    const upcoming = renderDetail(sampleEvent(), {
      ...UTC,
      onToggleSubscribe: () => {},
    });
    expect(upcoming.textContent).not.toContain("This event has ended");
    expect(upcoming.querySelector("[data-action=subscribe]")).not.toBeNull();

    const ended = renderDetail(sampleEvent({ status: "live" }), {
      ...UTC,
      now: AFTER_EVENT,
      onToggleSubscribe: () => {},
    });
    expect(ended.querySelector(".detail__ended").textContent).toBe(
      "This event has ended",
    );
    expect(ended.querySelector(".badge--live")).toBeNull();
    expect(ended.querySelector("[data-action=subscribe]")).toBeNull();
  });

  it("only links http(s) source URLs", () => {
    const article = renderDetail(
      sampleEvent({ sourceUrl: "javascript:alert(1)" }),
      UTC,
    );
    expect(article.querySelector('a[href^="javascript"]')).toBeNull();
  });

  it("wires Back and Copy link", () => {
    const onClose = vi.fn();
    const onCopyLink = vi.fn();
    const article = renderDetail(sampleEvent(), {
      ...UTC,
      onClose,
      onCopyLink,
    });
    const buttons = [...article.querySelectorAll(".detail__toolbar button")];
    buttons.find((b) => b.textContent.includes("Back")).click();
    buttons.find((b) => b.textContent === "Copy link").click();
    expect(onClose).toHaveBeenCalled();
    expect(onCopyLink).toHaveBeenCalledWith(sampleEvent().uri);
  });
});

describe("detailView.renderActions", () => {
  const labels = (buttons) => buttons.map((b) => b.textContent);

  it("reserves disabled slots for directions (#22) and calendar (#23)", () => {
    const buttons = renderActions(sampleEvent());
    const directions = buttons.find((b) => b.dataset.slot === "directions");
    const calendar = buttons.find((b) => b.dataset.slot === "calendar");
    expect(directions.disabled).toBe(true);
    expect(calendar.disabled).toBe(true);
  });

  it("renders a disabled Subscribe placeholder without a handler", () => {
    const [subscribe] = renderActions(sampleEvent());
    expect(subscribe.textContent).toBe("Subscribe");
    expect(subscribe.disabled).toBe(true);
  });

  it("toggles subscription and reflects state with aria-pressed", () => {
    const onToggleSubscribe = vi.fn();
    const [subscribe] = renderActions(sampleEvent(), {
      onToggleSubscribe,
      subscribed: true,
    });
    expect(subscribe.textContent).toBe("Subscribed");
    expect(subscribe.getAttribute("aria-pressed")).toBe("true");
    subscribe.click();
    expect(onToggleSubscribe).toHaveBeenCalledWith(sampleEvent().uri);
  });

  it("shows Edit / Delete only to the host", () => {
    expect(labels(renderActions(sampleEvent()))).not.toContain("Edit");
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    const buttons = renderActions(sampleEvent(), {
      canEdit: true,
      onEdit,
      onDelete,
    });
    buttons.find((b) => b.dataset.action === "edit").click();
    buttons.find((b) => b.dataset.action === "delete").click();
    expect(onEdit).toHaveBeenCalledWith(sampleEvent());
    expect(onDelete).toHaveBeenCalledWith(sampleEvent());
  });
});

describe("detailView.renderNotFound", () => {
  it("is friendly and offers a way back", () => {
    const onClose = vi.fn();
    const page = renderNotFound({ onClose });
    expect(page.querySelector("#detail-title").textContent).toBe(
      "Event not found",
    );
    page.querySelector(".btn--primary").click();
    expect(onClose).toHaveBeenCalled();
  });
});

describe("detailView.createDetailView", () => {
  /** Build a controller with a fake pin map and the given api/deps. */
  function setup(deps) {
    const root = document.createElement("div");
    document.body.replaceChildren(root);
    const pinMaps = [];
    const view = createDetailView(root, {
      now: () => BEFORE_EVENT,
      pinMapFactory: () => {
        const pinMap = fakePinMap();
        pinMaps.push(pinMap);
        return pinMap;
      },
      ...deps,
    });
    return { root, view, pinMaps };
  }

  it("loads via api.getEvent, renders it and shows the pin", async () => {
    const api = {
      getEvent: vi.fn(async () => ({ data: sampleEvent(), stale: false })),
    };
    const { root, view, pinMaps } = setup({ api });
    await view.open(sampleEvent().uri);
    expect(api.getEvent).toHaveBeenCalledWith(sampleEvent().uri);
    expect(root.querySelector("#detail-title").textContent).toBe(
      "Taco Tuesday",
    );
    expect(document.activeElement).toBe(root.querySelector("#detail-title"));
    // The pin map gets the sanitized display event (same name / location strings).
    expect(pinMaps.at(-1).show).toHaveBeenCalledWith(
      expect.objectContaining({
        uri: sampleEvent().uri,
        name: "Taco Tuesday",
        location: expect.objectContaining({ lat: "32.8797", lng: "-117.2362" }),
      }),
    );
    expect(view.currentUri).toBe(sampleEvent().uri);
    expect(view.currentEvent).toEqual(sampleEvent());
  });

  it('shows "Event not found" on 404 and for malformed links', async () => {
    const api = {
      getEvent: vi.fn(async () => {
        throw Object.assign(new Error("nf"), { status: 404 });
      }),
    };
    const { root, view } = setup({ api });
    await view.open("at://did:plc:nope/app.communitymap.event/zzz");
    expect(root.textContent).toContain("Event not found");
    await view.open(null);
    expect(root.textContent).toContain("Event not found");
    expect(api.getEvent).toHaveBeenCalledTimes(1);
  });

  it("renders the feed copy at once and keeps it (as saved) when the fetch fails", async () => {
    let failFetch;
    const api = {
      getEvent: () =>
        new Promise((_resolve, reject) => {
          failFetch = reject;
        }),
    };
    const { root, view } = setup({ api, findEvent: () => sampleEvent() });
    const pending = view.open(sampleEvent().uri);
    expect(root.querySelector("#detail-title").textContent).toBe(
      "Taco Tuesday",
    );
    failFetch(new Error("offline"));
    await pending;
    expect(root.textContent).toContain("Taco Tuesday");
    expect(root.textContent).toContain("Saved copy");
  });

  it("offers a retry when an uncached event fails to load", async () => {
    const api = {
      getEvent: vi
        .fn()
        .mockRejectedValueOnce(new Error("offline"))
        .mockResolvedValueOnce({ data: sampleEvent(), stale: false }),
    };
    const { root, view } = setup({ api });
    await view.open(sampleEvent().uri);
    expect(root.textContent).toContain("Could not load this event");
    [...root.querySelectorAll("button")]
      .find((b) => b.textContent === "Try again")
      .click();
    await vi.waitFor(() =>
      expect(root.querySelector("#detail-title").textContent).toBe(
        "Taco Tuesday",
      ),
    );
  });

  it("ignores a slow response for an event the user already left", async () => {
    const resolvers = {};
    const api = {
      getEvent: (uri) =>
        new Promise((resolve) => {
          resolvers[uri] = resolve;
        }),
    };
    const { root, view } = setup({ api });
    const first = view.open("at://did:plc:a/app.communitymap.event/1");
    const second = view.open("at://did:plc:a/app.communitymap.event/2");
    resolvers["at://did:plc:a/app.communitymap.event/2"]({
      data: sampleEvent({ name: "Second" }),
      stale: false,
    });
    await second;
    resolvers["at://did:plc:a/app.communitymap.event/1"]({
      data: sampleEvent({ name: "First" }),
      stale: false,
    });
    await first;
    expect(root.querySelector("#detail-title").textContent).toBe("Second");
  });

  it("refreshActions updates subscription state without re-rendering the pane", async () => {
    let subscribed = false;
    const api = {
      getEvent: async () => ({ data: sampleEvent(), stale: false }),
    };
    const { root, view, pinMaps } = setup({
      api,
      isSubscribed: () => subscribed,
      onToggleSubscribe: () => {},
    });
    await view.open(sampleEvent().uri);
    const title = root.querySelector("#detail-title");
    const pinMapCount = pinMaps.length;
    subscribed = true;
    view.refreshActions();
    expect(root.querySelector("[data-action=subscribe]").textContent).toBe(
      "Subscribed",
    );
    expect(root.querySelector("#detail-title")).toBe(title);
    expect(pinMaps).toHaveLength(pinMapCount);
  });

  it("close clears the pane and releases the pin map", async () => {
    const api = {
      getEvent: async () => ({ data: sampleEvent(), stale: false }),
    };
    const { root, view, pinMaps } = setup({ api });
    await view.open(sampleEvent().uri);
    view.close();
    expect(root.children).toHaveLength(0);
    expect(pinMaps.at(-1).destroy).toHaveBeenCalled();
    expect(view.currentUri).toBeNull();
  });
});

describe("detailView.renderDetail with lexicon records", () => {
  /** A valid event built from the shared full fixture (fixtures/event/valid/full.json). */
  const lexiconEvent = (over) => lexiconEventView(fullFixture.record, over);
  const BEFORE_HACKATHON = new Date("2026-12-01T00:00:00Z");
  const LA = {
    locale: "en-US",
    timeZone: "America/Los_Angeles",
    now: BEFORE_HACKATHON,
  };

  it("renders every lexicon field in local time with no warning", () => {
    const article = renderDetail(lexiconEvent(), LA);
    expect(article.querySelector("#detail-title").textContent).toBe(
      "Triton Hackathon Kickoff",
    );
    expect(article.querySelector(".detail__when").textContent).toBe(
      "Friday, December 4, 2026 · 5:00 PM – 8:00 PM PST",
    );
    expect(
      article.querySelector(".detail__when").getAttribute("datetime"),
    ).toBe("2026-12-04T17:00:00.000-08:00");
    expect(article.textContent).toContain("Price Center Ballroom East");
    expect(article.querySelector(".detail__address").textContent).toBe(
      "9500 Gilman Dr, La Jolla, CA 92093",
    );
    expect(
      [...article.querySelectorAll(".detail__tags li")].map(
        (li) => li.textContent,
      ),
    ).toEqual(["#hackathon", "#cse", "#free-food"]);
    expect(article.querySelector(".detail__desc").textContent).toBe(
      fullFixture.record.description,
    );
    expect(article.querySelector(".detail__host").getAttribute("href")).toBe(
      "https://bsky.app/profile/host.test",
    );
    expect(article.querySelector(".detail__invalid")).toBeNull();
    expect(article.dataset.lexiconValid).toBe("true");
  });

  it("labels a strongRef group with its record key and keeps its URI (STUB #17)", () => {
    const group = renderDetail(lexiconEvent(), LA).querySelector(
      ".detail__group",
    );
    expect(group.textContent).toBe("3lbxq7k2mzs2a");
    expect(group.dataset.groupUri).toBe(fullFixture.record.group.uri);
  });

  it("keeps legacy string groups readable, without a group URI", () => {
    const group = renderDetail(sampleEvent(), UTC).querySelector(
      ".detail__group",
    );
    expect(group.textContent).toBe("Triton Eats");
    expect(group.dataset.groupUri).toBeUndefined();
  });

  it("renders the minimal fixture: no group, tags, description or address", () => {
    const article = renderDetail(lexiconEventView(minimalFixture.record), {
      ...UTC,
      now: new Date("2026-11-30T00:00:00Z"),
    });
    expect(article.querySelector(".detail__group")).toBeNull();
    expect(article.querySelector(".detail__tags")).toBeNull();
    expect(article.querySelector(".detail__desc")).toBeNull();
    expect(article.querySelector(".detail__address")).toBeNull();
    expect(article.textContent).toContain("Location not specified");
    expect(article.querySelector(".detail__invalid")).toBeNull();
  });

  it("shows the ended notice for a lexicon event whose endsAt has passed", () => {
    const article = renderDetail(lexiconEvent(), {
      ...LA,
      now: new Date("2026-12-05T12:00:00Z"),
    });
    expect(article.querySelector(".detail__ended").textContent).toBe(
      "This event has ended",
    );
  });

  it("hands the original EventView (not the display copy) to Edit", () => {
    const onEdit = vi.fn();
    const ev = lexiconEvent();
    renderDetail(ev, { ...LA, canEdit: true, onEdit })
      .querySelector("[data-action=edit]")
      .click();
    expect(onEdit).toHaveBeenCalledWith(ev);
  });
});

describe("detailView.renderDetail best-effort for records that break the lexicon", () => {
  it("renders the record with a warning when it fails validation", () => {
    const article = renderDetail(
      lexiconEventView(missingLatFixture.record),
      UTC,
    );
    expect(article.querySelector(".detail__invalid").textContent).toBe(
      INVALID_RECORD_NOTICE,
    );
    expect(article.dataset.lexiconValid).toBe("false");
    expect(article.querySelector("#detail-title").textContent).toBe(
      missingLatFixture.record.name,
    );
  });

  it("falls back to placeholders instead of crashing on unusable fields", () => {
    const article = renderDetail(
      {
        uri: sampleEvent().uri,
        name: 42,
        startsAt: "soon",
        location: "somewhere",
        tags: "food",
        group: { uri: "nope" },
        updates: [{ text: "ok", createdAt: "bad" }],
      },
      UTC,
    );
    expect(article.querySelector("#detail-title").textContent).toBe(
      UNTITLED_EVENT_NAME,
    );
    expect(article.querySelector(".detail__when").textContent).toBe(
      TIME_NOT_SPECIFIED,
    );
    expect(article.textContent).toContain("Location not specified");
    expect(article.querySelector(".detail__tags")).toBeNull();
    expect(article.querySelector(".detail__group")).toBeNull();
    expect(article.textContent).toContain("No announcements yet.");
    expect(article.querySelector(".detail__invalid")).not.toBeNull();
  });

  it('leaves data-uri off (instead of writing "null") when the record has no URI', () => {
    const article = renderDetail({ name: "No URI" }, UTC);
    expect(article.hasAttribute("data-uri")).toBe(false);
    expect(article.querySelector(".detail__toolbar").textContent).not.toContain(
      "Copy link",
    );
  });

  it("shows just the start time when the end time is unusable", () => {
    const article = renderDetail(sampleEvent({ endsAt: "whenever" }), UTC);
    expect(article.querySelector(".detail__when").textContent).toBe(
      "Nov 11, 7:00 PM",
    );
  });

  it("never renders record text as HTML", () => {
    const article = renderDetail(
      sampleEvent({
        name: "<img src=x onerror=alert(1)>",
        location: { name: "<script>x()</script>", lat: "1", lng: "1" },
        tags: ["<b>tag</b>"],
      }),
      UTC,
    );
    expect(article.querySelector("img, script, b")).toBeNull();
    expect(article.querySelector("#detail-title").textContent).toBe(
      "<img src=x onerror=alert(1)>",
    );
  });
});

describe("detailView.createDetailView with lexicon records", () => {
  /** Build a controller with a fake pin map and the given deps. */
  function setup(deps) {
    const root = document.createElement("div");
    document.body.replaceChildren(root);
    const view = createDetailView(root, {
      now: () => BEFORE_EVENT,
      pinMapFactory: fakePinMap,
      onInvalidRecord: vi.fn(),
      ...deps,
    });
    return { root, view };
  }

  it("does not fetch, and shows Event not found, for URIs that are not events", async () => {
    const api = { getEvent: vi.fn() };
    const { root, view } = setup({ api });
    for (const uri of [
      "at://did:plc:abc/app.bsky.feed.post/3kabc",
      "https://example.com",
      42,
      undefined,
    ]) {
      await view.open(uri);
      expect(root.querySelector("#detail-title").textContent).toBe(
        "Event not found",
      );
    }
    expect(api.getEvent).not.toHaveBeenCalled();
    expect(view.currentUri).toBeNull();
  });

  it("treats a 400 (malformed URI) like a 404", async () => {
    const api = {
      getEvent: vi.fn(async () => {
        throw Object.assign(new Error("bad"), { status: 400 });
      }),
    };
    const { root, view } = setup({ api });
    await view.open(sampleEvent().uri);
    expect(root.querySelector("#detail-title").textContent).toBe(
      "Event not found",
    );
  });

  it("still shows the error page (with retry) for server errors", async () => {
    const api = {
      getEvent: vi.fn(async () => {
        throw Object.assign(new Error("boom"), { status: 503 });
      }),
    };
    const { root, view } = setup({ api });
    await view.open(sampleEvent().uri);
    expect(root.textContent).toContain("Could not load this event");
  });

  it.each([
    ["null", null],
    ["a string", "Taco Tuesday"],
    ["an array", [sampleEvent()]],
  ])("shows Event not found when the API returns %s", async (_label, data) => {
    const api = { getEvent: vi.fn(async () => ({ data, stale: false })) };
    const { root, view } = setup({ api });
    await view.open(sampleEvent().uri);
    expect(root.querySelector("#detail-title").textContent).toBe(
      "Event not found",
    );
  });

  it("shows Event not found when the API resolves with nothing", async () => {
    const api = { getEvent: vi.fn(async () => undefined) };
    const { root, view } = setup({ api });
    await view.open(sampleEvent().uri);
    expect(root.querySelector("#detail-title").textContent).toBe(
      "Event not found",
    );
  });

  it("falls back to the requested URI when the API omits it", async () => {
    const { uri: _uri, ...withoutUri } = lexiconEventView(fullFixture.record);
    const requested = "at://did:plc:host/app.communitymap.event/3lexicon";
    const onCopyLink = vi.fn();
    const api = { getEvent: async () => ({ data: withoutUri, stale: false }) };
    const { root, view } = setup({ api, onCopyLink });
    await view.open(requested);
    expect(view.currentUri).toBe(requested);
    [...root.querySelectorAll("button")]
      .find((b) => b.textContent === "Copy link")
      .click();
    expect(onCopyLink).toHaveBeenCalledWith(requested);
  });

  it("reports lexicon issues and still renders the event best-effort", async () => {
    const broken = lexiconEventView(missingLatFixture.record);
    const onInvalidRecord = vi.fn();
    const api = { getEvent: async () => ({ data: broken, stale: false }) };
    const { root, view } = setup({ api, onInvalidRecord });
    await view.open(broken.uri);
    expect(onInvalidRecord).toHaveBeenCalledWith(
      broken.uri,
      expect.arrayContaining([
        expect.objectContaining({ path: "location.lat" }),
      ]),
    );
    expect(root.querySelector(".detail__invalid")).not.toBeNull();
    expect(root.querySelector("#detail-title").textContent).toBe(broken.name);
  });

  it("does not report valid lexicon records", async () => {
    const valid = lexiconEventView(fullFixture.record);
    const onInvalidRecord = vi.fn();
    const api = { getEvent: async () => ({ data: valid, stale: false }) };
    const { view } = setup({ api, onInvalidRecord });
    await view.open(valid.uri);
    expect(onInvalidRecord).not.toHaveBeenCalled();
  });

  it("logs lexicon issues with console.warn by default", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const broken = lexiconEventView(missingLatFixture.record);
    const root = document.createElement("div");
    const view = createDetailView(root, {
      api: { getEvent: async () => ({ data: broken, stale: false }) },
      pinMapFactory: fakePinMap,
      now: () => BEFORE_EVENT,
    });
    await view.open(broken.uri);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(broken.uri),
      expect.any(Array),
    );
    warn.mockRestore();
  });

  it("refreshActions keeps working for a lexicon event", async () => {
    let subscribed = false;
    const valid = lexiconEventView(fullFixture.record);
    const api = { getEvent: async () => ({ data: valid, stale: false }) };
    const { root, view } = setup({
      api,
      isSubscribed: () => subscribed,
      onToggleSubscribe: () => {},
      now: () => new Date("2026-12-01T00:00:00Z"),
    });
    await view.open(valid.uri);
    subscribed = true;
    view.refreshActions();
    expect(root.querySelector("[data-action=subscribe]").textContent).toBe(
      "Subscribed",
    );
  });
});
