import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, memoryStorage, sampleEvent } from "./helpers.js";
import { dayKey } from "../src/filters.js";

globalThis.__CM_NO_AUTOSTART__ = true;
const { start, pendingEventView, upsertEvent, keepPending } =
  await import("../src/app.js");

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
});

describe("posting an event (#8)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("shows the new event in the list and opens its detail view before it is indexed", async () => {
    document.documentElement.innerHTML = html.replace(
      /<script[^>]*><\/script>/,
      "",
    );
    vi.stubGlobal("localStorage", memoryStorage());
    vi.stubGlobal("sessionStorage", memoryStorage());
    const chain = {
      setView() {
        return this;
      },
      addTo() {
        return this;
      },
      bindPopup() {
        return this;
      },
      invalidateSize: vi.fn(),
      fitBounds: vi.fn(),
      clearLayers: vi.fn(),
    };
    vi.stubGlobal("L", {
      map: () => chain,
      tileLayer: () => chain,
      layerGroup: () => chain,
      marker: () => chain,
    });
    const posted = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        if (url === "/api/dev/records") {
          posted.push(JSON.parse(init.body));
          return jsonResponse({ ok: true });
        }
        if (url.startsWith("/api/event?")) return jsonResponse({}, 404);
        return jsonResponse(routes(url) ?? [], 200);
      }),
    );
    await start();
    await flush();
    await flush();

    [...document.querySelectorAll("#account button")]
      .find((b) => b.textContent === "New event")
      .click();
    const form = document.querySelector("form.compose");
    const later = new Date(Date.now() + 86400e3);
    const local = (d) =>
      new Date(d - d.getTimezoneOffset() * 60e3).toISOString().slice(0, 16);
    Object.entries({
      name: "Optimistic jam",
      startsAt: local(later),
      endsAt: local(new Date(+later + 3600e3)),
      locationName: "Geisel",
    }).forEach(([k, v]) => {
      form.elements[k].value = v;
    });
    form.requestSubmit();
    await flush();
    await flush();

    expect(posted).toHaveLength(1);
    expect(posted[0].commit.operation).toBe("create");
    expect(document.querySelector("#list").textContent).toContain(
      "Optimistic jam",
    );
    const detail = document.getElementById("detail-title");
    expect(detail.textContent).toBe("Optimistic jam");
    expect(detail.closest("dialog").textContent).toMatch(/few seconds/);
  });
});

describe("optimistic event helpers", () => {
  const res = {
    uri: "at://did:plc:me/app.communitymap.event/r1",
    cid: "bafyX",
    record: {
      name: "Jam",
      startsAt: "2026-11-12T18:00:00.000Z",
      endsAt: "2026-11-12T20:00:00.000Z",
      location: { name: "Geisel" },
      createdAt: "2026-11-01T00:00:00.000Z",
    },
  };

  it("builds a pending EventView from the written record", () => {
    const now = Date.parse("2026-11-12T19:00:00Z");
    const ev = pendingEventView(
      res,
      { did: "did:plc:me", handle: "me.test" },
      now,
    );
    expect(ev).toMatchObject({
      uri: res.uri,
      cid: "bafyX",
      name: "Jam",
      authorDid: "did:plc:me",
      authorHandle: "me.test",
      source: "atproto",
      tags: [],
      status: "live",
      pending: true,
    });
    expect(pendingEventView(res, null, Date.parse("2026-11-01")).status).toBe(
      "upcoming",
    );
  });

  it("upserts by uri", () => {
    const a = sampleEvent({ uri: "a" });
    const b = sampleEvent({ uri: "b" });
    expect(upsertEvent([a], b).map((e) => e.uri)).toEqual(["b", "a"]);
    const a2 = { ...a, name: "changed" };
    expect(upsertEvent([b, a], a2)).toEqual([b, a2]);
  });

  it("keeps unindexed pending events after a reload, until the server copy or TTL", () => {
    const now = 1_000_000;
    const pending = { uri: "p", pending: true, pendingSince: now - 1000 };
    const old = { uri: "o", pending: true, pendingSince: now - 10 * 60e3 };
    const fetched = [sampleEvent({ uri: "x" })];
    expect(keepPending(fetched, [pending, old], now).map((e) => e.uri)).toEqual(
      ["p", "x"],
    );
    const indexed = sampleEvent({ uri: "p" });
    expect(keepPending([indexed], [pending], now)).toEqual([indexed]);
  });
});
