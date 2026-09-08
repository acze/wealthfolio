import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { render } from "@/test/render";
import { BudgetGaugeCard, SwipableView, useDataGrid } from "@wealthfolio/ui";
import type { ColumnDef } from "@tanstack/react-table";
import i18next from "i18next";
import { getI18n, I18nextProvider, setI18n } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import plUi from "./locales/pl/ui.json";

const mocks = vi.hoisted(() => ({
  toastError: vi.fn(),
  dataChange: vi.fn(),
  ref: vi.fn(),
  carousel: {
    selectedScrollSnap: () => 0,
    scrollSnapList: () => [0, 0.5, 1],
    on: vi.fn(),
    off: vi.fn(),
    scrollTo: vi.fn(),
  },
}));

// This dependency belongs to the UI workspace, not the frontend workspace.
vi.mock("../../../../packages/ui/node_modules/embla-carousel-react", () => ({
  default: () => [mocks.ref, mocks.carousel],
}));
vi.mock("sonner", async (importOriginal) => {
  const original = await importOriginal<typeof import("sonner")>();
  return { ...original, toast: { ...original.toast, error: mocks.toastError } };
});

const registered = getI18n();
const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");

beforeEach(() => {
  vi.clearAllMocks();
  // Exercise the real registry-empty notReadyT, not a mock or an initialized empty provider.
  Reflect.apply(setI18n, undefined, [undefined]);
  expect(getI18n()).toBeUndefined();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    },
  );
});

afterEach(() => {
  cleanup();
  setI18n(registered);
  vi.unstubAllGlobals();
  if (clipboardDescriptor) Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
  else Reflect.deleteProperty(navigator, "clipboard");
});

const items = [
  { name: "", content: <div>First</div> },
  { name: "Holdings", content: <div>Second</div> },
  { name: "", content: <div>Third</div> },
];
const rows = [{ amount: "1" }];
const columns: ColumnDef<{ amount: string }>[] = [
  { accessorKey: "amount", meta: { cell: { variant: "number", valueType: "string" } } },
];

function InvalidPasteGrid() {
  const grid = useDataGrid({
    data: rows,
    columns,
    enablePaste: true,
    onDataChange: mocks.dataChange,
  });
  return (
    <>
      <button onClick={() => grid.tableMeta?.onCellClick?.(0, "amount")}>Focus cell</button>
      <div ref={grid.dataGridRef} data-testid="invalid-paste-grid" />
    </>
  );
}

async function pasteInvalidNumber() {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { readText: vi.fn().mockResolvedValue("not-a-number") },
  });
  fireEvent.click(screen.getByRole("button", { name: "Focus cell" }));
  fireEvent.keyDown(screen.getByTestId("invalid-paste-grid"), { key: "v", ctrlKey: true });
  await waitFor(() => expect(mocks.toastError).toHaveBeenCalled());
}

describe("shared UI without a registered i18next instance", () => {
  it.each([
    [25, "25% used"],
    [95, "On track"],
    [115, "15% over budget"],
    [125, "25% over budget"],
  ] as const)(
    "renders a complete English budget fallback at %s percent",
    (percentUsed, expected) => {
      render(
        <BudgetGaugeCard
          categoryName="Synthetic"
          actual={25}
          budgeted={100}
          percentUsed={percentUsed}
          currency="USD"
        />,
      );
      expect(screen.getByText(expected)).toBeVisible();
      expect(screen.queryByText(/\{\{/)).not.toBeInTheDocument();
      expect(getI18n()).toBeUndefined();
    },
  );

  it("renders named and numbered carousel fallbacks without template tokens", () => {
    render(<SwipableView items={items} displayToggle />);
    expect(screen.getByRole("status")).toHaveTextContent("View 1");
    expect(screen.getByRole("button", { name: "Go to Holdings" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Go to view 3" })).toBeVisible();
    expect(getI18n()).toBeUndefined();
  });

  it("formats the newly localized paste-skip fallback without an instance", async () => {
    render(<InvalidPasteGrid />);
    await pasteInvalidNumber();
    expect(mocks.toastError).toHaveBeenCalledWith("Cells skipped due to invalid data: 1");
    expect(getI18n()).toBeUndefined();
  });

  it("retains Polish interpolation through a provider without initializing the global registry", async () => {
    const instance = i18next.createInstance();
    await instance.init({
      lng: "pl",
      fallbackLng: false,
      resources: { pl: { ui: plUi } },
      interpolation: { escapeValue: false },
    });
    render(
      <I18nextProvider i18n={instance}>
        <BudgetGaugeCard
          categoryName="Synthetic"
          actual={25}
          budgeted={100}
          percentUsed={125}
          currency="USD"
        />
        <SwipableView items={items} displayToggle />
        <InvalidPasteGrid />
      </I18nextProvider>,
    );
    expect(screen.getByText("25% ponad budżet")).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("Widok 1");
    expect(screen.getByRole("button", { name: "Przejdź do Holdings" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Przejdź do widoku 3" })).toBeVisible();
    await pasteInvalidNumber();
    expect(mocks.toastError).toHaveBeenCalledWith(
      "Komórki pominięte z powodu nieprawidłowych danych: 1",
    );
    expect(getI18n()).toBeUndefined();
  });
});
