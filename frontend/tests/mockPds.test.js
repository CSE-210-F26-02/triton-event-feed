import { describe, expect, it } from "vitest";
import { createAtprotoWriter } from "../src/atproto.js";
import { buildSubscriptionRecord } from "../src/lexicon/validateSubscription.js";
import {
  MOCK_PDS_STORAGE_KEY,
  createMockPdsFetch,
  createTokenIssuer,
  mockDidForHandle,
} from "../src/stubs/mockPds.js";
import { memoryStorage, testMockConfig } from "./helpers.js";

/** Fake token prefixes, from the shared test env (frontend/.env in the app). */
const TOKENS = (await testMockConfig()).tokenPrefixes;
const PDS_ORIGIN = "https://pds.mock.test";

const EVENT = {
  uri: "at://did:plc:host/app.communitymap.event/3kevt",
  cid: "bafyreihooyosut5ztb3xty23uwoyij5ovnqr5qldanntxmah33quatfwoy",
};

/** A real atproto writer talking to the mock PDS. */
function writerOver(local = memoryStorage()) {
  return createAtprotoWriter({
    plcBase: "https://plc.directory",
    resolverBases: ["https://public.api.bsky.app"],
    fetchImpl: createMockPdsFetch({ tokens: TOKENS, storage: local }),
    storage: memoryStorage(),
  });
}

describe("stubs/mockPds (the ?mock fake PDS, also usable by future e2e tests)", () => {
  it("logs any handle in with any non-empty password", async () => {
    const writer = writerOver();
    expect(await writer.login("larry.test", "anything")).toEqual({
      did: mockDidForHandle("larry.test"),
      handle: "larry.test",
    });
  });

  it("rejects an empty password", async () => {
    await expect(writerOver().login("larry.test", "")).rejects.toThrow(
      "Invalid password",
    );
  });

  it("creates, lists and deletes subscription records", async () => {
    const writer = writerOver();
    await writer.login("larry.test", "pw");
    const record = buildSubscriptionRecord(EVENT, "2026-11-26T18:00:00.000Z");
    const created = await writer.createSubscription(record);
    expect(created.uri).toMatch(
      /^at:\/\/did:plc:mock-larry-test\/app\.communitymap\.subscription\/.+/,
    );
    expect(await writer.listSubscriptions()).toEqual([
      { uri: created.uri, cid: created.cid, value: record },
    ]);
    await writer.deleteSubscription(created.uri.split("/").pop());
    expect(await writer.listSubscriptions()).toEqual([]);
  });

  it("keeps records in storage, so they survive a reload", async () => {
    const local = memoryStorage();
    const firstWriter = writerOver(local);
    await firstWriter.login("larry.test", "pw");
    await firstWriter.createSubscription(buildSubscriptionRecord(EVENT));
    const secondWriter = writerOver(local);
    await secondWriter.login("larry.test", "pw");
    expect(await secondWriter.listSubscriptions()).toHaveLength(1);
    expect(local.getItem(MOCK_PDS_STORAGE_KEY)).toContain(EVENT.uri);
  });

  it("pages listRecords with limit + cursor", async () => {
    const local = memoryStorage();
    const writer = writerOver(local);
    await writer.login("larry.test", "pw");
    for (let index = 0; index < 3; index++)
      await writer.createSubscription(buildSubscriptionRecord(EVENT));
    const pdsFetch = createMockPdsFetch({ tokens: TOKENS, storage: local });
    const larryDid = mockDidForHandle("larry.test");
    const response = await pdsFetch(
      `https://pds.mock.test/xrpc/com.atproto.repo.listRecords?repo=${larryDid}` +
        "&collection=app.communitymap.subscription&limit=2",
    );
    const page = await response.json();
    expect(page.records).toHaveLength(2);
    expect(page.cursor).toBe("2");
    expect(await writer.listSubscriptions()).toHaveLength(3);
  });

  it("refuses writes without the user's token", async () => {
    const pdsFetch = createMockPdsFetch({
      tokens: TOKENS,
      storage: memoryStorage(),
    });
    const response = await pdsFetch(
      "https://pds.mock.test/xrpc/com.atproto.repo.createRecord",
      {
        method: "POST",
        headers: { Authorization: "Bearer wrong" },
        body: JSON.stringify({
          repo: "did:plc:x",
          collection: "c",
          record: {},
        }),
      },
    );
    expect(response.status).toBe(401);
  });

  it("answers unknown methods with 404 and survives corrupt storage", async () => {
    const local = memoryStorage();
    local.setItem(MOCK_PDS_STORAGE_KEY, "{not json");
    const pdsFetch = createMockPdsFetch({ tokens: TOKENS, storage: local });
    const unknownMethodResponse = await pdsFetch(
      "https://pds.mock.test/xrpc/com.atproto.sync.getRepo",
    );
    expect(unknownMethodResponse.status).toBe(404);
    const writer = writerOver(local);
    await writer.login("larry.test", "pw");
    expect(await writer.listSubscriptions()).toEqual([]);
  });

  it("issues the tokens configured in .env (prefix + DID)", async () => {
    const pdsFetch = createMockPdsFetch({
      tokens: TOKENS,
      storage: memoryStorage(),
    });
    const response = await pdsFetch(
      `${PDS_ORIGIN}/xrpc/com.atproto.server.createSession`,
      {
        method: "POST",
        body: JSON.stringify({ identifier: "larry.test", password: "pw" }),
      },
    );
    const larryDid = mockDidForHandle("larry.test");
    expect(await response.json()).toMatchObject({
      accessJwt: `${TOKENS.accessTokenPrefix}${larryDid}`,
      refreshJwt: `${TOKENS.refreshTokenPrefix}${larryDid}`,
    });
  });

  it("refreshes only its own refresh tokens", async () => {
    const pdsFetch = createMockPdsFetch({
      tokens: TOKENS,
      storage: memoryStorage(),
    });
    const refresh = (token) =>
      pdsFetch(`${PDS_ORIGIN}/xrpc/com.atproto.server.refreshSession`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
    const validRefresh = await refresh(`${TOKENS.refreshTokenPrefix}did:plc:x`);
    expect((await validRefresh.json()).did).toBe("did:plc:x");
    for (const invalidToken of [
      `${TOKENS.accessTokenPrefix}did:plc:x`,
      TOKENS.refreshTokenPrefix,
      "anything",
    ])
      expect((await refresh(invalidToken)).status).toBe(401);
  });

  it("refuses to start without token prefixes", () => {
    expect(() => createMockPdsFetch({ storage: memoryStorage() })).toThrow(
      TypeError,
    );
    expect(() => createTokenIssuer({ accessTokenPrefix: "a-" })).toThrow(
      TypeError,
    );
  });
});
