import { describe, expect, it } from "vitest";
import fullFixture from "../../fixtures/event/valid/full.json";
import minimalFixture from "../../fixtures/event/valid/minimal.json";
import unicodeFixture from "../../fixtures/event/valid/unicode.json";
import endsBeforeStartsFixture from "../../fixtures/event/invalid/ends-before-starts.json";
import missingLatFixture from "../../fixtures/event/invalid/missing-lat.json";
import {
  LEXICON_RECORD_FIELDS,
  UNTITLED_EVENT_NAME,
  describeGroup,
  extractEventRecord,
  findLexiconIssues,
  isEventUri,
  isPlainObject,
  toDisplayEvent,
} from "../src/lexicon/eventView.js";
import { EVENT_NSID } from "../src/lexicon/validateEvent.js";
import { lexiconEventView, sampleEvent } from "./helpers.js";

const GROUP_URI =
  "at://did:plc:7iza6de2dwap2sbkpav7c6c6/app.communitymap.group/3lbxq7k2mzs2a";

describe("eventView.isPlainObject", () => {
  it.each([
    [{}, true],
    [{ a: 1 }, true],
    [null, false],
    [undefined, false],
    [[], false],
    ["event", false],
    [42, false],
  ])("%j → %s", (value, expected) => {
    expect(isPlainObject(value)).toBe(expected);
  });
});

describe("eventView.isEventUri", () => {
  it("accepts at:// URIs of app.communitymap.event records", () => {
    expect(isEventUri("at://did:plc:abc/app.communitymap.event/3kabc")).toBe(
      true,
    );
  });

  it.each([
    ["another collection", "at://did:plc:abc/app.communitymap.group/3kabc"],
    ["a Bluesky post", "at://did:plc:abc/app.bsky.feed.post/3kabc"],
    ["a missing record key", "at://did:plc:abc/app.communitymap.event"],
    ["an https URL", "https://example.com/app.communitymap.event/1"],
    ["an empty string", ""],
  ])("rejects %s", (_label, uri) => {
    expect(isEventUri(uri)).toBe(false);
  });

  it.each([null, undefined, 42, {}, []])("rejects non-strings (%j)", (uri) => {
    expect(isEventUri(uri)).toBe(false);
  });
});

describe("eventView.extractEventRecord", () => {
  it("returns only lexicon fields and adds the $type the AppView leaves off", () => {
    const record = extractEventRecord(lexiconEventView(fullFixture.record));
    expect(record).toEqual(fullFixture.record);
    expect(Object.keys(record).sort()).toEqual(
      ["$type", ...LEXICON_RECORD_FIELDS].sort(),
    );
  });

  it("drops AppView metadata (uri, author, status, updates, ...)", () => {
    const record = extractEventRecord(lexiconEventView(minimalFixture.record));
    for (const metadata of ["uri", "cid", "authorDid", "status", "updates"]) {
      expect(record).not.toHaveProperty(metadata);
    }
  });

  it("omits fields that are missing instead of setting them to undefined", () => {
    const record = extractEventRecord({ name: "Only a name" });
    expect(record).toEqual({ $type: EVENT_NSID, name: "Only a name" });
  });

  it("keeps a $type that is already there, so a wrong one is caught", () => {
    expect(extractEventRecord({ $type: "app.bsky.feed.post" }).$type).toBe(
      "app.bsky.feed.post",
    );
  });

  it.each([null, undefined, "event", 7, []])(
    "returns null for non-objects (%j)",
    (value) => {
      expect(extractEventRecord(value)).toBeNull();
    },
  );
});

describe("eventView.findLexiconIssues", () => {
  it.each([
    ["full", fullFixture],
    ["minimal", minimalFixture],
    ["unicode", unicodeFixture],
  ])("finds no issues in the %s valid fixture", (_name, fixture) => {
    expect(findLexiconIssues(lexiconEventView(fixture.record))).toEqual([]);
  });

  it("reports a missing lat at location.lat", () => {
    const issues = findLexiconIssues(
      lexiconEventView(missingLatFixture.record),
    );
    expect(issues.map((issue) => issue.path)).toContain("location.lat");
  });

  it("reports an end time before the start time", () => {
    const issues = findLexiconIssues(
      lexiconEventView(endsBeforeStartsFixture.record),
    );
    expect(issues).toContainEqual({
      path: "endsAt",
      message: "endsAt must be after startsAt",
    });
  });

  it("flags prototype-shaped events (string group, no createdAt)", () => {
    expect(findLexiconIssues(sampleEvent()).length).toBeGreaterThan(0);
  });

  it.each([null, "event", []])("reports non-objects (%j)", (value) => {
    expect(findLexiconIssues(value)).toEqual([
      { path: "", message: "Event must be an object" },
    ]);
  });
});

