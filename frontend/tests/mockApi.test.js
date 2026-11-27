import { beforeEach, describe, expect, it, vi } from "vitest";
import { findLexiconIssues } from "../src/lexicon/eventView.js";
import { createMockFetch } from "../src/stubs/mockApi.js";
import { memoryStorage } from "./helpers.js";

/** Mock event that intentionally breaks the lexicon (no lat/lng). */
const BROKEN_MOCK_URI_SUFFIX = "/mock-sunset";

/**
 * GET a mock endpoint and parse its JSON.
 * @param {(url: string, init?: object) => Promise<Response>} mockFetch
 * @param {string} url
 * @returns {Promise<{status: number, body: any}>}
 */
async function getJson(mockFetch, url) {
  const res = await mockFetch(url);
  return { status: res.status, body: await res.json() };
}

describe("stubs/mockApi (the ?mock demo data, also usable by future e2e tests)", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", memoryStorage());
    return () => vi.unstubAllGlobals();
  });

  it("serves events that match the lexicon, except the one meant to break it", async () => {
    const { body } = await getJson(createMockFetch(), "/api/events");
    expect(body.events.length).toBeGreaterThan(0);
    for (const event of body.events) {
      const issues = findLexiconIssues(event);
      if (event.uri.endsWith(BROKEN_MOCK_URI_SUFFIX))
        expect(issues.map((issue) => issue.path)).toContain("location.lat");
      else expect(issues).toEqual([]);
    }
  });

  it("returns one event by URI from /api/event, and 404 for unknown URIs", async () => {
    const mockFetch = createMockFetch();
    const { body } = await getJson(mockFetch, "/api/events");
    const [first] = body.events;
    const found = await getJson(
      mockFetch,
      `/api/event?uri=${encodeURIComponent(first.uri)}`,
    );
    expect(found).toEqual({ status: 200, body: first });
    const missing = await getJson(
      mockFetch,
      `/api/event?uri=${encodeURIComponent("at://did:plc:x/app.communitymap.event/nope")}`,
    );
    expect(missing.status).toBe(404);
  });

  it("uses strongRef groups and labels the group facets readably", async () => {
    const mockFetch = createMockFetch();
    const { body } = await getJson(mockFetch, "/api/events");
    const grouped = body.events.filter((event) => event.group);
    expect(grouped.length).toBeGreaterThan(0);
    for (const event of grouped) {
      expect(event.group).toEqual({
        uri: expect.stringMatching(
          /^at:\/\/did:[^/]+\/app\.communitymap\.group\/.+/,
        ),
        cid: expect.any(String),
      });
    }
    const groups = await getJson(mockFetch, "/api/groups");
    const labels = groups.body.map((facet) => facet.value);
    expect(labels).toContain("triton-eats");
    expect(labels.every((label) => typeof label === "string")).toBe(true);
  });

  it("returns 404 for endpoints it does not know", async () => {
    const { status } = await getJson(createMockFetch(), "/api/unknown");
    expect(status).toBe(404);
  });
});
