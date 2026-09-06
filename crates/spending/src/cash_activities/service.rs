use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::sync::Arc;

use anyhow::Result;
use chrono::{DateTime, Utc};
use chrono_tz::Tz;
use rust_decimal::{prelude::ToPrimitive, Decimal};
use wealthfolio_core::accounts::{
    account_supports_purpose, account_types, AccountPurpose, AccountRepositoryTrait,
};
use wealthfolio_core::activities::{
    Activity, ActivityRepositoryTrait, TransferPairResolution, ACTIVITY_TYPE_TRANSFER_IN,
    ACTIVITY_TYPE_TRANSFER_OUT,
};
use wealthfolio_core::utils::time_utils::{activity_date_in_tz, parse_user_timezone_or_default};

use super::{
    model::{
        AnalysisTotals, CashActivity, CashActivityAnalysis, CashActivityFilter,
        CashActivitySearchRequest, CashActivitySearchResponse, CashActivitySelection,
        CashActivitySelectionMode, CashActivitySortField, CashActivityStatusFilter, CashFlowBucket,
        CurrencyNet, ExactCurrencyAmount, ExactMoneySummary, NetSummary, SortDirection,
        TransferLinkStatus,
    },
    CASH_ACTIVITY_TYPES,
};
use crate::activity_allocations::{
    allocations_for_taxonomy, group_assignments as group_assignments_owned,
    group_splits as group_splits_owned, AssignmentsByActivity, SplitsByActivity,
};
use crate::activity_assignments::{
    ActivityTaxonomyAssignment, ActivityTaxonomyAssignmentService, BulkCategoryAssignment,
};
use crate::activity_classification::{
    activity_abs_amount, classify_activity, classify_activity_for_aggregation, decimal_to_f64,
    net_amount, within_spending_transfer_groups, SpendingClassification,
};
use crate::activity_splits::{ActivitySplit, ActivitySplitRepositoryTrait, NewActivitySplit};
use crate::error::SpendingError;
use crate::events::EventsService;
use crate::settings::SpendingSettingsService;

const SPENDING_TAXONOMY: &str = "spending_categories";
const INCOME_TAXONOMY: &str = "income_sources";
const SAVINGS_TAXONOMY: &str = "savings_categories";
const MAX_CASH_ACTIVITY_SEARCH_LIMIT: usize = 1_000;

/// Service for listing/searching activities scoped to the user's spending accounts.
/// Mutation (create/update/delete) goes through the existing core ActivityService;
/// categorization goes through ActivityTaxonomyAssignmentService.
pub struct CashActivityService {
    activity_repo: Arc<dyn ActivityRepositoryTrait>,
    account_repo: Arc<dyn AccountRepositoryTrait>,
    settings: Arc<SpendingSettingsService>,
    assignments: Arc<ActivityTaxonomyAssignmentService>,
    splits: Arc<dyn ActivitySplitRepositoryTrait>,
    activity_events: Arc<dyn crate::activity_events::ActivityEventsRepositoryTrait>,
    events: Arc<EventsService>,
    fx: Arc<dyn wealthfolio_core::fx::FxServiceTrait>,
}

/// Accounts in scope for a spending query, with the two lookups callers need.
/// A named struct rather than a tuple: `types` and `currencies` are both
/// `HashMap<String, String>` and would be silently transposable by position.
/// Running per-currency net while summarising a filtered set.
struct CurrencyTally {
    currency: String,
    native: Decimal,
    /// `None` once a row in this currency could not be converted.
    converted: Option<Decimal>,
}

struct TargetAccounts {
    ids: Vec<String>,
    types: HashMap<String, String>,
    currencies: HashMap<String, String>,
}

#[derive(Default)]
struct ExactMoneyTally {
    native: BTreeMap<String, Decimal>,
    converted: Decimal,
    missing: BTreeSet<String>,
}

impl ExactMoneyTally {
    fn add(&mut self, currency: &str, native: Decimal, converted: Option<Decimal>) {
        if native.is_zero() {
            return;
        }
        *self.native.entry(currency.to_string()).or_default() += native;
        match converted {
            Some(amount) => self.converted += amount,
            None => {
                self.missing.insert(currency.to_string());
            }
        }
    }

    fn finish(self, base_currency: Option<&str>) -> ExactMoneySummary {
        ExactMoneySummary {
            by_currency: self
                .native
                .into_iter()
                .filter(|(_, amount)| !amount.is_zero())
                .map(|(currency, amount)| ExactCurrencyAmount {
                    currency,
                    amount: amount.normalize().to_string(),
                })
                .collect(),
            converted: base_currency
                .filter(|_| self.missing.is_empty())
                .map(|currency| ExactCurrencyAmount {
                    currency: currency.to_string(),
                    amount: self.converted.normalize().to_string(),
                }),
            missing_rate_currencies: if base_currency.is_some() {
                self.missing.into_iter().collect()
            } else {
                Vec::new()
            },
        }
    }
}

#[derive(Default)]
struct AnalysisTally {
    count: usize,
    cash_movement: ExactMoneyTally,
    spending: ExactMoneyTally,
}

impl AnalysisTally {
    fn finish(self, base_currency: Option<&str>) -> AnalysisTotals {
        AnalysisTotals {
            count: self.count,
            cash_movement: self.cash_movement.finish(base_currency),
            spending: self.spending.finish(base_currency),
        }
    }
}

