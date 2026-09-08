use serde::{Deserialize, Serialize};

use crate::activity_assignments::ActivityTaxonomyAssignment;
use crate::activity_splits::ActivitySplit;
use wealthfolio_core::activities::Activity;

/// Filter for listing cash activities. All fields optional.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CashActivityFilter {
    /// Restrict to specific accounts (intersected with the spending account list).
    /// If None, all spending accounts are queried.
    pub account_ids: Option<Vec<String>>,
    /// Restrict to a date window (RFC3339 strings on either side; both inclusive).
    pub start_date: Option<String>,
    pub end_date: Option<String>,
    /// Restrict to specific activity_types. If None, defaults to CASH_ACTIVITY_TYPES.
    pub activity_types: Option<Vec<String>>,
}

/// Status filter for cash-activity search.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[derive(Default)]
pub enum CashActivityStatusFilter {
    #[default]
    All,
    NeedsReview,
    Uncategorized,
    Categorized,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[derive(Default)]
pub enum CashActivitySortField {
    #[default]
    Date,
    Amount,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[derive(Default)]
pub enum SortDirection {
    Asc,
    #[default]
    Desc,
}

/// Search request for cash activities. Powers the spending Transactions page.
/// All filters optional. Server-side: filters → sort → analysis → paginate → join assignments.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CashActivitySearchRequest {
    /// Free-text search over notes (payee). Case-insensitive contains-match.
    pub search: Option<String>,
    /// Restrict to these accounts (intersected with the spending account list).
    pub account_ids: Option<Vec<String>>,
    /// Restrict to specific activity_types. If None, defaults to CASH_ACTIVITY_TYPES.
    pub activity_types: Option<Vec<String>>,
    /// Filter to activities assigned to any of these top-level categories
    /// (caller is responsible for expanding subcategories).
    pub category_ids: Option<Vec<String>>,
    /// Filter to activities assigned to specific (sub)category ids.
    pub subcategory_ids: Option<Vec<String>>,
    /// Filter to activities tagged with these events (uses Activity.event_id).
    pub event_ids: Option<Vec<String>>,
    /// Status: All / NeedsReview / Uncategorized / Categorized.
    #[serde(default)]
    pub status: CashActivityStatusFilter,
    /// Date window — RFC3339 strings, inclusive.
    pub start_date: Option<String>,
    pub end_date: Option<String>,
    /// Absolute amount range (operates on |amount|).
    pub min_amount: Option<f64>,
    pub max_amount: Option<f64>,
    /// Sort.
    #[serde(default)]
    pub sort_by: CashActivitySortField,
    #[serde(default)]
    pub sort_dir: SortDirection,
    /// Pagination.
    #[serde(default)]
    pub offset: usize,
    #[serde(default = "default_limit")]
    pub limit: usize,
    /// Optional analysis of the full filtered set, independent of pagination.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selection: Option<CashActivitySelection>,
    /// Materialize selected matching ids, net and buckets before pagination.
    /// Requires `selection`, even when spending is disabled. Does not filter page items.
    #[serde(default)]
    pub include_selection_snapshot: bool,
}

impl CashActivitySearchRequest {
    pub fn validate_selection_snapshot(&self) -> Result<(), crate::error::SpendingError> {
        if self.include_selection_snapshot && self.selection.is_none() {
            return Err(crate::error::SpendingError::InvalidInput {
                message: "includeSelectionSnapshot requires selection".to_string(),
            });
        }
        Ok(())
    }
}

fn default_limit() -> usize {
    50
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CashActivitySelectionMode {
    All,
    Explicit,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CashActivitySelection {
    pub mode: CashActivitySelectionMode,
    /// Excluded ids in `all` mode; included ids in `explicit` mode.
    /// Unknown ids and ids outside the filtered set have no effect.
    pub ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExactCurrencyAmount {
    pub currency: String,
    pub amount: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExactMoneySummary {
    /// Exact native totals. Currencies that net to zero are omitted.
    pub by_currency: Vec<ExactCurrencyAmount>,
    /// Sum of per-row conversions, including native-zero FX residuals.
    /// Present whenever a base was supplied and every contribution converted.
    pub converted: Option<ExactCurrencyAmount>,
    /// Nonzero contributions without a rate, even if their native totals cancel.
    pub missing_rate_currencies: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisTotals {
    pub count: usize,
    /// Canonical signed cash movement of whole transactions.
    pub cash_movement: ExactMoneySummary,
    /// Net consumption, restricted to matching category allocations when filtered.
    pub spending: ExactMoneySummary,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CashActivityAnalysis {
    pub matching: AnalysisTotals,
    pub selected: AnalysisTotals,
    pub excluded: AnalysisTotals,
}

impl CashActivityAnalysis {
    pub fn empty(base_currency: Option<&str>) -> Self {
        let money = ExactMoneySummary {
            by_currency: Vec::new(),
            converted: base_currency.map(|currency| ExactCurrencyAmount {
                currency: currency.to_string(),
                amount: "0".to_string(),
            }),
            missing_rate_currencies: Vec::new(),
        };
        let totals = AnalysisTotals {
            count: 0,
            cash_movement: money.clone(),
            spending: money,
        };
        Self {
            matching: totals.clone(),
            selected: totals.clone(),
            excluded: totals,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CashFlowBucket {
    Spending,
    Income,
    Saving,
    Neutral,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TransferLinkStatus {
    Linked,
    Unlinked,
    Invalid,
}

/// Canonical cash-activity row, returned by every spending read path
/// (`list()` and `search()`). Flattens the portfolio-wide `Activity` and
/// adds the spending-domain enrichments — single-select category assignment
/// and the optional event tag — so callers always get the full shape in one
/// round-trip.
///
/// Why this exists vs `Activity`: the core `Activity` struct is shared with
/// the portfolio/investments path and stays free of spending-domain
/// coupling. The enrichment fields live on the join tables
/// (`activity_taxonomy_assignments`, `activity_events`) and only the
/// spending feature's API surface joins them in.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CashActivity {
    #[serde(flatten)]
    pub activity: Activity,
    /// Accounting bucket for this activity. Categories label the bucket; they do
    /// not move the activity between Spending, Income, Saving, and Neutral.
    pub cash_flow_bucket: CashFlowBucket,
    /// Activity-scope assignments for this row. Typically 0 or 1 (single-select).
    pub assignments: Vec<ActivityTaxonomyAssignment>,
    /// Exact category allocations. When present, these replace the single
    /// assignment for budget/report actuals.
    #[serde(default)]
    pub splits: Vec<ActivitySplit>,
    /// Spending event tag from the `activity_events` join. `None` when untagged.
    #[serde(default)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event_id: Option<String>,
    /// Transfer link state for TRANSFER_IN / TRANSFER_OUT rows. Distinguishes
    /// valid pairs from orphaned or malformed source groups.
    #[serde(default)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transfer_link_status: Option<TransferLinkStatus>,
    /// Signed cash movement in this row's own currency: positive when money
    /// entered the account, negative when it left, zero when the row moves no
    /// cash (an unposted row, for instance).
    ///
    /// Produced by the same resolver that builds account cash balances, so a
    /// client can sum these directly rather than re-deriving a sign, and the
    /// figures it shows agree with the account page by construction.
    pub net_amount: f64,
    /// `net_amount` in the caller's base currency, converted at this row's own
    /// date. `None` when the caller asked for no conversion, or when this row's
    /// currency has no rate at all.
    #[serde(default)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub net_amount_base: Option<f64>,
}

/// A signed net in one currency.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CurrencyNet {
    pub currency: String,
    pub amount: f64,
}

/// The net of a filtered set, summed before pagination so it describes the
/// filter rather than the page.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NetSummary {
    /// Always populated. Uses no exchange rates, so it cannot be wrong.
    /// Currencies that net to nothing are omitted.
    pub by_currency: Vec<CurrencyNet>,
    /// One figure in the base currency, for readers who want a single number.
    ///
    /// `None` when there is nothing to convert (a single currency contributes,
    /// so `by_currency` already is the total) or when any contributing currency
    /// has no rate at all — a converted total that silently omitted those rows
    /// would be worse than no total.
    pub converted: Option<CurrencyNet>,
}

/// Read-only projection of the full selected matching set, independent of page limits.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CashActivitySelectionSnapshot {
    pub ids: Vec<String>,
    /// Canonical selected net with known native zero currency buckets restored.
    /// Restoring currency labels does not change the canonical converted total.
    pub net: NetSummary,
    /// Distinct actual selected buckets, using the full spending transfer context.
    pub cash_flow_buckets: Vec<CashFlowBucket>,
}

/// Paginated response for cash-activity search.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CashActivitySearchResponse {
    pub items: Vec<CashActivity>,
    /// Total rows matching the filters (for pagination UI).
    pub total_count: usize,
    /// Net over the whole filtered set.
    ///
    /// Only the first page carries it (`None` afterwards): clients refetch page
    /// one on every filter change, so later pages would only recompute the same
    /// answer.
    #[serde(default)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub net: Option<NetSummary>,
    /// Currency that `net_amount_base` on each row — and `net.converted` — are
    /// denominated in. `None` when no conversion was requested.
    ///
    /// Reported rather than left to the client to infer from its own settings:
    /// a cached response outlives a settings change, and labelling those amounts
    /// with the new currency would state a figure in a currency it is not in.
    #[serde(default)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_currency: Option<String>,
    /// Requested selection totals over the full filtered snapshot, before pagination.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub analysis: Option<CashActivityAnalysis>,
    /// Present only when `includeSelectionSnapshot` is true and `selection` is supplied.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selection_snapshot: Option<CashActivitySelectionSnapshot>,
}