describe("eventView.describeGroup", () => {
  it("labels a lexicon strongRef with its record key (STUB #17) and keeps the URI", () => {
    expect(describeGroup(fullFixture.record.group)).toEqual({
      label: "3lbxq7k2mzs2a",
      uri: GROUP_URI,
    });
  });

  it("shows legacy plain-string groups as-is (trimmed)", () => {
    expect(describeGroup("  Triton Eats ")).toEqual({
      label: "Triton Eats",
      uri: null,
    });
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["an empty string", "   "],
    ["a strongRef without a uri", { cid: "bafy" }],
    ["a strongRef with a non-string uri", { uri: 42, cid: "bafy" }],
    ["a strongRef with a non-at:// uri", { uri: "https://x.test/g", cid: "b" }],
    ["an array", ["Triton Eats"]],
    ["a number", 5],
  ])("returns null for %s", (_label, group) => {
    expect(describeGroup(group)).toBeNull();
  });
});

describe("eventView.toDisplayEvent", () => {
  it("passes a valid lexicon event through with no issues", () => {
    const view = toDisplayEvent(lexiconEventView(fullFixture.record));
    expect(view).toMatchObject({
      uri: "at://did:plc:host/app.communitymap.event/3lexicon",
      name: "Triton Hackathon Kickoff",
      startsAt: "2026-12-04T17:00:00.000-08:00",
      endsAt: "2026-12-04T20:00:00.000-08:00",
      location: {
        name: "Price Center Ballroom East",
        address: "9500 Gilman Dr, La Jolla, CA 92093",
        lat: "32.8797",
        lng: "-117.2362",
      },
      tags: ["hackathon", "cse", "free-food"],
      group: { label: "3lbxq7k2mzs2a", uri: GROUP_URI },
      authorHandle: "host.test",
      issues: [],
    });
  });

  it("fills safe defaults for optional fields the minimal fixture leaves out", () => {
    const view = toDisplayEvent(lexiconEventView(minimalFixture.record));
    expect(view.description).toBe("");
    expect(view.tags).toEqual([]);
    expect(view.group).toBeNull();
    expect(view.location).toEqual({
      name: "",
      address: "",
      lat: "32.8812",
      lng: "-117.2375",
    });
  });

  it("keeps emoji and non-English text unchanged", () => {
    const view = toDisplayEvent(lexiconEventView(unicodeFixture.record));
    expect(view.name).toBe(unicodeFixture.record.name);
    expect(view.tags).toEqual(["음식", "café", "🎉"]);
  });

  it("never throws on a badly broken record, and lists its issues", () => {
    const view = toDisplayEvent({
      name: { text: "not a string" },
      description: 42,
      startsAt: "not a date",
      endsAt: null,
      location: "Price Center",
      tags: "food,free",
      group: 99,
      authorHandle: 7,
      sourceUrl: { href: "https://x.test" },
      updates: "none",
    });
    expect(view).toMatchObject({
      uri: null,
      name: UNTITLED_EVENT_NAME,
      description: "",
      startsAt: null,
      endsAt: null,
      location: { name: "", address: "", lat: null, lng: null },
      tags: [],
      group: null,
      authorHandle: null,
      sourceUrl: null,
      updates: [],
    });
    expect(view.issues.length).toBeGreaterThan(0);
  });

  it("uses the untitled fallback for blank names", () => {
    expect(toDisplayEvent({ name: "   " }).name).toBe(UNTITLED_EVENT_NAME);
  });

  it("keeps only string, non-blank tags", () => {
    expect(
      toDisplayEvent({ tags: ["food", "", " ", 3, null, "free"] }).tags,
    ).toEqual(["food", "free"]);
  });

  it("keeps only announcements with text and a parseable time", () => {
    const view = toDisplayEvent({
      updates: [
        { text: "Moved inside", createdAt: "2026-11-11T18:00:00Z" },
        { text: "", createdAt: "2026-11-11T18:00:00Z" },
        { text: "No time" },
        { text: "Bad time", createdAt: "yesterday-ish" },
        { text: 5, createdAt: "2026-11-11T18:00:00Z" },
        "just a string",
        null,
      ],
    });
    expect(view.updates).toEqual([
      { text: "Moved inside", createdAt: "2026-11-11T18:00:00Z" },
    ]);
  });

  it.each([null, undefined, "event", 3, []])(
    "returns a fully-defaulted display event for non-objects (%j)",
    (value) => {
      const view = toDisplayEvent(value);
      expect(view.name).toBe(UNTITLED_EVENT_NAME);
      expect(view.tags).toEqual([]);
      expect(view.issues).toEqual([
        { path: "", message: "Event must be an object" },
      ]);
    },
  );
});
