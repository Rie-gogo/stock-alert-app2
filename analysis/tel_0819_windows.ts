import { getDb } from "../server/db";
import { sql } from "drizzle-orm";

type Candle = {
  candleTime: string;
  open: number | string;
  high: number | string;
  low: number | string;
  close: number | string;
  volume: number | string;
};

const average = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

async function main() {
  const db = await getDb();
  if (!db) throw new Error("DB接続に失敗しました");
  const result = await db.execute(sql`
    SELECT candleTime, open, high, low, close, volume
    FROM rt_candles
    WHERE symbol = '8035' AND tradeDate = '2026-08-19'
    ORDER BY candleTime
  `);
  const candles = ((result as any)[0] as Candle[]).map((row) => ({
    ...row,
    open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close), volume: Number(row.volume),
  }));
  if (candles.length === 0) throw new Error("2026-08-19の8035データがありません");
  const dayOpen = candles[0].open;
  let dayHigh = -Infinity;
  let dayLow = Infinity;
  console.log(`8035 2026-08-19: ${candles.length}本 始値${dayOpen}`);
  console.log("time close open% dayHighDrop% MA8 slope2% high10 low10 high20 low20 vol20x candle%");

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    dayHigh = Math.max(dayHigh, c.high);
    dayLow = Math.min(dayLow, c.low);
    if (i < 20) continue;
    const inShort = c.candleTime >= "09:50" && c.candleTime <= "10:25";
    const inLong = c.candleTime >= "12:30" && c.candleTime <= "13:15";
    if (!inShort && !inLong) continue;
    const ma8 = average(candles.slice(i - 7, i + 1).map((x) => x.close));
    const prevMa8 = average(candles.slice(i - 9, i - 1).map((x) => x.close));
    const slope2 = (ma8 / prevMa8 - 1) * 100;
    const prior10 = candles.slice(i - 10, i);
    const prior20 = candles.slice(i - 20, i);
    const high10 = Math.max(...prior10.map((x) => x.high));
    const low10 = Math.min(...prior10.map((x) => x.low));
    const high20 = Math.max(...prior20.map((x) => x.high));
    const low20 = Math.min(...prior20.map((x) => x.low));
    const vol20 = c.volume / average(prior20.map((x) => x.volume));
    const openPct = (c.close / dayOpen - 1) * 100;
    const highDrop = (c.close / dayHigh - 1) * 100;
    const candlePct = (c.close / c.open - 1) * 100;
    console.log([
      c.candleTime,
      c.close.toFixed(0),
      openPct.toFixed(2),
      highDrop.toFixed(2),
      ma8.toFixed(1),
      slope2.toFixed(3),
      c.close > high10 ? "Y" : "-",
      c.close < low10 ? "Y" : "-",
      c.close > high20 ? "Y" : "-",
      c.close < low20 ? "Y" : "-",
      vol20.toFixed(2),
      candlePct.toFixed(2),
    ].join(" "));
  }
  console.log(`日中高値${dayHigh} 安値${dayLow} 終値${candles[candles.length - 1].close}`);
  process.exit(0);
}

main().catch((error) => { console.error(error); process.exit(1); });
