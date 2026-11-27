/**
 * Application entry: wires store, API, views, writers, subscriptions and notifications.
 * @module app
 */
import { createApi } from "./api.js";
import { createAtprotoWriter } from "./atproto.js";
import { loadConfig, loadMockConfig } from "./config.js";
import { createDevWriter } from "./devWriter.js";
import { h } from "./dom.js";
import {
  EMPTY_FILTERS,
  buildEventQuery,
  filterEventsByDate,
  sortByDistance,
  toggleTag,
} from "./filters.js";
import { createGeo } from "./geo.js";
import { createNotifications } from "./notifications.js";
import { SUBSCRIPTIONS_ROUTE, createRouter, shareUrl } from "./router.js";
import { createStore } from "./store.js";
import { createSubscriptionController } from "./subscriptionController.js";
import { createSubscriptions } from "./subscriptions.js";
import { createToaster } from "./toast.js";
import { createComposeView } from "./views/composeView.js";
import { createDetailView } from "./views/detailView.js";
import { createDateFilter } from "./views/dateFilter.js";
import { createFilterBar } from "./views/filterBar.js";
import { createListView } from "./views/listView.js";
import { createLoginView } from "./views/loginView.js";
import { createMapView } from "./views/mapView.js";
import { createSubscriptionsView } from "./views/subscriptionsView.js";

const $ = (sel) => document.querySelector(sel);

/** `.events-layout[data-view]` per route view (CSS uses it for the mobile layout). */
const LAYOUT_VIEW = Object.freeze({
  list: "map",
  event: "detail",
  subscriptions: "subscriptions",
});

/** Login reason shown when opening My subscriptions while logged out. */
const LOGIN_FOR_SUBSCRIPTIONS_REASON = "Log in to see your subscriptions.";

/**
 * Read a config (from frontend/.env via import.meta.env). When it is invalid, show what
 * is wrong on the page instead of starting a half-working app.
 * @template T
 * @param {() => T} read e.g. () => loadConfig(import.meta.env)
 * @returns {T|null}
 */
function configOrReport(read) {
  try {
    return read();
  } catch (error) {
    console.error(error);
    const problems = error.problems ?? [String(error.message ?? error)];
    $("#list")?.replaceChildren(
      h(
        "div",
        { class: "notice notice--error", role: "alert" },
        h("p", null, "The app is not configured correctly:"),
        h(
          "ul",
          null,
          problems.map((problem) => h("li", null, problem)),
        ),
        h("p", null, "See frontend/.env.example."),
      ),
    );
    $("#list")?.setAttribute("aria-busy", "false");
    return null;
  }
}

/**
 * Start the app. Configuration (API location, AT Protocol services, map, and the
 * ?mock demo tokens) comes from frontend/.env via import.meta.env; see src/config.js
 * and frontend/.env.example.
 * @param {{config?: import('./config.js').AppConfig,
 *   mockConfig?: import('./config.js').MockConfig}} [opts] tests pass configs
 */
