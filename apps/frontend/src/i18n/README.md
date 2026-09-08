# Internationalization (i18n)

Wealthfolio uses [i18next](https://www.i18next.com/) +
[react-i18next](https://react.i18next.com/).

## Layout

```
src/i18n/
  i18n.ts        # runtime init (lazy-loads locale JSON, no browser auto-detect)
  locales.ts     # SUPPORTED_LOCALES, NAMESPACES, DEFAULT_LOCALE  (single source of truth)
  locales/
    en/<ns>.json # source language (canonical keys)
    fr/<ns>.json
    de/<ns>.json
```

Namespaces (one JSON file each): `common`, `dashboard`, `holdings`, `activity`,
`performance`, `account`, `settings`, `goals`, `income`, `insights`, `asset`,
`spending`, `ui`, `ai`, `allocation`, `onboarding`, `auth`, `health`, `sync`,
`connect`.

## Using translations in code

Keys are referenced with the fully-qualified `namespace:key` form so the default
hook works everywhere:

```tsx
import { useTranslation } from "react-i18next";

function Example() {
  const { t } = useTranslation();
  return <h1>{t("settings:title")}</h1>;
}
```

Interpolation uses i18next's `{{var}}` syntax:
`t("common:activities_count", { count })`.

## Language selection

Language is an **explicit, stored user setting** (`Settings.language`), not
browser-detected. It is chosen during onboarding and in Settings → General, and
persisted through the normal settings pipeline (stored per-device, like `theme`
and `baseCurrency` — device-sync is not enabled for it). The settings provider
applies it via `i18n.changeLanguage()` on load and on change. Default is `en`;
missing translations fall back to `en`. Adding a language never changes an
existing language preference, formatting region, timezone, or base currency.

## Maintenance (i18next-cli)

Config: `apps/frontend/i18next.config.ts`.

```bash
pnpm --filter frontend i18n:status   # coverage per namespace/locale
pnpm --filter frontend i18n:extract  # sync JSON with t() keys used in code
pnpm --filter frontend i18n:lint     # find remaining hardcoded strings
pnpm --filter frontend i18n:types    # generate typed keys
```

`extract` never removes unreferenced keys (`removeUnusedKeys: false`) so
community-contributed translations are preserved. Extraction and status checks
exclude test fixtures, whose deliberately missing addon keys are not app
strings.

## Adding a language

A locale code is public API — addons read it, and it is persisted per device —
so pick it deliberately before shipping. Five places have to agree:

1. `locales/<code>/` — one JSON file per namespace, complete parity with `en`.
2. `SUPPORTED_LOCALES` in `locales.ts`.
3. `locales` in `i18next.config.ts`.
4. `SUPPORTED_UI_LANGUAGES` in `crates/core/src/settings/settings_service.rs`,
   plus any alias normalization (`fr-CA` -> `fr`).
5. `addon-sandbox-i18n.ts`, if the locale should reach addon iframes.

Register the date-fns locale in `packages/ui/src/hooks/use-date-fns-locale.ts`
for complete calendar and relative-date text. An optional formatting region is a
separate setting: keep the shared formatting registry, backend region allowlist,
Settings and onboarding options in sync. Do not infer currency from UI language.

### Naming

Bare language codes (`fr`, `ja`) unless the language is written in more than one
script. Chinese is the case that matters: `zh` means Simplified (CLDR expands it
to `zh-Hans-CN`) and `zh-Hant` means Traditional. Name Chinese variants by
**script**, not region — one `zh-Hant` catalog serves Taiwan, Hong Kong and
Macau, and regional differences belong in `formattingRegion`, which is a
separate setting. A `zh-Hant-HK` catalog can be added later and will fall back
to `zh-Hant`; that path does not exist from a region-named `zh-TW`.

Fallback never crosses a script boundary: a missing `zh-Hant` string resolves to
`en`, not `zh`. Mixed glyphs read as broken, untranslated text reads as missing.

### Terminology

Each locale should carry a glossary test (see `traditional-chinese.test.ts`)
asserting the term the catalog standardises on and rejecting its alternates. Key
parity and a green suite do not catch a catalog that says "Return" three
different ways — only a glossary does.

## Provenance of current translations

- **English keys + French**: adapted from PR #416 (namespaced structure, 100%
  FR), with single-brace `{var}` interpolation converted to i18next `{{var}}`.
- **German**: value-joined from PR #845 by matching English source text onto the
  English keys (~65% auto-coverage); the remainder falls back to English and is
  filled by AI draft + community review. See `scripts/i18n-remap.mjs`.
- **Korean**: AI-drafted, full-coverage translation of all namespaces against
  the English source keys, using standard Korean financial/investment
  terminology; intended for community review.
- **Italian**: community contribution (PR #1588), full coverage of all
  namespaces, reviewed against the terminology already used by the French and
  Spanish sets (`Posizioni`, `Classe di attività`, `Costo di carico`) and
  Italian sentence case; `_many` plural forms are required because Italian has a
  CLDR `many` category. Intended for continued community review.
- **Portuguese (pt-BR)**: community contribution (PR #1533), full coverage of
  all namespaces in Brazilian Portuguese. Terminology follows Brazilian market
  usage — `Posições`, `Carteira`, `Custo de aquisição`, `Rentabilidade`, `L/P`,
  `Valores mobiliários`, `Aportes`, `Desdobramento de ações` — and Brazilian
  punctuation (`"..."`, never `«...»`). `_many` plural forms are required
  because Portuguese has a CLDR `many` category. Intended for continued
  community review.
- **Traditional Chinese (`zh-Hant`)**: contributed in PR #1566, machine-seeded
  from the English source and reviewed for Taiwan financial terminology by a
  native speaker; intended for continued community review.
- **Polish (`pl`)**: AI-assisted translation of all 20 namespaces, with Polish
  financial terminology and `_one`, `_few`, `_many`, `_other` forms. For
  example, 1 uses `_one`, 2 and 22 use `_few`, 0, 5 and 12 use `_many`, and
  fractional counts use `_other`. `polish.test.ts` covers catalog parity,
  interpolation, markup, links, plural resolution and key financial
  distinctions: `wydatki` (spending), `przychody` (income), `oszczędności`
  (saving), and `przepływy pieniężne netto` (net cash flow). Financial accounts
  are `rachunki`, holdings `pozycje`, cost basis `koszt nabycia`, and return
  `stopa zwrotu`. The optional `PL` formatting region controls presentation
  only; currency codes and saved category names are not translated or migrated.
  Addons supply their own content translations; their shared `ui` components
  receive the host's Polish catalog.

Non-English catalogs are machine-drafted and community-corrected. Terminology
reports are expected and welcome — file them as issues against the locale.
