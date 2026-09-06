import { useTranslation } from "react-i18next";

import {
  Button,
  Skeleton,
  useAmountFormatting,
  useBalancePrivacy,
  useNumberFormatting,
} from "@wealthfolio/ui";

import type {
  AnalysisTotals,
  CashActivityAnalysis,
  ExactMoneySummary,
} from "../types/cash-activity";

function ExactMoneyReadout({ summary }: { summary: ExactMoneySummary }) {
  const { t } = useTranslation();
  const { formatAmount } = useAmountFormatting();
  const { formatDecimal } = useNumberFormatting();
  const { isBalanceHidden } = useBalancePrivacy();
  const amounts = summary.converted ? [summary.converted] : summary.byCurrency;
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap gap-x-2 font-semibold tabular-nums">
        {amounts.length === 0 ? (
          <span>
            {isBalanceHidden
              ? "••••"
              : formatDecimal(0, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </span>
        ) : (
          amounts.map((total) => (
            <span key={total.currency}>
              {isBalanceHidden ? "••••" : formatAmount(total.amount, total.currency, false)}{" "}
              {total.currency}
            </span>
          ))
        )}
      </div>
      {summary.missingRateCurrencies.length > 0 && (
        <p className="text-muted-foreground text-xs">
          {t("spending:analysis.missingRates", {
            currencies: summary.missingRateCurrencies.join(", "),
          })}
        </p>
      )}
      {summary.converted && summary.byCurrency.length > 0 && (
        <details className="text-muted-foreground text-xs">
          <summary className="cursor-pointer">{t("spending:analysis.byCurrency")}</summary>
          {summary.byCurrency.map((total) => (
            <div key={total.currency}>
              {isBalanceHidden ? "••••" : formatAmount(total.amount, total.currency, false)}{" "}
              {total.currency}
            </div>
          ))}
        </details>
      )}
    </div>
  );
}

export function AnalysisTotalsReadout({ totals }: { totals: AnalysisTotals }) {
  const { t } = useTranslation();
  return (
    <dl className="space-y-2 text-sm">
      <div>
        <dt className="text-muted-foreground text-xs">{t("spending:analysis.netSpending")}</dt>
        <dd>
          <ExactMoneyReadout summary={totals.spending} />
        </dd>
      </div>
      <div>
        <dt className="text-muted-foreground text-xs">{t("spending:analysis.cashMovement")}</dt>
        <dd>
          <ExactMoneyReadout summary={totals.cashMovement} />
        </dd>
      </div>
    </dl>
  );
}

interface TransactionsAnalysisBarProps {
  active: boolean;
  analysis?: CashActivityAnalysis;
  pending: boolean;
  failed: boolean;
  onStart: () => void;
  onStop: () => void;
  onSelectAll: () => void;
  onClear: () => void;
  onRetry: () => void;
}

export function TransactionsAnalysisBar({
  active,
  analysis,
  pending,
  failed,
  onStart,
  onStop,
  onSelectAll,
  onClear,
  onRetry,
}: TransactionsAnalysisBarProps) {
  const { t } = useTranslation();
  if (!active) {
    return (
      <Button variant="outline" size="sm" onClick={onStart}>
        {t("spending:analysis.start")}
      </Button>
    );
  }
  const ready = !pending && !failed && analysis;
  return (
    <section
      aria-label={t("spending:analysis.title")}
      aria-busy={pending}
      className="bg-background sticky top-0 z-20 space-y-3 rounded-md border p-3 shadow-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{t("spending:analysis.title")}</h3>
        <div className="flex flex-wrap gap-1">
          <Button
            size="sm"
            variant="outline"
            onClick={onSelectAll}
            disabled={pending || (!!ready && analysis.matching.count === 0)}
          >
            {t("spending:analysis.selectAll")}
          </Button>
          <Button size="sm" variant="ghost" onClick={onClear}>
            {t("spending:analysis.clear")}
          </Button>
          <Button size="sm" variant="ghost" onClick={onStop}>
            {t("spending:analysis.exit")}
          </Button>
        </div>
      </div>
      <div role="status" aria-live="polite">
        {pending ? (
          <div className="space-y-2">
            <span className="text-muted-foreground text-xs">{t("spending:analysis.updating")}</span>
            <Skeleton className="h-20 w-full" />
          </div>
        ) : failed || !analysis ? (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span>{t("spending:analysis.error")}</span>
            <Button size="sm" variant="outline" onClick={onRetry}>
              {t("common:retry")}
            </Button>
          </div>
        ) : (
          <>
            <p className="mb-2 text-sm font-medium">
              {t("spending:analysis.count", {
                selected: analysis.selected.count,
                matching: analysis.matching.count,
              })}
            </p>
            <div className="grid grid-cols-3 gap-3">
              {(["selected", "matching", "excluded"] as const).map((scope) => (
                <div key={scope} data-testid={`analysis-${scope}`} className="min-w-0">
                  <h4 className="mb-1 text-xs font-semibold">{t(`spending:analysis.${scope}`)}</h4>
                  <AnalysisTotalsReadout totals={analysis[scope]} />
                </div>
              ))}
            </div>
          </>
        )}
      </div>
      <details className="text-muted-foreground text-xs">
        <summary className="cursor-pointer">{t("spending:analysis.about")}</summary>
        <p className="mt-1">{t("spending:analysis.explanation")}</p>
      </details>
    </section>
  );
}
