import { describe, expect, it, vi } from "vitest";
import { createFilterBar } from "../src/views/filterBar.js";
import {
  assertMapConfig,
  buildMarkers,
  createMapView,
  createPinMap,
} from "../src/views/mapView.js";
import { createGeo } from "../src/geo.js";
import { sampleEvent, testConfig } from "./helpers.js";

/** Map settings from the shared test env (what frontend/.env provides in the app). */
const MAP = (await testConfig()).map;

describe("mapView.buildMarkers", () => {
  it("keeps only events with valid coordinates", () => {
    const ms = buildMarkers(
      [sampleEvent(), sampleEvent({ uri: "x", location: { name: "No pin" } })],
      { timeZone: "UTC", locale: "en-US" },
    );
    expect(ms).toEqual([
      {
        uri: sampleEvent().uri,
        lat: 32.8797,
        lng: -117.2362,
        title: "Taco Tuesday",
        subtitle: "7:00 PM – 9:00 PM · Price Center",
      },
    ]);
  });

  it("tile provider is configurable", async () => {
    const L = fakeLeaflet();
    globalThis.L = L;
    const root = document.createElement("div");
    const view = createMapView(root, {
      config: { ...MAP, tileUrl: "https://tiles.example/{z}/{x}/{y}.pbf" },
      load: async () => L,
    });
    await view.show([sampleEvent()]);
    expect(L.tileLayer).toHaveBeenCalledWith(
      "https://tiles.example/{z}/{x}/{y}.pbf",
      expect.objectContaining({
        maxZoom: MAP.maxZoom,
        attribution: MAP.attribution,
      }),
    );
    expect(L.marker).toHaveBeenCalledTimes(1);
    delete globalThis.L;
  });

  it("shows an error when Leaflet fails to load", async () => {
    const root = document.createElement("div");
    await createMapView(root, {
      config: MAP,
      load: async () => {
        throw new Error("x");
      },
    }).show([]);
    expect(root.querySelector("[role=alert]")).not.toBeNull();
  });

  it("initializes once and uses the latest events while the map loads", async () => {
    const L = fakeLeaflet();
    let finishLoading;
    const load = vi.fn(
      () =>
        new Promise((resolve) => {
          finishLoading = resolve;
        }),
    );
    const view = createMapView(document.createElement("div"), {
      config: MAP,
      load,
    });
    const first = view.show([sampleEvent()]);
    const latest = view.show([
      sampleEvent({
        name: "Updated event",
        location: { lat: 32.88, lng: -117.23 },
      }),
    ]);
    finishLoading(L);
    await Promise.all([first, latest]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(L.map).toHaveBeenCalledTimes(1);
    expect(L.marker).toHaveBeenCalledTimes(1);
    expect(L.marker).toHaveBeenCalledWith([32.88, -117.23], {
      title: "Updated event",
    });
  });
});

describe("mapView config (from frontend/.env)", () => {
  it("accepts a complete config and returns it", () => {
    expect(assertMapConfig(MAP)).toBe(MAP);
  });

  it("names every missing field", () => {
    const { tileUrl: _tileUrl, zoom: _zoom, ...partial } = MAP;
    expect(() => assertMapConfig(partial)).toThrow(
      "Map config is missing: tileUrl, zoom",
    );
    expect(() => assertMapConfig(undefined)).toThrow(TypeError);
  });

  it("refuses to build maps without a config", () => {
    const root = document.createElement("div");
    expect(() => createMapView(root, {})).toThrow(TypeError);
    expect(() => createPinMap(root, {})).toThrow(TypeError);
  });

  it("starts the main map at the configured center and zoom", async () => {
    const L = fakeLeaflet();
    const setView = vi.fn(function () {
      return this;
    });
    L.map = vi.fn(() => ({ setView, invalidateSize() {}, fitBounds() {} }));
    const root = document.createElement("div");
    await createMapView(root, {
      config: { ...MAP, center: [1, 2], zoom: 7 },
      load: async () => L,
    }).show([]);
    expect(setView).toHaveBeenCalledWith([1, 2], 7);
  });
});

describe("mapView.createPinMap", () => {
  it("centers a single marker on the event", async () => {
    const L = fakeLeaflet();
    const root = document.createElement("div");
    await createPinMap(root, { config: MAP, load: async () => L }).show(
      sampleEvent(),
    );
    expect(root.querySelector(".map")).not.toBeNull();
    expect(L.marker).toHaveBeenCalledWith([32.8797, -117.2362], {
      title: "Taco Tuesday",
    });
  });

  it("explains when the event has no coordinates", async () => {
    const load = vi.fn();
    const root = document.createElement("div");
    await createPinMap(root, { config: MAP, load }).show(
      sampleEvent({ location: { name: "TBD" } }),
    );
    expect(load).not.toHaveBeenCalled();
    expect(root.textContent).toContain("No map pin");
  });

  it("shows an error when Leaflet fails, and does nothing once destroyed", async () => {
    const failing = document.createElement("div");
    await createPinMap(failing, {
      config: MAP,
      load: async () => {
        throw new Error("offline");
      },
    }).show(sampleEvent());
    expect(failing.querySelector("[role=alert]")).not.toBeNull();

    const L = fakeLeaflet();
    const root = document.createElement("div");
    const pin = createPinMap(root, { config: MAP, load: async () => L });
    const pending = pin.show(sampleEvent());
    pin.destroy();
    await pending;
    expect(L.map).not.toHaveBeenCalled();
  });
});

function fakeLeaflet() {
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
  });
  return {
    map: vi.fn(chain),
    tileLayer: vi.fn(chain),
    layerGroup: vi.fn(chain),
    marker: vi.fn(chain),
  };
}

