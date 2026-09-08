import { fireEvent, render, screen } from "@testing-library/react";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { LanguageRegionSettings } from "./language-region-settings";

const mocks = vi.hoisted(() => ({
  updateSettings: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/settings-provider", () => ({
  useSettingsContext: () => ({
    settings: {
      language: "en",
      formattingRegion: "US",
      baseCurrency: "USD",
      timezone: "America/New_York",
    },
    updateSettings: mocks.updateSettings,
  }),
}));

const originalScrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");

beforeAll(() => {
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});

afterAll(() => {
  if (originalScrollIntoView) {
    Object.defineProperty(Element.prototype, "scrollIntoView", originalScrollIntoView);
  } else {
    Reflect.deleteProperty(Element.prototype, "scrollIntoView");
  }
});

describe("Polish language and region settings", () => {
  beforeEach(() => {
    mocks.updateSettings.mockClear();
  });

  it("offers Polski and updates only the language when selected", async () => {
    render(<LanguageRegionSettings />);

    fireEvent.keyDown(screen.getByTestId("language-select"), { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: "Polski" }));

    expect(mocks.updateSettings).toHaveBeenCalledExactlyOnceWith({ language: "pl" });
  });

  it("offers Poland as a separate presentation setting", async () => {
    render(<LanguageRegionSettings />);

    fireEvent.keyDown(screen.getByTestId("formatting-locale-select"), { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: "Poland" }));

    expect(mocks.updateSettings).toHaveBeenCalledExactlyOnceWith({ formattingRegion: "PL" });
  });
});
