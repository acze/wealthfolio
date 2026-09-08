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

  it("clears selection explicitly and keeps selection when exiting", () => {
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
    expect(result.current.selection).toEqual({ mode: "all", ids: [] });
  });

  it.each([false, true])(
    "resets filters in either mode without restoring old selections (analysis=%s)",
    (active) => {
      const { result, rerender } = renderHook(({ scope }) => useAnalysisSelection(scope, active), {
        initialProps: { scope: "account-a:category-a:date-a:search-a" },
      });
      act(() => result.current.selectAll());
      act(() => result.current.toggle(["outlier"]));
      rerender({ scope: "account-b:category-a:date-a:search-a" });
      expect(result.current.active).toBe(active);
      expect(result.current.selection).toEqual({ mode: "explicit", ids: [] });
      act(() => result.current.toggle(["row-b"]));
      rerender({ scope: "account-a:category-a:date-a:search-a" });
      expect(result.current.selection).toEqual({ mode: "explicit", ids: [] });
    },
  );

  it("shares explicit IDs and edits across repeated mode transitions, including zero-sum pairs", () => {
    const { result } = renderHook(() => useAnalysisSelection("scope"));
    act(() => result.current.toggle(["purchase"]));
    expect(result.current.active).toBe(false);
    act(() => result.current.start());
    expect(result.current.isSelected("purchase")).toBe(true);
    act(() => result.current.toggle(["refund"]));
    act(() => result.current.stop());
    expect(result.current.selection).toEqual({ mode: "explicit", ids: ["purchase", "refund"] });
    act(() => result.current.toggle(["purchase"]));
    act(() => result.current.start());
    expect(result.current.selection).toEqual({ mode: "explicit", ids: ["refund"] });
    act(() => result.current.stop());
    act(() => result.current.start());
    expect(result.current.selection).toEqual({ mode: "explicit", ids: ["refund"] });
  });

  it("retains all matching and exclusions outside loaded pages when switching both ways", () => {
    const { result } = renderHook(() => useAnalysisSelection("scope"));
    act(() => result.current.start());
    act(() => result.current.selectAll());
    act(() => result.current.toggle(["row-101", "row-1101"]));
    act(() => result.current.stop());
    expect(result.current.active).toBe(false);
    expect(result.current.selection).toEqual({ mode: "all", ids: ["row-101", "row-1101"] });
    expect(result.current.isSelected("row-1200")).toBe(true);
    expect(result.current.isSelected("row-1101")).toBe(false);
    act(() => result.current.toggle(["row-101"]));
    act(() => result.current.start());
    expect(result.current.selection).toEqual({ mode: "all", ids: ["row-1101"] });
    expect(result.current.isSelected("row-101")).toBe(true);
  });

  it.each([false, true])("clear remains empty through transitions (analysis=%s)", (active) => {
    const { result } = renderHook(() => useAnalysisSelection("scope", active));
    act(() => result.current.selectAll());
    act(() => result.current.clear());
    expect(result.current.active).toBe(active);
    act(() => result.current.start());
    act(() => result.current.stop());
    act(() => result.current.start());
    expect(result.current.selection).toEqual({ mode: "explicit", ids: [] });
  });

  it("clears a successful submission only while its selection context is unchanged", () => {
    const { result } = renderHook(() => useAnalysisSelection("scope"));
    act(() => result.current.toggle(["submitted"]));
    const submitted = result.current.context;
    act(() => result.current.clearIfUnchanged(submitted));
    expect(result.current.selection).toEqual({ mode: "explicit", ids: [] });
    expect(result.current.active).toBe(false);
  });

  it("does not let an old completion clear edited exclusions or a newer mode", () => {
    const { result } = renderHook(() => useAnalysisSelection("scope"));
    act(() => result.current.selectAll());
    const submitted = result.current.context;
    act(() => result.current.start());
    act(() => result.current.toggle(["new-exclusion"]));
    act(() => result.current.clearIfUnchanged(submitted));
    expect(result.current.active).toBe(true);
    expect(result.current.selection).toEqual({ mode: "all", ids: ["new-exclusion"] });
  });

  it("rejects stale completion even after switching back to identical IDs and mode", () => {
    const { result } = renderHook(() => useAnalysisSelection("scope"));
    act(() => result.current.toggle(["submitted"]));
    const submitted = result.current.context;
    act(() => result.current.start());
    act(() => result.current.stop());
    act(() => result.current.clearIfUnchanged(submitted));
    expect(result.current.selection).toEqual({ mode: "explicit", ids: ["submitted"] });
  });

  it("keeps a newer filter selection when an older operation completes", () => {
    const { result, rerender } = renderHook(({ scope }) => useAnalysisSelection(scope), {
      initialProps: { scope: "old" },
    });
    act(() => result.current.toggle(["submitted"]));
    const submitted = result.current.context;
    rerender({ scope: "new" });
    act(() => result.current.toggle(["new-row"]));
    act(() => result.current.clearIfUnchanged(submitted));
    expect(result.current.selection).toEqual({ mode: "explicit", ids: ["new-row"] });
  });
});
