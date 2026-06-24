import "dotenv/config";
import mysql from "mysql2/promise";
import fs from "fs";
const conn = await mysql.createConnection(process.env.DATABASE_URL);
const dates = ['2026-06-17','2026-06-18','2026-06-19','2026-06-22','2026-06-23','2026-06-24'];
for (const date of dates) {
  const [rows] = await conn.execute(
    'SELECT symbol, tradeDate, candleTime, `open`, high, low, `close`, volume FROM rt_candles WHERE tradeDate = ? ORDER BY candleTime, symbol',
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
  }));
  const same = data.filter(d => d.open === d.high && d.open === d.low && d.open === d.close).length;
  const diff = data.length - same;
  const vol0 = data.filter(d => d.volume === 0).length;
  console.log(`${date}: ${data.length}本, O=H=L=C: ${same}, OHLC異なる: ${diff}, 出来高0: ${vol0}`);
  fs.writeFileSync(`/tmp/rt_candles_${date.replace(/-/g,'')}.json`, JSON.stringify(data));
}
await conn.end();
