/**
 * Confirm Break Entry (SHORT) - 村田製作所(6981)専用
 * 
 * 【ロジック】
 * Phase 1: Pullback Confirmation条件を満たす（戻り終了シグナル）
 *   - LH >= 2, LL >= 2
 *   - price < VWAP, price <= VWAP - 0.3%
 *   - MA5 < MA25, MA5 slope < 0
 *   - 戻り率 20〜40%
 *   - 陰線転換（前足陽線→今足陰線）
 *   - 次足で陰線安値更新
 *   - 陰線出来高 > 戻り陽線出来高
 * 
 * Phase 2: Confirm Break（即エントリーしない。以下を追加確認）
 *   ① 陰線転換（再度の陰線転換を待つ）
 *   ② 次足で前足安値更新
 *   ③ その時点でSHORTエントリー
 * 
 * TP: 1.5%, SL: 0.5%, 大引け: 15:20
 */
import mysql from "mysql2/promise";
const conn = await mysql.createConnection(process.env.DATABASE_URL);

const SYMBOL = "6981";
const TP = 0.015;
const SL = 0.005;
const NO_ENTRY_AFTER = "14:50";
const FORCE_EXIT_TIME = "15:20";

// 全取引日を取得
const [dayRows] = await conn.query(
  `SELECT DISTINCT tradeDate FROM rt_candles WHERE symbol = ? ORDER BY tradeDate ASC`,
  [SYMBOL]
);
const days = dayRows.map(r => r.tradeDate);

console.log(`=== Confirm Break Entry (SHORT) - 村田製作所(6981) ===`);
console.log(`期間: ${days[0]} 〜 ${days[days.length - 1]} (${days.length}営業日)`);
console.log(`Phase1: LH>=2, LL>=2, VWAP-0.3%, MA5<MA25, MA5↓, 戻り率20-40%, 陰線転換, 次足確認, 出来高確認`);
console.log(`Phase2: 陰線転換 → 次足で前足安値更新 → エントリー\n`);

// スイングポイント検出
function detectSwingPoints(candles, upToIdx) {
  const swings = [];
  const lookback = 2;
  const end = Math.min(upToIdx, candles.length - 1);
  
  for (let i = lookback; i <= end - lookback; i++) {
    const curr = candles[i];
    let isSwingHigh = true;
    let isSwingLow = true;
    
    for (let j = 1; j <= lookback; j++) {
      if (candles[i - j].high >= curr.high || candles[i + j].high >= curr.high) isSwingHigh = false;
      if (candles[i - j].low <= curr.low || candles[i + j].low <= curr.low) isSwingLow = false;
    }
    
    if (isSwingHigh) swings.push({ type: "high", price: curr.high, index: i, time: curr.candleTime });
    if (isSwingLow) swings.push({ type: "low", price: curr.low, index: i, time: curr.candleTime });
  }
  return swings;
}

// VWAP計算
function calcVWAP(candles, upToIdx) {
  let cumVol = 0, cumPV = 0;
  for (let i = 0; i <= upToIdx; i++) {
    const typical = (candles[i].high + candles[i].low + candles[i].close) / 3;
    cumVol += candles[i].volume;
    cumPV += typical * candles[i].volume;
  }
  return cumVol > 0 ? cumPV / cumVol : candles[upToIdx].close;
}

// MA計算
function calcMA(candles, upToIdx, period) {
  if (upToIdx < period - 1) return null;
  let sum = 0;
  for (let i = upToIdx - period + 1; i <= upToIdx; i++) sum += candles[i].close;
  return sum / period;
}

// 戻り率計算
function calcPullbackRatio(candles, swings, currentIdx) {
  const lows = swings.filter(s => s.type === "low" && s.index < currentIdx);
  const highs = swings.filter(s => s.type === "high" && s.index < currentIdx);
  if (lows.length === 0 || highs.length === 0) return null;
  
  const latestLow = lows[lows.length - 1];
  const prevHighs = highs.filter(h => h.index < latestLow.index);
  if (prevHighs.length === 0) return null;
  
  const prevHigh = prevHighs[prevHighs.length - 1];
  const downMove = prevHigh.price - latestLow.price;
  if (downMove <= 0) return null;
  
  let pullbackHigh = latestLow.price;
  for (let i = latestLow.index + 1; i <= currentIdx; i++) {
    if (candles[i].high > pullbackHigh) pullbackHigh = candles[i].high;
  }
  
  const pullback = pullbackHigh - latestLow.price;
  return { ratio: pullback / downMove, latestLowIdx: latestLow.index };
}

