import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  Calendar,
  DatePickerInput,
  FormattingProvider,
  IntervalSelector,
  MonthYearPicker,
} from "@wealthfolio/ui";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import { describe, expect, it, vi } from "vitest";
import plUi from "@/i18n/locales/pl/ui.json";
import { MonthSwitcher } from "../features/spending/components/month-switcher";

describe("calendar localization policy", () => {
  it("formats month choices with the formatting locale", () => {
    render(
      <FormattingProvider locale="ja-JP" uiLocale="en">
        <MonthYearPicker value="2026-01" maxDate="2026-12" />
      </FormattingProvider>,
    );

    expect(screen.getByRole("button", { name: "1月" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Jan" })).not.toBeInTheDocument();
  });

  it.each(["fa-IR", "th-TH"])(
    "keeps Gregorian month picker state aligned with %s labels",
    async (locale) => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      const january = new Intl.DateTimeFormat(locale, {
        calendar: "gregory",
        month: "long",
        timeZone: "UTC",
      }).format(new Date(Date.UTC(2020, 0, 1)));
      const year = new Intl.DateTimeFormat(locale, {
        calendar: "gregory",
        year: "numeric",
        timeZone: "UTC",
      }).format(new Date(Date.UTC(2026, 0, 1)));

      render(
        <FormattingProvider locale={locale} uiLocale="en">
          <MonthYearPicker value="2026-01" maxDate="2026-12" onChange={onChange} />
        </FormattingProvider>,
      );

      expect(screen.getByText(year)).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: january }));
      expect(onChange).toHaveBeenCalledWith("2026-01");
    },
  );

  it.each(["fa-IR", "th-TH"])("labels the Gregorian report month correctly in %s", (locale) => {
    const expected = new Intl.DateTimeFormat(locale, {
      calendar: "gregory",
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    }).format(new Date(Date.UTC(2026, 7, 1)));

    render(
      <FormattingProvider locale={locale} uiLocale="en">
        <MonthSwitcher
          selectedMonth="2026-08"
          availableMonths={["2026-08"]}
          onMonthChange={vi.fn()}
        />
      </FormattingProvider>,
    );

    expect(screen.getByText(expected)).toBeInTheDocument();
  });

  it("uses UI-language labels for DayPicker controls", () => {
    render(
      <FormattingProvider locale="de-DE" uiLocale="en">
        <Calendar defaultMonth={new Date(2026, 7, 1)} />
      </FormattingProvider>,
    );

    expect(screen.getByRole("button", { name: "Previous month" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next month" })).toBeInTheDocument();
  });

  it("uses Polish control labels without overriding an English formatting region", async () => {
    const i18n = i18next.createInstance();
    await i18n.init({ lng: "pl", fallbackLng: false, resources: { pl: { ui: plUi } } });
    render(
      <I18nextProvider i18n={i18n}>
        <FormattingProvider locale="en-US" uiLocale="pl">
          <Calendar defaultMonth={new Date(2026, 7, 1)} />
        </FormattingProvider>
      </I18nextProvider>,
    );

    expect(screen.getByRole("button", { name: "Poprzedni miesiąc" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Następny miesiąc" })).toBeInTheDocument();
    expect(screen.getByText("August 2026")).toBeInTheDocument();
  });

  it("changes Polish month-picker labels but preserves the ISO value", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <FormattingProvider locale="PL" uiLocale="pl">
        <MonthYearPicker value="2026-01" maxDate="2026-12" onChange={onChange} />
      </FormattingProvider>,
    );

    await user.click(screen.getByRole("button", { name: "lipiec" }));
    expect(onChange).toHaveBeenCalledWith("2026-07");
  });

  it("localizes short period labels without changing period identifiers", async () => {
    const user = userEvent.setup();
    const onIntervalSelect = vi.fn();
    const i18n = i18next.createInstance();
    await i18n.init({ lng: "pl", fallbackLng: false, resources: { pl: { ui: plUi } } });
    render(
      <I18nextProvider i18n={i18n}>
        <IntervalSelector onIntervalSelect={onIntervalSelect} />
      </I18nextProvider>,
    );

    await user.click(screen.getByRole("button", { name: "1T" }));
    expect(onIntervalSelect).toHaveBeenCalledWith("1W", expect.any(String), {
      from: expect.any(Date),
      to: expect.any(Date),
    });
  });

  it("uses UI-language labels for React Aria calendar controls", async () => {
    const user = userEvent.setup();
    render(
      <FormattingProvider locale="de-DE" uiLocale="en">
        <DatePickerInput value="2026-08-18" onChange={vi.fn()} />
      </FormattingProvider>,
    );

    await user.click(screen.getByRole("button", { name: /Pick a date/ }));

    expect(await screen.findByRole("button", { name: "Previous month" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next month" })).toBeInTheDocument();
  });
});
