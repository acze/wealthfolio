import { randomUUID } from "node:crypto";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { BASE_URL, completeOnboardingIfNeeded, gotoAppPath } from "./helpers";

const SEARCH_PATH = "/api/v1/spending/cash-activities/search";
const TAXONOMY = "spending_categories";
const COUNT = 127;
const CATEGORIZED_COUNT = COUNT - 3;
const SPENDING = "2176.69";
const CASH_MOVEMENT = "-2151.69";

interface MoneySummary {
  byCurrency: { currency: string; amount: string }[];
  converted: { currency: string; amount: string } | null;
  missingRateCurrencies: string[];
}

interface Totals {
  count: number;
  spending: MoneySummary;
  cashMovement: MoneySummary;
}

interface SearchResult {
  items: { id: string; notes: string; cashFlowBucket: string }[];
  totalCount: number;
  analysis: { selected: Totals; matching: Totals; excluded: Totals };
  selectionSnapshot?: {
    ids: string[];
    net: { byCurrency: { currency: string; amount: number }[]; converted: unknown };
    cashFlowBuckets: string[];
  };
}

test.describe.configure({ mode: "serial" });

test.describe("Spending selection analysis with real paginated transactions", () => {
  let page: Page;
  let accountId: string;
  let otherAccountId: string;
  let parentId: string;
  let childId: string;
  let grandchildId: string;
  let outlierId: string;
  let firstExpenseId: string;
  let ordinaryIds: string[];
  let zeroCurrencyIds: string[];
  const token = randomUUID().slice(0, 8);
  const parentName = `Analysis parent ${token}`;
  const childName = `Analysis child ${token}`;
  const grandchildName = `Analysis grandchild ${token}`;
  const accountName = `Analysis cash ${token}`;
  const otherAccountName = `Analysis other ${token}`;
  const outlierNote = `Synthetic outlier ${token}`;
  const ordinaryNote = `Synthetic ordinary ${token}`;
  const zeroCurrencyNote = `Synthetic zero currency ${token}`;
  const day = new Date().toISOString().slice(0, 10);
  const monthStart = `${day.slice(0, 7)}-01`;
  const monthEnd = new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)), 0))
    .toISOString()
    .slice(0, 10);

  async function api<T>(path: string, data: unknown, method = "POST"): Promise<T> {
    const response = await page.request.fetch(`${BASE_URL}/api/v1${path}`, { method, data });
    expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBe(true);
    return response.json() as Promise<T>;
  }

  async function search(extra: Record<string, unknown> = {}) {
    return api<SearchResult>("/spending/cash-activities/search", {
      accountIds: [accountId],
      startDate: `${day}T00:00:00Z`,
      endDate: `${day}T23:59:59.999Z`,
      offset: 0,
      limit: 0,
      selection: { mode: "all", ids: [] },
      ...extra,
    });
  }

  function activitiesPath(extra: Record<string, string> = {}) {
    return `/activities?${new URLSearchParams({
      tab: "spending",
      account: accountId,
      from: day,
      to: day,
      analysis: "true",
      ...extra,
    })}`;
  }

  const region = () => page.getByRole("region", { name: "Selection analysis", exact: true });
  const bulkRegion = () => page.getByRole("region", { name: "Bulk actions", exact: true });
  const selectedNet = () => page.locator("span").filter({ hasText: /^Selected net/ });

  function observeLedgerWrites() {
    const writes: string[] = [];
    const record = (request: import("@playwright/test").Request) => {
      const path = new URL(request.url()).pathname;
      if (
        ["POST", "PUT", "DELETE", "PATCH"].includes(request.method()) &&
        ((path.startsWith("/api/v1/activities") && path !== "/api/v1/activities/search") ||
          (/^\/api\/v1\/spending\/(?:assignments|activities|cash-activities)\//.test(path) &&
            path !== SEARCH_PATH))
      ) {
        writes.push(`${request.method()} ${path}`);
      }
    };
    page.on("request", record);
    return () => {
      page.off("request", record);
      return writes;
    };
  }

  async function expectCount(selected: number, matching = COUNT) {
    await expect(region()).toContainText(
      `${selected} of ${matching} matching transactions selected`,
      { timeout: 30000 },
    );
  }

  function assertNative(summary: MoneySummary, amount: string) {
    expect(summary.missingRateCurrencies).toEqual([]);
    expect(summary.byCurrency).toHaveLength(1);
    expect(summary.byCurrency[0].currency).toBe("CAD");
    const canonical = amount.includes(".") ? amount.replace(/0+$/, "").replace(/\.$/, "") : amount;
    expect(summary.byCurrency[0].amount).toBe(canonical);
  }

  async function expectMoney(
    scope: "selected" | "matching" | "excluded",
    spending: string,
    cash: string,
  ) {
    const totals = page.getByTestId(`analysis-${scope}`);
    const formatter = new Intl.NumberFormat("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    await expect(totals.locator("dd").nth(0)).toContainText(formatter.format(Number(spending)));
    await expect(totals.locator("dd").nth(1)).toContainText(formatter.format(Number(cash)));
    await expect(totals).toContainText("CAD");
  }

  async function scrollToOutlier(): Promise<Locator> {
    const row = page.getByRole("row").filter({ hasText: outlierNote });
    await page.evaluate(() => {
      for (const el of document.querySelectorAll<HTMLElement>(
        "[data-virtual-scroll-parent],[data-page-scroll-container]",
      )) {
        if (el.scrollHeight > el.clientHeight) el.scrollTo(0, 0);
      }
    });
    // Scroll the real virtualized list; no DOM injection or API-only exclusion.
    await expect
      .poll(
        async () => {
          const inViewport = await page.evaluate((note) => {
            const target = [...document.querySelectorAll("tr")].find((el) =>
              el.textContent?.includes(note),
            );
            if (!target) return false;
            const bounds = target.getBoundingClientRect();
            const stickyBottom =
              document
                .querySelector('section[aria-label="Selection analysis"]')
                ?.getBoundingClientRect().bottom ?? 0;
            return bounds.top > Math.max(0, stickyBottom) && bounds.bottom < window.innerHeight;
          }, outlierNote);
          if (inViewport) return true;
          await page.evaluate(() => {
            for (const el of document.querySelectorAll<HTMLElement>(
              "[data-virtual-scroll-parent],[data-page-scroll-container]",
            )) {
              if (el.scrollHeight > el.clientHeight) el.scrollBy(0, 260);
            }
          });
          return false;
        },
        { timeout: 30000, intervals: [100, 200, 300] },
      )
      .toBe(true);
    return row;
  }

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180000);
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.context().tracing.start({ screenshots: true, snapshots: true });
    await completeOnboardingIfNeeded(page);
    await api("/settings", { timezone: "UTC", baseCurrency: "CAD" }, "PUT");
    const createAccount = async (name: string, accountType = "CASH") =>
      api<{ id: string }>("/accounts", {
        name,
        accountType,
        currency: "CAD",
        isDefault: false,
        isActive: true,
      });
    accountId = (await createAccount(accountName)).id;
    otherAccountId = (await createAccount(otherAccountName)).id;
    const investmentId = (await createAccount(`Analysis investment ${token}`, "SECURITIES")).id;
    await api(
      "/spending/settings",
      { enabled: true, accountIds: [accountId, otherAccountId] },
      "PUT",
    );

    const createCategory = async (name: string, parent: string | null) =>
      api<{ id: string }>("/taxonomies/categories", {
        taxonomyId: TAXONOMY,
        name,
        key: randomUUID(),
        parentId: parent,
        color: "#3b82f6",
        sortOrder: 100,
      });
    parentId = (await createCategory(parentName, null)).id;
    childId = (await createCategory(childName, parentId)).id;
    grandchildId = (await createCategory(grandchildName, childId)).id;

    const activity = (notes: string, amount: string, activityType = "WITHDRAWAL", extra = {}) => ({
      id: randomUUID(),
      accountId,
      activityType,
      currency: "CAD",
      amount,
      activityDate: `${day}T12:30:00Z`,
      notes,
      ...extra,
    });
    // 120 ordinary expenses span 12:00 through 10:01. The outlier sorts after
    // 80 ordinary expenses, well beyond the real search page size of 50.
    const ordinary = Array.from({ length: 120 }, (_, index) =>
      activity(`${ordinaryNote} ${String(index).padStart(3, "0")}`, "10.01", "WITHDRAWAL", {
        activityDate: new Date(Date.parse(`${day}T12:00:00Z`) - index * 60000).toISOString(),
      }),
    );
    const outlier = activity(outlierNote, "1000.99", "WITHDRAWAL", {
      activityDate: `${day}T10:40:30Z`,
    });
    const refund = activity(`Synthetic refund ${token}`, "25.50", "CREDIT", {
      subtype: "REFUND",
      metadata: JSON.stringify({ flow: { is_external: true } }),
    });
    const income = activity(`Synthetic income ${token}`, "200.00", "DEPOSIT");
    const zeroCurrency = [
      activity(`${zeroCurrencyNote} purchase`, "12.50", "WITHDRAWAL", {
        currency: "EUR",
        fxRate: "2",
        activityDate: `${day}T09:00:00Z`,
      }),
      activity(`${zeroCurrencyNote} refund`, "12.50", "CREDIT", {
        currency: "EUR",
        fxRate: "2",
        activityDate: `${day}T09:01:00Z`,
        subtype: "REFUND",
        metadata: JSON.stringify({ flow: { is_external: true } }),
      }),
    ];
    const sentinel = activity(`Other account sentinel ${token}`, "42.42", "WITHDRAWAL", {
      accountId: otherAccountId,
    });
    const result = await api<{ created: { id: string; notes: string }[]; errors: unknown[] }>(
      "/activities/bulk",
      {
        creates: [...ordinary, outlier, refund, income, sentinel, ...zeroCurrency],
      },
    );
    expect(result.errors).toEqual([]);
    expect(result.created).toHaveLength(126);
    const persistedIds = new Map(result.created.map((row) => [row.notes, row.id]));
    firstExpenseId = persistedIds.get(ordinary[0].notes)!;
    ordinaryIds = ordinary.map((row) => persistedIds.get(row.notes)!);
    zeroCurrencyIds = zeroCurrency.map((row) => persistedIds.get(row.notes)!);
    outlierId = persistedIds.get(outlier.notes)!;
    for (const [toAccountId, amount, note] of [
      [investmentId, "75.00", "saving"],
      [otherAccountId, "100.00", "internal"],
    ]) {
      await api("/activities/transfer-pair", {
        fromAccountId: accountId,
        toAccountId,
        activityDate: `${day}T12:45:00Z`,
        sourceAmount: amount,
        destinationAmount: amount,
        sourceCurrency: "CAD",
        destinationCurrency: "CAD",
        notes: `Synthetic ${note} ${token}`,
      });
    }
    await api(
      "/spending/assignments/bulk",
      [...ordinary, outlier, refund, ...zeroCurrency].map((row, index) => ({
        activityId: persistedIds.get(row.notes)!,
        taxonomyId: TAXONOMY,
        categoryId: [parentId, childId, grandchildId][index % 3],
      })),
    );
    const response = await search({
      limit: 50,
      sortBy: "date",
      sortDir: "desc",
      includeSelectionSnapshot: true,
    });
    expect(response.totalCount).toBe(COUNT);
    expect(response.items).toHaveLength(50);
    expect(response.items.some((item) => item.id === outlierId)).toBe(false);
    expect(response.items.some((item) => zeroCurrencyIds.includes(item.id))).toBe(false);
    expect(response.selectionSnapshot?.ids).toHaveLength(COUNT);
    expect(response.selectionSnapshot?.net.byCurrency).toContainEqual({
      currency: "EUR",
      amount: 0,
    });
    expect(response.analysis.matching.count).toBe(COUNT);
    assertNative(response.analysis.matching.spending, SPENDING);
    assertNative(response.analysis.matching.cashMovement, CASH_MOVEMENT);
    expect(response.items.some((item) => item.cashFlowBucket === "saving")).toBe(true);
    expect(response.items.some((item) => item.cashFlowBucket === "neutral")).toBe(true);
  });

  test.afterAll(async ({}, testInfo) => {
    await page?.context().tracing.stop({ path: testInfo.outputPath("analysis-session-trace.zip") });
    await page?.close();
  });

  test("preserves selection across modes, including all pages and unloaded zero-currency rows", async ({}, testInfo) => {
    test.setTimeout(90000);
    const finishWriteObservation = observeLedgerWrites();
    await gotoAppPath(page, activitiesPath({ analysis: "false" }));
    const firstExpense = page.getByRole("row").filter({ hasText: `${ordinaryNote} 000` });
    await firstExpense.getByRole("checkbox").click();
    await expect(page.getByRole("region", { name: "Bulk actions" })).toContainText("1 selected");
    await page.getByRole("button", { name: "Analyze selection", exact: true }).click();
    await expectCount(1);
    await expect(firstExpense.getByRole("checkbox")).toBeChecked();
    await expect(page.getByRole("region", { name: "Bulk actions" })).toHaveCount(0);
    await page
      .getByRole("checkbox", { name: "Select all visible transactions", exact: true })
      .click();
    await expectCount(50);
    await region().getByRole("button", { name: "Select all matching" }).click();
    await expectCount(COUNT);
    await expectMoney("matching", SPENDING, CASH_MOVEMENT);
    await expectMoney("selected", SPENDING, CASH_MOVEMENT);

    await expect(page.getByText(`50/${COUNT} transactions`, { exact: true })).toBeVisible();
    const materialized = page.waitForResponse(
      (response) =>
        response.url().endsWith(SEARCH_PATH) &&
        response.request().postDataJSON().includeSelectionSnapshot === true,
    );
    await region().getByRole("button", { name: "Exit analysis" }).click();
    await expect(bulkRegion()).toContainText(`${COUNT} selected`);
    await expect(bulkRegion()).toContainText("Includes selected transactions on other pages.");
    const snapshot = ((await (await materialized).json()) as SearchResult).selectionSnapshot!;
    expect(snapshot.ids).toHaveLength(COUNT);
    expect(snapshot.ids).toEqual(expect.arrayContaining(zeroCurrencyIds));
    expect(snapshot.net.byCurrency).toContainEqual({ currency: "EUR", amount: 0 });
    await expect(selectedNet().getByText("EUR", { exact: true }).locator("..")).toContainText(
      "0.00",
    );
    await expect(selectedNet()).toContainText("2,151.69");
    await expect(selectedNet().getByText("EUR", { exact: true }).locator("..")).toHaveClass(
      /rounded-full/,
    );
    await page.screenshot({
      path: testInfo.outputPath("normal-all-matching-unloaded-eur-zero.png"),
      fullPage: true,
    });
    await page.getByRole("button", { name: "Analyze selection", exact: true }).click();
    await expectCount(COUNT);

    const outlier = await scrollToOutlier();
    const checkbox = outlier.getByRole("checkbox");
    await expect(checkbox).toBeChecked();
    await checkbox.focus();
    await page.keyboard.press("Space");
    await expect(checkbox).not.toBeChecked();
    await expectCount(COUNT - 1);
    await expectMoney("selected", "1175.70", "-1150.70");
    await expectMoney("excluded", "1000.99", "-1000.99");
    await expectMoney("matching", SPENDING, CASH_MOVEMENT);
    await expect(region().getByRole("button", { name: "Clear selection" })).toBeInViewport();
    await page.screenshot({
      path: testInfo.outputPath("desktop-outlier-excluded.png"),
      fullPage: true,
    });
    const exact = await search({ selection: { mode: "all", ids: [outlierId] } });
    expect(exact.analysis.selected.count).toBe(COUNT - 1);
    expect(exact.analysis.excluded.count).toBe(1);
    assertNative(exact.analysis.selected.spending, "1175.70");
    assertNative(exact.analysis.selected.cashMovement, "-1150.70");

    await region().getByRole("button", { name: "Exit analysis" }).click();
    await expect(bulkRegion()).toContainText(`${COUNT - 1} selected`);
    await scrollToOutlier();
    await expect(outlier.getByRole("checkbox")).not.toBeChecked();
    await page.getByRole("button", { name: "Analyze selection", exact: true }).click();
    await expectCount(COUNT - 1);
    await scrollToOutlier();
    await expect(outlier.getByRole("checkbox")).not.toBeChecked();

    await region().getByRole("button", { name: "Clear selection" }).click();
    await expectCount(0);
    await expectMoney("excluded", SPENDING, CASH_MOVEMENT);
    await region().getByRole("button", { name: "Exit analysis" }).click();
    await expect(region()).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Bulk actions" })).toHaveCount(0);
    expect(finishWriteObservation()).toEqual([]);
    // A subsequent ordinary bulk action must contain one explicit row, never
    // the implicit all-matching analysis selection.
    await gotoAppPath(page, activitiesPath({ analysis: "false", q: `${ordinaryNote} 000` }));
    await page.getByRole("checkbox", { name: "Select transaction", exact: true }).click();
    const bulk = page.getByRole("region", { name: "Bulk actions" });
    await expect(bulk).toContainText("1 selected");
    await bulk.getByRole("button", { name: "Categorize", exact: true }).click();
    const mutation = page.waitForRequest(
      (request) =>
        request.url().endsWith("/spending/assignments/bulk") && request.method() === "POST",
    );
    await page.getByRole("option", { name: parentName, exact: true }).click();
    expect((await mutation).postDataJSON()).toEqual([
      { activityId: firstExpenseId, taxonomyId: TAXONOMY, categoryId: parentId },
    ]);
    const persisted = await search();
    expect(persisted.totalCount).toBe(COUNT);
    assertNative(persisted.analysis.matching.spending, SPENDING);
  });

  test("clears selection on search, category, account and clear-all filter changes", async () => {
    await gotoAppPath(page, activitiesPath());
    await expectCount(0);
    await region().getByRole("button", { name: "Select all matching" }).click();
    await expectCount(COUNT);
    const searchbox = page.getByPlaceholder(/search/i).first();
    await searchbox.fill(outlierNote);
    await expectCount(0, 1);
    await region().getByRole("button", { name: "Select all matching" }).click();
    await expectCount(1, 1);
    await searchbox.fill("");
    await expectCount(0);
    await region().getByRole("button", { name: "Select all matching" }).click();
    await page.getByRole("button", { name: /^Category/ }).click();
    await page.getByRole("option", { name: parentName, exact: true }).click();
    await page.keyboard.press("Escape");
    await expectCount(0, CATEGORIZED_COUNT);
    await region().getByRole("button", { name: "Select all matching" }).click();
    await expectCount(CATEGORIZED_COUNT, CATEGORIZED_COUNT);
    await expectMoney("matching", SPENDING, "-2176.69");
    await page.getByRole("button", { name: "Clear all", exact: true }).click();
    const all = await search({ accountIds: undefined, startDate: undefined, endDate: undefined });
    await expectCount(0, all.totalCount);
    for (const key of ["account", "accounts", "category", "from", "to", "q"]) {
      expect(new URL(page.url()).searchParams.has(key)).toBe(false);
    }
    await region().getByRole("button", { name: "Select all matching" }).click();
    await page.getByRole("button", { name: /^Account/ }).click();
    await page.getByRole("option", { name: otherAccountName, exact: true }).click();
    await page.keyboard.press("Escape");
    await expectCount(0, 2);
    await region().getByRole("button", { name: "Select all matching" }).click();
    await expectCount(2, 2);
    await expectMoney("selected", "42.42", "57.58");
    await searchbox.fill(`No synthetic transaction matches ${token}`);
    await expectCount(0, 0);
    await expect(region().getByRole("button", { name: "Select all matching" })).toBeDisabled();
    await expect(page.getByTestId("analysis-selected")).not.toContainText("57.58");
  });

  test("keeps explicit zero-sum selections and Analysis edits through repeated transitions", async () => {
    await gotoAppPath(page, activitiesPath({ analysis: "false", q: zeroCurrencyNote }));
    const purchase = page.getByRole("row").filter({ hasText: `${zeroCurrencyNote} purchase` });
    const refund = page.getByRole("row").filter({ hasText: `${zeroCurrencyNote} refund` });
    await purchase.getByRole("checkbox").click();
    await expect(bulkRegion()).toContainText("1 selected");
    await page.getByRole("button", { name: "Analyze selection", exact: true }).click();
    await expectCount(1, 2);
    await expect(purchase.getByRole("checkbox")).toBeChecked();
    await refund.getByRole("checkbox").click();
    await expectCount(2, 2);
    await expectMoney("selected", "0", "0");
    await region().getByRole("button", { name: "Exit analysis" }).click();
    await expect(bulkRegion()).toContainText("2 selected");
    await expect(selectedNet().getByText("EUR", { exact: true }).locator("..")).toContainText(
      "0.00",
    );
    await expect(purchase.getByRole("checkbox")).toBeChecked();
    await expect(refund.getByRole("checkbox")).toBeChecked();
    await page.getByRole("button", { name: "Analyze selection", exact: true }).click();
    await expectCount(2, 2);
    await purchase.getByRole("checkbox").click();
    await expectCount(1, 2);
    for (let turn = 0; turn < 2; turn++) {
      await region().getByRole("button", { name: "Exit analysis" }).click();
      await expect(bulkRegion()).toContainText("1 selected");
      await expect(purchase.getByRole("checkbox")).not.toBeChecked();
      await expect(refund.getByRole("checkbox")).toBeChecked();
      await page.getByRole("button", { name: "Analyze selection", exact: true }).click();
      await expectCount(1, 2);
    }
    await region().getByRole("button", { name: "Clear selection" }).click();
    await expectCount(0, 2);
    await region().getByRole("button", { name: "Exit analysis" }).click();
    await expect(bulkRegion()).toHaveCount(0);
    await page.getByRole("button", { name: "Analyze selection", exact: true }).click();
    await expectCount(0, 2);
  });

  test("submits exactly the full resolved selection and resets it on normal-mode filter changes", async () => {
    await gotoAppPath(page, activitiesPath({ q: ordinaryNote }));
    await expectCount(0, 120);
    await region().getByRole("button", { name: "Select all matching" }).click();
    await expectCount(120, 120);
    await page
      .getByRole("row")
      .filter({ hasText: `${ordinaryNote} 000` })
      .getByRole("checkbox")
      .click();
    await expectCount(119, 120);
    await region().getByRole("button", { name: "Exit analysis" }).click();
    await expect(bulkRegion()).toContainText("119 selected");
    await bulkRegion().getByRole("button", { name: "Categorize", exact: true }).click();
    const mutation = page.waitForRequest(
      (request) =>
        request.url().endsWith("/spending/assignments/bulk") && request.method() === "POST",
    );
    await page.getByRole("option", { name: parentName, exact: true }).click();
    const submitted = (await mutation).postDataJSON() as { activityId: string }[];
    expect(submitted).toHaveLength(119);
    expect(submitted.map((entry) => entry.activityId).sort()).toEqual(
      ordinaryIds.filter((id) => id !== firstExpenseId).sort(),
    );
    await expect(bulkRegion()).toHaveCount(0);
    await page.getByRole("button", { name: "Analyze selection", exact: true }).click();
    await expectCount(0, 120);
    await region().getByRole("button", { name: "Select all matching" }).click();
    await region().getByRole("button", { name: "Exit analysis" }).click();
    await expect(bulkRegion()).toContainText("120 selected");
    await page
      .getByPlaceholder(/search/i)
      .first()
      .fill(outlierNote);
    await expect(bulkRegion()).toHaveCount(0);
    await page.getByRole("button", { name: "Analyze selection", exact: true }).click();
    await expectCount(0, 1);
  });

  test("blocks bulk actions during materialization and ignores late IDs after toggles or clear", async () => {
    const finishWriteObservation = observeLedgerWrites();
    await gotoAppPath(page, activitiesPath());
    await expectCount(0);
    await region().getByRole("button", { name: "Select all matching" }).click();
    await expectCount(COUNT);
    let release: () => void = () => {};
    let held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let behavior: "hold" | "error" | "pass" = "hold";
    await page.route(`**${SEARCH_PATH}`, async (route) => {
      if (!route.request().postDataJSON().includeSelectionSnapshot) {
        await route.continue();
      } else if (behavior === "error") {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: '{"error":"Synthetic selection snapshot failure"}',
        });
      } else {
        if (behavior === "hold") await held;
        await route.continue();
      }
    });
    const lateResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith(SEARCH_PATH) &&
        response.request().postDataJSON().includeSelectionSnapshot === true,
    );
    await region().getByRole("button", { name: "Exit analysis" }).click();
    await expect(bulkRegion()).toContainText("Preparing selected transactions...");
    await expect(bulkRegion().getByRole("button", { name: "Delete", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Analyze selection", exact: true }).click();
    await expectCount(COUNT);
    release();
    await (await lateResponse).finished();
    await expect(bulkRegion()).toHaveCount(0);
    await expectCount(COUNT);
    await page
      .getByRole("row")
      .filter({ hasText: `${ordinaryNote} 000` })
      .getByRole("checkbox")
      .click();
    await expectCount(COUNT - 1);
    behavior = "error";
    await region().getByRole("button", { name: "Exit analysis" }).click();
    await expect(bulkRegion()).toContainText("Your selection is preserved.");
    await expect(bulkRegion().getByRole("button", { name: "Delete", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Analyze selection", exact: true }).click();
    await expectCount(COUNT - 1);
    await region().getByRole("button", { name: "Exit analysis" }).click();
    await expect(bulkRegion()).toContainText("Your selection is preserved.");
    behavior = "pass";
    await bulkRegion().getByRole("button", { name: "Retry" }).click();
    await expect(bulkRegion()).toContainText(`${COUNT - 1} selected`);
    await expect(bulkRegion().getByRole("button", { name: "Delete", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Analyze selection", exact: true }).click();
    await expectCount(COUNT - 1);
    await region().getByRole("button", { name: "Select all matching" }).click();
    await expectCount(COUNT);
    held = new Promise<void>((resolve) => {
      release = resolve;
    });
    behavior = "hold";
    const clearedResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith(SEARCH_PATH) &&
        response.request().postDataJSON().includeSelectionSnapshot === true,
    );
    await region().getByRole("button", { name: "Exit analysis" }).click();
    await expect(bulkRegion()).toContainText("Preparing selected transactions...");
    await bulkRegion().getByRole("button", { name: "Clear", exact: true }).click();
    release();
    await (await clearedResponse).finished();
    await expect(bulkRegion()).toHaveCount(0);
    await page.unroute(`**${SEARCH_PATH}`);
    await page.getByRole("button", { name: "Analyze selection", exact: true }).click();
    await expectCount(0);
    expect(finishWriteObservation()).toEqual([]);
  });

  test("hides stale totals while a real read is pending or fails and recovers", async () => {
    await gotoAppPath(page, activitiesPath());
    await expectCount(0);
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let intercepted = false;
    await page.route(`**${SEARCH_PATH}`, async (route) => {
      if (!intercepted && route.request().postDataJSON().selection?.mode === "all") {
        intercepted = true;
        await held;
        await route.continue();
      } else {
        await route.continue();
      }
    });
    const lateResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith(SEARCH_PATH) &&
        response.request().postDataJSON().selection?.mode === "all",
    );
    await region().getByRole("button", { name: "Select all matching" }).click();
    await expect(region()).toContainText("Updating analysis");
    await expect(page.getByTestId("analysis-selected")).toHaveCount(0);
    await region().getByRole("button", { name: "Clear selection" }).click();
    release();
    await (await lateResponse).finished();
    await expectCount(0);
    await page.unroute(`**${SEARCH_PATH}`);

    await page.route(`**${SEARCH_PATH}`, async (route) => {
      if (route.request().postDataJSON().selection) {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: '{"error":"Synthetic read failure"}',
        });
      } else {
        await route.continue();
      }
    });
    await region().getByRole("button", { name: "Select all matching" }).click();
    await expect(region()).toContainText("Analysis unavailable", { timeout: 30000 });
    await expect(page.getByTestId("analysis-matching")).toHaveCount(0);
    await page.unroute(`**${SEARCH_PATH}`);
    await region().getByRole("button", { name: "Retry", exact: true }).click();
    await expectCount(COUNT);
    await expectMoney("selected", SPENDING, CASH_MOVEMENT);
  });

  test("supports mobile checkboxes, privacy masking, and no horizontal overflow", async ({}, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoAppPath(page, activitiesPath());
    await expectCount(0);
    const checkbox = page
      .getByRole("checkbox", { name: "Select transaction", exact: true })
      .first();
    await checkbox.click();
    await expectCount(1);
    await region().getByRole("button", { name: "Select all matching" }).click();
    await expectCount(COUNT);
    await expectMoney("selected", SPENDING, CASH_MOVEMENT);
    await expect(region().getByRole("button", { name: "Exit analysis" })).toBeInViewport();
    await region().getByRole("button", { name: "Exit analysis" }).click();
    await expect(bulkRegion()).toContainText(`${COUNT} selected`);
    await expect(selectedNet().getByText("EUR", { exact: true }).locator("..")).toContainText(
      "0.00",
    );
    await page.getByRole("button", { name: "Analyze selection", exact: true }).click();
    await expectCount(COUNT);
    const widths = await page.evaluate(() => ({
      document: document.documentElement.scrollWidth,
      viewport: window.innerWidth,
    }));
    expect(widths.document).toBeLessThanOrEqual(widths.viewport);
    await page.screenshot({ path: testInfo.outputPath("mobile-analysis.png"), fullPage: true });
    // Exercise the shared privacy preference without relying on the unrelated
    // dashboard-only eye toggle being mounted on this route.
    await page.evaluate(() => {
      localStorage.setItem("privacy-settings", "true");
      window.dispatchEvent(
        new CustomEvent("wf:privacy-changed", { detail: { isBalanceHidden: true } }),
      );
    });
    await expect(page.getByTestId("analysis-selected")).toContainText("••••");
    await expect(page.getByTestId("analysis-selected")).not.toContainText("2,176.69");
    await expect(page.getByTestId("analysis-matching")).not.toContainText("2,151.69");
    await page.screenshot({
      path: testInfo.outputPath("mobile-analysis-private.png"),
      fullPage: true,
    });
    await page.evaluate(() => {
      localStorage.setItem("privacy-settings", "false");
      window.dispatchEvent(
        new CustomEvent("wf:privacy-changed", { detail: { isBalanceHidden: false } }),
      );
    });
    await expectMoney("selected", SPENDING, CASH_MOVEMENT);
    await page.setViewportSize({ width: 1440, height: 1000 });
  });

  test("insights category drawer opens the full descendant scope with date and account context", async ({}, testInfo) => {
    await gotoAppPath(page, "/spending/insights?stage=where&period=MTD");
    await page.getByRole("row").filter({ hasText: parentName }).click();
    const drawer = page.getByRole("dialog");
    await expect(drawer).toBeVisible();
    await expect(drawer).toContainText(`${CATEGORIZED_COUNT} total`);
    await expect(drawer.getByRole("status")).toContainText("2,176.69");
    await drawer.getByRole("button", { name: /Load \d+ more/ }).click();
    await expect(drawer).toContainText(`${CATEGORIZED_COUNT} total`);
    await expect(drawer.getByRole("status")).toContainText("2,176.69");
    await page.screenshot({
      path: testInfo.outputPath("desktop-category-drawer.png"),
      fullPage: true,
    });
    const link = drawer.getByRole("link", { name: /Open in Transactions|all transactions/i });
    const href = await link.getAttribute("href");
    expect(href).not.toBeNull();
    const params = new URL(href!, BASE_URL).searchParams;
    expect(params.get("analysis")).toBe("true");
    expect(params.get("category")).toBe(parentId);
    expect(params.get("from")).toBe(monthStart);
    expect(params.get("to")).toBe(monthEnd);
    expect(params.get("accounts")?.split(",").sort()).toEqual([accountId, otherAccountId].sort());
    await link.click();
    await expectCount(0, CATEGORIZED_COUNT);
    await region().getByRole("button", { name: "Select all matching" }).click();
    await expectCount(CATEGORIZED_COUNT, CATEGORIZED_COUNT);
    await expectMoney("selected", SPENDING, "-2176.69");
    await page.goBack();
    await expect(page).toHaveURL(/\/spending\/insights/);
    expect(new URL(page.url()).searchParams.get("stage")).toBe("where");
    expect(new URL(page.url()).searchParams.get("period")).toBe("MTD");
  });

  test("late category/event completions preserve newer choices and failures keep unchanged selection", async () => {
    const types = await api<{ id: string }[]>("/spending/event-types", undefined, "GET");
    const eventName = `Synthetic delayed event ${token}`;
    await api("/spending/events", {
      name: eventName,
      eventTypeId: types[0].id,
      startDate: `${day}T00:00:00Z`,
      endDate: `${day}T23:59:59Z`,
    });
    for (const kind of ["category", "event"] as const) {
      await gotoAppPath(page, activitiesPath({ analysis: "false", q: zeroCurrencyNote }));
      const purchase = page.getByRole("row").filter({ hasText: `${zeroCurrencyNote} purchase` });
      const refund = page.getByRole("row").filter({ hasText: `${zeroCurrencyNote} refund` });
      await purchase.getByRole("checkbox").click();
      await expect(bulkRegion()).toContainText("1 selected");
      let release: () => void = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const pattern =
        kind === "category"
          ? "**/spending/assignments/bulk"
          : "**/spending/cash-activities/*/event";
      let intercepted = false;
      await page.route(pattern, async (route) => {
        intercepted = true;
        await held;
        await route.continue();
      });
      const completed = page.waitForResponse((response) =>
        kind === "category"
          ? response.url().endsWith("/spending/assignments/bulk")
          : response.url().endsWith(`/spending/cash-activities/${zeroCurrencyIds[0]}/event`),
      );
      await bulkRegion()
        .getByRole("button", {
          name: kind === "category" ? "Categorize" : "Tag event",
          exact: true,
        })
        .click();
      await page
        .getByRole("option", {
          name: kind === "category" ? parentName : new RegExp(eventName),
          exact: kind === "category",
        })
        .click();
      await expect.poll(() => intercepted).toBe(true);
      await page.getByRole("button", { name: "Analyze selection", exact: true }).click();
      await expectCount(1, 2);
      await refund.getByRole("checkbox").click();
      await expectCount(2, 2);
      release();
      await (await completed).finished();
      await expect(
        page.getByText(kind === "category" ? "Categorized 1 activity." : "Tagged 1 activity.", {
          exact: true,
        }),
      ).toBeVisible();
      await expectCount(2, 2);
      await expect(purchase.getByRole("checkbox")).toBeChecked();
      await expect(refund.getByRole("checkbox")).toBeChecked();
      await page.unroute(pattern);
      await region().getByRole("button", { name: "Exit analysis" }).click();
      await expect(bulkRegion()).toContainText("2 selected");
      await page.getByRole("button", { name: "Analyze selection", exact: true }).click();
      await expectCount(2, 2);
    }

    await gotoAppPath(page, activitiesPath({ analysis: "false", q: zeroCurrencyNote }));
    await page
      .getByRole("checkbox", { name: "Select all visible transactions", exact: true })
      .click();
    await expect(bulkRegion()).toContainText("2 selected");
    await page.route("**/spending/assignments/bulk", (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: '{"error":"Synthetic category failure"}',
      }),
    );
    await bulkRegion().getByRole("button", { name: "Categorize", exact: true }).click();
    await page.getByRole("option", { name: parentName, exact: true }).click();
    await expect(page.getByText("Failed to apply categories.", { exact: true })).toBeVisible();
    await expect(bulkRegion()).toContainText("2 selected");
    await page.unroute("**/spending/assignments/bulk");

    await page.route("**/spending/cash-activities/*/event", (route) =>
      route.request().url().includes(zeroCurrencyIds[0])
        ? route.fulfill({
            status: 503,
            contentType: "application/json",
            body: '{"error":"Synthetic event failure"}',
          })
        : route.continue(),
    );
    await bulkRegion().getByRole("button", { name: "Tag event", exact: true }).click();
    await page.getByRole("option", { name: new RegExp(eventName) }).click();
    await expect(page.getByText("Failed on 1 activity.", { exact: true })).toBeVisible();
    await expect(bulkRegion()).toContainText("2 selected");
    await page.unroute("**/spending/cash-activities/*/event");
    await page.getByRole("button", { name: "Analyze selection", exact: true }).click();
    await expectCount(2, 2);
  });

  test("keeps 1001 selected rows while disabling oversized categorization and respecting the API limit", async ({}, testInfo) => {
    test.setTimeout(90000);
    const note = `Synthetic oversized ${token}`;
    const ids: string[] = [];
    for (const size of [500, 500, 1]) {
      const seeded = await api<{ created: { id: string }[]; errors: unknown[] }>(
        "/activities/bulk",
        {
          creates: Array.from({ length: size }, (_, index) => ({
            id: randomUUID(),
            accountId,
            activityType: "WITHDRAWAL",
            currency: "CAD",
            amount: "1",
            activityDate: `${day}T08:00:00Z`,
            notes: `${note} ${ids.length + index}`,
          })),
        },
      );
      expect(seeded.errors).toEqual([]);
      expect(seeded.created).toHaveLength(size);
      ids.push(...seeded.created.map((row) => row.id));
    }
    await gotoAppPath(page, activitiesPath({ q: note }));
    await expectCount(0, 1001);
    await region().getByRole("button", { name: "Select all matching" }).click();
    await expectCount(1001, 1001);
    await region().getByRole("button", { name: "Exit analysis" }).click();
    await expect(bulkRegion()).toContainText("1001 selected");
    await expect(
      bulkRegion().getByRole("button", { name: "Categorize", exact: true }),
    ).toBeDisabled();
    await expect(bulkRegion()).toContainText("Categorize up to 1000 transactions at once.");
    const rejected = await page.request.post(`${BASE_URL}/api/v1/spending/assignments/bulk`, {
      data: ids.map((activityId) => ({ activityId, taxonomyId: TAXONOMY, categoryId: parentId })),
    });
    expect(rejected.status()).toBe(400);
    expect(await rejected.text()).toContain("At most 1000");
    expect((await search({ search: note, status: "uncategorized" })).totalCount).toBe(1001);
    await expect(bulkRegion()).toContainText("1001 selected");
    await page.screenshot({
      path: testInfo.outputPath("oversized-categorization-retains-selection.png"),
      fullPage: true,
    });
    await page.getByRole("button", { name: "Analyze selection", exact: true }).click();
    await expectCount(1001, 1001);
  });

  test("revalidates bulk delete confirmation through pending, error and changed snapshots without gating single-row delete", async ({}, testInfo) => {
    const outside = await api<{ id: string }>("/taxonomies/categories", {
      taxonomyId: TAXONOMY,
      name: `Outside confirmation ${token}`,
      key: randomUUID(),
      parentId: null,
      color: "#3b82f6",
      sortOrder: 101,
    });
    await gotoAppPath(page, activitiesPath({ q: ordinaryNote, category: parentId }));
    await expectCount(0, 120);
    await region().getByRole("button", { name: "Select all matching" }).click();
    await region().getByRole("button", { name: "Exit analysis" }).click();
    await expect(bulkRegion()).toContainText("120 selected");
    const deletes: string[] = [];
    const recordDelete = (request: import("@playwright/test").Request) => {
      if (request.method() === "DELETE" && request.url().includes("/api/v1/activities/"))
        deletes.push(request.url());
    };
    page.on("request", recordDelete);
    await bulkRegion().getByRole("button", { name: "Delete", exact: true }).click();
    const dialog = page.getByRole("alertdialog");
    const confirm = dialog.getByRole("button", { name: "Delete", exact: true });
    const underlyingBulk = page.locator('[role="region"][aria-label="Bulk actions"]');
    await expect(confirm).toBeEnabled();
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let failRead = true;
    await page.route(`**${SEARCH_PATH}`, async (route) => {
      if (!route.request().postDataJSON().includeSelectionSnapshot) return route.continue();
      await held;
      if (failRead)
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: '{"error":"Synthetic confirmation read failure"}',
        });
      else await route.continue();
    });
    await page.context().setOffline(true);
    await page.waitForFunction(() => !navigator.onLine);
    await page.context().setOffline(false);
    await expect(underlyingBulk).toContainText("Preparing selected transactions...");
    await expect(confirm).toBeDisabled();
    await confirm.click({ force: true });
    expect(deletes).toEqual([]);
    release();
    await expect(underlyingBulk).toContainText("Your selection is preserved.");
    await expect(confirm).toBeDisabled();
    expect(deletes).toEqual([]);

    await api("/spending/assignments/bulk", [
      { activityId: firstExpenseId, taxonomyId: TAXONOMY, categoryId: outside.id },
    ]);
    failRead = false;
    await page.context().setOffline(true);
    await page.waitForFunction(() => !navigator.onLine);
    await page.context().setOffline(false);
    await expect(underlyingBulk).toContainText("119 selected");
    await expect(confirm).toBeDisabled();
    await expect(dialog.getByRole("alert")).toContainText("Selection changed or is still loading.");
    await page.screenshot({
      path: testInfo.outputPath("invalidated-bulk-delete-confirmation.png"),
      fullPage: true,
    });
    await confirm.click({ force: true });
    expect(deletes).toEqual([]);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await page.unroute(`**${SEARCH_PATH}`);
    await bulkRegion().getByRole("button", { name: "Clear", exact: true }).click();
    await expect(bulkRegion()).toHaveCount(0);
    const single = page.getByRole("row").filter({ hasText: `${ordinaryNote} 001` });
    await single.getByRole("button", { name: "Row actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
    await expect(confirm).toBeEnabled();
    await confirm.click();
    await expect(page.getByText("Deleted 1 activity.", { exact: true })).toBeVisible();
    expect(deletes).toHaveLength(1);
    expect(deletes[0]).toContain(`/activities/${ordinaryIds[1]}`);
    page.off("request", recordDelete);
  });

  test("late and partially failed deletes do not clear newer or surviving selections", async () => {
    await gotoAppPath(page, activitiesPath({ analysis: "false", q: ordinaryNote }));
    const oldRow = page.getByRole("row").filter({ hasText: `${ordinaryNote} 002` });
    const newRow = page.getByRole("row").filter({ hasText: `${ordinaryNote} 003` });
    await oldRow.getByRole("checkbox").click();
    await expect(bulkRegion()).toContainText("1 selected");
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const oldPath = `**/activities/${ordinaryIds[2]}`;
    await page.route(oldPath, async (route) => {
      await held;
      await route.continue();
    });
    const completed = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/activities/${ordinaryIds[2]}`) &&
        response.request().method() === "DELETE",
    );
    await bulkRegion().getByRole("button", { name: "Delete", exact: true }).click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Delete", exact: true })
      .click();
    await page.getByRole("button", { name: "Analyze selection", exact: true }).click();
    await expectCount(1, 119);
    await oldRow.getByRole("checkbox").click();
    await newRow.getByRole("checkbox").click();
    await expectCount(1, 119);
    release();
    await (await completed).finished();
    await expect(page.getByText("Deleted 1 activity.", { exact: true })).toBeVisible();
    await expectCount(1, 118);
    await expect(newRow.getByRole("checkbox")).toBeChecked();
    await page.unroute(oldPath);

    await region().getByRole("button", { name: "Clear selection" }).click();
    await page
      .getByRole("row")
      .filter({ hasText: `${ordinaryNote} 004` })
      .getByRole("checkbox")
      .click();
    await page
      .getByRole("row")
      .filter({ hasText: `${ordinaryNote} 005` })
      .getByRole("checkbox")
      .click();
    await expectCount(2, 118);
    await region().getByRole("button", { name: "Exit analysis" }).click();
    await expect(bulkRegion()).toContainText("2 selected");
    const failedPath = `**/activities/${ordinaryIds[4]}`;
    await page.route(failedPath, (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: '{"error":"Synthetic delete failure"}',
      }),
    );
    await bulkRegion().getByRole("button", { name: "Delete", exact: true }).click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Delete", exact: true })
      .click();
    await expect(page.getByText("Failed to delete 1 activity.", { exact: true })).toBeVisible();
    await expect(bulkRegion()).toContainText("1 selected");
    await page.unroute(failedPath);
    await page.getByRole("button", { name: "Analyze selection", exact: true }).click();
    await expectCount(1, 117);
    await expect(
      page
        .getByRole("row")
        .filter({ hasText: `${ordinaryNote} 004` })
        .getByRole("checkbox"),
    ).toBeChecked();
  });
});
