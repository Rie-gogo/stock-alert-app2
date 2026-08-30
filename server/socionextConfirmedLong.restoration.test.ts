import { describe, expect, it, vi } from "vitest";

const { today, restoredRows } = vi.hoisted(() => {
  const tradeDate = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const baseRows = Array.from({ length: 40 }, (_, minute) => ({
    id: minute + 1,
    symbol: "6526",
    tradeDate,
    candleTime: `09:${String(minute).padStart(2, "0")}`,
    open: "100",
    high: "100.2",
    low: "99.8",
    close: "100",
    volume: 100,
    boardSnapshot: null,
    createdAt: new Date(),
  }));
  return {
    today: tradeDate,
    restoredRows: [
      ...baseRows,
      {
        id: 41,
        symbol: "6526",
        tradeDate,
        candleTime: "09:40",
        open: "100.1",
        high: "101.2",
        low: "100",
        close: "101",
        volume: 150,
        boardSnapshot: null,
        createdAt: new Date(),
      },
    ],
  };
});

vi.mock("./db", () => ({
  insertRtCandle: vi.fn().mockResolvedValue(undefined),
  insertRtTrade: vi.fn().mockResolvedValue(undefined),
  upsertRtDailySummary: vi.fn().mockResolvedValue(undefined),
  getRtTradesForDate: vi.fn().mockResolvedValue([]),
  getRtCandlesAllForDate: vi.fn().mockResolvedValue(restoredRows),
  getRtOpenPositionsFromDb: vi.fn().mockResolvedValue([]),
  insertScore0Block: vi.fn().mockResolvedValue(undefined),
  upsertTaiyoCandidateBEvent: vi.fn().mockResolvedValue(undefined),
  upsertSocionextConfirmedLongEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./kabuStation", () => ({
  getOrderBook: vi.fn().mockReturnValue(null),
  analyzeOrderBook: vi.fn().mockReturnValue([]),
  calcExtendedBoardFields: vi.fn().mockReturnValue({}),
  getAggregatedBoardStats: vi.fn().mockReturnValue(null),
  clearBoardRingBuffer: vi.fn(),
}));
vi.mock("../shared/stocks", () => ({
  getStockName: vi.fn().mockReturnValue("ソシオネクスト"),
  TARGET_STOCKS: [{ symbol: "6526", ticker: "6526.T", name: "ソシオネクスト", basePrice: 3250, sector: "半導体" }],
  TRADE_EXCLUDED_SYMBOLS: new Set([]),
  ACTIVE_ENTRY_SYMBOLS: new Set(["6526"]),
}));

import { processCandle, restoreBuffersFromDb } from "./realtimeSimEngine";

describe("6526確認型LONG 再起動復元", () => {
  it("最新保存足が初動なら確認待ちを再構築し、次の確定足でエントリー判定を継続する", async () => {
    await restoreBuffersFromDb();
    const result = await processCandle({
      symbol: "6526",
      tradeDate: today,
      candleTime: "09:41",
      open: 101,
      high: 101.6,
      low: 100.9,
      close: 101.5,
      volume: 100,
    });
    expect(result.action).toBe("entry");
    expect(result.reason).toContain("ソシオネクスト確認型LONG");
  });
});
