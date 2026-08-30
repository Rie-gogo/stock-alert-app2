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
  getStockName: vi.fn().mockReturnValue("アドバンテスト"),
  TARGET_STOCKS: [{ symbol: "6857", ticker: "6857.T", name: "アドバンテスト", basePrice: 10000, sector: "半導体" }],
  TRADE_EXCLUDED_SYMBOLS: new Set([]),
  ACTIVE_ENTRY_SYMBOLS: new Set(["6857"]),
}));

import { getRtCandles } from "./db";
import { processCandle } from "./realtimeSimEngine";

describe("6857 LONG・SHORT・損切り後再評価 直近5営業日・未来情報なし再生", () => {
  it("保存済みKABU 1分足と同時点の板スナップショットだけを時刻順に処理する", async () => {
    const dates = ["2026-08-17", "2026-08-18", "2026-08-19", "2026-08-20", "2026-08-21"];
    const events: Array<{ date: string; time: string; action: string; reason?: string; pnl?: number }> = [];
    let processedRows = 0;

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
        processedRows++;
        if (result.action !== "none") events.push({ date: tradeDate, time: row.candleTime, action: result.action, reason: result.reason, pnl: result.pnl });
      }
    }

    console.log("6857_5D_CAUSAL_REPLAY", JSON.stringify({ processedRows, events }));
    expect(processedRows).toBeGreaterThan(1_600);
  }, 60_000);

  it("2026-07-30のLONG損切り後に、確認済みのSHORTへ一度だけ再評価する", async () => {
    const events: Array<{ time: string; action: string; reason?: string; pnl?: number }> = [];
    const rows = await getRtCandles("6857", "2026-07-30");
    for (const row of rows) {
      currentSnapshot = (row.boardSnapshot as Snapshot | null) ?? null;
      const result = await processCandle({
        symbol: "6857",
        tradeDate: "2026-07-30",
        candleTime: row.candleTime,
        open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close), volume: row.volume,
      });
      if (result.action !== "none") events.push({ time: row.candleTime, action: result.action, reason: result.reason, pnl: result.pnl });
    }
    const longEntryIndex = events.findIndex(event => event.reason?.startsWith("アドバンテスト確認型LONG"));
    const stopIndex = events.findIndex(event => event.action === "stop_loss");
    const shortReentryIndex = events.findIndex(event => event.reason?.startsWith("アドバンテスト高値失速SHORT（損切り後再評価）"));
    expect(longEntryIndex).toBeGreaterThanOrEqual(0);
    expect(stopIndex).toBeGreaterThan(longEntryIndex);
    expect(shortReentryIndex).toBeGreaterThan(stopIndex);
  }, 60_000);

  it.each([
    { tradeDate: "2026-08-21", expectedLongEntry: "10:26", expectedExit: "11:09" },
    { tradeDate: "2026-08-26", expectedLongEntry: "10:55", expectedExit: "11:16" },
  ])("$tradeDateは弱出来高の初回SHORTを見送り、日次枠を消費せず後続LONGへ再探索する", async ({ tradeDate, expectedLongEntry, expectedExit }) => {
    const events: Array<{ time: string; action: string; reason?: string }> = [];
    const rows = await getRtCandles("6857", tradeDate);

    for (const row of rows) {
      currentSnapshot = (row.boardSnapshot as Snapshot | null) ?? null;
      const result = await processCandle({
        symbol: "6857",
        tradeDate,
        candleTime: row.candleTime,
        open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close), volume: row.volume,
      });
      if (result.action !== "none") events.push({ time: row.candleTime, action: result.action, reason: result.reason });
    }

    expect(events.some(event => event.reason?.startsWith("アドバンテスト高値失速SHORT:"))).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({
      time: expectedLongEntry,
      action: "entry",
      reason: expect.stringMatching(/^アドバンテスト確認型LONG:/),
    }));
    expect(events).toContainEqual(expect.objectContaining({ time: expectedExit, action: "take_profit" }));
  }, 60_000);
});
