import { getDb } from "../server/db";
import { rtCandles } from "../drizzle/schema";
import { and, eq, sql, inArray, gte, lte } from "drizzle-orm";

async function main() {
  const db = await getDb();
  const TARGET_SYMBOLS = ["6920", "6857", "5803", "6976", "6981", "6526", "9984", "7011", "8035", "8316"];
  
  const counts = await db.select({ 
    d: rtCandles.tradeDate, 
    s: rtCandles.symbol, 
    cnt: sql`count(*)` 
  })
    .from(rtCandles)
    .where(and(
      inArray(rtCandles.symbol, TARGET_SYMBOLS),
      gte(rtCandles.tradeDate, "2026-06-17"),
      lte(rtCandles.tradeDate, "2026-06-30")
    ))
    .groupBy(rtCandles.tradeDate, rtCandles.symbol);
  
  const dates = ["2026-06-17","2026-06-18","2026-06-19","2026-06-22","2026-06-23","2026-06-24","2026-06-25","2026-06-26","2026-06-29","2026-06-30"];
  
  for (const date of dates) {
    const dateData = counts.filter(r => r.d === date);
    const present = dateData.map(r => r.s);
    const missing = TARGET_SYMBOLS.filter(s => !present.includes(s));
    console.log(`${date}: ${dateData.length}/10銘柄 | missing: ${missing.length > 0 ? missing.join(",") : "なし"}`);
  }
  
  process.exit(0);
}
main();
