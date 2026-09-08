import { render, screen } from "@/test/render";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { TransactionsBulkBar } from "./transactions-bulk-bar";

vi.mock("./quick-categorize-popover", () => ({
  QuickCategorizePopover: ({ trigger }: { trigger: ReactNode }) => trigger,
}));
vi.mock("./quick-event-popover", () => ({
  QuickEventPopover: ({ trigger }: { trigger: ReactNode }) => trigger,
}));

function props() {
  return {
    selectedCount: 1500,
    categoryScope: null,
    onCategorize: vi.fn(),
    onTagEvent: vi.fn(),
    onDelete: vi.fn(),
    onClearSelection: vi.fn(),
    onRetrySelection: vi.fn(),
  };
}

describe("TransactionsBulkBar selection preparation", () => {
  it.each(["pending", "error"] as const)(
    "does not offer mutations or stale counts while %s",
    async (selectionStatus) => {
      const p = props();
      render(<TransactionsBulkBar {...p} selectionStatus={selectionStatus} />);
      expect(screen.queryByText("1500 selected")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Categorize" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Tag event" })).not.toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Clear" }));
      expect(p.onClearSelection).toHaveBeenCalledOnce();
      expect(p.onDelete).not.toHaveBeenCalled();
      expect(p.onCategorize).not.toHaveBeenCalled();
      expect(p.onTagEvent).not.toHaveBeenCalled();
    },
  );

  it("offers retry after a read error without changing the selection", async () => {
    const p = props();
    render(<TransactionsBulkBar {...p} selectionStatus="error" />);
    expect(screen.getByText(/Your selection is preserved/)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(p.onRetrySelection).toHaveBeenCalledOnce();
    expect(p.onClearSelection).not.toHaveBeenCalled();
    expect(p.onDelete).not.toHaveBeenCalled();
  });

  it("reports the resolved count and unseen-page scope before explicit actions", async () => {
    const p = props();
    render(<TransactionsBulkBar {...p} includesOtherPages />);
    expect(screen.getByText("1500 selected")).toBeVisible();
    expect(screen.getByText("Includes selected transactions on other pages.")).toBeVisible();
    expect(p.onDelete).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(p.onDelete).toHaveBeenCalledOnce();
  });

  it.each([1000, 1001])("respects the atomic categorization boundary at %s rows", (count) => {
    render(<TransactionsBulkBar {...props()} selectedCount={count} categoryScope="expense" />);
    const categorize = screen.getByRole("button", { name: "Categorize" });
    if (count === 1000) {
      expect(categorize).toBeEnabled();
    } else {
      expect(categorize).toBeDisabled();
      expect(screen.getByText(/Categorize up to 1000 transactions at once/)).toBeVisible();
    }
    expect(screen.getByText(`${count} selected`)).toBeVisible();
    expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Tag event" })).toBeEnabled();
  });
});
