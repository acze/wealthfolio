import type { TaxonomyCategory } from "@/lib/types";
import { act, render, screen, within } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { TooltipProvider } from "@wealthfolio/ui";
import { createMemoryRouter, MemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useCashActivityAnalysis } from "../../hooks/use-cash-activity-analysis";
import { useCashActivitySearch } from "../../hooks/use-cash-activity-search";
import type { AnalysisTotals, CashActivity, CashActivityAnalysis } from "../../types/cash-activity";
import { CategoryTransactionsSheet } from "./category-transactions-sheet";

vi.mock("../../hooks/use-cash-activity-analysis", () => ({
  useCashActivityAnalysis: vi.fn(),
}));
vi.mock("../../hooks/use-cash-activity-search", () => ({
  useCashActivitySearch: vi.fn(),
}));
vi.mock("@/hooks/use-accounts", () => ({
  useAccounts: () => ({
    accounts: [{ id: "synthetic-account", name: "Synthetic account", accountType: "CHECKING" }],
  }),
}));

const taxonomyCategories = [
  { id: "food", parentId: null, name: "Food" },
  { id: "groceries", parentId: "food", name: "Groceries" },
  { id: "produce", parentId: "groceries", name: "Produce" },
  { id: "fruit", parentId: "produce", name: "Fruit" },
  { id: "travel", parentId: null, name: "Travel" },
].map(
  (category): TaxonomyCategory => ({
    ...category,
    taxonomyId: "spending_categories",
    key: category.id,
    color: "#112233",
    icon: null,
    description: null,
    sortOrder: 0,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  }),
);

function activity(index: number, overrides: Partial<CashActivity> = {}): CashActivity {
  return {
    id: `synthetic-activity-${index}`,
    activityType: "WITHDRAWAL",
    activityDate: "2026-06-10T10:00:00Z",
    accountId: "synthetic-account",
    amount: "10",
    currency: "USD",
    cashFlowBucket: "spending",
    assignments: [],
    splits: [],
    isUserModified: false,
    needsReview: false,
    netAmount: -10,
    status: "POSTED",
    notes: `Synthetic transaction ${index}`,
    createdAt: "2026-06-10T10:00:00Z",
    updatedAt: "2026-06-10T10:00:00Z",
    ...overrides,
  } as CashActivity;
}

const allRows = Array.from({ length: 151 }, (_, index) => activity(index));
const matching: AnalysisTotals = {
  count: 151,
  spending: {
    byCurrency: [
      { currency: "USD", amount: "200" },
      { currency: "EUR", amount: "1000" },
    ],
    converted: { currency: "USD", amount: "1299.75" },
    missingRateCurrencies: [],
  },
  cashMovement: {
    byCurrency: [{ currency: "USD", amount: "-1200.25" }],
    converted: null,
    missingRateCurrencies: [],
  },
};
const empty: AnalysisTotals = {
  count: 0,
  spending: { byCurrency: [], converted: null, missingRateCurrencies: [] },
  cashMovement: { byCurrency: [], converted: null, missingRateCurrencies: [] },
};
const analysis: CashActivityAnalysis = { matching, selected: matching, excluded: empty };
const fetchNextPage = vi.fn();
let privacyHidden = false;

function mockSearch(overrides: Partial<ReturnType<typeof useCashActivitySearch>> = {}) {
  vi.mocked(useCashActivitySearch).mockReturnValue({
    items: allRows.slice(0, 50),
    totalCount: 151,
    isLoading: false,
    isFetching: false,
    isError: false,
    hasNextPage: true,
    isFetchingNextPage: false,
    isFetchNextPageError: false,
    fetchNextPage,
    refetch: vi.fn(),
    error: null,
    net: null,
    baseCurrency: "USD",
    ...overrides,
  } as ReturnType<typeof useCashActivitySearch>);
}

function mockAnalysis(overrides: Partial<ReturnType<typeof useCashActivityAnalysis>> = {}) {
  vi.mocked(useCashActivityAnalysis).mockReturnValue({
    data: analysis,
    isPending: false,
    isFetching: false,
    isError: false,
    ...overrides,
  } as ReturnType<typeof useCashActivityAnalysis>);
}

function props() {
  return {
    open: true,
    onOpenChange: vi.fn(),
    category: taxonomyCategories[0],
    taxonomyCategories,
    rangeStart: new Date("2026-05-31T15:00:00.000Z"),
    rangeEnd: new Date("2026-06-30T14:59:59.999Z"),
    timezone: "Asia/Tokyo",
    currency: "USD",
    accountIds: ["synthetic-account"],
  };
}

