import "dotenv/config";
import mysql from "mysql2/promise";
import fs from "fs";

const conn = await mysql.createConnection(process.env.DATABASE_URL);

const dates = ['2026-06-11', '2026-06-12', '2026-06-16'];

for (const date of dates) {
  const [rows] = await conn.execute(
    'SELECT symbol, tradeDate, candleTime, `open`, high, low, `close`, volume, boardSnapshot FROM rt_candles WHERE tradeDate = ? ORDER BY candleTime, symbol',
    [date]
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
  
  const filename = `/tmp/rt_candles_${date.replace(/-/g, '')}.json`;
  fs.writeFileSync(filename, JSON.stringify(data));
  console.log(`${filename}: ${data.length} candles exported`);
}

await conn.end();
