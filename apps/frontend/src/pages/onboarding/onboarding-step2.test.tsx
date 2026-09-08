import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";

import { SUPPORTED_LOCALES } from "@/i18n/locales";
import { OnboardingStep2, type OnboardingStep2Handle } from "./onboarding-step2";

const mocks = vi.hoisted(() => ({
  settings: { language: "en" } as {
    language: string;
    baseCurrency?: string;
    formattingRegion?: string;
    timezone?: string;
  },
  updateSettings: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/lib/settings-provider", () => ({
  useSettingsContext: () => ({
    settings: mocks.settings,
    updateSettings: mocks.updateSettings,
  }),
}));

function renderStep2(language = "en") {
  mocks.settings = { language };
  return render(<OnboardingStep2 onNext={vi.fn()} onValidityChange={vi.fn()} />);
}

describe("OnboardingStep2 language picker", () => {
  it("shows only the popular languages as chips", () => {
    renderStep2();

    for (const code of ["en", "fr", "de", "es", "zh", "ja", "ko"]) {
      expect(screen.getByTestId(`language-${code}-button`)).toBeInTheDocument();
    }
    // Everything else lives behind the "Other" chip.
    expect(screen.queryByTestId("language-pt-button")).not.toBeInTheDocument();
    expect(screen.queryByTestId("language-it-button")).not.toBeInTheDocument();
  });

  it("lists every supported locale in the overlay", async () => {
    const user = userEvent.setup();
    renderStep2();

    await user.click(screen.getAllByRole("button", { name: /other/i })[0]);

    for (const locale of SUPPORTED_LOCALES) {
      expect(screen.getAllByTestId(`language-${locale.code}-button`).length).toBeGreaterThan(0);
    }
    // A popular language now appears both as a chip and as an overlay row.
    expect(screen.getAllByTestId("language-en-button")).toHaveLength(2);
  });

  it("filters the overlay and reports when nothing matches", async () => {
    const user = userEvent.setup();
    renderStep2();

    await user.click(screen.getAllByRole("button", { name: /other/i })[0]);
    const search = screen.getByPlaceholderText("Search languages...");

    await user.type(search, "portug");
    expect(screen.getByTestId("language-pt-button")).toBeInTheDocument();
    expect(screen.queryByTestId("language-it-button")).not.toBeInTheDocument();

    await user.clear(search);
    await user.type(search, "zzzz");
    expect(screen.getByText("No languages found")).toBeInTheDocument();
  });

  it("substitutes the selected language into the chips when it is not popular", () => {
    renderStep2("pt");

    expect(screen.getByTestId("language-pt-button")).toBeInTheDocument();
    // It takes the last popular slot rather than growing the row.
    expect(screen.queryByTestId("language-ko-button")).not.toBeInTheDocument();
    expect(screen.getByTestId("language-en-button")).toBeInTheDocument();
  });

  it("saves Polish as a language-only preference", async () => {
    const user = userEvent.setup();
    renderStep2();
    mocks.updateSettings.mockClear();

    await user.click(screen.getAllByRole("button", { name: /other/i })[0]);
    await user.type(screen.getByPlaceholderText("Search languages..."), "polski");
    await user.click(screen.getByTestId("language-pl-button"));

    expect(mocks.updateSettings).toHaveBeenCalledExactlyOnceWith({ language: "pl" });
    expect(screen.getByTestId("language-pl-button")).toHaveTextContent("Polski");
  });

  it.each(["USD", "PLN", undefined])(
    "preserves saved or manually chosen currency %s when selecting Poland",
    async (savedCurrency) => {
      const user = userEvent.setup();
      const baseCurrency = savedCurrency ?? "CAD";
      mocks.settings = {
        language: "en",
        baseCurrency: savedCurrency,
        formattingRegion: "US",
        timezone: "America/New_York",
      };
      mocks.updateSettings.mockClear();
      const ref = createRef<OnboardingStep2Handle>();
      render(<OnboardingStep2 ref={ref} onNext={vi.fn()} onValidityChange={vi.fn()} />);

      if (!savedCurrency) {
        await user.click(screen.getByTestId("currency-cad-button"));
      }
      await user.click(
        within(screen.getByTestId("onboarding-formatting-locale")).getByRole("button", {
          name: "Other",
        }),
      );
      await user.click(screen.getByRole("button", { name: /^Poland/ }));

      expect(mocks.updateSettings).toHaveBeenCalledExactlyOnceWith({ formattingRegion: "PL" });
      act(() => ref.current?.submitForm());
      await waitFor(() =>
        expect(mocks.updateSettings).toHaveBeenLastCalledWith({
          baseCurrency,
          formattingRegion: "PL",
          timezone: "America/New_York",
        }),
      );
    },
  );
});