function sheet(p: Parameters<typeof CategoryTransactionsSheet>[0] = props()) {
  return (
    <MemoryRouter initialEntries={["/spending/insights?stage=changed&period=MTD"]}>
      <TooltipProvider>
        <CategoryTransactionsSheet {...p} />
      </TooltipProvider>
    </MemoryRouter>
  );
}

describe("CategoryTransactionsSheet", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    privacyHidden = false;
    vi.stubGlobal("localStorage", { getItem: () => JSON.stringify(privacyHidden) });
    mockSearch();
    mockAnalysis();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses identical complete subtree, account and exact report date filters for rows and totals", () => {
    const p = props();
    render(sheet(p));
    const expectedRequest = {
      categoryIds: ["food", "fruit", "groceries", "produce"],
      accountIds: ["synthetic-account"],
      startDate: p.rangeStart.toISOString(),
      endDate: p.rangeEnd.toISOString(),
      sortBy: "date",
      sortDir: "desc",
    };
    expect(useCashActivitySearch).toHaveBeenLastCalledWith(expectedRequest, { enabled: true });
    expect(useCashActivityAnalysis).toHaveBeenLastCalledWith(
      expectedRequest,
      { mode: "all", ids: [] },
      true,
    );
    expect(screen.getByText("Jun 1 – Jun 30, 2026 · 30 days")).toBeVisible();
  });

  it("keeps full server totals unchanged when loading more than the first 50 rows", async () => {
    const user = userEvent.setup();
    const { rerender } = render(sheet());
    const summary = within(screen.getByRole("status"));
    expect(screen.getAllByRole("listitem")).toHaveLength(50);
    expect(screen.getByText("151 total")).toBeVisible();
    expect(summary.getByText("1,299.75 USD")).toBeVisible();
    expect(summary.getByText("-1,200.25 USD")).toBeVisible();
    expect(summary.queryByText(/500\.00/)).not.toBeInTheDocument();
    expect(screen.queryByText("Avg / tx")).not.toBeInTheDocument();
    expect(screen.queryByText("Daily pace")).not.toBeInTheDocument();
    expect(screen.queryByText("Subcategory mix")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Load 50 more" }));
    expect(fetchNextPage).toHaveBeenCalledOnce();
    mockSearch({ items: allRows.slice(0, 100) });
    rerender(sheet());
    expect(screen.getAllByRole("listitem")).toHaveLength(100);
    expect(summary.getByText("1,299.75 USD")).toBeVisible();
    expect(summary.getByText("-1,200.25 USD")).toBeVisible();
  });

  it("expands nested subparents and links to analysis with the same calendar/account scope", async () => {
    const user = userEvent.setup();
    const p = { ...props(), category: taxonomyCategories[1] };
    render(sheet(p));
    expect(useCashActivitySearch).toHaveBeenLastCalledWith(
      expect.objectContaining({ categoryIds: ["fruit", "groceries", "produce"] }),
      { enabled: true },
    );
    const link = screen.getByRole("link", { name: "Open in Transactions" });
    const url = new URL(link.getAttribute("href")!, "https://synthetic.invalid");
    expect(url.pathname).toBe("/activities");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      tab: "spending",
      analysis: "true",
      subcategory: "groceries",
      from: "2026-06-01",
      to: "2026-06-30",
      accounts: "synthetic-account",
    });
    await user.click(link);
    expect(p.onOpenChange).toHaveBeenCalledWith(false);
  });

  it("links top-level categories and does not invent accounts when none are supplied", () => {
    render(sheet({ ...props(), accountIds: undefined }));
    const link = screen.getByRole("link", { name: "Open in Transactions" });
    const params = new URL(link.getAttribute("href")!, "https://synthetic.invalid").searchParams;
    expect(params.get("category")).toBe("food");
    expect(params.get("subcategory")).toBeNull();
    expect(params.get("accounts")).toBeNull();
    expect(params.get("analysis")).toBe("true");
  });

  it("preserves the Insights location in browser history when opening Transactions", async () => {
    const user = userEvent.setup();
    const initialLocation = "/spending/insights?stage=changed&period=MTD";
    const router = createMemoryRouter(
      [
        {
          path: "/spending/insights",
          element: (
            <TooltipProvider>
              <CategoryTransactionsSheet {...props()} />
            </TooltipProvider>
          ),
        },
        { path: "/activities", element: <div>Synthetic transactions destination</div> },
      ],
      { initialEntries: [initialLocation] },
    );
    render(<RouterProvider router={router} />);
    await user.click(screen.getByRole("link", { name: "Open in Transactions" }));
    expect(screen.getByText("Synthetic transactions destination")).toBeVisible();
    expect(router.state.location.search).toContain("analysis=true");
    await act(() => router.navigate(-1));
    expect(router.state.location.pathname + router.state.location.search).toBe(initialLocation);
  });

  it("hides cached totals while fetching, pending, or failed", () => {
    mockAnalysis({ isFetching: true });
    const { rerender } = render(sheet());
    expect(within(screen.getByRole("status")).getByText("Loading…")).toBeVisible();
    expect(screen.queryByText("1,299.75 USD")).not.toBeInTheDocument();

    mockAnalysis({ isError: true });
    rerender(sheet());
    expect(
      within(screen.getByRole("status")).getByText("Analysis unavailable. No totals are shown."),
    ).toBeVisible();
    expect(screen.queryByText("1,299.75 USD")).not.toBeInTheDocument();

    mockAnalysis({ data: undefined, isPending: true });
    rerender(sheet());
    expect(within(screen.getByRole("status")).getByText("Loading…")).toBeVisible();
    expect(screen.queryByText("Net spending")).not.toBeInTheDocument();
  });

  it("shows server signed native cash movement without inferring signs from type or nominal amount", () => {
    mockSearch({
      items: [
        activity(0, { activityType: "DEPOSIT", amount: "700", netAmount: -13.5 }),
        activity(1, { amount: "90", netAmount: 12 }),
        activity(2, { amount: "100", netAmount: 0 }),
        activity(3, { currency: "EUR", amount: "50", netAmount: -20.25 }),
      ],
      totalCount: 4,
      hasNextPage: false,
    });
    render(sheet());
    const rows = screen.getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("-$13.50");
    expect(rows[0]).not.toHaveTextContent("700");
    expect(rows[1]).toHaveTextContent("$12.00");
    expect(rows[1]).not.toHaveTextContent("-$12.00");
    expect(rows[2]).toHaveTextContent("$0.00");
    expect(rows[2]).not.toHaveTextContent("100.00");
    expect(rows[3]).toHaveTextContent("-€20.25");
    expect(rows[3]).toHaveTextContent("EUR");
  });

  it("does not display stale list counts during refresh or errors", () => {
    mockSearch({ isFetching: true });
    const { rerender } = render(sheet());
    expect(screen.queryByText("151 total")).not.toBeInTheDocument();
    mockSearch({ isError: true, error: new Error("Synthetic search failure") });
    rerender(sheet());
    expect(screen.queryByText("151 total")).not.toBeInTheDocument();
    expect(screen.getByText("Synthetic search failure")).toBeVisible();
  });

  it("delegates missing-FX summaries and privacy masking to the shared totals readout", () => {
    const mixed = {
      ...analysis,
      matching: {
        ...matching,
        spending: {
          byCurrency: [
            { currency: "USD", amount: "200" },
            { currency: "EUR", amount: "-10.25" },
          ],
          converted: null,
          missingRateCurrencies: ["EUR"],
        },
      },
    };
    mockAnalysis({ data: mixed });
    const { unmount } = render(sheet());
    const summary = within(screen.getByRole("status"));
    expect(summary.getByText("200.00 USD")).toBeVisible();
    expect(summary.getByText("-10.25 EUR")).toBeVisible();
    expect(summary.getByText(/missing rates for EUR/)).toBeVisible();
    expect(summary.queryByText("1,299.75 USD")).not.toBeInTheDocument();

    unmount();
    privacyHidden = true;
    render(sheet());
    expect(screen.queryByText(/200\.00/)).not.toBeInTheDocument();
    expect(screen.queryByText(/10\.25/)).not.toBeInTheDocument();
    expect(screen.getAllByRole("listitem")[0]).toHaveTextContent("••••");
    expect(screen.getAllByRole("listitem")[0]).not.toHaveTextContent("$10.00");
  });

  it("does not fetch category rows or totals when closed or without a category", () => {
    const { rerender } = render(sheet({ ...props(), open: false }));
    expect(useCashActivityAnalysis).toHaveBeenLastCalledWith(
      expect.anything(),
      { mode: "all", ids: [] },
      false,
    );
    rerender(sheet({ ...props(), category: null }));
    expect(useCashActivitySearch).toHaveBeenLastCalledWith(
      expect.objectContaining({ categoryIds: [] }),
      { enabled: false },
    );
    expect(useCashActivityAnalysis).toHaveBeenLastCalledWith(
      expect.anything(),
      { mode: "all", ids: [] },
      false,
    );
  });
});
