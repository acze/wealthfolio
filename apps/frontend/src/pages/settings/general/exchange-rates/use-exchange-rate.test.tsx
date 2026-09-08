import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import i18next from "i18next";
import type { ReactNode } from "react";
import { I18nextProvider } from "react-i18next";
import { describe, expect, it, vi } from "vitest";
import { useExchangeRates } from "./use-exchange-rate";

const mocks = vi.hoisted(() => ({
  getExchangeRates: vi.fn(),
}));

vi.mock("@/adapters", () => ({
  getExchangeRates: mocks.getExchangeRates,
  addExchangeRate: vi.fn(),
  updateExchangeRate: vi.fn(),
  deleteExchangeRate: vi.fn(),
  logger: { error: vi.fn() },
}));

describe("exchange-rate localization", () => {
  it("relabels cached currencies on language change without changing rates or fetching again", async () => {
    const rate = {
      id: "synthetic-eur-usd",
      fromCurrency: "EUR",
      toCurrency: "USD",
      rate: 1.25,
      source: "MANUAL",
      timestamp: "2026-07-10T00:00:00Z",
    };
    mocks.getExchangeRates.mockResolvedValue([rate]);
    const i18n = i18next.createInstance();
    await i18n.init({ lng: "en", resources: {}, react: { useSuspense: false } });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      </I18nextProvider>
    );
    const { result } = renderHook(() => useExchangeRates(), { wrapper });

    await waitFor(() =>
      expect(result.current.exchangeRates?.[0].toCurrencyName).toBe("United States dollar"),
    );
    await act(() => i18n.changeLanguage("pl"));
    await waitFor(() =>
      expect(result.current.exchangeRates?.[0].toCurrencyName).toBe("dolar amerykański"),
    );

    expect(result.current.exchangeRates?.[0]).toMatchObject(rate);
    expect(mocks.getExchangeRates).toHaveBeenCalledOnce();
  });
});
