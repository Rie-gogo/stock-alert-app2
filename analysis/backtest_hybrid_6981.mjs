/**
 * ハイブリッドエントリー (SHORT) - 村田製作所(6981)専用
 * 
 * Confirm Break Entry OR 3山切り下げv2 のどちらかの条件を満たした時点でエントリー
 * 
 * 【Strategy A: Confirm Break Entry】
 *   Phase 1: Pullback Confirmation条件 (LH>=2, LL>=2, VWAP-0.3%, MA5<MA25, 戻り率20-40%, 陰線転換+次足確認+出来高)
 *   Phase 2: 再度の陰線転換 → 次足で前足安値更新 → エントリー
 * 
 * 【Strategy B: 3山切り下げv2】
 *   ① 3回連続スイングハイ切り下げ (LH >= 3)
 *   ② 始値 > 現在値（全体下落方向）
 *   ③ 陰線転換（前足陽線→今足陰線）
 *   ④ 直近スイングハイ以降に高値更新なし（下降トレンド継続確認）
 *   ⑤ 次足で前足安値更新
 * 
 * 重複防止: 同じ足で両方発火した場合は1回のみエントリー
 * TP: 1.5%, SL: 0.5%, 大引け: 15:20
 */
import mysql from "mysql2/promise";
const conn = await mysql.createConnection(process.env.DATABASE_URL);

const SYMBOL = "6981";
const TP = 0.015;
const SL = 0.005;
const NO_ENTRY_AFTER = "14:50";
const FORCE_EXIT_TIME = "15:20";

const [dayRows] = await conn.query(
  `SELECT DISTINCT tradeDate FROM rt_candles WHERE symbol = ? ORDER BY tradeDate ASC`,
  [SYMBOL]
);
const days = dayRows.map(r => r.tradeDate);

console.log(`=== ハイブリッドエントリー (SHORT) - 村田製作所(6981) ===`);
console.log(`期間: ${days[0]} 〜 ${days[days.length - 1]} (${days.length}営業日)`);
console.log(`Strategy A: Confirm Break Entry (Phase1→Phase2)`);
console.log(`Strategy B: 3山切り下げv2 (LH>=3 + 下降トレンド継続確認)`);
console.log(`ルール: A OR B のどちらかが先に発火 → エントリー`);
console.log(`TP:1.5% SL:0.5% 大引け:15:20\n`);

// ===== ユーティリティ関数 =====

// スイングポイント検出（lookback=2）
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

