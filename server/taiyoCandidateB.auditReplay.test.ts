import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import auditFixture from "./fixtures/taiyoCandidateA.audit.fixture.json";
import {
  TAIYO_CANDIDATE_B_EXPECTED_SUMMARY,
  TAIYO_CANDIDATE_B_EXPECTED_TRADES,
  TAIYO_CANDIDATE_B_FIXTURE_SHA256,
  TAIYO_CANDIDATE_B_REJECTION_STREAM_SHA256,
  type TaiyoCandidateBExpectedTrade,
} from "./fixtures/taiyoCandidateB.expected";

type Snapshot = {
  buyPressureRatio?: number;
  marketOrderRatio?: number;
  marketOrderDirection?: "buy" | "sell" | "neutral";
  signal?: "buy_pressure" | "sell_pressure" | "large_buy_wall" | "large_sell_wall" | "market_surge" | "neutral";
  largeBuyWall?: boolean;
  largeSellWall?: boolean;
  [key: string]: unknown;
};
type FixtureRow = [string, number, number, number, number, number, Snapshot | null];
type FixtureSegment = { purpose: "full_saved_day"; tradeDate: string; candles: FixtureRow[] };

let currentSnapshot: Snapshot | null = null;
function makeBook(snapshot: Snapshot | null) {
  if (!snapshot) return null;
  const ask = 10_000;
  const bid = Math.round(ask * Math.max(0.01, Number(snapshot.buyPressureRatio ?? 1)));
  return {
    bids: [{ price: 1, qty: bid }], asks: [{ price: 1, qty: ask }],
    underBuyQty: 0, overSellQty: 0, marketOrderBuyQty: 0, marketOrderSellQty: 0,
  };
}

