import { describe, expect, it, vi } from "vitest";
import fullFixture from "../../fixtures/event/valid/full.json";
import { SUBSCRIPTION_NSID } from "../src/lexicon/validateSubscription.js";
import {
  SUBSCRIPTION_ERROR,
  SubscriptionError,
  createSubscriptions,
  indexSubscriptionRecords,
} from "../src/subscriptions.js";
import { lexiconEventView, sampleEvent } from "./helpers.js";

const MY_DID = "did:plc:me";
/** Before the full fixture's event (Dec 4, 2026) starts. */
const BEFORE = new Date("2026-12-01T00:00:00Z");
/** After it ended. */
const AFTER = new Date("2026-12-10T00:00:00Z");

/** A valid, subscribable EventView built from the shared full fixture. */
const eventA = lexiconEventView(fullFixture.record, {
  uri: "at://did:plc:host/app.communitymap.event/3aaa",
});
const eventB = lexiconEventView(fullFixture.record, {
  uri: "at://did:plc:host/app.communitymap.event/3bbb",
});

/** A listRecords entry for a subscription to `event`, with record key `rkey`. */
const listed = (event, recordKey) => ({
  uri: `at://${MY_DID}/${SUBSCRIPTION_NSID}/${recordKey}`,
  cid: event.cid,
  value: {
    $type: SUBSCRIPTION_NSID,
    subject: { uri: event.uri, cid: event.cid },
    createdAt: "2026-11-26T18:00:00.000Z",
  },
});

/** In-memory stand-in for the atproto writer's subscription methods. */
function fakeRepo(initial = []) {
  const records = [...initial];
  let nextKey = 0;
  return {
    did: MY_DID,
    records,
    listSubscriptions: vi.fn(async () => [...records]),
    createSubscription: vi.fn(async (record) => {
      const recordKey = `3new${nextKey++}`;
      records.push({
        uri: `at://${MY_DID}/${SUBSCRIPTION_NSID}/${recordKey}`,
        cid: "c",
        value: record,
      });
      return {
        uri: `at://${MY_DID}/${SUBSCRIPTION_NSID}/${recordKey}`,
        cid: "c",
      };
    }),
    deleteSubscription: vi.fn(async (recordKey) => {
      const recordIndex = records.findIndex((record) =>
        record.uri.endsWith(`/${recordKey}`),
      );
      if (recordIndex >= 0) records.splice(recordIndex, 1);
    }),
  };
}

/** Build a store around `repo` (null = logged out). */
function setup({ repo = fakeRepo(), now = BEFORE } = {}) {
  const onChange = vi.fn();
  let currentRepo = repo;
  const subs = createSubscriptions({
    getRepo: () => currentRepo,
    onChange,
    now: () => now,
  });
  return { subs, repo, onChange, logout: () => (currentRepo = null) };
}

describe("indexSubscriptionRecords", () => {
  it("maps each event URI to its subscription record keys", () => {
    const { recordKeysByEvent, skippedCount } = indexSubscriptionRecords([
      listed(eventA, "3k1"),
      listed(eventB, "3k2"),
      listed(eventA, "3k3"), // duplicate (e.g. two tabs)
    ]);
    expect([...recordKeysByEvent]).toEqual([
      [eventA.uri, ["3k1", "3k3"]],
      [eventB.uri, ["3k2"]],
    ]);
    expect(skippedCount).toBe(0);
  });

  it("skips records that break the lexicon or have no record key", () => {
    const notAnEvent = listed(eventA, "3k4");
    notAnEvent.value.subject.uri = "at://did:plc:x/app.bsky.feed.post/1";
    const { recordKeysByEvent, skippedCount } = indexSubscriptionRecords([
      notAnEvent,
      { uri: "garbage", value: listed(eventA, "x").value },
      { uri: `at://${MY_DID}/${SUBSCRIPTION_NSID}/3k5`, value: { nope: true } },
      null,
      listed(eventB, "3k6"),
    ]);
    expect([...recordKeysByEvent.keys()]).toEqual([eventB.uri]);
    expect(skippedCount).toBe(4);
  });

  it.each([null, undefined, "records", {}])(
    "returns nothing for a non-array (%j)",
    (value) => {
      expect(indexSubscriptionRecords(value)).toEqual({
        recordKeysByEvent: new Map(),
        skippedCount: 0,
      });
    },
  );
});

