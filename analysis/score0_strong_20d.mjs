import mysql from "mysql2/promise";

// 20営業日シミュレーション: 板読みスコア0 + 信頼度「強」の場合に通過させる
// 対象: 板読みスコア不足でブロックされたシグナルのうち、スコア=0 かつ 信頼度=強 のもの

const conn = await mysql.createConnection(process.env.DATABASE_URL);

// Get all trading days (last 20)
const [days] = await conn.execute(
  "SELECT DISTINCT tradeDate FROM rt_candles ORDER BY tradeDate DESC LIMIT 20"
);
const tradeDays = days.map(d => d.tradeDate).reverse();
console.log(`対象期間: ${tradeDays[0]} 〜 ${tradeDays[tradeDays.length-1]} (${tradeDays.length}営業日)\n`);

// Process each day
const dailyResults = [];
let totalPnl = 0;
let totalTrades = 0;
let totalWins = 0;

for (const day of tradeDays) {
  // Get candle data for this day
  const [candles] = await conn.execute(
    "SELECT symbol, candleTime, open, high, low, close, volume FROM rt_candles WHERE tradeDate = ? ORDER BY symbol, candleTime",
    [day]
  );
  
  if (candles.length === 0) continue;
  
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
  
  // For each symbol, detect signals that would have been blocked by board score
  // but have score=0 and confidence=strong
  // We need to re-detect: signals where the log would show "板読みスコア不足(0)" and "信頼度：強"
  
  // Strategy: scan candle data for potential entry points
  // A "score 0 + strong confidence" signal means:
  // - Volume confirmed (above average)
  // - Trend aligned (MA5 > MA25 for long, MA5 < MA25 for short)
  // - Momentum aligned
  // But board reading score = 0 (neutral board pressure)
  
  // Since we can't replicate the exact board reading from candle data alone,
  // we'll use the production approach: detect signals based on price patterns
  // and simulate with SL/TP rules
  
  // Simplified approach: detect 大台 signals and ダウ理論 signals
  // For each symbol, find where price crosses round numbers
  
  const dayTrades = [];
  
  for (const [symbol, bars] of Object.entries(bySymbol)) {
    if (bars.length < 30) continue;
    
    // Calculate MA5, MA25 for each bar
    for (let i = 0; i < bars.length; i++) {
      if (i >= 4) {
        bars[i].ma5 = bars.slice(i-4, i+1).reduce((s, b) => s + b.close, 0) / 5;
      }
      if (i >= 24) {
        bars[i].ma25 = bars.slice(i-24, i+1).reduce((s, b) => s + b.close, 0) / 25;
      }
      // Volume average (10-bar)
      if (i >= 9) {
        bars[i].avgVol = bars.slice(i-9, i+1).reduce((s, b) => s + b.volume, 0) / 10;
      }
    }
    
    // Detect potential SHORT signals with "strong" confidence
    // Strong = volume confirmed + trend aligned + momentum aligned
    for (let i = 25; i < bars.length - 1; i++) {
      const bar = bars[i];
      if (!bar.ma5 || !bar.ma25 || !bar.avgVol) continue;
      if (bar.time < "09:30" || bar.time > "14:50") continue;
      
      // Check strong confidence for SHORT:
      // - Volume > average (volume confirmed)
      // - MA5 < MA25 (trend aligned for short)
      // - Momentum negative (close < close[3])
      const volumeConfirmed = bar.volume > bar.avgVol * 1.0;
      const trendAligned = bar.ma5 < bar.ma25;
      const momentumAligned = i >= 3 && bar.close < bars[i-3].close;
      const isStrong = volumeConfirmed && trendAligned && momentumAligned;
      
      if (!isStrong) continue;
      
      // Check for round number break (大台割れ)
      const price = bar.close;
      let roundLevel = null;
      
      // Determine round number step based on price
      let step;
      if (price >= 50000) step = 500;
      else if (price >= 10000) step = 200;
      else if (price >= 5000) step = 100;
      else if (price >= 1000) step = 50;
      else step = 10;
      
      const nearestRound = Math.ceil(price / step) * step;
      const prevBar = bars[i-1];
      
      // Check if previous bar was above the round level and current is below
      if (prevBar.close > nearestRound && bar.close < nearestRound) {
        roundLevel = nearestRound;
      }
      
      // Also check for ダウ理論 (lower low)
      let isDowBreak = false;
      if (i >= 10) {
        const recentLows = bars.slice(i-10, i).map(b => b.low);
        const prevLow = Math.min(...recentLows);
        if (bar.low < prevLow && bar.close < prevLow) {
          isDowBreak = true;
        }
      }
      
      if (!roundLevel && !isDowBreak) continue;
      
      // This is a potential "score 0 + strong" SHORT signal
      // Simulate entry
      const entryPrice = bar.close;
      const capital = 3000000;
      const shares = Math.floor(capital / entryPrice);
      const slPrice = entryPrice * 1.005;
      const tpPrice = entryPrice * 0.985;
      
      let result = null;
      for (let j = i + 1; j < bars.length; j++) {
        const b = bars[j];
        if (b.high >= slPrice) {
          result = { pnl: Math.round((entryPrice - slPrice) * shares), reason: "SL", exitTime: b.time };
          break;
        }
        if (b.low <= tpPrice) {
          result = { pnl: Math.round((entryPrice - tpPrice) * shares), reason: "TP", exitTime: b.time };
          break;
        }
        if (b.time >= "15:25") {
          result = { pnl: Math.round((entryPrice - b.close) * shares), reason: "EOD", exitTime: b.time };
          break;
        }
      }
      
      if (result) {
        dayTrades.push({
          symbol,
          time: bar.time,
          side: "SHORT",
          signal: roundLevel ? `大台割れ(${roundLevel})` : "ダウ理論安値更新",
          entryPrice,
          ...result,
        });
      }
    }
    
    // Detect potential LONG signals with "strong" confidence
    for (let i = 25; i < bars.length - 1; i++) {
      const bar = bars[i];
      if (!bar.ma5 || !bar.ma25 || !bar.avgVol) continue;
      if (bar.time < "09:30" || bar.time > "14:50") continue;
      
      const volumeConfirmed = bar.volume > bar.avgVol * 1.0;
      const trendAligned = bar.ma5 > bar.ma25;
      const momentumAligned = i >= 3 && bar.close > bars[i-3].close;
      const isStrong = volumeConfirmed && trendAligned && momentumAligned;
      
      if (!isStrong) continue;
      
      // Check for round number break up (大台超え)
      const price = bar.close;
      let roundLevel = null;
      
      let step;
      if (price >= 50000) step = 500;
      else if (price >= 10000) step = 200;
      else if (price >= 5000) step = 100;
      else if (price >= 1000) step = 50;
      else step = 10;
      
      const nearestRound = Math.floor(price / step) * step;
      const prevBar = bars[i-1];
      
      if (prevBar.close < nearestRound && bar.close > nearestRound) {
        roundLevel = nearestRound;
      }
      
      // ダウ理論 (higher high)
      let isDowBreak = false;
      if (i >= 10) {
        const recentHighs = bars.slice(i-10, i).map(b => b.high);
        const prevHigh = Math.max(...recentHighs);
        if (bar.high > prevHigh && bar.close > prevHigh) {
          isDowBreak = true;
        }
      }
      
      if (!roundLevel && !isDowBreak) continue;
      
      const entryPrice = bar.close;
      const capital = 3000000;
      const shares = Math.floor(capital / entryPrice);
      const slPrice = entryPrice * 0.995;
      const tpPrice = entryPrice * 1.015;
      
      let result = null;
      for (let j = i + 1; j < bars.length; j++) {
        const b = bars[j];
        if (b.low <= slPrice) {
          result = { pnl: Math.round((slPrice - entryPrice) * shares), reason: "SL", exitTime: b.time };
          break;
        }
        if (b.high >= tpPrice) {
          result = { pnl: Math.round((tpPrice - entryPrice) * shares), reason: "TP", exitTime: b.time };
          break;
        }
        if (b.time >= "15:25") {
          result = { pnl: Math.round((b.close - entryPrice) * shares), reason: "EOD", exitTime: b.time };
          break;
        }
      }
      
      if (result) {
        dayTrades.push({
          symbol,
          time: bar.time,
          side: "LONG",
          signal: roundLevel ? `大台超え(${roundLevel})` : "ダウ理論高値更新",
          entryPrice,
          ...result,
        });
      }
    }
  }
  
  // Limit to max 3 concurrent positions (realistic constraint)
  // Sort by time and take first signal per time slot
  dayTrades.sort((a, b) => a.time.localeCompare(b.time));
  
  // Deduplicate: only one trade per symbol per 15-min window
  const filtered = [];
  const lastTradeTime = {};
  for (const t of dayTrades) {
    const key = `${t.symbol}_${t.side}`;
    const lastTime = lastTradeTime[key];
    if (lastTime) {
      const lastMin = parseInt(lastTime.split(":")[0]) * 60 + parseInt(lastTime.split(":")[1]);
      const curMin = parseInt(t.time.split(":")[0]) * 60 + parseInt(t.time.split(":")[1]);
      if (curMin - lastMin < 15) continue;
    }
    lastTradeTime[key] = t.time;
    filtered.push(t);
  }
  
  const dayPnl = filtered.reduce((s, t) => s + t.pnl, 0);
  const dayWins = filtered.filter(t => t.pnl > 0).length;
  
  dailyResults.push({
    date: day,
    trades: filtered.length,
    wins: dayWins,
    pnl: dayPnl,
  });
  
  totalPnl += dayPnl;
  totalTrades += filtered.length;
  totalWins += dayWins;
}

