/**
 * Map workspace displayed alongside the event list. Leaflet loads once on first render.
 * The tile provider is configuration so it can be swapped (e.g. Overture/Protomaps).
 * @module views/mapView
 */
import { h } from '../dom.js';
import { coordsOf } from '../filters.js';
import { formatTimeWindow } from '../format.js';

/** Default map configuration. Override any field via createMapView({config}). */
export const MAP_CONFIG = Object.freeze({
  leafletJs: 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  leafletCss: 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  tileUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  maxZoom: 19,
  center: [32.8801, -117.234], // UCSD
  zoom: 15,
});

/**
 * Pure: events → marker descriptors (only events with valid coordinates).
 * @param {object[]} events
 * @param {{locale?: string, timeZone?: string}} [opts]
 * @returns {{uri: string, lat: number, lng: number, title: string, subtitle: string}[]}
 */
export function buildMarkers(events, opts = {}) {
  return (events || []).flatMap((ev) => {
    const c = coordsOf(ev);
    if (!c) return [];
    const when = formatTimeWindow(ev.startsAt, ev.endsAt, opts);
    return [{ uri: ev.uri, lat: c.lat, lng: c.lng, title: ev.name, subtitle: `${when} · ${ev.location?.name ?? ''}` }];
  });
}

let leafletPromise = null;

/**
 * Inject Leaflet's CSS + script once and resolve with window.L.
 * @param {typeof MAP_CONFIG} config
 * @returns {Promise<any>}
 */
export function loadLeaflet(config = MAP_CONFIG) {
  if (globalThis.L) return Promise.resolve(globalThis.L);
  leafletPromise ??= new Promise((resolve, reject) => {
    document.head.append(h('link', { rel: 'stylesheet', href: config.leafletCss }));
    const script = h('script', { src: config.leafletJs, async: true });
    script.onload = () => resolve(globalThis.L);
    script.onerror = () => {
      leafletPromise = null;
      script.remove();
      reject(new Error('Map library failed to load'));
    };
    document.head.append(script);
  });
  return leafletPromise;
}

/**
 * Create the map view.
 * @param {HTMLElement} root
 * @param {{onOpen?: (uri: string) => void, config?: Partial<typeof MAP_CONFIG>,
 *   load?: (c: typeof MAP_CONFIG) => Promise<any>}} [opts]
 * @returns {{show(events: object[]): Promise<void>}}
 */
export function createMapView(root, { onOpen, config = {}, load = loadLeaflet } = {}) {
  const cfg = { ...MAP_CONFIG, ...config };
  let map = null;
  let layer = null;
  let leaflet = null;
  let initializing = null;
  let renderSequence = 0;

  async function ensureMap() {
    if (map) return map;
    if (!initializing) {
      root.replaceChildren(h('p', { role: 'status' }, 'Loading map…'));
      initializing = (async () => {
        const L = await load(cfg);
        leaflet = L;
        const el = h('div', { class: 'map', role: 'region', 'aria-label': 'Event map' });
        root.replaceChildren(el, h('p', { class: 'visually-hidden' }, 'All events are also available in the adjacent event list.'));
        map = L.map(el).setView(cfg.center, cfg.zoom);
        L.tileLayer(cfg.tileUrl, { maxZoom: cfg.maxZoom, attribution: cfg.attribution }).addTo(map);
        layer = L.layerGroup().addTo(map);
        return map;
      })().catch((err) => { initializing = null; throw err; });
    }
    return initializing;
  }

  function popup(m) {
    return h('div', null,
      h('strong', null, m.title), h('br'), h('span', null, m.subtitle), h('br'),
      h('button', { type: 'button', class: 'btn', onclick: () => onOpen?.(m.uri) }, 'Details'),
    );
  }

  async function show(events) {
    const sequence = ++renderSequence;
    try {
      await ensureMap();
    } catch {
      if (sequence !== renderSequence) return;
      root.replaceChildren(h('p', { class: 'notice notice--error', role: 'alert' },
        'The map could not load (poor connection?). The list view still works.'));
      return;
    }
    if (sequence !== renderSequence) return;
    const L = leaflet;
    layer.clearLayers();
    const markers = buildMarkers(events);
    for (const m of markers) L.marker([m.lat, m.lng], { title: m.title }).bindPopup(popup(m)).addTo(layer);
    map.invalidateSize();
    if (markers.length) map.fitBounds(markers.map((m) => [m.lat, m.lng]), { maxZoom: 17, padding: [24, 24] });
  }

  return { show };
}
