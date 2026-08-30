import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import fixture from "./fixtures/socionextConfirmedLong.audit.fixture.json";
import expected from "./fixtures/socionextConfirmedLong.expected.json";

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
}));
vi.mock("./kabuStation", () => ({
  getOrderBook: vi.fn().mockReturnValue(null),
  analyzeOrderBook: vi.fn().mockReturnValue([]),
  calcExtendedBoardFields: vi.fn().mockReturnValue({}),
  getAggregatedBoardStats: vi.fn().mockReturnValue(null),
  clearBoardRingBuffer: vi.fn(),
}));
vi.mock("../shared/stocks", () => ({
  getStockName: vi.fn().mockReturnValue("ソシオネクスト"),
  TARGET_STOCKS: [{ symbol: "6526", ticker: "6526.T", name: "ソシオネクスト", basePrice: 3250, sector: "半導体" }],
  TRADE_EXCLUDED_SYMBOLS: new Set([]),
  ACTIVE_ENTRY_SYMBOLS: new Set(["6526"]),
}));

import {
  forceCloseAllPositions,
  getOpenPositions,
  getSocionextConfirmedLongAuditEventsForTest,
  processCandle,
  restoreOpenPositions,
  shouldBoardEarlyExit,
} from "./realtimeSimEngine";
import { upsertSocionextConfirmedLongEvent } from "./db";

type Row = [string, number, number, number, number, number];
type Segment = { purpose: "full_saved_day"; tradeDate: string; candles: Row[] };
type ExpectedTrade = (typeof expected.trades)[number];

