import mysql from "mysql2/promise";
import { describe, expect, it } from "vitest";
import expectedTrades from "./fixtures/telOpenDirectionBreakout.expected.json";
import {
  applyTelCurrentParityTransition,
  createEmptyTelCurrentParityState,
} from "./telCurrentParity";

type SourceRow = {
  id: number;
  tradeDate: string;
  candleTime: string;
  open: string | number;
  high: string | number;
  low: string | number;
  close: string | number;
  volume: number;
  boardSnapshot: unknown;
};

const sourceAuditIt = process.env.RUN_TEL_CURRENT_PARITY_SOURCE_AUDIT === "1" ? it : it.skip;

describe("baseline-8035-current-parity-v1 保存KABU全48日監査", () => {
  sourceAuditIt("現行8035の全35取引・経路・現行非因果価格を完全再現する", async () => {
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
    let state = createEmptyTelCurrentParityState();
    const trades: Array<Record<string, unknown>> = [];

    for (const row of rows) {
      let board = row.boardSnapshot;
      if (typeof board === "string") {
        try { board = JSON.parse(board); } catch { board = null; }
      }
      const transition = applyTelCurrentParityTransition(state, {
        sourceEventId: `historical:${row.id}`,
        candle: {
          symbol: "8035",
          tradeDate: String(row.tradeDate),
          candleTime: row.candleTime,
          open: Number(row.open),
          high: Number(row.high),
          low: Number(row.low),
          close: Number(row.close),
          volume: Number(row.volume),
        },
        board,
        marginUsedBefore: 0,
        evaluationMode: "capital_constrained",
      });
      state = transition.nextState;
      if (transition.closedPosition) {
        const position = transition.closedPosition;
        trades.push({
          date: row.tradeDate,
          entryTime: position.entryTime,
          exitTime: row.candleTime,
          side: position.side,
          entryPrice: position.entryPrice,
          pnlPer100: position.pnl / position.shares * 100,
          entryReason: position.entryReason,
          exitAction: position.exitReason === "stop_loss"
            ? "stop_loss"
            : position.exitReason === "take_profit"
              ? "take_profit"
              : "exit",
          exitReason: position.exitReason,
        });
      }
    }

    expect({ dates: dates.length, rows: rows.length }).toEqual({ dates: 48, rows: 15_697 });
    expect({
      trades: trades.length,
      wins: trades.filter(trade => Number(trade.pnlPer100) > 0).length,
      losses: trades.filter(trade => Number(trade.pnlPer100) < 0).length,
      pnlPer100: Math.round(trades.reduce((sum, trade) => sum + Number(trade.pnlPer100), 0)),
    }).toEqual({ trades: 35, wins: 27, losses: 8, pnlPer100: 867_618 });
    const normalizeRoute = (reason: unknown) => {
      const value = String(reason ?? "");
      if (value.startsWith("東京エレクトロン短期ブレイクLONG")) return "open_direction_breakout_long";
      if (value.startsWith("東京エレクトロン短期ブレイクSHORT")) return "open_direction_breakout_short";
      if (value.startsWith("順張りLONG")) return "fallback_trend_long";
      if (value.startsWith("順張りSHORT")) return "fallback_trend_short";
      return "unknown";
    };
    const normalize = (trade: Record<string, unknown>) => ({
      date: trade.date,
      entryTime: trade.entryTime,
      exitTime: trade.exitTime,
      side: trade.side,
      entryPrice: trade.entryPrice,
      pnlPer100: Math.round(Number(trade.pnlPer100)),
      route: normalizeRoute(trade.entryReason),
      exitAction: trade.exitAction,
    });
    expect(trades.map(normalize)).toEqual((expectedTrades as Array<Record<string, unknown>>).map(normalize));
  }, 180_000);
});