export async function start({ config, mockConfig } = {}) {
  const appConfig = config ?? configOrReport(() => loadConfig(import.meta.env));
  if (!appConfig) return;
  const mock = await mockOptions(
    () => mockConfig ?? loadMockConfig(import.meta.env),
  );
  if (!mock) return;
  const api = createApi({ baseUrl: appConfig.apiBaseUrl, ...mock.api });
  const toast = createToaster($("#toasts"));
  const geo = createGeo();
  const atproto = createAtprotoWriter({
    ...appConfig.atproto,
    ...mock.atproto,
  });
  let devWriter = null;
  const store = createStore({
    config: null,
    filters: { ...EMPTY_FILTERS },
    events: [],
    cursor: null,
    loading: false,
    stale: false,
    savedAt: null,
    error: null,
    tags: [],
    groups: [],
    subscribed: new Set(),
    locating: false,
    dateFilter: null,
  });

  const writer = () => (atproto.loggedIn ? atproto : devWriter);
  const canEdit = (ev) =>
    Boolean(writer()) && ev.authorDid === writer().did && ev.source !== "ical";

  // --- data loading ---
  let seq = 0;
  async function loadEvents({ append = false } = {}) {
    const mine = ++seq;
    const { filters, cursor, events } = store.get();
    store.set({ loading: true, error: null });
    try {
      let nextCursor = append ? cursor : null;
      let merged = append ? events : [];
      let anyStale = false;
      let savedAt = null;
      const seenCursors = new Set();
      do {
        const response = await api.listEvents(
          buildEventQuery(filters, { cursor: nextCursor }),
        );
        if (mine !== seq) return;
        merged = dedupe([...merged, ...response.data.events]);
        nextCursor = response.data.cursor ?? null;
        anyStale ||= response.stale;
        savedAt = response.savedAt ?? savedAt;
        if (!store.get().dateFilter || !nextCursor) break;
        if (seenCursors.has(nextCursor))
          throw new Error("Repeated event cursor");
        seenCursors.add(nextCursor);
      } while (nextCursor);
      store.set({
        events: merged,
        cursor: nextCursor,
        stale: anyStale,
        savedAt,
        loading: false,
      });
    } catch (err) {
      if (mine !== seq) return;
      store.set({
        loading: false,
        error: err.offline
          ? "You're offline and no saved events are available yet."
          : "Could not load events. Please try again.",
      });
    }
  }

  async function loadFacets() {
    const [tags, groups] = await Promise.allSettled([api.tags(), api.groups()]);
    store.set({
      tags: tags.status === "fulfilled" ? tags.value.data : [],
      groups: groups.status === "fulfilled" ? groups.value.data : [],
    });
  }

  // --- filters ---
  async function changeFilters(patch) {
    const filters = { ...store.get().filters, ...patch };
    if (patch.nearMe && !geo.position) {
      store.set({ locating: true });
      try {
        await geo.request();
      } catch (err) {
        toast(err.message, { kind: "error" });
        filters.nearMe = false;
      }
      store.set({ locating: false });
    }
    if (!filters.nearMe) geo.clear();
    store.set({ filters });
    const refetch = ["tags", "group", "q"].some((k) => k in patch);
    if (refetch) loadEvents();
  }

  const visibleEvents = () => {
    const { events, filters, dateFilter } = store.get();
    const matching = filterEventsByDate(events, dateFilter);
    return filters.nearMe && geo.position
      ? sortByDistance(matching, geo.position)
      : matching;
  };

  // --- views ---
  const findEvent = (uri) =>
    store.get().events.find((e) => e.uri === uri) ?? null;
  const notifications = createNotifications({
    api,
    toast,
    onNotification: (n) => applyNotification(n),
  });
  // #19: subscriptions are records on the logged-in user's PDS (demo mode has no PDS).
  const subs = createSubscriptions({
    getRepo: () => (atproto.loggedIn ? atproto : null),
    onChange: (subscribed) => {
      store.set({ subscribed });
      notifications.watch(subscribed.size ? atproto.did : null);
    },
  });
  const subscribing = createSubscriptionController({
    subscriptions: subs,
    notifications,
    toast,
    isLoggedIn: () => atproto.loggedIn,
    requestLogin: (request) => login.open(request),
    openEvent: (uri) => router.openEvent(uri),
  });
  const detail = createDetailView($("#panel-detail"), {
    api,
    mapConfig: appConfig.map,
    findEvent,
    canEdit,
    isSubscribed: (uri) => store.get().subscribed.has(uri),
    onToggleSubscribe: (ev) => subscribing.toggle(ev),
    onEdit: (ev) => compose.open(ev),
    onDelete: (ev) => compose.remove(ev),
    onClose: () => router.home(),
    onCopyLink: (uri) => copyEventLink(uri),
  });
  const router = createRouter({ onChange: applyRoute });
  const compose = createComposeView({
    getWriter: writer,
    geo,
    toast,
    onSaved: () => {
      toast("Event saved. It can take a few seconds to appear.");
      setTimeout(() => {
        loadEvents();
        loadFacets();
        if (detail.currentUri) detail.open(detail.currentUri);
      }, 1500);
    },
    onDeleted: (uri) => {
      toast("Event deleted.");
      store.set({ events: store.get().events.filter((e) => e.uri !== uri) });
      if (detail.currentUri === uri) router.home();
    },
  });
  const subscriptionsPage = createSubscriptionsView($("#panel-subscriptions"), {
    api,
    findEvent,
    getSubscribed: () => store.get().subscribed,
    isLoggedIn: () => atproto.loggedIn,
    onLogin: () => login.open({ reason: LOGIN_FOR_SUBSCRIPTIONS_REASON }),
    onClose: () => router.home(),
    onOpen: (uri) => router.openEvent(uri),
    onToggleSubscribe: (ev) => subscribing.toggle(ev),
    onUnsubscribe: (uri) => subscribing.unsubscribe(uri),
  });
  const login = createLoginView({
    login: (id, pw) => atproto.login(id, pw),
    onLoggedIn: async () => {
      renderAccount();
      await subscribing.reload();
    },
  });
  const filterBar = createFilterBar($("#filters"), {
    onChange: changeFilters,
    geoSupported: geo.supported,
  });
  const datePicker = createDateFilter($("#event-date-filter"), {
    onChange: (dateFilter) => {
      store.set({ dateFilter });
      loadEvents();
    },
  });
  const list = createListView($("#list"), {
    onLoadMore: () => loadEvents({ append: true }),
  });
  const map = createMapView($("#map"), {
    config: appConfig.map,
    onOpen: (uri) => router.openEvent(uri),
  });

  /**
   * Fill the map column for the route: the map (list route), the event detail pane, or
   * My subscriptions. Only one of the three panes is visible at a time.
   * @param {import('./router.js').Route} route
   */
  function applyRoute(route) {
    const view = LAYOUT_VIEW[route.view] ? route.view : "list";
    $(".events-layout").dataset.view = LAYOUT_VIEW[view];
    $("#panel-map").hidden = view !== "list";
    $("#panel-detail").hidden = view !== "event";
    $("#panel-subscriptions").hidden = view !== "subscriptions";
    if (view === "event") detail.open(route.uri);
    else detail.close();
    if (view === "subscriptions") subscriptionsPage.open();
    else subscriptionsPage.close();
    // The map was hidden; re-show so Leaflet re-measures its container.
    if (view === "list") render();
  }

  /**
   * Copy an event's shareable URL to the clipboard.
   * @param {string} uri
   */
  async function copyEventLink(uri) {
    try {
      await navigator.clipboard.writeText(shareUrl(uri));
      toast("Link copied.");
    } catch {
      toast("Could not copy — use the address bar link instead.", {
        kind: "error",
      });
    }
  }

  async function applyNotification(n) {
    const { events } = store.get();
    if (detail.currentUri === n.eventUri) detail.open(n.eventUri);
    if (n.kind === "deleted" || n.kind === "expired") {
      store.set({ events: events.filter((e) => e.uri !== n.eventUri) });
    } else if (
      n.kind === "updated" &&
      events.some((e) => e.uri === n.eventUri)
    ) {
      try {
        const { data } = await api.getEvent(n.eventUri);
        store.set({
          events: store
            .get()
            .events.map((e) => (e.uri === data.uri ? data : e)),
        });
      } catch {
        /* keep old copy */
      }
    }
  }

  function render() {
    const s = store.get();
    filterBar.render(s.filters, {
      tags: s.tags,
      groups: s.groups,
      nearMeBusy: s.locating,
    });
    datePicker.render(s.dateFilter);
    const shown = visibleEvents();
    list.render({
      events: shown,
      hasMore: Boolean(s.cursor),
      loading: s.loading,
      stale: s.stale,
      savedAt: s.savedAt,
      error: s.error,
      activeTags: s.filters.tags,
      subscribed: s.subscribed,
      onOpen: (uri) => router.openEvent(uri),
      onTagClick: (tag) =>
        changeFilters({ tags: toggleTag(store.get().filters.tags, tag) }),
      onToggleSubscribe: (ev) => subscribing.toggle(ev),
    });
    map.show(shown);
    detail.refreshActions();
    subscriptionsPage.refresh();
  }

  function renderAccount() {
    const root = $("#account");
    const canPost = Boolean(writer());
    const items = [];
    if (atproto.loggedIn) {
      items.push(
        h("span", { class: "muted" }, `@${atproto.handle}`),
        renderMySubscriptionsLink(),
        h(
          "button",
          {
            type: "button",
            class: "btn",
            onclick: async () => {
              await atproto.logout();
              subs.clear();
              renderAccount();
            },
          },
          "Log out",
        ),
      );
    } else {
      if (devWriter)
        items.push(
          h(
            "span",
            { class: "badge", title: "Posts go to the local dev index only" },
            "Demo mode",
          ),
        );
      items.push(
        h(
          "button",
          {
            type: "button",
            class: "btn btn--gold",
            onclick: () => login.open(),
          },
          "Log in",
        ),
      );
    }
    if (canPost)
      items.push(
        h(
          "button",
          {
            type: "button",
            class: "btn btn--primary",
            onclick: () => compose.open(),
          },
          "New event",
        ),
      );
    root.replaceChildren(...items);
    render(); // edit rights may have changed
  }

  store.subscribe(() => render());
  window.addEventListener("online", () => {
    if (store.get().stale || store.get().error) loadEvents();
    notifications.reconnectNow();
  });

  try {
    const { data } = await api.config();
    store.set({ config: data });
    if (data?.devMode) devWriter = createDevWriter({ api });
  } catch {
    /* offline with nothing cached: read-only */
  }
  renderAccount();
  router.start();
  loadFacets();
  loadEvents();
  subscribing.reload();
  registerServiceWorker();
}

