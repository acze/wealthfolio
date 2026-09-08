import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Cell } from "@tanstack/react-table";
import {
  ActionConfirm,
  BudgetGaugeCard,
  CurrencyInput,
  DataTable,
  DeleteConfirm,
  ErrorBoundary,
  FacetedSearchInput,
  FormattingProvider,
  getLocalizedCurrencyOptions,
  ProgressIndicator,
  quoteCurrencies,
  ResponsiveSelect,
  SearchableSelect,
  worldCurrencies,
} from "@wealthfolio/ui";
import { CurrencyCell } from "@wealthfolio/ui/components/data-grid/data-grid-cell-variants";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import enUi from "./locales/en/ui.json";
import frUi from "./locales/fr/ui.json";
import plUi from "./locales/pl/ui.json";

const originalScrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");

beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});

afterAll(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (originalScrollIntoView) {
    Object.defineProperty(Element.prototype, "scrollIntoView", originalScrollIntoView);
  } else {
    Reflect.deleteProperty(Element.prototype, "scrollIntoView");
  }
});

async function createI18n(language = "fr") {
  const i18n = i18next.createInstance();
  await i18n.init({
    lng: language,
    fallbackLng: false,
    resources: { en: { ui: enUi }, fr: { ui: frUi }, pl: { ui: plUi } },
    interpolation: { escapeValue: false },
  });
  return i18n;
}

