import { createHash } from "node:crypto";
import mysql from "mysql2/promise";
import { describe, expect, it, vi } from "vitest";
import expectedTrades from "./fixtures/telOpenDirectionBreakout.expected.json";

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
  upsertKioxiaConfirmedMorningLongEvent: vi.fn().mockResolvedValue(undefined),
  upsertTelOpenDirectionBreakoutEvent: vi.fn().mockResolvedValue(undefined),
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
  getStockName: vi.fn().mockReturnValue("東京エレクトロン"),
  TARGET_STOCKS: [{ symbol: "8035", ticker: "8035.T", name: "東京エレクトロン", basePrice: 70_000, sector: "半導体" }],
  TRADE_EXCLUDED_SYMBOLS: new Set([]),
  ACTIVE_ENTRY_SYMBOLS: new Set(["8035"]),
}));

import { getOpenPositions, processCandle } from "./realtimeSimEngine";

const sourceAuditIt = process.env.RUN_TEL_OPEN_DIRECTION_SOURCE_AUDIT === "1" ? it : it.skip;

describe("8035始値方向付き短期ブレイク 保存KABU全48日ソース監査", () => {
  sourceAuditIt("最新ID重複除去15,697足から全35取引を完全再現する", async () => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required");
    const connection = await mysql.createConnection(process.env.DATABASE_URL);
    const [rawRows] = await connection.query(`
      SELECT c.id, c.tradeDate, c.candleTime, c.open, c.high, c.low, c.close, c.volume, c.boardSnapshot
      FROM rt_candles c
      INNER JOIN (
        SELECT tradeDate, candleTime, MAX(id) AS maxId
        FROM rt_candles
        WHERE symbol = '8035' AND tradeDate <= '2026-08-31'
        GROUP BY tradeDate, candleTime
      ) latest ON latest.maxId = c.id
      ORDER BY c.tradeDate, c.id
    `);
    await connection.end();
    const rows = rawRows as SourceRow[];
    const dates = Array.from(new Set(rows.map(row => String(row.tradeDate))));
    const trades: Array<Record<string, unknown>> = [];
    let active: { date: string; time: string; side: string; entryPrice: number; shares: number; reason: string } | null = null;

    for (const tradeDate of dates) {
      for (const row of rows.filter(item => String(item.tradeDate) === tradeDate)) {
        if (typeof row.boardSnapshot === "string") {
          try { currentSnapshot = JSON.parse(row.boardSnapshot) as Snapshot; } catch { currentSnapshot = null; }
        } else {
          currentSnapshot = row.boardSnapshot ?? null;
        }
        const result = await processCandle({
          symbol: "8035", tradeDate, candleTime: row.candleTime,
          open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close), volume: Number(row.volume),
        });
        if (result.action === "entry") {
          const position = getOpenPositions().find(item => item.symbol === "8035");
          if (!position) throw new Error(`entry missing ${tradeDate} ${row.candleTime}`);
          active = { date: tradeDate, time: row.candleTime, side: position.side, entryPrice: position.entryPrice, shares: position.shares, reason: position.entryReason };
        } else if (result.action !== "none" && active && typeof result.pnl === "number") {
          trades.push({
            date: active.date,
            entryTime: active.time,
            exitTime: row.candleTime,
            side: active.side,
            entryPrice: active.entryPrice,
            pnlPer100: result.pnl / active.shares * 100,
            entryReason: active.reason,
            exitAction: result.action,
            exitReason: result.reason,
          });
          active = null;
        }
      }
    }

    expect({ dates: dates.length, rows: rows.length }).toEqual({ dates: 48, rows: 15_697 });
    expect({
      trades: trades.length,
      wins: trades.filter(trade => Number(trade.pnlPer100) > 0).length,
      losses: trades.filter(trade => Number(trade.pnlPer100) < 0).length,
      pnlPer100: trades.reduce((sum, trade) => sum + Number(trade.pnlPer100), 0),
    }).toEqual({ trades: 35, wins: 27, losses: 8, pnlPer100: 867_618 });

    const canonicalTrades = `${JSON.stringify(trades, null, 2)}\n`;
    expect(createHash("sha256").update(canonicalTrades).digest("hex"))
      .toBe("c1721e574d47dfdf89c3e08752390d317da3fdbbc771cb953244201d19c41330");
    expect(trades).toEqual(expectedTrades);

    const primaryLong = trades.filter(trade => String(trade.entryReason).startsWith("東京エレクトロン短期ブレイクLONG"));
    const primaryShort = trades.filter(trade => String(trade.entryReason).startsWith("東京エレクトロン短期ブレイクSHORT"));
    const fallbackLong = trades.filter(trade => String(trade.entryReason).startsWith("順張りLONG"));
    const fallbackShort = trades.filter(trade => String(trade.entryReason).startsWith("順張りSHORT"));
    const peakReversal = trades.filter(trade => String(trade.entryReason).startsWith("高値反転SHORT"));
    expect({
      primaryLong: { trades: primaryLong.length, wins: primaryLong.filter(trade => Number(trade.pnlPer100) > 0).length },
      primaryShort: { trades: primaryShort.length, wins: primaryShort.filter(trade => Number(trade.pnlPer100) > 0).length },
      fallbackLong: { trades: fallbackLong.length, wins: fallbackLong.filter(trade => Number(trade.pnlPer100) > 0).length },
      fallbackShort: { trades: fallbackShort.length, wins: fallbackShort.filter(trade => Number(trade.pnlPer100) > 0).length },
      peakReversal: peakReversal.length,
    }).toEqual({
      primaryLong: { trades: 19, wins: 14 },
      primaryShort: { trades: 13, wins: 10 },
      fallbackLong: { trades: 1, wins: 1 },
      fallbackShort: { trades: 2, wins: 2 },
      peakReversal: 0,
    });

    const recentFiveDates = new Set(["2026-08-21", "2026-08-26", "2026-08-27", "2026-08-28", "2026-08-31"]);
    const recentFive = trades.filter(trade => recentFiveDates.has(String(trade.date)));
    expect({
      trades: recentFive.length,
      wins: recentFive.filter(trade => Number(trade.pnlPer100) > 0).length,
      losses: recentFive.filter(trade => Number(trade.pnlPer100) < 0).length,
      pnlPer100: recentFive.reduce((sum, trade) => sum + Number(trade.pnlPer100), 0),
    }).toEqual({ trades: 3, wins: 2, losses: 1, pnlPer100: 12_046 });
  }, 180_000);
});
