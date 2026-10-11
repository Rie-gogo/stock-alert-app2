import { describe, expect, it, vi } from "vitest";

vi.mock("./db", () => ({
  insertRtCandle: vi.fn().mockResolvedValue(undefined),
  insertRtTrade: vi.fn().mockResolvedValue(undefined),
  upsertRtDailySummary: vi.fn().mockResolvedValue(undefined),
  getRtTradesForDate: vi.fn().mockResolvedValue([]),
  getRtCandlesAllForDate: vi.fn().mockResolvedValue([]),
  getRtOpenPositionsFromDb: vi.fn().mockResolvedValue([]),
  insertScore0Block: vi.fn().mockResolvedValue(undefined),
  upsertTaiyoCandidateBEvent: vi.fn().mockResolvedValue(undefined),
  upsertSocionextConfirmedLongEvent: vi.fn().mockResolvedValue(undefined),
  upsertSumcoBreakdownShortEvent: vi.fn().mockResolvedValue(undefined),
  upsertSoftbankBreakoutLongEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./kabuStation", () => ({
  getOrderBook: vi.fn().mockReturnValue(null),
  analyzeOrderBook: vi.fn().mockReturnValue([]),
  calcExtendedBoardFields: vi.fn().mockReturnValue({}),
  getAggregatedBoardStats: vi.fn().mockReturnValue(null),
  clearBoardRingBuffer: vi.fn(),
}));
vi.mock("../shared/stocks", () => ({
  getStockName: vi.fn().mockReturnValue("ソフトバンクグループ"),
  TARGET_STOCKS: [{ symbol: "9984", ticker: "9984.T", name: "ソフトバンクグループ", basePrice: 16_000, sector: "通信・投資" }],
  TRADE_EXCLUDED_SYMBOLS: new Set([]),
  ACTIVE_ENTRY_SYMBOLS: new Set(["9984"]),
}));

import { insertRtTrade } from "./db";
import {
  forceCloseAllPositions,
  getOpenPositions,
  processCandle,
  restoreOpenPositions,
  type RealtimeSourceExecutionContext,
} from "./realtimeSimEngine";

const tradeDate = "2026-10-13";

function context(sourceEventId: string, board: { asks?: Array<{ price: number; qty: number }>; bids?: Array<{ price: number; qty: number }> }, boardObservedAtMs = 1_000): RealtimeSourceExecutionContext {
  return {
    sourceEventId,
    board: board as never,
    currentAudit: {
      boardObservedAtMs,
      relayAssembledAtMs: boardObservedAtMs + 500,
      relaySentAtMs: boardObservedAtMs + 600,
      cloudReceivedAtMs: boardObservedAtMs + 700,
    },
  };
}

async function feedPrefix(date = tradeDate, price = 100) {
  for (let minute = 10; minute <= 39; minute += 1) {
    await processCandle({
      symbol: "9984", tradeDate: date, candleTime: `09:${String(minute).padStart(2, "0")}`,
      open: price, high: price + 0.2, low: price - 0.2, close: price, volume: 100,
    });
  }
}

