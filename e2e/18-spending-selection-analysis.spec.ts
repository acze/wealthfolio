import { randomUUID } from "node:crypto";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { BASE_URL, completeOnboardingIfNeeded, gotoAppPath } from "./helpers";

const SEARCH_PATH = "/api/v1/spending/cash-activities/search";
const TAXONOMY = "spending_categories";
const COUNT = 125;
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
  const token = randomUUID().slice(0, 8);
  const parentName = `Analysis parent ${token}`;
  const childName = `Analysis child ${token}`;
  const grandchildName = `Analysis grandchild ${token}`;
  const accountName = `Analysis cash ${token}`;
  const otherAccountName = `Analysis other ${token}`;
  const outlierNote = `Synthetic outlier ${token}`;
  const ordinaryNote = `Synthetic ordinary ${token}`;
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
    // Scroll the real virtualized list; no DOM injection or API-only exclusion.
    await expect
      .poll(
        async () => {
          if (await row.isVisible()) return true;
          await page.evaluate(() => {
            for (const el of document.querySelectorAll<HTMLElement>(
              "[data-virtual-scroll-parent],[data-page-scroll-container]",
            )) {
              if (el.scrollHeight > el.clientHeight) el.scrollBy(0, 520);
            }
          });
          return false;
        },
        { timeout: 30000, intervals: [100, 200, 300] },
      )
      .toBe(true);
    await row.scrollIntoViewIfNeeded();
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
    const sentinel = activity(`Other account sentinel ${token}`, "42.42", "WITHDRAWAL", {
      accountId: otherAccountId,
    });
    const result = await api<{ created: { id: string; notes: string }[]; errors: unknown[] }>(
      "/activities/bulk",
      {
        creates: [...ordinary, outlier, refund, income, sentinel],
      },
    );
    expect(result.errors).toEqual([]);
    expect(result.created).toHaveLength(124);
    const persistedIds = new Map(result.created.map((row) => [row.notes, row.id]));
    firstExpenseId = persistedIds.get(ordinary[0].notes)!;
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
      [...ordinary, outlier, refund].map((row, index) => ({
        activityId: persistedIds.get(row.notes)!,
        taxonomyId: TAXONOMY,
        categoryId: [parentId, childId, grandchildId][index % 3],
      })),
    );
    const response = await search({ limit: 50, sortBy: "date", sortDir: "desc" });
    expect(response.totalCount).toBe(COUNT);
    expect(response.items).toHaveLength(50);
    expect(response.items.some((item) => item.id === outlierId)).toBe(false);
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

  test("selects every matching page, excludes a late outlier with Space, and keeps bulk editing separate", async ({}, testInfo) => {
    test.setTimeout(90000);
    await gotoAppPath(page, activitiesPath({ analysis: "false" }));
    const firstExpense = page.getByRole("row").filter({ hasText: `${ordinaryNote} 000` });
    await firstExpense.getByRole("checkbox").click();
    await expect(page.getByRole("region", { name: "Bulk actions" })).toContainText("1 selected");
    await page.getByRole("button", { name: "Analyze selection", exact: true }).click();
    await expectCount(0);
    await expect(page.getByRole("region", { name: "Bulk actions" })).toHaveCount(0);
    const writes: string[] = [];
    const recordWrites = (request: import("@playwright/test").Request) => {
      if (
        ["POST", "PUT", "DELETE", "PATCH"].includes(request.method()) &&
        /\/api\/v1\/(?:activities(?:$|\/bulk$|\/transfer-pair$)|spending\/(?:assignments|activities)\/)/.test(
          request.url(),
        )
      ) {
        writes.push(request.url());
      }
    };
    page.on("request", recordWrites);
    await page
      .getByRole("checkbox", { name: "Select all visible transactions", exact: true })
      .click();
    await expectCount(50);
    await region().getByRole("button", { name: "Select all matching" }).click();
    await expectCount(COUNT);
    await expectMoney("matching", SPENDING, CASH_MOVEMENT);
    await expectMoney("selected", SPENDING, CASH_MOVEMENT);

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
    expect(exact.analysis.selected.count).toBe(124);
    expect(exact.analysis.excluded.count).toBe(1);
    assertNative(exact.analysis.selected.spending, "1175.70");
    assertNative(exact.analysis.selected.cashMovement, "-1150.70");

    await region().getByRole("button", { name: "Clear selection" }).click();
    await expectCount(0);
    await expectMoney("excluded", SPENDING, CASH_MOVEMENT);
    await region().getByRole("button", { name: "Exit analysis" }).click();
    await expect(region()).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Bulk actions" })).toHaveCount(0);
    page.off("request", recordWrites);
    expect(writes).toEqual([]);
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
    await expectCount(0, 122);
    await region().getByRole("button", { name: "Select all matching" }).click();
    await expectCount(122, 122);
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
    await expect(drawer).toContainText("122 total");
    await expect(drawer.getByRole("status")).toContainText("2,176.69");
    await drawer.getByRole("button", { name: /Load \d+ more/ }).click();
    await expect(drawer).toContainText("122 total");
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
    await expectCount(0, 122);
    await region().getByRole("button", { name: "Select all matching" }).click();
    await expectCount(122, 122);
    await expectMoney("selected", SPENDING, "-2176.69");
    await page.goBack();
    await expect(page).toHaveURL(/\/spending\/insights/);
    expect(new URL(page.url()).searchParams.get("stage")).toBe("where");
    expect(new URL(page.url()).searchParams.get("period")).toBe("MTD");
  });
});
