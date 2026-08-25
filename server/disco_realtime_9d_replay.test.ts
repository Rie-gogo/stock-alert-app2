import { describe, expect, it, vi } from "vitest";

type Snapshot = {
  buyPressureRatio?: number;
  marketOrderRatio?: number;
  marketOrderDirection?: "buy" | "sell" | "neutral";
  signal?: "buy_pressure" | "sell_pressure" | "large_buy_wall" | "large_sell_wall" | "market_surge" | "neutral";
  [key: string]: unknown;
};

let currentSnapshot: Snapshot | null = null;

function makeBook(snapshot: Snapshot | null) {
  if (!snapshot) return null;
  const bpr = Math.max(0.01, Number(snapshot.buyPressureRatio ?? 1));
  const ask = 10_000;
  return {
    bids: [{ price: 1, qty: Math.round(ask * bpr) }],
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
  getStockName: vi.fn().mockReturnValue("ディスコ"),
  TARGET_STOCKS: [{ symbol: "6146", ticker: "6146.T", name: "ディスコ", basePrice: 60000, sector: "半導体製造装置" }],
  TRADE_EXCLUDED_SYMBOLS: new Set([]),
  ACTIVE_ENTRY_SYMBOLS: new Set(["6146"]),
}));

import { getRtCandles } from "./db";
import { processCandle } from "./realtimeSimEngine";

describe("6146専用LONG・SHORT 9営業日・未来情報なし再生", () => {
  it("保存済みKABU 1分足と同時点板だけを時刻順に処理し、専用2方式だけを発火する", async () => {
    const dates = [
      "2026-08-07",
      "2026-08-10",
      "2026-08-13",
      "2026-08-14",
      "2026-08-17",
      "2026-08-18",
      "2026-08-19",
      "2026-08-20",
      "2026-08-21",
    ];
    const events: Array<{ date: string; time: string; action: string; reason?: string; pnl?: number }> = [];
    let processedRows = 0;

    for (const tradeDate of dates) {
      const rows = await getRtCandles("6146", tradeDate);
      for (const row of rows) {
        currentSnapshot = (row.boardSnapshot as Snapshot | null) ?? null;
        const result = await processCandle({
          symbol: "6146",
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
          events.push({ date: tradeDate, time: row.candleTime, action: result.action, reason: result.reason, pnl: result.pnl });
        }
      }
    }

    const entries = events.filter(event => event.action === "entry");
    const exits = events.filter(event => event.pnl !== undefined);
    const wins = exits.filter(event => (event.pnl ?? 0) > 0).length;
    const losses = exits.filter(event => (event.pnl ?? 0) < 0).length;
    const pnl = exits.reduce((sum, event) => sum + (event.pnl ?? 0), 0);

    console.log("6146_9D_CAUSAL_REPLAY", JSON.stringify({ processedRows, entries, exits, wins, losses, pnl }));
    expect(processedRows).toBeGreaterThan(2_600);
    expect(entries).toHaveLength(12);
    expect(exits).toHaveLength(12);
    expect(wins).toBe(9);
    expect(losses).toBe(3);
    expect(pnl).toBe(692_498);
    expect(entries.every(event => event.reason?.startsWith("ディスコ確認型10本高値更新LONG") || event.reason?.startsWith("ディスコ寄り付き10本安値更新SHORT"))).toBe(true);
  }, 60_000);
});
