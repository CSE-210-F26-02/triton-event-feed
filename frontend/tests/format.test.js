import { describe, expect, it } from "vitest";
import { blueskyProfileUrl, formatEventWhen } from "../src/format.js";

const UTC_OPTIONS = { locale: "en-US", timeZone: "UTC" };

describe("format.formatEventWhen", () => {
  it("shows the date once for same-day events, with the time zone", () => {
    expect(
      formatEventWhen(
        "2026-11-11T19:00:00Z",
        "2026-11-11T21:00:00Z",
        UTC_OPTIONS,
      ),
    ).toBe("Wednesday, November 11, 2026 · 7:00 PM – 9:00 PM UTC");
  });

  it("shows both dates for multi-day events", () => {
    expect(
      formatEventWhen(
        "2026-11-11T19:00:00Z",
        "2026-11-12T02:00:00Z",
        UTC_OPTIONS,
      ),
    ).toBe(
      "Wednesday, November 11, 2026, 7:00 PM – Thursday, November 12, 2026, 2:00 AM UTC",
    );
  });

  it("uses the viewer's time zone", () => {
    expect(
      formatEventWhen("2026-11-11T19:00:00Z", "2026-11-11T21:00:00Z", {
        locale: "en-US",
        timeZone: "America/Los_Angeles",
      }),
    ).toBe("Wednesday, November 11, 2026 · 11:00 AM – 1:00 PM PST");
  });
});

describe("format.blueskyProfileUrl", () => {
  it("prefers the handle, falls back to the DID, else null", () => {
    expect(blueskyProfileUrl("alice.bsky.social", "did:plc:abc")).toBe(
      "https://bsky.app/profile/alice.bsky.social",
    );
    expect(blueskyProfileUrl(undefined, "did:plc:abc")).toBe(
      "https://bsky.app/profile/did:plc:abc",
    );
    expect(blueskyProfileUrl("../evil", "nope")).toBeNull();
  });
});
