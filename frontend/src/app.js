/**
 * Application entry: wires store, API, views, writers, subscriptions and notifications.
 * @module app
 */
import { createApi } from "./api.js";
import { createAtprotoWriter } from "./atproto.js";
import { loadConfig, loadMockConfig } from "./config.js";
import { createDevWriter } from "./devWriter.js";
import { createElementTree } from "./dom.js";
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
import { runInBackground } from "./util.js";
import { createComposeView } from "./views/composeView.js";
import { createDetailView } from "./views/detailView.js";
import { createDateFilter } from "./views/dateFilter.js";
import { createFilterBar } from "./views/filterBar.js";
import { createListView } from "./views/listView.js";
import { createLoginView } from "./views/loginView.js";
import { createMapView } from "./views/mapView.js";
import { createSubscriptionsView } from "./views/subscriptionsView.js";

const findElement = (selector) => document.querySelector(selector);

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
    findElement("#list")?.replaceChildren(
      createElementTree(
        "div",
        { class: "notice notice--error", role: "alert" },
        createElementTree("p", null, "The app is not configured correctly:"),
        createElementTree(
          "ul",
          null,
          problems.map((problem) => createElementTree("li", null, problem)),
        ),
        createElementTree("p", null, "See frontend/.env.example."),
      ),
    );
    findElement("#list")?.setAttribute("aria-busy", "false");
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
  const mockSetup = await mockOptions(
    () => mockConfig ?? loadMockConfig(import.meta.env),
  );
  if (!mockSetup) return;
  const api = createApi({ baseUrl: appConfig.apiBaseUrl, ...mockSetup.api });
  const toast = createToaster(findElement("#toasts"));
  const geo = createGeo();
  const atproto = createAtprotoWriter({
    ...appConfig.atproto,
    ...mockSetup.atproto,
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
  const canEdit = (event) =>
    Boolean(writer()) &&
    event.authorDid === writer().did &&
    event.source !== "ical";

  // --- data loading ---
  let latestLoadSequence = 0;
  async function loadEvents({ append = false } = {}) {
    const thisLoadSequence = ++latestLoadSequence;
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
        if (thisLoadSequence !== latestLoadSequence) return;
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
    } catch (error) {
      if (thisLoadSequence !== latestLoadSequence) return;
      store.set({
        loading: false,
        error: error.offline
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
      } catch (error) {
        toast(error.message, { kind: "error" });
        filters.nearMe = false;
      }
      store.set({ locating: false });
    }
    if (!filters.nearMe) geo.clear();
    store.set({ filters });
    const refetch = ["tags", "group", "searchText", "sort"].some(
      (filterKey) => filterKey in patch,
    );
    if (refetch) runInBackground(loadEvents(), "Reloading events");
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
    store.get().events.find((event) => event.uri === uri) ?? null;
  const notifications = createNotifications({
    api,
    toast,
    onNotification: (notification) => applyNotification(notification),
  });
  // #19: subscriptions are records in the logged-in user's own account, on their PDS
  // (demo mode has no account, so no subscriptions).
  const subscriptions = createSubscriptions({
    getRepo: () => (atproto.loggedIn ? atproto : null),
    onChange: (subscribed) => {
      store.set({ subscribed });
      notifications.watch(subscribed.size ? atproto.did : null);
    },
  });
  const subscribing = createSubscriptionController({
    subscriptions,
    notifications,
    toast,
    isLoggedIn: () => atproto.loggedIn,
    requestLogin: (request) => login.open(request),
    openEvent: (uri) => router.openEvent(uri),
  });
  const detail = createDetailView(findElement("#panel-detail"), {
    api,
    mapConfig: appConfig.map,
    findEvent,
    canEdit,
    isSubscribed: (uri) => store.get().subscribed.has(uri),
    onToggleSubscribe: (event) => subscribing.toggle(event),
    onEdit: (event) => compose.open(event),
    onDelete: (event) => compose.remove(event),
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
        runInBackground(loadEvents(), "Reloading events");
        runInBackground(loadFacets(), "Reloading tags and groups");
        if (detail.currentUri)
          runInBackground(
            detail.open(detail.currentUri),
            "Refreshing the event",
          );
      }, 1500);
    },
    onDeleted: (uri) => {
      toast("Event deleted.");
      store.set({
        events: store.get().events.filter((event) => event.uri !== uri),
      });
      if (detail.currentUri === uri) router.home();
    },
  });
  const subscriptionsPage = createSubscriptionsView(
    findElement("#panel-subscriptions"),
    {
      api,
      findEvent,
      getSubscribed: () => store.get().subscribed,
      isLoggedIn: () => atproto.loggedIn,
      onLogin: () => login.open({ reason: LOGIN_FOR_SUBSCRIPTIONS_REASON }),
      onClose: () => router.home(),
      onOpen: (uri) => router.openEvent(uri),
      onToggleSubscribe: (event) => subscribing.toggle(event),
      onUnsubscribe: (uri) => subscribing.unsubscribe(uri),
    },
  );
  const login = createLoginView({
    login: (id, password) => atproto.login(id, password),
    onLoggedIn: async () => {
      renderAccount();
      await subscribing.reload();
    },
  });
  const filterBar = createFilterBar(findElement("#filters"), {
    onChange: changeFilters,
    geoSupported: geo.supported,
  });
  const datePicker = createDateFilter(findElement("#event-date-filter"), {
    onChange: (dateFilter) => {
      store.set({ dateFilter });
      runInBackground(loadEvents(), "Reloading events");
    },
  });
  const listView = createListView(findElement("#list"), {
    onLoadMore: () => loadEvents({ append: true }),
  });
  const map = createMapView(findElement("#map"), {
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
    findElement(".events-layout").dataset.view = LAYOUT_VIEW[view];
    findElement("#panel-map").hidden = view !== "list";
    findElement("#panel-detail").hidden = view !== "event";
    findElement("#panel-subscriptions").hidden = view !== "subscriptions";
    if (view === "event")
      runInBackground(detail.open(route.uri), "Opening the event");
    else detail.close();
    if (view === "subscriptions")
      runInBackground(subscriptionsPage.open(), "Opening My subscriptions");
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

  async function applyNotification(notification) {
    const { events } = store.get();
    if (detail.currentUri === notification.eventUri)
      runInBackground(
        detail.open(notification.eventUri),
        "Refreshing the updated event",
      );
    if (notification.kind === "deleted" || notification.kind === "expired") {
      store.set({
        events: events.filter((event) => event.uri !== notification.eventUri),
      });
    } else if (
      notification.kind === "updated" &&
      events.some((event) => event.uri === notification.eventUri)
    ) {
      try {
        const { data: updatedEvent } = await api.getEvent(
          notification.eventUri,
        );
        store.set({
          events: store
            .get()
            .events.map((event) =>
              event.uri === updatedEvent.uri ? updatedEvent : event,
            ),
        });
      } catch {
        /* keep old copy */
      }
    }
  }

  function render() {
    const state = store.get();
    filterBar.render(state.filters, {
      tags: state.tags,
      groups: state.groups,
      nearMeBusy: state.locating,
    });
    datePicker.render(state.dateFilter);
    const shown = visibleEvents();
    listView.render({
      events: shown,
      hasMore: Boolean(state.cursor),
      loading: state.loading,
      stale: state.stale,
      savedAt: state.savedAt,
      error: state.error,
      activeTags: state.filters.tags,
      subscribed: state.subscribed,
      onOpen: (uri) => router.openEvent(uri),
      onTagClick: (tag) =>
        changeFilters({ tags: toggleTag(store.get().filters.tags, tag) }),
      onToggleSubscribe: (event) => subscribing.toggle(event),
      sort: state.filters.sort,
    });
    runInBackground(map.show(shown), "Showing events on the map");
    detail.refreshActions();
    runInBackground(subscriptionsPage.refresh(), "Refreshing My subscriptions");
  }

  function renderAccount() {
    const root = findElement("#account");
    const canPost = Boolean(writer());
    const accountItems = [];
    if (atproto.loggedIn) {
      accountItems.push(
        createElementTree("span", { class: "muted" }, `@${atproto.handle}`),
        renderMySubscriptionsLink(),
        createElementTree(
          "button",
          {
            type: "button",
            class: "btn",
            onclick: async () => {
              await atproto.logout();
              subscriptions.clear();
              renderAccount();
            },
          },
          "Log out",
        ),
      );
    } else {
      if (devWriter)
        accountItems.push(
          createElementTree(
            "span",
            { class: "badge", title: "Posts go to the local dev index only" },
            "Demo mode",
          ),
        );
      accountItems.push(
        createElementTree(
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
      accountItems.push(
        createElementTree(
          "button",
          {
            type: "button",
            class: "btn btn--primary",
            onclick: () => compose.open(),
          },
          "New event",
        ),
      );
    root.replaceChildren(...accountItems);
    render(); // edit rights may have changed
  }

  store.subscribe(() => render());
  window.addEventListener("online", () => {
    if (store.get().stale || store.get().error)
      runInBackground(loadEvents(), "Reloading events");
    notifications.reconnectNow();
  });

  try {
    const { data: serverConfig } = await api.config();
    store.set({ config: serverConfig });
    if (serverConfig?.devMode) devWriter = createDevWriter({ api });
  } catch {
    /* offline with nothing cached: read-only */
  }
  renderAccount();
  router.start();
  runInBackground(loadFacets(), "Loading tags and groups");
  runInBackground(loadEvents(), "Loading events");
  runInBackground(subscribing.reload(), "Loading subscriptions");
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
    atproto: {
      fetchImpl: createMockPdsFetch({ tokens: mockConfig.tokenPrefixes }),
    },
  };
}

/**
 * Header link to the My subscriptions page (#19), shown while logged in.
 * @returns {HTMLElement}
 */
const renderMySubscriptionsLink = () =>
  createElementTree(
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
  return events.filter((event) => !seen.has(event.uri) && seen.add(event.uri));
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
  runInBackground(start(), "Starting the app");
}
