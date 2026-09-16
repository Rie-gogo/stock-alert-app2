import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./db", () => ({
  insertRtCandle: vi.fn().mockResolvedValue(undefined),
  insertRtTrade: vi.fn().mockResolvedValue(undefined),
  upsertRtDailySummary: vi.fn().mockResolvedValue(undefined),
  getRtTradesForDate: vi.fn().mockResolvedValue([]),
  getRtCandlesAllForDate: vi.fn().mockResolvedValue([]),
  getRtOpenPositionsFromDb: vi.fn().mockResolvedValue([]),
  getRtSignalCandidatesForDate: vi.fn().mockResolvedValue([]),
  getRtRealtimeDecisionEventsForDate: vi.fn().mockResolvedValue([]),
  getKioxiaShortGuardEventsForDate: vi.fn().mockResolvedValue([]),
  insertScore0Block: vi.fn().mockResolvedValue(undefined),
  upsertTaiyoCandidateBEvent: vi.fn().mockResolvedValue(undefined),
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

import {
  getOpenPositions,
  processCandle,
  restoreOpenPositions,
  setTaiyoCandidateBExecutablePricingEnabledForTest,
} from "./realtimeSimEngine";

function context(input: {
  sourceEventId: string;
  boardObservedOffsetMs?: number;
  relayAssembledOffsetMs?: number;
  board?: unknown | null;
}) {
  const now = Date.now();
  return {
    sourceEventId: input.sourceEventId,
    board: input.board === undefined
      ? {
          currentPrice: 101.45,
          currentPriceTime: "10:00:01",
          asks: [{ price: 101.5, qty: 100_000 }],
          bids: [{ price: 101.4, qty: 100_000 }],
          marketOrderSellQty: 0,
          marketOrderBuyQty: 0,
          overSellQty: 0,
          underBuyQty: 0,
          vwap: 101.45,
        }
      : input.board,
    currentAudit: {
      boardObservedAtMs: now - (input.boardObservedOffsetMs ?? 100),
      relayAssembledAtMs: now - (input.relayAssembledOffsetMs ?? 80),
      relaySentAtMs: now - 60,
      cloudReceivedAtMs: now - 40,
    },
  } as any;
}

async function resetDay(tradeDate: string) {
  for (let minute = 0; minute <= 29; minute += 1) {
    await processCandle({
      symbol: "6976", tradeDate, candleTime: `09:${String(minute).padStart(2, "0")}`,
      open: 100, high: 100.2, low: 99.8, close: 100, volume: 100,
    });
  }
}

async function restoreCandidateLong(tradeDate: string) {
  await resetDay(tradeDate);
  restoreOpenPositions([{
    symbol: "6976",
    side: "long",
    price: 100,
    shares: 100,
    tradeTime: "10:00",
    reason: "太陽誘電候補BLONG: 因果実行テスト",
  }]);
}

async function feedEntrySetup(tradeDate: string) {
  for (let minute = 30; minute <= 44; minute += 1) {
    await processCandle({
      symbol: "6976", tradeDate, candleTime: `09:${String(minute).padStart(2, "0")}`,
      open: 100, high: 100.2, low: 99.8, close: 100, volume: 100,
    });
  }
  await processCandle({
    symbol: "6976", tradeDate, candleTime: "09:45",
    open: 100.1, high: 101.2, low: 100, close: 101, volume: 100,
  });
  return processCandle({
    symbol: "6976", tradeDate, candleTime: "09:46",
    open: 101, high: 101.6, low: 100.9, close: 101.5, volume: 100,
  });
}

