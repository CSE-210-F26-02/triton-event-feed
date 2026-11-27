/**
 * STUB / DEV ONLY: an in-browser fake of the AppView API so the UI can be previewed
 * before the backend exists. Enabled only by adding `?mock` to the page URL
 * (e.g. http://localhost:5173/?mock). Never loaded otherwise; delete this file once
 * the real backend serves /api/*.
 * @module stubs/mockApi
 */
import { describeGroup } from "../lexicon/eventView.js";
import { EVENT_NSID } from "../lexicon/validateEvent.js";
import { storageGet, storageSet, getStorage } from "../util.js";

/** Collection the mock groups live in (the group lexicon itself is still #17). */
const GROUP_NSID = "app.communitymap.group";
/**
 * A well-formed CID for every mock event and group strongRef (the lexicon validates the
 * format, and subscriptions copy the event's CID); the same value as
 * fixtures/event/valid/full.json. The mock never resolves it.
 */
const MOCK_CID = "bafyreihooyosut5ztb3xty23uwoyij5ovnqr5qldanntxmah33quatfwoy";
const DEMO_DID_KEY = "cm:demo-did"; // same key devWriter uses, so you "own" one event

/**
 * ISO timestamp `hours` from now (negative = in the past).
 * @param {number} hours
 * @returns {string}
 */
const hoursFromNow = (hours) =>
  new Date(Date.now() + hours * 3600e3).toISOString();

/**
 * Get (or create) the demo DID so one mock event is editable by you in Demo mode.
 * @returns {string}
 */
function demoDid() {
  const storage = getStorage("localStorage");
  let did = storageGet(storage, DEMO_DID_KEY);
  if (!did) {
    did = "did:plc:demo-mockhost0000";
    storageSet(storage, DEMO_DID_KEY, did);
  }
  return did;
}

/**
 * Build a com.atproto.repo.strongRef to a mock group record, matching the lexicon's
 * `group` field.
 * @param {string} did DID of the group's owner
 * @param {string} rkey record key of the group (shown as the placeholder label, see #17)
 * @returns {{uri: string, cid: string}}
 */
const mockGroupRef = (did, rkey) => ({
  uri: `at://${did}/${GROUP_NSID}/${rkey}`,
  cid: MOCK_CID,
});

/**
 * Build one mock EventView (lexicon record fields + AppView metadata).
 * @param {object} fields overrides; must include `did` and `rkey`
 * @returns {object}
 */
function mockEvent({ did, rkey, ...fields }) {
  return {
    uri: `at://${did}/${EVENT_NSID}/${rkey}`,
    cid: MOCK_CID,
    authorDid: did,
    source: "atproto",
    sourceUrl: null,
    createdAt: hoursFromNow(-48),
    indexedAt: hoursFromNow(-48),
    updatedAt: hoursFromNow(-48),
    status: "upcoming",
    tags: [],
    updates: [],
    ...fields,
  };
}

/**
 * The mock event set: one you host (edited, with announcements), one by someone else,
 * one whose record breaks the lexicon (no lat/lng, to preview the best-effort warning),
 * and one that has already ended.
 * @returns {object[]}
 */
