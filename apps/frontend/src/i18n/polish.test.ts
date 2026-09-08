import i18next from "i18next";
import { describe, expect, it } from "vitest";
import { NAMESPACES } from "./locales";

interface Catalog {
  [key: string]: string | Catalog;
}

const english = import.meta.glob<Catalog>("./locales/en/*.json", {
  eager: true,
  import: "default",
});
const polish = import.meta.glob<Catalog>("./locales/pl/*.json", {
  eager: true,
  import: "default",
});

function flatten(catalog: Catalog, prefix = ""): Map<string, string> {
  return new Map(
    Object.entries(catalog).flatMap(([key, value]) => {
      const path = prefix ? `${prefix}.${key}` : key;
      return typeof value === "string" ? [[path, value]] : [...flatten(value, path)];
    }),
  );
}

function tokens(value: string, pattern: RegExp) {
  return [...value.matchAll(pattern)].map(([match]) => match).sort();
}

const pluralCategories = new Intl.PluralRules("pl").resolvedOptions().pluralCategories;
const counts = [0, 1, 2, 3, 4, 5, 11, 12, 14, 21, 22, 23, 25, 101, 112, 122, 1_000_000, 1.5];

describe("Polish catalogs", () => {
  it("ships exactly every application namespace", () => {
    expect(
      Object.keys(polish)
        .map((path) => path.replace("./locales/pl/", "").replace(".json", ""))
        .sort(),
    ).toEqual([...NAMESPACES].sort());
  });

  it.each(NAMESPACES)("%s preserves all keys, placeholders, markup and links", (namespace) => {
    const source = flatten(english[`./locales/en/${namespace}.json`]);
    const translated = flatten(polish[`./locales/pl/${namespace}.json`]);
    const expected = new Map(source);

    for (const [key] of source) {
      if (!key.endsWith("_one")) continue;
      const stem = key.slice(0, -4);
      const other = source.get(`${stem}_other`);
      if (other === undefined) continue;
      for (const category of pluralCategories) {
        if (!expected.has(`${stem}_${category}`)) expected.set(`${stem}_${category}`, other);
      }
    }

    expect([...translated.keys()].sort()).toEqual([...expected.keys()].sort());
    for (const [key, original] of expected) {
      const value = translated.get(key)!;
      expect(value.trim(), `${namespace}:${key}`).not.toBe("");
      for (const pattern of [
        /{{[^}]+}}/g,
        /<\/?[\w]+(?:\s[^>]*?)?\/?>/g,
        /https?:\/\/[^\s)<"]+/g,
      ]) {
        expect(tokens(value, pattern), `${namespace}:${key}`).toEqual(tokens(original, pattern));
      }
    }
  });

  it.each(NAMESPACES)("%s resolves every plural category without fallback", async (namespace) => {
    const source = flatten(english[`./locales/en/${namespace}.json`]);
    const catalog = polish[`./locales/pl/${namespace}.json`];
    const translated = flatten(catalog);
    const i18n = i18next.createInstance();
    await i18n.init({
      lng: "pl",
      fallbackLng: false,
      defaultNS: namespace,
      resources: { pl: { [namespace]: catalog } },
      interpolation: { escapeValue: false },
    });

    for (const key of source.keys()) {
      if (!key.endsWith("_one")) continue;
      const stem = key.slice(0, -4);
      if (!source.has(`${stem}_other`)) continue;
      for (const count of counts) {
        const category = new Intl.PluralRules("pl").select(count);
        const form = translated.get(`${stem}_${category}`)!;
        const values = Object.fromEntries(
          [...form.matchAll(/{{\s*([^},\s]+)[^}]*}}/g)].map(([, name]) => [name, "TEST"]),
        );
        const result = i18n.t(stem, { ...values, count });
        expect(result, `${namespace}:${stem} (${count})`).toBe(
          i18n.t(`${stem}_${category}`, { ...values, count }),
        );
        expect(result).not.toBe(stem);
        expect(result).not.toContain("{{");
        expect(result.trim()).not.toBe("");
      }
    }
  });

  it("uses Polish CLDR categories, including teens and fractional counts", () => {
    const rules = new Intl.PluralRules("pl");
    expect([0, 1, 2, 5, 12, 22, 1.5].map((count) => rules.select(count))).toEqual([
      "many",
      "one",
      "few",
      "many",
      "many",
      "few",
      "other",
    ]);
  });

  it("inflects financial account counts naturally", async () => {
    const i18n = i18next.createInstance();
    await i18n.init({
      lng: "pl",
      fallbackLng: false,
      resources: { pl: { dashboard: polish["./locales/pl/dashboard.json"] } },
    });
    for (const [count, expected] of [
      [0, "0 rachunków"],
      [1, "1 rachunek"],
      [2, "2 rachunki"],
      [5, "5 rachunków"],
      [12, "12 rachunków"],
      [22, "22 rachunki"],
    ] as const) {
      expect(i18n.t("dashboard:accounts_count", { count })).toBe(expected);
    }
  });

  it("keeps financial terminology and cash-flow buckets distinct", () => {
    const common = flatten(polish["./locales/pl/common.json"]);
    const holdings = flatten(polish["./locales/pl/holdings.json"]);
    const spending = flatten(polish["./locales/pl/spending.json"]);

    expect(common.get("activities")).toBe("Operacje");
    expect(common.get("holdings")).toBe("Pozycje");
    expect(holdings.get("cost_basis")).toBe("Koszt nabycia");
    expect(holdings.get("return")).toBe("Stopa zwrotu");
    expect(spending.get("cashFlow.income")).toBe("Przychody");
    expect(spending.get("cashFlow.spending")).toBe("Wydatki");
    expect(spending.get("cashFlow.saving")).toBe("Oszczędności");
    expect(spending.get("cashFlow.net")).toBe("Przepływy pieniężne netto");
  });
});