// スイングハイのみ検出
function detectSwingHighs(candles, upToIdx) {
  const highs = [];
  const lookback = 2;
  const end = Math.min(upToIdx, candles.length - 1);
  for (let i = lookback; i <= end - lookback; i++) {
    const curr = candles[i];
    let isSwingHigh = true;
    for (let j = 1; j <= lookback; j++) {
      if (candles[i - j].high >= curr.high || candles[i + j].high >= curr.high) isSwingHigh = false;
    }
    if (isSwingHigh) highs.push({ price: curr.high, index: i, time: curr.candleTime });
  }
  return highs;
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

// 連続切り下げ回数をカウント
function countConsecutiveLH(swingHighs) {
  if (swingHighs.length < 2) return 0;
  let count = 0;
  for (let i = swingHighs.length - 1; i > 0; i--) {
    if (swingHighs[i].price < swingHighs[i - 1].price) count++;
    else break;
  }
  return count;
}

// 下降トレンド継続確認: 直近SH以降に高値更新なし
function isStillInDowntrend(candles, swingHighs, currentIdx) {
  if (swingHighs.length === 0) return false;
  const lastSH = swingHighs[swingHighs.length - 1];
  for (let i = lastSH.index + 1; i <= currentIdx; i++) {
    if (candles[i].high > lastSH.price) return false;
  }
  return true;
}

// ===== Phase1チェック (Confirm Break Entry) =====
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

// ===== Strategy B: 3山切り下げv2チェック =====
function check3PeakV2(candles, i, openPrice) {
  if (i >= candles.length - 1) return false;
  const candle = candles[i];
  
  // ① 3山連続切り下げ
  const swingHighs = detectSwingHighs(candles, i);
  const consecutiveLH = countConsecutiveLH(swingHighs);
  if (consecutiveLH < 3) return false;
  
  // ② 全体の方向が下落（始値 > 現在値）
  if (openPrice <= candle.close) return false;
  
  // ③ 陰線転換（前足陽線→今足陰線）
  const prevCandle = candles[i - 1];
  if (!(candle.close < candle.open && prevCandle.close >= prevCandle.open)) return false;
  
  // ④ 直近スイングハイ以降に高値更新なし
  if (!isStillInDowntrend(candles, swingHighs, i)) return false;
  
  // ⑤ 次足で前足安値更新
  const nextCandle = candles[i + 1];
  if (!(nextCandle.low < candle.low)) return false;
  
  return true;
}

// ===== メインシミュレーション =====
const allTrades = [];

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
  
  const openPrice = candles[0].open;
  let inPosition = false;
  let entryPrice = 0, entryTime = "", entryIdx = 0;
  let lastEntryIdx = -10;
  
  // Confirm Break ステート管理
  let phase2Active = false;
  let phase2SignalTime = "";
  let phase2SignalIdx = 0;
  let phase2WaitingForBearishTurn = true;
  let phase2BearishIdx = -1;
  
  for (let i = 26; i < candles.length; i++) {
    const candle = candles[i];
    
    // ===== ポジション管理 =====
    if (inPosition) {
      const lossPct = (candle.high - entryPrice) / entryPrice;
      const profitPct = (entryPrice - candle.low) / entryPrice;
      
      if (lossPct >= SL) {
        const exitPrice = entryPrice * (1 + SL);
        const shares = Math.floor(1000000 / entryPrice);
        const pnl = (entryPrice - exitPrice) * shares;
        allTrades.push({ day, entryTime, entryPrice, exitTime: candle.candleTime, exitPrice, pnl, exitReason: "SL", holdBars: i - entryIdx, strategy: allTrades._lastStrategy || "?" });
        inPosition = false;
        continue;
      }
      if (profitPct >= TP) {
        const exitPrice = entryPrice * (1 - TP);
        const shares = Math.floor(1000000 / entryPrice);
        const pnl = (entryPrice - exitPrice) * shares;
        allTrades.push({ day, entryTime, entryPrice, exitTime: candle.candleTime, exitPrice, pnl, exitReason: "TP", holdBars: i - entryIdx, strategy: allTrades._lastStrategy || "?" });
        inPosition = false;
        continue;
      }
      if (candle.candleTime >= FORCE_EXIT_TIME) {
        const exitPrice = candle.close;
        const shares = Math.floor(1000000 / entryPrice);
        const pnl = (entryPrice - exitPrice) * shares;
        allTrades.push({ day, entryTime, entryPrice, exitTime: candle.candleTime, exitPrice, pnl, exitReason: "EOD", holdBars: i - entryIdx, strategy: allTrades._lastStrategy || "?" });
        inPosition = false;
      }
      continue;
    }
    
    // ===== エントリー条件チェック =====
    if (candle.candleTime >= NO_ENTRY_AFTER) { phase2Active = false; continue; }
    if (candle.candleTime < "09:10") continue;
    if (i - lastEntryIdx < 5) continue;
    
    // --- Strategy A: Confirm Break Phase2 (待機中) ---
    if (phase2Active) {
      // タイムアウト: 30本以内
      if (i - phase2SignalIdx > 30) {
        phase2Active = false;
      } else {
        // VWAP/MA条件再確認
        const vwap = calcVWAP(candles, i);
        const ma5 = calcMA(candles, i, 5);
        const ma25 = calcMA(candles, i, 25);
        if (candle.close >= vwap || ma5 === null || ma25 === null || ma5 >= ma25) {
          phase2Active = false;
        } else {
          if (phase2WaitingForBearishTurn) {
            const prevCandle = candles[i - 1];
            if (candle.close < candle.open && prevCandle.close >= prevCandle.open) {
              phase2WaitingForBearishTurn = false;
              phase2BearishIdx = i;
            }
          } else {
            if (i === phase2BearishIdx + 1) {
              const bearishCandle = candles[phase2BearishIdx];
              if (candle.close < candle.open && candle.low < bearishCandle.low) {
                // Strategy A エントリー!
                inPosition = true;
                entryPrice = candle.close;
                entryTime = candle.candleTime;
                entryIdx = i;
                lastEntryIdx = i;
                allTrades._lastStrategy = "ConfirmBreak";
                phase2Active = false;
                continue;
              } else {
                phase2WaitingForBearishTurn = true;
              }
            } else if (i > phase2BearishIdx + 1) {
              phase2WaitingForBearishTurn = true;
              const prevCandle = candles[i - 1];
              if (candle.close < candle.open && prevCandle.close >= prevCandle.open) {
                phase2WaitingForBearishTurn = false;
                phase2BearishIdx = i;
              }
            }
          }
        }
      }
    }
    
    // もしStrategy Aでエントリーしていたらスキップ
    if (inPosition) continue;
    
    // --- Strategy B: 3山切り下げv2 ---
    if (i < candles.length - 1 && check3PeakV2(candles, i, openPrice)) {
      const nextCandle = candles[i + 1];
      inPosition = true;
      entryPrice = nextCandle.close;
      entryTime = nextCandle.candleTime;
      entryIdx = i + 1;
      lastEntryIdx = i + 1;
      allTrades._lastStrategy = "3PeakV2";
      phase2Active = false; // Confirm Break待機もリセット
      i++;
      continue;
    }
    
    // --- Strategy A: Phase1チェック（新規） ---
    if (!phase2Active && i < candles.length - 1) {
      const swings = detectSwingPoints(candles, i);
      if (checkPhase1(candles, i, swings)) {
        phase2Active = true;
        phase2SignalTime = candles[i + 1].candleTime;
        phase2SignalIdx = i + 1;
        phase2WaitingForBearishTurn = true;
        phase2BearishIdx = -1;
        i++; // Phase1確認足をスキップ
      }
    }
  }
  
  // 未決済
  if (inPosition && candles.length > 0) {
    const lastCandle = candles[candles.length - 1];
    const shares = Math.floor(1000000 / entryPrice);
    const pnl = (entryPrice - lastCandle.close) * shares;
    allTrades.push({ day, entryTime, entryPrice, exitTime: lastCandle.candleTime, exitPrice: lastCandle.close, pnl, exitReason: "EOD", holdBars: candles.length - 1 - entryIdx, strategy: allTrades._lastStrategy || "?" });
  }
}

