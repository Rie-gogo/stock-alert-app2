import mysql from "mysql2/promise";
import { describe, expect, it, vi } from "vitest";

const ACTIVE_SYMBOLS = ["285A", "8035", "5803", "6981", "6976", "6857", "6146"] as const;
let currentSnapshot: Snapshot | null = null;

type Snapshot = {
  buyPressureRatio?: number;
  marketOrderRatio?: number;
  marketOrderDirection?: "buy" | "sell" | "neutral";
  signal?: "buy_pressure" | "sell_pressure" | "large_buy_wall" | "large_sell_wall" | "market_surge" | "neutral";
  largeBuyWall?: boolean;
  largeSellWall?: boolean;
  [key: string]: unknown;
};

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

vi.mock("./threePeakDetector", () => ({
  processThreePeakCandle: vi.fn().mockResolvedValue(undefined),
  resetThreePeakState: vi.fn(),
  resetThreePeakStateForTest: vi.fn(),
}));

import {
  getOpenPositions,
  processCandle,
  setTaiyoCandidateAAuditEnabledForTest,
} from "./realtimeSimEngine";
import { TAIYO_CANDIDATE_A_PORTFOLIO_SOURCE_EXPECTATIONS } from "./fixtures/taiyoCandidateA.expected";

interface SourceRow {
  id: number;
  symbol: string;
  tradeDate: string;
  candleTime: string;
  open: string | number;
  high: string | number;
  low: string | number;
  close: string | number;
  volume: number;
  boardSnapshot: Snapshot | string | null;
}

interface ActiveTrade {
  symbol: string;
  date: string;
  entryTime: string;
  side: "long" | "short";
  reason: string;
}

function parseSnapshot(raw: SourceRow["boardSnapshot"]): Snapshot | null {
  if (!raw) return null;
  if (typeof raw === "string") {
    try { return JSON.parse(raw) as Snapshot; } catch { return null; }
  }
  return raw;
}

describe("6976候補A 7銘柄保存ID受信順ソース監査", () => {
  const sourceAudit = process.env.TAIYO_CANDIDATE_A_PORTFOLIO_AUDIT === "1" ? it : it.skip;

  sourceAudit("46保存日を保存ID順・本番資金制約・可変株数で統合再生する", async () => {
    const candidateEnabled = process.env.TAIYO_CANDIDATE_A_PORTFOLIO_SCENARIO === "candidate";
    setTaiyoCandidateAAuditEnabledForTest(candidateEnabled);

    const connection = await mysql.createConnection(process.env.DATABASE_URL!);
    const placeholders = ACTIVE_SYMBOLS.map(() => "?").join(",");
    const [rawRows] = await connection.query(`
      SELECT c.id, c.symbol, c.tradeDate, c.candleTime,
             c.open, c.high, c.low, c.close, c.volume, c.boardSnapshot
      FROM rt_candles c
      INNER JOIN (
        SELECT symbol, tradeDate, candleTime, MAX(id) AS maxId
        FROM rt_candles
        WHERE symbol IN (${placeholders})
        GROUP BY symbol, tradeDate, candleTime
      ) latest ON latest.maxId = c.id
      ORDER BY c.tradeDate, c.id
    `, [...ACTIVE_SYMBOLS]);
    await connection.end();

    const rows = rawRows as SourceRow[];
    const active = new Map<string, ActiveTrade>();
    const trades: Array<ActiveTrade & { exitTime: string; pnl: number }> = [];
    let currentDate = "";

    for (const row of rows) {
      if (row.tradeDate !== currentDate) {
        active.clear();
        currentDate = row.tradeDate;
      }
      currentSnapshot = parseSnapshot(row.boardSnapshot);
      const result = await processCandle({
        symbol: row.symbol,
        tradeDate: row.tradeDate,
        candleTime: row.candleTime,
        open: Number(row.open),
        high: Number(row.high),
        low: Number(row.low),
        close: Number(row.close),
        volume: Number(row.volume),
      });

      if (result.action === "entry") {
        const position = getOpenPositions().find(item => item.symbol === row.symbol);
        expect(position).toBeDefined();
        active.set(row.symbol, {
          symbol: row.symbol,
          date: row.tradeDate,
          entryTime: row.candleTime,
          side: position!.side,
          reason: position!.entryReason,
        });
      } else if (["exit", "stop_loss", "take_profit", "forced_close"].includes(result.action)) {
        const opened = active.get(row.symbol);
        if (opened) {
          trades.push({ ...opened, exitTime: row.candleTime, pnl: Number(result.pnl ?? 0) });
          active.delete(row.symbol);
        }
      }
    }

    const bySymbol = Object.fromEntries(ACTIVE_SYMBOLS.map(symbol => {
      const list = trades.filter(trade => trade.symbol === symbol);
      return [symbol, {
        trades: list.length,
        wins: list.filter(trade => trade.pnl > 0).length,
        losses: list.filter(trade => trade.pnl < 0).length,
        pnl: list.reduce((sum, trade) => sum + trade.pnl, 0),
      }];
    }));
    const result = {
      scenario: candidateEnabled ? "candidate" : "baseline",
      order: "tradeDate_then_saved_id",
      processedRows: rows.length,
      trades: trades.length,
      wins: trades.filter(trade => trade.pnl > 0).length,
      losses: trades.filter(trade => trade.pnl < 0).length,
      pnl: trades.reduce((sum, trade) => sum + trade.pnl, 0),
      bySymbol,
    };
    console.log("TAIYO_CANDIDATE_A_PORTFOLIO_SOURCE", JSON.stringify(result));
    const expectedScenario = candidateEnabled
      ? TAIYO_CANDIDATE_A_PORTFOLIO_SOURCE_EXPECTATIONS.candidate
      : TAIYO_CANDIDATE_A_PORTFOLIO_SOURCE_EXPECTATIONS.baseline;
    expect(result).toEqual({
      scenario: candidateEnabled ? "candidate" : "baseline",
      order: TAIYO_CANDIDATE_A_PORTFOLIO_SOURCE_EXPECTATIONS.order,
      processedRows: TAIYO_CANDIDATE_A_PORTFOLIO_SOURCE_EXPECTATIONS.processedRows,
      ...expectedScenario,
    });
    setTaiyoCandidateAAuditEnabledForTest(false);
  }, 180_000);
});
