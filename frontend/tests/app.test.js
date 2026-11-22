import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { jsonResponse, memoryStorage, sampleEvent } from './helpers.js';
import { dayKey } from '../src/filters.js';

globalThis.__CM_NO_AUTOSTART__ = true;
const { start } = await import('../src/app.js');

const html = readFileSync(resolve(__dirname, '../index.html'), 'utf8');
const flush = () => new Promise((r) => setTimeout(r, 0));

function routes(url) {
  const path = url.split('?')[0];
  return {
    '/api/config': { devMode: true, jetstreamEnabled: false, eventNsid: 'app.communitymap.event', listenerNsid: 'app.communitymap.listener' },
    '/api/events': { events: [sampleEvent({ startsAt: new Date(Date.now() + 3600e3).toISOString(), endsAt: new Date(Date.now() + 7200e3).toISOString() })], cursor: null },
    '/api/tags': [{ value: 'food', count: 1 }],
    '/api/groups': [{ value: 'Triton Eats', count: 1 }],
    '/api/subscriptions': [],
  }[path];
}

describe('app (smoke)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('boots in demo mode and renders events, tags and the New event button', async () => {
    document.documentElement.innerHTML = html.replace(/<script[^>]*><\/script>/, '');
    vi.stubGlobal('localStorage', memoryStorage());
    vi.stubGlobal('sessionStorage', memoryStorage());
    const mapInstance = { setView() { return this; }, invalidateSize: vi.fn(), fitBounds: vi.fn() };
    const layer = { addTo() { return this; }, clearLayers: vi.fn() };
    const marker = { bindPopup() { return this; }, addTo() { return this; } };
    const leaflet = {
      map: vi.fn(() => mapInstance), tileLayer: vi.fn(() => ({ addTo() {} })),
      layerGroup: vi.fn(() => layer), marker: vi.fn(() => marker),
    };
    vi.stubGlobal('L', leaflet);
    const f = vi.fn(async (url) => jsonResponse(routes(url) ?? { error: 'nf' }, routes(url) ? 200 : 404));
    vi.stubGlobal('fetch', f);
    await start();
    await flush(); await flush();
    expect(document.querySelectorAll('#list article')).toHaveLength(1);
    expect(document.querySelector('#filters .chip').textContent).toBe('#food');
    expect(document.querySelector('#account').textContent).toContain('Demo mode');
    expect(document.querySelector('#account').textContent).toContain('New event');
    // Location is never sent to the backend.
    expect(f.mock.calls.every(([u]) => !/lat|lng|near/i.test(u))).toBe(true);

    document.querySelector('#filters .chip').click();
    await flush();
    expect(f.mock.calls.some(([u]) => u.startsWith('/api/events?') && u.includes('tag=food'))).toBe(true);

    expect(document.querySelector('[role=tablist]')).toBeNull();
    expect(document.querySelector('#panel-map').hidden).toBe(false);
    expect(document.querySelector('#panel-list').hidden).toBe(false);
    expect(document.querySelector('#map .map')).not.toBeNull();
    expect(leaflet.map).toHaveBeenCalledTimes(1);
    expect(leaflet.marker).toHaveBeenCalledWith([32.8797, -117.2362], expect.any(Object));

    // Date filtering must include later pages, and update the list and map together.
    const today = new Date();
    const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 12);
    const tomorrow = new Date(todayStart); tomorrow.setDate(tomorrow.getDate() + 1);
    const todayEvent = sampleEvent({ uri: 'at://today', name: 'Selected day event', startsAt: todayStart.toISOString(), endsAt: new Date(+todayStart + 3600e3).toISOString() });
    const tomorrowEvent = sampleEvent({ uri: 'at://tomorrow', name: 'Other day event', startsAt: tomorrow.toISOString(), endsAt: new Date(+tomorrow + 3600e3).toISOString() });
    f.mockImplementation(async (url) => {
      if (url.startsWith('/api/events?')) return jsonResponse(url.includes('cursor=page2')
        ? { events: [todayEvent], cursor: null } : { events: [tomorrowEvent], cursor: 'page2' });
      return jsonResponse(routes(url) ?? [], 200);
    });
    document.querySelector('.date-filter__trigger').click();
    document.querySelector(`[data-date="${dayKey(today)}"]`).click();
    [...document.querySelectorAll('#event-date-picker button')].find((b) => b.textContent === 'Apply').click();
    await flush(); await flush();
    expect(f.mock.calls.some(([url]) => url.includes('cursor=page2'))).toBe(true);
    expect(document.querySelector('#list').textContent).toContain('Selected day event');
    expect(document.querySelector('#list').textContent).not.toContain('Other day event');
    expect(leaflet.marker).toHaveBeenLastCalledWith([32.8797, -117.2362], { title: 'Selected day event' });
  });
});
