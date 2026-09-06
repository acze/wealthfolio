import { render, screen, within } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AnalysisTotals, CashActivityAnalysis } from "../types/cash-activity";
import { TransactionsAnalysisBar } from "./transactions-analysis-bar";

const privacy = vi.hoisted(() => ({ isBalanceHidden: false }));
vi.mock("@wealthfolio/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@wealthfolio/ui")>()),
  useBalancePrivacy: () => privacy,
}));

function total(count: number, spending: string, movement: string): AnalysisTotals {
  return {
    count,
    spending: {
      byCurrency: [{ currency: "USD", amount: spending }],
      converted: null,
      missingRateCurrencies: [],
    },
    cashMovement: {
      byCurrency: [{ currency: "USD", amount: movement }],
      converted: null,
      missingRateCurrencies: [],
    },
  };
}
const analysis: CashActivityAnalysis = {
  matching: total(151, "1500.30", "-900.30"),
  selected: total(150, "500.30", "99.70"),
  excluded: total(1, "1000", "-1000"),
};

function props() {
  return {
    active: true,
    analysis,
    pending: false,
    failed: false,
    onStart: vi.fn(),
    onStop: vi.fn(),
    onSelectAll: vi.fn(),
    onClear: vi.fn(),
    onRetry: vi.fn(),
  };
}

describe("TransactionsAnalysisBar", () => {
  beforeEach(() => {
    privacy.isBalanceHidden = false;
  });

  it("distinguishes selected/full/excluded consumption from signed mixed cash movement", () => {
    render(<TransactionsAnalysisBar {...props()} />);
    expect(screen.getByText("150 of 151 matching transactions selected")).toBeVisible();
    const selected = within(screen.getByTestId("analysis-selected"));
    expect(selected.getByText("500.30 USD")).toBeVisible();
    expect(selected.getByText("99.70 USD")).toBeVisible();
    expect(selected.getByText("Net spending")).toBeVisible();
    expect(selected.getByText("Signed cash movement")).toBeVisible();
    expect(within(screen.getByTestId("analysis-excluded")).getByText("1,000.00 USD")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
  });

  it("supports keyboard controls and never exposes bulk mutations", async () => {
    const user = userEvent.setup();
    const callbacks = props();
    render(<TransactionsAnalysisBar {...callbacks} />);
    screen.getByRole("button", { name: "Select all matching" }).focus();
    await user.keyboard("{Enter}");
    expect(callbacks.onSelectAll).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(callbacks.onClear).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Exit analysis" }));
    expect(callbacks.onStop).toHaveBeenCalledTimes(1);
  });

  it("hides cached amounts/counts during refetches and errors, rather than flashing a stale success", () => {
    const p = props();
    const { rerender } = render(<TransactionsAnalysisBar {...p} pending />);
    expect(screen.queryByTestId("analysis-selected")).not.toBeInTheDocument();
    expect(screen.getByText("Updating analysis...")).toBeVisible();
    rerender(<TransactionsAnalysisBar {...p} failed />);
    expect(screen.queryByTestId("analysis-selected")).not.toBeInTheDocument();
    expect(screen.getByText("Analysis unavailable. No totals are shown.")).toBeVisible();
  });

  it("masks every amount including currency breakdowns", async () => {
    privacy.isBalanceHidden = true;
    const p = props();
    render(<TransactionsAnalysisBar {...p} />);
    expect(screen.queryByText(/500\.30/)).not.toBeInTheDocument();
    expect(screen.queryByText(/99\.70/)).not.toBeInTheDocument();
    expect(screen.getAllByText(/••••/)).toHaveLength(6);
  });

  it("displays separate currency amounts and explicit missing FX instead of inventing a base total", () => {
    const p = props();
    const mixed = {
      ...analysis,
      selected: {
        ...analysis.selected,
        spending: {
          byCurrency: [
            { currency: "USD", amount: "10.10" },
            { currency: "EUR", amount: "-2.20" },
          ],
          converted: null,
          missingRateCurrencies: ["EUR"],
        },
      },
    };
    render(<TransactionsAnalysisBar {...p} analysis={mixed} />);
    const selected = within(screen.getByTestId("analysis-selected"));
    expect(selected.getByText("10.10 USD")).toBeVisible();
    expect(selected.getByText("-2.20 EUR")).toBeVisible();
    expect(selected.getByText(/missing rates for EUR/)).toBeVisible();
    expect(selected.queryByText("7.90 USD")).not.toBeInTheDocument();
  });

  it("shows an empty result honestly and disables select-all", () => {
    const empty = total(0, "0", "0");
    render(
      <TransactionsAnalysisBar
        {...props()}
        analysis={{ matching: empty, selected: empty, excluded: empty }}
      />,
    );
    expect(screen.getByText("0 of 0 matching transactions selected")).toBeVisible();
    expect(screen.getByRole("button", { name: "Select all matching" })).toBeDisabled();
  });
});
