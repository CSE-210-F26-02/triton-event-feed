import { describe, expect, it } from "vitest";
import {
  EVENT_STATUS,
  blueskyProfileUrl,
  displayStatus,
  formatEventWhen,
  statusBadges,
  statusLabel,
} from "../src/format.js";

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

describe("format.statusLabel", () => {
  it("labels live, ending soon and ended events", () => {
    expect(statusLabel(EVENT_STATUS.LIVE)).toBe("Happening now");
    expect(statusLabel(EVENT_STATUS.ENDING_SOON)).toBe("Ending soon");
    expect(statusLabel(EVENT_STATUS.ENDED)).toBe("Ended");
  });

  it("has no label for upcoming, unknown or inherited keys", () => {
    expect(statusLabel(EVENT_STATUS.UPCOMING)).toBeNull();
    expect(statusLabel("bogus")).toBeNull();
    expect(statusLabel(undefined)).toBeNull();
    expect(statusLabel("toString")).toBeNull();
    expect(statusLabel("__proto__")).toBeNull();
  });
});

describe("format.statusBadges", () => {
  it("gives ending-soon events both the happening-now and ending-soon badges", () => {
    expect(statusBadges("ending_soon")).toEqual([
      { label: "Happening now", modifier: "live" },
      { label: "Ending soon", modifier: "ending_soon" },
    ]);
  });

  it("gives live and ended events one badge each", () => {
    expect(statusBadges("live")).toEqual([
      { label: "Happening now", modifier: "live" },
    ]);
    expect(statusBadges("ended")).toEqual([
      { label: "Ended", modifier: "ended" },
    ]);
  });

  it("gives upcoming, unknown and inherited keys no badges", () => {
    for (const status of ["upcoming", "bogus", undefined, null, "constructor"])
      expect(statusBadges(status)).toEqual([]);
  });
});

describe("format.displayStatus", () => {
  it("is ended whenever the event is over, else the AppView status", () => {
    expect(displayStatus({ status: "live" }, true)).toBe("ended");
    expect(displayStatus({ status: "live" }, false)).toBe("live");
    expect(displayStatus({}, false)).toBeUndefined();
    expect(displayStatus(null, false)).toBeUndefined();
  });
});