vi.mock("./db", () => ({
  insertRtCandle: vi.fn().mockResolvedValue(undefined),
  insertRtTrade: vi.fn().mockResolvedValue(undefined),
  upsertRtDailySummary: vi.fn().mockResolvedValue(undefined),
  getRtTradesForDate: vi.fn().mockResolvedValue([]),
  getRtCandlesAllForDate: vi.fn().mockResolvedValue([]),
  getRtOpenPositionsFromDb: vi.fn().mockResolvedValue([]),
  insertScore0Block: vi.fn().mockResolvedValue(undefined),
  upsertTaiyoCandidateBEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./kabuStation", () => ({
  getOrderBook: vi.fn(() => makeBook(currentSnapshot)),
  analyzeOrderBook: vi.fn().mockReturnValue([]),
  calcExtendedBoardFields: vi.fn(() => currentSnapshot ?? {}),
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
  forceCloseAllPositions,
  getOpenPositions,
  getTaiyoCandidateBAuditEventsForTest,
  processCandle,
  restoreOpenPositions,
  setTaiyoCandidateAAuditEnabledForTest,
  shouldBoardEarlyExit,
} from "./realtimeSimEngine";
import { upsertTaiyoCandidateBEvent } from "./db";

afterEach(() => {
  setTaiyoCandidateAAuditEnabledForTest(false);
  currentSnapshot = null;
  vi.clearAllMocks();
});

describe("6976候補B30分 Git fixture実エンジン監査", () => {
  async function feedFlatPrefix(tradeDate: string, narrow = false) {
    for (let minute = 0; minute <= 44; minute++) {
      await processCandle({
        symbol: "6976",
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
    const bytes = readFileSync(new URL("./fixtures/taiyoCandidateA.audit.fixture.json", import.meta.url));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(TAIYO_CANDIDATE_B_FIXTURE_SHA256);
  });

  it("全46日14,719足で全33取引・決済理由・全確認失敗イベントを厳密再現する", async () => {
    setTaiyoCandidateAAuditEnabledForTest(false);
    const actualTrades: TaiyoCandidateBExpectedTrade[] = [];
    const rejectedEvents: Array<Record<string, unknown>> = [];
    let activeEntry: { date: string; time: string; price: number; shares: number; side: "long" | "short"; reason: string } | null = null;
    let processedRows = 0;

    expect(auditFixture.dateCount).toBe(TAIYO_CANDIDATE_B_EXPECTED_SUMMARY.sourceDates);
    expect(auditFixture.rowCount).toBe(TAIYO_CANDIDATE_B_EXPECTED_SUMMARY.sourceRows);

    for (const segment of auditFixture.segments as FixtureSegment[]) {
      for (const [candleTime, open, high, low, close, volume, snapshot] of segment.candles) {
        processedRows++;
        currentSnapshot = snapshot;
        const result = await processCandle({ symbol: "6976", tradeDate: segment.tradeDate, candleTime, open, high, low, close, volume });
        if (result.action === "entry") {
          const position = getOpenPositions().find(item => item.symbol === "6976");
          expect(position).toBeDefined();
          activeEntry = { date: segment.tradeDate, time: candleTime, price: close, shares: position!.shares, side: position!.side, reason: result.reason ?? "" };
        } else if (result.action !== "none" && activeEntry) {
          actualTrades.push({
            date: activeEntry.date,
            route: activeEntry.reason.startsWith("太陽誘電候補B") ? "primary" : "afternoon_short",
            side: activeEntry.side,
            entryTime: activeEntry.time,
            entryPrice: activeEntry.price,
            exitTime: candleTime,
            exitAction: result.action as "exit" | "stop_loss" | "take_profit",
            exitReason: result.reason ?? "",
            pnlPer100: Math.round(((result.pnl ?? 0) / activeEntry.shares * 100) * 100) / 100,
          });
          activeEntry = null;
        }
      }

      rejectedEvents.push(...getTaiyoCandidateBAuditEventsForTest()
        .filter(event => event.event === "confirmation_rejected" || event.event === "engine_rejected")
        .map(event => ({
          tradeDate: event.tradeDate,
          candleTime: event.candleTime,
          event: event.event,
          side: event.side,
          triggerTime: event.triggerTime,
          rejectionCodes: event.rejectionCodes ?? null,
          detail: event.detail ?? null,
        })));
    }

    expect(actualTrades).toEqual(TAIYO_CANDIDATE_B_EXPECTED_TRADES);
    expect(processedRows).toBe(TAIYO_CANDIDATE_B_EXPECTED_SUMMARY.sourceRows);
    expect(actualTrades.filter(trade => trade.route === "primary")).toHaveLength(TAIYO_CANDIDATE_B_EXPECTED_SUMMARY.primaryTrades);
    expect(actualTrades.filter(trade => trade.route === "afternoon_short")).toHaveLength(TAIYO_CANDIDATE_B_EXPECTED_SUMMARY.afternoonShortTrades);
    expect(actualTrades.filter(trade => trade.pnlPer100 > 0)).toHaveLength(TAIYO_CANDIDATE_B_EXPECTED_SUMMARY.wins);
    expect(actualTrades.filter(trade => trade.pnlPer100 < 0)).toHaveLength(TAIYO_CANDIDATE_B_EXPECTED_SUMMARY.losses);
    expect(Math.round(actualTrades.reduce((sum, trade) => sum + trade.pnlPer100, 0) * 100) / 100)
      .toBe(TAIYO_CANDIDATE_B_EXPECTED_SUMMARY.pnlPer100);
    expect(rejectedEvents).toHaveLength(TAIYO_CANDIDATE_B_EXPECTED_SUMMARY.confirmationRejected);
    expect(rejectedEvents.filter(event => event.event === "engine_rejected"))
      .toHaveLength(TAIYO_CANDIDATE_B_EXPECTED_SUMMARY.engineRejectedWithoutCapitalLimit);
    expect(vi.mocked(upsertTaiyoCandidateBEvent))
      .toHaveBeenCalledTimes(TAIYO_CANDIDATE_B_EXPECTED_SUMMARY.confirmationRejected);
    expect(createHash("sha256").update(JSON.stringify(rejectedEvents)).digest("hex"))
      .toBe(TAIYO_CANDIDATE_B_REJECTION_STREAM_SHA256);

    const recentFive = actualTrades.filter(trade => TAIYO_CANDIDATE_B_EXPECTED_SUMMARY.recentFiveDates.includes(trade.date));
    expect(recentFive).toHaveLength(TAIYO_CANDIDATE_B_EXPECTED_SUMMARY.recentFiveTrades);
    expect(recentFive.filter(trade => trade.pnlPer100 > 0)).toHaveLength(TAIYO_CANDIDATE_B_EXPECTED_SUMMARY.recentFiveWins);
    expect(recentFive.filter(trade => trade.pnlPer100 < 0)).toHaveLength(TAIYO_CANDIDATE_B_EXPECTED_SUMMARY.recentFiveLosses);
    expect(Math.round(recentFive.reduce((sum, trade) => sum + trade.pnlPer100, 0) * 100) / 100)
      .toBe(TAIYO_CANDIDATE_B_EXPECTED_SUMMARY.recentFivePnlPer100);
  }, 90_000);

  it("候補Bポジションでは板読み早期利確を使用しない", () => {
    expect(shouldBoardEarlyExit({
      symbol: "6976", side: "long", entryPrice: 10_000, shares: 100, entryTime: "10:00",
      entryReason: "太陽誘電候補BLONG: 監査テスト",
    }, 10_010, {
      buyPressureRatio: 0.5, largeBuyWall: false, largeSellWall: false,
      marketOrderRatio: 0, signal: "sell_pressure",
    })).toBe(false);
  });

  it("証拠金拒否は日次枠を消費せず、解放後の後続候補へ再探索する", async () => {
    const tradeDate = "2099-01-01";
    await feedFlatPrefix(tradeDate);
    restoreOpenPositions([{
      symbol: "285A", side: "long", price: 8_800_000, shares: 1,
      tradeTime: "09:30", reason: "候補B証拠金再探索テスト用",
    }]);

    await processCandle({ symbol: "6976", tradeDate, candleTime: "09:45", open: 100.1, high: 101.2, low: 100, close: 101, volume: 100 });
    const blocked = await processCandle({ symbol: "6976", tradeDate, candleTime: "09:46", open: 101, high: 101.6, low: 100.9, close: 101.5, volume: 100 });
    expect(blocked).toMatchObject({ action: "none", reason: "margin_block" });

    await forceCloseAllPositions(tradeDate, new Map([["285A", 8_800_000]]));
    await processCandle({ symbol: "6976", tradeDate, candleTime: "09:47", open: 101.5, high: 102.1, low: 101.4, close: 102, volume: 100 });
    const accepted = await processCandle({ symbol: "6976", tradeDate, candleTime: "09:48", open: 102, high: 102.6, low: 101.9, close: 102.5, volume: 100 });
    expect(accepted.action).toBe("entry");
    expect(accepted.reason).toContain("太陽誘電候補BLONG");

    const events = getTaiyoCandidateBAuditEventsForTest();
    expect(events.some(event => event.event === "engine_rejected" && event.detail === "margin_block")).toBe(true);
    expect(vi.mocked(upsertTaiyoCandidateBEvent)).toHaveBeenCalledWith(expect.objectContaining({
      tradeDate,
      candleTime: "09:46",
      eventType: "engine_rejected",
      detail: "margin_block",
      triggerTime: "09:45",
      referencePrice: "101.5",
    }));
    expect(events.filter(event => event.event === "entry")).toHaveLength(1);
    await processCandle({ symbol: "6976", tradeDate, candleTime: "09:49", open: 102.5, high: 104, low: 102.4, close: 103.5, volume: 100 });
  });

  it("ATR拒否も日次枠を消費せず、ボラティリティ回復後の後続候補へ再探索する", async () => {
    const tradeDate = "2099-01-02";
    await feedFlatPrefix(tradeDate, true);
    await processCandle({ symbol: "6976", tradeDate, candleTime: "09:45", open: 100.4, high: 100.51, low: 100.39, close: 100.5, volume: 100 });
    const blocked = await processCandle({ symbol: "6976", tradeDate, candleTime: "09:46", open: 100.5, high: 100.61, low: 100.49, close: 100.6, volume: 100 });
    expect(blocked.action).toBe("none");
    expect(blocked.reason).toMatch(/^atr_block:/);

    await processCandle({ symbol: "6976", tradeDate, candleTime: "09:47", open: 100.6, high: 101, low: 100.2, close: 100.7, volume: 100 });
    const accepted = await processCandle({ symbol: "6976", tradeDate, candleTime: "09:48", open: 100.7, high: 101.1, low: 100.3, close: 100.8, volume: 100 });
    expect(accepted.action).toBe("entry");
    expect(accepted.reason).toContain("太陽誘電候補BLONG");
    expect(getTaiyoCandidateBAuditEventsForTest().some(
      event => event.event === "engine_rejected" && event.detail?.startsWith("atr_block:"),
    )).toBe(true);
    expect(vi.mocked(upsertTaiyoCandidateBEvent)).toHaveBeenCalledWith(expect.objectContaining({
      tradeDate,
      candleTime: "09:46",
      eventType: "engine_rejected",
      triggerTime: "09:45",
      referencePrice: "100.6",
    }));
    await processCandle({ symbol: "6976", tradeDate, candleTime: "09:49", open: 100.8, high: 102, low: 100.7, close: 101.8, volume: 100 });
  });
});
