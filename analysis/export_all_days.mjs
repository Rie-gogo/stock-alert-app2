/**
 * export_all_days.mjs
 * DBの全日付の1分足+板情報をJSON出力する
 * 実行: cd /home/ubuntu/stock-alert-app && node analysis/export_all_days.mjs
 */
import "dotenv/config";
import mysql from "mysql2/promise";
import fs from "fs";

const conn = await mysql.createConnection(process.env.DATABASE_URL);

// 利用可能な日付を取得
const [dates] = await conn.execute(
  'SELECT DISTINCT tradeDate FROM rt_candles ORDER BY tradeDate ASC'
);

for (const { tradeDate } of dates) {
  const filename = `/tmp/rt_candles_${tradeDate.replace(/-/g, '')}.json`;
  if (fs.existsSync(filename)) {
    console.log(`${tradeDate}: already exists, skipping`);
    continue;
  }
  const [rows] = await conn.execute(
    'SELECT symbol, tradeDate, candleTime, `open`, high, low, `close`, volume, boardSnapshot FROM rt_candles WHERE tradeDate = ? ORDER BY candleTime, symbol',
    [tradeDate]
  );
  const data = rows.map(row => ({
    symbol: row.symbol,
    tradeDate: row.tradeDate,
    candleTime: row.candleTime,
    open: parseFloat(row.open),
    high: parseFloat(row.high),
    low: parseFloat(row.low),
    close: parseFloat(row.close),
    volume: Number(row.volume),
    boardSnapshot: typeof row.boardSnapshot === 'string' ? JSON.parse(row.boardSnapshot) : row.boardSnapshot
  }));
  fs.writeFileSync(filename, JSON.stringify(data));
  console.log(`${tradeDate}: ${data.length} candles exported -> ${filename}`);
}

await conn.end();
console.log("Done.");
