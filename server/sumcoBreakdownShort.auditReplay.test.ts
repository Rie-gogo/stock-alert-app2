import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import fixture from "./fixtures/sumcoBreakdownShort.audit.fixture.json";
import expected from "./fixtures/sumcoBreakdownShort.expected.json";

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
}));
vi.mock("./kabuStation", () => ({
  getOrderBook: vi.fn().mockReturnValue(null),
  analyzeOrderBook: vi.fn().mockReturnValue([]),
  calcExtendedBoardFields: vi.fn().mockReturnValue({}),
  getAggregatedBoardStats: vi.fn().mockReturnValue(null),
  clearBoardRingBuffer: vi.fn(),
}));
vi.mock("../shared/stocks", () => ({
  getStockName: vi.fn().mockReturnValue("SUMCO"),
  TARGET_STOCKS: [{ symbol: "3436", ticker: "3436.T", name: "SUMCO", basePrice: 3_400, sector: "半導体" }],
  TRADE_EXCLUDED_SYMBOLS: new Set([]),
  ACTIVE_ENTRY_SYMBOLS: new Set(["3436"]),
}));

import {
  forceCloseAllPositions,
  getOpenPositions,
  getSumcoBreakdownShortAuditEventsForTest,
  processCandle,
  restoreOpenPositions,
  shouldBoardEarlyExit,
} from "./realtimeSimEngine";
import { upsertSumcoBreakdownShortEvent } from "./db";

type Row = [string, number, number, number, number, number];
type Segment = { purpose: "full_saved_day"; tradeDate: string; candles: Row[] };
type ExpectedTrade = (typeof expected.trades)[number];

