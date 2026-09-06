import { SAVINGS_ROW_ID } from "./category-rollup";

/** Build a spending-transactions URL preserving category, date, and account context. */
export function buildCashflowUrl(opts: {
  categoryId?: string | null;
  subcategoryId?: string | null;
  accountIds?: string[];
  analysis?: boolean;
  status?: string;
  startDate?: string;
  endDate?: string;
}): string {
  const params = new URLSearchParams();
  params.set("tab", "spending");
  if (opts.analysis) params.set("analysis", "true");
  if (opts.categoryId) params.set("category", opts.categoryId);
  if (opts.subcategoryId) params.set("subcategory", opts.subcategoryId);
  if (opts.status) params.set("status", opts.status);
  if (opts.startDate) params.set("from", opts.startDate);
  if (opts.endDate) params.set("to", opts.endDate);
  if (opts.accountIds?.length) {
    params.set("accounts", Array.from(new Set(opts.accountIds)).sort().join(","));
  }
  return `/activities?${params.toString()}`;
}

/**
 * Deep-link for a "Where it went" node. The synthetic uncategorized bucket has
 * no real category id, so it routes to the status filter — the category filter
 * would match nothing and render an empty list. The savings row links to the
 * insights cashflow view, which carries its own period params, so `startDate`/
 * `endDate` (ISO YYYY-MM-DD) only apply to the /activities branches.
 */
export function spendingActivityHref(
  id: string,
  opts: {
    savingsHref?: string;
    startDate?: string;
    endDate?: string;
    accountIds?: string[];
    analysis?: boolean;
  } = {},
): string {
  const { savingsHref, startDate, endDate, accountIds, analysis } = opts;
  if (id === SAVINGS_ROW_ID) return savingsHref ?? buildCashflowUrl({});
  return id === "__uncategorized__"
    ? buildCashflowUrl({ status: "uncategorized", startDate, endDate, accountIds, analysis })
    : buildCashflowUrl({ categoryId: id, startDate, endDate, accountIds, analysis });
}
