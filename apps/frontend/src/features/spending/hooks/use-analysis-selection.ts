import { useState } from "react";

import type { CashActivitySelection } from "../types/cash-activity";

export const EMPTY_ANALYSIS_SELECTION: CashActivitySelection = { mode: "explicit", ids: [] };

export function isAnalysisSelected(selection: CashActivitySelection, id: string): boolean {
  return selection.mode === "all" ? !selection.ids.includes(id) : selection.ids.includes(id);
}

export function toggleAnalysisRows(
  selection: CashActivitySelection,
  ids: string[],
): CashActivitySelection {
  const remove = ids.every((id) => isAnalysisSelected(selection, id));
  const next = new Set(selection.ids);
  for (const id of ids) {
    if (remove === (selection.mode === "explicit")) next.delete(id);
    else next.add(id);
  }
  return { mode: selection.mode, ids: [...next].sort() };
}

/** Modes share the logical selection; mutations require a server-resolved ID snapshot. */
export function useAnalysisSelection(scope: string, initiallyActive = false) {
  const [state, setState] = useState(() => ({
    scope,
    active: initiallyActive,
    selection: EMPTY_ANALYSIS_SELECTION,
  }));
  if (state.scope !== scope) {
    setState({ scope, active: state.active, selection: EMPTY_ANALYSIS_SELECTION });
  }
  const selection = state.scope === scope ? state.selection : EMPTY_ANALYSIS_SELECTION;
  return {
    active: state.active,
    selection,
    start: () => setState((prev) => ({ ...prev, active: true })),
    stop: () => setState((prev) => ({ ...prev, active: false })),
    clear: () => setState((prev) => ({ ...prev, selection: EMPTY_ANALYSIS_SELECTION })),
    selectAll: () => setState((prev) => ({ ...prev, selection: { mode: "all", ids: [] } })),
    toggle: (ids: string[]) =>
      setState((prev) => ({
        scope,
        active: prev.active,
        selection: toggleAnalysisRows(
          prev.scope === scope ? prev.selection : EMPTY_ANALYSIS_SELECTION,
          ids,
        ),
      })),
    isSelected: (id: string) => isAnalysisSelected(selection, id),
  };
}
