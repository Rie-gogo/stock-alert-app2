import mysql from "mysql2/promise";
const conn = await mysql.createConnection(process.env.DATABASE_URL);

const [trades] = await conn.query(`
  SELECT tradeDate, symbol, symbolName, action, price, shares, pnl, tradeTime, reason
  FROM rt_trades
  WHERE symbol IN ('5016', '6920')
    AND tradeDate >= '2026-07-06'
  ORDER BY tradeDate, tradeTime
`);
console.log(`=== 5016(JX金属) & 6920(レーザーテック) 直近5日間 ===`);
console.log(`Total trades: ${trades.length}`);
let pnl5016 = 0, pnl6920 = 0;
for (const t of trades) {
  if (t.pnl) {
    if (t.symbol === '5016') pnl5016 += Number(t.pnl);
    if (t.symbol === '6920') pnl6920 += Number(t.pnl);
  }
  console.log(`  ${t.tradeDate} ${t.tradeTime} ${t.symbol}(${t.symbolName}) ${t.action} @${t.price} x${t.shares} pnl=${t.pnl || '-'}`);
}
console.log(`\n5016 total PnL: ${pnl5016.toLocaleString()}円`);
console.log(`6920 total PnL: ${pnl6920.toLocaleString()}円`);
console.log(`Combined: ${(pnl5016 + pnl6920).toLocaleString()}円`);

await conn.end();
