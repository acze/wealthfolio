import { render, screen, within } from "@testing-library/react";
import { FormattingProvider } from "@wealthfolio/ui";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import plSpending from "@/i18n/locales/pl/spending.json";
import type { MonthlyReport } from "../../../types/report";
import { WhereIAmStage } from "./where-i-am-stage";

vi.mock("@/hooks/use-balance-privacy", () => ({
  useBalancePrivacy: () => ({ isBalanceHidden: false }),
}));

async function renderCard(income = 12345.67, outflow = 15000, saved = 2000, isLoading = false) {
  const i18n = i18next.createInstance();
  await i18n.init({
    lng: "pl",
    fallbackLng: false,
    resources: { pl: { spending: plSpending } },
    interpolation: { escapeValue: false },
  });
  const report: MonthlyReport = {
    current: { income, outflow, saved, net: income - outflow - saved, count: 3 },
    prior: { income: 0, outflow: 0, saved: 0, net: 0, count: 0 },
    spendingBreakdown: [],
    incomeBreakdown: [],
    savingsBreakdown: [],
    byDay: [],
    byDayByCategory: [],
  };
  render(
    <MemoryRouter>
      <I18nextProvider i18n={i18n}>
        <FormattingProvider locale="pl-PL" uiLocale="pl" timezone="UTC">
          <WhereIAmStage
            range={{
              start: new Date("2026-09-01T00:00:00Z"),
              end: new Date("2026-09-30T23:59:59Z"),
              days: 30,
              months: 1,
            }}
            currentReport={report}
            priorReport={undefined}
            months={[{ iso: "2026-09-01", label: "wrz", report, isLoading }]}
            taxonomyCategories={[]}
            incomeCategories={[]}
            savingsCategories={[]}
            budget={undefined}
            currency="PLN"
            isLoading={isLoading}
          />
        </FormattingProvider>
      </I18nextProvider>
    </MemoryRouter>,
  );
}

describe("Net cashflow card layout", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses shared intrinsic columns and complete Polish labels without fixed text widths", async () => {
    await renderCard();
    const card = screen.getByTestId("net-cashflow-card");
    const rows = within(card).getAllByTestId("net-cashflow-row");
    expect(card).toHaveClass("@container", "min-w-0");
    expect(rows).toHaveLength(3);
    for (const [index, label] of ["Przychody", "Wydano", "Zaoszczędzono"].entries()) {
      expect(rows[index]).toHaveClass("grid", "grid-cols-subgrid", "col-span-full");
      const labelNode = within(rows[index]).getByText(label, { exact: true });
      expect(labelNode).not.toHaveClass("w-12", "truncate");
      expect(rows[index].lastElementChild).not.toHaveClass("w-20", "truncate");
    }
    const tracks = within(card).getAllByTestId("net-cashflow-track");
    expect(tracks[0].firstElementChild).toHaveStyle({ width: `${(12345.67 / 15000) * 100}%` });
    expect(tracks[1].firstElementChild).toHaveStyle({ width: "100%" });
    expect(tracks[2].firstElementChild).toHaveStyle({ width: `${(2000 / 15000) * 100}%` });
    const headline = within(card).getByText("Wydatki przekroczyły przychody o 38%");
    expect(headline.parentElement).toHaveClass("flex-wrap");
    expect(card.textContent?.replace(/\s/g, " ")).toContain("4654,33 zł");
  });

  it("keeps the no-income message and zero values, omitting only the existing saved-zero row", async () => {
    await renderCard(0, 0, 0);
    const card = screen.getByTestId("net-cashflow-card");
    expect(within(card).getAllByTestId("net-cashflow-row")).toHaveLength(2);
    expect(within(card).queryByText("Zaoszczędzono")).not.toBeInTheDocument();
    expect(within(card).getByText(plSpending.whereIAm.noIncome)).toBeVisible();
    for (const track of within(card).getAllByTestId("net-cashflow-track")) {
      expect(track.firstElementChild).toHaveStyle({ width: "0%" });
    }
    expect(card.textContent).not.toContain("NaN");
  });

  it("preserves the capped-deficit copy", async () => {
    await renderCard(1, 15000, 0);
    expect(
      within(screen.getByTestId("net-cashflow-card")).getByText(
        plSpending.whereIAm.overspentCapped,
      ),
    ).toBeVisible();
  });

  it("preserves the surplus and saved-zero behavior", async () => {
    await renderCard(20000, 15000, 0);
    const card = screen.getByTestId("net-cashflow-card");
    expect(within(card).getByText("Pozostało 25%")).toBeVisible();
    expect(within(card).getAllByTestId("net-cashflow-row")).toHaveLength(2);
  });

  it("retains privacy masking without removing labels or alignment", async () => {
    vi.stubGlobal("localStorage", { getItem: () => "true" });
    await renderCard();
    const card = screen.getByTestId("net-cashflow-card");
    expect(within(card).getAllByText("••••")).toHaveLength(4);
    expect(within(card).getByText("Zaoszczędzono")).toBeVisible();
    expect(card.textContent).not.toContain("345,67");
  });

  it("keeps loading placeholders instead of exposing synthetic zero totals", async () => {
    await renderCard(12345.67, 15000, 2000, true);
    expect(screen.queryByTestId("net-cashflow-card")).not.toBeInTheDocument();
    expect(screen.queryByTestId("net-cashflow-row")).not.toBeInTheDocument();
  });
});
