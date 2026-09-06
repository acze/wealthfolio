import { act, renderHook } from "@/test/render";
import { describe, expect, it } from "vitest";

import { useAnalysisSelection } from "./use-analysis-selection";

describe("analytical selection", () => {
  it("selects unloaded matches and preserves exclusions across pages without storing all IDs", () => {
    const { result } = renderHook(() => useAnalysisSelection("account-a"));
    const pages = Array.from({ length: 3 }, (_, page) =>
      Array.from({ length: 50 }, (_, i) => `row-${page * 50 + i}`),
    );
    act(() => result.current.start());
    act(() => result.current.selectAll());
    expect(result.current.selection).toEqual({ mode: "all", ids: [] });
    expect(pages.flat().filter(result.current.isSelected)).toHaveLength(150);

    act(() => result.current.toggle(["row-101"]));
    act(() => result.current.toggle(["row-8"]));
    expect(result.current.selection).toEqual({ mode: "all", ids: ["row-101", "row-8"] });
    expect(pages.flat().filter(result.current.isSelected)).toHaveLength(148);
    expect(result.current.isSelected("row-149")).toBe(true);

    act(() => result.current.toggle(["row-101"]));
    expect(result.current.isSelected("row-101")).toBe(true);
    expect(result.current.isSelected("row-8")).toBe(false);
    act(() => result.current.selectAll());
    expect(pages.flat().filter(result.current.isSelected)).toHaveLength(150);
  });

  it("clears selection, toggles explicit rows/days, and exits without leaking IDs", () => {
    const { result } = renderHook(() => useAnalysisSelection("all", true));
    act(() => result.current.selectAll());
    act(() => result.current.clear());
    expect(result.current.active).toBe(true);
    expect(result.current.isSelected("row-99")).toBe(false);
    act(() => result.current.toggle(["row-1"]));
    act(() => result.current.toggle(["row-1", "row-2"]));
    expect(result.current.selection).toEqual({ mode: "explicit", ids: ["row-1", "row-2"] });
    act(() => result.current.toggle(["row-1", "row-2"]));
    expect(result.current.selection.ids).toEqual([]);
    act(() => result.current.selectAll());
    act(() => result.current.stop());
    expect(result.current.active).toBe(false);
    expect(result.current.selection).toEqual({ mode: "explicit", ids: [] });
  });

  it("clears on every scope change without selecting the new scope or restoring old selections", () => {
    const { result, rerender } = renderHook(({ scope }) => useAnalysisSelection(scope), {
      initialProps: { scope: "account-a:category-a:date-a:search-a" },
    });
    act(() => result.current.selectAll());
    act(() => result.current.toggle(["outlier"]));
    rerender({ scope: "account-b:category-a:date-a:search-a" });
    expect(result.current.active).toBe(true);
    expect(result.current.selection).toEqual({ mode: "explicit", ids: [] });
    act(() => result.current.toggle(["row-b"]));
    rerender({ scope: "account-a:category-a:date-a:search-a" });
    expect(result.current.selection).toEqual({ mode: "explicit", ids: [] });
  });
});
