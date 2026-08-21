import { getDb } from "../server/db";
import { sql } from "drizzle-orm";

async function main() {
  const db = await getDb();
  if (!db) throw new Error("DB接続に失敗しました");
  const result = await db.execute(sql`
    SELECT candleTime, open, high, low, close
    FROM rt_candles WHERE symbol='8035' AND tradeDate='2026-08-19'
    ORDER BY candleTime
  `);
  const candles = ((result as any)[0] as any[]).map((x) => ({ ...x, open: Number(x.open), high: Number(x.high), low: Number(x.low), close: Number(x.close) }));
  console.log("8035 2026-08-19 後場LONG候補: SL0.8% / TP0.5% / 15:25時間決済");
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (c.candleTime < "12:40" || c.candleTime > "13:05") continue;
    const entry = c.close, sl = entry * 0.992, tp = entry * 1.005;
    let exit = candles.find((x, idx) => idx > i && x.candleTime <= "15:25" && (x.low <= sl || x.high >= tp));
    let outcome = "時間決済";
    let exitPrice = candles.filter((x) => x.candleTime <= "15:25").at(-1).close;
    if (exit) {
      if (exit.low <= sl) { outcome = "SL"; exitPrice = sl; }
      else { outcome = "TP"; exitPrice = tp; }
    }
    console.log(`${c.candleTime} @${entry} -> ${outcome} ${exit?.candleTime ?? "15:25"} @${exitPrice.toFixed(1)} PnL${(exitPrice-entry).toFixed(1)}/株`);
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