// ===== 結果集計 =====
const wins = allTrades.filter(t => t.pnl > 0);
const losses = allTrades.filter(t => t.pnl <= 0);
const totalPnl = allTrades.reduce((s, t) => s + t.pnl, 0);
const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
const pf = grossLoss > 0 ? grossProfit / grossLoss : Infinity;
const avgHold = allTrades.length > 0 ? allTrades.reduce((s, t) => s + t.holdBars, 0) / allTrades.length : 0;
const expectancy = allTrades.length > 0 ? totalPnl / allTrades.length : 0;
const sl5min = allTrades.filter(t => t.exitReason === "SL" && t.holdBars <= 5).length;

let cumPnl = 0, maxCum = 0, maxDD = 0;
for (const t of allTrades) {
  cumPnl += t.pnl;
  if (cumPnl > maxCum) maxCum = cumPnl;
  const dd = maxCum - cumPnl;
  if (dd > maxDD) maxDD = dd;
}

// Strategy別集計
const cbTrades = allTrades.filter(t => t.strategy === "ConfirmBreak");
const p3Trades = allTrades.filter(t => t.strategy === "3PeakV2");
const cbWins = cbTrades.filter(t => t.pnl > 0);
const p3Wins = p3Trades.filter(t => t.pnl > 0);
const cbPnl = cbTrades.reduce((s, t) => s + t.pnl, 0);
const p3Pnl = p3Trades.reduce((s, t) => s + t.pnl, 0);

console.log("=".repeat(80));
console.log("【ハイブリッド結果】");
console.log("=".repeat(80));
console.log("");
console.log("┌──────────────────────┬──────────────┬──────────────┬──────────────┬──────────────┬──────────────┐");
console.log("│ 指標                 │ Pullback Cfm │ Confirm Brk  │ 3山v1        │ 3山v2        │ **Hybrid**   │");
console.log("├──────────────────────┼──────────────┼──────────────┼──────────────┼──────────────┼──────────────┤");
console.log(`│ 取引数               │ 10件         │ 7件          │ 34件         │ 24件         │ ${String(allTrades.length).padStart(3)}件         │`);
console.log(`│ 勝率                 │ 20.0%        │ 42.9%        │ 32.4%        │ 33.3%        │ ${((wins.length / Math.max(allTrades.length, 1)) * 100).toFixed(1).padStart(5)}%       │`);
console.log(`│ PF                   │ 0.75         │ 2.25         │ 1.43         │ 1.50         │ ${pf === Infinity ? "∞" : pf.toFixed(2).padStart(5)}        │`);
console.log(`│ 総損益               │ -10,081円    │ +24,838円    │ +49,576円    │ +39,753円    │ ${(totalPnl >= 0 ? "+" : "") + Math.round(totalPnl).toLocaleString().padStart(7)}円    │`);
console.log(`│ 最大DD               │ 24,912円     │ 9,975円      │ 29,876円     │ 24,919円     │ ${Math.round(maxDD).toLocaleString().padStart(7)}円    │`);
console.log(`│ 平均保有時間         │ 11.0分       │ 9.7分        │ 12.5分       │ 13.1分       │ ${avgHold.toFixed(1).padStart(5)}分      │`);
console.log(`│ 保有5分以内SL        │ 5件          │ 2件          │ 13件         │ 10件         │ ${String(sl5min).padStart(3)}件         │`);
console.log(`│ 期待値               │ -1,008円     │ +3,548円     │ +1,458円     │ +1,656円     │ ${(expectancy >= 0 ? "+" : "") + Math.round(expectancy).toLocaleString().padStart(6)}円      │`);
console.log("└──────────────────────┴──────────────┴──────────────┴──────────────┴──────────────┴──────────────┘");

