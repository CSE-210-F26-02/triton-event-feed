// @vitest-environment node
// (Reads fixtures from disk via import.meta.url, which must be a file: URL; see
// validateEvent.test.js.)
/**
 * Runs every shared fixture in fixtures/subscription/ (repo root) through
 * validateSubscription. The backend's Python tests run the same files, so both
 * validators must agree on what a valid subscription is.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  SUBSCRIPTION_NSID,
  buildSubscriptionRecord,
  validateSubscription,
} from "./validateSubscription.js";

const fixturesDir = fileURLToPath(
  new URL("../../../fixtures/subscription/", import.meta.url),
);

const EVENT_URI =
  "at://did:plc:7iza6de2dwap2sbkpav7c6c6/app.communitymap.event/3lbxq7k2mzs2a";
const CID = "bafyreihooyosut5ztb3xty23uwoyij5ovnqr5qldanntxmah33quatfwoy";

/** Reads every .json fixture in fixtures/subscription/<folder>/ as [fileName, data]. */
function loadFixtures(folder) {
  const dir = join(fixturesDir, folder);
  return readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => [file, JSON.parse(readFileSync(join(dir, file), "utf8"))]);
}

const validFixtures = loadFixtures("valid");
const invalidFixtures = loadFixtures("invalid");

describe("validateSubscription: valid fixtures", () => {
  it("found some fixtures", () => {
    expect(validFixtures.length).toBeGreaterThan(0);
  });

  it.each(validFixtures)("%s", (_file, fixture) => {
    expect(validateSubscription(fixture.record)).toEqual({ ok: true });
  });
});

describe("validateSubscription: invalid fixtures", () => {
  it("found some fixtures", () => {
    expect(invalidFixtures.length).toBeGreaterThan(0);
  });

  it.each(invalidFixtures)("%s", (_file, fixture) => {
    const result = validateSubscription(fixture.record);
    expect(result.ok).toBe(false);
    const messages = result.errors.map((e) => e.message);
    expect(
      messages.some((m) => m.includes(fixture.expectedErrorContains)),
      `expected an error containing "${fixture.expectedErrorContains}", got: ${JSON.stringify(messages)}`,
    ).toBe(true);
  });
});

describe("validateSubscription: edge cases", () => {
  it.each([null, undefined, "subscription", 42, []])(
    "rejects non-objects (%j)",
    (value) => {
      expect(validateSubscription(value).ok).toBe(false);
    },
  );

  it("rejects a record with the wrong $type", () => {
    const result = validateSubscription({
      ...buildSubscriptionRecord({ uri: EVENT_URI, cid: CID }),
      $type: "app.bsky.feed.like",
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a subject URI with no record key", () => {
    const result = validateSubscription(
      buildSubscriptionRecord({
        uri: "at://did:plc:abc/app.communitymap.event",
        cid: CID,
      }),
    );
    expect(result.ok).toBe(false);
  });

  it("reports the wrong-collection rule at subject.uri", () => {
    const result = validateSubscription(
      buildSubscriptionRecord({
        uri: "at://did:plc:abc/app.communitymap.group/3kabc",
        cid: CID,
      }),
    );
    expect(result).toEqual({
      ok: false,
      errors: [
        {
          path: "subject.uri",
          message: "subject.uri must point at an app.communitymap.event record",
        },
      ],
    });
  });

  it("rejects a malformed CID", () => {
    const result = validateSubscription(
      buildSubscriptionRecord({ uri: EVENT_URI, cid: "not-a-cid" }),
    );
    expect(result.ok).toBe(false);
  });
});

describe("buildSubscriptionRecord", () => {
  it("builds a valid record from an EventView's uri and cid", () => {
    const record = buildSubscriptionRecord(
      { uri: EVENT_URI, cid: CID, name: "ignored" },
      "2026-11-26T18:00:00.000Z",
    );
    expect(record).toEqual({
      $type: SUBSCRIPTION_NSID,
      subject: { uri: EVENT_URI, cid: CID },
      createdAt: "2026-11-26T18:00:00.000Z",
    });
    expect(validateSubscription(record)).toEqual({ ok: true });
  });

  it("defaults createdAt to now", () => {
    const before = Date.now();
    const { createdAt } = buildSubscriptionRecord({ uri: EVENT_URI, cid: CID });
    expect(Date.parse(createdAt)).toBeGreaterThanOrEqual(before);
  });

  it.each([null, undefined, {}])(
    "builds an invalid (not throwing) record from a bad event (%j)",
    (event) => {
      expect(validateSubscription(buildSubscriptionRecord(event)).ok).toBe(
        false,
      );
    },
  );
});