describe("createSubscriptions", () => {
  it("load() reads the user's records from their PDS", async () => {
    const { subs, onChange } = setup({
      repo: fakeRepo([listed(eventA, "3k1")]),
    });
    await subs.load();
    expect(subs.has(eventA.uri)).toBe(true);
    expect(subs.ownerDid).toBe(MY_DID);
    expect(onChange).toHaveBeenLastCalledWith(new Set([eventA.uri]));
  });

  it("load() while logged out leaves nothing subscribed", async () => {
    const { subs, onChange } = setup({ repo: null });
    await subs.load();
    expect(subs.subscribed).toEqual(new Set());
    expect(onChange).toHaveBeenCalledWith(new Set());
  });

  it("load() failures propagate and keep the previous state", async () => {
    const repo = fakeRepo([listed(eventA, "3k1")]);
    const { subs } = setup({ repo });
    await subs.load();
    repo.listSubscriptions.mockRejectedValueOnce(new Error("offline"));
    await expect(subs.load()).rejects.toThrow("offline");
    expect(subs.has(eventA.uri)).toBe(true);
  });

  it("subscribe() publishes a valid strongRef record and tracks it", async () => {
    const { subs, repo } = setup();
    await expect(subs.subscribe(eventA)).resolves.toBe(true);
    expect(repo.createSubscription).toHaveBeenCalledWith({
      $type: SUBSCRIPTION_NSID,
      subject: { uri: eventA.uri, cid: eventA.cid },
      createdAt: BEFORE.toISOString(),
    });
    expect(subs.has(eventA.uri)).toBe(true);
  });

  it("subscribe() is a no-op when already subscribed or already in flight", async () => {
    const { subs, repo } = setup();
    await Promise.all([subs.subscribe(eventA), subs.subscribe(eventA)]);
    await subs.subscribe(eventA);
    expect(repo.createSubscription).toHaveBeenCalledTimes(1);
  });

  it("subscribe() re-lists when the PDS returns no record URI", async () => {
    const repo = fakeRepo();
    repo.createSubscription.mockImplementationOnce(async (record) => {
      repo.records.push({ ...listed(eventA, "3late"), value: record });
      return {};
    });
    const { subs } = setup({ repo });
    await subs.subscribe(eventA);
    expect(repo.listSubscriptions).toHaveBeenCalled();
    await subs.unsubscribe(eventA.uri);
    expect(repo.deleteSubscription).toHaveBeenCalledWith("3late");
  });

  it("refuses to subscribe when logged out", async () => {
    const { subs, repo } = setup({ repo: null });
    await expect(subs.subscribe(eventA)).rejects.toMatchObject({
      code: SUBSCRIPTION_ERROR.loginRequired,
    });
    expect(repo).toBeNull();
  });

  it("refuses to subscribe to an ended event", async () => {
    const { subs, repo } = setup({ now: AFTER });
    const error = await subs.subscribe(eventA).catch((rejection) => rejection);
    expect(error).toBeInstanceOf(SubscriptionError);
    expect(error.code).toBe(SUBSCRIPTION_ERROR.eventEnded);
    expect(repo.createSubscription).not.toHaveBeenCalled();
  });

  it.each([
    ["an invalid CID", sampleEvent({ endsAt: "2099-01-01T00:00:00Z" })],
    ["no CID", { ...eventA, cid: undefined }],
    [
      "a non-event URI",
      { ...eventA, uri: "at://did:plc:x/app.bsky.feed.post/1" },
    ],
    ["no URI", { ...eventA, uri: undefined }],
    ["not an object", null],
  ])("refuses to publish an invalid record (%s)", async (_label, event) => {
    const { subs, repo } = setup();
    await expect(subs.subscribe(event)).rejects.toMatchObject({
      code: SUBSCRIPTION_ERROR.invalidEvent,
    });
    expect(repo.createSubscription).not.toHaveBeenCalled();
  });

  it("unsubscribe() deletes every record for the event (deleteRecord)", async () => {
    const repo = fakeRepo([listed(eventA, "3k1"), listed(eventA, "3k2")]);
    const { subs, onChange } = setup({ repo });
    await subs.load();
    await expect(subs.unsubscribe(eventA.uri)).resolves.toBe(false);
    expect(repo.deleteSubscription.mock.calls).toEqual([["3k1"], ["3k2"]]);
    expect(subs.has(eventA.uri)).toBe(false);
    expect(onChange).toHaveBeenLastCalledWith(new Set());
  });

  it("unsubscribe() works for ended events", async () => {
    const { subs, repo } = setup({
      repo: fakeRepo([listed(eventA, "3k1")]),
      now: AFTER,
    });
    await subs.load();
    await subs.unsubscribe(eventA.uri);
    expect(repo.deleteSubscription).toHaveBeenCalledWith("3k1");
  });

  it("a failed delete keeps the records that were not deleted", async () => {
    const repo = fakeRepo([listed(eventA, "3k1"), listed(eventA, "3k2")]);
    repo.deleteSubscription
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("offline"));
    const { subs } = setup({ repo });
    await subs.load();
    await expect(subs.unsubscribe(eventA.uri)).rejects.toThrow("offline");
    expect(subs.has(eventA.uri)).toBe(true);
    repo.deleteSubscription.mockResolvedValue(undefined);
    await subs.unsubscribe(eventA.uri);
    expect(repo.deleteSubscription).toHaveBeenLastCalledWith("3k2");
  });

  it("toggle() subscribes, then unsubscribes", async () => {
    const { subs, repo } = setup();
    await expect(subs.toggle(eventA)).resolves.toBe(true);
    await expect(subs.toggle(eventA)).resolves.toBe(false);
    expect(repo.createSubscription).toHaveBeenCalledTimes(1);
    expect(repo.deleteSubscription).toHaveBeenCalledTimes(1);
  });

  it("subscriptions persist across stores (the PDS is the source of truth)", async () => {
    const repo = fakeRepo();
    await setup({ repo }).subs.subscribe(eventA);
    const { subs: afterReload } = setup({ repo });
    await afterReload.load();
    expect(afterReload.has(eventA.uri)).toBe(true);
  });

  it("clear() forgets everything and wins over an in-flight load", async () => {
    const repo = fakeRepo([listed(eventA, "3k1")]);
    let release;
    repo.listSubscriptions.mockImplementationOnce(
      () => new Promise((resolve) => (release = resolve)),
    );
    const { subs } = setup({ repo });
    const loading = subs.load();
    subs.clear();
    release([listed(eventA, "3k1")]);
    await loading;
    expect(subs.subscribed).toEqual(new Set());
    expect(subs.ownerDid).toBeNull();
  });

  it("refuses to unsubscribe when logged out", async () => {
    const { subs } = setup({ repo: null });
    await expect(subs.unsubscribe(eventA.uri)).rejects.toMatchObject({
      code: SUBSCRIPTION_ERROR.loginRequired,
    });
  });
});
