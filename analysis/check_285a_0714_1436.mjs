import mysql from "mysql2/promise";
const conn = await mysql.createConnection(process.env.DATABASE_URL);

// Check the 285A entry at 14:36 and what happened after
const [candles] = await conn.query(`
  SELECT candleTime, open, high, low, close, volume
  FROM rt_candles
  WHERE tradeDate = '2026-07-14' AND symbol = '285A'
    AND candleTime >= '14:30' AND candleTime <= '15:00'
  ORDER BY candleTime ASC
`);

console.log("=== 285A 7/14 14:30-15:00 1分足 ===\n");
console.log("時刻     | 始値    | 高値    | 安値    | 終値    | 出来高");
for (const c of candles) {
  console.log(`${c.candleTime} | ${Number(c.open).toLocaleString()} | ${Number(c.high).toLocaleString()} | ${Number(c.low).toLocaleString()} | ${Number(c.close).toLocaleString()} | ${Number(c.volume).toLocaleString()}`);
}

// Entry details
console.log("\n=== エントリー詳細 ===");
console.log("エントリー: 14:36 BUY @69,610");
console.log("SL(1.0%): 69,610 * (1 - 0.01) = 68,914円");
console.log("TP(3.0%): 69,610 * (1 + 0.03) = 71,698円");

// Check the trade records
const [trades] = await conn.query(`
  SELECT tradeTime, action, price, pnl, reason
  FROM rt_trades
  WHERE tradeDate = '2026-07-14' AND symbol = '285A'
  ORDER BY tradeTime ASC
`);
console.log("\n=== 取引記録 ===");
for (const t of trades) {
  console.log(`${t.tradeTime} | ${t.action} | @${Number(t.price).toLocaleString()} | PnL: ${t.pnl ? Math.round(Number(t.pnl)).toLocaleString() : '-'} | ${t.reason}`);
}

// Check if the low after entry ever hit SL
let entryTime = '14:36';
let slHit = false;
for (const c of candles) {
  if (c.candleTime >= entryTime) {
    if (Number(c.low) <= 68914) {
      console.log(`\n★ SLヒット: ${c.candleTime} 安値${Number(c.low).toLocaleString()} <= SL 68,914`);
      slHit = true;
      break;
    }
  }
}
if (!slHit) {
  console.log("\n★ 14:36以降、安値がSL(68,914)に到達した足はない！");
  
  // Check what the actual close was
  const lastCandle = candles[candles.length - 1];
  if (lastCandle) {
    console.log(`最終足: ${lastCandle.candleTime} 終値${Number(lastCandle.close).toLocaleString()}`);
  }
}

// Also check 14:41 specifically
const [c1441] = await conn.query(`
  SELECT candleTime, open, high, low, close
  FROM rt_candles
  WHERE tradeDate = '2026-07-14' AND symbol = '285A' AND candleTime = '14:41'
`);
if (c1441.length > 0) {
  console.log(`\n14:41足: O=${Number(c1441[0].open)} H=${Number(c1441[0].high)} L=${Number(c1441[0].low)} C=${Number(c1441[0].close)}`);
  console.log(`安値${Number(c1441[0].low)} vs SL 68,914 → ${Number(c1441[0].low) <= 68914 ? 'SLヒット' : 'SL未到達'}`);
}

await conn.end();
