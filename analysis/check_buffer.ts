import mysql from "mysql2/promise";
async function main() {
  const conn = await mysql.createConnection(process.env.DATABASE_URL!);
  const [rows] = await conn.query(`SELECT tradeDate, symbol, COUNT(*) as cnt FROM rt_candles WHERE tradeDate IN ('2026-08-14','2026-08-17') AND symbol IN ('6976','6981','6526') GROUP BY tradeDate, symbol ORDER BY tradeDate, symbol`) as any[];
  console.log("足数:");
  for (const r of rows as any[]) console.log(`  ${r.tradeDate} ${r.symbol} ${r.cnt}本`);
  
  const [rows2] = await conn.query(`SELECT COUNT(*) as cnt FROM rt_candles WHERE symbol='6976' AND ((tradeDate='2026-08-14') OR (tradeDate='2026-08-17' AND candleTime <= '09:44'))`) as any[];
  console.log(`\n6976 8/14全日+8/17 09:44まで: ${(rows2 as any[])[0].cnt}本`);
  
  // 本番エンジンのバッファは当日構築（前日を含む場合もある）
  // 実際のisBullish計算にはMA20が必要（21本以上）
  // 09:00から09:44は14本しかない → 前日バッファが必要
  const [rows3] = await conn.query(`SELECT candleTime, close FROM rt_candles WHERE symbol='6976' AND tradeDate='2026-08-14' ORDER BY candleTime DESC LIMIT 5`) as any[];
  console.log(`\n6976 8/14の最後の5本:`);
  for (const r of rows3 as any[]) console.log(`  ${r.candleTime} close=${r.close}`);
  
  const [rows4] = await conn.query(`SELECT candleTime, close FROM rt_candles WHERE symbol='6976' AND tradeDate='2026-08-17' ORDER BY candleTime LIMIT 20`) as any[];
  console.log(`\n6976 8/17の最初の20本:`);
  for (const r of rows4 as any[]) console.log(`  ${r.candleTime} close=${r.close}`);
  
  await conn.end();
}
main();
