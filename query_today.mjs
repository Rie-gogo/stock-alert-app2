import dotenv from 'dotenv';
dotenv.config();
import mysql from 'mysql2/promise';

const url = process.env.DATABASE_URL;
if (!url) { console.error('No DATABASE_URL'); process.exit(1); }

const conn = await mysql.createConnection(url);

const [summaries] = await conn.execute(
  "SELECT * FROM rt_daily_summaries WHERE tradeDate = '2026-06-22'"
);
console.log("=== Daily Summary ===");
console.log(JSON.stringify(summaries, null, 2));

const [trades] = await conn.execute(
  "SELECT * FROM rt_trades WHERE tradeDate = '2026-06-22' ORDER BY tradeTime ASC"
);
console.log("\n=== Trades Count:", trades.length);
for (const t of trades) {
  const pnlStr = t.pnl !== null ? `${Number(t.pnl) > 0 ? '+' : ''}${Number(t.pnl).toLocaleString()}円` : 'エントリー';
  console.log(`  ${t.tradeTime} ${t.symbolName.padEnd(12)} ${t.side.padEnd(5)} ${t.action.padEnd(5)} ${(t.reason || '').substring(0, 45).padEnd(45)} | ${pnlStr}`);
}

await conn.end();
