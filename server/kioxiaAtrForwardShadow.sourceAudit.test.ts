import mysql from "mysql2/promise";
import { describe, expect, it } from "vitest";
import {
  applyKioxiaAtrForwardTransition,
  emptyKioxiaAtrForwardState,
} from "./kioxiaAtrForwardShadow";

type SourceRow = {
  id: number;
  tradeDate: string;
  candleTime: string;
  open: string | number;
  high: string | number;
  low: string | number;
  close: string | number;
  volume: number;
  boardSnapshot: Record<string, unknown> | string | null;
};

const sourceAuditIt = process.env.RUN_KIOXIA_ATR_FORWARD_SOURCE_AUDIT === "1" ? it : it.skip;

describe("285A第2シャドー 保存KABU全48日ソース監査", () => {
  sourceAuditIt("最新ID重複除去15,286足からATR0.36%経路別終了候補を純粋コアで再生する", async () => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required");
    const connection = await mysql.createConnection(process.env.DATABASE_URL);
    const [rawRows] = await connection.query(`
      SELECT c.id, c.tradeDate, c.candleTime, c.open, c.high, c.low, c.close, c.volume, c.boardSnapshot
      FROM rt_candles c
      INNER JOIN (
        SELECT tradeDate, candleTime, MAX(id) AS maxId
        FROM rt_candles
        WHERE symbol = '285A' AND tradeDate <= '2026-09-03'
        GROUP BY tradeDate, candleTime
      ) latest ON latest.maxId = c.id
      ORDER BY c.tradeDate, c.id
    `);
    await connection.end();
    const rows = rawRows as SourceRow[];
    const dates = Array.from(new Set(rows.map(row => String(row.tradeDate))));
    const trades: Array<Record<string, unknown>> = [];
    const routeEndings: Array<Record<string, unknown>> = [];

    for (const originalDate of dates) {
      let state = emptyKioxiaAtrForwardState();
      state.tradeDate = "2026-09-07";
      for (const row of rows.filter(item => String(item.tradeDate) === originalDate)) {
        let snapshot: Record<string, unknown> = {};
        if (typeof row.boardSnapshot === "string") {
          try { snapshot = JSON.parse(row.boardSnapshot) as Record<string, unknown>; } catch { snapshot = {}; }
        } else if (row.boardSnapshot) {
          snapshot = row.boardSnapshot;
        }
        const close = Number(row.close);
        const input = {
          sourceEventId: `${originalDate}:${row.id}`,
          candle: {
            symbol: "285A",
            tradeDate: "2026-09-07",
            candleTime: row.candleTime,
            open: Number(row.open),
            high: Number(row.high),
            low: Number(row.low),
            close,
            volume: Number(row.volume),
          },
          // 候補選定時の実エンジンと同じcloseを比較用入口価格とし、シグナル再現だけを監査する。
          board: { ...snapshot, currentPrice: close },
        };
        const transition = applyKioxiaAtrForwardTransition(state, input, "signal_quality");
        for (const action of transition.actions) {
          if (action.type === "route_ended") routeEndings.push({ originalDate, candleTime: row.candleTime, ...action });
        }
        if (transition.closedPosition) {
          trades.push({
            originalDate,
            route: transition.closedPosition.position.route,
            side: transition.closedPosition.position.side,
            entryTime: transition.closedPosition.position.entryTime,
            exitTime: row.candleTime,
            pnl: transition.closedPosition.pnl,
            exitReason: transition.closedPosition.exitReason,
          });
        }
        state = transition.nextState;
      }
      expect(state.position).toBeNull();
    }

    const summary = {
      dates: dates.length,
      rows: rows.length,
      trades: trades.length,
      wins: trades.filter(trade => Number(trade.pnl) > 0).length,
      losses: trades.filter(trade => Number(trade.pnl) < 0).length,
      pnl: trades.reduce((sum, trade) => sum + Number(trade.pnl), 0),
      atrRouteEndings: routeEndings.filter(item => item.reason === "atr_below_036").length,
    };
    console.log("KIOXIA_ATR_FORWARD_SOURCE_AUDIT", JSON.stringify({ summary, trades, routeEndings }));
    expect({ dates: summary.dates, rows: summary.rows }).toEqual({ dates: 48, rows: 15_286 });
    expect(summary).toEqual({
      dates: 48,
      rows: 15_286,
      trades: 56,
      wins: 42,
      losses: 14,
      // 候補選定時+2,812,107円との差-8,432円は、6/24の窓下げをSL線ではなく不利な当足始値で約定するため。
      pnl: 2_803_675,
      atrRouteEndings: 27,
    });
  }, 180_000);
});
