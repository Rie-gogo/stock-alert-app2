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
  upsertTelOpenDirectionBreakoutEvent: vi.fn().mockResolvedValue(undefined),
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
  getStockName: vi.fn((symbol: string) => symbol === "8035" ? "東京エレクトロン" : "テスト銘柄"),
  TARGET_STOCKS: [
    { symbol: "8035", ticker: "8035.T", name: "東京エレクトロン", basePrice: 70_000, sector: "半導体" },
    { symbol: "9984", ticker: "9984.T", name: "テスト銘柄", basePrice: 8_905_000, sector: "テスト" },
  ],
  TRADE_EXCLUDED_SYMBOLS: new Set([]),
  ACTIVE_ENTRY_SYMBOLS: new Set(["8035"]),
}));

import { upsertTelOpenDirectionBreakoutEvent } from "./db";
import {
  forceCloseAllPositions,
  getTelOpenDirectionBreakoutAuditEventsForTest,
  processCandle,
  restoreOpenPositions,
} from "./realtimeSimEngine";
import { TEL_OPEN_DIRECTION_BREAKOUT_REASON_PREFIX } from "./telOpenDirectionBreakout";

async function feedPrefix(tradeDate: string, narrow = false) {
  for (let minute = 30; minute <= 59; minute += 1) {
    await processCandle({
      symbol: "8035",
      tradeDate,
      candleTime: `09:${String(minute).padStart(2, "0")}`,
      open: 70_000,
      high: 70_000 + (narrow ? 1 : 100),
      low: 70_000 - (narrow ? 1 : 100),
      close: 70_000,
      volume: 100,
    });
  }
}

describe("8035始値方向付き短期ブレイク 実エンジン監査", () => {
  it("証拠金拒否は日次枠を消費せず、資金解放後の次候補へ再探索する", async () => {
    const tradeDate = "2099-05-01";
    await feedPrefix(tradeDate);
    restoreOpenPositions([{
      symbol: "9984", side: "long", price: 8_905_000, shares: 1,
      tradeTime: "09:20", reason: "8035証拠金再探索テスト用",
    }]);

    const blocked = await processCandle({
      symbol: "8035", tradeDate, candleTime: "10:00",
      open: 70_100, high: 70_320, low: 70_090, close: 70_300, volume: 100,
    });
    expect(blocked).toMatchObject({ action: "none", reason: "margin_block" });

    await forceCloseAllPositions(tradeDate, new Map([["9984", 8_905_000]]));
    const accepted = await processCandle({
      symbol: "8035", tradeDate, candleTime: "10:01",
      open: 70_300, high: 70_620, low: 70_290, close: 70_600, volume: 110,
    });
    expect(accepted.action).toBe("entry");
    expect(accepted.reason).toContain(TEL_OPEN_DIRECTION_BREAKOUT_REASON_PREFIX);
    expect(getTelOpenDirectionBreakoutAuditEventsForTest().some(
      event => event.event === "engine_rejected" && event.detail === "margin_block",
    )).toBe(true);
    expect(vi.mocked(upsertTelOpenDirectionBreakoutEvent)).toHaveBeenCalledWith(expect.objectContaining({
      tradeDate,
      candleTime: "10:00",
      eventType: "engine_rejected",
      side: "long",
      detail: "margin_block",
      referencePrice: "70300",
    }));
  });

  it("ATR拒否も日次枠を消費せず、ボラティリティ回復後に再探索する", async () => {
    const tradeDate = "2099-05-02";
    await feedPrefix(tradeDate, true);
    const blocked = await processCandle({
      symbol: "8035", tradeDate, candleTime: "10:00",
      open: 70_050, high: 70_210, low: 69_999, close: 70_200, volume: 100,
    });
    expect(blocked.action).toBe("none");
    expect(blocked.reason).toMatch(/^atr_block:/);

    const accepted = await processCandle({
      symbol: "8035", tradeDate, candleTime: "10:01",
      open: 70_200, high: 70_520, low: 69_700, close: 70_500, volume: 110,
    });
    expect(accepted.action).toBe("entry");
    expect(getTelOpenDirectionBreakoutAuditEventsForTest().some(
      event => event.event === "engine_rejected" && event.detail?.startsWith("atr_block:"),
    )).toBe(true);
  });

  it("実エントリー成功後だけ日次枠を消費し、同日2回目は発火しない", async () => {
    const tradeDate = "2099-05-03";
    await feedPrefix(tradeDate);
    const first = await processCandle({
      symbol: "8035", tradeDate, candleTime: "10:00",
      open: 70_100, high: 70_320, low: 70_090, close: 70_300, volume: 100,
    });
    expect(first.action).toBe("entry");
    await forceCloseAllPositions(tradeDate, new Map([["8035", 70_300]]));
    const second = await processCandle({
      symbol: "8035", tradeDate, candleTime: "10:01",
      open: 70_300, high: 70_720, low: 70_290, close: 70_700, volume: 120,
    });
    expect(second.action).toBe("none");
  });
});
