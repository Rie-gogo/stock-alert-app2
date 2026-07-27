import { getDb } from "../server/db";
import { sql } from "drizzle-orm";

async function main() {
  const db = await getDb();
  
  // Check daily open vs close for each trading day to determine market direction
  const r = await db.execute(sql`
    SELECT tradeDate, symbol,
           MIN(CASE WHEN candleTime = '09:00' THEN open END) as dayOpen,
           MAX(CASE WHEN candleTime >= '15:00' THEN close END) as dayClose
    FROM rt_candles 
    WHERE tradeDate >= '2026-07-14' AND tradeDate <= '2026-07-24'
      AND symbol IN ('6857', '8035', '6976', '6981', '285A')
    GROUP BY tradeDate, symbol
    ORDER BY tradeDate, symbol
  `);
  const rows = (r as any)[0];
  
  // Also check: were there 大台超え BUY signals detected at all?
  // Let me check the filter trace data
  const r2 = await db.execute(sql`
    SELECT tradeDate, symbol, candleTime, side, signalReason
    FROM rt_score0_blocks
    WHERE side = 'BUY'
    ORDER BY tradeDate, candleTime
  `);
  const blocks = (r2 as any)[0];
  console.log("=== Board Score 0 BUY Blocks (state machine entries blocked by board) ===");
  for (const b of blocks) {
    console.log(`${b.tradeDate} ${b.candleTime} ${b.symbol} ${b.side}: ${(b.signalReason || "").substring(0, 120)}`);
  }
  
  // Check market direction
  console.log("\n=== MARKET DIRECTION (open vs close) ===");
  let dateMap: Record<string, {up: number, down: number}> = {};
  for (const row of rows) {
    if (!row.dayOpen || !row.dayClose) continue;
    if (!dateMap[row.tradeDate]) dateMap[row.tradeDate] = {up: 0, down: 0};
    if (row.dayClose > row.dayOpen) dateMap[row.tradeDate].up++;
    else dateMap[row.tradeDate].down++;
  }
  for (const [date, counts] of Object.entries(dateMap).sort()) {
    const direction = counts.up > counts.down ? "↑ BULLISH" : "↓ BEARISH";
    console.log(`${date}: ${direction} (up:${counts.up} down:${counts.down})`);
  }
  
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
