import mysql from "mysql2/promise";
const conn = await mysql.createConnection(process.env.DATABASE_URL);

// Get all 285A entries (both long and short)
const [entries] = await conn.query(`
  SELECT t.id, t.symbol, t.tradeDate, t.tradeTime, t.action, t.price, t.shares, t.reason
  FROM rt_trades t
  WHERE t.symbol = '285A' AND (t.action = 'buy' OR t.action = 'short')
  ORDER BY t.tradeDate, t.tradeTime
`);

// Get corresponding exits
const [exits] = await conn.query(`
  SELECT t.id, t.symbol, t.tradeDate, t.tradeTime, t.action, t.price, t.shares, t.pnl, t.reason
  FROM rt_trades t
  WHERE t.symbol = '285A' AND (t.action = 'sell' OR t.action = 'cover')
  ORDER BY t.tradeDate, t.tradeTime
`);

console.log(`=== キオクシアHD (285A) 利確ライン変更シミュレーション ===\n`);
console.log(`エントリー数: ${entries.length}件, 決済数: ${exits.length}件\n`);

// For each entry, get the candle data after entry to simulate different TP levels
const tpLevels = [0.015, 0.02, 0.025, 0.03];
const results = {};
for (const tp of tpLevels) {
  results[tp] = { trades: [], totalPnl: 0, wins: 0, losses: 0 };
}

// Also track the actual results
const actualResults = { trades: [], totalPnl: 0, wins: 0, losses: 0 };

for (let i = 0; i < entries.length; i++) {
  const entry = entries[i];
  const entryPrice = Number(entry.price);
  const shares = Number(entry.shares);
  const isShort = entry.action === 'short';
  
  // Find the actual exit
  const exit = exits.find(x => x.tradeDate === entry.tradeDate && x.tradeTime > entry.tradeTime);
  if (!exit) continue;
  
  const actualPnl = Number(exit.pnl);
  actualResults.totalPnl += actualPnl;
  if (actualPnl > 0) actualResults.wins++; else actualResults.losses++;
  actualResults.trades.push({ date: entry.tradeDate, entryTime: entry.tradeTime, exitTime: exit.tradeTime, pnl: actualPnl, reason: exit.reason });

  // Get 1-min candles after entry to simulate TP hits
  const [candles] = await conn.query(`
    SELECT candleTime, high, low, close FROM rt_candles
    WHERE symbol = '285A' AND tradeDate = ? AND candleTime > ? AND candleTime <= '15:30'
    ORDER BY candleTime ASC
  `, [entry.tradeDate, entry.tradeTime]);

  // Also need the stop-loss price (from actual exit if it was a stop loss)
  // Extract stop loss from the actual exit reason
  let stopLossPrice = null;
  if (exit.reason && exit.reason.includes('損切りライン:')) {
    const match = exit.reason.match(/損切りライン:(\d+)/);
    if (match) stopLossPrice = Number(match[1]);
  }

  for (const tp of tpLevels) {
    let tpPrice;
    if (isShort) {
      tpPrice = entryPrice * (1 - tp);
    } else {
      tpPrice = entryPrice * (1 + tp);
    }

    let simPnl = null;
    let simReason = '';
    let simExitTime = '';

    for (const c of candles) {
      const high = Number(c.high);
      const low = Number(c.low);
      
      if (isShort) {
        // Check stop loss first (price goes up)
        if (stopLossPrice && high >= stopLossPrice) {
          simPnl = (entryPrice - stopLossPrice) * shares;
          simReason = '損切り';
          simExitTime = c.candleTime;
          break;
        }
        // Check TP (price goes down)
        if (low <= tpPrice) {
          simPnl = (entryPrice - tpPrice) * shares;
          simReason = `利確(${(tp*100).toFixed(1)}%)`;
          simExitTime = c.candleTime;
          break;
        }
      } else {
        // Long: check stop loss (price goes down)
        if (stopLossPrice && low <= stopLossPrice) {
          simPnl = (stopLossPrice - entryPrice) * shares;
          simReason = '損切り';
          simExitTime = c.candleTime;
          break;
        }
        // Check TP (price goes up)
        if (high >= tpPrice) {
          simPnl = (tpPrice - entryPrice) * shares;
          simReason = `利確(${(tp*100).toFixed(1)}%)`;
          simExitTime = c.candleTime;
          break;
        }
      }
    }

    // If neither TP nor SL hit, use close of last candle (forced exit at end of day)
    if (simPnl === null) {
      if (candles.length > 0) {
        const lastClose = Number(candles[candles.length - 1].close);
        if (isShort) {
          simPnl = (entryPrice - lastClose) * shares;
        } else {
          simPnl = (lastClose - entryPrice) * shares;
        }
        simReason = '大引け決済';
        simExitTime = candles[candles.length - 1].candleTime;
      } else {
        simPnl = actualPnl; // fallback
        simReason = '不明';
        simExitTime = exit.tradeTime;
      }
    }

    results[tp].totalPnl += simPnl;
    if (simPnl > 0) results[tp].wins++; else results[tp].losses++;
    results[tp].trades.push({ 
      date: entry.tradeDate, 
      entryTime: entry.tradeTime, 
      exitTime: simExitTime, 
      pnl: simPnl, 
      reason: simReason,
      side: isShort ? 'SHORT' : 'BUY'
    });
  }
}

