import mysql from "mysql2/promise";
const conn = await mysql.createConnection(process.env.DATABASE_URL);

// 本日の6981のキャンドルデータ確認
const [rows] = await conn.query(
  `SELECT candleTime, open, high, low, close, volume 
   FROM rt_candles WHERE symbol = '6981' AND tradeDate = '2026-07-15'
   ORDER BY candleTime ASC`
);
console.log('本日の6981キャンドル数:', rows.length);
if (rows.length > 0) {
  console.log('最初:', rows[0].candleTime, 'O:', rows[0].open, 'H:', rows[0].high, 'L:', rows[0].low, 'C:', rows[0].close);
  console.log('最後:', rows[rows.length-1].candleTime, 'O:', rows[rows.length-1].open, 'H:', rows[rows.length-1].high, 'L:', rows[rows.length-1].low, 'C:', rows[rows.length-1].close);
}

// 本日の実際の取引も確認
const [trades] = await conn.query(
  `SELECT tradeTime, action, side, price, pnl, reason 
   FROM rt_trades WHERE symbol = '6981' AND tradeDate = '2026-07-15'
   ORDER BY tradeTime ASC`
);
console.log('\n本日の6981取引:', trades.length, '件');
for (const t of trades) {
  console.log(`  ${t.tradeTime} ${t.action} ${t.side} @${t.price} PnL:${t.pnl} ${t.reason || ''}`);
}

await conn.end();
