import mysql from "mysql2/promise";
const conn = await mysql.createConnection(process.env.DATABASE_URL);
const [rows] = await conn.query(`
  SELECT tradeDate, COUNT(*) as cnt, COUNT(DISTINCT symbol) as symbols
  FROM rt_candles_1min
  WHERE tradeDate >= '2026-07-06'
  GROUP BY tradeDate
  ORDER BY tradeDate
`);
console.log("=== 1min candle data availability ===");
for (const r of rows) {
  console.log(`  ${r.tradeDate}: ${r.cnt} candles, ${r.symbols} symbols`);
}
await conn.end();
