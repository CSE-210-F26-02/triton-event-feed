import { describe, expect, it, vi } from "vitest";
import {
  buildCommit,
  createDevWriter,
  generateTimestampRecordKey,
} from "../src/devWriter.js";
import { memoryStorage } from "./helpers.js";

describe("generateTid", () => {
  it("is 13 base32-sortable chars and monotonic", () => {
    const firstKey = generateTimestampRecordKey(1731300000000);
    const sameTimeKey = generateTimestampRecordKey(1731300000000);
    const laterKey = generateTimestampRecordKey(1731300005000);
    for (const generatedKey of [firstKey, sameTimeKey, laterKey])
      expect(generatedKey).toMatch(/^[234567a-z]{13}$/);
    expect(firstKey < sameTimeKey && sameTimeKey < laterKey).toBe(true);
  });
});

describe("dev writer", () => {
  it("posts Jetstream-shaped create commits with a persisted fake DID", async () => {
    const api = { postDevRecord: vi.fn(async () => ({ ok: true })) };
    const storage = memoryStorage();
    const writer = createDevWriter({ api, storage });
    expect(writer.did).toMatch(/^did:plc:demo-[a-z2-7]+$/);
    expect(createDevWriter({ api, storage }).did).toBe(writer.did);

    const response = await writer.createEvent({
      name: "Jam",
      createdAt: "2026-11-11T00:00:00Z",
    });
    const postedCommit = api.postDevRecord.mock.calls[0][0];
    expect(postedCommit).toEqual({
      did: writer.did,
      time_us: expect.any(Number),
      kind: "commit",
      commit: {
        operation: "create",
        collection: "app.communitymap.event",
        rkey: expect.stringMatching(/^[234567a-z]{13}$/),
        cid: expect.stringMatching(/^bafy/),
        record: {
          $type: "app.communitymap.event",
          name: "Jam",
          createdAt: "2026-11-11T00:00:00Z",
        },
      },
    });
    expect(response.uri).toBe(
      `at://${writer.did}/app.communitymap.event/${postedCommit.commit.rkey}`,
    );
  });

  it("update keeps rkey; delete has no record/cid; listener uses listener collection", async () => {
    const api = { postDevRecord: vi.fn(async () => ({ ok: true })) };
    const writer = createDevWriter({ api, storage: memoryStorage() });
    await writer.updateEvent("3kabc", { name: "n" });
    await writer.deleteEvent("3kabc");
    await writer.createListener("at://x/app.communitymap.event/3kabc", "Tag");
    const [updateCommit, deleteCommit, listenerCommit] =
      api.postDevRecord.mock.calls.map((call) => call[0].commit);
    expect(updateCommit).toMatchObject({
      operation: "update",
      rkey: "3kabc",
      record: { name: "n" },
    });
    expect(deleteCommit).toEqual({
      operation: "delete",
      collection: "app.communitymap.event",
      rkey: "3kabc",
    });
    expect(listenerCommit).toMatchObject({
      operation: "create",
      collection: "app.communitymap.listener",
      record: {
        subject: "at://x/app.communitymap.event/3kabc",
        hashtag: "tag",
      },
    });
  });

  it("buildCommit uses microsecond time", () => {
    expect(
      buildCommit({
        did: "d",
        operation: "delete",
        collection: "c",
        rkey: "r",
        nowMs: 1731300000000,
      }).time_us,
    ).toBe(1731300000000000);
  });
});