describe("3436専用15本安値更新SHORT Git fixture実エンジン監査", () => {
  async function feedFlatPrefix(tradeDate: string, price = 100, narrow = false) {
    for (let minute = 0; minute <= 29; minute += 1) {
      await processCandle({
        symbol: "3436",
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

  it("全29日fixtureのSHA-256を生バイトで固定する", () => {
    const bytes = readFileSync(new URL("./fixtures/sumcoBreakdownShort.audit.fixture.json", import.meta.url));
    expect(createHash("sha256").update(bytes).digest("hex"))
      .toBe("0a83e73dcb17607cfa6d3ccde66b2601739856a3d8a4e930f879a74818ca4485");
  });

  it("全29日9,417足で全22取引・全決済理由を厳密再現する", async () => {
    const actualTrades: ExpectedTrade[] = [];
    const rejectedEvents: typeof expected.rejectedEvents = [];
    let active: { date: string; entryTime: string; entryPrice: number; shares: number } | null = null;
    let processedRows = 0;

    expect(fixture.dateCount).toBe(expected.summary.sourceDates);
    expect(fixture.rowCount).toBe(expected.summary.sourceRows);

    for (const segment of fixture.segments as Segment[]) {
      for (const [candleTime, open, high, low, close, volume] of segment.candles) {
        processedRows += 1;
        const result = await processCandle({ symbol: "3436", tradeDate: segment.tradeDate, candleTime, open, high, low, close, volume });
        if (result.action === "entry") {
          const position = getOpenPositions().find(item => item.symbol === "3436");
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
      rejectedEvents.push(...getSumcoBreakdownShortAuditEventsForTest()
        .filter(event => event.event === "engine_rejected")
        .map(event => ({
          tradeDate: event.tradeDate,
          candleTime: event.candleTime,
          event: event.event,
          detail: event.detail ?? null,
          referencePrice: event.referencePrice,
        })));
    }

    expect(processedRows).toBe(9_417);
    expect(actualTrades).toEqual(expected.trades);
    expect(rejectedEvents).toEqual(expected.rejectedEvents);
    expect(actualTrades.filter(trade => trade.pnlPer100 > 0)).toHaveLength(20);
    expect(actualTrades.filter(trade => trade.pnlPer100 < 0)).toHaveLength(2);
    expect(Math.round(actualTrades.reduce((sum, trade) => sum + trade.pnlPer100, 0) * 100) / 100).toBe(43_984.96);
    expect(vi.mocked(upsertSumcoBreakdownShortEvent)).not.toHaveBeenCalled();

    const recentFive = actualTrades.filter(trade => expected.summary.recentFiveDates.includes(trade.date));
    expect(recentFive).toHaveLength(5);
    expect(recentFive.every(trade => trade.pnlPer100 > 0)).toBe(true);
    expect(Math.round(recentFive.reduce((sum, trade) => sum + trade.pnlPer100, 0) * 100) / 100).toBe(11_948.34);
  }, 90_000);

  it("0.05%・0.10%不利約定後の勝敗と損益を固定する", () => {
    const calculate = (adversePct: number) => expected.trades.map(trade => ({
      ...trade,
      adjustedPnl: trade.pnlPer100 - trade.entryPrice * adversePct,
    }));
    const adverse05 = calculate(0.05);
    const adverse10 = calculate(0.10);
    expect(adverse05.filter(trade => trade.adjustedPnl > 0)).toHaveLength(20);
    expect(adverse05.filter(trade => trade.adjustedPnl <= 0)).toHaveLength(2);
    expect(Math.round(adverse05.reduce((sum, trade) => sum + trade.adjustedPnl, 0) * 100) / 100).toBe(40_009.94);
    expect(adverse10.filter(trade => trade.adjustedPnl > 0)).toHaveLength(20);
    expect(adverse10.filter(trade => trade.adjustedPnl <= 0)).toHaveLength(2);
    expect(Math.round(adverse10.reduce((sum, trade) => sum + trade.adjustedPnl, 0) * 100) / 100).toBe(36_034.91);
  });

  it("3436専用SHORTポジションでは板読み早期利確を使用しない", () => {
    expect(shouldBoardEarlyExit({
      symbol: "3436", side: "short", entryPrice: 3_400, shares: 100, entryTime: "10:00",
      entryReason: "SUMCO専用15本安値更新SHORT: 監査テスト",
    }, 3_398, {
      buyPressureRatio: 2, largeBuyWall: true, largeSellWall: false,
      marketOrderRatio: 1, signal: "buy_pressure",
    })).toBe(false);
  });

  it("3436専用SHORTはSL/TP未到達なら30分境界の確定足終値で決済する", async () => {
    const tradeDate = "2099-01-31";
    await feedFlatPrefix(tradeDate);
    restoreOpenPositions([{
      symbol: "3436", side: "short", price: 1_000, shares: 100,
      tradeTime: "09:30", reason: "SUMCO専用15本安値更新SHORT: 30分出口テスト",
    }]);
    const result = await processCandle({
      symbol: "3436", tradeDate, candleTime: "10:00",
      open: 999, high: 1_001, low: 998, close: 999, volume: 100,
    });
    expect(result.action).toBe("exit");
    expect(result.reason).toContain("最大保有30分");
  });

  it("証拠金拒否は日次枠を消費せず、解放後の後続候補へ再探索する", async () => {
    const tradeDate = "2099-02-01";
    await feedFlatPrefix(tradeDate);
    restoreOpenPositions([{
      symbol: "285A", side: "long", price: 8_800_000, shares: 1,
      tradeTime: "09:20", reason: "3436証拠金再探索テスト用",
    }]);

    const blocked = await processCandle({ symbol: "3436", tradeDate, candleTime: "09:30", open: 100, high: 100.1, low: 98.8, close: 99, volume: 150 });
    expect(blocked).toMatchObject({ action: "none", reason: "margin_block" });

    await forceCloseAllPositions(tradeDate, new Map([["285A", 8_800_000]]));
    const accepted = await processCandle({ symbol: "3436", tradeDate, candleTime: "09:31", open: 99, high: 99.1, low: 97.8, close: 98, volume: 150 });
    expect(accepted.action).toBe("entry");
    expect(accepted.reason).toContain("SUMCO専用15本安値更新SHORT");
    expect(getSumcoBreakdownShortAuditEventsForTest().some(
      event => event.event === "engine_rejected" && event.detail === "margin_block",
    )).toBe(true);
    expect(vi.mocked(upsertSumcoBreakdownShortEvent)).toHaveBeenCalledWith(expect.objectContaining({
      tradeDate,
      candleTime: "09:30",
      eventType: "engine_rejected",
      detail: "margin_block",
      referencePrice: "99",
    }));
  });

  it("ATR拒否も日次枠を消費せず、ボラティリティ回復後の後続候補へ再探索する", async () => {
    const tradeDate = "2099-02-02";
    await feedFlatPrefix(tradeDate, 1_000, true);
    const blocked = await processCandle({ symbol: "3436", tradeDate, candleTime: "09:30", open: 1_000, high: 1_000.01, low: 995.9, close: 996, volume: 150 });
    expect(blocked.action).toBe("none");
    expect(blocked.reason).toMatch(/^atr_block:/);

    const accepted = await processCandle({ symbol: "3436", tradeDate, candleTime: "09:31", open: 996, high: 1_000, low: 990, close: 991, volume: 150 });
    expect(accepted.action).toBe("entry");
    expect(getSumcoBreakdownShortAuditEventsForTest().some(
      event => event.event === "engine_rejected" && event.detail?.startsWith("atr_block:"),
    )).toBe(true);
  });
});
