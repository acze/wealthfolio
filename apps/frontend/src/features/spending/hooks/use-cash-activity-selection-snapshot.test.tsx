import { onlineManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  CashActivitySearchResponse,
  CashActivitySelection,
  CashActivitySelectionSnapshot,
} from "../types/cash-activity";
import { useCashActivitySelectionSnapshot } from "./use-cash-activity-selection-snapshot";

const mocks = vi.hoisted(() => ({ searchCashActivities: vi.fn() }));
vi.mock("../adapters/cash-activities", () => mocks);

function createWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

function response(ids: string[]): CashActivitySearchResponse {
  return {
    items: [],
    totalCount: 1501,
    selectionSnapshot: {
      ids,
      net: {
        byCurrency: [
          { currency: "CAD", amount: -120 },
          { currency: "EUR", amount: 0 },
        ],
        converted: null,
      },
      cashFlowBuckets: ["spending"],
    },
  };
}

function deferred() {
  let resolve!: (value: CashActivitySearchResponse) => void;
  const promise = new Promise<CashActivitySearchResponse>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("useCashActivitySelectionSnapshot", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => onlineManager.setOnline(true));

  it("materializes the complete selected IDs and zero-currency context, not a rendered page", async () => {
    const ids = Array.from({ length: 1500 }, (_, i) => `row-${i}`);
    mocks.searchCashActivities.mockResolvedValue(response(ids));
    const { result } = renderHook(
      () =>
        useCashActivitySelectionSnapshot(
          { accountIds: ["synthetic-account"], categoryIds: ["parent", "descendant"] },
          { mode: "all", ids: ["outlier-on-last-page"] },
          true,
        ),
      { wrapper: createWrapper() },
    );
    await waitFor(() => expect(result.current.snapshot?.ids).toHaveLength(1500));
    expect(result.current.snapshot?.net.byCurrency).toContainEqual({ currency: "EUR", amount: 0 });
    expect(mocks.searchCashActivities).toHaveBeenCalledExactlyOnceWith({
      accountIds: ["synthetic-account"],
      categoryIds: ["parent", "descendant"],
      selection: { mode: "all", ids: ["outlier-on-last-page"] },
      includeSelectionSnapshot: true,
      offset: 0,
      limit: 0,
    });
  });

  it("never exposes cached IDs while in Analysis or after quickly returning during materialization", async () => {
    const old = deferred();
    const fresh = deferred();
    mocks.searchCashActivities
      .mockImplementationOnce(() => old.promise)
      .mockImplementationOnce(() => fresh.promise);
    const { result, rerender } = renderHook(
      ({ enabled }) => useCashActivitySelectionSnapshot({}, { mode: "all", ids: [] }, enabled),
      { wrapper: createWrapper(), initialProps: { enabled: true } },
    );
    await waitFor(() => expect(mocks.searchCashActivities).toHaveBeenCalledTimes(1));
    expect(result.current.snapshot).toBeUndefined();
    rerender({ enabled: false });
    await act(async () => {
      old.resolve(response(["old-selection"]));
      await old.promise;
    });
    expect(result.current.snapshot).toBeUndefined();
    rerender({ enabled: true });
    await waitFor(() => expect(mocks.searchCashActivities).toHaveBeenCalledTimes(2));
    expect(result.current.snapshot).toBeUndefined();
    await act(async () => {
      fresh.resolve(response(["fresh-selection"]));
      await fresh.promise;
    });
    await waitFor(() => expect(result.current.snapshot?.ids).toEqual(["fresh-selection"]));
  });

  it("ignores late materialization after a filter and selection change", async () => {
    const old = deferred();
    mocks.searchCashActivities
      .mockImplementationOnce(() => old.promise)
      .mockResolvedValueOnce(response(["new-filter-row"]));
    const { result, rerender } = renderHook(
      ({ search, selection }: { search: string; selection: CashActivitySelection }) =>
        useCashActivitySelectionSnapshot({ search }, selection, true),
      {
        wrapper: createWrapper(),
        initialProps: { search: "old", selection: { mode: "all", ids: [] } },
      },
    );
    await waitFor(() => expect(mocks.searchCashActivities).toHaveBeenCalledTimes(1));
    rerender({ search: "new", selection: { mode: "explicit", ids: ["new-filter-row"] } });
    await waitFor(() => expect(result.current.snapshot?.ids).toEqual(["new-filter-row"]));
    await act(async () => {
      old.resolve(response(["stale-row"]));
      await old.promise;
    });
    expect(result.current.snapshot?.ids).toEqual(["new-filter-row"]);
  });

  it("withholds cached IDs after an error and exposes only the successful retry", async () => {
    mocks.searchCashActivities.mockResolvedValueOnce(response(["first"]));
    const { result } = renderHook(
      () => useCashActivitySelectionSnapshot({}, { mode: "explicit", ids: ["first"] }, true),
      { wrapper: createWrapper() },
    );
    await waitFor(() => expect(result.current.snapshot?.ids).toEqual(["first"]));
    mocks.searchCashActivities.mockRejectedValueOnce(new Error("Synthetic read failure"));
    await act(async () => {
      await result.current.refetch();
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.snapshot).toBeUndefined();
    mocks.searchCashActivities.mockResolvedValueOnce(response(["first"]));
    await act(async () => {
      await result.current.refetch();
    });
    await waitFor(() => expect(result.current.snapshot?.ids).toEqual(["first"]));
    expect(mocks.searchCashActivities).toHaveBeenCalledTimes(3);
  });

  it("fails explicitly when the backend does not return the requested snapshot", async () => {
    mocks.searchCashActivities.mockResolvedValue({ items: [], totalCount: 1501 });
    const { result } = renderHook(
      () => useCashActivitySelectionSnapshot({}, { mode: "all", ids: [] }, true),
      { wrapper: createWrapper() },
    );
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.snapshot).toBeUndefined();
    expect(mocks.searchCashActivities).toHaveBeenCalledTimes(1);
  });

  it("does not expose a cached ID snapshot while an offline refetch is paused", async () => {
    mocks.searchCashActivities
      .mockResolvedValueOnce(response(["old"]))
      .mockResolvedValueOnce(response(["fresh"]));
    const { result } = renderHook(
      () => useCashActivitySelectionSnapshot({}, { mode: "all", ids: [] }, true),
      { wrapper: createWrapper() },
    );
    await waitFor(() => expect(result.current.snapshot?.ids).toEqual(["old"]));
    act(() => {
      onlineManager.setOnline(false);
      void result.current.refetch();
    });
    await waitFor(() => expect(result.current.isPaused).toBe(true));
    expect(result.current.snapshot).toBeUndefined();
    act(() => onlineManager.setOnline(true));
    await waitFor(() => expect(result.current.snapshot?.ids).toEqual(["fresh"]));
  });

  it("does not fetch a cleared selection and distinguishes a valid empty snapshot", async () => {
    const empty: CashActivitySelectionSnapshot = {
      ids: [],
      net: { byCurrency: [], converted: null },
      cashFlowBuckets: [],
    };
    mocks.searchCashActivities.mockResolvedValue({ ...response([]), selectionSnapshot: empty });
    const { result, rerender } = renderHook(
      ({ enabled }) => useCashActivitySelectionSnapshot({}, { mode: "explicit", ids: [] }, enabled),
      { wrapper: createWrapper(), initialProps: { enabled: false } },
    );
    expect(mocks.searchCashActivities).not.toHaveBeenCalled();
    expect(result.current.snapshot).toBeUndefined();
    rerender({ enabled: true });
    await waitFor(() => expect(result.current.snapshot).toEqual(empty));
  });
});