// Phase1: Pullback Confirmation条件チェック
function checkPhase1(candles, i, swings) {
  if (i >= candles.length - 1) return false;
  
  const candle = candles[i];
  const nextCandle = candles[i + 1];
  
  // LH >= 2, LL >= 2
  const highs = swings.filter(s => s.type === "high");
  const lows = swings.filter(s => s.type === "low");
  
  let lhCount = 0;
  for (let j = 1; j < highs.length; j++) {
    if (highs[j].price < highs[j - 1].price) lhCount++;
  }
  if (lhCount < 2) return false;
  
  let llCount = 0;
  for (let j = 1; j < lows.length; j++) {
    if (lows[j].price < lows[j - 1].price) llCount++;
  }
  if (llCount < 2) return false;
  
  // VWAP条件
  const vwap = calcVWAP(candles, i);
  if (candle.close >= vwap) return false;
  if (candle.close > vwap * (1 - 0.003)) return false;
  
  // MA条件
  const ma5 = calcMA(candles, i, 5);
  const ma25 = calcMA(candles, i, 25);
  if (ma5 === null || ma25 === null || ma5 >= ma25) return false;
  
  const ma5prev = calcMA(candles, i - 1, 5);
  if (ma5prev === null || ma5 >= ma5prev) return false;
  
  // 戻り率 20〜40%
  const pullbackInfo = calcPullbackRatio(candles, swings, i);
  if (!pullbackInfo || pullbackInfo.ratio < 0.20 || pullbackInfo.ratio > 0.40) return false;
  
  // 陰線転換
  const prevCandle = candles[i - 1];
  if (!(candle.close < candle.open && prevCandle.close >= prevCandle.open)) return false;
  
  // 次足で陰線安値更新
  if (!(nextCandle.close < nextCandle.open && nextCandle.low < candle.low)) return false;
  
  // 出来高: 陰線出来高 > 戻り陽線出来高
  const latestLowIdx = lows.length > 0 ? lows[lows.length - 1].index : 0;
  let bullishVolSum = 0, bullishVolCount = 0;
  for (let j = latestLowIdx + 1; j < i; j++) {
    if (candles[j].close >= candles[j].open) {
      bullishVolSum += candles[j].volume;
      bullishVolCount++;
    }
  }
  const avgBullishVol = bullishVolCount > 0 ? bullishVolSum / bullishVolCount : 0;
  if (candle.volume <= avgBullishVol) return false;
  
  return true;
}

// メインシミュレーション
const allTrades = [];
const phase1Signals = []; // Phase1が発火した記録