// Summary
console.log("=== サマリー比較 ===\n");
console.log(`利確ライン | 取引数 | 勝率      | 総損益        | 平均損益`);
console.log(`-----------|--------|-----------|---------------|--------`);

const totalTrades = actualResults.wins + actualResults.losses;
const actualWR = (actualResults.wins / totalTrades * 100).toFixed(1);
console.log(`1.5%(現在) | ${totalTrades}件  | ${actualWR}% (${actualResults.wins}勝${actualResults.losses}敗) | ${actualResults.totalPnl >= 0 ? '+' : ''}${actualResults.totalPnl.toLocaleString()}円 | ${actualResults.totalPnl >= 0 ? '+' : ''}${Math.round(actualResults.totalPnl / totalTrades).toLocaleString()}円`);

for (const tp of tpLevels) {
  const r = results[tp];
  const total = r.wins + r.losses;
  const wr = (r.wins / total * 100).toFixed(1);
  const label = `${(tp*100).toFixed(1)}%`;
  const marker = tp === 0.015 ? '(現在)' : '      ';
  console.log(`${label}${marker} | ${total}件  | ${wr}% (${r.wins}勝${r.losses}敗) | ${r.totalPnl >= 0 ? '+' : ''}${Math.round(r.totalPnl).toLocaleString()}円 | ${r.totalPnl >= 0 ? '+' : ''}${Math.round(r.totalPnl / total).toLocaleString()}円`);
}

// Detailed per-trade comparison
console.log("\n=== トレード別比較 ===\n");
console.log("日付       | 時刻  | 方向  | 1.5%(実績)    | 2.0%          | 2.5%          | 3.0%");
console.log("-----------|-------|-------|---------------|---------------|---------------|-------");

for (let i = 0; i < actualResults.trades.length; i++) {
  const a = actualResults.trades[i];
  const r2 = results[0.02].trades[i];
  const r25 = results[0.025].trades[i];
  const r3 = results[0.03].trades[i];
  
  const fmtPnl = (pnl, reason) => {
    const p = `${pnl >= 0 ? '+' : ''}${Math.round(pnl).toLocaleString()}`;
    const r = reason?.substring(0, 4) || '';
    return `${p}(${r})`.padEnd(13);
  };
  
  const side = r2?.side || 'SHORT';
  console.log(`${a.date} | ${a.entryTime} | ${side.padEnd(5)} | ${fmtPnl(a.pnl, a.reason?.substring(0,4))} | ${fmtPnl(r2.pnl, r2.reason)} | ${fmtPnl(r25.pnl, r25.reason)} | ${fmtPnl(r3.pnl, r3.reason)}`);
}

await conn.end();
