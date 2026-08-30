import mysql from "mysql2/promise";
import { describe, expect, it, vi } from "vitest";

const BASELINE_SYMBOLS = ["285A", "8035", "5803", "6981", "6976", "6857", "6146"] as const;
const ALL_SYMBOLS = [...BASELINE_SYMBOLS, "6526"] as const;

type Snapshot = {
  buyPressureRatio?: number;
  marketOrderRatio?: number;
  marketOrderDirection?: "buy" | "sell" | "neutral";
  signal?: "buy_pressure" | "sell_pressure" | "large_buy_wall" | "large_sell_wall" | "market_surge" | "neutral";
  [key: string]: unknown;
};
type SourceRow = {
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
};
type Trade = {
  symbol: string;
  date: string;
  entryTime: string;
  exitTime: string;
  side: "long" | "short";
  reason: string;
  pnl: number;
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

const sourceAuditIt = process.env.RUN_SOCIONEXT_PORTFOLIO_SOURCE_AUDIT === "1" ? it : it.skip;

describe("6526確認型LONG 8銘柄保存ID順ソース監査", () => {
  async function replay(rows: SourceRow[]) {
    const active = new Map<string, Omit<Trade, "exitTime" | "pnl">>();
    const trades: Trade[] = [];
    const marginBlocks: Array<{ date: string; time: string; symbol: string }> = [];

    for (const row of rows) {
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
        if (!position) throw new Error(`position missing ${row.symbol} ${row.tradeDate} ${row.candleTime}`);
        active.set(row.symbol, {
          symbol: row.symbol,
          date: row.tradeDate,
          entryTime: row.candleTime,
          side: position.side,
          reason: position.entryReason,
        });
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

  sourceAuditIt("現行7銘柄と6526追加8銘柄を比較し、既存7銘柄全取引が完全一致する", async () => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required");
    const connection = await mysql.createConnection(process.env.DATABASE_URL);
    const placeholders = ALL_SYMBOLS.map(() => "?").join(",");
    const [rawRows] = await connection.query(`
      SELECT c.id, c.symbol, c.tradeDate, c.candleTime,
             c.open, c.high, c.low, c.close, c.volume, c.boardSnapshot
      FROM rt_candles c
      INNER JOIN (
        SELECT symbol, tradeDate, candleTime, MAX(id) AS maxId
        FROM rt_candles
        WHERE symbol IN (${placeholders}) AND tradeDate <= '2026-08-28'
        GROUP BY symbol, tradeDate, candleTime
      ) latest ON latest.maxId = c.id
      ORDER BY c.tradeDate, c.id
    `, [...ALL_SYMBOLS]);
    await connection.end();
    const allRows = rawRows as SourceRow[];
    const baselineRows = allRows.filter(row => row.symbol !== "6526");

    expect(baselineRows).toHaveLength(93_072);
    expect(allRows).toHaveLength(108_151);

    const baseline = await replay(baselineRows);
    const candidate = await replay(allRows);
    const candidateExisting = candidate.trades.filter(trade => trade.symbol !== "6526");
    const socionextTrades = candidate.trades.filter(trade => trade.symbol === "6526");

    expect(candidateExisting).toEqual(baseline.trades);
    expect(baseline.trades).toHaveLength(211);
    expect(baseline.trades.filter(trade => trade.pnl > 0)).toHaveLength(166);
    expect(baseline.trades.filter(trade => trade.pnl < 0)).toHaveLength(45);
    expect(baseline.trades.reduce((sum, trade) => sum + trade.pnl, 0)).toBe(4_127_147);

    expect(socionextTrades).toHaveLength(18);
    expect(socionextTrades.filter(trade => trade.pnl > 0)).toHaveLength(16);
    expect(socionextTrades.filter(trade => trade.pnl < 0)).toHaveLength(2);
    expect(socionextTrades.reduce((sum, trade) => sum + trade.pnl, 0)).toBe(154_386);
    expect(candidate.trades).toHaveLength(229);
    expect(candidate.trades.filter(trade => trade.pnl > 0)).toHaveLength(182);
    expect(candidate.trades.filter(trade => trade.pnl < 0)).toHaveLength(47);
    expect(candidate.trades.reduce((sum, trade) => sum + trade.pnl, 0)).toBe(4_281_533);
    expect(candidate.marginBlocks).toContainEqual({ date: "2026-07-23", time: "10:10", symbol: "6526" });
  }, 240_000);
});
