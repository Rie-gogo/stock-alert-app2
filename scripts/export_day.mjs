import mysql from 'mysql2/promise';
import fs from 'fs';

const date = process.argv[2] || '2026-06-18';

// Read DATABASE_URL from running server process
const DATABASE_URL = fs.readFileSync('/tmp/db_url.txt', 'utf8').trim();

async function main() {
  const conn = await mysql.createConnection(DATABASE_URL);
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
  const filename = `/home/ubuntu/rt_candles_${date.replace(/-/g, '')}.json`;
  fs.writeFileSync(filename, JSON.stringify(data));
  console.log(`${filename}: ${data.length} candles exported`);
  await conn.end();
}

main().catch(e => { console.error(e); process.exit(1); });
