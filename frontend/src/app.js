/**
 * Application entry: wires store, API, views, writers and subscriptions together.
 * @module app
 */
import { createApi } from "./api.js";
import { createAtprotoWriter } from "./atproto.js";
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
import { createRouter, shareUrl } from "./router.js";
import { createStore } from "./store.js";
import { createSubscriptions } from "./subscriptions.js";
import { createToaster } from "./toast.js";
import { createComposeView } from "./views/composeView.js";
import { createDetailView } from "./views/detailView.js";
import { createDateFilter } from "./views/dateFilter.js";
import { createFilterBar } from "./views/filterBar.js";
import { createListView } from "./views/listView.js";
import { createLoginView } from "./views/loginView.js";
import { createMapView } from "./views/mapView.js";

const $ = (sel) => document.querySelector(sel);

/**
 * Start the app. API base comes from <meta name="cm-api-base"> (default: same origin).
 * @param {{baseUrl?: string}} [opts]
 */
export async function start({
  baseUrl = $('meta[name="cm-api-base"]')?.content ?? "",
} = {}) {
  const api = createApi({ baseUrl });
  const toast = createToaster($("#toasts"));
  const geo = createGeo();
  const atproto = createAtprotoWriter();
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
  const subs = createSubscriptions({
    api,
    toast,
    onChange: (subscribed) => store.set({ subscribed }),
    onNotification: (n) => applyNotification(n),
  });
  const detail = createDetailView($("#panel-detail"), {
    api,
    findEvent: (uri) => store.get().events.find((e) => e.uri === uri) ?? null,
    canEdit,
    isSubscribed: (uri) => store.get().subscribed.has(uri),
    // #20: the frontend subscriptions client exists; its backend endpoint is still pending.
    onToggleSubscribe: (uri) => toggleSubscribe(uri),
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
  const login = createLoginView({
    login: (id, pw) => atproto.login(id, pw),
    onLoggedIn: renderAccount,
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
    onOpen: (uri) => router.openEvent(uri),
  });

  /**
   * Show the detail pane in place of the map for event routes, or the map otherwise.
   * @param {import('./router.js').Route} route
   */
  function applyRoute(route) {
    const showDetail = route.view === "event";
    $(".events-layout").dataset.view = showDetail ? "detail" : "map";
    $("#panel-map").hidden = showDetail;
    $("#panel-detail").hidden = !showDetail;
    if (showDetail) detail.open(route.uri);
    else {
      detail.close();
      render(); // the map was hidden; re-show so Leaflet re-measures its container
    }
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

  async function toggleSubscribe(uri) {
    try {
      await subs.toggle(uri);
    } catch {
      toast("Could not update subscription — check your connection.", {
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
      onToggleSubscribe: toggleSubscribe,
    });
    map.show(shown);
    detail.refreshActions();
  }

  function renderAccount() {
    const root = $("#account");
    const canPost = Boolean(writer());
    const items = [];
    if (atproto.loggedIn) {
      items.push(
        h("span", { class: "muted" }, `@${atproto.handle}`),
        h(
          "button",
          {
            type: "button",
            class: "btn",
            onclick: async () => {
              await atproto.logout();
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
    subs.reconnectNow();
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
  subs.load();
  registerServiceWorker();
}

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
