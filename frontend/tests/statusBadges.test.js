import { describe, expect, it } from "vitest";
import { renderStatusBadges } from "../src/views/statusBadges.js";

describe("statusBadges.renderStatusBadges", () => {
  it("renders one badge span per status badge, with its modifier class", () => {
    const badges = renderStatusBadges("ending_soon");
    expect(badges.map((badge) => badge.className)).toEqual([
      "badge badge--live",
      "badge badge--ending_soon",
    ]);
    expect(badges.map((badge) => badge.textContent)).toEqual([
      "Happening now",
      "Ending soon",
    ]);
  });

  it("renders nothing for upcoming or unknown statuses", () => {
    expect(renderStatusBadges("upcoming")).toEqual([]);
    expect(renderStatusBadges("<img src=x onerror=alert(1)>")).toEqual([]);
    expect(renderStatusBadges(undefined)).toEqual([]);
  });
});
