import { describe, expect, it, vi } from "vitest";

const { today, restoredRows } = vi.hoisted(() => {
  const tradeDate = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return {
    today: tradeDate,
    restoredRows: [
      ...Array.from({ length: 60 }, (_, minute) => ({
        id: minute + 1,
        symbol: "6976",
        tradeDate,
        candleTime: `09:${String(minute).padStart(2, "0")}`,
        open: "100",
        high: "100.2",
        low: "99.8",
        close: "100",
        volume: 100,
        boardSnapshot: null,
        createdAt: new Date(),
      })),
      {
        id: 61,
        symbol: "6976",
        tradeDate,
        candleTime: "10:00",
        open: "100.1",
        high: "101.2",
        low: "100",
        close: "101",
        volume: 100,
        boardSnapshot: null,
        createdAt: new Date(),
      },
      {
        id: 62,
        symbol: "6976",
        tradeDate,
        candleTime: "10:01",
        open: "101",
        high: "101.6",
        low: "100.9",
        close: "101.5",
        volume: 100,
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
  getRtSignalCandidatesForDate: vi.fn().mockResolvedValue([]),
  getRtRealtimeDecisionEventsForDate: vi.fn().mockResolvedValue([]),
  getKioxiaShortGuardEventsForDate: vi.fn().mockResolvedValue([]),
  insertScore0Block: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./kabuStation", () => ({
  getOrderBook: vi.fn().mockReturnValue(null),
  analyzeOrderBook: vi.fn().mockReturnValue([]),
  calcExtendedBoardFields: vi.fn().mockReturnValue({}),
  getAggregatedBoardStats: vi.fn().mockReturnValue(null),
  clearBoardRingBuffer: vi.fn(),
}));
vi.mock("../shared/stocks", () => ({
  getStockName: vi.fn().mockReturnValue("太陽誘電"),
  TARGET_STOCKS: [{ symbol: "6976", ticker: "6976.T", name: "太陽誘電", basePrice: 3000, sector: "電子部品" }],
  TRADE_EXCLUDED_SYMBOLS: new Set([]),
  ACTIVE_ENTRY_SYMBOLS: new Set(["6976"]),
}));

import { processCandle, restoreBuffersFromDb } from "./realtimeSimEngine";

describe("6976候補B30分 再起動復元", () => {
  function executionContext(sourceEventId: string) {
    const now = Date.now();
    return {
      sourceEventId,
      board: {
        currentPrice: 101.45,
        currentPriceTime: "10:02:01",
        asks: [{ price: 101.5, qty: 100_000 }],
        bids: [{ price: 101.4, qty: 100_000 }],
        marketOrderSellQty: 0,
        marketOrderBuyQty: 0,
        overSellQty: 0,
        underBuyQty: 0,
        vwap: 101.45,
      },
      currentAudit: {
        boardObservedAtMs: now - 100,
        relayAssembledAtMs: now - 80,
        relaySentAtMs: now - 60,
        cloudReceivedAtMs: now - 40,
      },
    } as any;
  }

  it("確認成立直後の再起動でも次event待ちを復元し、同じsource eventの板VWAPで入る", async () => {
    await restoreBuffersFromDb();
    const result = await processCandle({
      symbol: "6976", tradeDate: today, candleTime: "10:02",
      open: 101.5, high: 101.7, low: 101.3, close: 101.4, volume: 100,
    }, executionContext("entry-event"));
    expect(result).toMatchObject({
      action: "entry",
      executionPrice: 101.5,
      executionPriceSource: "next_event_ask_depth_vwap",
      executionReferenceTime: "10:01",
      signalReferencePrice: 101.5,
      executionSourceEventId: "entry-event",
    });
    expect(result.reason).toContain("太陽誘電候補BLONG");

    const exit = await processCandle({
      symbol: "6976", tradeDate: today, candleTime: "10:32",
      open: 101.5, high: 101.55, low: 101.35, close: 101.4, volume: 100,
    }, executionContext("exit-event"));
    expect(exit).toMatchObject({
      action: "exit",
      executionPrice: 101.4,
      executionPriceSource: "current_event_bid_depth_vwap",
      executionReferenceTime: "10:02",
      executionSourceEventId: "exit-event",
    });
    expect(exit.reason).toContain("期限到達event板VWAP決済");
  });
});