impl CashActivityService {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        activity_repo: Arc<dyn ActivityRepositoryTrait>,
        account_repo: Arc<dyn AccountRepositoryTrait>,
        settings: Arc<SpendingSettingsService>,
        assignments: Arc<ActivityTaxonomyAssignmentService>,
        splits: Arc<dyn ActivitySplitRepositoryTrait>,
        activity_events: Arc<dyn crate::activity_events::ActivityEventsRepositoryTrait>,
        events: Arc<EventsService>,
        fx: Arc<dyn wealthfolio_core::fx::FxServiceTrait>,
    ) -> Self {
        Self {
            activity_repo,
            account_repo,
            settings,
            assignments,
            splits,
            activity_events,
            events,
            fx,
        }
    }

    /// List cash activities matching the (legacy) filter, scoped to opted-in
    /// spending accounts. Returns empty vec if spending tracking is disabled
    /// or no accounts opted in.
    ///
    /// Returns `CashActivity` (same shape as `search()` items)
    /// so consumers get the activity row, its category assignments, and its
    /// event tag in a single round-trip. Before the activity_events
    /// refactor, `Activity` carried `event_id` directly; we now JOIN it in
    /// here so the frontend doesn't need a second query (and so a single
    /// regression on either path can't diverge from the other — `list()`
    /// previously missed the event-tag enrichment `search()` got).
    pub async fn list(&self, filter: CashActivityFilter) -> Result<Vec<CashActivity>> {
        let s = self.settings.get().await?;
        if !s.enabled || s.account_ids.is_empty() {
            return Ok(Vec::new());
        }

        let TargetAccounts {
            ids: all_spending_accounts,
            types: account_types,
            ..
        } = self.resolve_target_accounts(None, &s.account_ids)?;
        if all_spending_accounts.is_empty() {
            return Ok(Vec::new());
        }
        let all_spending_account_ids: HashSet<&str> =
            all_spending_accounts.iter().map(String::as_str).collect();
        let requested_accounts = filter
            .account_ids
            .unwrap_or_else(|| all_spending_accounts.clone());
        let target_accounts: HashSet<String> = requested_accounts
            .into_iter()
            .filter(|id| all_spending_account_ids.contains(id.as_str()))
            .collect();
        if target_accounts.is_empty() {
            return Ok(Vec::new());
        }

        let mut activities = self
            .activity_repo
            .get_activities_by_account_ids(&all_spending_accounts)
            .map_err(|e| anyhow::anyhow!(e.to_string()))?;
        let transfer_link_resolution = self.transfer_link_resolution()?;
        let transfer_context_acts: Vec<&Activity> = activities.iter().collect();
        let transfer_groups = within_spending_transfer_groups(&transfer_context_acts);
        activities.retain(|a| target_accounts.contains(&a.account_id));

        let allowed_types: Vec<String> = filter
            .activity_types
            .unwrap_or_else(|| CASH_ACTIVITY_TYPES.iter().map(|s| s.to_string()).collect());
        activities.retain(|a| allowed_types.iter().any(|t| t == a.effective_type()));
        retain_classified_cash_activities(&mut activities, &account_types);

        retain_by_date_range(
            &mut activities,
            filter.start_date.as_deref(),
            filter.end_date.as_deref(),
        )?;

        activities.sort_by_key(|a| std::cmp::Reverse(a.activity_date));

        // Batch-enrich with assignments + event tags. Mirrors the tail of
        // `search()`. The ids list is the *retained* rows, so we never fetch
        // joins for activities we've already filtered out.
        let ids: Vec<String> = activities.iter().map(|a| a.id.clone()).collect();
        let asgs = self.assignments.list_for_activities(&ids).await?;
        let mut by_activity = group_assignments_owned(asgs);
        let splits = self.splits.list_for_activities(&ids).await?;
        let mut splits_by_activity = group_splits_owned(splits);
        let mut tag_map = self.activity_events.list_for_activities(&ids).await?;
        let items: Vec<CashActivity> = activities
            .into_iter()
            .map(|a| {
                let assignments = by_activity.remove(&a.id).unwrap_or_default();
                let splits = splits_by_activity.remove(&a.id).unwrap_or_default();
                let event_id = tag_map.remove(&a.id);
                let cash_flow_bucket = cash_flow_bucket_for(&a, &account_types, &transfer_groups);
                let transfer_link_status = transfer_link_status_for(&a, &transfer_link_resolution);
                let net_amount = decimal_to_f64(net_amount(&a, &account_types));
                CashActivity {
                    activity: a,
                    cash_flow_bucket,
                    assignments,
                    splits,
                    event_id,
                    transfer_link_status,
                    net_amount,
                    net_amount_base: None,
                }
            })
            .collect();
        Ok(items)
    }

    /// `net_amount` in `base`, converted at the activity's own date.
    ///
    /// A transaction list reports what a row cost at the time, so each row uses
    /// its own date rather than one snapshot rate for the whole set — see the
    /// note on [`crate::fx::convert`]. That date is resolved in the user's
    /// timezone, matching how the row is grouped on screen and how the holdings
    /// engine picks an acquisition-date rate.
    ///
    /// A rate stored on the activity wins over a lookup, matching how lots
    /// prefer their stored acquisition FX: it is the rate actually applied to
    /// this transaction, not a market rate for the day. It converts into the
    /// *account's* currency though, so it only answers this question when the
    /// account is denominated in the base currency; otherwise it would need
    /// chaining and the lookup is the simpler truth.
    fn net_amount_in_base(
        &self,
        activity: &Activity,
        net: Decimal,
        base: &str,
        account_currency: Option<&str>,
        timezone: Tz,
    ) -> Option<Decimal> {
        if account_currency == Some(base) && activity.currency != base {
            if let Some(rate) = activity.fx_rate.filter(|rate| !rate.is_zero()) {
                return Some(net * rate);
            }
        }
        crate::fx::convert(
            self.fx.as_ref(),
            net,
            &activity.currency,
            base,
            // The user's day, not UTC: a late-evening activity is displayed
            // under — and valued by the holdings engine on — its local date, so
            // taking `.date_naive()` here would price it a day out for anything
            // either side of midnight.
            activity_date_in_tz(activity.activity_date, timezone),
        )
    }

    /// Nets `activities` per currency, and adds a single converted figure when
    /// one is both useful and trustworthy.
    ///
    /// Rows that move no cash contribute nothing and never introduce a currency
    /// of their own. Currencies that net to nothing are dropped.
    fn net_summary(
        &self,
        activities: &[Activity],
        account_types: &HashMap<String, String>,
        account_currencies: &HashMap<String, String>,
        base_currency: Option<&str>,
        timezone: Tz,
    ) -> NetSummary {
        // One pass, tallied per currency: the resolver runs once per activity and
        // the conversion reuses that result rather than recomputing it.
        let mut tallies: Vec<CurrencyTally> = Vec::new();

        for activity in activities {
            let net = net_amount(activity, account_types);
            if net.is_zero() {
                continue;
            }

            let index = match tallies
                .iter()
                .position(|tally| tally.currency == activity.currency)
            {
                Some(index) => index,
                None => {
                    tallies.push(CurrencyTally {
                        currency: activity.currency.clone(),
                        native: Decimal::ZERO,
                        converted: Some(Decimal::ZERO),
                    });
                    tallies.len() - 1
                }
            };
            tallies[index].native += net;

            // Once a currency has failed to convert the answer cannot change, so
            // stop asking: every further attempt is a repository round-trip and a
            // warning for a figure already known to be unavailable.
            if let (Some(base), Some(running)) = (base_currency, tallies[index].converted) {
                let account_currency = account_currencies
                    .get(&activity.account_id)
                    .map(String::as_str);
                tallies[index].converted = self
                    .net_amount_in_base(activity, net, base, account_currency, timezone)
                    .map(|converted| running + converted);
            }
        }

        // A currency whose rows cancel out is not reported, and must not reach
        // the converted total either: converting each row at its own date leaves
        // a residual when the rate moved between them, which would put movement
        // into the headline that appears in no pill.
        let contributing: Vec<&CurrencyTally> = tallies
            .iter()
            .filter(|tally| !tally.native.is_zero())
            .collect();

        let by_currency: Vec<CurrencyNet> = contributing
            .iter()
            .map(|tally| CurrencyNet {
                currency: tally.currency.clone(),
                amount: decimal_to_f64(tally.native),
            })
            .collect();

        // Withheld when a single currency contributes — `by_currency` already is
        // the total, and converting it would only introduce FX drift into a
        // figure that has an exact answer. Withheld when any contributing
        // currency has no rate, since the total would silently omit its rows;
        // `Sum for Option` collapses to `None` if any tally failed.
        let converted = match base_currency {
            Some(base) if contributing.len() > 1 => contributing
                .iter()
                .map(|tally| tally.converted)
                .sum::<Option<Decimal>>()
                .map(|amount| CurrencyNet {
                    currency: base.to_string(),
                    amount: decimal_to_f64(amount),
                }),
            _ => None,
        };

        NetSummary {
            by_currency,
            converted,
        }
    }

    /// Search/filter/paginate cash activities. Powers the spending Transactions page.
    /// Server-side pipeline: filters → sort → optional analysis → paginate → join page assignments.
    /// `base_currency` is the currency the converted net is denominated in.
    /// Injected by the app-level callers and never sent by the client; `None`
    /// asks for the per-currency breakdown only.
    pub async fn search(
        &self,
        req: CashActivitySearchRequest,
        base_currency: Option<&str>,
        timezone: &str,
    ) -> Result<CashActivitySearchResponse> {
        let timezone = parse_user_timezone_or_default(timezone);
        let s = self.settings.get().await?;
        if !s.enabled || s.account_ids.is_empty() {
            return Ok(CashActivitySearchResponse {
                items: Vec::new(),
                total_count: 0,
                net: Some(NetSummary::default()),
                base_currency: base_currency.map(str::to_string),
                analysis: req
                    .selection
                    .as_ref()
                    .map(|_| CashActivityAnalysis::empty(base_currency)),
            });
        }

        let TargetAccounts {
            ids: all_spending_accounts,
            types: account_types,
            currencies: account_currencies,
        } = self.resolve_target_accounts(None, &s.account_ids)?;
        if all_spending_accounts.is_empty() {
            return Ok(CashActivitySearchResponse {
                items: Vec::new(),
                total_count: 0,
                net: Some(NetSummary::default()),
                base_currency: base_currency.map(str::to_string),
                analysis: req
                    .selection
                    .as_ref()
                    .map(|_| CashActivityAnalysis::empty(base_currency)),
            });
        }
        let all_spending_account_ids: HashSet<&str> =
            all_spending_accounts.iter().map(String::as_str).collect();
        let requested_accounts = req
            .account_ids
            .unwrap_or_else(|| all_spending_accounts.clone());
        let target_accounts: HashSet<String> = requested_accounts
            .into_iter()
            .filter(|id| all_spending_account_ids.contains(id.as_str()))
            .collect();
        if target_accounts.is_empty() {
            return Ok(CashActivitySearchResponse {
                items: Vec::new(),
                total_count: 0,
                net: Some(NetSummary::default()),
                base_currency: base_currency.map(str::to_string),
                analysis: req
                    .selection
                    .as_ref()
                    .map(|_| CashActivityAnalysis::empty(base_currency)),
            });
        }

        let mut activities = self
            .activity_repo
            .get_activities_by_account_ids(&all_spending_accounts)
            .map_err(|e| anyhow::anyhow!(e.to_string()))?;
        let transfer_link_resolution = self.transfer_link_resolution()?;
        let transfer_context_acts: Vec<&Activity> = activities.iter().collect();
        let transfer_groups = within_spending_transfer_groups(&transfer_context_acts);
        activities.retain(|a| target_accounts.contains(&a.account_id));

        let allowed_types: Vec<String> = req
            .activity_types
            .unwrap_or_else(|| CASH_ACTIVITY_TYPES.iter().map(|s| s.to_string()).collect());
        activities.retain(|a| allowed_types.iter().any(|t| t == a.effective_type()));
        retain_classified_cash_activities(&mut activities, &account_types);

        retain_by_date_range(
            &mut activities,
            req.start_date.as_deref(),
            req.end_date.as_deref(),
        )?;

        if let Some(events) = req.event_ids.as_deref() {
            if !events.is_empty() {
                // Load per-activity tags from the join table once, then
                // filter in-memory. Mirrors the analytics services' pattern.
                let activity_ids: Vec<String> = activities.iter().map(|a| a.id.clone()).collect();
                let tag_map = self
                    .activity_events
                    .list_for_activities(&activity_ids)
                    .await?;
                activities.retain(|a| {
                    tag_map
                        .get(&a.id)
                        .map(|tag| events.iter().any(|e| e == tag))
                        .unwrap_or(false)
                });
            }
        }

        if let Some(min) = req.min_amount {
            activities.retain(|a| {
                a.amount
                    .map(|d| d.abs().to_f64().unwrap_or(0.0) >= min)
                    .unwrap_or(false)
            });
        }
        if let Some(max) = req.max_amount {
            activities.retain(|a| {
                a.amount
                    .map(|d| d.abs().to_f64().unwrap_or(0.0) <= max)
                    .unwrap_or(false)
            });
        }

        if let Some(needle) = req.search.as_deref() {
            let needle = needle.trim().to_lowercase();
            if !needle.is_empty() {
                activities.retain(|a| {
                    let notes = a.notes.as_deref().unwrap_or("").to_lowercase();
                    notes.contains(&needle)
                });
            }
        }

        // Status / category filters need assignments; fetch in batch first.
        let needs_assignments_for_filter = req.status != CashActivityStatusFilter::All
            || req
                .category_ids
                .as_ref()
                .map(|v| !v.is_empty())
                .unwrap_or(false)
            || req
                .subcategory_ids
                .as_ref()
                .map(|v| !v.is_empty())
                .unwrap_or(false);

        let mut analysis_assignments = AssignmentsByActivity::new();
        let mut analysis_splits = SplitsByActivity::new();
        if needs_assignments_for_filter {
            let ids: Vec<String> = activities.iter().map(|a| a.id.clone()).collect();
            let assignments = self.assignments.list_for_activities(&ids).await?;
            let by_activity = group_assignments(&assignments);
            let splits = self.splits.list_for_activities(&ids).await?;
            let splits_by_activity = group_splits(&splits);

            activities.retain(|a| {
                let asgs = by_activity.get(a.id.as_str());
                let activity_splits = splits_by_activity.get(a.id.as_str());
                let bucket = cash_flow_bucket_for(a, &account_types, &transfer_groups);
                let expected_taxonomy = taxonomy_for_bucket(bucket);
                let has_category =
                    expected_taxonomy.map_or(bucket == CashFlowBucket::Neutral, |taxonomy_id| {
                        asgs.map(|v| v.iter().any(|asg| asg.taxonomy_id == taxonomy_id))
                            .unwrap_or(false)
                            || activity_splits
                                .map(|v| v.iter().any(|split| split.taxonomy_id == taxonomy_id))
                                .unwrap_or(false)
                    });

                match req.status {
                    CashActivityStatusFilter::All => {}
                    CashActivityStatusFilter::NeedsReview => {
                        if !a.needs_review {
                            return false;
                        }
                    }
                    CashActivityStatusFilter::Uncategorized => {
                        if has_category {
                            return false;
                        }
                    }
                    CashActivityStatusFilter::Categorized => {
                        if !has_category {
                            return false;
                        }
                    }
                }

                if let Some(cats) = req.category_ids.as_deref() {
                    if !cats.is_empty() {
                        let any = asgs
                            .map(|v| {
                                v.iter().any(|asg| {
                                    expected_taxonomy == Some(asg.taxonomy_id.as_str())
                                        && cats.iter().any(|c| c == &asg.category_id)
                                })
                            })
                            .unwrap_or(false)
                            || activity_splits
                                .map(|v| {
                                    v.iter().any(|split| {
                                        expected_taxonomy == Some(split.taxonomy_id.as_str())
                                            && cats.iter().any(|c| c == &split.category_id)
                                    })
                                })
                                .unwrap_or(false);
                        if !any {
                            return false;
                        }
                    }
                }
                if let Some(subs) = req.subcategory_ids.as_deref() {
                    if !subs.is_empty() {
                        let any = asgs
                            .map(|v| {
                                v.iter().any(|asg| {
                                    expected_taxonomy == Some(asg.taxonomy_id.as_str())
                                        && subs.iter().any(|c| c == &asg.category_id)
                                })
                            })
                            .unwrap_or(false)
                            || activity_splits
                                .map(|v| {
                                    v.iter().any(|split| {
                                        expected_taxonomy == Some(split.taxonomy_id.as_str())
                                            && subs.iter().any(|c| c == &split.category_id)
                                    })
                                })
                                .unwrap_or(false);
                        if !any {
                            return false;
                        }
                    }
                }

                true
            });
            if req.selection.is_some() {
                analysis_assignments = group_assignments_owned(assignments);
                analysis_splits = group_splits_owned(splits);
            }
        }

        // Sort
        match req.sort_by {
            CashActivitySortField::Date => match req.sort_dir {
                SortDirection::Desc => activities.sort_by(|a, b| {
                    b.activity_date
                        .cmp(&a.activity_date)
                        .then_with(|| a.id.cmp(&b.id))
                }),
                SortDirection::Asc => activities.sort_by(|a, b| {
                    a.activity_date
                        .cmp(&b.activity_date)
                        .then_with(|| a.id.cmp(&b.id))
                }),
            },
            CashActivitySortField::Amount => {
                activities.sort_by(|a, b| {
                    let av = a.amount.map(|d| d.abs()).unwrap_or_default();
                    let bv = b.amount.map(|d| d.abs()).unwrap_or_default();
                    match req.sort_dir {
                        SortDirection::Desc => bv.cmp(&av),
                        SortDirection::Asc => av.cmp(&bv),
                    }
                    .then_with(|| a.id.cmp(&b.id))
                });
            }
        }

        let total_count = activities.len();
        let analysis = req.selection.as_ref().map(|selection| {
            self.selection_analysis(
                &activities,
                selection,
                &account_types,
                &account_currencies,
                &transfer_groups,
                &analysis_assignments,
                &analysis_splits,
                req.category_ids.as_deref(),
                req.subcategory_ids.as_deref(),
                base_currency,
                timezone,
            )
        });

        // Net the FULL filtered set before paginating, so the figure covers every
        // matching row rather than the page about to be sliced out. Only the
        // first page carries it — clients refetch page one whenever the filter
        // changes, so recomputing it for later pages would answer the same
        // question twice.
        let net = (req.offset == 0).then(|| {
            self.net_summary(
                &activities,
                &account_types,
                &account_currencies,
                base_currency,
                timezone,
            )
        });

        // Paginate
        let offset = req.offset.min(total_count);
        let limit = req.limit.min(MAX_CASH_ACTIVITY_SEARCH_LIMIT);
        let end = offset.saturating_add(limit).min(total_count);
        let page: Vec<Activity> = activities.drain(offset..end).collect();
        // Drop the rest — we no longer need them.
        drop(activities);

        // Batch-fetch assignments + event tags for the paginated slice.
        // (Always — clients use both for display.)
        let page_ids: Vec<String> = page.iter().map(|a| a.id.clone()).collect();
        let asgs = self.assignments.list_for_activities(&page_ids).await?;
        let mut by_activity = group_assignments_owned(asgs);
        let splits = self.splits.list_for_activities(&page_ids).await?;
        let mut splits_by_activity = group_splits_owned(splits);
        let mut tag_map = self.activity_events.list_for_activities(&page_ids).await?;

        let items: Vec<CashActivity> = page
            .into_iter()
            .map(|a| {
                let assignments = by_activity.remove(&a.id).unwrap_or_default();
                let splits = splits_by_activity.remove(&a.id).unwrap_or_default();
                let event_id = tag_map.remove(&a.id);
                let cash_flow_bucket = cash_flow_bucket_for(&a, &account_types, &transfer_groups);
                let transfer_link_status = transfer_link_status_for(&a, &transfer_link_resolution);
                let net = net_amount(&a, &account_types);
                let net_amount_base = base_currency
                    .and_then(|base| {
                        let account_currency =
                            account_currencies.get(&a.account_id).map(String::as_str);
                        self.net_amount_in_base(&a, net, base, account_currency, timezone)
                    })
                    .map(decimal_to_f64);
                CashActivity {
                    activity: a,
                    cash_flow_bucket,
                    assignments,
                    splits,
                    event_id,
                    transfer_link_status,
                    net_amount: decimal_to_f64(net),
                    net_amount_base,
                }
            })
            .collect();

        Ok(CashActivitySearchResponse {
            items,
            total_count,
            net,
            base_currency: base_currency.map(str::to_string),
            analysis,
        })
    }

    #[allow(clippy::too_many_arguments)]
    fn selection_analysis(
        &self,
        activities: &[Activity],
        selection: &CashActivitySelection,
        account_types: &HashMap<String, String>,
        account_currencies: &HashMap<String, String>,
        transfer_groups: &HashSet<String>,
        assignments: &AssignmentsByActivity,
        splits: &SplitsByActivity,
        category_ids: Option<&[String]>,
        subcategory_ids: Option<&[String]>,
        base_currency: Option<&str>,
        timezone: Tz,
    ) -> CashActivityAnalysis {
        let ids: HashSet<&str> = selection.ids.iter().map(String::as_str).collect();
        let category_filters: Vec<&[String]> = [category_ids, subcategory_ids]
            .into_iter()
            .flatten()
            .filter(|ids| !ids.is_empty())
            .collect();
        let mut matching = AnalysisTally::default();
        let mut selected = AnalysisTally::default();
        let mut excluded = AnalysisTally::default();
        for activity in activities {
            let cash = net_amount(activity, account_types);
            let spending = account_types
                .get(&activity.account_id)
                .map(|account_type| {
                    classify_activity_for_aggregation(activity, account_type, transfer_groups)
                        .spending_amount(activity_abs_amount(activity))
                })
                .unwrap_or_default();
            let spending = if category_filters.is_empty() {
                spending
            } else {
                allocations_for_taxonomy(
                    &activity.id,
                    SPENDING_TAXONOMY,
                    spending,
                    assignments,
                    splits,
                )
                .into_iter()
                .filter(|allocation| {
                    category_filters
                        .iter()
                        .all(|ids| ids.contains(&allocation.category_id))
                })
                .map(|allocation| allocation.amount)
                .sum()
            };
            let convert = |amount| {
                base_currency.and_then(|base| {
                    self.net_amount_in_base(
                        activity,
                        amount,
                        base,
                        account_currencies
                            .get(&activity.account_id)
                            .map(String::as_str),
                        timezone,
                    )
                })
            };
            let cash_base = convert(cash);
            let spending_base = convert(spending);
            let is_selected = match selection.mode {
                CashActivitySelectionMode::All => !ids.contains(activity.id.as_str()),
                CashActivitySelectionMode::Explicit => ids.contains(activity.id.as_str()),
            };
            let partition = if is_selected {
                &mut selected
            } else {
                &mut excluded
            };
            for tally in [&mut matching, partition] {
                tally.count += 1;
                tally.cash_movement.add(&activity.currency, cash, cash_base);
                tally
                    .spending
                    .add(&activity.currency, spending, spending_base);
            }
        }
        CashActivityAnalysis {
            matching: matching.finish(base_currency),
            selected: selected.finish(base_currency),
            excluded: excluded.finish(base_currency),
        }
    }

    /// Fetch explicit activity ids without applying the normal status/date/limit
    /// search filters. Still respects the user's spending account opt-in.
    pub async fn get_by_activity_ids(&self, activity_ids: &[String]) -> Result<Vec<CashActivity>> {
        if activity_ids.is_empty() {
            return Ok(Vec::new());
        }
        let s = self.settings.get().await?;
        if !s.enabled || s.account_ids.is_empty() {
            return Ok(Vec::new());
        }

        let TargetAccounts {
            ids: target_accounts,
            types: account_types,
            ..
        } = self.resolve_target_accounts(None, &s.account_ids)?;
        if target_accounts.is_empty() {
            return Ok(Vec::new());
        }

        let allowed_accounts: HashSet<&str> = target_accounts.iter().map(String::as_str).collect();
        let context_activities = self
            .activity_repo
            .get_activities_by_account_ids(&target_accounts)
            .map_err(|e| anyhow::anyhow!(e.to_string()))?;
        let transfer_link_resolution = self.transfer_link_resolution()?;
        let transfer_context_acts: Vec<&Activity> = context_activities.iter().collect();
        let transfer_groups = within_spending_transfer_groups(&transfer_context_acts);
        let requested_ids: HashSet<&str> = activity_ids.iter().map(String::as_str).collect();
        let mut activities = context_activities
            .into_iter()
            .filter(|activity| requested_ids.contains(activity.id.as_str()))
            .filter(|activity| allowed_accounts.contains(activity.account_id.as_str()))
            .collect::<Vec<_>>();
        retain_classified_cash_activities(&mut activities, &account_types);

        let ids: Vec<String> = activities.iter().map(|a| a.id.clone()).collect();
        let asgs = self.assignments.list_for_activities(&ids).await?;
        let mut by_activity = group_assignments_owned(asgs);
        let splits = self.splits.list_for_activities(&ids).await?;
        let mut splits_by_activity = group_splits_owned(splits);
        let mut tag_map = self.activity_events.list_for_activities(&ids).await?;
        Ok(activities
            .into_iter()
            .map(|activity| {
                let assignments = by_activity.remove(&activity.id).unwrap_or_default();
                let splits = splits_by_activity.remove(&activity.id).unwrap_or_default();
                let event_id = tag_map.remove(&activity.id);
                let cash_flow_bucket =
                    cash_flow_bucket_for(&activity, &account_types, &transfer_groups);
                let transfer_link_status =
                    transfer_link_status_for(&activity, &transfer_link_resolution);
                let net_amount = decimal_to_f64(net_amount(&activity, &account_types));
                CashActivity {
                    activity,
                    cash_flow_bucket,
                    assignments,
                    splits,
                    event_id,
                    transfer_link_status,
                    net_amount,
                    net_amount_base: None,
                }
            })
            .collect())
    }

    pub async fn list_assignments(
        &self,
        activity_id: &str,
    ) -> Result<Vec<ActivityTaxonomyAssignment>> {
        self.ensure_activity_in_spending_scope(activity_id).await?;
        self.assignments.list_for_activity(activity_id).await
    }

    pub async fn assign_category(
        &self,
        activity_id: &str,
        taxonomy_id: &str,
        category_id: &str,
    ) -> Result<ActivityTaxonomyAssignment> {
        self.ensure_activity_assignment_allowed(activity_id, taxonomy_id, true)
            .await?;
        self.assignments
            .assign_single_clearing_splits(activity_id, taxonomy_id, category_id)
            .await
    }

    pub async fn unassign_category(&self, activity_id: &str, taxonomy_id: &str) -> Result<()> {
        self.ensure_activity_assignment_allowed(activity_id, taxonomy_id, false)
            .await?;
        self.assignments.unassign(activity_id, taxonomy_id).await
    }

    pub async fn bulk_assign_categories(
        &self,
        items: &[BulkCategoryAssignment],
    ) -> Result<Vec<ActivityTaxonomyAssignment>> {
        for item in items {
            self.ensure_activity_assignment_allowed(&item.activity_id, &item.taxonomy_id, true)
                .await?;
        }
        self.assignments
            .assign_many_single_select_clearing_splits(items)
            .await
    }

    pub async fn list_splits(&self, activity_id: &str) -> Result<Vec<ActivitySplit>> {
        self.ensure_activity_in_spending_scope(activity_id).await?;
        self.splits.list_for_activity(activity_id).await
    }

    pub async fn replace_splits(
        &self,
        activity_id: &str,
        splits: Vec<NewActivitySplit>,
    ) -> Result<Vec<ActivitySplit>> {
        let (activity, expected_taxonomy) = self.ensure_activity_split_allowed(activity_id).await?;
        if splits.is_empty() {
            return Err(SpendingError::InvalidInput {
                message: "Split transactions require at least one line".to_string(),
            }
            .into());
        }

        let mut sum = Decimal::ZERO;
        let mut category_ids = Vec::with_capacity(splits.len());
        for split in &splits {
            if split.taxonomy_id != expected_taxonomy {
                return Err(SpendingError::InvalidInput {
                    message: "Split line taxonomy must match the activity cash-flow bucket"
                        .to_string(),
                }
                .into());
            }
            if split.amount <= Decimal::ZERO {
                return Err(SpendingError::InvalidInput {
                    message: "Split line amounts must be positive".to_string(),
                }
                .into());
            }
            category_ids.push(split.category_id.clone());
            sum += split.amount;
        }

        if !self
            .splits
            .categories_belong_to_taxonomy(expected_taxonomy, &category_ids)
            .await?
        {
            return Err(SpendingError::InvalidInput {
                message: "Split line categories must belong to the activity cash-flow taxonomy"
                    .to_string(),
            }
            .into());
        }

        let expected_total = activity_abs_amount(&activity);
        if sum != expected_total {
            return Err(SpendingError::InvalidInput {
                message: format!(
                    "Split line total must equal the transaction amount ({})",
                    expected_total
                ),
            }
            .into());
        }

        self.splits
            .replace_for_activity_clearing_assignment(activity_id, expected_taxonomy, splits)
            .await
    }

    pub async fn clear_splits(&self, activity_id: &str) -> Result<()> {
        self.ensure_activity_in_spending_scope(activity_id).await?;
        self.splits.clear_for_activity(activity_id).await
    }

    /// Set or clear the spending-event tag on an activity. Pass `None` to clear.
    /// Event date ranges describe reporting periods; they do not restrict
    /// manual tagging. This allows pre-event spending like flights or deposits
    /// to stay attached to the event they belong to.
    ///
    /// **Return contract**: returns the underlying `Activity` row, which does
    /// **not** carry the new tag — `event_id` lives on the `activity_events`
    /// join table, not on the activity row itself. Callers that need to read
    /// the post-write tag back must round-trip through `search()` / `list()`
    /// (which JOIN the tag in via `CashActivity`). The existing frontend
    /// caller (`useCashActivities`) discards this return value and refetches
    /// via the spending caches, which is the intended pattern.
    pub async fn set_event(&self, activity_id: &str, event_id: Option<String>) -> Result<Activity> {
        let activity = self.ensure_activity_in_spending_scope(activity_id).await?;
        if let Some(ref event_id) = event_id {
            self.events
                .get_event(event_id)
                .await?
                .ok_or_else(|| SpendingError::NotFound {
                    entity: "Spending event",
                    id: event_id.clone(),
                })?;
        }
        self.activity_events
            .set_activity_event_tag(activity_id, event_id)
            .await?;
        Ok(activity)
    }

    fn resolve_target_accounts(
        &self,
        requested: Option<Vec<String>>,
        opted_in: &[String],
    ) -> Result<TargetAccounts> {
        let target_accounts: Vec<String> = match requested {
            Some(ids) => ids.into_iter().filter(|id| opted_in.contains(id)).collect(),
            None => opted_in.to_vec(),
        };
        if target_accounts.is_empty() {
            return Ok(TargetAccounts {
                ids: target_accounts,
                types: HashMap::new(),
                currencies: HashMap::new(),
            });
        }

        let accounts = self
            .account_repo
            .list(None, Some(false), Some(&target_accounts))
            .map_err(|e| anyhow::anyhow!(e.to_string()))?;
        let spending_accounts: Vec<_> = accounts
            .into_iter()
            .filter(|account| {
                account_supports_purpose(&account.account_type, AccountPurpose::Spending)
            })
            .collect();
        let currencies: HashMap<String, String> = spending_accounts
            .iter()
            .map(|account| (account.id.clone(), account.currency.clone()))
            .collect();
        let types: HashMap<String, String> = spending_accounts
            .into_iter()
            .map(|account| (account.id, account.account_type))
            .collect();

        let ids = target_accounts
            .into_iter()
            .filter(|id| types.contains_key(id))
            .collect();

        Ok(TargetAccounts {
            ids,
            types,
            currencies,
        })
    }

    fn transfer_link_resolution(&self) -> Result<TransferPairResolution> {
        let activities = self
            .activity_repo
            .get_activities()
            .map_err(|e| anyhow::anyhow!(e.to_string()))?;
        Ok(TransferPairResolution::from_activities(&activities))
    }

    async fn ensure_activity_assignment_allowed(
        &self,
        activity_id: &str,
        taxonomy_id: &str,
        enforce_bucket: bool,
    ) -> Result<Activity> {
        if taxonomy_id != SPENDING_TAXONOMY
            && taxonomy_id != INCOME_TAXONOMY
            && taxonomy_id != SAVINGS_TAXONOMY
        {
            return Err(SpendingError::InvalidInput {
                message: "Taxonomy is not assignable to spending activities".to_string(),
            }
            .into());
        }
        let activity = self.ensure_activity_in_spending_scope(activity_id).await?;
        if !enforce_bucket {
            return Ok(activity);
        }

        let s = self.settings.get().await?;
        let TargetAccounts {
            ids: target_accounts,
            types: account_types,
            ..
        } = self.resolve_target_accounts(None, &s.account_ids)?;
        let Some(account_type) = account_types.get(&activity.account_id) else {
            return Err(SpendingError::InvalidInput {
                message: "Activity account does not support spending tracking".to_string(),
            }
            .into());
        };
        let context_activities = self
            .activity_repo
            .get_activities_by_account_ids(&target_accounts)
            .map_err(|e| anyhow::anyhow!(e.to_string()))?;
        let transfer_context_acts: Vec<&Activity> = context_activities.iter().collect();
        let transfer_groups = within_spending_transfer_groups(&transfer_context_acts);
        let bucket = cash_flow_bucket_from_classification(classify_activity_for_aggregation(
            &activity,
            account_type,
            &transfer_groups,
        ));
        let Some(expected_taxonomy) = taxonomy_for_bucket(bucket) else {
            return Err(SpendingError::InvalidInput {
                message: "Neutral transfers cannot be categorized. Change or unlink the transfer if it should count as spending.".to_string(),
            }
            .into());
        };
        if expected_taxonomy != taxonomy_id {
            return Err(SpendingError::InvalidInput {
                message: format!(
                    "{} activities can only use {} categories. Categories label the cash-flow bucket; they do not change it.",
                    bucket.label(),
                    bucket.taxonomy_label(),
                ),
            }
            .into());
        }

        Ok(activity)
    }

    async fn ensure_activity_split_allowed(
        &self,
        activity_id: &str,
    ) -> Result<(Activity, &'static str)> {
        let activity = self.ensure_activity_in_spending_scope(activity_id).await?;
        let s = self.settings.get().await?;
        let TargetAccounts {
            ids: target_accounts,
            types: account_types,
            ..
        } = self.resolve_target_accounts(None, &s.account_ids)?;
        let Some(account_type) = account_types.get(&activity.account_id) else {
            return Err(SpendingError::InvalidInput {
                message: "Activity account does not support spending tracking".to_string(),
            }
            .into());
        };
        let context_activities = self
            .activity_repo
            .get_activities_by_account_ids(&target_accounts)
            .map_err(|e| anyhow::anyhow!(e.to_string()))?;
        let transfer_context_acts: Vec<&Activity> = context_activities.iter().collect();
        let transfer_groups = within_spending_transfer_groups(&transfer_context_acts);
        let bucket = cash_flow_bucket_from_classification(classify_activity_for_aggregation(
            &activity,
            account_type,
            &transfer_groups,
        ));
        let Some(expected_taxonomy) = taxonomy_for_bucket(bucket) else {
            return Err(SpendingError::InvalidInput {
                message: "Neutral transfers cannot be split. Change or unlink the transfer if it should count as spending.".to_string(),
            }
            .into());
        };
        if activity_abs_amount(&activity) <= Decimal::ZERO {
            return Err(SpendingError::InvalidInput {
                message: "Split transactions require a non-zero activity amount".to_string(),
            }
            .into());
        }
        Ok((activity, expected_taxonomy))
    }

    async fn ensure_activity_in_spending_scope(&self, activity_id: &str) -> Result<Activity> {
        let s = self.settings.get().await?;
        if !s.enabled {
            return Err(SpendingError::InvalidInput {
                message: "Spending tracking is disabled".to_string(),
            }
            .into());
        }

        let activity = self
            .activity_repo
            .get_activity(activity_id)
            .map_err(|e| anyhow::anyhow!(e.to_string()))?;
        if !s.account_ids.iter().any(|id| id == &activity.account_id) {
            return Err(SpendingError::InvalidInput {
                message: "Activity account is not opted into spending tracking".to_string(),
            }
            .into());
        }

        let account = self
            .account_repo
            .get_by_id(&activity.account_id)
            .map_err(|e| anyhow::anyhow!(e.to_string()))?;
        if account.is_archived
            || !account_supports_purpose(&account.account_type, AccountPurpose::Spending)
        {
            return Err(SpendingError::InvalidInput {
                message: "Activity account does not support spending tracking".to_string(),
            }
            .into());
        }

        Ok(activity)
    }
}

