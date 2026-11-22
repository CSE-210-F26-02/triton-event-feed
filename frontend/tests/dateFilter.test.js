import { afterEach, describe, expect, it, vi } from "vitest";
import { filterEventsByDate } from "../src/filters.js";
import { createDateFilter } from "../src/views/dateFilter.js";

const selection = (dates) => ({ mode: "multiple", dates });
const event = (startsAt, endsAt) => ({ startsAt, endsAt });

describe("calendar date matching", () => {
  it("matches separate local days and events crossing midnight", () => {
    const overnight = event("2026-11-20T23:00:00", "2026-11-21T01:00:00");
    const unselected = event("2026-11-22T10:00:00", "2026-11-22T11:00:00");
    const later = event("2026-12-01T10:00:00", "2026-12-01T11:00:00");
    expect(
      filterEventsByDate(
        [overnight, unselected, later],
        selection(["2026-11-21", "2026-12-01"]),
      ),
    ).toEqual([overnight, later]);
  });

  it("includes both range dates, excluding an event ending exactly at the start", () => {
    const midnightEnd = event("2026-11-20T22:00:00", "2026-11-21T00:00:00");
    const start = event("2026-11-21T00:00:00", "2026-11-21T01:00:00");
    const end = event("2026-11-23T23:30:00", "2026-11-24T01:00:00");
    const after = event("2026-11-24T00:00:00", "2026-11-24T01:00:00");
    expect(
      filterEventsByDate([midnightEnd, start, end, after], {
        mode: "range",
        start: "2026-11-21",
        end: "2026-11-23",
      }),
    ).toEqual([start, end]);
  });

  it("uses actual local day boundaries on a daylight saving transition", () => {
    const eventAtEnd = event("2026-11-01T23:30:00", "2026-11-02T00:30:00");
    expect(filterEventsByDate([eventAtEnd], selection(["2026-11-01"]))).toEqual(
      [eventAtEnd],
    );
    const events = [eventAtEnd];
    expect(filterEventsByDate(events, null)).toBe(events);
  });
});

describe("date picker", () => {
  afterEach(() => document.body.replaceChildren());
  const setup = () => {
    const root = document.createElement("div");
    document.body.append(root);
    const onChange = vi.fn();
    const view = createDateFilter(root, {
      onChange,
      now: new Date(2026, 10, 21),
    });
    root.querySelector(".date-filter__trigger").click();
    return { root, onChange, view };
  };
  const day = (root, key) => root.querySelector(`[data-date="${key}"]`).click();
  const apply = (root) =>
    [...root.querySelectorAll("button")]
      .find((b) => b.textContent === "Apply")
      .click();

  it("keeps a cross-month multi-selection as a draft until Apply", () => {
    const { root, onChange } = setup();
    day(root, "2026-11-21");
    day(root, "2026-11-22");
    day(root, "2026-11-22");
    root.querySelector('[aria-label="Next month"]').click();
    day(root, "2026-12-02");
    expect(onChange).not.toHaveBeenCalled();
    apply(root);
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "multiple",
        dates: ["2026-11-21", "2026-12-02"],
      }),
    );
    expect(root.querySelector("#event-date-picker").hidden).toBe(true);
  });

  it("supports reverse-order range clicks and requires a completed range", () => {
    const { root, onChange } = setup();
    root.querySelector('[data-mode="range"]').click();
    day(root, "2026-11-25");
    expect(
      [...root.querySelectorAll("button")].find(
        (b) => b.textContent === "Apply",
      ).disabled,
    ).toBe(true);
    day(root, "2026-11-21");
    apply(root);
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "range",
        start: "2026-11-21",
        end: "2026-11-25",
      }),
    );
  });

  it("rejects an inverted typed range, and Clear removes the filter", () => {
    const { root, onChange } = setup();
    root.querySelector('[data-mode="range"]').click();
    const setDate = (index, value) => {
      const input = root.querySelectorAll("input")[index];
      input.value = value;
      input.dispatchEvent(new Event("change"));
    };
    setDate(0, "2026-11-25");
    setDate(1, "2026-11-21");
    expect(root.textContent).toContain(
      "End date must be on or after start date.",
    );
    expect(
      [...root.querySelectorAll("button")].find(
        (b) => b.textContent === "Apply",
      ).disabled,
    ).toBe(true);
    [...root.querySelectorAll("button")]
      .find((b) => b.textContent === "Clear")
      .click();
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("Escape closes without applying draft changes", () => {
    const { root, onChange } = setup();
    day(root, "2026-11-21");
    root
      .querySelector("#event-date-picker")
      .dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    expect(onChange).not.toHaveBeenCalled();
    expect(
      root.querySelector(".date-filter__trigger").getAttribute("aria-expanded"),
    ).toBe("false");
  });
});
