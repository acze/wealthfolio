import { render, screen } from "@/test/render";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { NetSummary } from "../types/cash-activity";
import { TransactionsFilterBar } from "./transactions-filter-bar";

function net(
  byCurrency: NetSummary["byCurrency"],
  converted?: NetSummary["converted"],
): NetSummary {
  return { byCurrency, converted: converted ?? null };
}

function renderBar(
  nets: { selectedNet?: NetSummary | null; filteredNet?: NetSummary | null },
  overrides: { isMobile?: boolean } = {},
) {
  return render(
    <TransactionsFilterBar
      searchInput=""
      onSearchInputChange={vi.fn()}
      statusFilter="all"
      onStatusFilterChange={vi.fn()}
      dateRange={undefined}
      onDateRangeChange={vi.fn()}
      selectedAccounts={new Set()}
      onAccountsChange={vi.fn()}
      selectedTypes={new Set()}
      onTypesChange={vi.fn()}
      selectedCategories={new Set()}
      onCategoriesChange={vi.fn()}
      selectedSubcategories={new Set()}
      onSubcategoriesChange={vi.fn()}
      selectedEvents={new Set()}
      onEventsChange={vi.fn()}
      amountRange={{ min: null, max: null }}
      onAmountRangeChange={vi.fn()}
      accountOptions={[]}
      typeOptions={[]}
      categoryOptions={[]}
      subcategoryOptions={[]}
      eventOptions={[]}
      hasEvents={false}
      filtersActive={false}
      onClearAll={vi.fn()}
      visibleCount={2}
      totalCount={2}
      selectedNet={nets.selectedNet ?? null}
      filteredNet={nets.filteredNet ?? null}
      isRefreshing={false}
      isMobile={overrides.isMobile}
    />,
  );
}

describe("TransactionsFilterBar net readouts", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("shows neither readout when there is nothing to report", () => {
    renderBar({});

    expect(screen.queryByText("Selected net")).not.toBeInTheDocument();
    expect(screen.queryByText("Filtered net")).not.toBeInTheDocument();
  });

  it("shows the selected net on its own", () => {
    renderBar({ selectedNet: net([{ currency: "USD", amount: -131.5 }]) });

    expect(screen.getByText("Selected net")).toBeInTheDocument();
    // The pill names the currency beside the figure, so the figure itself
    // carries no symbol.
    expect(screen.getByText("USD")).toBeInTheDocument();
    expect(screen.getByText("131.50")).toBeInTheDocument();
    expect(screen.queryByText("Filtered net")).not.toBeInTheDocument();
  });

  it.each([false, true])(
    "keeps selected and filtered zero nets visible (mobile=%s)",
    (isMobile) => {
      renderBar({ selectedNet: net([]), filteredNet: net([]) }, { isMobile });

      expect(screen.getByText("Selected net")).toBeVisible();
      expect(screen.getByText("Filtered net")).toBeVisible();
      expect(screen.getAllByText("0.00")).toHaveLength(2);
    },
  );

  it("keeps a converted zero visible even without native currency rows", () => {
    renderBar({ selectedNet: net([], { currency: "USD", amount: 0 }) });

    expect(screen.getByText("Selected net")).toBeVisible();
    expect(screen.getByText("$0.00")).toBeVisible();
  });

  it("keeps explicit zero currency rows visible", () => {
    renderBar({ selectedNet: net([{ currency: "JPY", amount: 0 }]) });

    expect(screen.getByText("Selected net")).toBeVisible();
    expect(screen.getByText("JPY")).toBeVisible();
    expect(screen.getByText("0")).toBeVisible();
  });

  it("masks zero readouts without removing their labels", () => {
    vi.stubGlobal("localStorage", { getItem: () => "true" });
    renderBar({ selectedNet: net([]), filteredNet: net([]) });

    expect(screen.getByText("Selected net")).toBeVisible();
    expect(screen.getByText("Filtered net")).toBeVisible();
    expect(screen.getAllByText("••••")).toHaveLength(2);
    expect(screen.queryByText("0.00")).not.toBeInTheDocument();
  });

  it("shows both readouts at once", () => {
    renderBar({
      selectedNet: net([{ currency: "USD", amount: -20 }]),
      filteredNet: net([{ currency: "USD", amount: 500 }]),
    });

    expect(screen.getByText("Selected net")).toBeInTheDocument();
    expect(screen.getByText("Filtered net")).toBeInTheDocument();
    expect(screen.getByText("20.00")).toBeInTheDocument();
    expect(screen.getByText("500.00")).toBeInTheDocument();
  });

  it("lists one figure per currency rather than converting", () => {
    renderBar({
      filteredNet: net([
        { currency: "USD", amount: -60 },
        { currency: "EUR", amount: 60 },
      ]),
    });

    expect(screen.getByText("USD")).toBeInTheDocument();
    expect(screen.getByText("EUR")).toBeInTheDocument();
    expect(screen.getAllByText("60.00")).toHaveLength(2);
  });

  it("leads with the converted figure and keeps the breakdown beside it", () => {
    renderBar({
      filteredNet: net(
        [
          { currency: "USD", amount: -60 },
          { currency: "EUR", amount: -40 },
        ],
        { currency: "USD", amount: -104 },
      ),
    });

    // The converted headline carries its symbol; the pills stay unsymbolled, so
    // the "$" is what distinguishes it from the breakdown.
    expect(screen.getByText("$104.00")).toBeInTheDocument();
    expect(screen.getByText("USD")).toBeInTheDocument();
    expect(screen.getByText("EUR")).toBeInTheDocument();
  });

  it("shows the breakdown alone when conversion was withheld", () => {
    renderBar({
      filteredNet: net([
        { currency: "USD", amount: -60 },
        { currency: "JPY", amount: -400 },
      ]),
    });

    expect(screen.getByText("Filtered net")).toBeInTheDocument();
    expect(screen.getByText("JPY")).toBeInTheDocument();
    // No symbol anywhere means no converted headline was rendered.
    expect(screen.queryByText(/\$/)).not.toBeInTheDocument();
  });

  /** The readouts used to render only on desktop. */
  it("renders the readouts on mobile too", () => {
    renderBar({ filteredNet: net([{ currency: "USD", amount: 500 }]) }, { isMobile: true });

    expect(screen.getByText("Filtered net")).toBeInTheDocument();
    expect(screen.getByText("500.00")).toBeInTheDocument();
  });
});