describe.each(["en", "fr", "pl"])("shared UI defaults (%s)", (language) => {
  it("translates searchable-select defaults and reacts to language changes", async () => {
    const user = userEvent.setup();
    const i18n = await createI18n(language);
    render(
      <I18nextProvider i18n={i18n}>
        <SearchableSelect options={[]} onValueChange={vi.fn()} />
      </I18nextProvider>,
    );

    expect(screen.getByRole("combobox")).toHaveTextContent(i18n.t("ui:select.placeholder"));
    await user.click(screen.getByRole("combobox"));
    expect(screen.getByPlaceholderText(i18n.t("ui:dataGrid.search"))).toBeInTheDocument();
    expect(screen.getByText(i18n.t("ui:faceted.noResults"))).toBeInTheDocument();

    await act(() => i18n.changeLanguage(language === "en" ? "fr" : "en"));
    expect(screen.getByText(i18n.t("ui:select.placeholder"))).toBeInTheDocument();
    expect(screen.getByPlaceholderText(i18n.t("ui:dataGrid.search"))).toBeInTheDocument();
  });

  it.each(["mobile", "desktop"] as const)(
    "translates the %s select placeholder",
    async (displayMode) => {
      const user = userEvent.setup();
      const i18n = await createI18n(language);
      render(
        <I18nextProvider i18n={i18n}>
          <ResponsiveSelect options={[]} displayMode={displayMode} sheetDescription="Options" />
        </I18nextProvider>,
      );

      const trigger = screen.getByRole(displayMode === "mobile" ? "button" : "combobox");
      expect(trigger).toHaveTextContent(i18n.t("ui:select.placeholder"));
      if (displayMode === "mobile") {
        await user.click(trigger);
        expect(
          screen.getByRole("heading", { name: i18n.t("ui:select.title") }),
        ).toBeInTheDocument();
        expect(screen.getByText(i18n.t("ui:search.noOptions"))).toBeInTheDocument();
      }
    },
  );

  it.each(["mobile", "desktop"] as const)(
    "translates the %s currency picker without changing codes",
    async (displayMode) => {
      const user = userEvent.setup();
      const i18n = await createI18n(language);
      const onChange = vi.fn();
      render(
        <I18nextProvider i18n={i18n}>
          <CurrencyInput onChange={onChange} displayMode={displayMode} />
        </I18nextProvider>,
      );

      expect(screen.getByRole("combobox")).toHaveTextContent(i18n.t("ui:currency.placeholder"));
      await user.click(screen.getByRole("combobox"));
      if (displayMode === "mobile") {
        expect(
          screen.getByRole("heading", { name: i18n.t("ui:currency.popular") }),
        ).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "USD" }));
      } else {
        await user.click(screen.getByRole("option", { name: /USD/ }));
      }
      expect(onChange).toHaveBeenCalledWith("USD");
    },
  );

  it("translates confirmation actions and their pending text", async () => {
    const user = userEvent.setup();
    const i18n = await createI18n(language);
    const content = (pending: boolean) => (
      <I18nextProvider i18n={i18n}>
        <ActionConfirm
          confirmTitle="Action"
          confirmMessage="Message"
          handleConfirm={vi.fn()}
          isPending={pending}
        />
      </I18nextProvider>
    );
    const { rerender } = render(content(false));
    await user.click(screen.getByRole("button", { name: "Action" }));
    expect(screen.getByRole("button", { name: i18n.t("ui:dialog.confirm") })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: i18n.t("ui:dialog.cancel") })).toBeInTheDocument();
    rerender(content(true));
    expect(screen.getByRole("button", { name: i18n.t("ui:dialog.pending") })).toBeDisabled();
  });

  it("translates delete confirmation and its pending state", async () => {
    const user = userEvent.setup();
    const i18n = await createI18n(language);
    const content = (pending: boolean) => (
      <I18nextProvider i18n={i18n}>
        <DeleteConfirm
          deleteConfirmTitle="Remove"
          deleteConfirmMessage="Message"
          handleDeleteConfirm={vi.fn()}
          isPending={pending}
        />
      </I18nextProvider>
    );
    const { rerender } = render(content(false));
    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(screen.getByRole("button", { name: i18n.t("ui:dialog.delete") })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: i18n.t("ui:dialog.cancel") })).toBeInTheDocument();
    rerender(content(true));
    expect(screen.getByRole("button", { name: i18n.t("ui:dataGrid.deleting") })).toBeDisabled();
  });

  it("translates table empty states and search placeholders", async () => {
    const i18n = await createI18n(language);
    render(
      <I18nextProvider i18n={i18n}>
        <DataTable columns={[{ accessorKey: "name", header: "Name" }]} data={[]} searchBy="name" />
        <FacetedSearchInput value="" onChange={vi.fn()} />
      </I18nextProvider>,
    );
    expect(screen.getByText(i18n.t("ui:faceted.noResults"))).toBeInTheDocument();
    expect(screen.getAllByPlaceholderText(i18n.t("ui:dataTable.search"))).toHaveLength(2);
  });

  it("translates progress defaults in dialogs", async () => {
    const i18n = await createI18n(language);
    render(
      <I18nextProvider i18n={i18n}>
        <ProgressIndicator open isLoading={false} />
      </I18nextProvider>,
    );
    expect(screen.getByRole("dialog", { name: i18n.t("ui:progress.title") })).toBeInTheDocument();
    expect(screen.getByText(i18n.t("ui:progress.message"))).toBeInTheDocument();
    expect(screen.getAllByText(i18n.t("ui:progress.description"))).toHaveLength(2);
  });

  it.each([
    [25, "used", 25],
    [95, "onTrack", 95],
    [115, "overBudget", 15],
    [125, "overBudget", 25],
  ] as const)(
    "translates budget status at %s percent without changing thresholds",
    async (percentUsed, key, percent) => {
      const i18n = await createI18n(language);
      render(
        <I18nextProvider i18n={i18n}>
          <BudgetGaugeCard
            categoryName="Category"
            actual={percentUsed}
            budgeted={100}
            percentUsed={percentUsed}
            currency="USD"
          />
        </I18nextProvider>,
      );
      expect(screen.getByText(i18n.t(`ui:budget.${key}`, { percent }))).toBeInTheDocument();
    },
  );

  it("translates error-boundary controls while keeping diagnostic messages intact", async () => {
    const user = userEvent.setup();
    const i18n = await createI18n(language);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    function BrokenComponent(): never {
      throw new Error("Diagnostic detail");
    }
    render(
      <I18nextProvider i18n={i18n}>
        <ErrorBoundary>
          <BrokenComponent />
        </ErrorBoundary>
      </I18nextProvider>,
    );
    expect(
      screen.getByRole("heading", { name: i18n.t("ui:errorBoundary.title") }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: i18n.t("ui:errorBoundary.showDetails") }));
    expect(screen.getByText(/Diagnostic detail/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: i18n.t("ui:errorBoundary.hideDetails") }),
    ).toBeInTheDocument();
    log.mockRestore();
  });
});

