import { sql } from "drizzle-orm";
import { getDb } from "../server/db";

type Candle = {
  tradeDate: string;
  candleTime: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  boardSnapshot: unknown;
};

const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
const pct = (value: number, base: number) => (value / base - 1) * 100;

function maSlope(day: Candle[], index: number) {
  if (index < 9) return 0;
  const current = mean(day.slice(index - 7, index + 1).map((item) => item.close));
  const prior = mean(day.slice(index - 9, index - 1).map((item) => item.close));
  return pct(current, prior);
}

function snapshot(row: Candle) {
  const raw = typeof row.boardSnapshot === "string" ? JSON.parse(row.boardSnapshot) : row.boardSnapshot as Record<string, unknown> | null;
  return raw ? `${raw.signal ?? "?"}/BPR${Number(raw.buyPressureRatio ?? 0).toFixed(2)}` : "板なし";
}

async function main() {
  const db = await getDb();
  if (!db) throw new Error("DB接続に失敗しました");
  const result = await db.execute(sql`
    SELECT tradeDate, candleTime, open, high, low, close, volume, boardSnapshot
    FROM rt_candles
    WHERE symbol = '8035' AND tradeDate IN ('2026-08-17', '2026-08-18')
    ORDER BY tradeDate, candleTime
  `);
  const rows = (result as unknown as [Array<Record<string, unknown>>])[0].map((row) => ({
    tradeDate: String(row.tradeDate),
    candleTime: String(row.candleTime),
    open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close), volume: Number(row.volume), boardSnapshot: row.boardSnapshot,
  })) as Candle[];

  for (const date of ["2026-08-17", "2026-08-18"]) {
    const day = rows.filter((row) => row.tradeDate === date);
    const dayOpen = day[0].open;
    console.log(`\n=== ${date} SHORT時刻診断 ===`);
    console.log("時刻 終値 始値比 MA8傾き 5本安値更新 出来高比 陰線 板");
    for (let index = 20; index < day.length; index++) {
      const candle = day[index];
      if (candle.candleTime < "09:30" || candle.candleTime > "10:45") continue;
      const prior5Low = Math.min(...day.slice(index - 5, index).map((item) => item.low));
      const averageVolume = mean(day.slice(index - 20, index).map((item) => item.volume));
      const lowBreak = candle.low < prior5Low;
      const volumeRatio = averageVolume > 0 ? candle.volume / averageVolume : 0;
      const shortLike = pct(candle.close, dayOpen) <= -0.5 && maSlope(day, index) <= -0.02 && lowBreak && candle.close < candle.open && volumeRatio >= 1.0;
      if (shortLike || ["09:35", "09:40", "09:45", "09:46", "10:12", "10:20", "10:34", "10:40"].includes(candle.candleTime)) {
        console.log(`${candle.candleTime} ${candle.close.toFixed(0)} ${pct(candle.close, dayOpen).toFixed(2)}% ${maSlope(day, index).toFixed(3)}% ${lowBreak ? "Y" : "N"} ${volumeRatio.toFixed(2)}x ${candle.close < candle.open ? "Y" : "N"} ${snapshot(candle)}${shortLike ? " ★早期候補" : ""}`);
      }
    }
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
