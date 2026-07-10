import mysql from "mysql2/promise";
const conn = await mysql.createConnection(process.env.DATABASE_URL);
const [cols] = await conn.query(`DESCRIBE rt_candles`);
console.log("=== rt_candles columns ===");
for (const c of cols) console.log(`  ${c.Field} ${c.Type}`);

const [rows] = await conn.query(`
  SELECT tradeDate, COUNT(*) as cnt, COUNT(DISTINCT symbol) as symbols
  FROM rt_candles
  WHERE tradeDate >= '2026-07-06'
  GROUP BY tradeDate
  ORDER BY tradeDate
`);
console.log("\n=== Data availability (last 5 days) ===");
for (const r of rows) {
  console.log(`  ${r.tradeDate}: ${r.cnt} candles, ${r.symbols} symbols`);
}
await conn.end();
