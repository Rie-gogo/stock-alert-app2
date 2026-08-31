import mysql from "mysql2/promise";
import { describe, expect, it, vi } from "vitest";
import expectedTrades from "./fixtures/kioxiaShortGuards.expected.json";
import expectedAuditEvents from "./fixtures/kioxiaShortGuards.auditEvents.json";

type Snapshot = {
  buyPressureRatio?: number;
  marketOrderRatio?: number;
  marketOrderDirection?: "buy" | "sell" | "neutral";
  signal?: "buy_pressure" | "sell_pressure" | "large_buy_wall" | "large_sell_wall" | "market_surge" | "neutral";
  [key: string]: unknown;
};
type SourceRow = {
  id: number; tradeDate: string; candleTime: string;
  open: string | number; high: string | number; low: string | number; close: string | number;
  volume: number; boardSnapshot: Snapshot | string | null;
};

let currentSnapshot: Snapshot | null = null;
function makeBook(snapshot: Snapshot | null) {
  if (!snapshot) return null;
  const ask = 10_000;
  return {
    bids: [{ price: 1, qty: Math.round(ask * Math.max(0.01, Number(snapshot.buyPressureRatio ?? 1))) }],
    asks: [{ price: 1, qty: ask }],
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
  upsertKioxiaShortGuardEvent: vi.fn().mockResolvedValue(undefined),
  getKioxiaShortGuardEventsForDate: vi.fn().mockResolvedValue([]),
}));
vi.mock("./kabuStation", () => ({
  getOrderBook: vi.fn(() => makeBook(currentSnapshot)),
  analyzeOrderBook: vi.fn().mockReturnValue([]),
  calcExtendedBoardFields: vi.fn(() => currentSnapshot ?? {}),
  getAggregatedBoardStats: vi.fn().mockReturnValue(null),
  clearBoardRingBuffer: vi.fn(),
}));
vi.mock("../shared/stocks", () => ({
  getStockName: vi.fn().mockReturnValue("キオクシアHD"),
  TARGET_STOCKS: [{ symbol: "285A", ticker: "285A.T", name: "キオクシアHD", basePrice: 50000, sector: "半導体" }],
  TRADE_EXCLUDED_SYMBOLS: new Set([]),
  ACTIVE_ENTRY_SYMBOLS: new Set(["285A"]),
}));

import { getKioxiaShortGuardAuditEventsForTest, getOpenPositions, processCandle } from "./realtimeSimEngine";

const sourceAuditIt = process.env.RUN_KIOXIA_SHORT_GUARD_SOURCE_AUDIT === "1" ? it : it.skip;

describe("285A両SHORTガード 保存KABU全45日ソース監査", () => {
  sourceAuditIt("最新ID重複除去14,278足から全72取引・4件の当日終了を再現する", async () => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required");
    if (process.env.KIOXIA_SHORT_GUARD_AUDIT_NO_MARGIN !== "1") {
      throw new Error("KIOXIA_SHORT_GUARD_AUDIT_NO_MARGIN=1 required");
    }
    const connection = await mysql.createConnection(process.env.DATABASE_URL);
    const [rawRows] = await connection.query(`
      SELECT c.id, c.tradeDate, c.candleTime, c.open, c.high, c.low, c.close, c.volume, c.boardSnapshot
      FROM rt_candles c
      INNER JOIN (
        SELECT tradeDate, candleTime, MAX(id) AS maxId
        FROM rt_candles
        WHERE symbol = '285A' AND tradeDate <= '2026-08-31'
        GROUP BY tradeDate, candleTime
      ) latest ON latest.maxId = c.id
      ORDER BY c.tradeDate, c.id
    `);
    await connection.end();
    const rows = rawRows as SourceRow[];
    const dates = Array.from(new Set(rows.map(row => String(row.tradeDate))));
    const trades: Array<Record<string, unknown>> = [];
    const auditEvents: Array<Record<string, unknown>> = [];
    let active: { date: string; time: string; side: string; entryPrice: number; shares: number; reason: string } | null = null;

    for (const tradeDate of dates) {
      for (const row of rows.filter(item => String(item.tradeDate) === tradeDate)) {
        if (typeof row.boardSnapshot === "string") {
          try { currentSnapshot = JSON.parse(row.boardSnapshot) as Snapshot; } catch { currentSnapshot = null; }
        } else {
          currentSnapshot = row.boardSnapshot ?? null;
        }
        const result = await processCandle({
          symbol: "285A", tradeDate, candleTime: row.candleTime,
          open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close), volume: Number(row.volume),
        });
        if (result.action === "entry") {
          const position = getOpenPositions().find(item => item.symbol === "285A");
          if (!position) throw new Error(`entry missing ${tradeDate} ${row.candleTime}`);
          active = { date: tradeDate, time: row.candleTime, side: position.side, entryPrice: position.entryPrice, shares: position.shares, reason: position.entryReason };
        } else if (result.action !== "none" && active && typeof result.pnl === "number") {
          trades.push({
            date: active.date, entryTime: active.time, exitTime: row.candleTime,
            side: active.side, entryPrice: active.entryPrice,
            pnlPer100: result.pnl / active.shares * 100,
            entryReason: active.reason, exitAction: result.action, exitReason: result.reason,
          });
          active = null;
        }
      }
      auditEvents.push(...getKioxiaShortGuardAuditEventsForTest().map(event => ({
        tradeDate: event.tradeDate, candleTime: event.candleTime, guardType: event.guardType,
        observedValue: event.observedValue, thresholdValue: event.thresholdValue,
        averageVolume: event.averageVolume ?? null, zeroVolumeBars: event.zeroVolumeBars,
        referencePrice: event.referencePrice,
      })));
    }

    expect({ dates: dates.length, rows: rows.length }).toEqual({ dates: 45, rows: 14_278 });
    expect({
      trades: trades.length,
      wins: trades.filter(trade => Number(trade.pnlPer100) > 0).length,
      losses: trades.filter(trade => Number(trade.pnlPer100) < 0).length,
      draws: trades.filter(trade => Number(trade.pnlPer100) === 0).length,
      pnlPer100: trades.reduce((sum, trade) => sum + Number(trade.pnlPer100), 0),
    }).toEqual({ trades: 72, wins: 55, losses: 16, draws: 1, pnlPer100: 2_610_703 });
    expect(trades).toEqual(expectedTrades);
    expect(auditEvents).toEqual(expectedAuditEvents);
  }, 180_000);
});
