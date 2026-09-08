import { render, screen } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { DeleteTransactionsDialog } from "./delete-transactions-dialog";

vi.mock("@/hooks/use-balance-privacy", () => ({
  useBalancePrivacy: () => ({ isBalanceHidden: false }),
}));

describe("DeleteTransactionsDialog approval", () => {
  it("blocks confirmation while the captured bulk selection is unavailable or changed", async () => {
    const onConfirm = vi.fn();
    render(
      <DeleteTransactionsDialog
        open
        count={127}
        canConfirm={false}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Selection changed or is still loading.");
    const confirm = screen.getByRole("button", { name: "Delete" });
    expect(confirm).toBeDisabled();
    await userEvent.click(confirm);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
  });

  it("keeps a single-row confirmation usable without any bulk snapshot", async () => {
    const onConfirm = vi.fn();
    render(
      <DeleteTransactionsDialog
        open
        count={1}
        preview={{ activityType: "WITHDRAWAL", amount: "0", currency: "CAD" }}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });
});
