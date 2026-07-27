import { getDb } from "../server/db";
import { sql } from "drizzle-orm";

/**
 * Trace what happened on 7/21 for 285A specifically.
 * 285A opened at 52990, went to 60730. Should have crossed 53000, 54000, etc.
 * 
 * The 大台超え detection logic:
 * 1. detectSignals() detects when price crosses a round level
 * 2. Signal goes to state machine (roundLevelConfirmStates) for 5-bar confirmation
 * 3. After 5 bars above the level, it goes to roundPullbackStates for pullback wait
 * 4. After pullback (or timeout), enterPosition is called
 * 
 * Key: The signal must be detected by detectSignals() first.
 * detectSignals() generates "大台超え" when close crosses above a round level.
 * But what are the round levels for 285A? They depend on getRoundLevels() function.
 */

async function main() {
  const db = await getDb();
  
  // Get 285A candles for 7/21
  const r = await db.execute(sql`
    SELECT candleTime, open, high, low, close, volume
    FROM rt_candles 
    WHERE tradeDate = '2026-07-21' AND symbol = '285A'
    ORDER BY candleTime
  `);
  const candles = (r as any)[0];
  
  console.log("=== 285A 7/21 - Round Level Crossings ===");
  console.log(`Total candles: ${candles.length}`);
  console.log(`Open: ${candles[0]?.open}, Close: ${candles[candles.length-1]?.close}`);
  
  // Find round level crossings
  // For 285A at ~53000-60000 range, round levels are every 1000 yen (for stocks > 10000)
  // Actually need to check getRoundLevels logic
  let prevClose = 0;
  const crossings: string[] = [];
  for (const c of candles) {
    const close = parseFloat(c.close);
    if (prevClose > 0) {
      // Check if crossed a round level (every 1000 for this price range? or different?)
      // For 285A at 50000-60000, levels are probably every 1000 or 2000
      for (let level = 50000; level <= 65000; level += 1000) {
        if (prevClose < level && close >= level) {
          crossings.push(`${c.candleTime}: crossed UP ${level} (prev=${prevClose.toFixed(0)}, close=${close.toFixed(0)})`);
        }
      }
    }
    prevClose = close;
  }
  console.log(`\nRound level crossings (every 1000):`);
  for (const x of crossings) console.log(`  ${x}`);
  
  // Also check 6857 (28000→29500, should cross 28500, 29000, 29500)
  const r2 = await db.execute(sql`
    SELECT candleTime, open, high, low, close, volume
    FROM rt_candles 
    WHERE tradeDate = '2026-07-21' AND symbol = '6857'
    ORDER BY candleTime
  `);
  const candles2 = (r2 as any)[0];
  console.log(`\n=== 6857 7/21 - Round Level Crossings ===`);
  console.log(`Total candles: ${candles2.length}`);
  console.log(`Open: ${candles2[0]?.open}, Close: ${candles2[candles2.length-1]?.close}`);
  
  prevClose = 0;
  const crossings2: string[] = [];
  for (const c of candles2) {
    const close = parseFloat(c.close);
    if (prevClose > 0) {
      for (let level = 27000; level <= 31000; level += 500) {
        if (prevClose < level && close >= level) {
          crossings2.push(`${c.candleTime}: crossed UP ${level} (prev=${prevClose.toFixed(0)}, close=${close.toFixed(0)})`);
        }
      }
    }
    prevClose = close;
  }
  console.log(`\nRound level crossings (every 500):`);
  for (const x of crossings2) console.log(`  ${x}`);
  
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
