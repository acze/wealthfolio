import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import { describe, expect, it, vi } from "vitest";
import { ImportHelpPopover } from "@/pages/activity/import/import-help";
import { QuoteImportHelpPopover } from "@/pages/settings/market-data/components/quote-import-help-popover";
import plActivity from "./locales/pl/activity.json";
import plSettings from "./locales/pl/settings.json";
import plUi from "./locales/pl/ui.json";

vi.mock("@/hooks/use-platform", () => ({
  usePlatform: () => ({ isMobile: false }),
}));

async function polishI18n() {
  const i18n = i18next.createInstance();
  await i18n.init({
    lng: "pl",
    fallbackLng: false,
    resources: { pl: { activity: plActivity, settings: plSettings, ui: plUi } },
    interpolation: { escapeValue: false },
  });
  return i18n;
}

describe("Polish import help", () => {
  it("translates activity explanations but preserves CSV codes", async () => {
    const user = userEvent.setup();
    const i18n = await polishI18n();
    render(
      <I18nextProvider i18n={i18n}>
        <ImportHelpPopover />
      </I18nextProvider>,
    );
    await user.click(screen.getByRole("button"));

    expect(
      screen.getByText(`TRANSFER_IN (${i18n.t("activity:import.help.transferInDescription")})`),
    ).toBeInTheDocument();
    expect(screen.getByText(/SPLIT \(W polu Amount/)).toBeInTheDocument();
    expect(screen.queryByText(/Moves cash\/assets/)).not.toBeInTheDocument();
    expect(screen.getByText("BUY", { exact: true })).toBeInTheDocument();
  });

  it("translates quote-example comments without translating the CSV header", async () => {
    const user = userEvent.setup();
    const i18n = await polishI18n();
    render(
      <I18nextProvider i18n={i18n}>
        <QuoteImportHelpPopover />
      </I18nextProvider>,
    );
    await user.click(screen.getByRole("button"));

    expect(screen.getByText(i18n.t("settings:quote_help_format_comment_1"))).toBeInTheDocument();
    expect(screen.queryByText("# Required columns: symbol, date, close")).not.toBeInTheDocument();
    expect(screen.getByText(/symbol,date,open,high,low,close,volume,currency/)).toBeInTheDocument();
  });
});
