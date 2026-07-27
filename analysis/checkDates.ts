import { getDb } from "../server/db";
async function main() {
  const db = getDb();
  const [rows] = await db.execute(`
    SELECT DATE(candleTime) as d, COUNT(*) as cnt, COUNT(DISTINCT symbol) as syms
    FROM rt_candles
    WHERE candleTime >= '2026-07-17'
    GROUP BY DATE(candleTime)
    ORDER BY d
  `);
  console.log("=== rt_candles dates ===");
  for (const r of rows as any[]) {
    console.log(`${r.d}: ${r.cnt} candles, ${r.syms} symbols`);
  }
  
  // Also check ALLOWED_SYMBOLS
  const [trades] = await db.execute(`
    SELECT DATE(entryTime) as d, COUNT(*) as cnt, GROUP_CONCAT(DISTINCT symbol) as syms
    FROM rt_trades
    WHERE entryTime >= '2026-07-17'
    GROUP BY DATE(entryTime)
    ORDER BY d
  `);
  console.log("\n=== rt_trades dates ===");
  for (const r of trades as any[]) {
    console.log(`${r.d}: ${r.cnt} trades, symbols: ${r.syms}`);
  }
  process.exit(0);
}
main();
