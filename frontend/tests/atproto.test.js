import { describe, expect, it, vi } from "vitest";
import {
  LIST_RECORDS_MAX_PAGES,
  createAtprotoWriter,
  didDocumentUrl,
  pdsUrlFromDidDocument,
} from "../src/atproto.js";
import {
  SUBSCRIPTION_NSID,
  buildSubscriptionRecord,
} from "../src/lexicon/validateSubscription.js";
import { buildEventRecord } from "../src/records.js";
import { jsonResponse, memoryStorage } from "./helpers.js";

/** AT Protocol service URLs, as the app config provides them (see TEST_ENV). */
const SERVICES = Object.freeze({
  plcBase: "https://plc.directory",
  resolverBases: ["https://public.api.bsky.app", "https://bsky.social"],
});

const ALICE_DID = "did:plc:alice123";
const PDS_URL = "https://pds.example.com";
const aliceDidDocument = {
  id: ALICE_DID,
  service: [
    {
      id: "#atproto_pds",
      type: "AtprotoPersonalDataServer",
      serviceEndpoint: `${PDS_URL}/`,
    },
  ],
};

function fakeNetwork(overrides = {}) {
  const routes = {
    "https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=alice.test":
      () => jsonResponse({ did: ALICE_DID }),
    [`https://plc.directory/${ALICE_DID}`]: () =>
      jsonResponse(aliceDidDocument),
    [`${PDS_URL}/xrpc/com.atproto.server.createSession`]: () =>
      jsonResponse({
        did: ALICE_DID,
        handle: "alice.test",
        accessJwt: "A1",
        refreshJwt: "R1",
      }),
    [`${PDS_URL}/xrpc/com.atproto.repo.createRecord`]: () =>
      jsonResponse({
        uri: `at://${ALICE_DID}/app.communitymap.event/3kxyz`,
        cid: "bafyc",
      }),
    [`${PDS_URL}/xrpc/com.atproto.repo.putRecord`]: () =>
      jsonResponse({ uri: "u", cid: "c" }),
    [`${PDS_URL}/xrpc/com.atproto.repo.deleteRecord`]: () => jsonResponse({}),
    ...overrides,
  };
  return vi.fn(async (url) => {
    const route = routes[url];
    if (!route) return jsonResponse({ error: "NotFound" }, 404);
    return route();
  });
}

const body = (call) => JSON.parse(call[1].body);

describe("atproto helpers", () => {
  it("resolves DID document URLs for plc and web", () => {
    expect(didDocumentUrl("did:plc:x", SERVICES.plcBase)).toBe(
      "https://plc.directory/did:plc:x",
    );
    expect(() => didDocumentUrl("did:plc:x")).toThrow(TypeError);
    expect(didDocumentUrl("did:web:ucsd.edu")).toBe(
      "https://ucsd.edu/.well-known/did.json",
    );
    expect(didDocumentUrl("did:web:localhost%3A3000:u:bob")).toBe(
      "https://localhost:3000/u/bob/did.json",
    );
    expect(() => didDocumentUrl("did:key:z")).toThrow();
  });

  it("finds the PDS service endpoint", () => {
    expect(pdsUrlFromDidDocument(aliceDidDocument)).toBe(PDS_URL);
    expect(pdsUrlFromDidDocument({ service: [] })).toBeNull();
  });
});

