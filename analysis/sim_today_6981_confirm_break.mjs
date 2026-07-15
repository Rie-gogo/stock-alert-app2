/**
 * 本日(7/15)前場 村田製作所(6981) Confirm Break Entry シミュレーション
 */
import mysql from "mysql2/promise";
const conn = await mysql.createConnection(process.env.DATABASE_URL);

const SYMBOL = "6981";
const TP = 0.015;
const SL = 0.005;
const NO_ENTRY_AFTER = "14:50";
const FORCE_EXIT_TIME = "15:20";

// 本日のキャンドルデータ取得
const [candleRows] = await conn.query(
  `SELECT candleTime, open, high, low, close, volume
   FROM rt_candles WHERE symbol = ? AND tradeDate = '2026-07-15'
   ORDER BY candleTime ASC`,
  [SYMBOL]
);

const candles = candleRows.map(r => ({
  candleTime: r.candleTime,
  open: Number(r.open),
  high: Number(r.high),
  low: Number(r.low),
  close: Number(r.close),
  volume: Number(r.volume),
}));

console.log(`=== 本日(7/15) 村田製作所(6981) Confirm Break Entry シミュレーション ===`);
console.log(`キャンドル数: ${candles.length} (${candles[0]?.candleTime} 〜 ${candles[candles.length-1]?.candleTime})`);
console.log(`始値: ${candles[0]?.open}  現在値: ${candles[candles.length-1]?.close}`);
console.log(`\n--- 値動き概要 ---`);

// 高値・安値
let dayHigh = 0, dayLow = Infinity;
for (const c of candles) {
  if (c.high > dayHigh) dayHigh = c.high;
  if (c.low < dayLow) dayLow = c.low;
}
console.log(`日中高値: ${dayHigh}  日中安値: ${dayLow}  値幅: ${dayHigh - dayLow}`);

// スイングポイント検出
function detectSwingPoints(candles, upToIdx) {
  const swings = [];
  const lookback = 2;
  const end = Math.min(upToIdx, candles.length - 1);
  for (let i = lookback; i <= end - lookback; i++) {
    const curr = candles[i];
    let isSwingHigh = true, isSwingLow = true;
    for (let j = 1; j <= lookback; j++) {
      if (candles[i - j].high >= curr.high || candles[i + j].high >= curr.high) isSwingHigh = false;
      if (candles[i - j].low <= curr.low || candles[i + j].low <= curr.low) isSwingLow = false;
    }
    if (isSwingHigh) swings.push({ type: "high", price: curr.high, index: i, time: curr.candleTime });
    if (isSwingLow) swings.push({ type: "low", price: curr.low, index: i, time: curr.candleTime });
  }
  return swings;
}

function calcVWAP(candles, upToIdx) {
  let cumVol = 0, cumPV = 0;
  for (let i = 0; i <= upToIdx; i++) {
    const typical = (candles[i].high + candles[i].low + candles[i].close) / 3;
    cumVol += candles[i].volume;
    cumPV += typical * candles[i].volume;
  }
  return cumVol > 0 ? cumPV / cumVol : candles[upToIdx].close;
}

function calcMA(candles, upToIdx, period) {
  if (upToIdx < period - 1) return null;
  let sum = 0;
  for (let i = upToIdx - period + 1; i <= upToIdx; i++) sum += candles[i].close;
  return sum / period;
}

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
  return { ratio: pullback / downMove, latestLowIdx: latestLow.index, latestLow: latestLow.price, prevHigh: prevHigh.price, pullbackHigh };
}

