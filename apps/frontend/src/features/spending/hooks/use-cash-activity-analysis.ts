import { useQuery } from "@tanstack/react-query";

import { QueryKeys } from "@/lib/query-keys";

import { searchCashActivities } from "../adapters/cash-activities";
import type { CashActivitySearchRequest, CashActivitySelection } from "../types/cash-activity";

export function useCashActivityAnalysis(
  request: Omit<CashActivitySearchRequest, "offset" | "limit" | "selection">,
  selection: CashActivitySelection,
  enabled: boolean,
) {
  return useQuery({
    queryKey: [QueryKeys.SPENDING_TRANSACTIONS, "analysis", request, selection],
    queryFn: async () => {
      const response = await searchCashActivities({
        ...request,
        selection,
        offset: 0,
        limit: 0,
      });
      if (!response.analysis) throw new Error("Selection analysis is unavailable.");
      return response.analysis;
    },
    enabled,
    // One request per state change; old responses remain under their old key.
    // Never retry/poll a failed aggregate or retain a previous selection's total.
    retry: false,
    staleTime: 0,
  });
}