describe("atproto writer", () => {
  it.each([
    ["no options", undefined],
    ["no PLC directory", { resolverBases: SERVICES.resolverBases }],
    ["no resolvers", { plcBase: SERVICES.plcBase }],
    ["an empty resolver list", { ...SERVICES, resolverBases: [] }],
    ["a blank resolver", { ...SERVICES, resolverBases: [""] }],
  ])("refuses to start with %s (config comes from .env)", (_label, options) => {
    expect(() => createAtprotoWriter(options)).toThrow(TypeError);
  });

  it("login: resolveHandle → DID doc → createSession, persisted to sessionStorage", async () => {
    const fetchMock = fakeNetwork();
    const storage = memoryStorage();
    const writer = createAtprotoWriter({
      ...SERVICES,
      fetchImpl: fetchMock,
      storage,
    });
    expect(await writer.login("@alice.test", "app-pw")).toEqual({
      did: ALICE_DID,
      handle: "alice.test",
    });
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=alice.test",
      `https://plc.directory/${ALICE_DID}`,
      `${PDS_URL}/xrpc/com.atproto.server.createSession`,
    ]);
    expect(body(fetchMock.mock.calls[2])).toEqual({
      identifier: "alice.test",
      password: "app-pw",
    });
    expect(writer.did).toBe(ALICE_DID);
    // restored by a new instance from the same sessionStorage
    expect(
      createAtprotoWriter({
        ...SERVICES,
        fetchImpl: fetchMock,
        storage,
      }).loggedIn,
    ).toBe(true);
  });

  it("falls back to the second resolver", async () => {
    const fetchMock = fakeNetwork({
      "https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=alice.test":
        () => {
          throw new TypeError("net");
        },
      "https://bsky.social/xrpc/com.atproto.identity.resolveHandle?handle=alice.test":
        () => jsonResponse({ did: ALICE_DID }),
    });
    const writer = createAtprotoWriter({
      ...SERVICES,
      fetchImpl: fetchMock,
      storage: memoryStorage(),
    });
    await writer.login("alice.test", "pw");
    expect(writer.did).toBe(ALICE_DID);
  });

  it("createEvent sends a lexicon-exact createRecord payload with bearer auth", async () => {
    const fetchMock = fakeNetwork();
    const writer = createAtprotoWriter({
      ...SERVICES,
      fetchImpl: fetchMock,
      storage: memoryStorage(),
    });
    await writer.login("alice.test", "pw");
    const record = buildEventRecord({
      name: "Jam",
      startsAt: "2026-11-12T18:00:00.000Z",
      endsAt: "2026-11-12T20:00:00.000Z",
      locationName: "Geisel",
      lat: 32.88,
      lng: -117.23,
      tags: "study",
    });
    const response = await writer.createEvent(record);
    expect(response.uri).toBe(`at://${ALICE_DID}/app.communitymap.event/3kxyz`);
    const call = fetchMock.mock.calls.at(-1);
    expect(call[1].headers.Authorization).toBe("Bearer A1");
    expect(body(call)).toEqual({
      repo: ALICE_DID,
      collection: "app.communitymap.event",
      record: {
        $type: "app.communitymap.event",
        name: "Jam",
        startsAt: "2026-11-12T18:00:00.000Z",
        endsAt: "2026-11-12T20:00:00.000Z",
        location: { name: "Geisel", lat: "32.88", lng: "-117.23" },
        tags: ["study"],
        createdAt: record.createdAt,
      },
    });
  });

  it("updateEvent uses putRecord with rkey; deleteEvent uses deleteRecord; createListener", async () => {
    const fetchMock = fakeNetwork();
    const writer = createAtprotoWriter({
      ...SERVICES,
      fetchImpl: fetchMock,
      storage: memoryStorage(),
    });
    await writer.login("alice.test", "pw");
    await writer.updateEvent("3kxyz", { name: "n" });
    expect(body(fetchMock.mock.calls.at(-1))).toMatchObject({
      repo: ALICE_DID,
      collection: "app.communitymap.event",
      rkey: "3kxyz",
      record: { $type: "app.communitymap.event", name: "n" },
    });
    expect(await writer.deleteEvent("3kxyz")).toEqual({
      uri: `at://${ALICE_DID}/app.communitymap.event/3kxyz`,
    });
    expect(body(fetchMock.mock.calls.at(-1))).toEqual({
      repo: ALICE_DID,
      collection: "app.communitymap.event",
      rkey: "3kxyz",
    });
    await writer.createListener(
      `at://${ALICE_DID}/app.communitymap.event/3kxyz`,
      "#StudyJam",
    );
    const listenerRequest = body(fetchMock.mock.calls.at(-1));
    expect(listenerRequest.collection).toBe("app.communitymap.listener");
    expect(listenerRequest.record).toEqual({
      $type: "app.communitymap.listener",
      subject: `at://${ALICE_DID}/app.communitymap.event/3kxyz`,
      hashtag: "studyjam",
      createdAt: listenerRequest.record.createdAt,
    });
  });

  it("refreshes the session on ExpiredToken and retries once", async () => {
    let isFirstCall = true;
    const fetchMock = fakeNetwork({
      [`${PDS_URL}/xrpc/com.atproto.repo.createRecord`]: () => {
        if (isFirstCall) {
          isFirstCall = false;
          return jsonResponse(
            { error: "ExpiredToken", message: "Token has expired" },
            401,
          );
        }
        return jsonResponse({ uri: "u2", cid: "c2" });
      },
      [`${PDS_URL}/xrpc/com.atproto.server.refreshSession`]: () =>
        jsonResponse({
          did: ALICE_DID,
          handle: "alice.test",
          accessJwt: "A2",
          refreshJwt: "R2",
        }),
    });
    const writer = createAtprotoWriter({
      ...SERVICES,
      fetchImpl: fetchMock,
      storage: memoryStorage(),
    });
    await writer.login("alice.test", "pw");
    expect(await writer.createEvent({ name: "x" })).toEqual({
      uri: "u2",
      cid: "c2",
    });
    const urls = fetchMock.mock.calls.map((call) => call[0]).slice(3);
    expect(urls).toEqual([
      `${PDS_URL}/xrpc/com.atproto.repo.createRecord`,
      `${PDS_URL}/xrpc/com.atproto.server.refreshSession`,
      `${PDS_URL}/xrpc/com.atproto.repo.createRecord`,
    ]);
    expect(fetchMock.mock.calls[4][1].headers.Authorization).toBe("Bearer R1");
    expect(fetchMock.mock.calls[5][1].headers.Authorization).toBe("Bearer A2");
  });

  it("surfaces login errors and supports logout", async () => {
    const fetchMock = fakeNetwork({
      [`${PDS_URL}/xrpc/com.atproto.server.createSession`]: () =>
        jsonResponse(
          {
            error: "AuthenticationRequired",
            message: "Invalid identifier or password",
          },
          401,
        ),
    });
    const writer = createAtprotoWriter({
      ...SERVICES,
      fetchImpl: fetchMock,
      storage: memoryStorage(),
    });
    await expect(writer.login("alice.test", "bad")).rejects.toThrow(
      "Invalid identifier or password",
    );
    expect(writer.loggedIn).toBe(false);
    const loggedInWriter = createAtprotoWriter({
      ...SERVICES,
      fetchImpl: fakeNetwork(),
      storage: memoryStorage(),
    });
    await loggedInWriter.login("alice.test", "pw");
    await loggedInWriter.logout();
    expect(loggedInWriter.loggedIn).toBe(false);
  });
});

