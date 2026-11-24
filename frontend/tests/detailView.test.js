import { describe, expect, it, vi } from "vitest";
import {
  createDetailView,
  renderActions,
  renderDetail,
  renderNotFound,
} from "../src/views/detailView.js";
import { sampleEvent } from "./helpers.js";

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
    expect(pinMaps.at(-1).show).toHaveBeenCalledWith(sampleEvent());
    expect(view.currentUri).toBe(sampleEvent().uri);
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