// Strategy別内訳
console.log("\n--- Strategy別内訳 ---");
console.log(`  Confirm Break: ${cbTrades.length}件 (${cbWins.length}勝) PnL:${(cbPnl >= 0 ? "+" : "") + Math.round(cbPnl).toLocaleString()}円`);
console.log(`  3山v2:         ${p3Trades.length}件 (${p3Wins.length}勝) PnL:${(p3Pnl >= 0 ? "+" : "") + Math.round(p3Pnl).toLocaleString()}円`);

// 目標判定
console.log("\n--- 目標達成判定 ---");
console.log(`取引数 <=28件:  ${allTrades.length <= 28 ? "✅" : "❌"} (${allTrades.length}件)`);
console.log(`勝率 35%+:      ${(wins.length / Math.max(allTrades.length, 1)) >= 0.35 ? "✅" : "❌"} (${((wins.length / Math.max(allTrades.length, 1)) * 100).toFixed(1)}%)`);
console.log(`PF 1.30+:       ${pf >= 1.30 ? "✅" : "❌"} (${pf === Infinity ? "∞" : pf.toFixed(2)})`);
console.log(`最大DD <=55,473: ${maxDD <= 55473 ? "✅" : "❌"} (${Math.round(maxDD).toLocaleString()}円)`);

// 決済理由別
console.log("\n--- 決済理由別 ---");
for (const reason of ["TP", "SL", "EOD"]) {
  const rTrades = allTrades.filter(t => t.exitReason === reason);
  if (rTrades.length === 0) continue;
  const rPnl = rTrades.reduce((s, t) => s + t.pnl, 0);
  console.log(`${reason.padEnd(4)}: ${String(rTrades.length).padStart(3)}件 | ${(rPnl >= 0 ? "+" : "") + Math.round(rPnl).toLocaleString()}円`);
}

// 日別サマリー
console.log("\n--- 日別サマリー ---");
const dayMap = {};
for (const t of allTrades) {
  if (!dayMap[t.day]) dayMap[t.day] = [];
  dayMap[t.day].push(t);
}
for (const [day, trades] of Object.entries(dayMap)) {
  const dayPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const dayWins = trades.filter(t => t.pnl > 0).length;
  const strategies = trades.map(t => t.strategy === "ConfirmBreak" ? "CB" : "3P").join(",");
  console.log(`  ${day}: ${trades.length}件 (${dayWins}勝) PnL:${(dayPnl >= 0 ? "+" : "") + Math.round(dayPnl).toLocaleString()}円 [${strategies}]`);
}

// 全取引詳細
console.log("\n--- 全取引詳細 ---");
for (const t of allTrades) {
  const strat = t.strategy === "ConfirmBreak" ? "CB" : "3P";
  console.log(`  ${t.day} ${t.entryTime} SHORT @${t.entryPrice.toFixed(0)} → ${t.exitTime} @${t.exitPrice.toFixed(0)} (${t.exitReason}) PnL:${(t.pnl >= 0 ? "+" : "") + Math.round(t.pnl).toLocaleString()}円 [${strat}, ${t.holdBars}本]`);
}

// 本日(7/15)の結果
console.log("\n--- 本日(7/15)の結果 ---");
const todayTrades = allTrades.filter(t => t.day === "2026-07-15");
if (todayTrades.length > 0) {
  for (const t of todayTrades) {
    const strat = t.strategy === "ConfirmBreak" ? "CB" : "3P";
    console.log(`  ${t.entryTime} SHORT @${t.entryPrice.toFixed(0)} → ${t.exitTime} @${t.exitPrice.toFixed(0)} (${t.exitReason}) PnL:${(t.pnl >= 0 ? "+" : "") + Math.round(t.pnl).toLocaleString()}円 [${strat}]`);
  }
  const todayPnl = todayTrades.reduce((s, t) => s + t.pnl, 0);
  console.log(`  合計: ${(todayPnl >= 0 ? "+" : "") + Math.round(todayPnl).toLocaleString()}円`);
} else {
  console.log("  エントリーなし");
}
console.log("  現行ロジック: 10:08 SHORT @8,813 → 10:18 SL @8,857 PnL:-13,219円");

// 重複分析
console.log("\n--- 重複・排他分析 ---");
console.log(`  Confirm Break単独: ${cbTrades.length}件`);
console.log(`  3山v2単独:         ${p3Trades.length}件`);
console.log(`  合計:              ${allTrades.length}件`);
console.log(`  (重複エントリーは同一ポジション中は発生しないため、OR条件で先に発火した方が優先)`);

await conn.end();
