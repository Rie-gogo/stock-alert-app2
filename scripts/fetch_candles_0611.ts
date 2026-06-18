/**
 * 6/11のrt_candlesデータを本番DBから取得してJSONファイルに保存する
 */
import { getRtCandlesAllForDate } from "../server/db";

async function main() {
  console.log("6/11のrt_candlesデータを取得中...");
  const candles = await getRtCandlesAllForDate("2026-06-11");
  console.log(`取得件数: ${candles.length}`);
  
  if (candles.length === 0) {
    console.error("データが見つかりません");
    process.exit(1);
  }

  // 銘柄ごとの件数を表示
  const symbolCounts = new Map<string, number>();
  for (const c of candles) {
    symbolCounts.set(c.symbol, (symbolCounts.get(c.symbol) ?? 0) + 1);
  }
  console.log("\n銘柄別件数:");
  for (const [sym, count] of Array.from(symbolCounts.entries()).sort()) {
    console.log(`  ${sym}: ${count}本`);
  }

  // JSONファイルに保存
  const fs = await import("fs");
  fs.writeFileSync("/home/ubuntu/candles_0611.json", JSON.stringify(candles, null, 2));
  console.log("\n保存完了: /home/ubuntu/candles_0611.json");
  
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
