import { useQuery, useQueryClient } from "@tanstack/react-query";

import { QueryKeys } from "@/lib/query-keys";

import { searchCashActivities } from "../adapters/cash-activities";
import type {
  CashActivitySearchRequest,
  CashActivitySelection,
  CashActivitySelectionSnapshot,
} from "../types/cash-activity";

export function useCashActivitySelectionSnapshot(
  request: Omit<
    CashActivitySearchRequest,
    "offset" | "limit" | "selection" | "includeSelectionSnapshot"
  >,
  selection: CashActivitySelection,
  enabled: boolean,
) {
  const queryClient = useQueryClient();
  const queryKey = [QueryKeys.SPENDING_TRANSACTIONS, "selection-snapshot", request, selection];
  const query = useQuery({
    queryKey,
    queryFn: async () => {
      const response = await searchCashActivities({
        ...request,
        selection,
        includeSelectionSnapshot: true,
        offset: 0,
        limit: 0,
      });
      if (!response.selectionSnapshot) throw new Error("Selection snapshot is unavailable.");
      return response.selectionSnapshot;
    },
    enabled,
    retry: false,
    staleTime: 0,
  });
  // Confirmation handlers must see invalidation even before React has rerendered.
  const getReadySnapshot = () => {
    const current = queryClient.getQueryState<CashActivitySelectionSnapshot>(queryKey);
    return enabled &&
      current?.status === "success" &&
      current.fetchStatus === "idle" &&
      !current.isInvalidated
      ? current.data
      : undefined;
  };
  const snapshot =
    enabled && query.isSuccess && query.fetchStatus === "idle" ? query.data : undefined;
  return {
    snapshot: snapshot && getReadySnapshot() === snapshot ? snapshot : undefined,
    getReadySnapshot,
    isPending: query.isPending,
    isFetching: query.isFetching,
    isPaused: query.isPaused,
    isError: query.isError,
    refetch: query.refetch,
  };
}
