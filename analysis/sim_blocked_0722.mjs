import mysql from "mysql2/promise";

const conn = await mysql.createConnection(process.env.DATABASE_URL);
const TODAY = "2026-07-22";

// Get all candle data for today
const [candles] = await conn.execute(
  "SELECT symbol, candleTime, open, high, low, close, volume FROM rt_candles WHERE tradeDate = ? ORDER BY symbol, candleTime",
  [TODAY]
);

// Group by symbol
const bySymbol = {};
for (const c of candles) {
  if (!bySymbol[c.symbol]) bySymbol[c.symbol] = [];
  bySymbol[c.symbol].push({
    time: c.candleTime,
    open: Number(c.open),
    high: Number(c.high),
    low: Number(c.low),
    close: Number(c.close),
    volume: Number(c.volume),
  });
}

// Simulate a SHORT entry
function simShort(symbol, entryTime, entryPrice) {
  const bars = bySymbol[symbol];
  if (!bars) return null;
  const startIdx = bars.findIndex(b => b.time >= entryTime);
  if (startIdx < 0) return null;
  
  const capital = 3000000;
  const shares = Math.floor(capital / entryPrice);
  const slPrice = entryPrice * 1.005; // SL 0.5%
  const tpPrice = entryPrice * 0.985; // TP 1.5%
  
  for (let i = startIdx + 1; i < bars.length; i++) {
    const bar = bars[i];
    // Check SL first
    if (bar.high >= slPrice) {
      const pnl = Math.round((entryPrice - slPrice) * shares);
      return { exitTime: bar.time, exitPrice: slPrice, pnl, reason: "SL", bars: i - startIdx };
    }
    // Check TP
    if (bar.low <= tpPrice) {
      const pnl = Math.round((entryPrice - tpPrice) * shares);
      return { exitTime: bar.time, exitPrice: tpPrice, pnl, reason: "TP", bars: i - startIdx };
    }
    // EOD at 15:25
    if (bar.time >= "15:25") {
      const pnl = Math.round((entryPrice - bar.close) * shares);
      return { exitTime: bar.time, exitPrice: bar.close, pnl, reason: "EOD", bars: i - startIdx };
    }
  }
  // Use last bar
  const last = bars[bars.length - 1];
  const pnl = Math.round((entryPrice - last.close) * shares);
  return { exitTime: last.time, exitPrice: last.close, pnl, reason: "EOD", bars: bars.length - 1 - startIdx };
}

// Simulate a LONG entry
function simLong(symbol, entryTime, entryPrice) {
  const bars = bySymbol[symbol];
  if (!bars) return null;
  const startIdx = bars.findIndex(b => b.time >= entryTime);
  if (startIdx < 0) return null;
  
  const capital = 3000000;
  const shares = Math.floor(capital / entryPrice);
  const slPrice = entryPrice * 0.995; // SL 0.5%
  const tpPrice = entryPrice * 1.015; // TP 1.5%
  
  for (let i = startIdx + 1; i < bars.length; i++) {
    const bar = bars[i];
    if (bar.low <= slPrice) {
      const pnl = Math.round((slPrice - entryPrice) * shares);
      return { exitTime: bar.time, exitPrice: slPrice, pnl, reason: "SL", bars: i - startIdx };
    }
    if (bar.high >= tpPrice) {
      const pnl = Math.round((tpPrice - entryPrice) * shares);
      return { exitTime: bar.time, exitPrice: tpPrice, pnl, reason: "TP", bars: i - startIdx };
    }
    if (bar.time >= "15:25") {
      const pnl = Math.round((bar.close - entryPrice) * shares);
      return { exitTime: bar.time, exitPrice: bar.close, pnl, reason: "EOD", bars: i - startIdx };
    }
  }
  const last = bars[bars.length - 1];
  const pnl = Math.round((last.close - entryPrice) * shares);
  return { exitTime: last.time, exitPrice: last.close, pnl, reason: "EOD", bars: bars.length - 1 - startIdx };
}

