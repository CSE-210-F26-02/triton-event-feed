/**
 * Map workspace displayed alongside the event list. Leaflet loads once on first render.
 * Everything deployment-specific (Leaflet URLs, tile provider, default view) comes from
 * the app config (src/config.js, read from frontend/.env), so it can be swapped
 * (e.g. Overture/Protomaps) without code changes.
 * @module views/mapView
 */
import { createElementTree } from "../dom.js";
import { coordsOf } from "../filters.js";
import { formatTimeWindow } from "../format.js";

/**
 * @typedef {import('../config.js').MapConfig} MapConfig
 */

/** Fields every map config must have (see MapConfig). */
const MAP_CONFIG_FIELDS = Object.freeze([
  "leafletJs",
  "leafletCss",
  "tileUrl",
  "attribution",
  "maxZoom",
  "center",
  "zoom",
]);

/**
 * Check a map config has every field, so a missing setting fails loudly at startup
 * instead of as a blank map.
 * @param {unknown} config
 * @returns {MapConfig}
 * @throws {TypeError} naming the missing fields
 */
export function assertMapConfig(config) {
  const missing = MAP_CONFIG_FIELDS.filter((field) => config?.[field] == null);
  if (missing.length)
    throw new TypeError(
      `Map config is missing: ${missing.join(", ")} (see src/config.js)`,
    );
  return /** @type {MapConfig} */ (config);
}

/**
 * Pure: events → marker descriptors (only events with valid coordinates).
 * @param {object[]} events
 * @param {{locale?: string, timeZone?: string}} [options]
 * @returns {{uri: string, lat: number, lng: number, title: string, subtitle: string}[]}
 */
export function buildMarkers(events, options = {}) {
  return (events || []).flatMap((event) => {
    const coordinates = coordsOf(event);
    if (!coordinates) return [];
    const when = formatTimeWindow(event.startsAt, event.endsAt, options);
    return [
      {
        uri: event.uri,
        lat: coordinates.lat,
        lng: coordinates.lng,
        title: event.name,
        subtitle: `${when} · ${event.location?.name ?? ""}`,
      },
    ];
  });
}

let leafletPromise = null;

/**
 * Inject Leaflet's CSS + script once and resolve with the library (Leaflet defines
 * itself as the global `window.L`; that name is the library's, not ours).
 * @param {MapConfig} config
 * @returns {Promise<any>}
 */
export function loadLeaflet(config) {
  if (globalThis.L) return Promise.resolve(globalThis.L);
  leafletPromise ??= new Promise((resolve, reject) => {
    document.head.append(
      createElementTree("link", { rel: "stylesheet", href: config.leafletCss }),
    );
    const script = createElementTree("script", {
      src: config.leafletJs,
      async: true,
    });
    script.onload = () => resolve(globalThis.L);
    script.onerror = () => {
      leafletPromise = null;
      script.remove();
      reject(new Error("Map library failed to load"));
    };
    document.head.append(script);
  });
  return leafletPromise;
}

/**
 * Create the map view.
 * @param {HTMLElement} root
 * @param {{config: MapConfig, onOpen?: (uri: string) => void,
 *   load?: (mapConfig: MapConfig) => Promise<any>}} opts
 * @returns {{show(events: object[]): Promise<void>}}
 * @throws {TypeError} when the map config is incomplete
 */
