import { describe, expect, it } from "vitest";
import { toQueryString } from "../src/api.js";
import {
  DEFAULT_SORT_ORDER,
  EMPTY_FILTERS,
  SORT_ORDERS,
  buildEventQuery,
  formatBoundingBox,
  normalizeSortOrder,
  coordsOf,
  groupByDay,
  haversineKm,
  isEnded,
  isUpdated,
  sortByDistance,
  toggleTag,
} from "../src/filters.js";

describe("buildEventQuery", () => {
  it("drops empty values and never sends nearMe", () => {
    expect(buildEventQuery({ ...EMPTY_FILTERS, nearMe: true })).toEqual({
      limit: 20,
    });
  });

  it("includes tags (repeatable), group, trimmed search text (sent as q) and cursor", () => {
    const params = buildEventQuery(
      {
        tags: ["food", "music"],
        group: "ACM",
        searchText: "  tacos ",
        nearMe: false,
      },
      { cursor: "c1", limit: 5 },
    );
    expect(params).toEqual({
      limit: 5,
      tag: ["food", "music"],
      group: "ACM",
      q: "tacos",
      cursor: "c1",
    });
    expect(toQueryString(params)).toBe(
      "?limit=5&tag=food&tag=music&group=ACM&q=tacos&cursor=c1",
    );
  });

  it("toggleTag adds and removes", () => {
    expect(toggleTag(["a"], "b")).toEqual(["a", "b"]);
    expect(toggleTag(["a", "b"], "a")).toEqual(["b"]);
  });
});

describe("distance", () => {
  it("haversine is ~0 for same point and right order of magnitude", () => {
    const geisel = { lat: 32.8811, lng: -117.2376 };
    expect(haversineKm(geisel, geisel)).toBe(0);
    // UCSD -> downtown San Diego is ~ 18 km
    const distanceKm = haversineKm(geisel, { lat: 32.7157, lng: -117.1611 });
    expect(distanceKm).toBeGreaterThan(17);
    expect(distanceKm).toBeLessThan(21);
  });

  it("coordsOf parses strings and rejects junk", () => {
    expect(coordsOf({ location: { lat: "32.1", lng: "-117" } })).toEqual({
      lat: 32.1,
      lng: -117,
    });
    expect(coordsOf({ location: { lat: "x", lng: "1" } })).toBeNull();
    expect(coordsOf({ location: { lat: "95", lng: "1" } })).toBeNull();
    expect(coordsOf({ location: { name: "n" } })).toBeNull();
  });

  it("sorts nearest first; no-coords last, stable, annotated", () => {
    const myLocation = { lat: 32.88, lng: -117.23 };
    const far = { uri: "far", location: { lat: "32.70", lng: "-117.16" } };
    const near = { uri: "near", location: { lat: "32.881", lng: "-117.231" } };
    const none1 = { uri: "none1", location: { name: "x" } };
    const none2 = { uri: "none2", location: { name: "y" } };
    const sortedEvents = sortByDistance([none1, far, none2, near], myLocation);
    expect(sortedEvents.map((event) => event.uri)).toEqual([
      "near",
      "far",
      "none1",
      "none2",
    ]);
    expect(sortedEvents[0].distanceKm).toBeLessThan(1);
    expect(sortedEvents[2].distanceKm).toBeNull();
  });
});

