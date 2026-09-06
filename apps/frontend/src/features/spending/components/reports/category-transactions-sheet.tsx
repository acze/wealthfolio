import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import { TruncatedText } from "@/components/truncated-text";
import { useAccounts } from "@/hooks/use-accounts";
import type { Account, TaxonomyCategory } from "@/lib/types";
import { cn, formatDate } from "@/lib/utils";
import {
  Button,
  Icons,
  PrivacyAmount,
  Sheet,
  SheetContent,
  SheetTitle,
  Skeleton,
  useDateFormatting,
  type FormattingApi,
} from "@wealthfolio/ui";

import { useCashActivityAnalysis } from "../../hooks/use-cash-activity-analysis";
import { useCashActivitySearch } from "../../hooks/use-cash-activity-search";
import { expandCategoryIds } from "../../lib/category-rollup";
import { buildCashflowUrl } from "../../lib/navigation";
import {
  calendarDaysBetweenInclusive,
  formatZonedDateKey,
  getZonedDateParts,
} from "../../lib/timezone";
import { CategoryIcon } from "../category-chips";
import { AnalysisTotalsReadout } from "../transactions-analysis-bar";

interface CategoryTransactionsSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The category that was clicked. Null while the sheet is closed. */
  category: TaxonomyCategory | null;
  taxonomyCategories: TaxonomyCategory[];
  rangeStart: Date;
  rangeEnd: Date;
  currency: string;
  accountIds?: string[];
  timezone?: string;
}

/**
 * Drill-down drawer listing cash activities for a category in the active
 * insight range. Header totals cover the complete server-filtered category
 * subtree, independently of how many transaction pages have been loaded.
 *
 * When to use this vs. navigating to `/activities?tab=spending&category=…`:
 *
 *   • In-context analysis surfaces (Insights stages, category breakdown
 *     tables, sparkline grids on the insights page) → **use this sheet**.
 *     The user is mid-narrative; staying in context preserves the period,
 *     comparison, and other settings they're examining.
 *
 *   • Cross-page summary widgets (the dashboard Spending tab's treemap,
 *     ranked bar, group blocks; the budget chart's category rings) →
 *     **navigate to /activities**. The user clicked a summary number to
 *     drill *out* for bulk edits, deletions, or full-transaction filters.
 *
 * If you find a third pattern emerging, decide which bucket above it falls
 * into rather than introducing a third primitive.
 */
