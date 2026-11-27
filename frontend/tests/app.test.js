import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import fullFixture from "../../fixtures/event/valid/full.json";
import {
  jsonResponse,
  lexiconEventView,
  memoryStorage,
  sampleEvent,
  testConfig,
} from "./helpers.js";
import { dayKey } from "../src/filters.js";
import { eventHash } from "../src/router.js";

globalThis.__CM_NO_AUTOSTART__ = true;
const { start } = await import("../src/app.js");

const html = readFileSync(resolve(__dirname, "../index.html"), "utf8");
const flush = () => new Promise((resolveFlush) => setTimeout(resolveFlush, 0));

function routes(url) {
  const path = url.split("?")[0];
  return {
    "/api/config": {
      devMode: true,
      jetstreamEnabled: false,
      eventNsid: "app.communitymap.event",
      listenerNsid: "app.communitymap.listener",
    },
    "/api/events": {
      events: [
        sampleEvent({
          startsAt: new Date(Date.now() + 3600e3).toISOString(),
          endsAt: new Date(Date.now() + 7200e3).toISOString(),
        }),
      ],
      cursor: null,
    },
    "/api/tags": [{ value: "food", count: 1 }],
    "/api/groups": [{ value: "Triton Eats", count: 1 }],
    "/api/subscriptions": [],
  }[path];
}