// Define blocked signals from production logs
const blockedSignals = [
  // SHORT blocks - isBullish
  { time: "09:54", symbol: "285A", side: "SHORT", reason: "isBullish", signal: "大台割れ(66500円)" },
  { time: "09:54", symbol: "5803", side: "SHORT", reason: "isBullish", signal: "ダウ理論安値更新" },
  { time: "09:58", symbol: "5803", side: "SHORT", reason: "isBullish", signal: "ダウ理論安値更新" },
  // SHORT blocks - 板読みスコア不足
  { time: "09:55", symbol: "6976", side: "SHORT", reason: "板読み(-4)", signal: "大台割れ(12800円)" },
  { time: "13:43", symbol: "6981", side: "SHORT", reason: "板読み(0)", signal: "ダウ理論安値更新" },
  { time: "13:57", symbol: "6981", side: "SHORT", reason: "板読み(-2)", signal: "ダウ理論安値更新" },
  // SHORT blocks - 押し目深さフィルター
  { time: "13:57", symbol: "8035", side: "SHORT", reason: "押し目深さ(1.4%)", signal: "ダウ理論SHORT" },
  { time: "13:57", symbol: "6976", side: "SHORT", reason: "押し目深さ(2.2%)", signal: "ダウ理論SHORT" },
  { time: "13:57", symbol: "5803", side: "SHORT", reason: "押し目深さ(0.0%)", signal: "ダウ理論SHORT" },
  { time: "13:58", symbol: "8035", side: "SHORT", reason: "押し目深さ(11.3%)", signal: "ダウ理論SHORT" },
  { time: "13:58", symbol: "5803", side: "SHORT", reason: "押し目深さ(14.0%)", signal: "ダウ理論SHORT" },
  { time: "14:12", symbol: "6526", side: "SHORT", reason: "押し目深さ(5.8%)", signal: "ダウ理論SHORT" },
  { time: "14:12", symbol: "8035", side: "SHORT", reason: "押し目深さ(8.6%)", signal: "ダウ理論SHORT" },
  { time: "14:12", symbol: "285A", side: "SHORT", reason: "押し目深さ(10.6%)", signal: "ダウ理論SHORT" },
  { time: "14:13", symbol: "6981", side: "SHORT", reason: "押し目深さ(6.8%)", signal: "ダウ理論SHORT" },
  { time: "14:13", symbol: "5803", side: "SHORT", reason: "押し目深さ(3.6%)", signal: "ダウ理論SHORT" },
  // SHORT blocks - HTFフィルター
  { time: "13:43", symbol: "5803", side: "SHORT", reason: "HTF(up)", signal: "大台割れ(4900円)" },
  { time: "13:44", symbol: "5803", side: "SHORT", reason: "HTF(up)", signal: "ダウ理論安値更新" },
  // LONG blocks - sell_pressure
  { time: "09:37", symbol: "6857", side: "LONG", reason: "sell_pressure", signal: "大台超え(31000円)" },
  { time: "09:39", symbol: "6857", side: "LONG", reason: "sell_pressure", signal: "大台超え(31100円)" },
  { time: "09:57", symbol: "6857", side: "LONG", reason: "sell_pressure", signal: "大台超え(31000円)" },
  { time: "09:58", symbol: "6857", side: "LONG", reason: "sell_pressure", signal: "大台超え(31100円)" },
  { time: "13:28", symbol: "8035", side: "LONG", reason: "sell_pressure", signal: "大台超え(68200円)" },
  { time: "14:56", symbol: "285A", side: "LONG", reason: "sell_pressure", signal: "大台超え(64100円)" },
  { time: "14:58", symbol: "285A", side: "LONG", reason: "sell_pressure", signal: "大台超え(64200円)" },
  // LONG blocks - 板読みスコア不足
  { time: "10:57", symbol: "6976", side: "LONG", reason: "板読み(-2)", signal: "ダウ理論高値更新" },
  { time: "10:58", symbol: "6526", side: "LONG", reason: "板読み(-1)", signal: "ダウ理論高値更新" },
  { time: "10:58", symbol: "5803", side: "LONG", reason: "板読み(-4)", signal: "ダウ理論高値更新" },
  { time: "10:59", symbol: "285A", side: "LONG", reason: "板読み(-2)", signal: "ダウ理論高値更新" },
  { time: "14:49", symbol: "6981", side: "LONG", reason: "板読み(-2)", signal: "逆三尊" },
  { time: "14:50", symbol: "6981", side: "LONG", reason: "板読み(0)", signal: "逆三尊" },
  { time: "14:51", symbol: "6981", side: "LONG", reason: "板読み(0)", signal: "逆三尊" },
  { time: "14:52", symbol: "6981", side: "LONG", reason: "板読み(0)", signal: "ダウ理論高値更新" },
  { time: "14:57", symbol: "6976", side: "LONG", reason: "板読み(-3)", signal: "大台超え(12600円)" },
  { time: "14:58", symbol: "6981", side: "LONG", reason: "板読み(-2)", signal: "ダウ理論高値更新" },
  { time: "14:59", symbol: "6976", side: "LONG", reason: "板読み(-1)", signal: "大台超え(12600円)" },
  { time: "14:59", symbol: "6981", side: "LONG", reason: "板読み(-2)", signal: "ダウ理論高値更新" },
  // LONG blocks - 押し目深さ
  { time: "10:58", symbol: "285A", side: "LONG", reason: "押し目深さ(2.9%)", signal: "ダウ理論LONG" },
  // LONG blocks - HTFフィルター
  { time: "14:49", symbol: "6976", side: "LONG", reason: "HTF(down)", signal: "ダウ理論高値更新" },
];

