import { useTranslation } from "react-i18next";

import { Button, Icons } from "@wealthfolio/ui";

import { MAX_BULK_CATEGORY_ASSIGNMENTS } from "../lib/constants";
import { QuickCategorizePopover, type QuickCategorizeScope } from "./quick-categorize-popover";
import { QuickEventPopover } from "./quick-event-popover";

interface TransactionsBulkBarProps {
  selectedCount: number;
  categoryScope: QuickCategorizeScope | null;
  onCategorize: (taxonomyId: string, categoryId: string) => void;
  onTagEvent: (eventId: string | null) => void;
  onDelete: () => void;
  onClearSelection: () => void;
  selectionStatus?: "ready" | "pending" | "error";
  onRetrySelection?: () => void;
  includesOtherPages?: boolean;
}

export function TransactionsBulkBar({
  selectedCount,
  categoryScope,
  onCategorize,
  onTagEvent,
  onDelete,
  onClearSelection,
  selectionStatus = "ready",
  onRetrySelection,
  includesOtherPages = false,
}: TransactionsBulkBarProps) {
  const { t } = useTranslation();
  const exceedsCategoryLimit = selectedCount > MAX_BULK_CATEGORY_ASSIGNMENTS;
  const categoryLimitHint = t("spending:transactions.categorizeLimit", {
    limit: MAX_BULK_CATEGORY_ASSIGNMENTS,
  });
  if (selectionStatus !== "ready") {
    return (
      <div
        role="region"
        aria-label={t("spending:transactions.bulkActions")}
        aria-busy={selectionStatus === "pending"}
        className="bg-muted/40 ring-border flex flex-wrap items-center justify-between gap-2 rounded-md px-3 py-2 ring-1"
      >
        <span role="status" className="text-sm">
          {t(
            selectionStatus === "pending"
              ? "spending:transactions.preparingSelection"
              : "spending:transactions.selectionLoadFailed",
          )}
        </span>
        <div className="flex gap-2">
          {selectionStatus === "error" && (
            <Button size="sm" variant="outline" onClick={onRetrySelection}>
              {t("common:retry")}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={onClearSelection}>
            {t("common:clear")}
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div
      role="region"
      aria-label={t("spending:transactions.bulkActions")}
      className="bg-muted/40 ring-border flex flex-wrap items-center justify-between gap-2 rounded-md px-3 py-2 ring-1"
    >
      <div className="text-foreground flex flex-wrap items-center gap-2 text-sm">
        <Icons.Check className="h-4 w-4" aria-hidden="true" />
        <span className="font-medium">
          {t("spending:transactions.selectedCount", { count: selectedCount })}
        </span>
        {includesOtherPages && (
          <span className="text-muted-foreground text-xs">
            {t("spending:transactions.includesOtherPages")}
          </span>
        )}
        {exceedsCategoryLimit && (
          <span className="text-muted-foreground text-xs">{categoryLimitHint}</span>
        )}
      </div>
      {/* Wraps: on a phone these four buttons do not fit beside the count, and
          without it the last one is cut off at the edge of the screen. */}
      <div className="flex flex-wrap items-center gap-2">
        {categoryScope && !exceedsCategoryLimit ? (
          <QuickCategorizePopover
            align="end"
            scope={categoryScope}
            onSelect={onCategorize}
            trigger={
              <Button size="sm" variant="default">
                <Icons.Tag className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                {t("spending:transactions.categorize")}
              </Button>
            }
          />
        ) : (
          <Button
            size="sm"
            variant="default"
            disabled
            title={
              exceedsCategoryLimit ? categoryLimitHint : t("spending:transactions.categorizeHint")
            }
          >
            <Icons.Tag className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
            {t("spending:transactions.categorize")}
          </Button>
        )}
        <QuickEventPopover
          align="end"
          onSelect={(eventId) => onTagEvent(eventId)}
          onClear={() => onTagEvent(null)}
          trigger={
            <Button size="sm" variant="outline">
              <Icons.Calendar className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
              {t("spending:transactions.tagEvent")}
            </Button>
          }
        />
        <Button
          size="sm"
          variant="outline"
          className="text-destructive hover:bg-destructive/10"
          onClick={onDelete}
        >
          <Icons.Trash className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
          {t("common:delete")}
        </Button>
        <Button size="sm" variant="ghost" onClick={onClearSelection}>
          {t("common:clear")}
        </Button>
      </div>
    </div>
  );
}
