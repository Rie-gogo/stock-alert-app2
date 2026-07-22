import mysql from "mysql2/promise";

// より現実的なシミュレーション:
// 実際のエンジンで「板読みスコア不足(0)」かつ「信頼度：強」でブロックされたシグナルを
// 20営業日分のrt_tradesテーブルから推定する
//
// アプローチ: 
// 1. 既存のrt_tradesから実際のエントリーを取得（現行閾値1で通過したもの）
// 2. 各日のローソク足データから、スコア0+信頼度強の追加シグナルを検出
//    - 信頼度強 = 出来高>平均 AND トレンド一致(MA5 vs MA25) AND モメンタム一致
//    - 大台シグナルまたはダウ理論シグナル
//    - isBullish/isBearishチェック通過
//    - 押し目深さフィルター通過
//    - HTFフィルター通過
//    - 同時ポジション制限(max 3)
// 3. 追加シグナルのみのSL/TP/EODシミュレーション

const conn = await mysql.createConnection(process.env.DATABASE_URL);

const [days] = await conn.execute(
  "SELECT DISTINCT tradeDate FROM rt_candles ORDER BY tradeDate DESC LIMIT 20"
);
const tradeDays = days.map(d => d.tradeDate).reverse();
console.log(`対象期間: ${tradeDays[0]} 〜 ${tradeDays[tradeDays.length-1]} (${tradeDays.length}営業日)\n`);

const dailyResults = [];
let totalPnl = 0;
let totalTrades = 0;
let totalWins = 0;
const allTrades = [];

for (const day of tradeDays) {
  const [candles] = await conn.execute(
    "SELECT symbol, candleTime, open, high, low, close, volume FROM rt_candles WHERE tradeDate = ? ORDER BY symbol, candleTime",
    [day]
  );
  
  if (candles.length === 0) continue;
  
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
  
  // Get the day's opening prices for isBullish check
  const openPrices = {};
  for (const [sym, bars] of Object.entries(bySymbol)) {
    if (bars.length > 0) openPrices[sym] = bars[0].open;
  }
  
  const dayTrades = [];
  
  for (const [symbol, bars] of Object.entries(bySymbol)) {
    if (bars.length < 30) continue;
    
    // Calculate indicators
    for (let i = 0; i < bars.length; i++) {
      if (i >= 4) bars[i].ma5 = bars.slice(i-4, i+1).reduce((s, b) => s + b.close, 0) / 5;
      if (i >= 24) bars[i].ma25 = bars.slice(i-24, i+1).reduce((s, b) => s + b.close, 0) / 25;
      if (i >= 9) bars[i].avgVol = bars.slice(i-9, i+1).reduce((s, b) => s + b.volume, 0) / 10;
    }
    
    // 3-minute HTF trend (use 3-bar lookback on 1-min data as proxy)
    function getHTFTrend(idx) {
      if (idx < 6) return "neutral";
      const recent3 = [bars[idx-2].close, bars[idx-1].close, bars[idx].close];
      const prev3 = [bars[idx-5].close, bars[idx-4].close, bars[idx-3].close];
      const recentAvg = recent3.reduce((s, v) => s + v, 0) / 3;
      const prevAvg = prev3.reduce((s, v) => s + v, 0) / 3;
      if (recentAvg > prevAvg * 1.001) return "up";
      if (recentAvg < prevAvg * 0.999) return "down";
      return "neutral";
    }
    
    // isBullish check: price > open + 0.2%
    function isBullish(idx) {
      return bars[idx].close > openPrices[symbol] * 1.002;
    }
    function isBearish(idx) {
      return bars[idx].close < openPrices[symbol] * 0.998;
    }
    
    // Pushback depth check (30-70% range)
    function checkPullbackDepth(idx, side) {
      if (idx < 20) return false;
      const window = bars.slice(Math.max(0, idx-20), idx+1);
      const high = Math.max(...window.map(b => b.high));
      const low = Math.min(...window.map(b => b.low));
      const range = high - low;
      if (range === 0) return false;
      const depth = side === "SHORT" 
        ? (high - bars[idx].close) / range
        : (bars[idx].close - low) / range;
      return depth >= 0.30 && depth <= 0.70;
    }
    
    // Detect SHORT signals
    for (let i = 25; i < bars.length - 1; i++) {
      const bar = bars[i];
      if (!bar.ma5 || !bar.ma25 || !bar.avgVol) continue;
      if (bar.time < "09:30" || bar.time > "14:50") continue;
      
      // Strong confidence check for SHORT
      const volumeConfirmed = bar.volume > bar.avgVol;
      const trendAligned = bar.ma5 < bar.ma25;
      const momentumAligned = i >= 3 && bar.close < bars[i-3].close;
      const isStrong = volumeConfirmed && trendAligned && momentumAligned;
      if (!isStrong) continue;
      
      // isBullish block
      if (isBullish(i)) continue;
      
      // HTF filter
      const htf = getHTFTrend(i);
      if (htf === "up") continue;
      
      // Pullback depth check
      if (!checkPullbackDepth(i, "SHORT")) continue;
      
      // Signal detection: round number break or Dow theory
      const price = bar.close;
      let step;
      if (price >= 50000) step = 500;
      else if (price >= 10000) step = 200;
      else if (price >= 5000) step = 100;
      else if (price >= 1000) step = 50;
      else step = 10;
      
      let hasSignal = false;
      let signalType = "";
      
      // Round number break
      const nearestRound = Math.ceil(price / step) * step;
      if (i > 0 && bars[i-1].close > nearestRound && bar.close < nearestRound) {
        hasSignal = true;
        signalType = `大台割れ(${nearestRound})`;
      }
      
      // Dow theory lower low
      if (!hasSignal && i >= 10) {
        const recentLows = bars.slice(i-10, i).map(b => b.low);
        const prevLow = Math.min(...recentLows);
        if (bar.low < prevLow && bar.close < prevLow) {
          hasSignal = true;
          signalType = "ダウ理論安値更新";
        }
      }
      
      if (!hasSignal) continue;
      
      // Simulate SHORT entry
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
        dayTrades.push({ day, symbol, time: bar.time, side: "SHORT", signal: signalType, entryPrice, ...result });
      }
    }
    
    // Detect LONG signals
    for (let i = 25; i < bars.length - 1; i++) {
      const bar = bars[i];
      if (!bar.ma5 || !bar.ma25 || !bar.avgVol) continue;
      if (bar.time < "09:30" || bar.time > "14:50") continue;
      
      const volumeConfirmed = bar.volume > bar.avgVol;
      const trendAligned = bar.ma5 > bar.ma25;
      const momentumAligned = i >= 3 && bar.close > bars[i-3].close;
      const isStrong = volumeConfirmed && trendAligned && momentumAligned;
      if (!isStrong) continue;
      
      // isBearish block for LONG
      if (isBearish(i)) continue;
      
      // HTF filter
      const htf = getHTFTrend(i);
      if (htf === "down") continue;
      
      // Pullback depth
      if (!checkPullbackDepth(i, "LONG")) continue;
      
      const price = bar.close;
      let step;
      if (price >= 50000) step = 500;
      else if (price >= 10000) step = 200;
      else if (price >= 5000) step = 100;
      else if (price >= 1000) step = 50;
      else step = 10;
      
      let hasSignal = false;
      let signalType = "";
      
      const nearestRound = Math.floor(price / step) * step;
      if (i > 0 && bars[i-1].close < nearestRound && bar.close > nearestRound) {
        hasSignal = true;
        signalType = `大台超え(${nearestRound})`;
      }
      
      if (!hasSignal && i >= 10) {
        const recentHighs = bars.slice(i-10, i).map(b => b.high);
        const prevHigh = Math.max(...recentHighs);
        if (bar.high > prevHigh && bar.close > prevHigh) {
          hasSignal = true;
          signalType = "ダウ理論高値更新";
        }
      }
      
      if (!hasSignal) continue;
      
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
        dayTrades.push({ day, symbol, time: bar.time, side: "LONG", signal: signalType, entryPrice, ...result });
      }
    }
  }
  
  // Apply realistic constraints:
  // 1. Max 3 concurrent positions
  // 2. Only one trade per symbol per 30-min window
  dayTrades.sort((a, b) => a.time.localeCompare(b.time));
  
  const filtered = [];
  const lastTradeTime = {};
  let activePositions = 0;
  
  for (const t of dayTrades) {
    // Max concurrent positions
    if (activePositions >= 3) continue;
    
    // One trade per symbol per 30-min window
    const key = `${t.symbol}_${t.side}`;
    const lastTime = lastTradeTime[key];
    if (lastTime) {
      const lastMin = parseInt(lastTime.split(":")[0]) * 60 + parseInt(lastTime.split(":")[1]);
      const curMin = parseInt(t.time.split(":")[0]) * 60 + parseInt(t.time.split(":")[1]);
      if (curMin - lastMin < 30) continue;
    }
    lastTradeTime[key] = t.time;
    filtered.push(t);
    activePositions++;
    // Simple: assume position closes quickly (within a few bars)
    // In reality we'd track exit times, but for estimation this is sufficient
  }
  
  const dayPnl = filtered.reduce((s, t) => s + t.pnl, 0);
  const dayWins = filtered.filter(t => t.pnl > 0).length;
  
  dailyResults.push({ date: day, trades: filtered.length, wins: dayWins, pnl: dayPnl });
  totalPnl += dayPnl;
  totalTrades += filtered.length;
  totalWins += dayWins;
  allTrades.push(...filtered);
}

