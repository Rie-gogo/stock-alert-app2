import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import auditFixture from "./fixtures/taiyoCandidateA.audit.fixture.json";
import {
  TAIYO_CANDIDATE_A_EXPECTED_BOARD_REJECTIONS,
  TAIYO_CANDIDATE_A_EXPECTED_SUMMARY,
  TAIYO_CANDIDATE_A_EXPECTED_TRADES,
  TAIYO_CANDIDATE_A_FIXTURE_SHA256,
  TAIYO_CANDIDATE_A_SLIPPAGE_EXPECTATIONS,
  type TaiyoCandidateAExpectedTrade,
} from "./fixtures/taiyoCandidateA.expected";

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
type FixtureSegment = {
  purpose: "full_saved_day";
  tradeDate: string;
  candles: FixtureRow[];
};

let currentSnapshot: Snapshot | null = null;

function makeBook(snapshot: Snapshot | null) {
  if (!snapshot) return null;
  const bpr = Math.max(0.01, Number(snapshot.buyPressureRatio ?? 1));
  const ask = 10_000;
  const bid = Math.round(ask * bpr);
  return {
    bids: [{ price: 1, qty: bid }],
    asks: [{ price: 1, qty: ask }],
    underBuyQty: 0,
    overSellQty: 0,
    marketOrderBuyQty: 0,
    marketOrderSellQty: 0,
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
  getOpenPositions,
  getTaiyoCandidateAAuditEventsForTest,
  processCandle,
  setTaiyoCandidateAAuditEnabledForTest,
  shouldBoardEarlyExit,
} from "./realtimeSimEngine";

afterEach(() => {
  setTaiyoCandidateAAuditEnabledForTest(false);
  currentSnapshot = null;
});

describe("6976候補A Git fixture実エンジン監査", () => {
  it("全46日fixtureのSHA-256を生バイトで固定する", () => {
    const bytes = readFileSync(new URL("./fixtures/taiyoCandidateA.audit.fixture.json", import.meta.url));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(TAIYO_CANDIDATE_A_FIXTURE_SHA256);
  });

  it("全21取引の0.05%・0.10%約定悪化を原案と同じ片道総悪化モデルで固定する", () => {
    const summarize = (adversePct: number) => {
      const adjusted = TAIYO_CANDIDATE_A_EXPECTED_TRADES.map(
        trade => trade.pnlPer100 - trade.entryPrice * adversePct,
      );
      const wins = adjusted.filter(pnl => pnl > 0).length;
      return {
        wins,
        losses: adjusted.filter(pnl => pnl < 0).length,
        winRatePct: Math.round(wins / adjusted.length * 10_000) / 100,
        pnlPer100: Math.round(adjusted.reduce((sum, pnl) => sum + pnl, 0) * 100) / 100,
      };
    };

    expect(summarize(0.05)).toEqual(TAIYO_CANDIDATE_A_SLIPPAGE_EXPECTATIONS.adverse005Pct);
    expect(summarize(0.10)).toEqual(TAIYO_CANDIDATE_A_SLIPPAGE_EXPECTATIONS.adverse010Pct);
  });

  it("KABU由来の全46保存日・14,719足を因果順再生し、全21取引・決済理由・全19板拒否初動を厳密再現する", async () => {
    setTaiyoCandidateAAuditEnabledForTest(true);
    const actualTrades: TaiyoCandidateAExpectedTrade[] = [];
    let activeEntry: { date: string; time: string; price: number; shares: number; side: "long" | "short"; reason: string } | null = null;
    let processedRows = 0;

    expect(auditFixture.dateCount).toBe(TAIYO_CANDIDATE_A_EXPECTED_SUMMARY.dates);
    expect(auditFixture.rowCount).toBe(TAIYO_CANDIDATE_A_EXPECTED_SUMMARY.rows);

    for (const segment of auditFixture.segments as FixtureSegment[]) {
      for (const [candleTime, open, high, low, close, volume, snapshot] of segment.candles) {
        processedRows++;
        currentSnapshot = snapshot;
        const result = await processCandle({
          symbol: "6976",
          tradeDate: segment.tradeDate,
          candleTime,
          open,
          high,
          low,
          close,
          volume,
        });

        if (result.action === "entry") {
          const position = getOpenPositions().find(item => item.symbol === "6976");
          expect(position).toBeDefined();
          activeEntry = {
            date: segment.tradeDate,
            time: candleTime,
            price: close,
            shares: position!.shares,
            side: position!.side,
            reason: result.reason ?? "",
          };
        } else if (result.action !== "none" && activeEntry) {
          actualTrades.push({
            date: activeEntry.date,
            route: activeEntry.reason.startsWith("太陽誘電候補A") ? "primary" : "fallback_short",
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
    }

    const events = getTaiyoCandidateAAuditEventsForTest();
    const boardRejections = events
      .filter(event => event.event === "trigger_rejected")
      .map(event => ({
        date: event.tradeDate,
        time: event.candleTime,
        side: event.side,
        code: event.rejectionCodes![0] as "board_missing" | "board_bpr" | "board_signal",
        detail: event.detail!,
      }))
      .sort((a, b) => `${a.date}/${a.time}`.localeCompare(`${b.date}/${b.time}`));

    expect(actualTrades).toEqual(TAIYO_CANDIDATE_A_EXPECTED_TRADES);
    expect(processedRows).toBe(TAIYO_CANDIDATE_A_EXPECTED_SUMMARY.rows);
    expect(boardRejections).toEqual(TAIYO_CANDIDATE_A_EXPECTED_BOARD_REJECTIONS);
    expect(actualTrades.filter(trade => trade.route === "primary")).toHaveLength(TAIYO_CANDIDATE_A_EXPECTED_SUMMARY.primaryTrades);
    expect(actualTrades.filter(trade => trade.route === "fallback_short")).toHaveLength(TAIYO_CANDIDATE_A_EXPECTED_SUMMARY.fallbackShortTrades);
    expect(actualTrades.filter(trade => trade.pnlPer100 > 0)).toHaveLength(TAIYO_CANDIDATE_A_EXPECTED_SUMMARY.wins);
    expect(actualTrades.filter(trade => trade.pnlPer100 < 0)).toHaveLength(TAIYO_CANDIDATE_A_EXPECTED_SUMMARY.losses);
    expect(Math.round(actualTrades.reduce((sum, trade) => sum + trade.pnlPer100, 0) * 100) / 100)
      .toBe(TAIYO_CANDIDATE_A_EXPECTED_SUMMARY.pnlPer100);

    const recentFive = actualTrades.filter(trade => TAIYO_CANDIDATE_A_EXPECTED_SUMMARY.recentFiveDates.includes(trade.date));
    expect(recentFive).toHaveLength(TAIYO_CANDIDATE_A_EXPECTED_SUMMARY.recentFiveTrades);
    expect(recentFive.filter(trade => trade.pnlPer100 > 0)).toHaveLength(TAIYO_CANDIDATE_A_EXPECTED_SUMMARY.recentFiveWins);
    expect(recentFive.filter(trade => trade.pnlPer100 < 0)).toHaveLength(TAIYO_CANDIDATE_A_EXPECTED_SUMMARY.recentFiveLosses);

    const failureThenRedetect = events.some((event, index) => {
      const next = events[index + 1];
      return event.event === "confirmation_rejected"
        && next?.event === "trigger"
        && event.tradeDate === next.tradeDate
        && event.candleTime === next.candleTime;
    });
    expect(failureThenRedetect).toBe(true);
  }, 60_000);

  it("通常モードは同じ保存足でも候補Aを発火せず、現行6976経路のままである", async () => {
    setTaiyoCandidateAAuditEnabledForTest(false);
    const segment = (auditFixture.segments as FixtureSegment[]).find(item => item.tradeDate === "2026-08-28")!;
    const actions: Array<{ action: string; reason?: string }> = [];
    for (const [candleTime, open, high, low, close, volume, snapshot] of segment.candles) {
      currentSnapshot = snapshot;
      const result = await processCandle({
        symbol: "6976",
        tradeDate: segment.tradeDate,
        candleTime,
        open,
        high,
        low,
        close,
        volume,
      });
      if (result.action !== "none") actions.push({ action: result.action, reason: result.reason });
    }

    expect(actions.some(item => item.reason?.startsWith("太陽誘電候補A"))).toBe(false);
    expect(getTaiyoCandidateAAuditEventsForTest()).toEqual([]);
  });

  it("候補Aポジションでは原案どおり板読み早期利確を無効化する", () => {
    const candidatePosition = {
      symbol: "6976",
      side: "long" as const,
      entryPrice: 10_000,
      shares: 100,
      entryTime: "10:00",
      entryReason: "太陽誘電候補ALONG: 監査テスト",
    };
    const adverseBoard = {
      buyPressureRatio: 0.5,
      largeBuyWall: false,
      largeSellWall: false,
      marketOrderRatio: 0,
      signal: "sell_pressure" as const,
    };
    expect(shouldBoardEarlyExit(candidatePosition, 10_010, adverseBoard)).toBe(false);
  });
});