describe("app (smoke)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("boots in demo mode and renders events, tags and the New event button", async () => {
    document.documentElement.innerHTML = html.replace(
      /<script[^>]*><\/script>/,
      "",
    );
    vi.stubGlobal("localStorage", memoryStorage());
    vi.stubGlobal("sessionStorage", memoryStorage());
    const mapInstance = {
      setView() {
        return this;
      },
      invalidateSize: vi.fn(),
      fitBounds: vi.fn(),
    };
    const layer = {
      addTo() {
        return this;
      },
      clearLayers: vi.fn(),
    };
    const marker = {
      bindPopup() {
        return this;
      },
      addTo() {
        return this;
      },
    };
    const leaflet = {
      map: vi.fn(() => mapInstance),
      tileLayer: vi.fn(() => ({ addTo() {} })),
      layerGroup: vi.fn(() => layer),
      marker: vi.fn(() => marker),
    };
    vi.stubGlobal("L", leaflet);
    const fetchMock = vi.fn(async (url) =>
      jsonResponse(routes(url) ?? { error: "nf" }, routes(url) ? 200 : 404),
    );
    vi.stubGlobal("fetch", fetchMock);
    await start({ config: await testConfig() });
    await flush();
    await flush();
    expect(document.querySelectorAll("#list article")).toHaveLength(1);
    expect(document.querySelector("#filters .chip").textContent).toBe("#food");
    expect(document.querySelector("#account").textContent).toContain(
      "Demo mode",
    );
    expect(document.querySelector("#account").textContent).toContain(
      "New event",
    );
    // Location is never sent to the backend.
    expect(
      fetchMock.mock.calls.every(([url]) => !/lat|lng|near/i.test(url)),
    ).toBe(true);

    document.querySelector("#filters .chip").click();
    await flush();
    expect(
      fetchMock.mock.calls.some(
        ([url]) => url.startsWith("/api/events?") && url.includes("tag=food"),
      ),
    ).toBe(true);

    // Changing the sort order refetches events with the new order.
    const sortSelect = document.querySelector("#f-sort");
    sortSelect.value = "newest";
    sortSelect.dispatchEvent(new Event("change"));
    await flush();
    expect(
      fetchMock.mock.calls.some(
        ([url]) =>
          url.startsWith("/api/events?") && url.includes("sort=newest"),
      ),
    ).toBe(true);
    expect(document.querySelector("#list h2").textContent).toBe("Newest");
    sortSelect.value = "soonest";
    sortSelect.dispatchEvent(new Event("change"));
    await flush();

    expect(document.querySelector("[role=tablist]")).toBeNull();
    expect(document.querySelector("#panel-map").hidden).toBe(false);
    expect(document.querySelector("#panel-list").hidden).toBe(false);
    expect(document.querySelector("#map .map")).not.toBeNull();
    expect(leaflet.map).toHaveBeenCalledTimes(1);
    expect(leaflet.marker).toHaveBeenCalledWith(
      [32.8797, -117.2362],
      expect.any(Object),
    );

    // Date filtering must include later pages, and update the list and map together.
    const today = new Date();
    const todayStart = new Date(
      today.getFullYear(),
      today.getMonth(),
      today.getDate(),
      12,
    );
    const tomorrow = new Date(todayStart);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const todayEvent = sampleEvent({
      uri: "at://today",
      name: "Selected day event",
      startsAt: todayStart.toISOString(),
      endsAt: new Date(+todayStart + 3600e3).toISOString(),
    });
    const tomorrowEvent = sampleEvent({
      uri: "at://tomorrow",
      name: "Other day event",
      startsAt: tomorrow.toISOString(),
      endsAt: new Date(+tomorrow + 3600e3).toISOString(),
    });
    fetchMock.mockImplementation(async (url) => {
      if (url.startsWith("/api/events?"))
        return jsonResponse(
          url.includes("cursor=page2")
            ? { events: [todayEvent], cursor: null }
            : { events: [tomorrowEvent], cursor: "page2" },
        );
      return jsonResponse(routes(url) ?? [], 200);
    });
    document.querySelector(".date-filter__trigger").click();
    document.querySelector(`[data-date="${dayKey(today)}"]`).click();
    [...document.querySelectorAll("#event-date-picker button")]
      .find((button) => button.textContent === "Apply")
      .click();
    await flush();
    await flush();
    expect(
      fetchMock.mock.calls.some(([url]) => url.includes("cursor=page2")),
    ).toBe(true);
    expect(document.querySelector("#list").textContent).toContain(
      "Selected day event",
    );
    expect(document.querySelector("#list").textContent).not.toContain(
      "Other day event",
    );
    expect(leaflet.marker).toHaveBeenLastCalledWith([32.8797, -117.2362], {
      title: "Selected day event",
    });
  });

  it("opens an event in the detail pane via a shareable URL, and handles bad links", async () => {
    const upcoming = sampleEvent({
      startsAt: new Date(Date.now() + 3600e3).toISOString(),
      endsAt: new Date(Date.now() + 7200e3).toISOString(),
    });
    const fetchMock = await bootApp((url) => {
      if (!url.startsWith("/api/event?")) return null;
      const uri = new URLSearchParams(url.split("?")[1]).get("uri");
      return uri === upcoming.uri
        ? jsonResponse(upcoming)
        : jsonResponse({ error: "nf" }, 404);
    });
    const mapPanel = document.querySelector("#panel-map");
    const detailPanel = document.querySelector("#panel-detail");
    expect(detailPanel.hidden).toBe(true);

    // Card click → detail replaces the map, URL is shareable.
    document.querySelector("#list article .card__title button").click();
    await flush();
    await flush();
    expect(location.hash).toBe("#/event/did:plc:abc/3kabc");
    expect(mapPanel.hidden).toBe(true);
    expect(detailPanel.hidden).toBe(false);
    expect(detailPanel.querySelector("#detail-title").textContent).toBe(
      "Taco Tuesday",
    );
    expect(detailPanel.querySelector(".detail__host").textContent).toBe(
      "@alice.test",
    );
    expect(
      fetchMock.mock.calls.some(([url]) => url.startsWith("/api/event?")),
    ).toBe(true);

    // Subscribing while logged out asks the user to log in first (#19).
    detailPanel.querySelector("[data-action=subscribe]").click();
    await flush();
    expect(document.querySelector("#login-reason").textContent).toBe(
      "Log in to subscribe to this event.",
    );

    // Made-up event URL → friendly not-found page.
    location.hash = "#/event/did:plc:nobody/doesnotexist";
    await flush();
    await flush();
    expect(detailPanel.querySelector("#detail-title").textContent).toBe(
      "Event not found",
    );

    // Back → map returns and the URL is clean.
    [...detailPanel.querySelectorAll("button")]
      .find((button) => button.textContent.includes("Back"))
      .click();
    await flush();
    expect(location.hash).toBe("");
    expect(mapPanel.hidden).toBe(false);
    expect(detailPanel.hidden).toBe(true);
  });

  /** A valid, upcoming lexicon event (shared full fixture, shifted into the future). */
  const upcomingLexiconEvent = () =>
    lexiconEventView(fullFixture.record, {
      startsAt: new Date(Date.now() + 3600e3).toISOString(),
      endsAt: new Date(Date.now() + 7200e3).toISOString(),
    });

  /**
   * Routes serving one lexicon event from the feed and from GET /api/event.
   * @param {object} event
   * @param {{inFeed?: boolean}} [options]
   */
  const lexiconRoutes =
    (event, { inFeed = true } = {}) =>
    (url) => {
      if (url.startsWith("/api/events?"))
        return jsonResponse({ events: inFeed ? [event] : [], cursor: null });
      if (!url.startsWith("/api/event?")) return null;
      const uri = new URLSearchParams(url.split("?")[1]).get("uri");
      return uri === event.uri
        ? jsonResponse(event)
        : jsonResponse({ error: "NotFound" }, 404);
    };

  /** The facts a user checks on the detail page (mirrors e2e test 1 of #14). */
  const detailFacts = (panel) => ({
    title: panel.querySelector("#detail-title").textContent,
    location: panel.querySelector(".detail__facts").textContent,
    tags: [...panel.querySelectorAll(".detail__tags li")].map(
      (listItem) => listItem.textContent,
    ),
    host: panel.querySelector(".detail__host").textContent,
    group: panel.querySelector(".detail__group").textContent,
    hasWhen: Boolean(panel.querySelector("time.detail__when")),
    warned: Boolean(panel.querySelector(".detail__invalid")),
  });

  it("shows a lexicon event from its feed card with all its details", async () => {
    const event = upcomingLexiconEvent();
    await bootApp(lexiconRoutes(event));
    document.querySelector("#list article .card__title button").click();
    await flush();
    await flush();
    const panel = document.querySelector("#panel-detail");
    expect(location.hash).toBe(eventHash(event.uri));
    const facts = detailFacts(panel);
    expect(facts).toMatchObject({
      title: "Triton Hackathon Kickoff",
      tags: ["#hackathon", "#cse", "#free-food"],
      host: "@host.test",
      group: "3lbxq7k2mzs2a",
      hasWhen: true,
      warned: false,
    });
    expect(facts.location).toContain("Price Center Ballroom East");
  });

  it("loads the same lexicon event when its shared link is opened in a fresh app", async () => {
    const event = upcomingLexiconEvent();
    await bootApp(lexiconRoutes(event));
    document.querySelector("#list article .card__title button").click();
    await flush();
    await flush();
    const fromFeed = detailFacts(document.querySelector("#panel-detail"));

    // Fresh page load at the shared URL, with nothing in the feed to fall back on.
    const fetchMock = await bootApp(lexiconRoutes(event, { inFeed: false }), {
      initialUrl: `/${eventHash(event.uri)}`,
    });
    await flush();
    const panel = document.querySelector("#panel-detail");
    expect(panel.hidden).toBe(false);
    expect(detailFacts(panel)).toEqual(fromFeed);
    expect(
      fetchMock.mock.calls.some(([url]) =>
        url.startsWith(`/api/event?uri=${encodeURIComponent(event.uri)}`),
      ),
    ).toBe(true);
  });

  it("shows Event not found when a made-up link is opened in a fresh app", async () => {
    await bootApp(lexiconRoutes(upcomingLexiconEvent()), {
      initialUrl: "/#/event/did:plc:madeup/doesnotexist",
    });
    await flush();
    expect(
      document.querySelector("#panel-detail #detail-title").textContent,
    ).toBe("Event not found");
  });
});

