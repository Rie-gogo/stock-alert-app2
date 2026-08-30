import mysql from "mysql2/promise";
import { describe, expect, it } from "vitest";
import fixture from "./fixtures/softbankBreakoutLong.audit.fixture.json";

type Row = {
  tradeDate: string;
  candleTime: string;
  open: string | number;
  high: string | number;
  low: string | number;
  close: string | number;
  volume: number;
};

const sourceAuditIt = process.env.RUN_SOFTBANK_SOURCE_AUDIT === "1" ? it : it.skip;

describe("9984専用LONG Git fixtureソース監査", () => {
  sourceAuditIt("DBの最新ID重複除去済み44日14,353足とfixtureが完全一致する", async () => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required");
    const connection = await mysql.createConnection(process.env.DATABASE_URL);
    const [rawRows] = await connection.query(`
      SELECT c.tradeDate, c.candleTime, c.open, c.high, c.low, c.close, c.volume
      FROM rt_candles c
      INNER JOIN (
        SELECT tradeDate, candleTime, MAX(id) AS maxId
        FROM rt_candles
        WHERE symbol = '9984' AND tradeDate <= '2026-08-28'
        GROUP BY tradeDate, candleTime
      ) latest ON latest.maxId = c.id
      ORDER BY c.tradeDate, c.id
    `);
    await connection.end();

    const byDate = new Map<string, Array<[string, number, number, number, number, number]>>();
    for (const row of rawRows as Row[]) {
      const tradeDate = String(row.tradeDate);
      const candles = byDate.get(tradeDate) ?? [];
      candles.push([row.candleTime, Number(row.open), Number(row.high), Number(row.low), Number(row.close), Number(row.volume)]);
      byDate.set(tradeDate, candles);
    }
    const source = {
      source: "rt_candles latest-id deduplicated KABU STATION 1-minute bars",
      symbol: "9984",
      throughDate: "2026-08-28",
      dateCount: byDate.size,
      rowCount: (rawRows as Row[]).length,
      segments: Array.from(byDate.entries()).map(([tradeDate, candles]) => ({ purpose: "full_saved_day", tradeDate, candles })),
    };
    expect(source).toEqual(fixture);
  }, 120_000);
});
