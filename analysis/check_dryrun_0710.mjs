import mysql from "mysql2/promise";
const conn = await mysql.createConnection(process.env.DATABASE_URL);

const [oi] = await conn.query(`
  SELECT symbol, oi_side AS side, oi_instruction_type AS type, oi_status AS status, qty,
         reason, referencePrice, executedPrice, executedAt, pnl, isDryRun, errorMessage,
         createdAt
  FROM order_instructions
  WHERE tradeDate = '2026-07-10'
  ORDER BY createdAt
`);
console.log("=== Order Instructions (7/10) ===");
console.log(`Total: ${oi.length}`);
const statusCounts = {};
for (const r of oi) {
  const s = r.status || 'null';
  statusCounts[s] = (statusCounts[s] || 0) + 1;
  const t = new Date(r.createdAt).toLocaleTimeString('ja-JP', {timeZone:'Asia/Tokyo'});
  console.log(`  ${t} ${r.symbol} ${r.side} ${r.type} status=${r.status} qty=${r.qty} refPrice=${r.referencePrice} execPrice=${r.executedPrice || 'N/A'} dryRun=${r.isDryRun}`);
  if (r.errorMessage) console.log(`    error: ${r.errorMessage}`);
}
console.log(`\nStatus counts: ${JSON.stringify(statusCounts)}`);

const [daily] = await conn.query(`SELECT * FROM auto_trade_daily WHERE tradeDate = '2026-07-10'`);
console.log("\n=== Auto Trade Daily (7/10) ===");
if (daily.length > 0) {
  for (const d of daily) console.log(JSON.stringify(d, null, 2));
} else {
  console.log("  No record found");
}

await conn.end();
