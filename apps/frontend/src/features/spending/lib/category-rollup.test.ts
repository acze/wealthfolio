import { describe, expect, it } from "vitest";

import {
  SAVINGS_ROW_ID,
  buildWhereItWentRows,
  expandCategoryIds,
  type CategoryMeta,
  type RollupMeta,
} from "./category-rollup";

describe("expandCategoryIds", () => {
  const categories = new Map<string, RollupMeta>([
    ["food", {}],
    ["groceries", { parentId: "food" }],
    ["produce", { parentId: "groceries" }],
    ["fruit", { parentId: "produce" }],
    ["travel", {}],
    ["flights", { parentId: "travel" }],
  ]);

  it("includes every descendant of a parent, in sorted order", () => {
    expect(expandCategoryIds(["food"], categories)).toEqual([
      "food",
      "fruit",
      "groceries",
      "produce",
    ]);
  });

  it("expands a nested subparent without including its ancestors or siblings", () => {
    expect(expandCategoryIds(["produce"], categories)).toEqual(["fruit", "produce"]);
  });

  it("deduplicates overlapping roots and accepts any iterable", () => {
    expect(expandCategoryIds(new Set(["travel", "groceries", "food"]), categories)).toEqual([
      "flights",
      "food",
      "fruit",
      "groceries",
      "produce",
      "travel",
    ]);
    expect(expandCategoryIds(["food", "food", "fruit"], categories)).toEqual(
      expandCategoryIds(["food"], categories),
    );
  });

  it("terminates cycles and self-parent links while retaining attached descendants", () => {
    const cyclic = new Map<string, RollupMeta>([
      ["a", { parentId: "c" }],
      ["b", { parentId: "a" }],
      ["c", { parentId: "b" }],
      ["leaf", { parentId: "b" }],
      ["self", { parentId: "self" }],
    ]);
    expect(expandCategoryIds(["c", "self", "a"], cyclic)).toEqual(["a", "b", "c", "leaf", "self"]);
  });

  it("retains unknown roots, including children whose parent metadata is missing", () => {
    expect(
      expandCategoryIds(["missing", "unknown"], new Map([["child", { parentId: "missing" }]])),
    ).toEqual(["child", "missing", "unknown"]);
    expect(expandCategoryIds([], categories)).toEqual([]);
  });

  it("does not truncate deeper-than-usual taxonomies", () => {
    const deep = new Map<string, RollupMeta>();
    for (let index = 0; index < 100; index++) {
      deep.set(`node-${index}`, { parentId: index ? `node-${index - 1}` : null });
    }
    expect(expandCategoryIds(["node-0"], deep)).toEqual(Array.from(deep.keys()).sort());
  });
});

const meta = (overrides: Record<string, CategoryMeta> = {}) =>
  new Map<string, CategoryMeta>([
    ["cat_groceries", { name: "Groceries", color: "#111", icon: null, parentId: null }],
    ["cat_rent", { name: "Rent", color: "#222", icon: null, parentId: null }],
    ...Object.entries(overrides),
  ]);

describe("buildWhereItWentRows", () => {
  it("appends a savings row when money was set aside this period", () => {
    const rows = buildWhereItWentRows({
      spendingBreakdown: [{ categoryId: "cat_groceries", amount: 100, count: 2 }],
      priorSpendingBreakdown: [],
      categoriesMeta: meta(),
      totalSaved: 500,
      priorSaved: 0,
      uncategorizedLabel: "Uncategorized",
      savingsLabel: "Saving",
    });

    const savings = rows.find((r) => r.id === SAVINGS_ROW_ID);
    expect(savings).toMatchObject({ name: "Saving", amount: 500 });
  });

  it("omits the savings row when nothing was saved", () => {
    const rows = buildWhereItWentRows({
      spendingBreakdown: [{ categoryId: "cat_groceries", amount: 100, count: 2 }],
      priorSpendingBreakdown: [],
      categoriesMeta: meta(),
      totalSaved: 0,
      priorSaved: 0,
      uncategorizedLabel: "Uncategorized",
      savingsLabel: "Saving",
    });

    expect(rows.find((r) => r.id === SAVINGS_ROW_ID)).toBeUndefined();
  });

  it("sorts the savings row by amount alongside spending categories", () => {
    const rows = buildWhereItWentRows({
      spendingBreakdown: [
        { categoryId: "cat_groceries", amount: 100, count: 2 },
        { categoryId: "cat_rent", amount: 1000, count: 1 },
      ],
      priorSpendingBreakdown: [],
      categoriesMeta: meta(),
      totalSaved: 500,
      priorSaved: 0,
      uncategorizedLabel: "Uncategorized",
      savingsLabel: "Saving",
    });

    expect(rows.map((r) => r.id)).toEqual(["cat_rent", SAVINGS_ROW_ID, "cat_groceries"]);
  });

  it("computes delta against the prior period's saved amount", () => {
    const rows = buildWhereItWentRows({
      spendingBreakdown: [],
      priorSpendingBreakdown: [],
      categoriesMeta: meta(),
      totalSaved: 600,
      priorSaved: 400,
      uncategorizedLabel: "Uncategorized",
      savingsLabel: "Saving",
    });

    const savings = rows.find((r) => r.id === SAVINGS_ROW_ID);
    expect(savings).toMatchObject({ delta: 200, deltaPct: 50 });
  });
});
