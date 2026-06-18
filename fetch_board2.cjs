require('dotenv').config();
const mysql = require('mysql2/promise');
const fs = require('fs');

(async () => {
  const conn = await mysql.createConnection(process.env.DATABASE_URL);
  const [rows] = await conn.execute(
    "SELECT symbol, tradeDate, candleTime, `open`, high, low, `close`, volume, boardSnapshot FROM rt_candles WHERE tradeDate = '2026-06-18' ORDER BY symbol, candleTime"
  );
  console.log('Rows:', rows.length);
  const bySymbol = {};
  for (const r of rows) {
    const sym = r.symbol;
    if (bySymbol[sym] === undefined) bySymbol[sym] = [];
    bySymbol[sym].push({
      symbol: sym,
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
  const out = JSON.stringify(bySymbol);
  fs.writeFileSync('/home/ubuntu/candles_0618.json', out);
  console.log('Written:', out.length, 'bytes');
  await conn.end();
  process.exit(0);
})();