describe("groupByDay", () => {
  const now = new Date(2026, 10, 11, 12, 0); // Wed Nov 11 2026 local
  const localTime = (day, hour) => ({
    startsAt: new Date(2026, 10, day, hour).toISOString(),
    uri: `${day}-${hour}`,
  });

  it("labels Today, Tomorrow, weekday, then date; chronological groups", () => {
    const groups = groupByDay(
      [localTime(20, 9), localTime(13, 9), localTime(12, 9), localTime(11, 18)],
      {
        now,
        locale: "en-US",
      },
    );
    expect(groups.map((group) => group.label)).toEqual([
      "Today",
      "Tomorrow",
      "Friday",
      "Fri, Nov 20",
    ]);
  });

  it("puts in-progress events (started earlier) under Today, keeps order within a group", () => {
    const groups = groupByDay(
      [localTime(11, 15), localTime(10, 20), localTime(11, 13)],
      {
        now,
        locale: "en-US",
      },
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe("Today");
    expect(groups[0].events.map((event) => event.uri)).toEqual([
      "11-15",
      "10-20",
      "11-13",
    ]);
  });
});

describe("isUpdated", () => {
  it("is true only when updatedAt > indexedAt", () => {
    expect(
      isUpdated({
        indexedAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-02T00:00:00Z",
      }),
    ).toBe(true);
    expect(
      isUpdated({
        indexedAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      }),
    ).toBe(false);
    expect(isUpdated({})).toBe(false);
  });
});

describe("isEnded", () => {
  const now = new Date("2026-11-11T20:00:00Z");
  it("is true after endsAt or when the backend marks it ended", () => {
    expect(isEnded({ endsAt: "2026-11-11T19:59:59Z" }, now)).toBe(true);
    expect(isEnded({ endsAt: "2026-11-11T20:00:01Z" }, now)).toBe(false);
    expect(
      isEnded({ status: "ended", endsAt: "2030-01-01T00:00:00Z" }, now),
    ).toBe(true);
    expect(isEnded({ endsAt: "not a date" }, now)).toBe(false);
  });
});

describe("buildEventQuery sort (#sorting)", () => {
  it("defaults to soonest, which is the server default and never sent", () => {
    expect(EMPTY_FILTERS.sort).toBe(DEFAULT_SORT_ORDER);
    expect(DEFAULT_SORT_ORDER).toBe(SORT_ORDERS.SOONEST);
    expect(buildEventQuery({ ...EMPTY_FILTERS })).not.toHaveProperty("sort");
  });

  it("sends a non-default sort order", () => {
    expect(
      buildEventQuery({ ...EMPTY_FILTERS, sort: SORT_ORDERS.NEWEST }).sort,
    ).toBe("newest");
  });

  it("never sends an unknown or malformed sort order", () => {
    for (const sort of ["bogus", "", null, undefined, 7, { evil: true }]) {
      expect(buildEventQuery({ ...EMPTY_FILTERS, sort })).not.toHaveProperty(
        "sort",
      );
    }
  });
});

describe("normalizeSortOrder", () => {
  it("keeps known orders and falls back to the default for anything else", () => {
    expect(normalizeSortOrder("soonest")).toBe("soonest");
    expect(normalizeSortOrder("newest")).toBe("newest");
    expect(normalizeSortOrder("NEWEST")).toBe(DEFAULT_SORT_ORDER);
    expect(normalizeSortOrder(undefined)).toBe(DEFAULT_SORT_ORDER);
    expect(normalizeSortOrder(["newest"])).toBe(DEFAULT_SORT_ORDER);
  });
});

describe("buildEventQuery bbox", () => {
  it("formats a bounding box as west,south,east,north", () => {
    expect(
      buildEventQuery(EMPTY_FILTERS, {
        bbox: { west: -117.3, south: 32.8, east: -117.2, north: 32.9 },
      }).bbox,
    ).toBe("-117.3,32.8,-117.2,32.9");
  });

  it("passes a preformatted bbox string through (trimmed)", () => {
    expect(buildEventQuery(EMPTY_FILTERS, { bbox: " 1,2,3,4 " }).bbox).toBe(
      "1,2,3,4",
    );
  });

  it("omits bbox when absent", () => {
    expect(buildEventQuery(EMPTY_FILTERS)).not.toHaveProperty("bbox");
    expect(buildEventQuery(EMPTY_FILTERS, { bbox: null })).not.toHaveProperty(
      "bbox",
    );
  });
});

describe("formatBoundingBox", () => {
  it("rejects boxes with missing, non-numeric or non-finite edges", () => {
    expect(formatBoundingBox({ west: 1, south: 2, east: 3 })).toBeNull();
    expect(
      formatBoundingBox({ west: "1", south: 2, east: 3, north: 4 }),
    ).toBeNull();
    expect(
      formatBoundingBox({ west: NaN, south: 2, east: 3, north: 4 }),
    ).toBeNull();
    expect(
      formatBoundingBox({ west: 1, south: 2, east: Infinity, north: 4 }),
    ).toBeNull();
    expect(formatBoundingBox("   ")).toBeNull();
    expect(formatBoundingBox(undefined)).toBeNull();
  });
});
