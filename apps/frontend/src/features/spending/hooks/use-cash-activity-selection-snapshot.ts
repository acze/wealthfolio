import { useQuery } from "@tanstack/react-query";

import { QueryKeys } from "@/lib/query-keys";

import { searchCashActivities } from "../adapters/cash-activities";
import type { CashActivitySearchRequest, CashActivitySelection } from "../types/cash-activity";

export function useCashActivitySelectionSnapshot(
  request: Omit<
    CashActivitySearchRequest,
    "offset" | "limit" | "selection" | "includeSelectionSnapshot"
  >,
  selection: CashActivitySelection,
  enabled: boolean,
) {
  const query = useQuery({
    queryKey: [QueryKeys.SPENDING_TRANSACTIONS, "selection-snapshot", request, selection],
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
  return {
    snapshot: enabled && query.isSuccess && query.fetchStatus === "idle" ? query.data : undefined,
    isPending: query.isPending,
    isFetching: query.isFetching,
    isPaused: query.isPaused,
    isError: query.isError,
    refetch: query.refetch,
  };
}