/**
 * Boot the app against fake fetch/Leaflet. `extraRoute(url)` may return a response
 * to override the default routes. `initialUrl` is the address the page "loads" at, so a
 * test can open a shared link (e.g. "/#/event/did:plc:abc/3kabc") in a fresh app.
 * @param {(url: string) => object|null} [extraRoute]
 * @param {{initialUrl?: string}} [options]
 * @returns {Promise<import('vitest').Mock>} the fetch mock
 */
async function bootApp(extraRoute = () => null, { initialUrl = "/" } = {}) {
  history.replaceState(null, "", initialUrl);
  document.documentElement.innerHTML = html.replace(
    /<script[^>]*><\/script>/,
    "",
  );
  vi.stubGlobal("localStorage", memoryStorage());
  vi.stubGlobal("sessionStorage", memoryStorage());
  const fakeLayer = () => ({
    addTo() {
      return this;
    },
    bindPopup() {
      return this;
    },
    setView() {
      return this;
    },
    clearLayers() {},
    invalidateSize() {},
    fitBounds() {},
    remove() {},
  });
  vi.stubGlobal("L", {
    map: vi.fn(fakeLayer),
    tileLayer: vi.fn(fakeLayer),
    layerGroup: vi.fn(fakeLayer),
    marker: vi.fn(fakeLayer),
  });
  const fetchMock = vi.fn(async (url, requestInit) => {
    const overrideResponse = extraRoute(url);
    if (overrideResponse) return overrideResponse;
    if (url.startsWith("/api/subscriptions") && requestInit?.method === "POST")
      return jsonResponse({ ok: true });
    const body = routes(url);
    return jsonResponse(body ?? { error: "nf" }, body ? 200 : 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  await start({ config: await testConfig() });
  await flush();
  await flush();
  return fetchMock;
}