describe("6526確認型ブレイクLONG Git fixture実エンジン監査", () => {
  async function feedFlatPrefix(tradeDate: string, narrow = false) {
    for (let minute = 0; minute <= 29; minute += 1) {
      await processCandle({
        symbol: "6526",
        tradeDate,
        candleTime: `09:${String(minute).padStart(2, "0")}`,
        open: 100,
        high: narrow ? 100.02 : 100.2,
        low: narrow ? 99.98 : 99.8,
        close: 100,
        volume: 100,
      });
    }
  }

  it("全46日fixtureのSHA-256を生バイトで固定する", () => {
    const bytes = readFileSync(new URL("./fixtures/socionextConfirmedLong.audit.fixture.json", import.meta.url));
    expect(createHash("sha256").update(bytes).digest("hex"))
      .toBe("66ce7ce286a956bc6904ccd3d64aaa3ca598f769d2a04079a02e652c4d88edfa");
  });

  it("全46日15,079足で全19取引・決済理由・全確認失敗を厳密再現する", async () => {
    const actualTrades: ExpectedTrade[] = [];
    const rejectedEvents: typeof expected.rejectedEvents = [];
    let active: { date: string; entryTime: string; entryPrice: number; shares: number } | null = null;
    let processedRows = 0;

    expect(fixture.dateCount).toBe(expected.summary.sourceDates);
    expect(fixture.rowCount).toBe(expected.summary.sourceRows);

    for (const segment of fixture.segments as Segment[]) {
      for (const [candleTime, open, high, low, close, volume] of segment.candles) {
        processedRows += 1;
        const result = await processCandle({ symbol: "6526", tradeDate: segment.tradeDate, candleTime, open, high, low, close, volume });
        if (result.action === "entry") {
          const position = getOpenPositions().find(item => item.symbol === "6526");
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
      rejectedEvents.push(...getSocionextConfirmedLongAuditEventsForTest()
        .filter(event => event.event === "confirmation_rejected" || event.event === "engine_rejected")
        .map(event => ({
          tradeDate: event.tradeDate,
          candleTime: event.candleTime,
          event: event.event,
          triggerTime: event.triggerTime,
          rejectionCodes: event.rejectionCodes ?? null,
          detail: event.detail ?? null,
        })));
    }

    expect(processedRows).toBe(15_079);
    expect(actualTrades).toEqual(expected.trades);
    expect(rejectedEvents).toEqual(expected.rejectedEvents);
    expect(actualTrades.filter(trade => trade.pnlPer100 > 0)).toHaveLength(16);
    expect(actualTrades.filter(trade => trade.pnlPer100 < 0)).toHaveLength(3);
    expect(Math.round(actualTrades.reduce((sum, trade) => sum + trade.pnlPer100, 0) * 100) / 100).toBe(11_823.89);
    expect(vi.mocked(upsertSocionextConfirmedLongEvent)).toHaveBeenCalledTimes(17);

    const recentFive = actualTrades.filter(trade => expected.summary.recentFiveDates.includes(trade.date));
    expect(recentFive).toHaveLength(3);
    expect(recentFive.every(trade => trade.pnlPer100 > 0)).toBe(true);
    expect(Math.round(recentFive.reduce((sum, trade) => sum + trade.pnlPer100, 0) * 100) / 100).toBe(2_953.73);
  }, 90_000);

  it("0.05%・0.10%不利約定後の勝敗と損益を固定する", () => {
    const calculate = (adversePct: number) => expected.trades.map(trade => ({
      ...trade,
      adjustedPnl: trade.pnlPer100 - trade.entryPrice * adversePct,
    }));
    const adverse05 = calculate(0.05);
    const adverse10 = calculate(0.10);
    expect(adverse05.filter(trade => trade.adjustedPnl > 0)).toHaveLength(16);
    expect(adverse05.filter(trade => trade.adjustedPnl <= 0)).toHaveLength(3);
    expect(Math.round(adverse05.reduce((sum, trade) => sum + trade.adjustedPnl, 0) * 100) / 100).toBe(9_598.31);
    expect(adverse10.filter(trade => trade.adjustedPnl > 0)).toHaveLength(15);
    expect(adverse10.filter(trade => trade.adjustedPnl <= 0)).toHaveLength(4);
    expect(Math.round(adverse10.reduce((sum, trade) => sum + trade.adjustedPnl, 0) * 100) / 100).toBe(7_372.74);
  });

  it("6526確認型LONGポジションでは板読み早期利確を使用しない", () => {
    expect(shouldBoardEarlyExit({
      symbol: "6526", side: "long", entryPrice: 2_000, shares: 100, entryTime: "10:00",
      entryReason: "ソシオネクスト確認型LONG: 監査テスト",
    }, 2_002, {
      buyPressureRatio: 0.5, largeBuyWall: false, largeSellWall: false,
      marketOrderRatio: 0, signal: "sell_pressure",
    })).toBe(false);
  });

  it("証拠金拒否は日次枠を消費せず、解放後の後続候補へ再探索する", async () => {
    const tradeDate = "2099-01-01";
    await feedFlatPrefix(tradeDate);
    restoreOpenPositions([{
      symbol: "285A", side: "long", price: 8_800_000, shares: 1,
      tradeTime: "09:20", reason: "6526証拠金再探索テスト用",
    }]);

    await processCandle({ symbol: "6526", tradeDate, candleTime: "09:30", open: 100.1, high: 101.2, low: 100, close: 101, volume: 150 });
    const blocked = await processCandle({ symbol: "6526", tradeDate, candleTime: "09:31", open: 101, high: 101.6, low: 100.9, close: 101.5, volume: 100 });
    expect(blocked).toMatchObject({ action: "none", reason: "margin_block" });

    await forceCloseAllPositions(tradeDate, new Map([["285A", 8_800_000]]));
    await processCandle({ symbol: "6526", tradeDate, candleTime: "09:32", open: 101.5, high: 102.1, low: 101.4, close: 102, volume: 150 });
    const accepted = await processCandle({ symbol: "6526", tradeDate, candleTime: "09:33", open: 102, high: 102.6, low: 101.9, close: 102.5, volume: 100 });
    expect(accepted.action).toBe("entry");
    expect(accepted.reason).toContain("ソシオネクスト確認型LONG");
    expect(getSocionextConfirmedLongAuditEventsForTest().some(
      event => event.event === "engine_rejected" && event.detail === "margin_block",
    )).toBe(true);
    expect(vi.mocked(upsertSocionextConfirmedLongEvent)).toHaveBeenCalledWith(expect.objectContaining({
      tradeDate,
      candleTime: "09:31",
      eventType: "engine_rejected",
      detail: "margin_block",
      triggerTime: "09:30",
      referencePrice: "101.5",
    }));
  });

  it("ATR拒否も日次枠を消費せず、ボラティリティ回復後の後続候補へ再探索する", async () => {
    const tradeDate = "2099-01-02";
    await feedFlatPrefix(tradeDate, true);
    await processCandle({ symbol: "6526", tradeDate, candleTime: "09:30", open: 100.4, high: 100.51, low: 100.39, close: 100.5, volume: 150 });
    const blocked = await processCandle({ symbol: "6526", tradeDate, candleTime: "09:31", open: 100.5, high: 100.61, low: 100.49, close: 100.6, volume: 100 });
    expect(blocked.action).toBe("none");
    expect(blocked.reason).toMatch(/^atr_block:/);

    await processCandle({ symbol: "6526", tradeDate, candleTime: "09:32", open: 100.6, high: 101, low: 100.2, close: 100.7, volume: 150 });
    const accepted = await processCandle({ symbol: "6526", tradeDate, candleTime: "09:33", open: 100.7, high: 101.1, low: 100.3, close: 100.8, volume: 100 });
    expect(accepted.action).toBe("entry");
    expect(getSocionextConfirmedLongAuditEventsForTest().some(
      event => event.event === "engine_rejected" && event.detail?.startsWith("atr_block:"),
    )).toBe(true);
  });
});