// Phase1チェック
function checkPhase1(candles, i, swings) {
  if (i >= candles.length - 1) return null;
  const candle = candles[i];
  const nextCandle = candles[i + 1];
  
  const highs = swings.filter(s => s.type === "high");
  const lows = swings.filter(s => s.type === "low");
  
  let lhCount = 0;
  for (let j = 1; j < highs.length; j++) {
    if (highs[j].price < highs[j - 1].price) lhCount++;
  }
  if (lhCount < 2) return { reject: "LH<2", lhCount };
  
  let llCount = 0;
  for (let j = 1; j < lows.length; j++) {
    if (lows[j].price < lows[j - 1].price) llCount++;
  }
  if (llCount < 2) return { reject: "LL<2", llCount };
  
  const vwap = calcVWAP(candles, i);
  if (candle.close >= vwap) return { reject: "price>=VWAP", close: candle.close, vwap };
  if (candle.close > vwap * (1 - 0.003)) return { reject: "price>VWAP-0.3%", close: candle.close, threshold: vwap * (1 - 0.003) };
  
  const ma5 = calcMA(candles, i, 5);
  const ma25 = calcMA(candles, i, 25);
  if (ma5 === null || ma25 === null || ma5 >= ma25) return { reject: "MA5>=MA25", ma5, ma25 };
  
  const ma5prev = calcMA(candles, i - 1, 5);
  if (ma5prev === null || ma5 >= ma5prev) return { reject: "MA5 slope>=0", ma5, ma5prev };
  
  const pullbackInfo = calcPullbackRatio(candles, swings, i);
  if (!pullbackInfo || pullbackInfo.ratio < 0.20 || pullbackInfo.ratio > 0.40) return { reject: "戻り率範囲外", ratio: pullbackInfo?.ratio };
  
  const prevCandle = candles[i - 1];
  if (!(candle.close < candle.open && prevCandle.close >= prevCandle.open)) return { reject: "陰線転換なし" };
  
  if (!(nextCandle.close < nextCandle.open && nextCandle.low < candle.low)) return { reject: "次足確認失敗" };
  
  const latestLowIdx = lows.length > 0 ? lows[lows.length - 1].index : 0;
  let bullishVolSum = 0, bullishVolCount = 0;
  for (let j = latestLowIdx + 1; j < i; j++) {
    if (candles[j].close >= candles[j].open) {
      bullishVolSum += candles[j].volume;
      bullishVolCount++;
    }
  }
  const avgBullishVol = bullishVolCount > 0 ? bullishVolSum / bullishVolCount : 0;
  if (candle.volume <= avgBullishVol) return { reject: "出来高不足", vol: candle.volume, avgBullVol: avgBullishVol };
  
  return { pass: true, lhCount, llCount, vwap, ma5, ma25, pullbackRatio: pullbackInfo.ratio, pullbackInfo };
}

// シミュレーション実行（詳細ログ付き）
console.log("\n--- Phase1条件チェック詳細ログ ---");