// Get entry prices from candle data
function getEntryPrice(symbol, time, side) {
  const bars = bySymbol[symbol];
  if (!bars) return null;
  const bar = bars.find(b => b.time >= time);
  if (!bar) return null;
  return bar.close; // Use close of the signal bar as entry
}

console.log("=== 7/22 ブロックされたシグナル仮想エントリーシミュレーション ===\n");

// Deduplicate by symbol+time (keep first occurrence)
const seen = new Set();
const unique = blockedSignals.filter(s => {
  const key = `${s.symbol}_${s.time}_${s.side}`;
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
});

const results = [];
for (const sig of unique) {
  const entryPrice = getEntryPrice(sig.symbol, sig.time, sig.side);
  if (!entryPrice) continue;
  
  const result = sig.side === "SHORT" 
    ? simShort(sig.symbol, sig.time, entryPrice)
    : simLong(sig.symbol, sig.time, entryPrice);
  
  if (result) {
    results.push({ ...sig, entryPrice, ...result });
  }
}

// Sort by PnL descending
results.sort((a, b) => b.pnl - a.pnl);

console.log("--- プラスになったケース（勿体なかったシグナル）---");
console.log("| # | 時刻 | 銘柄 | 方向 | ブロック理由 | シグナル | エントリー | 損益 | 結果 |");
console.log("|---|------|------|------|------|------|----------:|-----:|------|");
let profitCount = 0;
let profitTotal = 0;
for (const r of results) {
  if (r.pnl > 0) {
    profitCount++;
    profitTotal += r.pnl;
    const pnlStr = `+${r.pnl.toLocaleString()}`;
    console.log(`| ${profitCount} | ${r.time} | ${r.symbol} | ${r.side} | ${r.reason} | ${r.signal} | ${r.entryPrice.toLocaleString()} | ${pnlStr} | ${r.reason === "TP" ? "TP" : r.reason === "EOD" ? "EOD" : r.reason} ${r.exitTime} |`);
  }
}

console.log(`\n--- マイナスになったケース ---`);
console.log("| # | 時刻 | 銘柄 | 方向 | ブロック理由 | シグナル | エントリー | 損益 | 結果 |");
console.log("|---|------|------|------|------|------|----------:|-----:|------|");
let lossCount = 0;
let lossTotal = 0;
for (const r of results) {
  if (r.pnl <= 0) {
    lossCount++;
    lossTotal += r.pnl;
    console.log(`| ${lossCount} | ${r.time} | ${r.symbol} | ${r.side} | ${r.reason} | ${r.signal} | ${r.entryPrice.toLocaleString()} | ${r.pnl.toLocaleString()} | ${r.reason === "SL" ? "SL" : "EOD"} ${r.exitTime} |`);
  }
}

console.log(`\n--- サマリー ---`);
console.log(`プラス: ${profitCount}件 / ${profitTotal >= 0 ? '+' : ''}${profitTotal.toLocaleString()}円`);
console.log(`マイナス: ${lossCount}件 / ${lossTotal.toLocaleString()}円`);
console.log(`合計: ${results.length}件 / ${(profitTotal + lossTotal) >= 0 ? '+' : ''}${(profitTotal + lossTotal).toLocaleString()}円`);

// Group by block reason
console.log(`\n--- ブロック理由別の仮想損益 ---`);
const byReason = {};
for (const r of results) {
  const key = r.reason.split("(")[0]; // Simplify reason
  if (!byReason[key]) byReason[key] = { count: 0, pnl: 0, wins: 0 };
  byReason[key].count++;
  byReason[key].pnl += r.pnl;
  if (r.pnl > 0) byReason[key].wins++;
}
console.log("| ブロック理由 | 件数 | 勝率 | 仮想損益 |");
console.log("|------|-----:|-----:|-----:|");
for (const [reason, data] of Object.entries(byReason).sort((a, b) => b[1].pnl - a[1].pnl)) {
  const pnlStr = data.pnl >= 0 ? `+${data.pnl.toLocaleString()}` : data.pnl.toLocaleString();
  console.log(`| ${reason} | ${data.count} | ${(data.wins/data.count*100).toFixed(0)}% | ${pnlStr} |`);
}

// Special analysis: the "score 0" cases
console.log(`\n--- スコア0でブロックされたケース（閾値緩和候補）---`);
for (const r of results) {
  if (r.reason.includes("(0)")) {
    const pnlStr = r.pnl >= 0 ? `+${r.pnl.toLocaleString()}` : r.pnl.toLocaleString();
    console.log(`  ${r.time} ${r.symbol} ${r.side} ${r.signal} → ${pnlStr} (${r.reason === "TP" ? "TP" : r.reason === "SL" ? "SL" : "EOD"})`);
  }
}

await conn.end();