describe("9984 Current 固定1500株・source event depth VWAP", () => {
  it("新規entryとTP exitを各1500株の同一source event方向別depth VWAPで保存する", async () => {
    await feedPrefix();

    const entry = await processCandle({
      symbol: "9984", tradeDate, candleTime: "09:40",
      open: 100.5, high: 101.2, low: 100.4, close: 101, volume: 150,
    }, context("9984-entry", {
      asks: [{ price: 101, qty: 1_000 }, { price: 101.5, qty: 500 }],
      bids: [{ price: 100.9, qty: 2_000 }],
    }));

    expect(entry).toMatchObject({
      action: "entry",
      executionPrice: 101 + (0.5 / 3),
      executionPriceSource: "current_event_ask_depth_vwap",
      executionSourceEventId: "9984-entry",
      executionBoardAgeMs: 500,
    });
    expect(getOpenPositions().find(position => position.symbol === "9984")).toMatchObject({ shares: 1_500 });

    const exit = await processCandle({
      symbol: "9984", tradeDate, candleTime: "09:41",
      open: 101.2, high: 102, low: 101, close: 101.7, volume: 150,
    }, context("9984-exit", {
      asks: [{ price: 101.8, qty: 2_000 }],
      bids: [{ price: 101.7, qty: 1_000 }, { price: 101.4, qty: 500 }],
    }, 2_000));

    expect(exit).toMatchObject({
      action: "take_profit",
      executionPrice: 101.6,
      executionPriceSource: "current_event_bid_depth_vwap",
      executionSourceEventId: "9984-exit",
      executionBoardAgeMs: 500,
    });
    expect(getOpenPositions().find(position => position.symbol === "9984")).toBeUndefined();
    expect(vi.mocked(insertRtTrade)).toHaveBeenNthCalledWith(1, expect.objectContaining({
      action: "buy", shares: 1_500, price: String(101 + (0.5 / 3)), amount: (101 + (0.5 / 3)) * 1_500,
      reason: expect.stringContaining("fixed_execution=1500; leg=entry; signal_reference=101.00; depth_vwap=101.17; slippage_vs_reference=+250円; commission=0円(no_fee_model); source_event=9984-entry; source_board_age_ms=500"),
    }));
    expect(vi.mocked(insertRtTrade)).toHaveBeenNthCalledWith(2, expect.objectContaining({
      action: "sell", shares: 1_500, price: "101.6", amount: 152_400, pnl: 650,
      reason: expect.stringContaining("fixed_execution=1500; leg=exit"),
    }));
    expect(vi.mocked(insertRtTrade)).toHaveBeenNthCalledWith(2, expect.objectContaining({
      reason: expect.stringContaining("commission=0円(no_fee_model); source_event=9984-exit; source_board_age_ms=500; gross_pnl=+650円; net_pnl=+650円"),
    }));
  });

  it("1500株に不足する板ではentryをfail-closedにする", async () => {
    const insufficientDate = "2026-10-15";
    await feedPrefix(insufficientDate);
    const insufficient = await processCandle({
      symbol: "9984", tradeDate: insufficientDate, candleTime: "09:40",
      open: 100.5, high: 101.2, low: 100.4, close: 101, volume: 150,
    }, context("9984-too-shallow", { asks: [{ price: 101, qty: 1_499 }] }));
    expect(insufficient).toMatchObject({ action: "none", reason: "softbank_1500_depth_entry_rejected:source_event_depth_insufficient" });
    expect(getOpenPositions().find(position => position.symbol === "9984")).toBeUndefined();
  });

  it("1500株の想定額が通常shared margin上限を超えても9984専用virtual枠でだけ記録する", async () => {
    const separateCapitalDate = "2026-10-16";
    await feedPrefix(separateCapitalDate, 6_000);
    const entry = await processCandle({
      symbol: "9984", tradeDate: separateCapitalDate, candleTime: "09:40",
      open: 6_000, high: 6_060, low: 5_999, close: 6_050, volume: 150,
    }, context("9984-separate-capital", { asks: [{ price: 6_050, qty: 2_000 }], bids: [{ price: 6_049, qty: 2_000 }] }));
    expect(entry).toMatchObject({ action: "entry", executionPrice: 6_050 });
    expect(getOpenPositions().find(position => position.symbol === "9984")).toMatchObject({
      shares: 1_500,
      separateVirtualCapital: true,
    });
  });

  it("再起動復元した9984固定1500株も専用virtual capital枠として保持する", async () => {
    await processCandle({
      symbol: "9984", tradeDate: "2026-10-19", candleTime: "09:10",
      open: 6_000, high: 6_001, low: 5_999, close: 6_000, volume: 100,
    });
    restoreOpenPositions([{
      symbol: "9984",
      side: "long",
      price: 6_050,
      shares: 1_500,
      tradeTime: "09:40",
      reason: "ソフトバンクG専用10本高値更新LONG: 再起動復元テスト",
    }]);
    expect(getOpenPositions().find(position => position.symbol === "9984")).toMatchObject({
      shares: 1_500,
      separateVirtualCapital: true,
    });
  });

  it("source board ageが5秒超ならdelivery遅延に関係なくentryをfail-closedにする", async () => {
    const staleDate = "2026-10-14";
    await feedPrefix(staleDate);
    // helperがrelayAssembledAtMsをobserved+500に置く通常fixtureと異なり、ここだけ5,001msに固定する。
    const staleContext = context("9984-stale-source-board-5001", { asks: [{ price: 101, qty: 2_000 }] }, 1_000);
    staleContext.currentAudit.relayAssembledAtMs = 6_001;
    const stale5001 = await processCandle({
      symbol: "9984", tradeDate: staleDate, candleTime: "09:40",
      open: 101, high: 101.2, low: 100.8, close: 101.1, volume: 150,
    }, staleContext);
    expect(stale5001).toMatchObject({ action: "none", reason: "softbank_1500_depth_entry_rejected:source_event_board_stale_over_5000ms" });
  });

  it("source event板がないscheduler強制決済では1500株を終値へフォールバックさせない", async () => {
    const forcedDate = "2026-10-20";
    await processCandle({
      symbol: "9984", tradeDate: forcedDate, candleTime: "09:10",
      open: 100, high: 100.1, low: 99.9, close: 100, volume: 100,
    });
    restoreOpenPositions([{
      symbol: "9984",
      side: "long",
      price: 100,
      shares: 1_500,
      tradeTime: "09:40",
      reason: "ソフトバンクG専用10本高値更新LONG: scheduler source contextなし",
    }]);

    vi.mocked(insertRtTrade).mockClear();
    await forceCloseAllPositions(forcedDate, new Map([["9984", 99]]));

    expect(getOpenPositions().find(position => position.symbol === "9984")).toMatchObject({
      shares: 1_500,
    });
    expect(vi.mocked(insertRtTrade)).not.toHaveBeenCalled();
  });
});
