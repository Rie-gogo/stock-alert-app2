import mysql from "mysql2/promise";
const conn = await mysql.createConnection(process.env.DATABASE_URL);

const today = '2026-07-14';

// Get all trades for today
const [trades] = await conn.query(`
  SELECT symbol, action, tradeTime, price, shares, pnl, reason
  FROM rt_trades
  WHERE tradeDate = ?
  ORDER BY tradeTime ASC
`, [today]);

console.log(`=== ${today} リアルタイムシミュレーション日次レポート ===\n`);

if (trades.length === 0) {
  console.log("本日の取引データはありません。");
  
  // Check if there's candle data
  const [candles] = await conn.query(`
    SELECT COUNT(*) as cnt FROM rt_candles WHERE tradeDate = ?
  `, [today]);
  console.log(`\n受信足数: ${candles[0].cnt}本`);
  
  // Check daily summary
  const [summary] = await conn.query(`
    SELECT * FROM rt_daily_summaries WHERE tradeDate = ?
  `, [today]);
  if (summary.length > 0) {
    console.log(`\nDaily Summary:`, JSON.stringify(summary[0], null, 2));
  } else {
    console.log("\nDaily Summaryもありません。");
  }
  
  await conn.end();
  process.exit(0);
}

// Separate entries and exits
const entries = trades.filter(t => t.action === 'buy' || t.action === 'short');
const exits = trades.filter(t => t.action === 'sell' || t.action === 'cover');

console.log(`--- サマリー ---`);
console.log(`取引件数: ${exits.length}件（エントリー${entries.length}件、決済${exits.length}件）`);

const wins = exits.filter(t => Number(t.pnl) > 0).length;
const losses = exits.filter(t => Number(t.pnl) <= 0).length;
const totalPnl = exits.reduce((s, t) => s + Number(t.pnl), 0);
const grossProfit = exits.filter(t => Number(t.pnl) > 0).reduce((s, t) => s + Number(t.pnl), 0);
const grossLoss = Math.abs(exits.filter(t => Number(t.pnl) < 0).reduce((s, t) => s + Number(t.pnl), 0));
const pf = grossLoss > 0 ? (grossProfit / grossLoss).toFixed(2) : '∞';
const avgWin = wins > 0 ? Math.round(grossProfit / wins) : 0;
const avgLoss = losses > 0 ? Math.round(grossLoss / losses) : 0;

console.log(`勝率: ${((wins / exits.length) * 100).toFixed(1)}%（${wins}勝${losses}敗）`);
console.log(`総損益: ${totalPnl >= 0 ? '+' : ''}${Math.round(totalPnl).toLocaleString()}円`);
console.log(`総利益: +${Math.round(grossProfit).toLocaleString()}円 / 総損失: -${Math.round(grossLoss).toLocaleString()}円`);
console.log(`PF: ${pf}`);
console.log(`平均利益: +${avgWin.toLocaleString()}円 / 平均損失: -${avgLoss.toLocaleString()}円`);

// Get candle count
const [candleCount] = await conn.query(`
  SELECT COUNT(*) as cnt FROM rt_candles WHERE tradeDate = ?
`, [today]);
console.log(`受信足数: ${candleCount[0].cnt}本`);

// By symbol
console.log(`\n--- 銘柄別損益 ---`);
const bySymbol = {};
for (const t of exits) {
  if (!bySymbol[t.symbol]) bySymbol[t.symbol] = { pnl: 0, trades: 0, wins: 0 };
  bySymbol[t.symbol].pnl += Number(t.pnl);
  bySymbol[t.symbol].trades++;
  if (Number(t.pnl) > 0) bySymbol[t.symbol].wins++;
}
const sorted = Object.entries(bySymbol).sort((a, b) => b[1].pnl - a[1].pnl);
for (const [sym, data] of sorted) {
  const losses = data.trades - data.wins;
  console.log(`${sym.padEnd(6)} | ${data.trades}件 | ${data.wins}勝${losses}敗 | ${data.pnl >= 0 ? '+' : ''}${Math.round(data.pnl).toLocaleString()}円`);
}

// By signal type (from reason field of entries)
console.log(`\n--- シグナル別成績 ---`);
const bySignal = {};
for (let i = 0; i < entries.length; i++) {
  const entry = entries[i];
  const exit = exits.find(t => t.symbol === entry.symbol && t.tradeTime > entry.tradeTime);
  if (!exit) continue;
  
  const reason = entry.reason || 'unknown';
  if (!bySignal[reason]) bySignal[reason] = { pnl: 0, trades: 0, wins: 0 };
  bySignal[reason].pnl += Number(exit.pnl);
  bySignal[reason].trades++;
  if (Number(exit.pnl) > 0) bySignal[reason].wins++;
}
for (const [sig, data] of Object.entries(bySignal).sort((a, b) => b[1].pnl - a[1].pnl)) {
  const wr = ((data.wins / data.trades) * 100).toFixed(0);
  console.log(`${sig.padEnd(20)} | ${data.trades}件 | 勝率${wr}% | ${data.pnl >= 0 ? '+' : ''}${Math.round(data.pnl).toLocaleString()}円`);
}

// Trade timeline
console.log(`\n--- 取引タイムライン ---`);
for (const t of trades) {
  const pnl = t.pnl ? `PnL: ${Number(t.pnl) >= 0 ? '+' : ''}${Math.round(Number(t.pnl)).toLocaleString()}円` : '';
  console.log(`${t.tradeTime} | ${t.symbol.padEnd(6)} | ${t.action.padEnd(6)} | @${Number(t.price).toLocaleString()} | ${t.reason || ''} ${pnl}`);
}

// Check for afternoon low-zone filter blocks
const [signals] = await conn.query(`
  SELECT * FROM rt_candles 
  WHERE tradeDate = ? AND signal IS NOT NULL AND signal LIKE '%pm_lowzone%'
  ORDER BY candleTime
`, [today]);
if (signals.length > 0) {
  console.log(`\n--- 午後安値圏フィルター発動 ---`);
  for (const s of signals) {
    console.log(`${s.candleTime} | ${s.symbol} | ${s.signal}`);
  }
}

await conn.end();