for (const day of days) {
  const [candleRows] = await conn.query(
    `SELECT candleTime, open, high, low, close, volume
     FROM rt_candles WHERE symbol = ? AND tradeDate = ?
     ORDER BY candleTime ASC`,
    [SYMBOL, day]
  );
  
  const candles = candleRows.map(r => ({
    candleTime: r.candleTime,
    open: Number(r.open),
    high: Number(r.high),
    low: Number(r.low),
    close: Number(r.close),
    volume: Number(r.volume),
  }));
  
  if (candles.length < 30) continue;
  
  let inPosition = false;
  let entryPrice = 0;
  let entryTime = "";
  let entryIdx = 0;
  let lastEntryIdx = -10;
  
  // Phase2 ステート管理
  let phase2Active = false;
  let phase2SignalTime = "";
  let phase2SignalIdx = 0;
  let phase2WaitingForBearishTurn = true; // Phase2の①陰線転換待ち
  let phase2BearishIdx = -1; // 陰線転換が発生した足のインデックス
  
  for (let i = 26; i < candles.length; i++) {
    const candle = candles[i];
    
    // ポジション管理
    if (inPosition) {
      const lossPct = (candle.high - entryPrice) / entryPrice;
      const profitPct = (entryPrice - candle.low) / entryPrice;
      
      if (lossPct >= SL) {
        const exitPrice = entryPrice * (1 + SL);
        const shares = Math.floor(1000000 / entryPrice);
        const pnl = (entryPrice - exitPrice) * shares;
        allTrades.push({ day, entryTime, entryPrice, exitTime: candle.candleTime, exitPrice, pnl, exitReason: "SL", holdBars: i - entryIdx, phase2Delay: entryIdx - phase2SignalIdx });
        inPosition = false;
        phase2Active = false;
        continue;
      }
      
      if (profitPct >= TP) {
        const exitPrice = entryPrice * (1 - TP);
        const shares = Math.floor(1000000 / entryPrice);
        const pnl = (entryPrice - exitPrice) * shares;
        allTrades.push({ day, entryTime, entryPrice, exitTime: candle.candleTime, exitPrice, pnl, exitReason: "TP", holdBars: i - entryIdx, phase2Delay: entryIdx - phase2SignalIdx });
        inPosition = false;
        phase2Active = false;
        continue;
      }
      
      if (candle.candleTime >= FORCE_EXIT_TIME) {
        const exitPrice = candle.close;
        const shares = Math.floor(1000000 / entryPrice);
        const pnl = (entryPrice - exitPrice) * shares;
        allTrades.push({ day, entryTime, entryPrice, exitTime: candle.candleTime, exitPrice, pnl, exitReason: "EOD", holdBars: i - entryIdx, phase2Delay: entryIdx - phase2SignalIdx });
        inPosition = false;
        phase2Active = false;
        continue;
      }
      continue;
    }
    
    // Phase2: Confirm Break待ち
    if (phase2Active && !inPosition) {
      // タイムアウト: Phase1シグナルから30本以内に確認できなければキャンセル
      if (i - phase2SignalIdx > 30) {
        phase2Active = false;
        continue;
      }
      
      if (candle.candleTime >= NO_ENTRY_AFTER) {
        phase2Active = false;
        continue;
      }
      
      // VWAP/MA条件の再確認（環境が変わっていないか）
      const vwap = calcVWAP(candles, i);
      if (candle.close >= vwap) { phase2Active = false; continue; } // 環境崩壊
      
      const ma5 = calcMA(candles, i, 5);
      const ma25 = calcMA(candles, i, 25);
      if (ma5 === null || ma25 === null || ma5 >= ma25) { phase2Active = false; continue; } // 環境崩壊
      
      if (phase2WaitingForBearishTurn) {
        // ① 陰線転換待ち: 前足が陽線/横ばい → 今足が陰線
        const prevCandle = candles[i - 1];
        const isCurrBearish = candle.close < candle.open;
        const isPrevBullishOrFlat = prevCandle.close >= prevCandle.open;
        
        if (isCurrBearish && isPrevBullishOrFlat) {
          phase2WaitingForBearishTurn = false;
          phase2BearishIdx = i;
        }
      } else {
        // ② 次足で前足安値更新を確認
        // phase2BearishIdxの次の足（= 現在の足）が前足安値を更新しているか
        if (i === phase2BearishIdx + 1) {
          const bearishCandle = candles[phase2BearishIdx];
          const isNextBearish = candle.close < candle.open;
          const breaksLow = candle.low < bearishCandle.low;
          
          if (isNextBearish && breaksLow) {
            // ③ エントリー!
            inPosition = true;
            entryPrice = candle.close;
            entryTime = candle.candleTime;
            entryIdx = i;
            lastEntryIdx = i;
            phase1Signals.push({ day, phase1Time: phase2SignalTime, entryTime: candle.candleTime, delay: i - phase2SignalIdx });
          } else {
            // 安値更新失敗 → 再度陰線転換待ちに戻る
            phase2WaitingForBearishTurn = true;
          }
        } else if (i > phase2BearishIdx + 1) {
          // 確認足を過ぎた → 再度陰線転換待ちに戻る
          phase2WaitingForBearishTurn = true;
          
          // 今足自体が陰線転換かチェック
          const prevCandle = candles[i - 1];
          const isCurrBearish = candle.close < candle.open;
          const isPrevBullishOrFlat = prevCandle.close >= prevCandle.open;
          if (isCurrBearish && isPrevBullishOrFlat) {
            phase2WaitingForBearishTurn = false;
            phase2BearishIdx = i;
          }
        }
      }
      continue;
    }
    
    // Phase1: Pullback Confirmation条件チェック
    if (candle.candleTime >= NO_ENTRY_AFTER) continue;
    if (candle.candleTime < "09:10") continue;
    if (i - lastEntryIdx < 5) continue;
    if (i >= candles.length - 1) continue;
    
    const swings = detectSwingPoints(candles, i);
    
    if (checkPhase1(candles, i, swings)) {
      // Phase1発火 → Phase2に移行（即エントリーしない）
      phase2Active = true;
      phase2SignalTime = candles[i + 1].candleTime; // Phase1確認完了は次足
      phase2SignalIdx = i + 1;
      phase2WaitingForBearishTurn = true;
      phase2BearishIdx = -1;
      i++; // 次足（Phase1の確認足）をスキップ
    }
  }
  
  // 未決済ポジション
  if (inPosition && candles.length > 0) {
    const lastCandle = candles[candles.length - 1];
    const shares = Math.floor(1000000 / entryPrice);
    const pnl = (entryPrice - lastCandle.close) * shares;
    allTrades.push({ day, entryTime, entryPrice, exitTime: lastCandle.candleTime, exitPrice: lastCandle.close, pnl, exitReason: "EOD", holdBars: candles.length - 1 - entryIdx, phase2Delay: entryIdx - phase2SignalIdx });
  }
}

