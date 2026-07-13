import mysql from "mysql2/promise";
const conn = await mysql.createConnection(process.env.DATABASE_URL);

const [entry] = await conn.query(`SELECT tradeTime, price FROM rt_trades WHERE symbol = '285A' AND tradeDate = '2026-07-10' AND tradeTime >= '13:40' AND tradeTime <= '13:42' AND action = 'short'`);
const [openRow] = await conn.query(`SELECT open FROM rt_candles WHERE symbol = '285A' AND tradeDate = '2026-07-10' AND candleTime >= '09:00' AND candleTime < '09:05' ORDER BY candleTime ASC LIMIT 1`);

const openPrice = Number(openRow[0]?.open);
const entryPrice = Number(entry[0]?.price);
const drop = (entryPrice - openPrice) / openPrice;

console.log(`7/10 キオクシアHD (285A) 13:41 エントリー`);
console.log(`  始値(09:00): ${openPrice}円`);
console.log(`  エントリー価格: ${entryPrice}円`);
console.log(`  始値比: ${(drop * 100).toFixed(2)}%`);
console.log(`  フィルター閾値: -3.0%`);
console.log(`  判定: ${drop <= -0.03 ? '❌ ブロックされる → +120,585円の利確を逃す' : '✅ 通過する（フィルターに引っかからない）'}`);

const [exit] = await conn.query(`SELECT tradeTime, price, pnl, reason FROM rt_trades WHERE symbol = '285A' AND tradeDate = '2026-07-10' AND tradeTime > '13:40' AND action = 'cover' ORDER BY tradeTime ASC LIMIT 1`);
console.log(`\n  決済: ${exit[0]?.tradeTime} COVER @${exit[0]?.price} PnL=${exit[0]?.pnl}円`);
console.log(`  理由: ${exit[0]?.reason}`);

await conn.end();
