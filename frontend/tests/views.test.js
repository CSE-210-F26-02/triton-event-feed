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
const TEST_MAP_CONFIG = (await testConfig()).map;

describe("mapView.buildMarkers", () => {
  it("keeps only events with valid coordinates", () => {
    const delayMs = buildMarkers(
      [sampleEvent(), sampleEvent({ uri: "x", location: { name: "No pin" } })],
      { timeZone: "UTC", locale: "en-US" },
    );
    expect(delayMs).toEqual([
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
    const leaflet = fakeLeaflet();
    globalThis.L = leaflet;
    const root = document.createElement("div");
    const view = createMapView(root, {
      config: {
        ...TEST_MAP_CONFIG,
        tileUrl: "https://tiles.example/{z}/{x}/{y}.pbf",
      },
      load: async () => leaflet,
    });
    await view.show([sampleEvent()]);
    expect(leaflet.tileLayer).toHaveBeenCalledWith(
      "https://tiles.example/{z}/{x}/{y}.pbf",
      expect.objectContaining({
        maxZoom: TEST_MAP_CONFIG.maxZoom,
        attribution: TEST_MAP_CONFIG.attribution,
      }),
    );
    expect(leaflet.marker).toHaveBeenCalledTimes(1);
    delete globalThis.L;
  });

  it("shows an error when Leaflet fails to load", async () => {
    const root = document.createElement("div");
    await createMapView(root, {
      config: TEST_MAP_CONFIG,
      load: async () => {
        throw new Error("x");
      },
    }).show([]);
    expect(root.querySelector("[role=alert]")).not.toBeNull();
  });

  it("initializes once and uses the latest events while the map loads", async () => {
    const leaflet = fakeLeaflet();
    let finishLoading;
    const load = vi.fn(
      () =>
        new Promise((resolve) => {
          finishLoading = resolve;
        }),
    );
    const view = createMapView(document.createElement("div"), {
      config: TEST_MAP_CONFIG,
      load,
    });
    const firstShow = view.show([sampleEvent()]);
    const latest = view.show([
      sampleEvent({
        name: "Updated event",
        location: { lat: 32.88, lng: -117.23 },
      }),
    ]);
    finishLoading(leaflet);
    await Promise.all([firstShow, latest]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(leaflet.map).toHaveBeenCalledTimes(1);
    expect(leaflet.marker).toHaveBeenCalledTimes(1);
    expect(leaflet.marker).toHaveBeenCalledWith([32.88, -117.23], {
      title: "Updated event",
    });
  });
});

describe("mapView config (from frontend/.env)", () => {
  it("accepts a complete config and returns it", () => {
    expect(assertMapConfig(TEST_MAP_CONFIG)).toBe(TEST_MAP_CONFIG);
  });

  it("names every missing field", () => {
    const { tileUrl: _tileUrl, zoom: _zoom, ...partial } = TEST_MAP_CONFIG;
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
    const leaflet = fakeLeaflet();
    const setView = vi.fn(function () {
      return this;
    });
    leaflet.map = vi.fn(() => ({
      setView,
      invalidateSize() {},
      fitBounds() {},
    }));
    const root = document.createElement("div");
    await createMapView(root, {
      config: { ...TEST_MAP_CONFIG, center: [1, 2], zoom: 7 },
      load: async () => leaflet,
    }).show([]);
    expect(setView).toHaveBeenCalledWith([1, 2], 7);
  });
});

describe("mapView.createPinMap", () => {
  it("centers a single marker on the event", async () => {
    const leaflet = fakeLeaflet();
    const root = document.createElement("div");
    await createPinMap(root, {
      config: TEST_MAP_CONFIG,
      load: async () => leaflet,
    }).show(sampleEvent());
    expect(root.querySelector(".map")).not.toBeNull();
    expect(leaflet.marker).toHaveBeenCalledWith([32.8797, -117.2362], {
      title: "Taco Tuesday",
    });
  });

  it("explains when the event has no coordinates", async () => {
    const load = vi.fn();
    const root = document.createElement("div");
    await createPinMap(root, { config: TEST_MAP_CONFIG, load }).show(
      sampleEvent({ location: { name: "TBD" } }),
    );
    expect(load).not.toHaveBeenCalled();
    expect(root.textContent).toContain("No map pin");
  });

  it("shows an error when Leaflet fails, and does nothing once destroyed", async () => {
    const failing = document.createElement("div");
    await createPinMap(failing, {
      config: TEST_MAP_CONFIG,
      load: async () => {
        throw new Error("offline");
      },
    }).show(sampleEvent());
    expect(failing.querySelector("[role=alert]")).not.toBeNull();

    const leaflet = fakeLeaflet();
    const root = document.createElement("div");
    const pinMap = createPinMap(root, {
      config: TEST_MAP_CONFIG,
      load: async () => leaflet,
    });
    const pending = pinMap.show(sampleEvent());
    pinMap.destroy();
    await pending;
    expect(leaflet.map).not.toHaveBeenCalled();
  });
});

function fakeLeaflet() {
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
  });
  return {
    map: vi.fn(fakeLayer),
    tileLayer: vi.fn(fakeLayer),
    layerGroup: vi.fn(fakeLayer),
    marker: vi.fn(fakeLayer),
  };
}

describe("filterBar", () => {
  it("renders tags/groups and emits changes; search is debounced", async () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    const root = document.createElement("div");
    document.body.replaceChildren(root);
    const filterBar = createFilterBar(root, { onChange, debounceMs: 300 });
    filterBar.render(
      { tags: ["food"], group: "", searchText: "", nearMe: false },
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
    expect([...select.options].map((option) => option.textContent)).toEqual([
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
    expect(onChange).toHaveBeenLastCalledWith({ searchText: "tacos" });
    root.querySelector("button.btn").click();
    expect(onChange).toHaveBeenLastCalledWith({ nearMe: true });
    vi.useRealTimers();
  });
});

describe("geo", () => {
  it("keeps the position in memory only and can clear it", async () => {
    const geolocation = {
      getCurrentPosition: (onSuccess) =>
        onSuccess({ coords: { latitude: 32.88, longitude: -117.23 } }),
    };
    const geo = createGeo({ geolocation });
    expect(geo.position).toBeNull();
    expect(await geo.request()).toEqual({ lat: 32.88, lng: -117.23 });
    expect(geo.position).toEqual({ lat: 32.88, lng: -117.23 });
    geo.clear();
    expect(geo.position).toBeNull();
    await expect(createGeo({ geolocation: null }).request()).rejects.toThrow();
  });
});