describe("6976候補B 因果的depth執行", () => {
  beforeEach(() => {
    setTaiyoCandidateBExecutablePricingEnabledForTest(true);
  });

  it("30分境界でSLが先に成立した場合、板欠損でもSLを上書きしない", async () => {
    const tradeDate = "2099-02-01";
    await restoreCandidateLong(tradeDate);
    const result = await processCandle({
      symbol: "6976", tradeDate, candleTime: "10:30",
      open: 100, high: 100.3, low: 98.9, close: 99.2, volume: 100,
    }, context({ sourceEventId: "sl-boundary", board: null }));
    expect(result.action).toBe("stop_loss");
    expect(result.reason).toContain("損切り");
    expect(getOpenPositions().find(item => item.symbol === "6976")).toBeUndefined();
  });

  it("30分境界でTPが先に成立した場合、板欠損でもTPを上書きしない", async () => {
    const tradeDate = "2099-02-02";
    await restoreCandidateLong(tradeDate);
    const result = await processCandle({
      symbol: "6976", tradeDate, candleTime: "10:30",
      open: 100, high: 100.7, low: 99.5, close: 100.4, volume: 100,
    }, context({ sourceEventId: "tp-boundary", board: null }));
    expect(result.action).toBe("take_profit");
    expect(result.reason).toContain("利確");
    expect(getOpenPositions().find(item => item.symbol === "6976")).toBeUndefined();
  });

  it("30分境界でSL/TP未成立かつ板欠損なら、ポジションを閉じず次の有効event板で決済する", async () => {
    const tradeDate = "2099-02-03";
    await restoreCandidateLong(tradeDate);
    const result = await processCandle({
      symbol: "6976", tradeDate, candleTime: "10:30",
      open: 100, high: 100.3, low: 99.5, close: 100.1, volume: 100,
    }, context({ sourceEventId: "missing-board", board: null }));
    expect(result).toMatchObject({
      action: "none",
      reason: "candidate_b_time_exit_pending:source_event_board_missing",
    });
    expect(getOpenPositions().find(item => item.symbol === "6976")).toBeDefined();

    const retried = await processCandle({
      symbol: "6976", tradeDate, candleTime: "10:31",
      open: 100.1, high: 100.3, low: 99.5, close: 100.1, volume: 100,
    }, context({ sourceEventId: "retry-with-fresh-board" }));
    expect(retried).toMatchObject({
      action: "exit",
      executionPriceSource: "current_event_bid_depth_vwap",
      executionSourceEventId: "retry-with-fresh-board",
    });
    expect(getOpenPositions().find(item => item.symbol === "6976")).toBeUndefined();
  });

  it("30分境界の10秒古い板では決済せず、次eventを待つ", async () => {
    const tradeDate = "2099-02-06";
    await restoreCandidateLong(tradeDate);
    const result = await processCandle({
      symbol: "6976", tradeDate, candleTime: "10:30",
      open: 100, high: 100.3, low: 99.5, close: 100.1, volume: 100,
    }, context({ sourceEventId: "stale-exit", boardObservedOffsetMs: 10_000 }));
    expect(result).toMatchObject({
      action: "none",
      reason: "candidate_b_time_exit_pending:source_event_board_stale_over_5000ms",
    });
    expect(getOpenPositions().find(item => item.symbol === "6976")).toBeDefined();
  });

  it("10秒古い板は次event入口へ使わず、日次枠を消費しない", async () => {
    const tradeDate = "2099-02-04";
    await resetDay(tradeDate);
    const confirmation = await feedEntrySetup(tradeDate);
    expect(confirmation.reason).toBe("candidate_b_next_event_execution_pending");
    const rejected = await processCandle({
      symbol: "6976", tradeDate, candleTime: "09:47",
      open: 101.5, high: 101.7, low: 101.3, close: 101.4, volume: 100,
    }, context({ sourceEventId: "stale-entry", boardObservedOffsetMs: 10_000 }));
    expect(rejected).toMatchObject({
      action: "none",
      reason: "source_event_board_stale_over_5000ms",
    });
    expect(getOpenPositions().find(item => item.symbol === "6976")).toBeUndefined();
  });

  it("board観測がrelay組立より後の時刻逆転は入口へ使わない", async () => {
    const tradeDate = "2099-02-05";
    await resetDay(tradeDate);
    await feedEntrySetup(tradeDate);
    const rejected = await processCandle({
      symbol: "6976", tradeDate, candleTime: "09:47",
      open: 101.5, high: 101.7, low: 101.3, close: 101.4, volume: 100,
    }, context({
      sourceEventId: "noncausal-entry",
      boardObservedOffsetMs: 20,
      relayAssembledOffsetMs: 80,
    }));
    expect(rejected).toMatchObject({
      action: "none",
      reason: "source_event_audit_timestamps_noncausal",
    });
    expect(getOpenPositions().find(item => item.symbol === "6976")).toBeUndefined();
  });
});
