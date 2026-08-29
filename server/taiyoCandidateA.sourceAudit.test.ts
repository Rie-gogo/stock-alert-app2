import { describe, expect, it, vi } from "vitest";

type Snapshot = {
  buyPressureRatio?: number;
  marketOrderRatio?: number;
  marketOrderDirection?: "buy" | "sell" | "neutral";
  signal?: "buy_pressure" | "sell_pressure" | "large_buy_wall" | "large_sell_wall" | "market_surge" | "neutral";
  largeBuyWall?: boolean;
  largeSellWall?: boolean;
  [key: string]: unknown;
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

vi.mock("./db", async () => {
  const actual = await vi.importActual<typeof import("./db")>("./db");
  return {
    ...actual,
    insertRtCandle: vi.fn().mockResolvedValue(undefined),
    insertRtTrade: vi.fn().mockResolvedValue(undefined),
    upsertRtDailySummary: vi.fn().mockResolvedValue(undefined),
    getRtTradesForDate: vi.fn().mockResolvedValue([]),
    getRtCandlesAllForDate: vi.fn().mockResolvedValue([]),
    getRtOpenPositionsFromDb: vi.fn().mockResolvedValue([]),
    insertScore0Block: vi.fn().mockResolvedValue(undefined),
  };
});

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

import { getRtCandles } from "./db";
import {
  getOpenPositions,
  getTaiyoCandidateAAuditEventsForTest,
  processCandle,
  setTaiyoCandidateAAuditEnabledForTest,
} from "./realtimeSimEngine";
import {
  TAIYO_CANDIDATE_A_EXPECTED_BOARD_REJECTIONS,
  TAIYO_CANDIDATE_A_EXPECTED_SUMMARY,
  TAIYO_CANDIDATE_A_EXPECTED_TRADES,
} from "./fixtures/taiyoCandidateA.expected";

const SOURCE_DATES = [
  "2026-06-17", "2026-06-18", "2026-06-19", "2026-06-22", "2026-06-23", "2026-06-24",
  "2026-06-25", "2026-06-26", "2026-06-29", "2026-06-30", "2026-07-01", "2026-07-02",
  "2026-07-03", "2026-07-06", "2026-07-07", "2026-07-08", "2026-07-09", "2026-07-10",
  "2026-07-13", "2026-07-14", "2026-07-15", "2026-07-16", "2026-07-17", "2026-07-21",
  "2026-07-22", "2026-07-23", "2026-07-24", "2026-07-27", "2026-07-28", "2026-07-30",
  "2026-07-31", "2026-08-03", "2026-08-06", "2026-08-07", "2026-08-10", "2026-08-13",
  "2026-08-14", "2026-08-17", "2026-08-18", "2026-08-19", "2026-08-20", "2026-08-21",
  "2026-08-25", "2026-08-26", "2026-08-27", "2026-08-28",
] as const;

interface AuditTrade {
  date: string;
  route: "primary" | "fallback_short";
  side: "long" | "short";
  entryTime: string;
  entryPrice: number;
  exitTime: string;
  exitAction: string;
  exitReason: string;
  pnlPer100: number;
}

interface SourceCandle {
  date: string;
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  snapshot: Snapshot | null;
}

interface SourceCandidate {
  date: string;
  triggerTime: string;
  entryTime: string;
  side: "long" | "short";
  entryPrice: number;
  bpr: number | null;
  marketOrderDirection: string;
  signal: string;
}

function sourceBoardAllows(side: "long" | "short", snapshot: Snapshot | null): boolean {
  if (!snapshot) return false;
  const bpr = Number(snapshot.buyPressureRatio ?? 1);
  const direction = snapshot.marketOrderDirection ?? "neutral";
  const signal = snapshot.signal ?? "neutral";
  if (side === "long") {
    return bpr >= 0.8 && direction !== "sell" && signal !== "sell_pressure" && signal !== "large_sell_wall";
  }
  return bpr <= 1.2 && direction !== "buy" && signal !== "buy_pressure" && signal !== "large_buy_wall";
}

function simulateSourcePrimary(days: Map<string, SourceCandle[]>, useBoard: boolean): SourceCandidate[] {
  const candidates: SourceCandidate[] = [];
  for (const [date, candles] of days) {
    for (let index = 22; index < candles.length; index++) {
      const candle = candles[index];
      if (candle.time < "09:45" || candle.time > "10:30") continue;
      const prior = candles.slice(index - 5, index);
      const prior20 = candles.slice(index - 20, index);
      const avgVolume = prior20.reduce((sum, item) => sum + item.volume, 0) / prior20.length;
      const volumeRatio = avgVolume > 0 ? candle.volume / avgVolume : 0;
      if (volumeRatio < 1.0) continue;
      const currentMa = candles.slice(index - 7, index + 1).reduce((sum, item) => sum + item.close, 0) / 8;
      const ma2Ago = candles.slice(index - 9, index - 1).reduce((sum, item) => sum + item.close, 0) / 8;
      const slope = ma2Ago > 0 ? (currentMa - ma2Ago) / ma2Ago * 100 : 0;
      const long = candle.close > candle.open && candle.close > Math.max(...prior.map(item => item.high)) && slope > 0;
      const short = candle.close < candle.open && candle.close < Math.min(...prior.map(item => item.low)) && slope < 0;
      if (!long && !short) continue;
      const side = long ? "long" : "short";
      if (useBoard && !sourceBoardAllows(side, candle.snapshot)) continue;

      const confirming = candles[index + 1];
      if (!confirming || confirming.time > "10:30") continue;
      const confirmationOk = side === "long"
        ? confirming.close > candle.close && confirming.close > confirming.open
        : confirming.close < candle.close && confirming.close < confirming.open;
      if (!confirmationOk) continue;
      const dayOpen = candles[0]?.open ?? candle.open;
      const openMovePct = dayOpen > 0 ? (confirming.close - dayOpen) / dayOpen * 100 : 0;
      const alignedOpenMovePct = side === "long" ? openMovePct : -openMovePct;
      const bodyPct = confirming.open > 0 ? Math.abs(confirming.close - confirming.open) / confirming.open * 100 : 0;
      if (alignedOpenMovePct < 1.6 || bodyPct < 0.275) continue;

      candidates.push({
        date,
        triggerTime: candle.time,
        entryTime: confirming.time,
        side,
        entryPrice: confirming.close,
        bpr: candle.snapshot?.buyPressureRatio ?? null,
        marketOrderDirection: candle.snapshot?.marketOrderDirection ?? "neutral",
        signal: candle.snapshot?.signal ?? "neutral",
      });
      break;
    }
  }
  return candidates;
}

describe("6976候補A 保存KABUソース監査", () => {
  const sourceAudit = process.env.TAIYO_CANDIDATE_A_SOURCE_AUDIT === "1" ? it : it.skip;

  sourceAudit("同一日時は最大idを採用し、46保存日を実エンジンへ時刻順投入する", async () => {
    setTaiyoCandidateAAuditEnabledForTest(true);
    const trades: AuditTrade[] = [];
    const sourceDays = new Map<string, SourceCandle[]>();
    let activeEntry: { date: string; time: string; price: number; shares: number; side: "long" | "short"; reason: string } | null = null;
    let processedRows = 0;

    for (const tradeDate of SOURCE_DATES) {
      const sourceRows = await getRtCandles("6976", tradeDate);
      const deduped = [...new Map(
        [...sourceRows]
          .sort((a, b) => Number(a.id) - Number(b.id))
          .map(row => [row.candleTime, row]),
      ).values()].sort((a, b) => a.candleTime.localeCompare(b.candleTime));
      sourceDays.set(tradeDate, deduped.map(row => ({
        date: tradeDate,
        time: row.candleTime,
        open: Number(row.open),
        high: Number(row.high),
        low: Number(row.low),
        close: Number(row.close),
        volume: row.volume,
        snapshot: (row.boardSnapshot as Snapshot | null) ?? null,
      })));

      for (const row of deduped) {
        currentSnapshot = (row.boardSnapshot as Snapshot | null) ?? null;
        const result = await processCandle({
          symbol: "6976",
          tradeDate,
          candleTime: row.candleTime,
          open: Number(row.open),
          high: Number(row.high),
          low: Number(row.low),
          close: Number(row.close),
          volume: row.volume,
        });
        processedRows++;

        if (result.action === "entry") {
          const position = getOpenPositions().find(item => item.symbol === "6976");
          expect(position).toBeDefined();
          activeEntry = {
            date: tradeDate,
            time: row.candleTime,
            price: Number(row.close),
            shares: position!.shares,
            side: position!.side,
            reason: result.reason ?? "",
          };
        } else if (result.action !== "none" && activeEntry) {
          trades.push({
            date: tradeDate,
            route: activeEntry.reason.startsWith("太陽誘電候補A") ? "primary" : "fallback_short",
            side: activeEntry.side,
            entryTime: activeEntry.time,
            entryPrice: activeEntry.price,
            exitTime: row.candleTime,
            exitAction: result.action,
            exitReason: result.reason ?? "",
            pnlPer100: Math.round(((result.pnl ?? 0) / activeEntry.shares * 100) * 100) / 100,
          });
          activeEntry = null;
        }
      }
    }

    const auditEvents = getTaiyoCandidateAAuditEventsForTest();
    const looseBoardCandidates = simulateSourcePrimary(sourceDays, true);
    const engineBoardRejections = auditEvents
      .filter(event => event.event === "trigger_rejected")
      .map(event => ({
        date: event.tradeDate,
        time: event.candleTime,
        side: event.side,
        code: event.rejectionCodes![0] as "board_missing" | "board_bpr" | "board_signal",
        detail: event.detail!,
      }));
    console.log("TAIYO_CANDIDATE_A_SOURCE_TRADES", JSON.stringify(trades));
    console.log("TAIYO_CANDIDATE_A_SOURCE_REJECTIONS", JSON.stringify(auditEvents.filter(event => event.event === "confirmation_rejected")));
    console.log("TAIYO_CANDIDATE_A_ENGINE_BOARD_REJECTIONS", JSON.stringify(engineBoardRejections));
    console.log("TAIYO_CANDIDATE_A_SOURCE_SUMMARY", JSON.stringify({
      processedRows,
      trades: trades.length,
      primary: trades.filter(trade => trade.route === "primary").length,
      fallback: trades.filter(trade => trade.route === "fallback_short").length,
      wins: trades.filter(trade => trade.pnlPer100 > 0).length,
      losses: trades.filter(trade => trade.pnlPer100 < 0).length,
      pnlPer100: Math.round(trades.reduce((sum, trade) => sum + trade.pnlPer100, 0) * 100) / 100,
      confirmationRejections: auditEvents.filter(event => event.event === "confirmation_rejected").length,
      boardTriggerRejections: auditEvents.filter(event => event.event === "trigger_rejected").length,
    }));

    expect(processedRows).toBeGreaterThan(14_000);
    expect(looseBoardCandidates).toHaveLength(16);
    expect(trades).toEqual(TAIYO_CANDIDATE_A_EXPECTED_TRADES);
    expect(engineBoardRejections).toEqual(TAIYO_CANDIDATE_A_EXPECTED_BOARD_REJECTIONS);
    expect(trades).toHaveLength(TAIYO_CANDIDATE_A_EXPECTED_SUMMARY.trades);
    setTaiyoCandidateAAuditEnabledForTest(false);
  }, 120_000);
});
