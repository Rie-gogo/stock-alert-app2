import { getDb } from "../server/db";
import { sql } from "drizzle-orm";

async function main() {
  const db = await getDb();
  
  // 7/21 was very bullish but had 0 LONG entries. Only 1 SHORT entry (6981 大台割れ).
  // Let's check what signals were generated on 7/21 using the fullFilterTrace approach
  
  // First, check if there were 大台超え signals on 7/21
  // The 大台超え detection happens in detectSignals() which generates "buy" signals
  // These get filtered by: isBullish (only blocks SHORT), medium block (blocks direct BUY medium)
  // State machine entries should still work for medium BUY
  
  // Let me check the candle data for 7/21 to see if any stock crossed a round level
  // 285A went from ~56000 to ~64000 (+14.6%) - definitely crossed multiple round levels!
  // 6857 went from ~28000 to ~29500 (+5.5%) - crossed 29000, 29500
  
  // Check 285A candles on 7/21 around round levels
  const r = await db.execute(sql`
    SELECT candleTime, open, high, low, close, volume
    FROM rt_candles 
    WHERE tradeDate = '2026-07-21' AND symbol = '285A'
    ORDER BY candleTime
    LIMIT 5
  `);
  const candles = (r as any)[0];
  console.log("=== 285A 7/21 first candles ===");
  for (const c of candles) {
    console.log(`${c.candleTime} O:${c.open} H:${c.high} L:${c.low} C:${c.close} V:${c.volume}`);
  }
  
  // Check 6857 candles on 7/21
  const r2 = await db.execute(sql`
    SELECT candleTime, open, high, low, close, volume
    FROM rt_candles 
    WHERE tradeDate = '2026-07-21' AND symbol = '6857'
    ORDER BY candleTime
    LIMIT 5
  `);
  const candles2 = (r2 as any)[0];
  console.log("\n=== 6857 7/21 first candles ===");
  for (const c of candles2) {
    console.log(`${c.candleTime} O:${c.open} H:${c.high} L:${c.low} C:${c.close} V:${c.volume}`);
  }
  
  // The key question: on a strongly bullish day (7/21), why didn't the engine generate 大台超え BUY signals?
  // Hypothesis: The stocks GAP UP at open, so they start ABOVE the round level.
  // 大台超え requires crossing the level during the session, not starting above it.
  
  // Check 285A: if it opened at 56000 area and went to 64000, it crossed 57000, 58000, 59000, 60000, 61000, 62000, 63000, 64000
  // But wait - if it gapped up to 60000+ at open, it wouldn't cross lower levels
  
  // Let me check the previous day close vs today's open
  const r3 = await db.execute(sql`
    SELECT tradeDate, candleTime, close
    FROM rt_candles 
    WHERE symbol = '285A' AND tradeDate IN ('2026-07-17', '2026-07-21')
      AND (candleTime = '15:25' OR candleTime = '09:00')
    ORDER BY tradeDate, candleTime
  `);
  console.log("\n=== 285A prev close vs open ===");
  console.log(JSON.stringify((r3 as any)[0]));
  
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