describe("filterBar", () => {
  it("renders tags/groups and emits changes; search is debounced", async () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    const root = document.createElement("div");
    document.body.replaceChildren(root);
    const bar = createFilterBar(root, { onChange, debounceMs: 300 });
    bar.render(
      { tags: ["food"], group: "", q: "", nearMe: false },
      {
        tags: [
          { value: "food", count: 2 },
          { value: "music", count: 1 },
        ],
        groups: [{ value: "ACM", count: 4 }],
      },
    );
    const chips = root.querySelectorAll(".chip");
    expect(chips[0].getAttribute("aria-pressed")).toBe("true");
    chips[1].click();
    expect(onChange).toHaveBeenLastCalledWith({ tags: ["food", "music"] });
    const select = root.querySelector("select");
    expect([...select.options].map((o) => o.textContent)).toEqual([
      "All groups",
      "ACM (4)",
    ]);
    select.value = "ACM";
    select.dispatchEvent(new Event("change"));
    expect(onChange).toHaveBeenLastCalledWith({ group: "ACM" });
    const input = root.querySelector("input[type=search]");
    input.value = "ta";
    input.dispatchEvent(new Event("input"));
    input.value = "tacos";
    input.dispatchEvent(new Event("input"));
    expect(onChange).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(300);
    expect(onChange).toHaveBeenLastCalledWith({ q: "tacos" });
    root.querySelector("button.btn").click();
    expect(onChange).toHaveBeenLastCalledWith({ nearMe: true });
    vi.useRealTimers();
  });
});

describe("geo", () => {
  it("keeps the position in memory only and can clear it", async () => {
    const geolocation = {
      getCurrentPosition: (ok) =>
        ok({ coords: { latitude: 32.88, longitude: -117.23 } }),
    };
    const g = createGeo({ geolocation });
    expect(g.position).toBeNull();
    expect(await g.request()).toEqual({ lat: 32.88, lng: -117.23 });
    expect(g.position).toEqual({ lat: 32.88, lng: -117.23 });
    g.clear();
    expect(g.position).toBeNull();
    await expect(createGeo({ geolocation: null }).request()).rejects.toThrow();
  });
});
