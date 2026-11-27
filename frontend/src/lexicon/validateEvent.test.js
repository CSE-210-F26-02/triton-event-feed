// @vitest-environment node
// (Reads fixtures from disk via import.meta.url, which must be a file: URL. The default
// jsdom environment used by the view tests rewrites it, so this suite opts back into node.)
/**
 * Runs every shared fixture in fixtures/event/ (repo root) through
 * validateEvent. The backend's Python tests run the same files, so both
 * validators must agree on what a valid event is.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EVENT_LIMITS, validateEvent } from "./validateEvent.js";

const fixturesDir = fileURLToPath(
  new URL("../../../fixtures/event/", import.meta.url),
);

/** Reads every .json fixture in fixtures/event/<folder>/ as [fileName, data]. */
function loadFixtures(folder) {
  const dir = join(fixturesDir, folder);
  return readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => [file, JSON.parse(readFileSync(join(dir, file), "utf8"))]);
}

const validFixtures = loadFixtures("valid");
const invalidFixtures = loadFixtures("invalid");

describe("validateEvent: valid fixtures", () => {
  it("found some fixtures", () => {
    expect(validFixtures.length).toBeGreaterThan(0);
  });

  it.each(validFixtures)("%s", (_file, fixture) => {
    expect(validateEvent(fixture.record)).toEqual({ ok: true });
  });
});

describe("validateEvent: invalid fixtures", () => {
  it("found some fixtures", () => {
    expect(invalidFixtures.length).toBeGreaterThan(0);
  });

  it.each(invalidFixtures)("%s", (_file, fixture) => {
    const result = validateEvent(fixture.record);
    expect(result.ok).toBe(false);
    const messages = result.errors.map((e) => e.message);
    expect(
      messages.some((m) => m.includes(fixture.expectedErrorContains)),
      `expected an error containing "${fixture.expectedErrorContains}", got: ${JSON.stringify(messages)}`,
    ).toBe(true);
  });
});

describe("EVENT_LIMITS", () => {
  it("matches the limits in the lexicon", () => {
    expect(EVENT_LIMITS).toEqual({
      nameMaxGraphemes: 100,
      descriptionMaxGraphemes: 3000,
      tagsMaxCount: 10,
      tagMaxGraphemes: 32,
      locationNameMaxGraphemes: 100,
      addressMaxGraphemes: 300,
    });
  });
});
