import { describe, expect, it, vi } from "vitest";
import {
  EVENT_ROUTE_PREFIX,
  SUBSCRIPTIONS_ROUTE,
  createRouter,
  eventHash,
  parseHash,
  shareUrl,
} from "../src/router.js";
import { sampleEvent } from "./helpers.js";

const EVENT_URI = sampleEvent().uri; // at://did:plc:abc/app.communitymap.event/3kabc

describe("router.eventHash / parseHash", () => {
  it("builds a readable hash from the record's DID and rkey", () => {
    expect(eventHash(EVENT_URI)).toBe("#/event/did:plc:abc/3kabc");
  });

  it("round-trips, including DIDs that need escaping", () => {
    const webDid = "at://did:web:example.com%3A8080/app.communitymap.event/r1";
    for (const uri of [EVENT_URI, webDid])
      expect(parseHash(eventHash(uri))).toEqual({ view: "event", uri });
  });

  it("rejects non-event URIs", () => {
    expect(eventHash("at://did:plc:abc/app.bsky.feed.post/1")).toBeNull();
    expect(eventHash("https://example.com")).toBeNull();
  });

  it("maps empty hashes to the list and ignores non-route hashes", () => {
    expect(parseHash("")).toEqual({ view: "list" });
    expect(parseHash("#")).toEqual({ view: "list" });
    expect(parseHash("#main")).toBeNull(); // skip link
  });

  it("treats malformed event routes as not found (uri: null)", () => {
    for (const hash of [
      `${EVENT_ROUTE_PREFIX}garbage`,
      `${EVENT_ROUTE_PREFIX}notadid/3kabc`,
      `${EVENT_ROUTE_PREFIX}did:plc:abc/%E0%A4%A`,
      `${EVENT_ROUTE_PREFIX}did:plc:abc/a/b`,
    ])
      expect(parseHash(hash)).toEqual({ view: "event", uri: null });
  });

  it("shareUrl keeps origin, path and query", () => {
    const location = {
      origin: "https://map.example",
      pathname: "/app/",
      search: "?x=1",
    };
    expect(shareUrl(EVENT_URI, location)).toBe(
      "https://map.example/app/?x=1#/event/did:plc:abc/3kabc",
    );
  });
});

describe("router.createRouter", () => {
  /** Minimal window stand-in with hashchange support. */
  function fakeWindow(hash = "") {
    const target = new EventTarget();
    const win = {
      location: {
        pathname: "/",
        search: "",
        get hash() {
          return hash;
        },
        set hash(value) {
          hash = value;
          target.dispatchEvent(new Event("hashchange"));
        },
      },
      history: {
        pushState: vi.fn(
          (_s, _t, url) =>
            (hash = url.split("#")[1] ? `#${url.split("#")[1]}` : ""),
        ),
      },
      addEventListener: (type, fn) => target.addEventListener(type, fn),
    };
    return win;
  }

  it("emits the initial route, event navigations and home", () => {
    const onChange = vi.fn();
    const win = fakeWindow(eventHash(EVENT_URI));
    const router = createRouter({ onChange, win });
    router.start();
    expect(onChange).toHaveBeenLastCalledWith({
      view: "event",
      uri: EVENT_URI,
    });

    router.home();
    expect(win.history.pushState).toHaveBeenCalledWith(null, "", "/");
    expect(onChange).toHaveBeenLastCalledWith({ view: "list" });

    router.openEvent(EVENT_URI);
    expect(win.location.hash).toBe("#/event/did:plc:abc/3kabc");
    expect(router.current()).toEqual({ view: "event", uri: EVENT_URI });
  });

  it("keeps the current route when a non-route hash appears", () => {
    const onChange = vi.fn();
    const win = fakeWindow(eventHash(EVENT_URI));
    const router = createRouter({ onChange, win });
    router.start();
    win.location.hash = "#main";
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(router.current().view).toBe("event");
  });

  it("routes #/subscriptions to My subscriptions (#19)", () => {
    const onChange = vi.fn();
    const win = fakeWindow(SUBSCRIPTIONS_ROUTE);
    const router = createRouter({ onChange, win });
    router.start();
    expect(onChange).toHaveBeenLastCalledWith({ view: "subscriptions" });
    router.home();
    router.openSubscriptions();
    expect(win.location.hash).toBe(SUBSCRIPTIONS_ROUTE);
    expect(router.current()).toEqual({ view: "subscriptions" });
    const calls = onChange.mock.calls.length;
    router.openSubscriptions(); // already there: re-syncs instead of a no-op
    expect(onChange).toHaveBeenCalledTimes(calls + 1);
  });

  it("parses only the exact subscriptions hash", () => {
    expect(parseHash(SUBSCRIPTIONS_ROUTE)).toEqual({ view: "subscriptions" });
    expect(parseHash("#/subscriptions/extra")).toBeNull();
  });
});
