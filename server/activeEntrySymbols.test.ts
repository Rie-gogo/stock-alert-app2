import { describe, expect, it } from "vitest";
import { ACTIVE_ENTRY_SYMBOLS, TARGET_STOCKS } from "../shared/stocks";

describe("DRY_RUNエントリー対象", () => {
  it("個別最適化が完了した7銘柄だけをエントリー対象とし、受信対象は全銘柄を維持する", () => {
    expect(ACTIVE_ENTRY_SYMBOLS).not.toBeNull();
    expect([...ACTIVE_ENTRY_SYMBOLS!].sort()).toEqual([
      "285A",
      "5803",
      "6146",
      "6857",
      "6976",
      "6981",
      "8035",
    ]);

    const receivedSymbols = new Set(TARGET_STOCKS.map(stock => stock.symbol));
    expect(receivedSymbols.size).toBeGreaterThan(ACTIVE_ENTRY_SYMBOLS!.size);
    for (const symbol of ACTIVE_ENTRY_SYMBOLS!) {
      expect(receivedSymbols.has(symbol as typeof TARGET_STOCKS[number]["symbol"])).toBe(true);
    }
  });
});
