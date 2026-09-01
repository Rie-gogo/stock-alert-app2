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
  upsertKioxiaConfirmedMorningLongEvent: vi.fn().mockResolvedValue(undefined),
  upsertKioxiaShortGuardEvent: vi.fn().mockResolvedValue(undefined),
  getKioxiaShortGuardEventsForDate: vi.fn().mockResolvedValue([]),
}));
vi.mock("./kabuStation", () => ({
  getOrderBook: vi.fn().mockReturnValue(null),
  analyzeOrderBook: vi.fn().mockReturnValue([]),
  calcExtendedBoardFields: vi.fn().mockReturnValue({}),
  getAggregatedBoardStats: vi.fn().mockReturnValue(null),
  clearBoardRingBuffer: vi.fn(),
}));
vi.mock("../shared/stocks", () => ({
  getStockName: vi.fn().mockReturnValue("キオクシアHD"),
  TARGET_STOCKS: [{ symbol: "285A", ticker: "285A.T", name: "キオクシアHD", basePrice: 100, sector: "半導体" }],
  TRADE_EXCLUDED_SYMBOLS: new Set([]),
  ACTIVE_ENTRY_SYMBOLS: new Set(["285A"]),
}));

import {
  forceCloseAllPositions,
  getKioxiaConfirmedMorningLongAuditEventsForTest,
  processCandle,
  restoreOpenPositions,
} from "./realtimeSimEngine";
import { upsertKioxiaConfirmedMorningLongEvent } from "./db";
import { KIOXIA_CONFIRMED_MORNING_LONG_REASON_PREFIX } from "./kioxiaConfirmedMorningLong";

async function feedPrefix(tradeDate: string, price = 100, narrow = false) {
  for (let minute = 15; minute <= 44; minute += 1) {
    const close = price + (minute - 15) * (narrow ? 0 : 0.01);
    await processCandle({
      symbol: "285A",
      tradeDate,
      candleTime: `09:${String(minute).padStart(2, "0")}`,
      open: close,
      high: close + (narrow ? 0.01 : 0.02),
      low: close - (narrow ? 0.01 : 0.02),
      close,
      volume: 100,
    });
  }
}

describe("285A確認型前場LONG 実エンジン監査", () => {
  it("証拠金拒否は日次枠を消費せず、資金解放後の後続候補へ再探索する", async () => {
    const tradeDate = "2099-04-01";
    await feedPrefix(tradeDate);
    restoreOpenPositions([{
      symbol: "9984", side: "long", price: 8_905_000, shares: 1,
      tradeTime: "09:20", reason: "285A証拠金再探索テスト用",
    }]);

    const blocked = await processCandle({
      symbol: "285A", tradeDate, candleTime: "09:45",
      open: 100, high: 100.61, low: 99.99, close: 100.6, volume: 140,
    });
    expect(blocked).toMatchObject({ action: "none", reason: "margin_block" });

    await forceCloseAllPositions(tradeDate, new Map([["9984", 8_905_000]]));
    const accepted = await processCandle({
      symbol: "285A", tradeDate, candleTime: "09:46",
      open: 100.6, high: 101.21, low: 100.59, close: 101.2, volume: 150,
    });
    expect(accepted.action).toBe("entry");
    expect(accepted.reason).toContain(KIOXIA_CONFIRMED_MORNING_LONG_REASON_PREFIX);
    expect(getKioxiaConfirmedMorningLongAuditEventsForTest().some(
      event => event.event === "engine_rejected" && event.detail === "margin_block",
    )).toBe(true);
    expect(vi.mocked(upsertKioxiaConfirmedMorningLongEvent)).toHaveBeenCalledWith(expect.objectContaining({
      tradeDate,
      candleTime: "09:45",
      eventType: "engine_rejected",
      detail: "margin_block",
      referencePrice: "100.6",
    }));
  });

  it("ATR拒否も日次枠を消費せず、ボラティリティ回復後に再探索する", async () => {
    const tradeDate = "2099-04-02";
    await feedPrefix(tradeDate, 1_000, true);
    const blocked = await processCandle({
      symbol: "285A", tradeDate, candleTime: "09:45",
      open: 1_000, high: 1_005.1, low: 999.99, close: 1_005, volume: 140,
    });
    expect(blocked.action).toBe("none");
    expect(blocked.reason).toMatch(/^atr_block:/);

    const accepted = await processCandle({
      symbol: "285A", tradeDate, candleTime: "09:46",
      open: 1_005, high: 1_013, low: 999, close: 1_012, volume: 150,
    });
    expect(accepted.action).toBe("entry");
    expect(getKioxiaConfirmedMorningLongAuditEventsForTest().some(
      event => event.event === "engine_rejected" && event.detail?.startsWith("atr_block:"),
    )).toBe(true);
  });

  it("実エントリー成功後だけ日次枠を消費し、同日2回目は発火しない", async () => {
    const tradeDate = "2099-04-03";
    await feedPrefix(tradeDate);
    const first = await processCandle({
      symbol: "285A", tradeDate, candleTime: "09:45",
      open: 100, high: 100.61, low: 99.99, close: 100.6, volume: 140,
    });
    expect(first.action).toBe("entry");
    await forceCloseAllPositions(tradeDate, new Map([["285A", 100.6]]));
    const second = await processCandle({
      symbol: "285A", tradeDate, candleTime: "09:46",
      open: 100.6, high: 101.31, low: 100.59, close: 101.3, volume: 150,
    });
    expect(second.action).toBe("none");
  });
});