function mockEvents() {
  return [
    mockEvent({
      did: demoDid(),
      rkey: "mock-tacos",
      authorHandle: "you.demo.test",
      name: "Taco Tuesday at Price Center",
      description:
        "Free tacos for the first 200 students!\nBring your student ID.\n\nVegetarian and vegan options available.",
      startsAt: hoursFromNow(2),
      endsAt: hoursFromNow(4),
      location: {
        name: "Price Center Plaza",
        address: "9500 Gilman Dr, La Jolla, CA 92093",
        lat: "32.8797",
        lng: "-117.2362",
      },
      tags: ["food", "free", "social"],
      group: mockGroupRef("did:plc:mockeats0000000", "triton-eats"),
      sourceUrl: "https://example.com/taco-tuesday",
      updatedAt: hoursFromNow(-1), // edited → shows "Updated <time>"
      updates: [
        {
          text: "We're moving to the east side of the plaza.",
          createdAt: hoursFromNow(-1),
        },
        { text: "See you there!", createdAt: hoursFromNow(-20) },
      ],
    }),
    mockEvent({
      did: "did:plc:mockacm0000000",
      rkey: "mock-hackathon",
      authorHandle: "acm.ucsd.edu",
      name: "ACM Fall Hack Night",
      description: "Build something cool in 6 hours. Pizza provided.",
      startsAt: hoursFromNow(26),
      endsAt: hoursFromNow(32),
      location: {
        name: "CSE Building, Room 1202",
        address: "3235 Voigt Dr, La Jolla, CA 92093",
        lat: "32.8818",
        lng: "-117.2335",
      },
      tags: ["tech", "hackathon"],
      group: mockGroupRef("did:plc:mockacm0000000", "acm-at-ucsd"),
    }),
    mockEvent({
      did: "did:plc:mockclub0000000",
      rkey: "mock-sunset",
      authorHandle: "sunsetclub.bsky.social",
      name: "Sunset Walk (meet-up spot TBD)",
      description:
        "Its record has no lat/lng, which the lexicon requires, to preview the " +
        "best-effort “some details may be missing” warning and the no-pin map state.",
      startsAt: hoursFromNow(50),
      endsAt: hoursFromNow(52),
      location: { name: "Somewhere near Scripps Pier" },
      tags: ["outdoors"],
    }),
    mockEvent({
      did: "did:plc:mockclub0000000",
      rkey: "mock-ended",
      authorHandle: "sunsetclub.bsky.social",
      name: "Morning Yoga (already ended)",
      description: "Previews the “This event has ended” state.",
      startsAt: hoursFromNow(-5),
      endsAt: hoursFromNow(-4),
      location: {
        name: "RIMAC Field",
        address: "9730 Hopkins Dr, La Jolla, CA 92093",
        lat: "32.8854",
        lng: "-117.2400",
      },
      tags: ["fitness"],
      group: mockGroupRef("did:plc:mockclub0000000", "rec-club"),
    }),
  ];
}

/**
 * Count values for /api/tags and /api/groups.
 * @param {string[]} values
 * @returns {{value: string, count: number}[]}
 */
function facetCounts(values) {
  const counts = new Map();
  values.forEach((value) => counts.set(value, (counts.get(value) ?? 0) + 1));
  return [...counts].map(([value, count]) => ({ value, count }));
}

/**
 * Minimal Response stand-in understood by createApi.
 * @param {any} body
 * @param {number} [status]
 * @returns {Response}
 */
const respond = (body, status = 200) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/**
 * Create a fetch replacement that answers /api/* from mock data (in memory, per page load).
 * @returns {(url: string, init?: RequestInit) => Promise<Response>}
 */
export function createMockFetch() {
  const events = mockEvents();

  const handlers = {
    "/api/config": () =>
      respond({
        devMode: true,
        jetstreamEnabled: false,
        eventNsid: EVENT_NSID,
      }),
    "/api/events": () => respond({ events: events, cursor: null }),
    "/api/event": (params) => {
      const event = events.find((ev) => ev.uri === params.get("uri"));
      return event ? respond(event) : respond({ error: "NotFound" }, 404);
    },
    "/api/tags": () => respond(facetCounts(events.flatMap((ev) => ev.tags))),
    "/api/groups": () =>
      respond(
        facetCounts(
          events.map((ev) => describeGroup(ev.group)?.label).filter(Boolean),
        ),
      ),
    "/api/notifications": () => respond([]),
    "/api/dev/records": () => respond({ ok: true }),
  };

  return async (url, init) => {
    const parsed = new URL(url, globalThis.location.origin);
    const handler = handlers[parsed.pathname];
    return handler
      ? handler(parsed.searchParams, init)
      : respond({ error: "NotFound" }, 404);
  };
}
