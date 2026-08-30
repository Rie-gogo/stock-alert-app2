import mysql from "mysql2/promise";
import { describe, expect, it, vi } from "vitest";

const BASELINE_SYMBOLS = ["285A", "8035", "5803", "6981", "6976", "6857", "6146", "6526", "3436"] as const;
const ALL_SYMBOLS = [...BASELINE_SYMBOLS, "9984"] as const;

type Snapshot = {
  buyPressureRatio?: number;
  marketOrderRatio?: number;
  marketOrderDirection?: "buy" | "sell" | "neutral";
  signal?: "buy_pressure" | "sell_pressure" | "large_buy_wall" | "large_sell_wall" | "market_surge" | "neutral";
  [key: string]: unknown;
};
type SourceRow = {
  id: number; symbol: string; tradeDate: string; candleTime: string;
  open: string | number; high: string | number; low: string | number; close: string | number;
  volume: number; boardSnapshot: Snapshot | string | null;
};
type Trade = {
  symbol: string; date: string; entryTime: string; exitTime: string;
  side: "long" | "short"; reason: string; pnl: number;
};

let currentSnapshot: Snapshot | null = null;
function parseSnapshot(raw: SourceRow["boardSnapshot"]): Snapshot | null {
  if (!raw) return null;
  if (typeof raw === "string") {
    try { return JSON.parse(raw) as Snapshot; } catch { return null; }
  }
  return raw;
}
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
  upsertSocionextConfirmedLongEvent: vi.fn().mockResolvedValue(undefined),
  upsertSumcoBreakdownShortEvent: vi.fn().mockResolvedValue(undefined),
  upsertSoftbankBreakoutLongEvent: vi.fn().mockResolvedValue(undefined),
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

import { getOpenPositions, processCandle } from "./realtimeSimEngine";

const sourceAuditIt = process.env.RUN_SOFTBANK_PORTFOLIO_SOURCE_AUDIT === "1" ? it : it.skip;

describe("9984専用LONG 10銘柄保存ID順ソース監査", () => {
  async function replay(rows: SourceRow[]) {
    const active = new Map<string, Omit<Trade, "exitTime" | "pnl">>();
    const trades: Trade[] = [];
    const marginBlocks: Array<{ date: string; time: string; symbol: string }> = [];
    for (const row of rows) {
      currentSnapshot = parseSnapshot(row.boardSnapshot);
      const result = await processCandle({
        symbol: row.symbol, tradeDate: row.tradeDate, candleTime: row.candleTime,
        open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close), volume: Number(row.volume),
      });
      if (result.action === "entry") {
        const position = getOpenPositions().find(item => item.symbol === row.symbol);
        if (!position) throw new Error(`position missing ${row.symbol} ${row.tradeDate} ${row.candleTime}`);
        active.set(row.symbol, { symbol: row.symbol, date: row.tradeDate, entryTime: row.candleTime, side: position.side, reason: position.entryReason });
      } else if (result.action !== "none") {
        const entry = active.get(row.symbol);
        if (entry && typeof result.pnl === "number") {
          trades.push({ ...entry, exitTime: row.candleTime, pnl: result.pnl });
          active.delete(row.symbol);
        }
      } else if (result.reason === "margin_block") {
        marginBlocks.push({ date: row.tradeDate, time: row.candleTime, symbol: row.symbol });
      }
    }
    return { trades, marginBlocks };
  }

  sourceAuditIt("現行9銘柄と9984追加10銘柄を比較し、統合期待値と資金競合を固定する", async () => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required");
    const connection = await mysql.createConnection(process.env.DATABASE_URL);
    const allRows: SourceRow[] = [];
    for (const symbol of ALL_SYMBOLS) {
      const [rawRows] = await connection.query(`
        SELECT c.id, c.symbol, c.tradeDate, c.candleTime,
               c.open, c.high, c.low, c.close, c.volume, c.boardSnapshot
        FROM rt_candles c
        INNER JOIN (
          SELECT tradeDate, candleTime, MAX(id) AS maxId
          FROM rt_candles
          WHERE symbol = ? AND tradeDate <= '2026-08-28'
          GROUP BY tradeDate, candleTime
        ) latest ON latest.maxId = c.id
      `, [symbol]);
      allRows.push(...(rawRows as SourceRow[]));
    }
    await connection.end();
    allRows.sort((a, b) => a.tradeDate.localeCompare(b.tradeDate) || a.id - b.id);
    const baselineRows = allRows.filter(row => row.symbol !== "9984");

    expect(baselineRows).toHaveLength(117_568);
    expect(allRows).toHaveLength(131_921);

    const baseline = await replay(baselineRows);
    const candidate = await replay(allRows);
    const candidateExisting = candidate.trades.filter(trade => trade.symbol !== "9984");
    const softbankTrades = candidate.trades.filter(trade => trade.symbol === "9984");

    expect(baseline.trades).toHaveLength(249);
    expect(baseline.trades.filter(trade => trade.pnl > 0)).toHaveLength(200);
    expect(baseline.trades.filter(trade => trade.pnl < 0)).toHaveLength(49);
    expect(baseline.trades.reduce((sum, trade) => sum + trade.pnl, 0)).toBe(4_589_426);

    expect(softbankTrades).toHaveLength(22);
    expect(softbankTrades.filter(trade => trade.pnl > 0)).toHaveLength(20);
    expect(softbankTrades.filter(trade => trade.pnl < 0)).toHaveLength(2);
    expect(softbankTrades.reduce((sum, trade) => sum + trade.pnl, 0)).toBe(101_809);
    expect(candidate.trades).toHaveLength(270);
    expect(candidate.trades.filter(trade => trade.pnl > 0)).toHaveLength(220);
    expect(candidate.trades.filter(trade => trade.pnl < 0)).toHaveLength(50);
    expect(candidate.trades.reduce((sum, trade) => sum + trade.pnl, 0)).toBe(4_726_287);

    expect(candidateExisting).toHaveLength(248);
    expect(candidateExisting.filter(trade => trade.pnl > 0)).toHaveLength(200);
    expect(candidateExisting.filter(trade => trade.pnl < 0)).toHaveLength(48);
    expect(candidateExisting.reduce((sum, trade) => sum + trade.pnl, 0)).toBe(4_624_478);
    expect(candidate.marginBlocks.filter(block => block.symbol === "9984").length).toBeGreaterThan(0);
  }, 300_000);
});
