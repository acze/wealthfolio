import { defineConfig } from "i18next-cli";

// Config for `i18next-cli` (extract / status / lint / types / instrument).
// Keep `locales` in sync with SUPPORTED_LOCALES in src/i18n/locales.ts.
export default defineConfig({
  locales: ["en", "fr", "de", "es", "pt", "zh", "zh-Hant", "ja", "ko", "it", "pl"],
  extract: {
    input: ["src/**/*.{ts,tsx}"],
    // Addon test fixtures contain deliberately missing keys, not app translations.
    ignore: ["src/**/*.{test,spec}.{ts,tsx}", "src/**/__tests__/**"],
    output: "src/i18n/locales/{{language}}/{{namespace}}.json",
    defaultNS: "common",
    // Preserve keys that exist in the JSON but aren't (yet) referenced in code,
    // so community-contributed translations are never dropped by an extract run.
    removeUnusedKeys: false,
  },
});
