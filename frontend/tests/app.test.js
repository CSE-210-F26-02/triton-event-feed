import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, memoryStorage, sampleEvent } from "./helpers.js";
import { dayKey } from "../src/filters.js";

globalThis.__CM_NO_AUTOSTART__ = true;
const { start } = await import("../src/app.js");

const html = readFileSync(resolve(__dirname, "../index.html"), "utf8");
const flush = () => new Promise((r) => setTimeout(r, 0));

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
    const f = vi.fn(async (url) =>
      jsonResponse(routes(url) ?? { error: "nf" }, routes(url) ? 200 : 404),
    );
    vi.stubGlobal("fetch", f);
    await start();
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
    expect(f.mock.calls.every(([u]) => !/lat|lng|near/i.test(u))).toBe(true);

    document.querySelector("#filters .chip").click();
    await flush();
    expect(
      f.mock.calls.some(
        ([u]) => u.startsWith("/api/events?") && u.includes("tag=food"),
      ),
    ).toBe(true);

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
    f.mockImplementation(async (url) => {
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
      .find((b) => b.textContent === "Apply")
      .click();
    await flush();
    await flush();
    expect(f.mock.calls.some(([url]) => url.includes("cursor=page2"))).toBe(
      true,
    );
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
      fetchMock.mock.calls.some(([u]) => u.startsWith("/api/event?")),
    ).toBe(true);

    // Subscribing from the pane updates its button in place.
    detailPanel.querySelector("[data-action=subscribe]").click();
    await flush();
    expect(
      detailPanel.querySelector("[data-action=subscribe]").textContent,
    ).toBe("Subscribed");

    // Made-up event URL → friendly not-found page.
    location.hash = "#/event/did:plc:nobody/doesnotexist";
    await flush();
    await flush();
    expect(detailPanel.querySelector("#detail-title").textContent).toBe(
      "Event not found",
    );

    // Back → map returns and the URL is clean.
    [...detailPanel.querySelectorAll("button")]
      .find((b) => b.textContent.includes("Back"))
      .click();
    await flush();
    expect(location.hash).toBe("");
    expect(mapPanel.hidden).toBe(false);
    expect(detailPanel.hidden).toBe(true);
  });
});

/**
 * Boot the app against fake fetch/Leaflet. `extraRoute(url)` may return a response
 * to override the default routes.
 * @param {(url: string) => object|null} [extraRoute]
 * @returns {Promise<import('vitest').Mock>} the fetch mock
 */
async function bootApp(extraRoute = () => null) {
  history.replaceState(null, "", "/");
  document.documentElement.innerHTML = html.replace(
    /<script[^>]*><\/script>/,
    "",
  );
  vi.stubGlobal("localStorage", memoryStorage());
  vi.stubGlobal("sessionStorage", memoryStorage());
  const chain = () => ({
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
    map: vi.fn(chain),
    tileLayer: vi.fn(chain),
    layerGroup: vi.fn(chain),
    marker: vi.fn(chain),
  });
  const fetchMock = vi.fn(async (url, init) => {
    const extra = extraRoute(url);
    if (extra) return extra;
    if (url.startsWith("/api/subscriptions") && init?.method === "POST")
      return jsonResponse({ ok: true });
    const body = routes(url);
    return jsonResponse(body ?? { error: "nf" }, body ? 200 : 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  await start();
  await flush();
  await flush();
  return fetchMock;
}