it("uses Polish table and filter copy without English fallbacks", async () => {
  const i18n = await createI18n("pl");
  render(
    <I18nextProvider i18n={i18n}>
      <DataTable columns={[{ accessorKey: "name", header: "Nazwa" }]} data={[]} searchBy="name" />
      <FacetedSearchInput value="Akcje" onChange={vi.fn()} />
    </I18nextProvider>,
  );
  expect(screen.getByText("Nie znaleziono wyników.")).toBeInTheDocument();
  expect(screen.getAllByPlaceholderText("Szukaj ...")).toHaveLength(2);
  expect(screen.getByRole("button", { name: plUi.search.clear })).toBeInTheDocument();
  expect(screen.queryByText("No results found.")).not.toBeInTheDocument();
});

it("preserves custom confirmation labels and pending text", async () => {
  const user = userEvent.setup();
  const i18n = await createI18n();
  const content = (pending: boolean) => (
    <I18nextProvider i18n={i18n}>
      <ActionConfirm
        confirmTitle="Action"
        confirmMessage="Message"
        handleConfirm={vi.fn()}
        isPending={pending}
        confirmButtonText="Proceed"
        cancelButtonText="Back"
        pendingText="Working"
      />
    </I18nextProvider>
  );
  const { rerender } = render(content(false));
  await user.click(screen.getByRole("button", { name: "Action" }));
  expect(screen.getByRole("button", { name: "Proceed" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Back" })).toBeInTheDocument();
  rerender(content(true));
  expect(screen.getByRole("button", { name: "Working" })).toBeDisabled();
});

it("preserves caller-provided text, including intentionally empty descriptions", async () => {
  const user = userEvent.setup();
  const i18n = await createI18n();
  render(
    <I18nextProvider i18n={i18n}>
      <SearchableSelect
        options={[]}
        onValueChange={vi.fn()}
        placeholder="Choose"
        searchPlaceholder="Find"
        emptyMessage="Empty"
      />
      <FacetedSearchInput value="" onChange={vi.fn()} placeholder="Filter" />
      <ProgressIndicator message="Working" description="" isLoading={false} />
      <CurrencyInput onChange={vi.fn()} placeholder="Currency" displayMode="desktop" />
      <ResponsiveSelect options={[]} placeholder="Option" displayMode="desktop" />
    </I18nextProvider>,
  );
  expect(screen.getByPlaceholderText("Filter")).toBeInTheDocument();
  expect(screen.getByText("Currency")).toBeInTheDocument();
  expect(screen.getByText("Option")).toBeInTheDocument();
  expect(screen.getByText("Working")).toBeInTheDocument();
  expect(screen.queryByText(i18n.t("ui:progress.description"))).not.toBeInTheDocument();
  await user.click(screen.getByText("Choose"));
  expect(screen.getByPlaceholderText("Find")).toBeInTheDocument();
  expect(screen.getByText("Empty")).toBeInTheDocument();
});

describe("localized currency names", () => {
  it("localizes names without mutating options, codes, or metadata", () => {
    const options = [
      { value: "USD", label: "United States dollar (USD)", amount: "1234.5678" },
      { value: "GBP", label: "British pound (GBP)", amount: "90.12" },
    ];
    const original = structuredClone(options);

    expect(getLocalizedCurrencyOptions(options, "pl")).toEqual([
      { value: "USD", label: "dolar amerykański (USD)", amount: "1234.5678" },
      { value: "GBP", label: "funt szterling (GBP)", amount: "90.12" },
    ]);
    expect(options).toEqual(original);
    expect(getLocalizedCurrencyOptions(options, "en-US")).toEqual(original);
    expect(() => getLocalizedCurrencyOptions(options, "invalid_locale")).toThrow(RangeError);
  });

  it("preserves quote-unit and custom labels rather than interpreting GBp as GBP", () => {
    const custom = { value: "Private-token", label: "Private token" };
    const lowercase = { value: "usd", label: "Custom lowercase code" };
    const options = [...quoteCurrencies, custom, lowercase];
    const localized = getLocalizedCurrencyOptions(options, "pl");

    expect(localized.map(({ value }) => value)).toEqual(options.map(({ value }) => value));
    expect(localized.find(({ value }) => value === "GBP")?.label).toBe("funt szterling (GBP)");
    for (const code of ["GBp", "GBX", "ZAc", "USX", "Private-token", "usd"]) {
      expect(localized.find(({ value }) => value === code)).toBe(
        options.find(({ value }) => value === code),
      );
    }
  });

  it("updates the selected display label with the UI language, not the formatting region", async () => {
    const i18n = await createI18n("en");
    render(
      <I18nextProvider i18n={i18n}>
        <FormattingProvider locale="de-DE" uiLocale="en">
          <CurrencyInput value="USD" onChange={vi.fn()} displayMode="desktop" />
        </FormattingProvider>
      </I18nextProvider>,
    );
    expect(screen.getByRole("combobox")).toHaveTextContent(
      worldCurrencies.find(({ value }) => value === "USD")!.label,
    );

    await act(() => i18n.changeLanguage("pl"));
    expect(screen.getByRole("combobox")).toHaveTextContent("dolar amerykański (USD)");
    await act(() => i18n.changeLanguage("fr"));
    expect(screen.getByRole("combobox")).toHaveTextContent("dollar des États-Unis (USD)");
  });

  it.each(["mobile", "desktop"] as const)(
    "searches localized names in the %s picker and returns unchanged ISO codes",
    async (displayMode) => {
      const user = userEvent.setup();
      const i18n = await createI18n("pl");
      const onChange = vi.fn();
      render(
        <I18nextProvider i18n={i18n}>
          <FormattingProvider locale="en-US" uiLocale="pl">
            <CurrencyInput value="USD" onChange={onChange} displayMode={displayMode} />
          </FormattingProvider>
        </I18nextProvider>,
      );
      await user.click(screen.getByRole("combobox"));
      const input = screen.getByPlaceholderText(
        i18n.t(displayMode === "mobile" ? "ui:currency.searchAll" : "ui:currency.search"),
      );
      await user.type(input, "złoty");
      expect(screen.getByText("złoty polski (PLN)")).toBeInTheDocument();
      await user.click(screen.getByText("złoty polski (PLN)"));
      expect(onChange).toHaveBeenCalledWith("PLN");
    },
  );

  it.each(["PLN", "GBp"])("keeps %s intact when selecting a currency in the grid", async (code) => {
    const user = userEvent.setup();
    const i18n = await createI18n("pl");
    const onDataUpdate = vi.fn();
    const cell = {
      getValue: () => "USD",
      column: { columnDef: { meta: { cell: { variant: "currency" } } } },
      row: { original: { currency: "USD" } },
    } as unknown as Cell<{ currency: string }, unknown>;
    render(
      <I18nextProvider i18n={i18n}>
        <FormattingProvider locale="en-US" uiLocale="pl">
          <CurrencyCell
            cell={cell}
            tableMeta={{ onDataUpdate }}
            rowIndex={0}
            columnId="currency"
            rowHeight="short"
            isEditing
            isFocused
            isSelected={false}
            isSearchMatch={false}
            isActiveSearchMatch={false}
            readOnly={false}
          />
        </FormattingProvider>
      </I18nextProvider>,
    );
    await user.type(
      screen.getByPlaceholderText(i18n.t("ui:dataGrid.searchCurrency")),
      code === "PLN" ? "złoty" : code,
    );
    await user.click(
      screen.getByText(code === "PLN" ? "złoty polski (PLN)" : "British pence (GBp)"),
    );
    expect(onDataUpdate).toHaveBeenCalledWith({ rowIndex: 0, columnId: "currency", value: code });
  });
});