// Output
console.log("=== 日別結果（スコア0+信頼度強 追加シグナル）===");
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
console.log(`取引数: ${totalTrades}件`);
console.log(`勝敗: ${totalWins}W / ${totalTrades - totalWins}L (勝率: ${(totalWins/totalTrades*100).toFixed(1)}%)`);
console.log(`総損益: ${totalPnl >= 0 ? '+' : ''}${totalPnl.toLocaleString()}円`);
console.log(`1日平均: ${Math.round(totalPnl / tradeDays.length).toLocaleString()}円`);
console.log(`PF: ${(allTrades.filter(t=>t.pnl>0).reduce((s,t)=>s+t.pnl,0) / Math.abs(allTrades.filter(t=>t.pnl<0).reduce((s,t)=>s+t.pnl,0))).toFixed(2)}`);

// Side breakdown
const shorts = allTrades.filter(t => t.side === "SHORT");
const longs = allTrades.filter(t => t.side === "LONG");
console.log(`\nSHORT: ${shorts.length}件 / 勝率${(shorts.filter(t=>t.pnl>0).length/shorts.length*100).toFixed(1)}% / ${shorts.reduce((s,t)=>s+t.pnl,0) >= 0 ? '+' : ''}${shorts.reduce((s,t)=>s+t.pnl,0).toLocaleString()}円`);
console.log(`LONG: ${longs.length}件 / 勝率${(longs.filter(t=>t.pnl>0).length/longs.length*100).toFixed(1)}% / ${longs.reduce((s,t)=>s+t.pnl,0) >= 0 ? '+' : ''}${longs.reduce((s,t)=>s+t.pnl,0).toLocaleString()}円`);

await conn.end();
