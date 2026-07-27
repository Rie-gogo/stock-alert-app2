import { getDb } from "../server/db";
import { sql } from "drizzle-orm";

async function main() {
  const db = await getDb();
  
  // Check daily open (09:00) vs close (15:25) for market direction
  const r = await db.execute(sql`
    SELECT a.tradeDate, a.symbol,
           a.open as dayOpen,
           b.close as dayClose
    FROM rt_candles a
    JOIN rt_candles b ON a.tradeDate = b.tradeDate AND a.symbol = b.symbol
    WHERE a.tradeDate >= '2026-07-14' AND a.tradeDate <= '2026-07-24'
      AND a.candleTime = '09:00'
      AND b.candleTime = '15:25'
      AND a.symbol IN ('6857', '8035', '6976', '6981', '285A', '6526', '5803')
    ORDER BY a.tradeDate, a.symbol
  `);
  const rows = (r as any)[0];
  
  console.log("=== MARKET DIRECTION (open vs close) ===");
  let dateMap: Record<string, {up: string[], down: string[]}> = {};
  for (const row of rows) {
    if (!dateMap[row.tradeDate]) dateMap[row.tradeDate] = {up: [], down: []};
    const pctChange = ((row.dayClose - row.dayOpen) / row.dayOpen * 100).toFixed(2);
    if (row.dayClose > row.dayOpen) {
      dateMap[row.tradeDate].up.push(`${row.symbol}(+${pctChange}%)`);
    } else {
      dateMap[row.tradeDate].down.push(`${row.symbol}(${pctChange}%)`);
    }
  }
  for (const [date, data] of Object.entries(dateMap).sort()) {
    const direction = data.up.length > data.down.length ? "↑ BULLISH" : "↓ BEARISH";
    console.log(`${date}: ${direction} (up:${data.up.length} down:${data.down.length})`);
    if (data.up.length > 0) console.log(`  UP: ${data.up.join(', ')}`);
    if (data.down.length > 0) console.log(`  DOWN: ${data.down.join(', ')}`);
  }
  
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
