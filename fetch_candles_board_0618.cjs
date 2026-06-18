require('dotenv').config();
const mysql = require('mysql2/promise');
const fs = require('fs');

async function main() {
  const conn = await mysql.createConnection(process.env.DATABASE_URL);
  const [rows] = await conn.execute(
    'SELECT symbol, tradeDate, candleTime, `open`, high, low, `close`, volume, boardSnapshot FROM rt_candles WHERE tradeDate = ? ORDER BY symbol, candleTime',
    ['2026-06-18']
  );
  console.log('Total candles:', rows.length);
  const bySymbol = {};
  for (const r of rows) {
    if (!bySymbol[r.symbol]) bySymbol[r.symbol] = [];
    bySymbol[r.symbol].push({
      symbol: r.symbol,
      tradeDate: r.tradeDate,
      candleTime: r.candleTime,
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
      volume: Number(r.volume),
      boardSnapshot: r.boardSnapshot || null,
    });
  }
  fs.writeFileSync('/home/ubuntu/rt_candles_board_20260618.json', JSON.stringify(bySymbol));
  console.log('Saved with board data. Symbols:', Object.keys(bySymbol).length);
  await conn.end();
}
main().catch(e => { console.error(e.message); process.exit(1); });