let inPosition = false;
let entryPrice = 0, entryTime = "", entryIdx = 0;
let phase2Active = false, phase2SignalTime = "", phase2SignalIdx = 0;
let phase2WaitingForBearishTurn = true, phase2BearishIdx = -1;
let lastEntryIdx = -10;
const trades = [];
let phase1Count = 0;

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
      trades.push({ entryTime, entryPrice, exitTime: candle.candleTime, exitPrice, pnl, exitReason: "SL", holdBars: i - entryIdx });
      console.log(`  ★ SL: ${candle.candleTime} @${exitPrice.toFixed(0)} PnL:${Math.round(pnl).toLocaleString()}円`);
      inPosition = false;
      phase2Active = false;
      continue;
    }
    if (profitPct >= TP) {
      const exitPrice = entryPrice * (1 - TP);
      const shares = Math.floor(1000000 / entryPrice);
      const pnl = (entryPrice - exitPrice) * shares;
      trades.push({ entryTime, entryPrice, exitTime: candle.candleTime, exitPrice, pnl, exitReason: "TP", holdBars: i - entryIdx });
      console.log(`  ★ TP: ${candle.candleTime} @${exitPrice.toFixed(0)} PnL:+${Math.round(pnl).toLocaleString()}円`);
      inPosition = false;
      phase2Active = false;
      continue;
    }
    if (candle.candleTime >= FORCE_EXIT_TIME) {
      const exitPrice = candle.close;
      const shares = Math.floor(1000000 / entryPrice);
      const pnl = (entryPrice - exitPrice) * shares;
      trades.push({ entryTime, entryPrice, exitTime: candle.candleTime, exitPrice, pnl, exitReason: "EOD", holdBars: i - entryIdx });
      console.log(`  ★ EOD: ${candle.candleTime} @${exitPrice.toFixed(0)} PnL:${Math.round(pnl).toLocaleString()}円`);
      inPosition = false;
      phase2Active = false;
    }
    continue;
  }
  
  // Phase2処理
  if (phase2Active) {
    if (i - phase2SignalIdx > 30 || candle.candleTime >= NO_ENTRY_AFTER) {
      console.log(`  Phase2タイムアウト @${candle.candleTime}`);
      phase2Active = false;
      continue;
    }
    
    const vwap = calcVWAP(candles, i);
    if (candle.close >= vwap) { console.log(`  Phase2環境崩壊(VWAP) @${candle.candleTime}`); phase2Active = false; continue; }
    const ma5 = calcMA(candles, i, 5);
    const ma25 = calcMA(candles, i, 25);
    if (ma5 === null || ma25 === null || ma5 >= ma25) { console.log(`  Phase2環境崩壊(MA) @${candle.candleTime}`); phase2Active = false; continue; }
    
    if (phase2WaitingForBearishTurn) {
      const prevCandle = candles[i - 1];
      const isCurrBearish = candle.close < candle.open;
      const isPrevBullishOrFlat = prevCandle.close >= prevCandle.open;
      if (isCurrBearish && isPrevBullishOrFlat) {
        console.log(`  Phase2①陰線転換検出 @${candle.candleTime} (O:${candle.open} C:${candle.close})`);
        phase2WaitingForBearishTurn = false;
        phase2BearishIdx = i;
      }
    } else {
      if (i === phase2BearishIdx + 1) {
        const bearishCandle = candles[phase2BearishIdx];
        const isNextBearish = candle.close < candle.open;
        const breaksLow = candle.low < bearishCandle.low;
        if (isNextBearish && breaksLow) {
          console.log(`  ★ Phase2②確認完了→エントリー @${candle.candleTime} SHORT @${candle.close}`);
          inPosition = true;
          entryPrice = candle.close;
          entryTime = candle.candleTime;
          entryIdx = i;
          lastEntryIdx = i;
        } else {
          console.log(`  Phase2②確認失敗 @${candle.candleTime} (陰線:${isNextBearish}, 安値更新:${breaksLow}, 前足安値:${bearishCandle.low}, 今足安値:${candle.low})`);
          phase2WaitingForBearishTurn = true;
          // 今足自体が陰線転換かチェック
          const prevC = candles[i - 1];
          if (candle.close < candle.open && prevC.close >= prevC.open) {
            phase2WaitingForBearishTurn = false;
            phase2BearishIdx = i;
            console.log(`  → 今足自体が陰線転換 @${candle.candleTime}`);
          }
        }
      } else if (i > phase2BearishIdx + 1) {
        phase2WaitingForBearishTurn = true;
        const prevC = candles[i - 1];
        if (candle.close < candle.open && prevC.close >= prevC.open) {
          phase2WaitingForBearishTurn = false;
          phase2BearishIdx = i;
        }
      }
    }
    continue;
  }
  
  // Phase1チェック
  if (candle.candleTime >= NO_ENTRY_AFTER) continue;
  if (candle.candleTime < "09:10") continue;
  if (i - lastEntryIdx < 5) continue;
  if (i >= candles.length - 1) continue;
  
  const swings = detectSwingPoints(candles, i);
  const result = checkPhase1(candles, i, swings);
  
  if (result && result.pass) {
    phase1Count++;
    console.log(`\n[Phase1発火] ${candle.candleTime} @${candle.close}`);
    console.log(`  LH:${result.lhCount} LL:${result.llCount} VWAP:${result.vwap.toFixed(0)} MA5:${result.ma5.toFixed(0)} MA25:${result.ma25.toFixed(0)} 戻り率:${(result.pullbackRatio*100).toFixed(1)}%`);
    console.log(`  → Phase2移行（陰線転換+安値更新待ち）`);
    phase2Active = true;
    phase2SignalTime = candles[i + 1].candleTime;
    phase2SignalIdx = i + 1;
    phase2WaitingForBearishTurn = true;
    phase2BearishIdx = -1;
    i++;
  }
}

// 結果サマリー
console.log("\n" + "=".repeat(80));
console.log("【本日前場 シミュレーション結果】");
console.log("=".repeat(80));
console.log(`Phase1発火: ${phase1Count}回`);
console.log(`エントリー: ${trades.length}件`);

if (trades.length > 0) {
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  console.log(`総損益: ${totalPnl >= 0 ? "+" : ""}${Math.round(totalPnl).toLocaleString()}円`);
  console.log("\n取引詳細:");
  for (const t of trades) {
    console.log(`  ${t.entryTime} SHORT @${t.entryPrice.toFixed(0)} → ${t.exitTime} @${t.exitPrice.toFixed(0)} (${t.exitReason}) PnL:${(t.pnl >= 0 ? "+" : "") + Math.round(t.pnl).toLocaleString()}円 [${t.holdBars}本]`);
  }
} else {
  console.log("エントリーなし");
  if (phase2Active) {
    console.log("→ Phase2待機中（まだ確認完了していない）");
  }
}

// 現行ロジックとの比較
console.log("\n--- 現行ロジックとの比較 ---");
console.log("現行: 10:08 SHORT @8,813 → 10:18 SL @8,857 PnL:-13,219円");
console.log(`Confirm Break: ${trades.length > 0 ? trades.map(t => `${t.entryTime} SHORT @${t.entryPrice.toFixed(0)} → ${t.exitTime} (${t.exitReason}) PnL:${Math.round(t.pnl).toLocaleString()}円`).join(" / ") : "エントリーなし（Phase2未完了）"}`);

await conn.end();
