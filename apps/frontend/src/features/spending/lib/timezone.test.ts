import { describe, expect, it } from "vitest";

import {
  addCalendarMonths,
  formatZonedDateKey,
  getZonedDateParts,
  localDateBoundaryToISOString,
  zonedCalendarDateBoundaryToDate,
} from "./timezone";

describe("spending timezone helpers", () => {
  it("converts configured timezone day boundaries to UTC instants", () => {
    const date = { year: 2026, month: 5, day: 1 };

    expect(zonedCalendarDateBoundaryToDate(date, "start", "America/Toronto").toISOString()).toBe(
      "2026-05-01T04:00:00.000Z",
    );
    expect(zonedCalendarDateBoundaryToDate(date, "end", "America/Toronto").toISOString()).toBe(
      "2026-05-02T03:59:59.999Z",
    );
  });

  it("uses the configured timezone when extracting calendar dates", () => {
    const instant = new Date("2026-05-01T02:00:00.000Z");

    expect(getZonedDateParts(instant, "America/Toronto")).toEqual({
      year: 2026,
      month: 4,
      day: 30,
    });
    expect(getZonedDateParts(instant, "Europe/London")).toEqual({
      year: 2026,
      month: 5,
      day: 1,
    });
  });

  it("clamps month arithmetic to the destination month", () => {
    expect(addCalendarMonths({ year: 2026, month: 3, day: 31 }, -1)).toEqual({
      year: 2026,
      month: 2,
      day: 28,
    });
  });

  it.each([
    ["Asia/Tokyo", "2026-05-31T15:00:00.000Z", "2026-06-30T14:59:59.999Z"],
    ["America/Toronto", "2026-03-08T05:00:00.000Z", "2026-03-09T03:59:59.999Z"],
  ])(
    "keeps drawer-to-Transactions calendar links in %s, independent of the device timezone",
    (timezone, start, end) => {
      const parseCalendarParam = (instant: string) => {
        const [year, month, day] = formatZonedDateKey(new Date(instant), timezone)
          .split("-")
          .map(Number);
        return new Date(year, month - 1, day);
      };
      expect(localDateBoundaryToISOString(parseCalendarParam(start), "start", timezone)).toBe(
        start,
      );
      expect(localDateBoundaryToISOString(parseCalendarParam(end), "end", timezone)).toBe(end);
    },
  );
});
