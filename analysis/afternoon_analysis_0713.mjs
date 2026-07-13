import mysql from "mysql2/promise";
const conn = await mysql.createConnection(process.env.DATABASE_URL);

const date = '2026-07-13';

// Get afternoon trades
const [pmTrades] = await conn.query(`
  SELECT symbol, symbolName, action, price, shares, pnl, tradeTime, reason
  FROM rt_trades
  WHERE tradeDate = ? AND tradeTime >= '13:00'
  ORDER BY tradeTime
`, [date]);

console.log(`=== 7/13 午後の取引分析 ===\n`);
console.log(`午後取引: ${pmTrades.length}件\n`);

// Pair entries with exits
const pairs = [];
const openEntries = new Map();
for (const t of pmTrades) {
  if (t.action === 'buy' || t.action === 'short') {
    openEntries.set(t.symbol, t);
  } else {
    const entry = openEntries.get(t.symbol);
    if (entry) {
      pairs.push({ entry, exit: t });
      openEntries.delete(t.symbol);
    }
  }
}

console.log("--- 午後の全取引ペア ---");
for (const p of pairs) {
  const holdMin = (() => {
    const [eh, em] = p.entry.tradeTime.split(':').map(Number);
    const [xh, xm] = p.exit.tradeTime.split(':').map(Number);
    return (xh * 60 + xm) - (eh * 60 + em);
  })();
  const pnl = Number(p.exit.pnl);
  console.log(`  ${p.entry.tradeTime}→${p.exit.tradeTime} (${holdMin}分) ${p.entry.symbol}(${p.entry.symbolName}) ${p.entry.action} @${p.entry.price}→@${p.exit.price} PnL=${pnl >= 0 ? '+' : ''}${pnl.toLocaleString()}円`);
  console.log(`    シグナル: ${p.entry.reason?.substring(0, 80)}`);
  console.log(`    決済理由: ${p.exit.reason?.substring(0, 60)}`);
}

// Check the morning price movement to understand context
console.log("\n--- 午前の値動き（始値→午前終値）---");
const symbols = [...new Set(pmTrades.filter(t => t.action === 'short' || t.action === 'buy').map(t => t.symbol))];
for (const sym of symbols) {
  const [morning] = await conn.query(`
    SELECT MIN(open) as dayLow, MAX(high) as dayHigh, 
      (SELECT open FROM rt_candles WHERE tradeDate = ? AND symbol = ? AND candleTime = '09:00' LIMIT 1) as openPrice,
      (SELECT close FROM rt_candles WHERE tradeDate = ? AND symbol = ? AND candleTime >= '11:25' AND candleTime <= '11:30' ORDER BY candleTime DESC LIMIT 1) as amClose,
      (SELECT close FROM rt_candles WHERE tradeDate = ? AND symbol = ? AND candleTime >= '12:30' AND candleTime <= '12:31' ORDER BY candleTime ASC LIMIT 1) as pmOpen
    FROM rt_candles WHERE tradeDate = ? AND symbol = ?
  `, [date, sym, date, sym, date, sym, date, sym]);
  
  if (morning[0] && morning[0].openPrice) {
    const op = Number(morning[0].openPrice);
    const amCl = Number(morning[0].amClose || 0);
    const pmOp = Number(morning[0].pmOpen || 0);
    const dropPct = op > 0 ? ((amCl - op) / op * 100).toFixed(2) : '?';
    console.log(`  ${sym}: 始値${op} → 前場終値${amCl} (${dropPct}%) → 後場寄${pmOp}`);
  }
}

// Check: what was the price at entry vs the day's low
console.log("\n--- 午後エントリー時点の位置（日中安値との距離）---");
for (const p of pairs) {
  if (p.entry.action !== 'short') continue;
  const [range] = await conn.query(`
    SELECT MIN(low) as dayLow, MAX(high) as dayHigh,
      (SELECT open FROM rt_candles WHERE tradeDate = ? AND symbol = ? AND candleTime = '09:00' LIMIT 1) as openPrice
    FROM rt_candles WHERE tradeDate = ? AND symbol = ? AND candleTime < ?
  `, [date, p.entry.symbol, date, p.entry.symbol, p.entry.tradeTime]);
  
  if (range[0]) {
    const entryPrice = Number(p.entry.price);
    const dayLow = Number(range[0].dayLow);
    const dayHigh = Number(range[0].dayHigh);
    const openPrice = Number(range[0].openPrice);
    const fromLow = ((entryPrice - dayLow) / dayLow * 100).toFixed(2);
    const fromOpen = ((entryPrice - openPrice) / openPrice * 100).toFixed(2);
    const dayRange = ((dayHigh - dayLow) / dayLow * 100).toFixed(2);
    console.log(`  ${p.entry.symbol} ${p.entry.tradeTime}: エントリー${entryPrice} | 始値比${fromOpen}% | 安値比+${fromLow}% | 日中レンジ${dayRange}%`);
  }
}

// Check NO_ENTRY_AFTER setting
console.log("\n--- 現在のエントリー制限時間 ---");
const [config] = await conn.query(`SELECT 1`); // just to keep connection alive

// Read from the engine file
await conn.end();