export function createMapView(root, { onOpen, config, load = loadLeaflet }) {
  const mapConfig = assertMapConfig(config);
  let map = null;
  let layer = null;
  let leaflet = null;
  let initializing = null;
  let renderSequence = 0;

  async function ensureMap() {
    if (map) return map;
    if (!initializing) {
      root.replaceChildren(
        createElementTree("p", { role: "status" }, "Loading map…"),
      );
      initializing = (async () => {
        leaflet = await load(mapConfig);
        const mapContainer = createElementTree("div", {
          class: "map",
          role: "region",
          "aria-label": "Event map",
        });
        root.replaceChildren(
          mapContainer,
          createElementTree(
            "p",
            { class: "visually-hidden" },
            "All events are also available in the adjacent event list.",
          ),
        );
        map = leaflet
          .map(mapContainer)
          .setView(mapConfig.center, mapConfig.zoom);
        leaflet
          .tileLayer(mapConfig.tileUrl, {
            maxZoom: mapConfig.maxZoom,
            attribution: mapConfig.attribution,
          })
          .addTo(map);
        layer = leaflet.layerGroup().addTo(map);
        return map;
      })().catch((error) => {
        initializing = null;
        throw error;
      });
    }
    return initializing;
  }

  function popup(markerInfo) {
    return createElementTree(
      "div",
      null,
      createElementTree("strong", null, markerInfo.title),
      createElementTree("br"),
      createElementTree("span", null, markerInfo.subtitle),
      createElementTree("br"),
      createElementTree(
        "button",
        {
          type: "button",
          class: "btn",
          onclick: () => onOpen?.(markerInfo.uri),
        },
        "Details",
      ),
    );
  }

  async function show(events) {
    const sequence = ++renderSequence;
    try {
      await ensureMap();
    } catch {
      if (sequence !== renderSequence) return;
      root.replaceChildren(
        createElementTree(
          "p",
          { class: "notice notice--error", role: "alert" },
          "The map could not load (poor connection?). The list view still works.",
        ),
      );
      return;
    }
    if (sequence !== renderSequence) return;
    layer.clearLayers();
    const markers = buildMarkers(events);
    for (const markerInfo of markers)
      leaflet
        .marker([markerInfo.lat, markerInfo.lng], { title: markerInfo.title })
        .bindPopup(popup(markerInfo))
        .addTo(layer);
    map.invalidateSize();
    if (markers.length)
      map.fitBounds(
        markers.map((markerInfo) => [markerInfo.lat, markerInfo.lng]),
        { maxZoom: 17, padding: [24, 24] },
      );
  }

  return { show };
}

/**
 * Small single-pin map used inside the event detail pane. Shares the Leaflet loader
 * (and therefore the browser's tile cache) with the main map.
 * @param {HTMLElement} root container; must be in the document before show() resolves
 * @param {{config: MapConfig, load?: (mapConfig: MapConfig) => Promise<any>}} options
 * @returns {{show(event: object): Promise<void>, destroy(): void}}
 * @throws {TypeError} when the map config is incomplete
 */
export function createPinMap(root, { config, load = loadLeaflet }) {
  const mapConfig = assertMapConfig(config);
  let pinMap = null;
  let destroyed = false;

  /** Render the pin for `event` (or a notice when it has no coordinates). */
  async function show(event) {
    const coords = coordsOf(event);
    if (!coords) {
      root.replaceChildren(
        createElementTree(
          "p",
          { class: "muted detail__map-note" },
          "No map pin for this location.",
        ),
      );
      return;
    }
    root.replaceChildren(
      createElementTree("p", { role: "status" }, "Loading map…"),
    );
    let leaflet;
    try {
      leaflet = await load(mapConfig);
    } catch {
      if (!destroyed)
        root.replaceChildren(
          createElementTree(
            "p",
            { class: "notice notice--error", role: "alert" },
            "The map could not load.",
          ),
        );
      return;
    }
    if (destroyed) return;
    const mapElement = createElementTree("div", {
      class: "map",
      role: "img",
      "aria-label": `Map showing ${event.location?.name ?? "the event location"}`,
    });
    root.replaceChildren(mapElement);
    pinMap = leaflet.map(mapElement).setView([coords.lat, coords.lng], 17);
    leaflet
      .tileLayer(mapConfig.tileUrl, {
        maxZoom: mapConfig.maxZoom,
        attribution: mapConfig.attribution,
      })
      .addTo(pinMap);
    leaflet
      .marker([coords.lat, coords.lng], { title: event.name })
      .addTo(pinMap);
    pinMap.invalidateSize();
  }

  /** Release the Leaflet instance (call before discarding the container). */
  function destroy() {
    destroyed = true;
    pinMap?.remove?.();
    pinMap = null;
  }

  return { show, destroy };
}
