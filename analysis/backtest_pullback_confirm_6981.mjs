/**
 * Pullback Confirmation Entry (SHORT) - 村田製作所(6981)専用
 * 
 * 必須条件:
 * ① Lower High >= 2（戻り高値切り下げ2回以上）
 * ② Lower Low >= 2（安値更新2回以上）
 * ③ price < VWAP
 * ④ price <= VWAP - 0.3%
 * ⑤ MA5 < MA25
 * ⑥ MA5 slope < 0（MA5が下向き）
 * ⑦ 戻り率 20〜40%（直近下落幅に対する戻りの割合）
 * ⑧ 陰線転換（前足が陽線/横ばい → 今足が陰線）
 * ⑨ 次足で陰線安値更新（確認足）
 * ⑩ 陰線出来高 > 戻り陽線出来高
 * ⑪ 板スコア >= 1（rt_candlesにはないためrt_board_snapshotsから取得）
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

console.log(`=== Pullback Confirmation Entry (SHORT) - 村田製作所(6981) ===`);
console.log(`期間: ${days[0]} 〜 ${days[days.length - 1]} (${days.length}営業日)`);
console.log(`条件: LH>=2, LL>=2, price<VWAP-0.3%, MA5<MA25, MA5↓, 戻り率20-40%, 陰線転換, 次足確認, 出来高確認, 板スコア>=1\n`);

// 板スコアテーブルの存在確認
let hasBoardData = false;
try {
  const [boardCheck] = await conn.query(
    `SELECT COUNT(*) as cnt FROM rt_board_snapshots WHERE symbol = ? LIMIT 1`,
    [SYMBOL]
  );
  hasBoardData = boardCheck[0].cnt > 0;
} catch (e) {
  // テーブルが存在しない場合
  hasBoardData = false;
}

// 板スコアがない場合はrt_candlesのbidAskImbalanceを使う
let boardScoreSource = "none";
try {
  const [colCheck] = await conn.query(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS 
     WHERE TABLE_NAME = 'rt_candles' AND COLUMN_NAME IN ('bidAskImbalance', 'bid_ask_imbalance', 'boardScore', 'board_score')
     LIMIT 5`
  );
  if (colCheck.length > 0) {
    boardScoreSource = colCheck[0].COLUMN_NAME;
  }
} catch (e) {}

console.log(`板スコアソース: ${hasBoardData ? "rt_board_snapshots" : boardScoreSource || "利用不可(条件⑪スキップ)"}`);

// スイングポイント検出（前後2本で判定）
function detectSwingPoints(candles, upToIdx) {
  const swings = [];
  const lookback = 2;
  const end = Math.min(upToIdx, candles.length - 1);
  
  for (let i = lookback; i <= end - lookback; i++) {
    const curr = candles[i];
    let isSwingHigh = true;
    let isSwingLow = true;
    
    for (let j = 1; j <= lookback; j++) {
      if (candles[i - j].high >= curr.high || candles[i + j].high >= curr.high) {
        isSwingHigh = false;
      }
      if (candles[i - j].low <= curr.low || candles[i + j].low <= curr.low) {
        isSwingLow = false;
      }
    }
    
    if (isSwingHigh) swings.push({ type: "high", price: curr.high, index: i, time: curr.candleTime });
    if (isSwingLow) swings.push({ type: "low", price: curr.low, index: i, time: curr.candleTime });
  }
  
  return swings;
}

// VWAP計算（累積）
function calcVWAP(candles, upToIdx) {
  let cumVol = 0;
  let cumPV = 0;
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
  for (let i = upToIdx - period + 1; i <= upToIdx; i++) {
    sum += candles[i].close;
  }
  return sum / period;
}

// 戻り率計算
function calcPullbackRatio(candles, swings, currentIdx) {
  // 直近のスイングローとその前のスイングハイを見つける
  const lows = swings.filter(s => s.type === "low" && s.index < currentIdx);
  const highs = swings.filter(s => s.type === "high" && s.index < currentIdx);
  
  if (lows.length === 0 || highs.length === 0) return null;
  
  const latestLow = lows[lows.length - 1];
  // latestLowの前のスイングハイを探す
  const prevHighs = highs.filter(h => h.index < latestLow.index);
  if (prevHighs.length === 0) return null;
  
  const prevHigh = prevHighs[prevHighs.length - 1];
  const downMove = prevHigh.price - latestLow.price;
  if (downMove <= 0) return null;
  
  // 現在の戻り = latestLow以降の最高値 - latestLow
  let pullbackHigh = latestLow.price;
  for (let i = latestLow.index + 1; i <= currentIdx; i++) {
    if (candles[i].high > pullbackHigh) pullbackHigh = candles[i].high;
  }
  
  const pullback = pullbackHigh - latestLow.price;
  const ratio = pullback / downMove;
  
  return { ratio, downMove, pullback, prevHigh: prevHigh.price, latestLow: latestLow.price, pullbackHigh };
}

// 板スコア取得（日付・時刻ベース）
async function getBoardScores(day) {
  if (hasBoardData) {
    const [rows] = await conn.query(
      `SELECT snapshotTime, 
              COALESCE(sellPressure, 0) as sell,
              COALESCE(buyPressure, 0) as buy
       FROM rt_board_snapshots 
       WHERE symbol = ? AND tradeDate = ?
       ORDER BY snapshotTime ASC`,
      [SYMBOL, day]
    );
    const map = new Map();
    for (const r of rows) {
      // 板スコア = (売り圧力 - 買い圧力) / (売り圧力 + 買い圧力) * 10
      // >=1 は売り優勢
      const total = Number(r.sell) + Number(r.buy);
      const score = total > 0 ? ((Number(r.sell) - Number(r.buy)) / total) * 10 : 0;
      map.set(r.snapshotTime, score);
    }
    return map;
  }
  return new Map(); // 板データなし
}

// メインシミュレーション
const allTrades = [];
const rejectionLog = { lh: 0, ll: 0, vwap: 0, vwap03: 0, ma: 0, maSlope: 0, pullback: 0, bearish: 0, nextBar: 0, volume: 0, board: 0 };
let totalSignals = 0;

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
  
  const boardScores = await getBoardScores(day);
  
  let inPosition = false;
  let entryPrice = 0;
  let entryTime = "";
  let entryIdx = 0;
  let lastEntryIdx = -10; // 連続エントリー防止
  
  for (let i = 26; i < candles.length - 1; i++) { // -1: 次足確認が必要
    const candle = candles[i];
    const nextCandle = candles[i + 1];
    
    // ポジション管理
    if (inPosition) {
      // TP/SL判定
      const lossPct = (candle.high - entryPrice) / entryPrice;
      const profitPct = (entryPrice - candle.low) / entryPrice;
      
      if (lossPct >= SL) {
        const exitPrice = entryPrice * (1 + SL);
        const shares = Math.floor(1000000 / entryPrice);
        const pnl = (entryPrice - exitPrice) * shares;
        allTrades.push({ day, entryTime, entryPrice, exitTime: candle.candleTime, exitPrice, pnl, exitReason: "SL", holdBars: i - entryIdx });
        inPosition = false;
        continue;
      }
      
      if (profitPct >= TP) {
        const exitPrice = entryPrice * (1 - TP);
        const shares = Math.floor(1000000 / entryPrice);
        const pnl = (entryPrice - exitPrice) * shares;
        allTrades.push({ day, entryTime, entryPrice, exitTime: candle.candleTime, exitPrice, pnl, exitReason: "TP", holdBars: i - entryIdx });
        inPosition = false;
        continue;
      }
      
      if (candle.candleTime >= FORCE_EXIT_TIME) {
        const exitPrice = candle.close;
        const shares = Math.floor(1000000 / entryPrice);
        const pnl = (entryPrice - exitPrice) * shares;
        allTrades.push({ day, entryTime, entryPrice, exitTime: candle.candleTime, exitPrice, pnl, exitReason: "EOD", holdBars: i - entryIdx });
        inPosition = false;
        continue;
      }
      continue;
    }
    
    // エントリー判定
    if (candle.candleTime >= NO_ENTRY_AFTER) continue;
    if (candle.candleTime < "09:10") continue; // 寄付き直後除外
    if (i - lastEntryIdx < 5) continue; // 連続エントリー防止（5本間隔）
    
    // ① ② スイングポイント確認
    const swings = detectSwingPoints(candles, i);
    const highs = swings.filter(s => s.type === "high");
    const lows = swings.filter(s => s.type === "low");
    
    let lhCount = 0;
    for (let j = 1; j < highs.length; j++) {
      if (highs[j].price < highs[j - 1].price) lhCount++;
    }
    if (lhCount < 2) { rejectionLog.lh++; continue; }
    
    let llCount = 0;
    for (let j = 1; j < lows.length; j++) {
      if (lows[j].price < lows[j - 1].price) llCount++;
    }
    if (llCount < 2) { rejectionLog.ll++; continue; }
    
    // ③ ④ VWAP条件
    const vwap = calcVWAP(candles, i);
    if (candle.close >= vwap) { rejectionLog.vwap++; continue; }
    if (candle.close > vwap * (1 - 0.003)) { rejectionLog.vwap03++; continue; }
    
    // ⑤ MA5 < MA25
    const ma5 = calcMA(candles, i, 5);
    const ma25 = calcMA(candles, i, 25);
    if (ma5 === null || ma25 === null || ma5 >= ma25) { rejectionLog.ma++; continue; }
    
    // ⑥ MA5 slope < 0
    const ma5prev = calcMA(candles, i - 1, 5);
    if (ma5prev === null || ma5 >= ma5prev) { rejectionLog.maSlope++; continue; }
    
    // ⑦ 戻り率 20〜40%
    const pullbackInfo = calcPullbackRatio(candles, swings, i);
    if (!pullbackInfo || pullbackInfo.ratio < 0.20 || pullbackInfo.ratio > 0.40) { rejectionLog.pullback++; continue; }
    
    // ⑧ 陰線転換（前足が陽線/横ばい → 今足が陰線）
    const prevCandle = candles[i - 1];
    const isCurrBearish = candle.close < candle.open;
    const isPrevBullishOrFlat = prevCandle.close >= prevCandle.open;
    if (!isCurrBearish || !isPrevBullishOrFlat) { rejectionLog.bearish++; continue; }
    
    // ⑨ 次足で陰線安値更新
    const isNextBearish = nextCandle.close < nextCandle.open;
    const isNextLowerLow = nextCandle.low < candle.low;
    if (!isNextBearish || !isNextLowerLow) { rejectionLog.nextBar++; continue; }
    
    // ⑩ 陰線出来高 > 戻り陽線出来高
    // 戻り陽線 = 直近スイングロー以降の陽線の平均出来高
    const latestLowIdx = lows.length > 0 ? lows[lows.length - 1].index : 0;
    let bullishVolSum = 0, bullishVolCount = 0;
    for (let j = latestLowIdx + 1; j < i; j++) {
      if (candles[j].close >= candles[j].open) {
        bullishVolSum += candles[j].volume;
        bullishVolCount++;
      }
    }
    const avgBullishVol = bullishVolCount > 0 ? bullishVolSum / bullishVolCount : 0;
    if (candle.volume <= avgBullishVol) { rejectionLog.volume++; continue; }
    
    // ⑪ 板スコア >= 1
    if (boardScores.size > 0) {
      // 最も近い時刻の板スコアを取得
      let bestScore = 0;
      let bestDiff = Infinity;
      for (const [time, score] of boardScores) {
        // 簡易的に時刻文字列比較
        if (time <= candle.candleTime) {
          bestScore = score;
        }
      }
      if (bestScore < 1) { rejectionLog.board++; continue; }
    }
    // 板データがない場合は条件⑪をスキップ
    
    totalSignals++;
    
    // エントリー: 次足のclose（確認完了後）
    inPosition = true;
    entryPrice = nextCandle.close;
    entryTime = nextCandle.candleTime;
    entryIdx = i + 1;
    lastEntryIdx = i + 1;
  }
  
  // 未決済ポジション
  if (inPosition && candles.length > 0) {
    const lastCandle = candles[candles.length - 1];
    const shares = Math.floor(1000000 / entryPrice);
    const pnl = (entryPrice - lastCandle.close) * shares;
    allTrades.push({ day, entryTime, entryPrice, exitTime: lastCandle.candleTime, exitPrice: lastCandle.close, pnl, exitReason: "EOD", holdBars: candles.length - 1 - entryIdx });
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

// 最大DD
let cumPnl = 0, maxCum = 0, maxDD = 0;
for (const t of allTrades) {
  cumPnl += t.pnl;
  if (cumPnl > maxCum) maxCum = cumPnl;
  const dd = maxCum - cumPnl;
  if (dd > maxDD) maxDD = dd;
}

console.log("\n" + "=".repeat(80));
console.log("【結果サマリー】");
console.log("=".repeat(80));
console.log(`取引数:     ${allTrades.length}件 (目標: 28件以下 = 56件の半分)`);
console.log(`勝率:       ${((wins.length / Math.max(allTrades.length, 1)) * 100).toFixed(1)}% (目標: 35%以上)`);
console.log(`PF:         ${pf.toFixed(2)} (目標: 1.30以上)`);
console.log(`期待値:     ${expectancy >= 0 ? "+" : ""}${expectancy.toFixed(0)}円/取引`);
console.log(`総損益:     ${totalPnl >= 0 ? "+" : ""}${totalPnl.toLocaleString()}円`);
console.log(`最大DD:     ${maxDD.toLocaleString()}円 (前回: 55,473円)`);
console.log(`平均保有:   ${avgHold.toFixed(1)}分`);
console.log(`損切り率:   ${((allTrades.filter(t => t.exitReason === "SL").length / Math.max(allTrades.length, 1)) * 100).toFixed(1)}%`);

console.log("\n--- 目標達成判定 ---");
console.log(`取引数半減: ${allTrades.length <= 28 ? "✅" : "❌"} (${allTrades.length}件 / 目標28件以下)`);
console.log(`勝率35%+:   ${(wins.length / Math.max(allTrades.length, 1)) >= 0.35 ? "✅" : "❌"} (${((wins.length / Math.max(allTrades.length, 1)) * 100).toFixed(1)}%)`);
console.log(`PF 1.30+:   ${pf >= 1.30 ? "✅" : "❌"} (${pf.toFixed(2)})`);
console.log(`最大DD改善: ${maxDD <= 55473 ? "✅" : "❌"} (${maxDD.toLocaleString()}円)`);

// 決済理由別
console.log("\n--- 決済理由別 ---");
for (const reason of ["TP", "SL", "EOD"]) {
  const rTrades = allTrades.filter(t => t.exitReason === reason);
  if (rTrades.length === 0) continue;
  const rPnl = rTrades.reduce((s, t) => s + t.pnl, 0);
  console.log(`${reason.padEnd(4)}: ${String(rTrades.length).padStart(3)}件 | ${(rPnl >= 0 ? "+" : "") + rPnl.toLocaleString()}円`);
}

// 全取引詳細
console.log("\n--- 全取引詳細 ---");
for (const t of allTrades) {
  console.log(`  ${t.day} ${t.entryTime} SHORT @${t.entryPrice.toFixed(0)} → ${t.exitTime} @${t.exitPrice.toFixed(0)} (${t.exitReason}) PnL:${(t.pnl >= 0 ? "+" : "") + Math.round(t.pnl).toLocaleString()}円 [${t.holdBars}本]`);
}

// フィルター別リジェクト数
console.log("\n--- フィルター別リジェクト数 ---");
console.log(`① LH<2:        ${rejectionLog.lh.toLocaleString()}回`);
console.log(`② LL<2:        ${rejectionLog.ll.toLocaleString()}回`);
console.log(`③ price>=VWAP:  ${rejectionLog.vwap.toLocaleString()}回`);
console.log(`④ price>VWAP-0.3%: ${rejectionLog.vwap03.toLocaleString()}回`);
console.log(`⑤ MA5>=MA25:    ${rejectionLog.ma.toLocaleString()}回`);
console.log(`⑥ MA5 slope>=0: ${rejectionLog.maSlope.toLocaleString()}回`);
console.log(`⑦ 戻り率範囲外: ${rejectionLog.pullback.toLocaleString()}回`);
console.log(`⑧ 陰線転換なし: ${rejectionLog.bearish.toLocaleString()}回`);
console.log(`⑨ 次足確認失敗: ${rejectionLog.nextBar.toLocaleString()}回`);
console.log(`⑩ 出来高不足:   ${rejectionLog.volume.toLocaleString()}回`);
console.log(`⑪ 板スコア<1:   ${rejectionLog.board.toLocaleString()}回`);
console.log(`→ 通過(エントリー): ${totalSignals}件`);

await conn.end();