// Output results
console.log("=== 日別結果 ===");
console.log("| 日付 | 件数 | 勝敗 | 損益 | 累計 |");
console.log("|------|-----:|------|-----:|-----:|");
let cumPnl = 0;
for (const d of dailyResults) {
  cumPnl += d.pnl;
  const pnlStr = d.pnl >= 0 ? `+${d.pnl.toLocaleString()}` : d.pnl.toLocaleString();
  const cumStr = cumPnl >= 0 ? `+${cumPnl.toLocaleString()}` : cumPnl.toLocaleString();
  console.log(`| ${d.date} | ${d.trades} | ${d.wins}W/${d.trades - d.wins}L | ${pnlStr} | ${cumStr} |`);
}

console.log(`\n=== サマリー ===`);
console.log(`期間: ${tradeDays[0]} 〜 ${tradeDays[tradeDays.length-1]} (${tradeDays.length}営業日)`);
console.log(`取引数: ${totalTrades}件`);
console.log(`勝敗: ${totalWins}W / ${totalTrades - totalWins}L (勝率: ${(totalWins/totalTrades*100).toFixed(1)}%)`);
console.log(`総損益: ${totalPnl >= 0 ? '+' : ''}${totalPnl.toLocaleString()}円`);
console.log(`1日平均: ${Math.round(totalPnl / tradeDays.length).toLocaleString()}円`);

await conn.end();