export function CategoryTransactionsSheet({
  open,
  onOpenChange,
  category,
  taxonomyCategories,
  rangeStart,
  rangeEnd,
  currency,
  accountIds,
  timezone,
}: CategoryTransactionsSheetProps) {
  const dateFormatting = useDateFormatting();

  const { t } = useTranslation();

  const ids = useMemo(
    () =>
      expandCategoryIds(
        category ? [category.id] : [],
        new Map(taxonomyCategories.map((c) => [c.id, c])),
      ),
    [category, taxonomyCategories],
  );

  const startIso = rangeStart.toISOString();
  // The report already supplies inclusive boundaries in the app timezone.
  const endIso = rangeEnd.toISOString();
  const days = calendarDaysBetweenInclusive(
    getZonedDateParts(rangeStart, timezone),
    getZonedDateParts(rangeEnd, timezone),
  );

  const searchRequest = useMemo(
    () => ({
      categoryIds: ids,
      accountIds,
      startDate: startIso,
      endDate: endIso,
      sortBy: "date" as const,
      sortDir: "desc" as const,
    }),
    [ids, accountIds, startIso, endIso],
  );

  const enabled = open && ids.length > 0;
  const analysis = useCashActivityAnalysis(searchRequest, { mode: "all", ids: [] }, enabled);
  const {
    items,
    totalCount,
    isLoading,
    isFetching,
    isError,
    error,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
  } = useCashActivitySearch(searchRequest, { enabled });

  const { accounts = [] } = useAccounts({ filterActive: false });
  const accountById = useMemo(() => {
    const m = new Map<string, Account>();
    accounts.forEach((a) => m.set(a.id, a));
    return m;
  }, [accounts]);

  const transactionsLink = buildCashflowUrl({
    analysis: true,
    categoryId: category?.parentId ? undefined : category?.id,
    subcategoryId: category?.parentId ? category.id : undefined,
    startDate: formatZonedDateKey(rangeStart, timezone),
    endDate: formatZonedDateKey(rangeEnd, timezone),
    accountIds,
  });

  const accent = category?.color ?? "var(--muted-foreground)";
  const tintBg = category?.color ? `${category.color}24` : "var(--muted)";
  // Strong-at-top, fade-to-transparent — gives the header the warm "drill-down"
  // panel feel from the inspiration. Falls back to a neutral muted wash so the
  // anatomy is visible even when a category has no color set.
  const headerFill = category?.color ? `${category.color}40` : "rgba(120,120,120,0.18)";
  const headerFillMid = category?.color ? `${category.color}1A` : "rgba(120,120,120,0.06)";

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        className="flex w-full flex-col gap-0 p-0 sm:max-w-lg"
        // SheetContent injects an inline paddingTop (safe-area + 1.5rem) that a
        // className can't override. Zero it here and reapply safe-area inside
        // the header so the gradient runs edge-to-edge from the very top.
        style={{ paddingTop: 0 }}
      >
        {/* ── Header ─────────────────────────────────────────────────── */}
        <header
          className="border-border/60 relative border-b px-6 pb-5"
          style={{
            paddingTop: "calc(env(safe-area-inset-top, 0px) + 1.5rem)",
            backgroundImage: `linear-gradient(to bottom, ${headerFill} 0%, ${headerFillMid} 55%, transparent 100%)`,
          }}
        >
          <div className="text-muted-foreground/80 text-[10px] font-semibold uppercase tracking-[0.14em]">
            {t("spending:categorySheet.eyebrow")}
          </div>
          <div className="mt-2 flex items-start gap-3">
            <span
              className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg"
              style={{ backgroundColor: tintBg, color: accent }}
            >
              <CategoryIcon
                icon={category?.icon ?? null}
                fallback={category?.name ?? "?"}
                className="h-5 w-5"
              />
            </span>
            <div className="min-w-0 flex-1">
              <SheetTitle className="text-foreground truncate text-2xl font-semibold tracking-tight">
                {category?.name ?? t("spending:categorySheet.categoryFallback")}
              </SheetTitle>
              <p className="text-muted-foreground mt-0.5 text-xs">
                {formatRangeLabel(rangeStart, rangeEnd, dateFormatting, timezone)} ·{" "}
                {t("spending:categorySheet.daysCount", { count: days })}
              </p>
            </div>
          </div>

          <div className="mt-5" role="status" aria-live="polite" aria-busy={analysis.isFetching}>
            {analysis.isPending || analysis.isFetching ? (
              <div className="space-y-2">
                <span className="text-muted-foreground text-xs">
                  {t("spending:categorySheet.loading")}
                </span>
                <Skeleton className="h-20 w-full" />
              </div>
            ) : analysis.isError || !analysis.data ? (
              <p className="text-destructive text-sm">{t("spending:analysis.error")}</p>
            ) : (
              <AnalysisTotalsReadout totals={analysis.data.matching} />
            )}
          </div>
        </header>

        {/* ── Body ───────────────────────────────────────────────────── */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {/* Transactions list */}
          <section>
            <div className="mb-3 flex items-baseline justify-between">
              <h3 className="text-foreground text-sm font-semibold">
                {t("spending:categorySheet.transactions")}
              </h3>
              <span className="text-muted-foreground text-[11px] tabular-nums">
                {isLoading || (isFetching && !isFetchingNextPage)
                  ? t("spending:categorySheet.loading")
                  : !isError && t("spending:categorySheet.totalCount", { count: totalCount })}
              </span>
            </div>

            {isLoading ? (
              <div className="space-y-2">
                {Array.from({ length: 6 }).map((_, i) => (
                  <Skeleton key={i} className="h-14 w-full rounded-xl" />
                ))}
              </div>
            ) : isError ? (
              <div className="text-destructive border-border/60 flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed py-10 text-center text-sm">
                <Icons.AlertTriangle className="h-6 w-6 opacity-70" aria-hidden />
                <div>{error?.message ?? t("spending:categorySheet.loadError")}</div>
              </div>
            ) : items.length === 0 ? (
              <div className="text-muted-foreground border-border/60 flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed py-10 text-center text-sm">
                <Icons.Activity className="h-6 w-6 opacity-50" aria-hidden />
                <div>{t("spending:categorySheet.noTransactions")}</div>
              </div>
            ) : (
              <ul className="divide-border/40 divide-y">
                {items.map((it) => {
                  const account = accountById.get(it.accountId);
                  return (
                    <li
                      key={it.id}
                      className="hover:bg-muted/30 flex items-center gap-2.5 px-1 py-2 transition-colors"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="text-foreground text-[13px] font-medium leading-tight">
                          {it.notes != null ? (
                            <TruncatedText text={it.notes} />
                          ) : (
                            <span className="text-muted-foreground italic">
                              {it.activityType.toLowerCase()}
                            </span>
                          )}
                        </div>
                        <div className="text-muted-foreground/80 mt-0.5 flex items-center gap-1 text-[10px] leading-tight">
                          <span>{formatDate(it.activityDate, dateFormatting)}</span>
                          <span aria-hidden>·</span>
                          <span className="truncate">{account?.name ?? it.accountId}</span>
                        </div>
                      </div>
                      <div
                        className={cn(
                          "shrink-0 text-right text-[13px] font-semibold tabular-nums leading-tight",
                          it.netAmount > 0 ? "text-success" : "text-foreground",
                        )}
                      >
                        <PrivacyAmount value={it.netAmount} currency={it.currency} />
                        {it.currency !== currency && (
                          <span className="text-muted-foreground/70 ml-1 text-[9px] uppercase tracking-wide">
                            {it.currency}
                          </span>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}

            {hasNextPage && (
              <div className="mt-3 flex items-center justify-center">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => fetchNextPage()}
                  disabled={isFetchingNextPage}
                >
                  {isFetchingNextPage ? (
                    <>
                      <Icons.Spinner className="mr-2 h-3.5 w-3.5 animate-spin" aria-hidden />
                      {t("spending:categorySheet.loading")}
                    </>
                  ) : (
                    t("spending:categorySheet.loadMore", {
                      count: Math.min(50, totalCount - items.length),
                    })
                  )}
                </Button>
              </div>
            )}
          </section>
        </div>

        {/* ── Footer ─────────────────────────────────────────────────── */}
        <div className="border-border/60 bg-background/70 border-t px-6 py-3 backdrop-blur">
          <Button asChild size="sm" className="w-full">
            <Link to={transactionsLink} onClick={() => onOpenChange(false)}>
              {t("spending:categorySheet.openInTransactions")}
              <Icons.ArrowRight className="ml-1.5 h-3.5 w-3.5" aria-hidden />
            </Link>
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function formatRangeLabel(
  start: Date,
  end: Date,
  formatting: Pick<FormattingApi, "formatCalendarDate">,
  timezone?: string,
): string {
  const startParts = getZonedDateParts(start, timezone);
  const endParts = getZonedDateParts(end, timezone);
  const sameYear = startParts.year === endParts.year;
  const options = { month: "short", day: "numeric" } as const;
  const startStr = formatting.formatCalendarDate(startParts, options);
  const endStr = formatting.formatCalendarDate(endParts, options);
  const yearStr = sameYear
    ? `, ${formatting.formatCalendarDate(endParts, { year: "numeric" })}`
    : "";
  return `${startStr} – ${endStr}${yearStr}`;
}
