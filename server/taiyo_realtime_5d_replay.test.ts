import { describe, expect, it, vi } from "vitest";

type Snapshot = {
  buyPressureRatio?: number;
  marketOrderRatio?: number;
  marketOrderDirection?: "buy" | "sell" | "neutral";
  signal?: "buy_pressure" | "sell_pressure" | "large_buy_wall" | "large_sell_wall" | "market_surge" | "neutral";
  largeBuyWall?: boolean;
  largeSellWall?: boolean;
  [key: string]: unknown;
};

let currentSnapshot: Snapshot | null = null;

function makeBook(snapshot: Snapshot | null) {
  if (!snapshot) return null;
  const bpr = Math.max(0.01, Number(snapshot.buyPressureRatio ?? 1));
  const ask = 10_000;
  const bid = Math.round(ask * bpr);
  return {
    bids: [{ price: 1, qty: bid }],
    asks: [{ price: 1, qty: ask }],
    underBuyQty: 0,
    overSellQty: 0,
    marketOrderBuyQty: 0,
    marketOrderSellQty: 0,
  };
}

vi.mock("./db", async () => {
  const actual = await vi.importActual<typeof import("./db")>("./db");
  return {
    ...actual,
    insertRtCandle: vi.fn().mockResolvedValue(undefined),
    insertRtTrade: vi.fn().mockResolvedValue(undefined),
    upsertRtDailySummary: vi.fn().mockResolvedValue(undefined),
    getRtTradesForDate: vi.fn().mockResolvedValue([]),
    getRtCandlesAllForDate: vi.fn().mockResolvedValue([]),
    getRtOpenPositionsFromDb: vi.fn().mockResolvedValue([]),
    insertScore0Block: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("./kabuStation", () => ({
  getOrderBook: vi.fn(() => makeBook(currentSnapshot)),
  analyzeOrderBook: vi.fn().mockReturnValue([]),
  calcExtendedBoardFields: vi.fn(() => currentSnapshot ?? {}),
  getAggregatedBoardStats: vi.fn().mockReturnValue(null),
  clearBoardRingBuffer: vi.fn(),
}));

vi.mock("../shared/stocks", () => ({
  getStockName: vi.fn().mockReturnValue("太陽誘電"),
  TARGET_STOCKS: [{ symbol: "6976", ticker: "6976.T", name: "太陽誘電", basePrice: 3000, sector: "電子部品" }],
  TRADE_EXCLUDED_SYMBOLS: new Set([]),
  ACTIVE_ENTRY_SYMBOLS: new Set(["6976"]),
}));

import { getRtCandles } from "./db";
import { processCandle } from "./realtimeSimEngine";

describe("6976 現行3方式 直近5営業日・未来情報なし再生", () => {
  it("保存済みKABU 1分足と同時点の板スナップショットだけを時刻順に処理する", async () => {
    const dates = ["2026-08-17", "2026-08-18", "2026-08-19", "2026-08-20", "2026-08-21"];
    const events: Array<{ date: string; time: string; action: string; reason?: string; pnl?: number }> = [];
    let processedRows = 0;

    for (const tradeDate of dates) {
      const rows = await getRtCandles("6976", tradeDate);
      for (const row of rows) {
        currentSnapshot = (row.boardSnapshot as Snapshot | null) ?? null;
        const result = await processCandle({
          symbol: "6976",
          tradeDate,
          candleTime: row.candleTime,
          open: Number(row.open),
          high: Number(row.high),
          low: Number(row.low),
          close: Number(row.close),
          volume: row.volume,
        });
        processedRows++;
        if (result.action !== "none") {
          events.push({
            date: tradeDate,
            time: row.candleTime,
            action: result.action,
            reason: result.reason,
            pnl: result.pnl,
          });
        }
      }
    }

    console.log("6976_5D_CAUSAL_REPLAY", JSON.stringify({ processedRows, events }));
    expect(processedRows).toBeGreaterThan(1_600);
  }, 60_000);
});