fn retain_classified_cash_activities(
    activities: &mut Vec<Activity>,
    account_types: &HashMap<String, String>,
) {
    activities.retain(|activity| {
        account_types
            .get(&activity.account_id)
            .is_some_and(|account_type| is_visible_cash_activity(activity, account_type))
    });
}

fn cash_flow_bucket_for(
    activity: &Activity,
    account_types: &HashMap<String, String>,
    transfer_groups: &HashSet<String>,
) -> CashFlowBucket {
    account_types
        .get(&activity.account_id)
        .map(|account_type| {
            cash_flow_bucket_from_classification(classify_activity_for_aggregation(
                activity,
                account_type,
                transfer_groups,
            ))
        })
        .unwrap_or(CashFlowBucket::Neutral)
}

fn cash_flow_bucket_from_classification(classification: SpendingClassification) -> CashFlowBucket {
    match classification {
        SpendingClassification::Income => CashFlowBucket::Income,
        SpendingClassification::Expense | SpendingClassification::ExpenseRefund => {
            CashFlowBucket::Spending
        }
        SpendingClassification::Saving => CashFlowBucket::Saving,
        SpendingClassification::InternalTransfer | SpendingClassification::Ignored => {
            CashFlowBucket::Neutral
        }
    }
}

fn taxonomy_for_bucket(bucket: CashFlowBucket) -> Option<&'static str> {
    match bucket {
        CashFlowBucket::Spending => Some(SPENDING_TAXONOMY),
        CashFlowBucket::Income => Some(INCOME_TAXONOMY),
        CashFlowBucket::Saving => Some(SAVINGS_TAXONOMY),
        CashFlowBucket::Neutral => None,
    }
}

fn transfer_link_status_for(
    activity: &Activity,
    resolution: &TransferPairResolution,
) -> Option<TransferLinkStatus> {
    if !matches!(
        activity.effective_type(),
        ACTIVITY_TYPE_TRANSFER_IN | ACTIVITY_TYPE_TRANSFER_OUT
    ) {
        return None;
    }
    if resolution.pair_for_activity(&activity.id).is_some() {
        return Some(TransferLinkStatus::Linked);
    }
    if activity
        .source_group_id
        .as_deref()
        .map(str::trim)
        .is_some_and(|group_id| !group_id.is_empty())
    {
        return Some(TransferLinkStatus::Invalid);
    }
    Some(TransferLinkStatus::Unlinked)
}

impl CashFlowBucket {
    fn label(self) -> &'static str {
        match self {
            CashFlowBucket::Spending => "Spending",
            CashFlowBucket::Income => "Income",
            CashFlowBucket::Saving => "Saving",
            CashFlowBucket::Neutral => "Neutral",
        }
    }

    fn taxonomy_label(self) -> &'static str {
        match self {
            CashFlowBucket::Spending => "spending",
            CashFlowBucket::Income => "income",
            CashFlowBucket::Saving => "savings",
            CashFlowBucket::Neutral => "no",
        }
    }
}

fn is_visible_cash_activity(activity: &Activity, account_type: &str) -> bool {
    matches!(
        classify_activity(activity, account_type),
        SpendingClassification::Income
            | SpendingClassification::Expense
            | SpendingClassification::ExpenseRefund
    ) || is_neutral_visible_cash_activity(activity, account_type)
}

fn is_neutral_visible_cash_activity(activity: &Activity, account_type: &str) -> bool {
    let activity_type = activity.effective_type();
    // Credit-card payment received (incoming transfer to the card).
    if account_type == account_types::CREDIT_CARD && activity_type == "TRANSFER_IN" {
        return true;
    }
    // Linked transfers touching a cash account — savings moves to investing
    // accounts and internal moves between cash accounts. Always shown in the
    // ledger (we never hide an account's transactions); the totals layer
    // decides saving vs neutral via classify_activity_for_aggregation.
    account_type == account_types::CASH
        && matches!(activity_type, "TRANSFER_IN" | "TRANSFER_OUT")
        && activity.source_group_id.is_some()
}

fn group_assignments(
    assignments: &[ActivityTaxonomyAssignment],
) -> HashMap<&str, Vec<&ActivityTaxonomyAssignment>> {
    let mut map: HashMap<&str, Vec<&ActivityTaxonomyAssignment>> = HashMap::new();
    for a in assignments {
        map.entry(a.activity_id.as_str()).or_default().push(a);
    }
    map
}

