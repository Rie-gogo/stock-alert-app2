import { describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import expectedTrades from "./fixtures/advantestWeakVolume.expected.json";

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
    upsertTaiyoCandidateBEvent: vi.fn().mockResolvedValue(undefined),
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
  getStockName: vi.fn().mockReturnValue("アドバンテスト"),
  TARGET_STOCKS: [{ symbol: "6857", ticker: "6857.T", name: "アドバンテスト", basePrice: 10000, sector: "半導体" }],
  TRADE_EXCLUDED_SYMBOLS: new Set([]),
  ACTIVE_ENTRY_SYMBOLS: new Set(["6857"]),
}));

import { getDb, getRtCandles } from "./db";
import { getOpenPositions, processCandle } from "./realtimeSimEngine";

const sourceAuditIt = process.env.RUN_ADVANTEST_WEAK_VOLUME_SOURCE_AUDIT === "1" ? it : it.skip;

describe("6857 弱出来高＋利益保護・保存KABU全48日ソース監査", () => {
  sourceAuditIt("重複除去済み保存足を実エンジンへ投入し、全取引と決済理由を再現する", async () => {
    const db = await getDb();
    if (!db) throw new Error("DATABASE_URL required");
    const dateRows = await db.execute(sql`
      SELECT DISTINCT tradeDate
      FROM rt_candles
      WHERE symbol = '6857' AND tradeDate <= '2026-08-31'
      ORDER BY tradeDate
    `);
    const dates = (dateRows[0] as Array<{ tradeDate: string }>).map(row => String(row.tradeDate));
    const trades: Array<Record<string, unknown>> = [];
    let active: { date: string; time: string; side: string; entryPrice: number; shares: number; reason: string } | null = null;

    for (const tradeDate of dates) {
      const rows = await getRtCandles("6857", tradeDate);
      for (const row of rows) {
        currentSnapshot = (row.boardSnapshot as Snapshot | null) ?? null;
        const result = await processCandle({
          symbol: "6857",
          tradeDate,
          candleTime: row.candleTime,
          open: Number(row.open),
          high: Number(row.high),
          low: Number(row.low),
          close: Number(row.close),
          volume: row.volume,
        });
        if (result.action === "entry") {
          const pos = getOpenPositions().find(position => position.symbol === "6857");
          if (!pos) throw new Error(`entry position missing at ${tradeDate} ${row.candleTime}`);
          active = {
            date: tradeDate,
            time: row.candleTime,
            side: pos.side,
            entryPrice: pos.entryPrice,
            shares: pos.shares,
            reason: pos.entryReason,
          };
        } else if (result.action !== "none" && active && typeof result.pnl === "number") {
          trades.push({
            date: active.date,
            entryTime: active.time,
            exitTime: row.candleTime,
            side: active.side,
            entryPrice: active.entryPrice,
            pnlPer100: result.pnl / active.shares * 100,
            entryReason: active.reason,
            exitAction: result.action,
            exitReason: result.reason,
          });
          active = null;
        }
      }
    }

    const summary = {
      dates: dates.length,
      trades: trades.length,
      wins: trades.filter(trade => Number(trade.pnlPer100) > 0).length,
      losses: trades.filter(trade => Number(trade.pnlPer100) < 0).length,
      pnlPer100: trades.reduce((sum, trade) => sum + Number(trade.pnlPer100), 0),
    };
    const highFadeShorts = trades.filter(trade => String(trade.entryReason).startsWith("アドバンテスト高値失速SHORT"));

    expect(summary).toEqual({ dates: 48, trades: 24, wins: 21, losses: 3, pnlPer100: 475_851 });
    expect({
      trades: highFadeShorts.length,
      wins: highFadeShorts.filter(trade => Number(trade.pnlPer100) > 0).length,
      losses: highFadeShorts.filter(trade => Number(trade.pnlPer100) < 0).length,
      pnlPer100: highFadeShorts.reduce((sum, trade) => sum + Number(trade.pnlPer100), 0),
    }).toEqual({ trades: 14, wins: 12, losses: 2, pnlPer100: 260_476 });
    expect(highFadeShorts).toContainEqual(expect.objectContaining({
      date: "2026-08-31",
      entryTime: "09:57",
      exitTime: "10:12",
      pnlPer100: 22_974,
      exitAction: "take_profit",
      exitReason: "アドバンテスト利益保護 (+0.8%到達後、+0.7%戻り)",
    }));
    expect(trades).toEqual(expectedTrades);
  }, 180_000);
});
