import mysql from "mysql2/promise";

async function main() {
  const conn = await mysql.createConnection(process.env.DATABASE_URL!);
  const today = "2026-08-04";

  // Total candles today
  const [totalRows] = await conn.execute(
    "SELECT COUNT(*) as cnt FROM rt_candles WHERE tradeDate = ?",
    [today]
  );
  console.log("本日の受信バー数:", (totalRows as any)[0].cnt);

  // By symbol
  const [bySymbol] = await conn.execute(
    `SELECT symbol, COUNT(*) as cnt, MIN(candleTime) as first_bar, MAX(candleTime) as last_bar 
     FROM rt_candles WHERE tradeDate = ? 
     GROUP BY symbol ORDER BY symbol`,
    [today]
  );
  console.log("\n銘柄別受信状況:");
  const rows = bySymbol as any[];
  if (rows.length === 0) {
    console.log("  *** 本日のデータなし ***");
  } else {
    for (const r of rows) {
      console.log(`  ${r.symbol}: ${r.cnt}本 (${r.first_bar}〜${r.last_bar})`);
    }
  }

  // Latest dates
  const [latest] = await conn.execute(
    `SELECT tradeDate, COUNT(*) as cnt FROM rt_candles 
     GROUP BY tradeDate ORDER BY tradeDate DESC LIMIT 5`
  );
  console.log("\n直近の受信日:");
  for (const r of (latest as any[])) {
    console.log(`  ${r.tradeDate}: ${r.cnt}本`);
  }

  // Check rt_trades today
  const [tradeCols] = await conn.execute("DESCRIBE rt_trades");
  const tradeColNames = (tradeCols as any[]).map(c => c.Field);
  const tradeDateCol = tradeColNames.includes("tradeDate") ? "tradeDate" : "trade_date";
  
  const [trades] = await conn.execute(
    `SELECT COUNT(*) as cnt FROM rt_trades WHERE ${tradeDateCol} = ?`,
    [today]
  );
  console.log("\n本日のrt_trades:", (trades as any)[0].cnt, "件");

  // Check rt_daily_summaries today
  const [sumCols] = await conn.execute("DESCRIBE rt_daily_summaries");
  const sumColNames = (sumCols as any[]).map(c => c.Field);
  const sumDateCol = sumColNames.includes("tradeDate") ? "tradeDate" : "trade_date";
  
  const [summaries] = await conn.execute(
    `SELECT * FROM rt_daily_summaries WHERE ${sumDateCol} = ?`,
    [today]
  );
  const sumRows = summaries as any[];
  if (sumRows.length > 0) {
    console.log("本日のrt_daily_summaries:", JSON.stringify(sumRows[0], null, 2));
  } else {
    console.log("本日のrt_daily_summaries: なし");
  }

  await conn.end();
}
main();