/**
 * STUB / DEV ONLY: with `?mock` in the page URL, answer /api/* from in-browser mock data
 * (src/stubs/mockApi.js) and the AT Protocol calls from a fake PDS (src/stubs/mockPds.js),
 * so the UI, including login and subscriptions, can be previewed (and e2e-tested) without
 * the backend or a Bluesky account. Remove with the stubs.
 * The mock config (fake token prefixes) is only read in mock mode.
 * @param {() => import('./config.js').MockConfig} readMockConfig
 * @returns {Promise<{api: {fetchImpl?: typeof fetch, cache?: object},
 *   atproto: {fetchImpl?: typeof fetch}}|null>} extra createApi / createAtprotoWriter
 *   options; null when the mock config is invalid (the problem is shown on the page)
 */
async function mockOptions(readMockConfig) {
  if (!new URLSearchParams(globalThis.location?.search).has("mock"))
    return { api: {}, atproto: {} };
  const mockConfig = configOrReport(readMockConfig);
  if (!mockConfig) return null;
  const [{ createMockFetch }, { createMockPdsFetch }] = await Promise.all([
    import("./stubs/mockApi.js"),
    import("./stubs/mockPds.js"),
  ]);
  const noCache = { get: () => null, set: () => {} }; // never mix mock data into the real cache
  return {
    api: { fetchImpl: createMockFetch(), cache: noCache },
    atproto: { fetchImpl: createMockPdsFetch({ tokens: mockConfig.pds }) },
  };
}

/**
 * Header link to the My subscriptions page (#19), shown while logged in.
 * @returns {HTMLElement}
 */
const renderMySubscriptionsLink = () =>
  h(
    "a",
    {
      href: SUBSCRIPTIONS_ROUTE,
      class: "btn",
      dataset: { action: "my-subscriptions" },
    },
    "My subscriptions",
  );

function dedupe(events) {
  const seen = new Set();
  return events.filter((e) => !seen.has(e.uri) && seen.add(e.uri));
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker
    .register("./sw.js", { updateViaCache: "none" })
    .then((registration) => registration.update())
    .catch(() => {
      /* offline support is best-effort */
    });
}

if (
  typeof window !== "undefined" &&
  !globalThis.__CM_NO_AUTOSTART__ &&
  document.querySelector("#list")
) {
  start();
}