fn group_splits(splits: &[ActivitySplit]) -> HashMap<&str, Vec<&ActivitySplit>> {
    let mut map: HashMap<&str, Vec<&ActivitySplit>> = HashMap::new();
    for split in splits {
        map.entry(split.activity_id.as_str())
            .or_default()
            .push(split);
    }
    map
}

fn retain_by_date_range(
    activities: &mut Vec<Activity>,
    start_date: Option<&str>,
    end_date: Option<&str>,
) -> Result<()> {
    let start = parse_filter_datetime(start_date)?;
    let end = parse_filter_datetime(end_date)?;

    if start.is_some() || end.is_some() {
        activities
            .retain(|a| activity_date_in_range(&a.activity_date, start.as_ref(), end.as_ref()));
    }

    Ok(())
}

fn parse_filter_datetime(value: Option<&str>) -> Result<Option<DateTime<Utc>>> {
    value
        .map(|value| DateTime::parse_from_rfc3339(value).map(|date| date.with_timezone(&Utc)))
        .transpose()
        .map_err(Into::into)
}

fn activity_date_in_range(
    activity_date: &DateTime<Utc>,
    start: Option<&DateTime<Utc>>,
    end: Option<&DateTime<Utc>>,
) -> bool {
    start.is_none_or(|start| activity_date >= start) && end.is_none_or(|end| activity_date <= end)
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use async_trait::async_trait;
    use chrono::{NaiveDate, NaiveDateTime};
    use rust_decimal::Decimal;
    use wealthfolio_core::accounts::{
        Account, AccountRepositoryTrait, AccountUpdate, NewAccount, TrackingMode,
    };
    use wealthfolio_core::activities::{
        ActivityBulkMutationResult, ActivitySearchResponse, ActivityStatus, ActivityUpdate,
        ActivityUpsert, BulkUpsertResult, ImportMapping, ImportTemplate, IncomeData, NewActivity,
        Sort,
    };
    use wealthfolio_core::limits::ContributionActivity;

    use super::*;
    use crate::activity_assignments::NewActivityTaxonomyAssignment;
    use crate::events::{Event, EventType, NewEvent, NewEventType, UpdateEvent};
    use crate::settings::{
        SpendingSettingsRepositoryTrait, SETTING_KEY_ACCOUNT_IDS, SETTING_KEY_ENABLED,
    };

    fn now_naive() -> NaiveDateTime {
        Utc::now().naive_utc()
    }

    fn activity(activity_type: &str) -> Activity {
        Activity {
            id: "activity-1".to_string(),
            account_id: "account-1".to_string(),
            asset_id: None,
            activity_type: activity_type.to_string(),
            activity_type_override: None,
            source_type: None,
            subtype: None,
            status: ActivityStatus::Posted,
            activity_date: Utc::now(),
            settlement_date: None,
            quantity: None,
            unit_price: None,
            amount: Some(Decimal::new(100, 0)),
            fee: None,
            tax: None,
            currency: "USD".to_string(),
            fx_rate: None,
            notes: None,
            metadata: None,
            source_system: None,
            source_record_id: None,
            source_group_id: None,
            idempotency_key: None,
            import_run_id: None,
            is_user_modified: false,
            needs_review: false,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        }
    }

    #[derive(Default)]
    struct MockSettingsRepo {
        disabled: bool,
        account_ids: Option<Vec<String>>,
    }

    #[async_trait]
    impl SpendingSettingsRepositoryTrait for MockSettingsRepo {
        async fn get_setting(&self, key: &str) -> Result<Option<String>> {
            match key {
                SETTING_KEY_ENABLED => Ok(Some((!self.disabled).to_string())),
                SETTING_KEY_ACCOUNT_IDS => Ok(Some(serde_json::to_string(
                    &self
                        .account_ids
                        .clone()
                        .unwrap_or_else(|| vec!["account-1".to_string()]),
                )?)),
                _ => Ok(None),
            }
        }

        async fn set_setting(&self, _: &str, _: &str) -> Result<()> {
            unimplemented!()
        }

        async fn set_settings(&self, _: Vec<(String, String)>) -> Result<()> {
            unimplemented!()
        }
    }

    struct MockAccountRepo {
        account: Account,
    }

    #[async_trait]
    impl AccountRepositoryTrait for MockAccountRepo {
        async fn create(&self, _: NewAccount) -> wealthfolio_core::Result<Account> {
            unimplemented!()
        }

        async fn update(&self, _: AccountUpdate) -> wealthfolio_core::Result<Account> {
            unimplemented!()
        }

        async fn delete(&self, _: &str) -> wealthfolio_core::Result<usize> {
            unimplemented!()
        }

        fn get_by_id(&self, account_id: &str) -> wealthfolio_core::Result<Account> {
            if self.account.id == account_id {
                Ok(self.account.clone())
            } else {
                Err(wealthfolio_core::errors::Error::Validation(
                    wealthfolio_core::errors::ValidationError::InvalidInput("not found".into()),
                ))
            }
        }

        fn list(
            &self,
            is_active_filter: Option<bool>,
            is_archived_filter: Option<bool>,
            account_ids: Option<&[String]>,
        ) -> wealthfolio_core::Result<Vec<Account>> {
            let include = account_ids
                .map(|ids| ids.iter().any(|id| id == &self.account.id))
                .unwrap_or(true)
                && is_active_filter
                    .map(|active| active == self.account.is_active)
                    .unwrap_or(true)
                && is_archived_filter
                    .map(|archived| archived == self.account.is_archived)
                    .unwrap_or(true);
            Ok(if include {
                vec![self.account.clone()]
            } else {
                Vec::new()
            })
        }
    }

    struct MockActivityRepo {
        activities: Vec<Activity>,
    }

    #[async_trait]
    impl ActivityRepositoryTrait for MockActivityRepo {
        fn get_activity(&self, activity_id: &str) -> wealthfolio_core::Result<Activity> {
            self.activities
                .iter()
                .find(|activity| activity.id == activity_id)
                .cloned()
                .ok_or_else(|| {
                    wealthfolio_core::errors::Error::Validation(
                        wealthfolio_core::errors::ValidationError::InvalidInput(
                            "not found".to_string(),
                        ),
                    )
                })
        }

        fn find_transfer_counterpart(
            &self,
            _: &str,
            _: &str,
        ) -> wealthfolio_core::Result<Option<Activity>> {
            Ok(None)
        }

        fn get_activities(&self) -> wealthfolio_core::Result<Vec<Activity>> {
            Ok(self.activities.clone())
        }

        fn get_activities_by_account_id(
            &self,
            account_id: &str,
        ) -> wealthfolio_core::Result<Vec<Activity>> {
            Ok(self
                .activities
                .iter()
                .filter(|activity| activity.account_id == account_id)
                .cloned()
                .collect())
        }

        fn get_activities_by_account_ids(
            &self,
            account_ids: &[String],
        ) -> wealthfolio_core::Result<Vec<Activity>> {
            Ok(self
                .activities
                .iter()
                .filter(|activity| account_ids.iter().any(|id| id == &activity.account_id))
                .cloned()
                .collect())
        }

        fn get_trading_activities(&self) -> wealthfolio_core::Result<Vec<Activity>> {
            unimplemented!()
        }

        fn get_income_activities(&self) -> wealthfolio_core::Result<Vec<Activity>> {
            unimplemented!()
        }

        fn get_contribution_activities(
            &self,
            _: &[String],
            _: DateTime<Utc>,
            _: DateTime<Utc>,
        ) -> wealthfolio_core::Result<Vec<ContributionActivity>> {
            unimplemented!()
        }

        fn search_activities(
            &self,
            _: i64,
            _: i64,
            _: Option<Vec<String>>,
            _: Option<Vec<String>>,
            _: Option<String>,
            _: Option<Sort>,
            _: Option<bool>,
            _: Option<chrono::NaiveDate>,
            _: Option<chrono::NaiveDate>,
            _: Option<Vec<String>>,
            _: Option<Vec<String>>,
        ) -> wealthfolio_core::Result<ActivitySearchResponse> {
            unimplemented!()
        }

        async fn create_activity(&self, _: NewActivity) -> wealthfolio_core::Result<Activity> {
            unimplemented!()
        }

        async fn update_activity(&self, _: ActivityUpdate) -> wealthfolio_core::Result<Activity> {
            unimplemented!()
        }

        async fn delete_activity(&self, _: String) -> wealthfolio_core::Result<Activity> {
            unimplemented!()
        }

        async fn link_transfer_activities(
            &self,
            _: String,
            _: String,
        ) -> wealthfolio_core::Result<(Activity, Activity)> {
            unimplemented!()
        }

        async fn unlink_transfer_activities(
            &self,
            _: String,
            _: String,
        ) -> wealthfolio_core::Result<(Activity, Activity)> {
            unimplemented!()
        }

        async fn bulk_mutate_activities(
            &self,
            _: Vec<NewActivity>,
            _: Vec<ActivityUpdate>,
            _: Vec<String>,
        ) -> wealthfolio_core::Result<ActivityBulkMutationResult> {
            unimplemented!()
        }

        async fn create_activities(&self, _: Vec<NewActivity>) -> wealthfolio_core::Result<usize> {
            unimplemented!()
        }

        fn get_first_activity_date(
            &self,
            _: Option<&[String]>,
        ) -> wealthfolio_core::Result<Option<DateTime<Utc>>> {
            unimplemented!()
        }

        fn get_import_mapping(
            &self,
            _: &str,
            _: &str,
        ) -> wealthfolio_core::Result<Option<ImportMapping>> {
            unimplemented!()
        }

        async fn save_import_mapping(&self, _: &ImportMapping) -> wealthfolio_core::Result<()> {
            unimplemented!()
        }

        async fn link_account_template(
            &self,
            _: &str,
            _: &str,
            _: &str,
        ) -> wealthfolio_core::Result<()> {
            unimplemented!()
        }

        fn list_import_templates(&self) -> wealthfolio_core::Result<Vec<ImportTemplate>> {
            unimplemented!()
        }

        fn get_import_template(&self, _: &str) -> wealthfolio_core::Result<Option<ImportTemplate>> {
            unimplemented!()
        }

        async fn save_import_template(&self, _: &ImportTemplate) -> wealthfolio_core::Result<()> {
            unimplemented!()
        }

        async fn delete_import_template(&self, _: &str) -> wealthfolio_core::Result<()> {
            unimplemented!()
        }

        fn get_broker_sync_profile(
            &self,
            _: &str,
            _: &str,
        ) -> wealthfolio_core::Result<Option<ImportTemplate>> {
            unimplemented!()
        }

        async fn save_broker_sync_profile(
            &self,
            _: &ImportTemplate,
        ) -> wealthfolio_core::Result<()> {
            unimplemented!()
        }

        async fn link_broker_sync_profile(
            &self,
            _: &str,
            _: &str,
            _: &str,
        ) -> wealthfolio_core::Result<()> {
            unimplemented!()
        }

        fn calculate_average_cost(&self, _: &str, _: &str) -> wealthfolio_core::Result<Decimal> {
            unimplemented!()
        }

        fn get_income_activities_data(
            &self,
            _: Option<&[String]>,
        ) -> wealthfolio_core::Result<Vec<IncomeData>> {
            unimplemented!()
        }

        fn get_first_activity_date_overall(&self) -> wealthfolio_core::Result<DateTime<Utc>> {
            unimplemented!()
        }

        fn get_activity_bounds_for_assets(
            &self,
            _: &[String],
        ) -> wealthfolio_core::Result<
            std::collections::HashMap<
                String,
                (Option<chrono::NaiveDate>, Option<chrono::NaiveDate>),
            >,
        > {
            unimplemented!()
        }

        fn get_holdings_snapshot_bounds_for_assets(
            &self,
            _: &[String],
        ) -> wealthfolio_core::Result<
            std::collections::HashMap<
                String,
                (Option<chrono::NaiveDate>, Option<chrono::NaiveDate>),
            >,
        > {
            unimplemented!()
        }

        fn check_existing_duplicates(
            &self,
            _: &[String],
        ) -> wealthfolio_core::Result<std::collections::HashMap<String, String>> {
            unimplemented!()
        }

        async fn bulk_upsert(
            &self,
            _: Vec<ActivityUpsert>,
        ) -> wealthfolio_core::Result<BulkUpsertResult> {
            unimplemented!()
        }

        async fn reassign_asset(&self, _: &str, _: &str) -> wealthfolio_core::Result<u32> {
            unimplemented!()
        }

        async fn get_activity_accounts_and_currencies_by_asset_id(
            &self,
            _: &str,
        ) -> wealthfolio_core::Result<(Vec<String>, Vec<String>)> {
            unimplemented!()
        }
    }

    #[derive(Default)]
    struct MockAssignmentRepo {
        cleared: Mutex<Vec<(String, String)>>,
        assignments: Mutex<Vec<ActivityTaxonomyAssignment>>,
    }

    #[async_trait]
    impl crate::activity_assignments::ActivityTaxonomyAssignmentRepositoryTrait for MockAssignmentRepo {
        async fn list_for_activity(&self, _: &str) -> Result<Vec<ActivityTaxonomyAssignment>> {
            Ok(Vec::new())
        }

        async fn list_for_activities(
            &self,
            ids: &[String],
        ) -> Result<Vec<ActivityTaxonomyAssignment>> {
            Ok(self
                .assignments
                .lock()
                .unwrap()
                .iter()
                .filter(|assignment| ids.contains(&assignment.activity_id))
                .cloned()
                .collect())
        }

        async fn upsert(
            &self,
            _: NewActivityTaxonomyAssignment,
        ) -> Result<ActivityTaxonomyAssignment> {
            unimplemented!()
        }

        async fn assign_many_single_select(
            &self,
            _: Vec<NewActivityTaxonomyAssignment>,
        ) -> Result<Vec<ActivityTaxonomyAssignment>> {
            unimplemented!()
        }

        async fn assign_many_single_select_clearing_splits(
            &self,
            _: Vec<NewActivityTaxonomyAssignment>,
        ) -> Result<Vec<ActivityTaxonomyAssignment>> {
            unimplemented!()
        }

        async fn assign_rule_many_single_select(
            &self,
            _: Vec<NewActivityTaxonomyAssignment>,
            _: bool,
        ) -> Result<Vec<ActivityTaxonomyAssignment>> {
            unimplemented!()
        }

        async fn delete(&self, _: &str) -> Result<()> {
            unimplemented!()
        }

        async fn clear_for_taxonomy(&self, activity_id: &str, taxonomy_id: &str) -> Result<()> {
            self.cleared
                .lock()
                .unwrap()
                .push((activity_id.to_string(), taxonomy_id.to_string()));
            Ok(())
        }
    }

    #[derive(Default)]
    struct MockSplitRepo {
        replaced: Mutex<Vec<(String, Vec<NewActivitySplit>)>>,
        assignment_clears: Mutex<Vec<(String, String)>>,
        cleared: Mutex<Vec<String>>,
        categories_valid: Mutex<bool>,
        splits: Mutex<Vec<ActivitySplit>>,
    }

    #[async_trait]
    impl ActivitySplitRepositoryTrait for MockSplitRepo {
        async fn list_for_activity(&self, _: &str) -> Result<Vec<ActivitySplit>> {
            Ok(Vec::new())
        }

        async fn list_for_activities(&self, ids: &[String]) -> Result<Vec<ActivitySplit>> {
            Ok(self
                .splits
                .lock()
                .unwrap()
                .iter()
                .filter(|split| ids.contains(&split.activity_id))
                .cloned()
                .collect())
        }

        async fn categories_belong_to_taxonomy(&self, _: &str, _: &[String]) -> Result<bool> {
            Ok(*self.categories_valid.lock().unwrap())
        }

        async fn replace_for_activity(
            &self,
            activity_id: &str,
            splits: Vec<NewActivitySplit>,
        ) -> Result<Vec<ActivitySplit>> {
            self.replaced
                .lock()
                .unwrap()
                .push((activity_id.to_string(), splits.clone()));
            Ok(splits
                .into_iter()
                .enumerate()
                .map(|(index, split)| ActivitySplit {
                    id: format!("split-{index}"),
                    activity_id: activity_id.to_string(),
                    taxonomy_id: split.taxonomy_id,
                    category_id: split.category_id,
                    amount: split.amount,
                    note: split.note,
                    sort_order: split.sort_order.unwrap_or(index as i32),
                    created_at: now_naive(),
                    updated_at: now_naive(),
                })
                .collect())
        }

        async fn replace_for_activity_clearing_assignment(
            &self,
            activity_id: &str,
            taxonomy_id: &str,
            splits: Vec<NewActivitySplit>,
        ) -> Result<Vec<ActivitySplit>> {
            self.assignment_clears
                .lock()
                .unwrap()
                .push((activity_id.to_string(), taxonomy_id.to_string()));
            self.replace_for_activity(activity_id, splits).await
        }

        async fn clear_for_activity(&self, activity_id: &str) -> Result<()> {
            self.cleared.lock().unwrap().push(activity_id.to_string());
            Ok(())
        }
    }

    #[derive(Default)]
    struct MockActivityEventsRepo {
        tags: HashMap<String, String>,
    }

    #[async_trait]
    impl crate::activity_events::ActivityEventsRepositoryTrait for MockActivityEventsRepo {
        async fn list_for_activities(
            &self,
            ids: &[String],
        ) -> Result<std::collections::HashMap<String, String>> {
            Ok(self
                .tags
                .iter()
                .filter(|(id, _)| ids.contains(id))
                .map(|(id, tag)| (id.clone(), tag.clone()))
                .collect())
        }

        async fn list_for_event(&self, _: &str) -> Result<Vec<String>> {
            Ok(Vec::new())
        }

        async fn set_activity_event_tag(&self, _: &str, _: Option<String>) -> Result<()> {
            Ok(())
        }

        async fn delete_by_event(&self, _: &str) -> Result<usize> {
            Ok(0)
        }

        async fn list_all(&self) -> Result<Vec<crate::activity_events::ActivityEvent>> {
            Ok(Vec::new())
        }
    }

    #[derive(Default)]
    struct MockEventTypesRepo;

    #[async_trait]
    impl crate::events::EventTypesRepositoryTrait for MockEventTypesRepo {
        async fn list(&self) -> Result<Vec<EventType>> {
            Ok(Vec::new())
        }

        async fn create(&self, _: NewEventType) -> Result<EventType> {
            unimplemented!()
        }

        async fn update(
            &self,
            _: &str,
            _: Option<String>,
            _: Option<Option<String>>,
        ) -> Result<EventType> {
            unimplemented!()
        }

        async fn delete(&self, _: &str) -> Result<()> {
            unimplemented!()
        }
    }

    #[derive(Default)]
    struct MockEventsRepo;

    #[async_trait]
    impl crate::events::EventsRepositoryTrait for MockEventsRepo {
        async fn list(&self) -> Result<Vec<Event>> {
            Ok(Vec::new())
        }

        async fn get(&self, _: &str) -> Result<Option<Event>> {
            Ok(None)
        }

        async fn create(&self, _: NewEvent) -> Result<Event> {
            unimplemented!()
        }

        async fn update(&self, _: &str, _: UpdateEvent) -> Result<Event> {
            unimplemented!()
        }

        async fn delete(&self, _: &str) -> Result<()> {
            unimplemented!()
        }

        async fn count_by_type(&self, _: &str) -> Result<usize> {
            Ok(0)
        }
    }

    fn account(account_type: &str) -> Account {
        Account {
            id: "account-1".to_string(),
            name: "Checking".to_string(),
            account_type: account_type.to_string(),
            group: None,
            currency: "USD".to_string(),
            is_default: false,
            is_active: true,
            created_at: now_naive(),
            updated_at: now_naive(),
            platform_id: None,
            account_number: None,
            meta: None,
            provider: None,
            provider_account_id: None,
            is_archived: false,
            tracking_mode: TrackingMode::Transactions,
        }
    }

    fn split(category_id: &str, amount: i64, taxonomy_id: &str) -> NewActivitySplit {
        NewActivitySplit {
            taxonomy_id: taxonomy_id.to_string(),
            category_id: category_id.to_string(),
            amount: Decimal::new(amount, 0),
            note: None,
            sort_order: None,
        }
    }

    /// Records the dates conversions were requested for, so a test can assert
    /// which day's rate a row was priced at.
    #[derive(Default)]
    struct DateCapturingFx {
        dates: std::sync::Mutex<Vec<chrono::NaiveDate>>,
        rates: HashMap<chrono::NaiveDate, Decimal>,
    }

    #[async_trait]
    impl wealthfolio_core::fx::FxServiceTrait for DateCapturingFx {
        fn initialize(&self) -> wealthfolio_core::Result<()> {
            Ok(())
        }
        fn get_historical_rates(
            &self,
            _: &str,
            _: &str,
            _: i64,
        ) -> wealthfolio_core::Result<Vec<wealthfolio_core::fx::ExchangeRate>> {
            Ok(vec![])
        }
        fn get_latest_exchange_rate(&self, _: &str, _: &str) -> wealthfolio_core::Result<Decimal> {
            Ok(Decimal::ONE)
        }
        fn get_exchange_rate_for_date(
            &self,
            _: &str,
            _: &str,
            date: chrono::NaiveDate,
        ) -> wealthfolio_core::Result<Decimal> {
            self.dates.lock().unwrap().push(date);
            Ok(Decimal::ONE)
        }
        fn convert_currency(
            &self,
            amount: Decimal,
            _: &str,
            _: &str,
        ) -> wealthfolio_core::Result<Decimal> {
            Ok(amount)
        }
        fn convert_currency_for_date(
            &self,
            amount: Decimal,
            _: &str,
            _: &str,
            date: chrono::NaiveDate,
        ) -> wealthfolio_core::Result<Decimal> {
            self.dates.lock().unwrap().push(date);
            Ok(amount * self.rates.get(&date).copied().unwrap_or(Decimal::ONE))
        }
        fn get_latest_exchange_rates(
            &self,
        ) -> wealthfolio_core::Result<Vec<wealthfolio_core::fx::ExchangeRate>> {
            Ok(vec![])
        }
        async fn add_exchange_rate(
            &self,
            _: wealthfolio_core::fx::NewExchangeRate,
        ) -> wealthfolio_core::Result<wealthfolio_core::fx::ExchangeRate> {
            unimplemented!("read-only")
        }
        async fn update_exchange_rate(
            &self,
            _: &str,
            _: &str,
            _: Decimal,
        ) -> wealthfolio_core::Result<wealthfolio_core::fx::ExchangeRate> {
            unimplemented!("read-only")
        }
        async fn delete_exchange_rate(&self, _: &str) -> wealthfolio_core::Result<()> {
            Ok(())
        }
        async fn register_currency_pair(&self, _: &str, _: &str) -> wealthfolio_core::Result<()> {
            Ok(())
        }
        async fn register_currency_pair_manual(
            &self,
            _: &str,
            _: &str,
        ) -> wealthfolio_core::Result<()> {
            Ok(())
        }
        async fn ensure_fx_pairs(&self, _: Vec<(String, String)>) -> wealthfolio_core::Result<()> {
            Ok(())
        }
    }

    /// FX stub keyed by source currency. A currency absent from the map has no
    /// rate at all, which is the only way `convert` fails once the real service
    /// has exhausted its nearest-date and latest-rate fallbacks.
    struct MockFx {
        rates: HashMap<String, Decimal>,
    }

    impl MockFx {
        fn none() -> Arc<Self> {
            Arc::new(Self {
                rates: HashMap::new(),
            })
        }

        fn with(pairs: &[(&str, i64, u32)]) -> Arc<Self> {
            Arc::new(Self {
                rates: pairs
                    .iter()
                    .map(|(currency, mantissa, scale)| {
                        (currency.to_string(), Decimal::new(*mantissa, *scale))
                    })
                    .collect(),
            })
        }

        fn rate(&self, from: &str) -> wealthfolio_core::Result<Decimal> {
            self.rates.get(from).copied().ok_or_else(|| {
                wealthfolio_core::errors::Error::Validation(
                    wealthfolio_core::errors::ValidationError::InvalidInput(format!(
                        "no rate for {from}"
                    )),
                )
            })
        }
    }

    #[async_trait]
    impl wealthfolio_core::fx::FxServiceTrait for MockFx {
        fn initialize(&self) -> wealthfolio_core::Result<()> {
            Ok(())
        }
        fn get_historical_rates(
            &self,
            _: &str,
            _: &str,
            _: i64,
        ) -> wealthfolio_core::Result<Vec<wealthfolio_core::fx::ExchangeRate>> {
            Ok(vec![])
        }
        fn get_latest_exchange_rate(
            &self,
            from: &str,
            _: &str,
        ) -> wealthfolio_core::Result<Decimal> {
            self.rate(from)
        }
        fn get_exchange_rate_for_date(
            &self,
            from: &str,
            _: &str,
            _: chrono::NaiveDate,
        ) -> wealthfolio_core::Result<Decimal> {
            self.rate(from)
        }
        fn convert_currency(
            &self,
            amount: Decimal,
            from: &str,
            _: &str,
        ) -> wealthfolio_core::Result<Decimal> {
            Ok(amount * self.rate(from)?)
        }
        fn convert_currency_for_date(
            &self,
            amount: Decimal,
            from: &str,
            _: &str,
            _: chrono::NaiveDate,
        ) -> wealthfolio_core::Result<Decimal> {
            Ok(amount * self.rate(from)?)
        }
        fn get_latest_exchange_rates(
            &self,
        ) -> wealthfolio_core::Result<Vec<wealthfolio_core::fx::ExchangeRate>> {
            Ok(vec![])
        }
        async fn add_exchange_rate(
            &self,
            _: wealthfolio_core::fx::NewExchangeRate,
        ) -> wealthfolio_core::Result<wealthfolio_core::fx::ExchangeRate> {
            unimplemented!("MockFx is read-only")
        }
        async fn update_exchange_rate(
            &self,
            _: &str,
            _: &str,
            _: Decimal,
        ) -> wealthfolio_core::Result<wealthfolio_core::fx::ExchangeRate> {
            unimplemented!("MockFx is read-only")
        }
        async fn delete_exchange_rate(&self, _: &str) -> wealthfolio_core::Result<()> {
            Ok(())
        }
        async fn register_currency_pair(&self, _: &str, _: &str) -> wealthfolio_core::Result<()> {
            Ok(())
        }
        async fn register_currency_pair_manual(
            &self,
            _: &str,
            _: &str,
        ) -> wealthfolio_core::Result<()> {
            Ok(())
        }
        async fn ensure_fx_pairs(&self, _: Vec<(String, String)>) -> wealthfolio_core::Result<()> {
            Ok(())
        }
    }

    fn make_service(
        activity: Activity,
    ) -> (
        CashActivityService,
        Arc<MockAssignmentRepo>,
        Arc<MockSplitRepo>,
    ) {
        make_service_with_fx(vec![activity], MockFx::none())
    }

    fn make_service_with(
        activities: Vec<Activity>,
    ) -> (
        CashActivityService,
        Arc<MockAssignmentRepo>,
        Arc<MockSplitRepo>,
    ) {
        make_service_with_fx(activities, MockFx::none())
    }

    fn make_service_with_fx(
        activities: Vec<Activity>,
        fx: Arc<dyn wealthfolio_core::fx::FxServiceTrait>,
    ) -> (
        CashActivityService,
        Arc<MockAssignmentRepo>,
        Arc<MockSplitRepo>,
    ) {
        let activity_repo = Arc::new(MockActivityRepo { activities });
        let account_repo = Arc::new(MockAccountRepo {
            account: account(account_types::CASH),
        });
        let settings = Arc::new(SpendingSettingsService::new(Arc::new(
            MockSettingsRepo::default(),
        )));
        let assignment_repo = Arc::new(MockAssignmentRepo::default());
        let assignment_service = Arc::new(ActivityTaxonomyAssignmentService::new(
            assignment_repo.clone()
                as Arc<dyn crate::activity_assignments::ActivityTaxonomyAssignmentRepositoryTrait>,
        ));
        let split_repo = Arc::new(MockSplitRepo::default());
        *split_repo.categories_valid.lock().unwrap() = true;
        let activity_events = Arc::new(MockActivityEventsRepo::default());
        let events = Arc::new(EventsService::new(
            Arc::new(MockEventTypesRepo),
            Arc::new(MockEventsRepo),
            activity_repo.clone() as Arc<dyn ActivityRepositoryTrait>,
            activity_events.clone(),
        ));
        let service = CashActivityService::new(
            activity_repo as Arc<dyn ActivityRepositoryTrait>,
            account_repo,
            settings,
            assignment_service,
            split_repo.clone(),
            activity_events,
            events,
            fx,
        );
        (service, assignment_repo, split_repo)
    }

    async fn search_net(service: &CashActivityService, base: Option<&str>) -> NetSummary {
        service
            .search(
                CashActivitySearchRequest {
                    limit: 50,
                    ..Default::default()
                },
                base,
                "UTC",
            )
            .await
            .unwrap()
            .net
            .unwrap()
    }

    /// Distinct ids keep the repo's rows separable; amounts drive the nets.
    fn cash_row(id: &str, activity_type: &str, amount: i64, currency: &str) -> Activity {
        Activity {
            id: id.to_string(),
            amount: Some(Decimal::new(amount, 0)),
            currency: currency.to_string(),
            ..activity(activity_type)
        }
    }

    fn analysis_request(
        mode: CashActivitySelectionMode,
        ids: &[&str],
    ) -> CashActivitySearchRequest {
        CashActivitySearchRequest {
            selection: Some(CashActivitySelection {
                mode,
                ids: ids.iter().map(|id| id.to_string()).collect(),
            }),
            limit: 0,
            ..Default::default()
        }
    }

    #[test]
    fn search_selection_request_round_trips_the_wire_contract() {
        for mode in ["all", "explicit"] {
            let json = serde_json::json!({
                "selection": { "mode": mode, "ids": ["synthetic-id"] },
                "offset": 0,
                "limit": 0,
            });
            let request: CashActivitySearchRequest = serde_json::from_value(json.clone()).unwrap();
            assert_eq!(
                serde_json::to_value(request).unwrap()["selection"],
                json["selection"]
            );
        }
        let request: CashActivitySearchRequest =
            serde_json::from_value(serde_json::json!({})).unwrap();
        assert!(request.selection.is_none());
        assert_eq!(request.limit, 50);
    }

    fn exact_amount(summary: &ExactMoneySummary, currency: &str) -> Decimal {
        summary
            .by_currency
            .iter()
            .find(|entry| entry.currency == currency)
            .map(|entry| entry.amount.parse().unwrap())
            .unwrap_or_default()
    }

    fn assert_partition(analysis: &CashActivityAnalysis) {
        assert_eq!(
            analysis.matching.count,
            analysis.selected.count + analysis.excluded.count
        );
        for (matching, selected, excluded) in [
            (
                &analysis.matching.cash_movement,
                &analysis.selected.cash_movement,
                &analysis.excluded.cash_movement,
            ),
            (
                &analysis.matching.spending,
                &analysis.selected.spending,
                &analysis.excluded.spending,
            ),
        ] {
            for currency in matching
                .by_currency
                .iter()
                .chain(&selected.by_currency)
                .chain(&excluded.by_currency)
            {
                assert_eq!(
                    exact_amount(matching, &currency.currency),
                    exact_amount(selected, &currency.currency)
                        + exact_amount(excluded, &currency.currency),
                );
            }
            if let Some(total) = &matching.converted {
                let selected = selected.converted.as_ref().unwrap();
                let excluded = excluded.converted.as_ref().unwrap();
                assert_eq!(total.currency, selected.currency);
                assert_eq!(total.currency, excluded.currency);
                assert_eq!(
                    total.amount.parse::<Decimal>().unwrap(),
                    selected.amount.parse::<Decimal>().unwrap()
                        + excluded.amount.parse::<Decimal>().unwrap(),
                );
            }
            let missing: BTreeSet<_> = selected
                .missing_rate_currencies
                .iter()
                .chain(&excluded.missing_rate_currencies)
                .cloned()
                .collect();
            assert_eq!(
                matching.missing_rate_currencies,
                missing.into_iter().collect::<Vec<_>>()
            );
        }
    }

    fn assignment_row(activity_id: &str, category: &str) -> ActivityTaxonomyAssignment {
        ActivityTaxonomyAssignment {
            id: format!("{activity_id}-{category}"),
            activity_id: activity_id.to_string(),
            taxonomy_id: SPENDING_TAXONOMY.to_string(),
            category_id: category.to_string(),
            weight: 10_000,
            source: "manual".to_string(),
            created_at: now_naive(),
            updated_at: now_naive(),
        }
    }

    fn split_row(activity_id: &str, category: &str, amount: &str) -> ActivitySplit {
        ActivitySplit {
            id: format!("{activity_id}-{category}"),
            activity_id: activity_id.to_string(),
            taxonomy_id: SPENDING_TAXONOMY.to_string(),
            category_id: category.to_string(),
            amount: amount.parse().unwrap(),
            note: None,
            sort_order: 0,
            created_at: now_naive(),
            updated_at: now_naive(),
        }
    }

    #[tokio::test]
    async fn search_analysis_covers_more_than_fifty_and_one_thousand_rows_before_pagination() {
        for count in [73, 1_207] {
            let rows = (0..count)
                .map(|i| {
                    let mut row = cash_row(&format!("row-{i:04}"), "WITHDRAWAL", 0, "USD");
                    row.amount = Some(Decimal::new(1, 2));
                    row
                })
                .collect();
            let (service, _, _) = make_service_with(rows);
            let mut request = analysis_request(
                CashActivitySelectionMode::All,
                &["row-0001", "row-0059", "row-1205", "unknown"],
            );
            request.limit = 50;
            let response = service
                .search(request.clone(), Some("USD"), "UTC")
                .await
                .unwrap();
            assert_eq!(response.total_count, count);
            assert_eq!(response.items.len(), 50);
            let analysis = response.analysis.unwrap();
            let excluded = if count > 1_000 { 3 } else { 2 };
            assert_eq!(analysis.matching.count, count);
            assert_eq!(analysis.selected.count, count - excluded);
            assert_eq!(analysis.excluded.count, excluded);
            assert_eq!(
                exact_amount(&analysis.matching.spending, "USD"),
                Decimal::new(count as i64, 2)
            );
            assert_eq!(
                exact_amount(&analysis.selected.spending, "USD"),
                Decimal::new((count - excluded) as i64, 2)
            );
            assert_partition(&analysis);

            request.offset = 55;
            request.limit = 0;
            let response = service
                .search(request.clone(), Some("USD"), "UTC")
                .await
                .unwrap();
            assert!(response.items.is_empty());
            assert!(response.net.is_none());
            assert_eq!(response.analysis.unwrap(), analysis);
            request.offset = 0;
            request.limit = usize::MAX;
            let response = service.search(request, Some("USD"), "UTC").await.unwrap();
            assert_eq!(response.items.len(), count.min(1_000));
            assert_eq!(response.analysis.unwrap(), analysis);
        }
    }

    #[tokio::test]
    async fn search_analysis_explicit_empty_duplicate_unknown_and_filtered_ids() {
        let mut included = cash_row("included", "WITHDRAWAL", 11, "USD");
        included.notes = Some("synthetic matched".into());
        let filtered = cash_row("filtered-out", "WITHDRAWAL", 999, "USD");
        let (service, _, _) = make_service_with(vec![included, filtered]);
        for (mode, ids, expected) in [
            (
                CashActivitySelectionMode::Explicit,
                vec!["included", "included", "unknown", "filtered-out"],
                1,
            ),
            (CashActivitySelectionMode::Explicit, vec![], 0),
            (
                CashActivitySelectionMode::Explicit,
                vec!["unknown", "filtered-out"],
                0,
            ),
            (CashActivitySelectionMode::All, vec![], 1),
            (
                CashActivitySelectionMode::All,
                vec!["included", "included"],
                0,
            ),
            (
                CashActivitySelectionMode::All,
                vec!["unknown", "filtered-out"],
                1,
            ),
        ] {
            let mut request = analysis_request(mode, &ids);
            request.search = Some("MATCHED".into());
            let analysis = service
                .search(request, Some("USD"), "UTC")
                .await
                .unwrap()
                .analysis
                .unwrap();
            assert_eq!(analysis.matching.count, 1);
            assert_eq!(analysis.selected.count, expected);
            assert_eq!(
                exact_amount(&analysis.selected.spending, "USD"),
                Decimal::new(expected as i64 * 11, 0)
            );
            assert_partition(&analysis);
        }
    }

    #[tokio::test]
    async fn search_analysis_serializes_exact_decimal_strings_without_float_aggregation() {
        let mut large = cash_row("large", "WITHDRAWAL", 0, "USD");
        large.amount = Some("9007199254740993.1".parse().unwrap());
        let mut small = cash_row("small", "WITHDRAWAL", 0, "USD");
        small.amount = Some("0.2".parse().unwrap());
        let (service, _, _) = make_service_with(vec![large, small]);
        let response = service
            .search(
                analysis_request(CashActivitySelectionMode::Explicit, &["small"]),
                Some("USD"),
                "UTC",
            )
            .await
            .unwrap();
        let json = serde_json::to_value(&response).unwrap();
        assert_eq!(
            json["analysis"]["matching"]["spending"]["byCurrency"][0]["amount"],
            "9007199254740993.3"
        );
        assert_eq!(
            json["analysis"]["matching"]["cashMovement"]["converted"]["amount"],
            "-9007199254740993.3"
        );
        assert_eq!(
            json["analysis"]["selected"]["spending"]["converted"]["amount"],
            "0.2"
        );
        assert_partition(response.analysis.as_ref().unwrap());
    }

    #[tokio::test]
    async fn search_analysis_mixed_currencies_stored_fx_and_missing_rates_are_partitioned() {
        let mut stored = cash_row("stored", "WITHDRAWAL", 10, "EUR");
        stored.fx_rate = Some(Decimal::new(15, 1));
        let (service, _, _) = make_service_with_fx(
            vec![
                stored,
                cash_row("lookup", "WITHDRAWAL", 20, "EUR"),
                cash_row("native", "WITHDRAWAL", 3, "USD"),
                cash_row("unrated", "WITHDRAWAL", 7, "GBP"),
            ],
            MockFx::with(&[("EUR", 2, 0)]),
        );
        let analysis = service
            .search(
                analysis_request(CashActivitySelectionMode::All, &["unrated"]),
                Some("USD"),
                "UTC",
            )
            .await
            .unwrap()
            .analysis
            .unwrap();
        assert_eq!(analysis.matching.spending.missing_rate_currencies, ["GBP"]);
        assert!(analysis.matching.spending.converted.is_none());
        assert!(analysis.excluded.cash_movement.converted.is_none());
        assert_eq!(
            analysis
                .selected
                .spending
                .converted
                .as_ref()
                .unwrap()
                .amount,
            "58"
        );
        assert_eq!(
            analysis
                .selected
                .cash_movement
                .converted
                .as_ref()
                .unwrap()
                .amount,
            "-58"
        );
        assert_eq!(
            exact_amount(&analysis.matching.spending, "EUR"),
            Decimal::new(30, 0)
        );
        assert_partition(&analysis);
    }

    #[tokio::test]
    async fn search_analysis_preserves_native_zero_fx_residuals_and_unrated_cancellations() {
        let mut refund = cash_row("refund", "CREDIT", 10, "EUR");
        refund.subtype = Some("REFUND".into());
        let mut debit = cash_row("debit", "WITHDRAWAL", 10, "EUR");
        debit.fx_rate = Some(Decimal::new(2, 0));
        refund.fx_rate = Some(Decimal::new(3, 0));
        let (service, _, _) = make_service_with(vec![debit.clone(), refund.clone()]);
        let analysis = service
            .search(
                analysis_request(CashActivitySelectionMode::Explicit, &["debit"]),
                Some("USD"),
                "UTC",
            )
            .await
            .unwrap()
            .analysis
            .unwrap();
        assert!(analysis.matching.spending.by_currency.is_empty());
        assert!(analysis.matching.cash_movement.by_currency.is_empty());
        assert_eq!(
            analysis
                .matching
                .spending
                .converted
                .as_ref()
                .unwrap()
                .amount,
            "-10"
        );
        assert_eq!(
            analysis
                .matching
                .cash_movement
                .converted
                .as_ref()
                .unwrap()
                .amount,
            "10"
        );
        assert_partition(&analysis);

        debit.fx_rate = None;
        refund.fx_rate = None;
        let (service, _, _) = make_service_with(vec![debit, refund]);
        let analysis = service
            .search(
                analysis_request(CashActivitySelectionMode::All, &[]),
                Some("USD"),
                "UTC",
            )
            .await
            .unwrap()
            .analysis
            .unwrap();
        assert!(analysis.matching.spending.by_currency.is_empty());
        assert!(analysis.matching.spending.converted.is_none());
        assert_eq!(analysis.matching.spending.missing_rate_currencies, ["EUR"]);
        assert_partition(&analysis);
    }

    #[tokio::test]
    async fn search_analysis_uses_each_local_date_for_fx_and_keeps_single_currency_conversion() {
        let first_date = NaiveDate::from_ymd_opt(2026, 1, 1).unwrap();
        let second_date = NaiveDate::from_ymd_opt(2026, 1, 2).unwrap();
        let fx = Arc::new(DateCapturingFx {
            dates: Mutex::new(Vec::new()),
            rates: HashMap::from([
                (first_date, Decimal::new(2, 0)),
                (second_date, Decimal::new(3, 0)),
            ]),
        });
        let mut first = cash_row("first", "WITHDRAWAL", 10, "EUR");
        first.activity_date = "2026-01-02T01:00:00Z".parse().unwrap();
        let mut second = cash_row("second", "WITHDRAWAL", 10, "EUR");
        second.activity_date = "2026-01-03T01:00:00Z".parse().unwrap();
        let (service, _, _) = make_service_with_fx(vec![first, second], fx.clone());
        let mut request = analysis_request(CashActivitySelectionMode::All, &[]);
        request.offset = 1;
        let analysis = service
            .search(request, Some("USD"), "America/Los_Angeles")
            .await
            .unwrap()
            .analysis
            .unwrap();
        assert_eq!(
            analysis
                .matching
                .spending
                .converted
                .as_ref()
                .unwrap()
                .amount,
            "50"
        );
        let dates = fx.dates.lock().unwrap();
        assert_eq!(dates.len(), 4);
        assert!(dates
            .iter()
            .all(|date| *date == first_date || *date == second_date));
        assert!(dates.contains(&first_date) && dates.contains(&second_date));
        assert_partition(&analysis);
    }

    #[tokio::test]
    async fn search_analysis_fx_override_requires_account_currency_and_nonzero_rate() {
        let mut row = cash_row("row", "WITHDRAWAL", 10, "EUR");
        row.fx_rate = Some(Decimal::new(9, 0));
        let (service, _, _) =
            make_service_with_fx(vec![row.clone()], MockFx::with(&[("EUR", 2, 0)]));
        let analysis = service
            .search(
                analysis_request(CashActivitySelectionMode::All, &[]),
                Some("GBP"),
                "UTC",
            )
            .await
            .unwrap()
            .analysis
            .unwrap();
        assert_eq!(
            analysis
                .matching
                .spending
                .converted
                .as_ref()
                .unwrap()
                .amount,
            "20"
        );
        row.fx_rate = Some(Decimal::ZERO);
        let (service, _, _) = make_service_with_fx(vec![row], MockFx::with(&[("EUR", 2, 0)]));
        let analysis = service
            .search(
                analysis_request(CashActivitySelectionMode::All, &[]),
                Some("USD"),
                "UTC",
            )
            .await
            .unwrap()
            .analysis
            .unwrap();
        assert_eq!(
            analysis
                .matching
                .spending
                .converted
                .as_ref()
                .unwrap()
                .amount,
            "20"
        );
    }

    #[tokio::test]
    async fn search_analysis_reuses_classification_for_refunds_income_savings_and_overrides() {
        let mut refund = cash_row("refund", "CREDIT", 12, "USD");
        refund.subtype = Some("REFUND".into());
        let mut saving = cash_row("saving", "TRANSFER_OUT", 200, "USD");
        saving.source_group_id = Some("to-investments".into());
        let mut incoming = cash_row("incoming", "TRANSFER_IN", 30, "USD");
        incoming.source_group_id = Some("from-investments".into());
        let mut effective = cash_row("effective", "DEPOSIT", 8, "USD");
        effective.activity_type_override = Some("WITHDRAWAL".into());
        let (service, _, _) = make_service_with(vec![
            cash_row("expense", "WITHDRAWAL", -100, "USD"),
            cash_row("income", "DEPOSIT", 500, "USD"),
            cash_row("unlinked", "TRANSFER_OUT", 4, "USD"),
            refund,
            saving,
            incoming,
            effective,
        ]);
        let analysis = service
            .search(
                analysis_request(
                    CashActivitySelectionMode::Explicit,
                    &["expense", "refund", "effective"],
                ),
                Some("USD"),
                "UTC",
            )
            .await
            .unwrap()
            .analysis
            .unwrap();
        assert_eq!(analysis.matching.count, 7);
        assert_eq!(
            exact_amount(&analysis.matching.spending, "USD"),
            Decimal::new(100, 0)
        );
        assert_eq!(
            exact_amount(&analysis.selected.spending, "USD"),
            Decimal::new(96, 0)
        );
        assert_eq!(
            exact_amount(&analysis.matching.cash_movement, "USD"),
            Decimal::new(230, 0)
        );
        assert_partition(&analysis);
    }

    #[tokio::test]
    async fn search_analysis_keeps_transfer_context_outside_date_and_type_filters() {
        let mut outbound = cash_row("outbound", "TRANSFER_OUT", 100, "USD");
        outbound.source_group_id = Some("internal".into());
        outbound.activity_date = "2026-02-01T12:00:00Z".parse().unwrap();
        let mut inbound = cash_row("inbound", "TRANSFER_IN", 100, "USD");
        inbound.source_group_id = Some("internal".into());
        inbound.activity_date = "2026-01-31T12:00:00Z".parse().unwrap();
        let (service, _, _) = make_service_with(vec![outbound, inbound]);
        let mut request = analysis_request(CashActivitySelectionMode::All, &[]);
        request.start_date = Some("2026-02-01T00:00:00Z".into());
        request.activity_types = Some(vec!["TRANSFER_OUT".into()]);
        let analysis = service
            .search(request, Some("USD"), "UTC")
            .await
            .unwrap()
            .analysis
            .unwrap();
        assert_eq!(analysis.matching.count, 1);
        assert_eq!(
            analysis
                .matching
                .cash_movement
                .converted
                .as_ref()
                .unwrap()
                .amount,
            "-100"
        );
        assert_eq!(
            analysis
                .matching
                .spending
                .converted
                .as_ref()
                .unwrap()
                .amount,
            "0"
        );
    }

    #[tokio::test]
    async fn search_analysis_credit_card_interest_refunds_and_neutral_payments() {
        let (mut service, _, _) = make_service_with(vec![
            cash_row("interest", "INTEREST", 10, "USD"),
            cash_row("refund", "CREDIT", 2, "USD"),
            cash_row("payment", "TRANSFER_IN", 100, "USD"),
        ]);
        service.account_repo = Arc::new(MockAccountRepo {
            account: account(account_types::CREDIT_CARD),
        });
        let analysis = service
            .search(
                analysis_request(CashActivitySelectionMode::All, &[]),
                Some("USD"),
                "UTC",
            )
            .await
            .unwrap()
            .analysis
            .unwrap();
        assert_eq!(analysis.matching.count, 3);
        assert_eq!(
            analysis
                .matching
                .spending
                .converted
                .as_ref()
                .unwrap()
                .amount,
            "8"
        );
        assert_eq!(
            analysis
                .matching
                .cash_movement
                .converted
                .as_ref()
                .unwrap()
                .amount,
            "92"
        );
        assert_partition(&analysis);
    }

    #[tokio::test]
    async fn search_analysis_filters_spending_allocations_but_keeps_whole_cash_movements() {
        let mut refund = cash_row("refund", "CREDIT", 20, "EUR");
        refund.subtype = Some("REFUND".into());
        let (service, assignments, splits) = make_service_with_fx(
            vec![
                cash_row("expense", "WITHDRAWAL", 100, "EUR"),
                refund,
                cash_row("assigned", "WITHDRAWAL", 3, "EUR"),
            ],
            MockFx::with(&[("EUR", 2, 0)]),
        );
        *assignments.assignments.lock().unwrap() = vec![
            assignment_row("expense", "groceries"),
            assignment_row("refund", "groceries"),
            assignment_row("assigned", "groceries"),
        ];
        *splits.splits.lock().unwrap() = vec![
            split_row("expense", "groceries", "40"),
            split_row("expense", "household", "60"),
            split_row("refund", "groceries", "10"),
            split_row("refund", "household", "10"),
        ];
        for (category_ids, subcategory_ids) in [
            (Some(vec!["groceries".into()]), None),
            (None, Some(vec!["groceries".into()])),
            (
                Some(vec!["groceries".into(), "household".into()]),
                Some(vec!["groceries".into()]),
            ),
        ] {
            let mut request = analysis_request(CashActivitySelectionMode::All, &["refund"]);
            request.category_ids = category_ids;
            request.subcategory_ids = subcategory_ids;
            let analysis = service
                .search(request, Some("USD"), "UTC")
                .await
                .unwrap()
                .analysis
                .unwrap();
            assert_eq!(analysis.matching.count, 3);
            assert_eq!(
                exact_amount(&analysis.matching.spending, "EUR"),
                Decimal::new(33, 0)
            );
            assert_eq!(
                analysis
                    .matching
                    .spending
                    .converted
                    .as_ref()
                    .unwrap()
                    .amount,
                "66"
            );
            assert_eq!(
                analysis
                    .matching
                    .cash_movement
                    .converted
                    .as_ref()
                    .unwrap()
                    .amount,
                "-166"
            );
            assert_eq!(
                analysis
                    .selected
                    .spending
                    .converted
                    .as_ref()
                    .unwrap()
                    .amount,
                "86"
            );
            assert_partition(&analysis);
        }
        let analysis = service
            .search(
                analysis_request(CashActivitySelectionMode::All, &[]),
                Some("USD"),
                "UTC",
            )
            .await
            .unwrap()
            .analysis
            .unwrap();
        assert_eq!(
            analysis
                .matching
                .spending
                .converted
                .as_ref()
                .unwrap()
                .amount,
            "166"
        );
    }

    #[tokio::test]
    async fn search_analysis_splits_take_precedence_over_stale_assignment() {
        let (service, assignments, splits) =
            make_service_with(vec![cash_row("expense", "WITHDRAWAL", 100, "EUR")]);
        *assignments.assignments.lock().unwrap() = vec![assignment_row("expense", "groceries")];
        *splits.splits.lock().unwrap() = vec![split_row("expense", "household", "100")];
        let mut request = analysis_request(CashActivitySelectionMode::All, &[]);
        request.category_ids = Some(vec!["groceries".into()]);
        let analysis = service
            .search(request, Some("USD"), "UTC")
            .await
            .unwrap()
            .analysis
            .unwrap();
        // Existing search matching is unchanged; the stale assignment must not
        // contribute to category actuals when canonical splits replace it.
        assert_eq!(analysis.matching.count, 1);
        assert_eq!(
            analysis
                .matching
                .spending
                .converted
                .as_ref()
                .unwrap()
                .amount,
            "0"
        );
        assert!(analysis
            .matching
            .spending
            .missing_rate_currencies
            .is_empty());
        assert_eq!(
            analysis.matching.cash_movement.missing_rate_currencies,
            ["EUR"]
        );
    }

    #[tokio::test]
    async fn search_analysis_uses_the_same_account_status_event_amount_and_text_filters() {
        let mut matched = cash_row("matched", "WITHDRAWAL", 12, "USD");
        matched.needs_review = true;
        matched.notes = Some("Synthetic merchant".into());
        matched.activity_date = "2026-02-03T12:00:00Z".parse().unwrap();
        let mut rows = vec![matched.clone()];
        for (id, change) in [
            ("account", 0),
            ("status", 1),
            ("event", 2),
            ("amount", 3),
            ("text", 4),
            ("date", 5),
            ("type", 6),
        ] {
            let mut row = matched.clone();
            row.id = id.into();
            match change {
                0 => row.account_id = "not-opted-in".into(),
                1 => row.needs_review = false,
                2 => {}
                3 => row.amount = Some(Decimal::new(100, 0)),
                4 => row.notes = None,
                5 => row.activity_date = "2026-01-01T00:00:00Z".parse().unwrap(),
                _ => row.activity_type = "DEPOSIT".into(),
            }
            rows.push(row);
        }
        let (mut service, _, _) = make_service_with(rows.clone());
        service.activity_events = Arc::new(MockActivityEventsRepo {
            tags: rows
                .iter()
                .filter(|row| row.id != "event")
                .map(|row| (row.id.clone(), "synthetic-event".into()))
                .collect(),
        });
        let mut request = analysis_request(CashActivitySelectionMode::All, &["event", "account"]);
        request.search = Some("MERCHANT".into());
        request.account_ids = Some(vec!["account-1".into(), "not-opted-in".into()]);
        request.activity_types = Some(vec!["WITHDRAWAL".into()]);
        request.status = CashActivityStatusFilter::NeedsReview;
        request.event_ids = Some(vec!["synthetic-event".into()]);
        request.min_amount = Some(10.0);
        request.max_amount = Some(20.0);
        request.start_date = Some("2026-02-01T00:00:00Z".into());
        request.end_date = Some("2026-02-28T00:00:00Z".into());
        let analysis = service
            .search(request, Some("USD"), "UTC")
            .await
            .unwrap()
            .analysis
            .unwrap();
        assert_eq!(analysis.matching.count, 1);
        assert_eq!(
            analysis
                .selected
                .spending
                .converted
                .as_ref()
                .unwrap()
                .amount,
            "12"
        );
        assert_partition(&analysis);
    }

    #[tokio::test]
    async fn search_analysis_empty_disabled_and_no_accounts_return_honest_zero_totals() {
        for mode in [
            CashActivitySelectionMode::All,
            CashActivitySelectionMode::Explicit,
        ] {
            for base in [None, Some("USD")] {
                for scenario in 0..5 {
                    let (mut service, _, _) =
                        make_service_with(vec![cash_row("row", "WITHDRAWAL", 5, "USD")]);
                    let mut request = analysis_request(mode, &["row"]);
                    match scenario {
                        0 => request.search = Some("no match".into()),
                        1 => {
                            service.settings =
                                Arc::new(SpendingSettingsService::new(Arc::new(MockSettingsRepo {
                                    disabled: true,
                                    ..Default::default()
                                })))
                        }
                        2 => {
                            service.settings =
                                Arc::new(SpendingSettingsService::new(Arc::new(MockSettingsRepo {
                                    account_ids: Some(vec![]),
                                    ..Default::default()
                                })))
                        }
                        3 => request.account_ids = Some(vec!["outside".into()]),
                        _ => {
                            service.settings =
                                Arc::new(SpendingSettingsService::new(Arc::new(MockSettingsRepo {
                                    account_ids: Some(vec!["missing-account".into()]),
                                    ..Default::default()
                                })))
                        }
                    }
                    let response = service.search(request, base, "UTC").await.unwrap();
                    assert_eq!(response.total_count, 0);
                    assert_eq!(
                        response.analysis.unwrap(),
                        CashActivityAnalysis::empty(base)
                    );
                }
            }
        }
    }

    #[tokio::test]
    async fn search_analysis_categorized_status_uses_splits_and_assignments() {
        let (service, assignments, splits) = make_service_with(vec![
            cash_row("assigned", "WITHDRAWAL", 10, "USD"),
            cash_row("split", "WITHDRAWAL", 20, "USD"),
            cash_row("unassigned", "WITHDRAWAL", 30, "USD"),
        ]);
        *assignments.assignments.lock().unwrap() = vec![assignment_row("assigned", "groceries")];
        *splits.splits.lock().unwrap() = vec![split_row("split", "groceries", "20")];
        for (status, count) in [
            (CashActivityStatusFilter::Categorized, 2),
            (CashActivityStatusFilter::Uncategorized, 1),
        ] {
            let mut request = analysis_request(CashActivitySelectionMode::All, &[]);
            request.status = status;
            let analysis = service
                .search(request, Some("USD"), "UTC")
                .await
                .unwrap()
                .analysis
                .unwrap();
            assert_eq!(analysis.matching.count, count);
            assert_eq!(
                analysis
                    .matching
                    .spending
                    .converted
                    .as_ref()
                    .unwrap()
                    .amount,
                "30"
            );
            assert_partition(&analysis);
        }
    }

    #[tokio::test]
    async fn search_analysis_zero_cash_does_not_require_fx_but_spending_uses_canonical_classification(
    ) {
        let mut pending = cash_row("pending", "WITHDRAWAL", 10, "EUR");
        pending.status = ActivityStatus::Pending;
        let (service, _, _) =
            make_service_with(vec![pending, cash_row("zero", "WITHDRAWAL", 0, "GBP")]);
        let analysis = service
            .search(
                analysis_request(CashActivitySelectionMode::All, &[]),
                Some("USD"),
                "UTC",
            )
            .await
            .unwrap()
            .analysis
            .unwrap();
        assert_eq!(analysis.matching.count, 2);
        assert_eq!(
            analysis
                .matching
                .cash_movement
                .converted
                .as_ref()
                .unwrap()
                .amount,
            "0"
        );
        assert!(analysis
            .matching
            .cash_movement
            .missing_rate_currencies
            .is_empty());
        assert_eq!(
            exact_amount(&analysis.matching.spending, "EUR"),
            Decimal::new(10, 0)
        );
        assert_eq!(analysis.matching.spending.missing_rate_currencies, ["EUR"]);
        assert_partition(&analysis);
    }

    #[tokio::test]
    async fn search_without_selection_omits_analysis_and_does_not_convert_for_it() {
        let fx = Arc::new(DateCapturingFx::default());
        let (service, _, _) =
            make_service_with_fx(vec![cash_row("row", "WITHDRAWAL", 10, "EUR")], fx.clone());
        let request: CashActivitySearchRequest = serde_json::from_value(serde_json::json!({
            "offset": 1, "limit": 0
        }))
        .unwrap();
        assert!(request.selection.is_none());
        let response = service.search(request, Some("USD"), "UTC").await.unwrap();
        assert!(response.analysis.is_none());
        assert!(serde_json::to_value(response)
            .unwrap()
            .get("analysis")
            .is_none());
        assert!(fx.dates.lock().unwrap().is_empty());
        let analysis = service
            .search(
                analysis_request(CashActivitySelectionMode::All, &[]),
                None,
                "UTC",
            )
            .await
            .unwrap()
            .analysis
            .unwrap();
        assert_eq!(
            exact_amount(&analysis.matching.spending, "EUR"),
            Decimal::new(10, 0)
        );
        assert!(analysis.matching.spending.converted.is_none());
        assert!(analysis
            .matching
            .spending
            .missing_rate_currencies
            .is_empty());
        assert!(fx.dates.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn search_sort_ties_use_ids_for_stable_page_boundaries() {
        let mut rows: Vec<_> = ["c", "b", "a"]
            .into_iter()
            .map(|id| cash_row(id, "WITHDRAWAL", 1, "USD"))
            .collect();
        for row in &mut rows {
            row.activity_date = "2026-01-01T00:00:00Z".parse().unwrap();
        }
        let (service, _, _) = make_service_with(rows);
        for sort_by in [CashActivitySortField::Date, CashActivitySortField::Amount] {
            for sort_dir in [SortDirection::Asc, SortDirection::Desc] {
                let mut ids = Vec::new();
                for offset in 0..3 {
                    let response = service
                        .search(
                            CashActivitySearchRequest {
                                offset,
                                limit: 1,
                                sort_by,
                                sort_dir,
                                ..Default::default()
                            },
                            None,
                            "UTC",
                        )
                        .await
                        .unwrap();
                    ids.push(response.items[0].activity.id.clone());
                }
                assert_eq!(ids, ["a", "b", "c"]);
            }
        }
    }

    #[tokio::test]
    async fn search_nets_the_filtered_set_in_its_own_currency() {
        let (service, _, _) = make_service_with(vec![
            cash_row("a", "DEPOSIT", 1000, "USD"),
            cash_row("b", "WITHDRAWAL", 400, "USD"),
        ]);

        let response = service
            .search(
                CashActivitySearchRequest {
                    limit: 50,
                    ..Default::default()
                },
                None,
                "UTC",
            )
            .await
            .unwrap();

        assert_eq!(
            response.net.clone().unwrap().by_currency,
            vec![CurrencyNet {
                currency: "USD".to_string(),
                amount: 600.0,
            }]
        );
    }

    /// The reported case: a transfer filter used to answer with nothing,
    /// because transfers were treated as neither income nor expense.
    #[tokio::test]
    async fn search_nets_transfers_by_direction() {
        let (service, _, _) = make_service_with(vec![
            cash_row("a", "TRANSFER_IN", 900, "USD"),
            cash_row("b", "TRANSFER_OUT", 250, "USD"),
        ]);

        let response = service
            .search(
                CashActivitySearchRequest {
                    limit: 50,
                    ..Default::default()
                },
                None,
                "UTC",
            )
            .await
            .unwrap();

        assert_eq!(
            response.net.clone().unwrap().by_currency,
            vec![CurrencyNet {
                currency: "USD".to_string(),
                amount: 650.0,
            }]
        );
    }

    #[tokio::test]
    async fn search_reports_each_currency_separately_without_converting() {
        let (service, _, _) = make_service_with(vec![
            cash_row("a", "WITHDRAWAL", 60, "USD"),
            cash_row("b", "DEPOSIT", 100, "EUR"),
            cash_row("c", "WITHDRAWAL", 40, "EUR"),
        ]);

        let response = service
            .search(
                CashActivitySearchRequest {
                    limit: 50,
                    ..Default::default()
                },
                None,
                "UTC",
            )
            .await
            .unwrap();

        let mut nets = response.net.unwrap().by_currency;
        nets.sort_by(|a, b| a.currency.cmp(&b.currency));
        assert_eq!(
            nets,
            vec![
                CurrencyNet {
                    currency: "EUR".to_string(),
                    amount: 60.0,
                },
                CurrencyNet {
                    currency: "USD".to_string(),
                    amount: -60.0,
                },
            ]
        );
    }

    #[tokio::test]
    async fn search_excludes_unposted_rows_from_the_net_and_the_row_figure() {
        let mut draft = cash_row("a", "WITHDRAWAL", 500, "USD");
        draft.status = ActivityStatus::Draft;
        let (service, _, _) =
            make_service_with(vec![draft, cash_row("b", "WITHDRAWAL", 60, "USD")]);

        let response = service
            .search(
                CashActivitySearchRequest {
                    limit: 50,
                    ..Default::default()
                },
                None,
                "UTC",
            )
            .await
            .unwrap();

        assert_eq!(
            response.net.clone().unwrap().by_currency,
            vec![CurrencyNet {
                currency: "USD".to_string(),
                amount: -60.0,
            }]
        );
        let drafted = response
            .items
            .iter()
            .find(|i| i.activity.id == "a")
            .unwrap();
        assert_eq!(drafted.net_amount, 0.0);
    }

    /// A single currency already is the total, so converting it would only add
    /// FX drift to a figure that has an exact answer.
    /// The rate actually applied to the transaction beats a market lookup — but
    /// only when the account is denominated in the base currency, since that is
    /// what the stored rate converts into.
    #[tokio::test]
    async fn search_prefers_a_rate_stored_on_the_activity() {
        let mut row = cash_row("a", "WITHDRAWAL", 60, "EUR");
        row.fx_rate = Some(Decimal::new(15, 1));
        // The lookup would say 2.0; the stored rate says 1.5 and must win.
        let (service, _, _) = make_service_with_fx(vec![row], MockFx::with(&[("EUR", 2, 0)]));

        let response = service
            .search(
                CashActivitySearchRequest {
                    limit: 50,
                    ..Default::default()
                },
                // MockAccountRepo's account is USD, matching the base currency.
                Some("USD"),
                "UTC",
            )
            .await
            .unwrap();

        assert_eq!(response.items[0].net_amount_base, Some(-90.0));
    }

    #[tokio::test]
    async fn search_ignores_a_zero_stored_rate() {
        let mut row = cash_row("a", "WITHDRAWAL", 60, "EUR");
        row.fx_rate = Some(Decimal::ZERO);
        let (service, _, _) = make_service_with_fx(vec![row], MockFx::with(&[("EUR", 2, 0)]));

        let response = service
            .search(
                CashActivitySearchRequest {
                    limit: 50,
                    ..Default::default()
                },
                Some("USD"),
                "UTC",
            )
            .await
            .unwrap();

        assert_eq!(response.items[0].net_amount_base, Some(-120.0));
    }

    #[tokio::test]
    async fn search_withholds_a_converted_net_when_one_currency_contributes() {
        let (service, _, _) = make_service_with_fx(
            vec![
                cash_row("a", "WITHDRAWAL", 60, "EUR"),
                cash_row("b", "WITHDRAWAL", 40, "EUR"),
            ],
            MockFx::with(&[("EUR", 11, 1)]),
        );

        let net = search_net(&service, Some("USD")).await;

        assert_eq!(net.by_currency.len(), 1);
        assert!(net.converted.is_none());
    }

    #[tokio::test]
    async fn search_converts_a_mixed_set_at_each_row_own_date() {
        let (service, _, _) = make_service_with_fx(
            vec![
                cash_row("a", "WITHDRAWAL", 60, "USD"),
                cash_row("b", "WITHDRAWAL", 40, "EUR"),
            ],
            // USD is the base, so it passes through untouched; EUR doubles.
            MockFx::with(&[("USD", 1, 0), ("EUR", 2, 0)]),
        );

        let net = search_net(&service, Some("USD")).await;

        assert_eq!(
            net.converted,
            Some(CurrencyNet {
                currency: "USD".to_string(),
                amount: -140.0,
            })
        );
        assert_eq!(net.by_currency.len(), 2);
    }

    /// The total would silently omit the unconvertible rows, so it is withheld
    /// rather than reported short.
    #[tokio::test]
    async fn search_withholds_a_converted_net_when_a_currency_has_no_rate() {
        let (service, _, _) = make_service_with_fx(
            vec![
                cash_row("a", "WITHDRAWAL", 60, "USD"),
                cash_row("b", "WITHDRAWAL", 40, "JPY"),
            ],
            MockFx::with(&[("USD", 1, 0)]),
        );

        let net = search_net(&service, Some("USD")).await;

        assert!(net.converted.is_none());
        assert_eq!(net.by_currency.len(), 2);
    }

    #[tokio::test]
    async fn search_omits_row_conversions_when_no_base_currency_is_asked_for() {
        let (service, _, _) = make_service_with_fx(
            vec![cash_row("a", "WITHDRAWAL", 60, "EUR")],
            MockFx::with(&[("EUR", 2, 0)]),
        );

        let response = service
            .search(
                CashActivitySearchRequest {
                    limit: 50,
                    ..Default::default()
                },
                None,
                "UTC",
            )
            .await
            .unwrap();

        assert_eq!(response.items[0].net_amount, -60.0);
        assert!(response.items[0].net_amount_base.is_none());
    }

    #[tokio::test]
    async fn search_converts_each_row_into_the_base_currency() {
        let (service, _, _) = make_service_with_fx(
            vec![cash_row("a", "WITHDRAWAL", 60, "EUR")],
            MockFx::with(&[("EUR", 2, 0)]),
        );

        let response = service
            .search(
                CashActivitySearchRequest {
                    limit: 50,
                    ..Default::default()
                },
                Some("USD"),
                "UTC",
            )
            .await
            .unwrap();

        assert_eq!(response.items[0].net_amount, -60.0);
        assert_eq!(response.items[0].net_amount_base, Some(-120.0));
    }

    /// A currency whose rows cancel out is absent from the breakdown, so its
    /// per-date conversion residual must not leak into the headline either.
    #[tokio::test]
    async fn search_keeps_a_cancelled_currency_out_of_the_converted_total() {
        let (service, _, _) = make_service_with_fx(
            vec![
                cash_row("a", "TRANSFER_IN", 900, "CAD"),
                cash_row("b", "TRANSFER_OUT", 900, "CAD"),
                cash_row("c", "WITHDRAWAL", 60, "USD"),
                cash_row("d", "WITHDRAWAL", 40, "EUR"),
            ],
            MockFx::with(&[("CAD", 5, 1), ("USD", 1, 0), ("EUR", 2, 0)]),
        );

        let net = search_net(&service, Some("USD")).await;

        // CAD nets to zero and is not reported, so only USD and EUR count.
        assert_eq!(net.by_currency.len(), 2);
        assert_eq!(
            net.converted,
            Some(CurrencyNet {
                currency: "USD".to_string(),
                amount: -140.0,
            })
        );
    }

    /// A currency that cannot convert but contributes nothing must not block a
    /// headline the remaining currencies can support.
    #[tokio::test]
    async fn search_converts_despite_an_unrated_currency_that_cancels_out() {
        let (service, _, _) = make_service_with_fx(
            vec![
                cash_row("a", "TRANSFER_IN", 900, "JPY"),
                cash_row("b", "TRANSFER_OUT", 900, "JPY"),
                cash_row("c", "WITHDRAWAL", 60, "USD"),
                cash_row("d", "WITHDRAWAL", 40, "EUR"),
            ],
            MockFx::with(&[("USD", 1, 0), ("EUR", 2, 0)]),
        );

        let net = search_net(&service, Some("USD")).await;

        assert_eq!(
            net.converted,
            Some(CurrencyNet {
                currency: "USD".to_string(),
                amount: -140.0,
            })
        );
    }

    /// The client labels `net_amount_base` with this, rather than its own
    /// setting, so a cached response cannot be relabelled by a later change.
    #[tokio::test]
    async fn search_reports_the_currency_it_converted_into() {
        let (service, _, _) = make_service_with_fx(
            vec![cash_row("a", "WITHDRAWAL", 60, "EUR")],
            MockFx::with(&[("EUR", 2, 0)]),
        );

        let converted = service
            .search(
                CashActivitySearchRequest {
                    limit: 50,
                    ..Default::default()
                },
                Some("CAD"),
                "UTC",
            )
            .await
            .unwrap();
        assert_eq!(converted.base_currency.as_deref(), Some("CAD"));

        let unconverted = service
            .search(
                CashActivitySearchRequest {
                    limit: 50,
                    ..Default::default()
                },
                None,
                "UTC",
            )
            .await
            .unwrap();
        assert!(unconverted.base_currency.is_none());
    }

    /// The row is displayed under its local day and the holdings engine values
    /// it on that day, so the rate must be picked for the same one. Taking the
    /// UTC date instead priced anything either side of midnight a day out.
    #[tokio::test]
    async fn search_dates_the_rate_in_the_user_timezone() {
        // 02:00 UTC on Jun 7 is still Jun 6 in New York.
        let mut row = cash_row("a", "WITHDRAWAL", 60, "EUR");
        row.activity_date = DateTime::parse_from_rfc3339("2026-06-07T02:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let fx = Arc::new(DateCapturingFx::default());
        let (service, _, _) = make_service_with_fx(vec![row], fx.clone());

        service
            .search(
                CashActivitySearchRequest {
                    limit: 50,
                    ..Default::default()
                },
                Some("USD"),
                "America/New_York",
            )
            .await
            .unwrap();

        assert_eq!(
            *fx.dates.lock().unwrap().first().unwrap(),
            NaiveDate::from_ymd_opt(2026, 6, 6).unwrap()
        );
    }

    #[tokio::test]
    async fn search_nets_only_on_the_first_page() {
        let (service, _, _) = make_service_with(vec![
            cash_row("a", "WITHDRAWAL", 60, "USD"),
            cash_row("b", "WITHDRAWAL", 40, "USD"),
        ]);

        let later_page = service
            .search(
                CashActivitySearchRequest {
                    offset: 1,
                    limit: 50,
                    ..Default::default()
                },
                None,
                "UTC",
            )
            .await
            .unwrap();

        assert!(later_page.net.is_none());
    }

    #[tokio::test]
    async fn search_signs_each_row_so_the_rows_add_up_to_the_net() {
        let (service, _, _) = make_service_with(vec![
            cash_row("a", "DEPOSIT", 1000, "USD"),
            cash_row("b", "WITHDRAWAL", 400, "USD"),
            cash_row("c", "TRANSFER_OUT", 250, "USD"),
        ]);

        let response = service
            .search(
                CashActivitySearchRequest {
                    limit: 50,
                    ..Default::default()
                },
                None,
                "UTC",
            )
            .await
            .unwrap();

        let summed: f64 = response.items.iter().map(|i| i.net_amount).sum();
        let net = response.net.clone().unwrap().by_currency[0].amount;
        assert_eq!(summed, net);
        assert_eq!(summed, 350.0);
    }

    #[test]
    fn activity_date_filter_compares_instants_not_rfc3339_strings() {
        let activity_date = DateTime::parse_from_rfc3339("2024-01-01T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let same_start = parse_filter_datetime(Some("2024-01-01T00:00:00.000Z"))
            .unwrap()
            .unwrap();
        let same_end = parse_filter_datetime(Some("2024-01-01T00:00:00.000Z"))
            .unwrap()
            .unwrap();
        let after_end = DateTime::parse_from_rfc3339("2024-01-01T00:00:01Z")
            .unwrap()
            .with_timezone(&Utc);

        assert!(activity_date_in_range(
            &activity_date,
            Some(&same_start),
            Some(&same_end)
        ));
        assert!(!activity_date_in_range(&after_end, None, Some(&same_end)));
    }

    #[test]
    fn credit_card_payment_is_visible_as_neutral_cash_activity() {
        let mut linked_payment = activity("TRANSFER_IN");
        linked_payment.source_group_id = Some("payment-group".to_string());

        assert!(is_visible_cash_activity(
            &linked_payment,
            account_types::CREDIT_CARD
        ));
        assert!(is_visible_cash_activity(
            &activity("TRANSFER_IN"),
            account_types::CREDIT_CARD
        ));
        assert!(!is_visible_cash_activity(
            &activity("DEPOSIT"),
            account_types::CREDIT_CARD
        ));
    }

    #[tokio::test]
    async fn replace_splits_accepts_exact_total_and_clears_single_assignment() {
        let (service, assignment_repo, split_repo) = make_service(activity("WITHDRAWAL"));

        let splits = service
            .replace_splits(
                "activity-1",
                vec![
                    split("groceries", 80, SPENDING_TAXONOMY),
                    split("household", 20, SPENDING_TAXONOMY),
                ],
            )
            .await
            .unwrap();

        assert_eq!(splits.len(), 2);
        assert!(assignment_repo.cleared.lock().unwrap().is_empty());
        assert_eq!(
            split_repo.assignment_clears.lock().unwrap().as_slice(),
            &[("activity-1".to_string(), SPENDING_TAXONOMY.to_string())]
        );
        assert_eq!(split_repo.replaced.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn replace_splits_rejects_over_total_without_writing() {
        let (service, assignment_repo, split_repo) = make_service(activity("WITHDRAWAL"));

        let err = service
            .replace_splits(
                "activity-1",
                vec![
                    split("groceries", 80, SPENDING_TAXONOMY),
                    split("household", 25, SPENDING_TAXONOMY),
                ],
            )
            .await
            .unwrap_err();

        assert!(err.to_string().contains("must equal"));
        assert!(assignment_repo.cleared.lock().unwrap().is_empty());
        assert!(split_repo.replaced.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn replace_splits_rejects_wrong_taxonomy_without_writing() {
        let (service, assignment_repo, split_repo) = make_service(activity("WITHDRAWAL"));

        let err = service
            .replace_splits("activity-1", vec![split("salary", 100, INCOME_TAXONOMY)])
            .await
            .unwrap_err();

        assert!(err.to_string().contains("taxonomy must match"));
        assert!(assignment_repo.cleared.lock().unwrap().is_empty());
        assert!(split_repo.replaced.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn replace_splits_rejects_wrong_category_taxonomy_without_writing() {
        let (service, assignment_repo, split_repo) = make_service(activity("WITHDRAWAL"));
        *split_repo.categories_valid.lock().unwrap() = false;

        let err = service
            .replace_splits("activity-1", vec![split("salary", 100, SPENDING_TAXONOMY)])
            .await
            .unwrap_err();

        assert!(err.to_string().contains("categories must belong"));
        assert!(assignment_repo.cleared.lock().unwrap().is_empty());
        assert!(split_repo.replaced.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn replace_splits_rejects_neutral_transfer_without_writing() {
        let mut transfer = activity("TRANSFER_IN");
        transfer.source_group_id = Some("group-1".to_string());
        let (service, assignment_repo, split_repo) = make_service(transfer);

        let err = service
            .replace_splits(
                "activity-1",
                vec![split("groceries", 100, SPENDING_TAXONOMY)],
            )
            .await
            .unwrap_err();

        assert!(err
            .to_string()
            .contains("Neutral transfers cannot be split"));
        assert!(assignment_repo.cleared.lock().unwrap().is_empty());
        assert!(split_repo.replaced.lock().unwrap().is_empty());
    }
}