describe("atproto writer: subscriptions (#19)", () => {
  const EVENT = {
    uri: "at://did:plc:host/app.communitymap.event/3kevt",
    cid: "bafyreihooyosut5ztb3xty23uwoyij5ovnqr5qldanntxmah33quatfwoy",
  };
  const listUrl = (cursor) =>
    `${PDS_URL}/xrpc/com.atproto.repo.listRecords?repo=${encodeURIComponent(ALICE_DID)}` +
    `&collection=${SUBSCRIPTION_NSID}&limit=100${cursor ? `&cursor=${cursor}` : ""}`;

  /** Logged-in writer over fakeNetwork(routes). */
  async function loggedIn(routes = {}) {
    const fetchMock = fakeNetwork(routes);
    const writer = createAtprotoWriter({
      ...SERVICES,
      fetchImpl: fetchMock,
      storage: memoryStorage(),
    });
    await writer.login("alice.test", "pw");
    fetchMock.mockClear();
    return { fetchMock, writer };
  }

  it("createSubscription publishes the record to the subscription collection", async () => {
    const { fetchMock, writer } = await loggedIn();
    const record = buildSubscriptionRecord(EVENT, "2026-11-26T18:00:00.000Z");
    await writer.createSubscription(record);
    const [url, requestInit] = fetchMock.mock.calls[0];
    expect(url).toBe(`${PDS_URL}/xrpc/com.atproto.repo.createRecord`);
    expect(requestInit.headers.Authorization).toBe("Bearer A1");
    expect(body(fetchMock.mock.calls[0])).toEqual({
      repo: ALICE_DID,
      collection: SUBSCRIPTION_NSID,
      record,
    });
  });

  it("deleteSubscription uses deleteRecord with the record key", async () => {
    const { fetchMock, writer } = await loggedIn();
    expect(await writer.deleteSubscription("3ksub")).toEqual({
      uri: `at://${ALICE_DID}/${SUBSCRIPTION_NSID}/3ksub`,
    });
    expect(body(fetchMock.mock.calls[0])).toEqual({
      repo: ALICE_DID,
      collection: SUBSCRIPTION_NSID,
      rkey: "3ksub",
    });
  });

  it("listSubscriptions follows cursors and sends no token (public read)", async () => {
    const page = (recordKey) => ({
      uri: `at://${ALICE_DID}/${SUBSCRIPTION_NSID}/${recordKey}`,
    });
    const { fetchMock, writer } = await loggedIn({
      [listUrl()]: () => jsonResponse({ records: [page(1)], cursor: "c1" }),
      [listUrl("c1")]: () => jsonResponse({ records: [page(2)] }),
    });
    expect(await writer.listSubscriptions()).toEqual([page(1), page(2)]);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      listUrl(),
      listUrl("c1"),
    ]);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });

  it("listSubscriptions stops on a repeated cursor and tolerates missing records", async () => {
    const { fetchMock, writer } = await loggedIn({
      [listUrl()]: () => jsonResponse({ cursor: "same" }),
      [listUrl("same")]: () =>
        jsonResponse({ records: "nope", cursor: "same" }),
    });
    expect(await writer.listSubscriptions()).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("listSubscriptions gives up after LIST_RECORDS_MAX_PAGES pages", async () => {
    let pagesServed = 0;
    const fetchMock = vi.fn(async (url) =>
      url.includes("listRecords")
        ? jsonResponse({ records: [], cursor: `c${pagesServed++}` })
        : fakeNetwork()(url),
    );
    const writer = createAtprotoWriter({
      ...SERVICES,
      fetchImpl: fetchMock,
      storage: memoryStorage(),
    });
    await writer.login("alice.test", "pw");
    await writer.listSubscriptions();
    expect(pagesServed).toBe(LIST_RECORDS_MAX_PAGES);
  });

  it("listSubscriptions surfaces PDS errors", async () => {
    const { writer } = await loggedIn({
      [listUrl()]: () => jsonResponse({ error: "InvalidRequest" }, 400),
    });
    await expect(writer.listSubscriptions()).rejects.toMatchObject({
      status: 400,
    });
  });

  it("subscription methods refuse when logged out", async () => {
    const writer = createAtprotoWriter({
      ...SERVICES,
      fetchImpl: fakeNetwork(),
      storage: memoryStorage(),
    });
    await expect(writer.listSubscriptions()).rejects.toThrow("Not logged in");
    await expect(writer.createSubscription({})).rejects.toThrow(
      "Not logged in",
    );
    await expect(writer.deleteSubscription("x")).rejects.toThrow(
      "Not logged in",
    );
  });
});
