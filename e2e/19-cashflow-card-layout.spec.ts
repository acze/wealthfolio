import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { BASE_URL, completeOnboardingIfNeeded, gotoAppPath } from "./helpers";

test.describe.configure({ mode: "serial" });

const scenarios = [
  { name: "deficit", income: "12345.67", spent: "15000", saved: "2000" },
  { name: "long amounts", income: "1234567890.67", spent: "2345678901.23", saved: "987654321.12" },
  { name: "no income", income: "0", spent: "15000", saved: "2000" },
  { name: "zero", income: "0", spent: "0", saved: "0" },
  { name: "surplus", income: "20000", spent: "15000", saved: "0" },
] as const;

test.describe("Cashflow card translated layout", () => {
  let page: Page;
  const accountIds = new Map<string, string>();
  const day = new Date().toISOString().slice(0, 10);

  async function api<T>(path: string, data: unknown, method = "POST"): Promise<T> {
    const response = await page.request.fetch(`${BASE_URL}/api/v1${path}`, { method, data });
    expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBe(true);
    return response.json() as Promise<T>;
  }

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(120000);
    page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    await page.context().tracing.start({ screenshots: true, snapshots: true });
    await completeOnboardingIfNeeded(page);
    await api(
      "/settings",
      {
        language: "pl",
        formattingRegion: "PL",
        baseCurrency: "PLN",
        timezone: "UTC",
        font: "font-mono",
      },
      "PUT",
    );
    for (const scenario of scenarios) {
      const account = await api<{ id: string }>("/accounts", {
        name: `Synthetic cashflow ${scenario.name} ${randomUUID()}`,
        accountType: "CASH",
        currency: "PLN",
        isDefault: false,
        isActive: true,
      });
      accountIds.set(scenario.name, account.id);
      const amounts = [
        { activityType: "DEPOSIT", amount: scenario.income },
        { activityType: "WITHDRAWAL", amount: scenario.spent },
      ].filter(({ amount }) => amount !== "0");
      if (amounts.length > 0) {
        const created = await api<{ errors: unknown[] }>("/activities/bulk", {
          creates: amounts.map((entry) => ({
            ...entry,
            id: randomUUID(),
            accountId: account.id,
            currency: "PLN",
            activityDate: `${day}T12:00:00Z`,
            notes: `Synthetic cashflow ${scenario.name}`,
          })),
        });
        expect(created.errors).toEqual([]);
      }
      if (scenario.saved !== "0") {
        const investment = await api<{ id: string }>("/accounts", {
          name: `Synthetic savings destination ${scenario.name} ${randomUUID()}`,
          accountType: "SECURITIES",
          currency: "PLN",
          isDefault: false,
          isActive: true,
        });
        await api("/activities/transfer-pair", {
          fromAccountId: account.id,
          toAccountId: investment.id,
          activityDate: `${day}T12:00:00Z`,
          sourceAmount: scenario.saved,
          destinationAmount: scenario.saved,
          sourceCurrency: "PLN",
          destinationCurrency: "PLN",
          notes: "Synthetic cashflow saving",
        });
      }
    }
  });

  test.afterAll(async ({}, testInfo) => {
    await page?.context().tracing.stop({ path: testInfo.outputPath("cashflow-layout-trace.zip") });
    await page?.close();
  });

  async function measureCard() {
    return page.getByTestId("net-cashflow-card").evaluate((card) => {
      const box = (el: Element) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width };
      };
      const textBoxes = (el: Element) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        return [...range.getClientRects()].map((r) => ({
          left: r.left,
          right: r.right,
          top: r.top,
          bottom: r.bottom,
        }));
      };
      const rows = [...card.querySelectorAll('[data-testid="net-cashflow-row"]')].map((row) => {
        const [label, track, amount] = [...row.children];
        return {
          label: label.textContent,
          labelBox: box(label),
          labelText: textBoxes(label),
          track: box(track),
          amount: amount.textContent,
          amountBox: box(amount),
          amountText: textBoxes(amount),
          clipped: row.scrollWidth > row.clientWidth,
          fontSize: getComputedStyle(label).fontSize,
          lineClamp: getComputedStyle(label).getPropertyValue("-webkit-line-clamp"),
        };
      });
      const headline = card.children[1];
      return {
        card: box(card),
        clipped: card.scrollWidth > card.clientWidth,
        rows,
        headline: [...headline.children].map((el) => ({ box: box(el), text: textBoxes(el) })),
        mono: document.body.classList.contains("font-mono"),
        columns: getComputedStyle(card.children[2]).gridTemplateColumns.split(" ").length,
      };
    });
  }

  for (const scenario of scenarios) {
    test(`${scenario.name}: complete labels, aligned bars and amounts at desktop and 390/320px`, async ({}, testInfo) => {
      await api(
        "/spending/settings",
        { enabled: true, accountIds: [accountIds.get(scenario.name)!] },
        "PUT",
      );
      const measurements = [];
      for (const width of [1920, 1280, 390, 320]) {
        await page.setViewportSize({ width, height: 1000 });
        await gotoAppPath(page, "/spending/insights?stage=where&period=MTD");
        const card = page.getByTestId("net-cashflow-card");
        await expect(card).toBeVisible({ timeout: 30000 });
        await page.evaluate(() => document.fonts.ready);
        const labels = [
          "Przychody",
          "Wydano",
          ...(scenario.saved !== "0" ? ["Zaoszczędzono"] : []),
        ];
        await expect(card.getByTestId("net-cashflow-row")).toHaveCount(labels.length);
        const result = await measureCard();
        expect(result.mono).toBe(true);
        expect(result.clipped).toBe(false);
        expect(result.rows.map((row) => row.label)).toEqual(labels);
        const formatter = new Intl.NumberFormat("pl-PL", { style: "currency", currency: "PLN" });
        const values = [
          scenario.income,
          scenario.spent,
          ...(scenario.saved !== "0" ? [scenario.saved] : []),
        ];
        expect(result.rows.map((row) => row.amount?.replace(/\s/g, " "))).toEqual(
          values.map((value) => formatter.format(Number(value)).replace(/\s/g, " ")),
        );
        for (const row of result.rows) {
          expect(row.fontSize).toBe("11px");
          expect(row.clipped).toBe(false);
          expect(row.track.width).toBeGreaterThan(0);
          for (const rect of [...row.labelText, ...row.amountText]) {
            expect(rect.left).toBeGreaterThanOrEqual(result.card.left - 1);
            expect(rect.right).toBeLessThanOrEqual(result.card.right + 1);
            const overlapsTrack =
              rect.left < row.track.right &&
              rect.right > row.track.left &&
              rect.top < row.track.bottom &&
              rect.bottom > row.track.top;
            expect(overlapsTrack, `text must not cover a bar at ${width}px`).toBe(false);
          }
          expect(row.labelBox.right).toBeLessThanOrEqual(row.amountBox.left);
          expect(Math.abs(row.track.left - result.rows[0].track.left)).toBeLessThan(1);
          expect(Math.abs(row.track.right - result.rows[0].track.right)).toBeLessThan(1);
          expect(Math.abs(row.amountBox.right - result.rows[0].amountBox.right)).toBeLessThan(1);
        }
        for (const part of result.headline) {
          for (const rect of part.text) {
            expect(rect.left).toBeGreaterThanOrEqual(result.card.left - 1);
            expect(rect.right).toBeLessThanOrEqual(result.card.right + 1);
          }
        }
        if (result.headline.length === 2) {
          const [amount, pill] = result.headline.map((part) => part.box);
          expect(
            amount.right <= pill.left || amount.bottom <= pill.top || pill.bottom <= amount.top,
          ).toBe(true);
        }
        if (scenario.income === "0") await expect(card).toContainText("Brak przychodów");
        measurements.push({ width, ...result });
        if (width === 320 || (width === 1280 && scenario.name === "deficit")) {
          await card.screenshot({ path: testInfo.outputPath(`cashflow-${width}.png`) });
        }
      }
      await testInfo.attach("synthetic-dom-geometry", {
        body: JSON.stringify(measurements, null, 2),
        contentType: "application/json",
      });

      await page.evaluate(() => {
        localStorage.setItem("privacy-settings", "true");
        window.dispatchEvent(
          new CustomEvent("wf:privacy-changed", { detail: { isBalanceHidden: true } }),
        );
      });
      const card = page.getByTestId("net-cashflow-card");
      await expect(card.getByTestId("net-cashflow-row").first()).toContainText("••••");
      const hidden = await measureCard();
      expect(hidden.clipped).toBe(false);
      expect(hidden.rows.every((row) => row.amount === "••••")).toBe(true);
      expect(hidden.rows.map((row) => row.label)).toEqual([
        "Przychody",
        "Wydano",
        ...(scenario.saved !== "0" ? ["Zaoszczędzono"] : []),
      ]);
      await page.evaluate(() => {
        localStorage.setItem("privacy-settings", "false");
        window.dispatchEvent(
          new CustomEvent("wf:privacy-changed", { detail: { isBalanceHidden: false } }),
        );
      });
    });
  }
});
