import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CashActivityAnalysis, CashActivitySearchResponse } from "../types/cash-activity";
import { useCashActivityAnalysis } from "./use-cash-activity-analysis";

const mocks = vi.hoisted(() => ({ searchCashActivities: vi.fn() }));
vi.mock("../adapters/cash-activities", () => mocks);

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function response(count: number): CashActivitySearchResponse {
  const money = {
    byCurrency: [{ currency: "USD", amount: "0.30" }],
    converted: null,
    missingRateCurrencies: [],
  };
  const total = { count, cashMovement: money, spending: money };
  return {
    items: [],
    totalCount: count,
    analysis: { matching: total, selected: total, excluded: total },
  };
}

describe("useCashActivityAnalysis", () => {
  beforeEach(() => vi.clearAllMocks());

  it("requests an entire filtered aggregate, not a page, preserving exact monetary strings", async () => {
    mocks.searchCashActivities.mockResolvedValue(response(151));
    const { result, rerender } = renderHook(
      ({ ids }) =>
        useCashActivityAnalysis(
          {
            accountIds: ["synthetic-account"],
            categoryIds: ["parent", "descendant"],
            search: "Synthetic",
          },
          { mode: "all", ids },
          true,
        ),
      { wrapper, initialProps: { ids: [] as string[] } },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.matching.count).toBe(151);
    expect(result.current.data?.selected.spending.byCurrency[0].amount).toBe("0.30");
    rerender({ ids: ["row-101"] });
    await waitFor(() => expect(mocks.searchCashActivities).toHaveBeenCalledTimes(2));
    expect(mocks.searchCashActivities).toHaveBeenLastCalledWith({
      accountIds: ["synthetic-account"],
      categoryIds: ["parent", "descendant"],
      search: "Synthetic",
      selection: { mode: "all", ids: ["row-101"] },
      offset: 0,
      limit: 0,
    });
  });

  it("ignores late responses after filter/selection changes and never shows previous totals while pending", async () => {
    let resolveOld: (value: CashActivitySearchResponse) => void = () => {};
    mocks.searchCashActivities
      .mockImplementationOnce(
        () =>
          new Promise<CashActivitySearchResponse>((resolve) => {
            resolveOld = resolve;
          }),
      )
      .mockResolvedValueOnce(response(2));
    const { result, rerender } = renderHook(
      ({ search }) => useCashActivityAnalysis({ search }, { mode: "explicit", ids: [] }, true),
      { wrapper, initialProps: { search: "old" } },
    );
    await waitFor(() => expect(mocks.searchCashActivities).toHaveBeenCalledTimes(1));
    expect(result.current.data).toBeUndefined();
    rerender({ search: "new" });
    await waitFor(() => expect(result.current.data?.matching.count).toBe(2));
    await act(async () => resolveOld(response(999)));
    expect(result.current.data?.matching.count).toBe(2);
  });

  it("does not fetch while disabled; errors and missing aggregates are not synthetic zero totals", async () => {
    mocks.searchCashActivities.mockResolvedValue({ items: [], totalCount: 0 });
    const { result, rerender } = renderHook(
      ({ enabled }) => useCashActivityAnalysis({}, { mode: "all", ids: [] }, enabled),
      { wrapper, initialProps: { enabled: false } },
    );
    expect(mocks.searchCashActivities).not.toHaveBeenCalled();
    rerender({ enabled: true });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
    expect(mocks.searchCashActivities).toHaveBeenCalledTimes(1);
  });

  it("keeps an honest empty response", async () => {
    const emptyMoney = { byCurrency: [], converted: null, missingRateCurrencies: [] };
    const empty = { count: 0, cashMovement: emptyMoney, spending: emptyMoney };
    const analysis: CashActivityAnalysis = { matching: empty, selected: empty, excluded: empty };
    mocks.searchCashActivities.mockResolvedValue({ items: [], totalCount: 0, analysis });
    const { result } = renderHook(
      () => useCashActivityAnalysis({}, { mode: "all", ids: [] }, true),
      { wrapper },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(analysis);
  });
});
