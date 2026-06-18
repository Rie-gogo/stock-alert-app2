import { getDb } from "./server/db";
import { rtTrades, rtCandles, rtDailySummaries } from "./drizzle/schema";
import { eq, inArray, and } from "drizzle-orm";

async function main() {
  const db = await getDb();
  if (!db) {
    console.error("DB接続失敗");
    process.exit(1);
  }

  const targetDates = ["2026-06-11", "2026-06-12", "2026-06-16"];

  // 1. 日次サマリー取得
  const summaries = await db
    .select()
    .from(rtDailySummaries)
    .where(inArray(rtDailySummaries.tradeDate, targetDates));
  console.log("=== 日次サマリー ===");
  console.log(JSON.stringify(summaries, null, 2));

  // 2. 全取引データ取得
  const trades = await db
    .select()
    .from(rtTrades)
    .where(inArray(rtTrades.tradeDate, targetDates))
    .orderBy(rtTrades.tradeDate, rtTrades.tradeTime);
  console.log("\n=== 取引データ ===");
  console.log(JSON.stringify(trades, null, 2));

  // 3. 取引があった銘柄・時刻の板情報を取得
  const boardData: any[] = [];
  for (const t of trades) {
    const candle = await db
      .select({
        symbol: rtCandles.symbol,
        tradeDate: rtCandles.tradeDate,
        candleTime: rtCandles.candleTime,
        close: rtCandles.close,
        volume: rtCandles.volume,
        boardSnapshot: rtCandles.boardSnapshot,
      })
      .from(rtCandles)
      .where(
        and(
          eq(rtCandles.symbol, t.symbol),
          eq(rtCandles.tradeDate, t.tradeDate),
          eq(rtCandles.candleTime, t.tradeTime)
        )
      )
      .limit(1);
    if (candle.length > 0) {
      boardData.push(candle[0]);
    } else {
      boardData.push({ symbol: t.symbol, tradeDate: t.tradeDate, candleTime: t.tradeTime, boardSnapshot: null });
    }
  }
  console.log("\n=== 板情報（取引時刻） ===");
  console.log(JSON.stringify(boardData, null, 2));

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