// 結果集計
const wins = allTrades.filter(t => t.pnl > 0);
const losses = allTrades.filter(t => t.pnl <= 0);
const totalPnl = allTrades.reduce((s, t) => s + t.pnl, 0);
const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
const pf = grossLoss > 0 ? grossProfit / grossLoss : Infinity;
const avgHold = allTrades.length > 0 ? allTrades.reduce((s, t) => s + t.holdBars, 0) / allTrades.length : 0;
const expectancy = allTrades.length > 0 ? totalPnl / allTrades.length : 0;
const slCount = allTrades.filter(t => t.exitReason === "SL").length;
const sl5min = allTrades.filter(t => t.exitReason === "SL" && t.holdBars <= 5).length;

let cumPnl = 0, maxCum = 0, maxDD = 0;
for (const t of allTrades) {
  cumPnl += t.pnl;
  if (cumPnl > maxCum) maxCum = cumPnl;
  const dd = maxCum - cumPnl;
  if (dd > maxDD) maxDD = dd;
}

console.log("=".repeat(80));
console.log("【比較結果】");
console.log("=".repeat(80));
console.log("");
console.log("┌──────────────────────┬───────────────────────┬───────────────────────┐");
console.log("│ 指標                 │ Pullback Confirmation │ Confirm Break Entry   │");
console.log("├──────────────────────┼───────────────────────┼───────────────────────┤");
console.log(`│ 取引数               │ 10件                  │ ${String(allTrades.length).padStart(3)}件                  │`);
console.log(`│ 勝率                 │ 20.0%                 │ ${((wins.length / Math.max(allTrades.length, 1)) * 100).toFixed(1).padStart(5)}%                │`);
console.log(`│ PF                   │ 0.75                  │ ${pf.toFixed(2).padStart(5)}                 │`);
console.log(`│ 総損益               │ -10,081円             │ ${(totalPnl >= 0 ? "+" : "") + Math.round(totalPnl).toLocaleString().padStart(8)}円           │`);
console.log(`│ 最大DD               │ 24,912円              │ ${Math.round(maxDD).toLocaleString().padStart(8)}円           │`);
console.log(`│ 平均保有時間         │ 11.0分                │ ${avgHold.toFixed(1).padStart(5)}分               │`);
console.log(`│ 保有5分以内SL        │ 5件                   │ ${String(sl5min).padStart(3)}件                  │`);
console.log(`│ 期待値               │ -1,008円              │ ${(expectancy >= 0 ? "+" : "") + Math.round(expectancy).toLocaleString().padStart(6)}円             │`);
console.log("└──────────────────────┴───────────────────────┴───────────────────────┘");

// 目標達成判定
console.log("\n--- 目標達成判定 ---");
console.log(`取引数半減(<=28): ${allTrades.length <= 28 ? "✅" : "❌"} (${allTrades.length}件)`);
console.log(`勝率35%+:         ${(wins.length / Math.max(allTrades.length, 1)) >= 0.35 ? "✅" : "❌"} (${((wins.length / Math.max(allTrades.length, 1)) * 100).toFixed(1)}%)`);
console.log(`PF 1.30+:         ${pf >= 1.30 ? "✅" : "❌"} (${pf.toFixed(2)})`);
console.log(`最大DD改善:        ${maxDD <= 55473 ? "✅" : "❌"} (${Math.round(maxDD).toLocaleString()}円)`);

// 決済理由別
console.log("\n--- 決済理由別 ---");
for (const reason of ["TP", "SL", "EOD"]) {
  const rTrades = allTrades.filter(t => t.exitReason === reason);
  if (rTrades.length === 0) continue;
  const rPnl = rTrades.reduce((s, t) => s + t.pnl, 0);
  console.log(`${reason.padEnd(4)}: ${String(rTrades.length).padStart(3)}件 | ${(rPnl >= 0 ? "+" : "") + Math.round(rPnl).toLocaleString()}円`);
}

// 全取引詳細
console.log("\n--- 全取引詳細 ---");
for (const t of allTrades) {
  const holdMin = t.holdBars;
  const delay = t.phase2Delay || 0;
  console.log(`  ${t.day} ${t.entryTime} SHORT @${t.entryPrice.toFixed(0)} → ${t.exitTime} @${t.exitPrice.toFixed(0)} (${t.exitReason}) PnL:${(t.pnl >= 0 ? "+" : "") + Math.round(t.pnl).toLocaleString()}円 [保有${holdMin}本, Phase2遅延${delay}本]`);
}

// Phase1発火→Phase2エントリーの遅延分析
console.log("\n--- Phase1→Phase2遅延分析 ---");
for (const s of phase1Signals) {
  console.log(`  ${s.day} Phase1: ${s.phase1Time} → Entry: ${s.entryTime} (遅延${s.delay}本)`);
}

await conn.end();
