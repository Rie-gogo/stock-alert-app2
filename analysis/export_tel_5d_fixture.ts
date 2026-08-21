import { writeFile } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { getDb } from "../server/db";

type Row = {
  tradeDate: string;
  candleTime: string;
  open: string | number;
  high: string | number;
  low: string | number;
  close: string | number;
  volume: string | number;
  boardSnapshot: unknown;
};

async function main() {
  const db = await getDb();
  if (!db) throw new Error("DB接続に失敗しました");

  const result = await db.execute(sql`
    SELECT tradeDate, candleTime, open, high, low, close, volume, boardSnapshot
    FROM rt_candles
    WHERE symbol = '8035'
      AND tradeDate BETWEEN '2026-08-17' AND '2026-08-21'
    ORDER BY tradeDate, candleTime
  `);

  const rows = (result as unknown as [Row[]])[0]
    .map((row) => ({
      ...row,
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
      volume: Number(row.volume),
    }))
    .filter((row) => Number.isFinite(row.close) && row.close > 0);

  await writeFile(
    new URL("./tel_5d_replay_fixture.json", import.meta.url),
    JSON.stringify(rows, null, 2),
    "utf8",
  );
  console.log(`8035再生用データを書き出しました: ${rows.length}本`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
