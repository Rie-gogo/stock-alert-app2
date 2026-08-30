import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import fixture from "./fixtures/softbankBreakoutLong.audit.fixture.json";
import expected from "./fixtures/softbankBreakoutLong.expected.json";

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

import {
  forceCloseAllPositions,
  getOpenPositions,
  getSoftbankBreakoutLongAuditEventsForTest,
  processCandle,
  resolveRestoredRiskOverrides,
  resolveSpecializedFiredStateKeys,
  restoreOpenPositions,
  shouldBoardEarlyExit,
} from "./realtimeSimEngine";
import { upsertSoftbankBreakoutLongEvent } from "./db";
import { SOFTBANK_BREAKOUT_LONG_REASON_PREFIX } from "./softbankBreakoutLong";

type Row = [string, number, number, number, number, number];
type Segment = { purpose: "full_saved_day"; tradeDate: string; candles: Row[] };
type ExpectedTrade = (typeof expected.trades)[number];

describe("9984専用10本高値更新LONG Git fixture実エンジン監査", () => {
  async function feedFlatPrefix(tradeDate: string, price = 100, narrow = false) {
    for (let minute = 10; minute <= 39; minute += 1) {
      await processCandle({
        symbol: "9984",
        tradeDate,
        candleTime: `09:${String(minute).padStart(2, "0")}`,
        open: price,
        high: narrow ? price + 0.01 : price + 0.2,
        low: narrow ? price - 0.01 : price - 0.2,
        close: price,
        volume: 100,
      });
    }
  }

  it("全44日fixtureのSHA-256を生バイトで固定する", () => {
    const bytes = readFileSync(new URL("./fixtures/softbankBreakoutLong.audit.fixture.json", import.meta.url));
    expect(createHash("sha256").update(bytes).digest("hex"))
      .toBe("360e8cb3f9ee6379830b84f8f4cd1376774fb9672cf7076ff23638ec19b18de5");
  });

  it("全44日14,353足で全25取引・全決済理由を厳密再現する", async () => {
    const actualTrades: ExpectedTrade[] = [];
    const rejectedEvents: typeof expected.rejectedEvents = [];
    let active: { date: string; entryTime: string; entryPrice: number; shares: number } | null = null;
    let processedRows = 0;

    expect(fixture.dateCount).toBe(expected.summary.sourceDates);
    expect(fixture.rowCount).toBe(expected.summary.sourceRows);

    for (const segment of fixture.segments as Segment[]) {
      for (const [candleTime, open, high, low, close, volume] of segment.candles) {
        processedRows += 1;
        const result = await processCandle({ symbol: "9984", tradeDate: segment.tradeDate, candleTime, open, high, low, close, volume });
        if (result.action === "entry") {
          const position = getOpenPositions().find(item => item.symbol === "9984");
          expect(position).toBeDefined();
          active = { date: segment.tradeDate, entryTime: candleTime, entryPrice: position!.entryPrice, shares: position!.shares };
        } else if (result.action !== "none" && active && typeof result.pnl === "number") {
          actualTrades.push({
            date: active.date,
            entryTime: active.entryTime,
            entryPrice: active.entryPrice,
            exitTime: candleTime,
            exitAction: result.action,
            exitReason: result.reason ?? "",
            pnlPer100: Math.round((result.pnl / active.shares * 100) * 100) / 100,
          });
          active = null;
        }
      }
      rejectedEvents.push(...getSoftbankBreakoutLongAuditEventsForTest()
        .filter(event => event.event === "engine_rejected")
        .map(event => ({
          tradeDate: event.tradeDate,
          candleTime: event.candleTime,
          event: event.event,
          detail: event.detail ?? null,
          referencePrice: event.referencePrice,
        })));
    }

    expect(processedRows).toBe(14_353);
    expect(actualTrades).toEqual(expected.trades);
    expect(rejectedEvents).toEqual(expected.rejectedEvents);
    expect(actualTrades.filter(trade => trade.pnlPer100 > 0)).toHaveLength(23);
    expect(actualTrades.filter(trade => trade.pnlPer100 < 0)).toHaveLength(2);
    expect(Math.round(actualTrades.reduce((sum, trade) => sum + trade.pnlPer100, 0) * 100) / 100).toBe(29_675.8);
    expect(vi.mocked(upsertSoftbankBreakoutLongEvent)).not.toHaveBeenCalled();

    const recentFive = actualTrades.filter(trade => expected.summary.recentFiveDates.includes(trade.date));
    expect(recentFive).toHaveLength(5);
    expect(recentFive.filter(trade => trade.pnlPer100 > 0)).toHaveLength(4);
    expect(recentFive.filter(trade => trade.pnlPer100 < 0)).toHaveLength(1);
    expect(Math.round(recentFive.reduce((sum, trade) => sum + trade.pnlPer100, 0) * 100) / 100).toBe(2_010.15);
  }, 120_000);

  it("0.05%・0.10%不利約定後の勝敗と損益を固定する", () => {
    const calculate = (adversePct: number) => expected.trades.map(trade => ({
      ...trade,
      adjustedPnl: trade.pnlPer100 - trade.entryPrice * adversePct,
    }));
    const adverse05 = calculate(0.05);
    const adverse10 = calculate(0.10);
    expect(adverse05.filter(trade => trade.adjustedPnl > 0)).toHaveLength(23);
    expect(adverse05.filter(trade => trade.adjustedPnl <= 0)).toHaveLength(2);
    expect(Math.round(adverse05.reduce((sum, trade) => sum + trade.adjustedPnl, 0) * 100) / 100).toBe(22_575.25);
    expect(adverse10.filter(trade => trade.adjustedPnl > 0)).toHaveLength(23);
    expect(adverse10.filter(trade => trade.adjustedPnl <= 0)).toHaveLength(2);
    expect(Math.round(adverse10.reduce((sum, trade) => sum + trade.adjustedPnl, 0) * 100) / 100).toBe(15_474.7);
  });

  it("9984専用LONGは板読み早期利確を使用しない", () => {
    expect(shouldBoardEarlyExit({
      symbol: "9984", side: "long", entryPrice: 5_000, shares: 100, entryTime: "10:00",
      entryReason: `${SOFTBANK_BREAKOUT_LONG_REASON_PREFIX}: 監査テスト`,
    }, 5_010, {
      buyPressureRatio: 0.5, largeBuyWall: false, largeSellWall: true,
      marketOrderRatio: 1, signal: "sell_pressure",
    })).toBe(false);
  });

  it("SL/TP未到達なら45分境界の確定足終値で決済する", async () => {
    const tradeDate = "2099-03-01";
    await feedFlatPrefix(tradeDate, 1_000);
    restoreOpenPositions([{
      symbol: "9984", side: "long", price: 1_000, shares: 100,
      tradeTime: "09:40", reason: `${SOFTBANK_BREAKOUT_LONG_REASON_PREFIX}: 45分出口テスト`,
    }]);
    const result = await processCandle({
      symbol: "9984", tradeDate, candleTime: "10:25",
      open: 1_000, high: 1_002, low: 999, close: 1_001, volume: 100,
    });
    expect(result.action).toBe("exit");
    expect(result.reason).toContain("最大保有45分");
  });

  it("復元時のSL0.8%・TP0.3%と発火済みキーを識別する", () => {
    const reason = `${SOFTBANK_BREAKOUT_LONG_REASON_PREFIX}: 復元テスト`;
    expect(resolveRestoredRiskOverrides("9984", "long", reason)).toEqual({ slPct: 0.8, tpPct: 0.3 });
    expect(resolveSpecializedFiredStateKeys("9984", "buy", reason)).toEqual(["softbankBreakoutLong"]);
  });

  it("証拠金拒否は日次枠を消費せず、解放後の後続候補へ再探索する", async () => {
    const tradeDate = "2099-03-02";
    await feedFlatPrefix(tradeDate);
    restoreOpenPositions([{
      symbol: "285A", side: "long", price: 8_800_000, shares: 1,
      tradeTime: "09:20", reason: "9984証拠金再探索テスト用",
    }]);

    const blocked = await processCandle({ symbol: "9984", tradeDate, candleTime: "09:40", open: 100, high: 101.1, low: 99.9, close: 101, volume: 150 });
    expect(blocked).toMatchObject({ action: "none", reason: "margin_block" });

    await forceCloseAllPositions(tradeDate, new Map([["285A", 8_800_000]]));
    const accepted = await processCandle({ symbol: "9984", tradeDate, candleTime: "09:41", open: 101, high: 102.1, low: 100.9, close: 102, volume: 150 });
    expect(accepted.action).toBe("entry");
    expect(accepted.reason).toContain(SOFTBANK_BREAKOUT_LONG_REASON_PREFIX);
    expect(getSoftbankBreakoutLongAuditEventsForTest().some(
      event => event.event === "engine_rejected" && event.detail === "margin_block",
    )).toBe(true);
    expect(vi.mocked(upsertSoftbankBreakoutLongEvent)).toHaveBeenCalledWith(expect.objectContaining({
      tradeDate,
      candleTime: "09:40",
      eventType: "engine_rejected",
      detail: "margin_block",
      referencePrice: "101",
    }));
  });

  it("ATR拒否も日次枠を消費せず、ボラティリティ回復後の後続候補へ再探索する", async () => {
    const tradeDate = "2099-03-03";
    await feedFlatPrefix(tradeDate, 1_000, true);
    const blocked = await processCandle({ symbol: "9984", tradeDate, candleTime: "09:40", open: 1_000, high: 1_004.1, low: 999.99, close: 1_004, volume: 150 });
    expect(blocked.action).toBe("none");
    expect(blocked.reason).toMatch(/^atr_block:/);

    const accepted = await processCandle({ symbol: "9984", tradeDate, candleTime: "09:41", open: 1_004, high: 1_010, low: 1_000, close: 1_009, volume: 150 });
    expect(accepted.action).toBe("entry");
    expect(getSoftbankBreakoutLongAuditEventsForTest().some(
      event => event.event === "engine_rejected" && event.detail?.startsWith("atr_block:"),
    )).toBe(true);
  });
});
