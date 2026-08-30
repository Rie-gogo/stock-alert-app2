import { describe, expect, it } from "vitest";
import { ACTIVE_ENTRY_SYMBOLS, TARGET_STOCKS } from "../shared/stocks";

describe("DRY_RUNエントリー対象", () => {
  it("個別最適化が完了した10銘柄だけをエントリー対象とし、受信対象は全銘柄を維持する", () => {
    expect(ACTIVE_ENTRY_SYMBOLS).not.toBeNull();
    expect([...ACTIVE_ENTRY_SYMBOLS!].sort()).toEqual([
      "285A",
      "3436",
      "5803",
      "6146",
      "6526",
      "6857",
      "6976",
      "6981",
      "8035",
      "9984",
    ]);

    const receivedSymbols = new Set(TARGET_STOCKS.map(stock => stock.symbol));
    expect(TARGET_STOCKS).toHaveLength(22);
    expect(receivedSymbols.size).toBe(22);
    expect(receivedSymbols.has("6920")).toBe(true);
    expect(receivedSymbols.has("6758")).toBe(true);
    expect(receivedSymbols.size - ACTIVE_ENTRY_SYMBOLS!.size).toBe(12);
    for (const symbol of ACTIVE_ENTRY_SYMBOLS!) {
      expect(receivedSymbols.has(symbol as typeof TARGET_STOCKS[number]["symbol"])).toBe(true);
    }
  });
});
