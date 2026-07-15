/**
 * 本日(7/15) 村田製作所(6981) Phase1不発火の原因調査
 * チャートでは10:30付近に明確な「戻り→再下落」パターンがあるのに
 * Phase1が発火しなかった理由を調べる
 */
import mysql from "mysql2/promise";
const conn = await mysql.createConnection(process.env.DATABASE_URL);

const SYMBOL = "6981";

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

console.log(`キャンドル数: ${candles.length}`);

// 10:00〜11:00の値動きを表示
console.log("\n--- 10:00〜11:30 の値動き ---");
for (const c of candles) {
  if (c.candleTime >= "10:00" && c.candleTime <= "11:30") {
    const bar = c.close >= c.open ? "陽" : "陰";
    console.log(`${c.candleTime} O:${c.open} H:${c.high} L:${c.low} C:${c.close} V:${c.volume} [${bar}]`);
  }
}

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
  return { ratio: pullback / downMove, latestLow, prevHigh, pullbackHigh, downMove };
}

// 10:20〜11:00の各足でPhase1条件を詳細チェック
console.log("\n--- 10:20〜11:00 Phase1条件診断 ---");
for (let i = 26; i < candles.length; i++) {
  const candle = candles[i];
  if (candle.candleTime < "10:20" || candle.candleTime > "11:00") continue;
  if (i >= candles.length - 1) continue;
  
  const swings = detectSwingPoints(candles, i);
  const highs = swings.filter(s => s.type === "high");
  const lows = swings.filter(s => s.type === "low");
  
  let lhCount = 0;
  for (let j = 1; j < highs.length; j++) {
    if (highs[j].price < highs[j - 1].price) lhCount++;
  }
  let llCount = 0;
  for (let j = 1; j < lows.length; j++) {
    if (lows[j].price < lows[j - 1].price) llCount++;
  }
  
  const vwap = calcVWAP(candles, i);
  const ma5 = calcMA(candles, i, 5);
  const ma25 = calcMA(candles, i, 25);
  const ma5prev = calcMA(candles, i - 1, 5);
  const pullback = calcPullbackRatio(candles, swings, i);
  
  const isBearish = candle.close < candle.open;
  const prevBullish = i > 0 && candles[i-1].close >= candles[i-1].open;
  const bearishTurn = isBearish && prevBullish;
  
  // 条件判定
  const checks = {
    "LH>=2": lhCount >= 2,
    "LL>=2": llCount >= 2,
    "price<VWAP": candle.close < vwap,
    "price<=VWAP-0.3%": candle.close <= vwap * (1 - 0.003),
    "MA5<MA25": ma5 !== null && ma25 !== null && ma5 < ma25,
    "MA5↓": ma5prev !== null && ma5 < ma5prev,
    "戻り率20-40%": pullback !== null && pullback.ratio >= 0.20 && pullback.ratio <= 0.40,
    "陰線転換": bearishTurn,
  };
  
  const failedChecks = Object.entries(checks).filter(([k, v]) => !v).map(([k]) => k);
  
  if (failedChecks.length <= 3) { // 条件に近い足のみ表示
    console.log(`\n${candle.candleTime} C:${candle.close} [${isBearish ? "陰" : "陽"}]`);
    console.log(`  LH:${lhCount} LL:${llCount} VWAP:${vwap.toFixed(0)} MA5:${ma5?.toFixed(0)} MA25:${ma25?.toFixed(0)} MA5slope:${ma5prev ? (ma5 - ma5prev).toFixed(1) : "?"}`);
    console.log(`  戻り率: ${pullback ? (pullback.ratio * 100).toFixed(1) + "%" : "N/A"} ${pullback ? `(高値${pullback.prevHigh.price}→安値${pullback.latestLow.price}→戻り${pullback.pullbackHigh})` : ""}`);
    console.log(`  ✅ ${Object.entries(checks).filter(([k, v]) => v).map(([k]) => k).join(", ")}`);
    console.log(`  ❌ ${failedChecks.join(", ")}`);
  }
}

// スイングポイント一覧
console.log("\n--- 全スイングポイント（11:30時点） ---");
const allSwings = detectSwingPoints(candles, candles.length - 3);
for (const s of allSwings) {
  console.log(`  ${s.time} ${s.type === "high" ? "HIGH" : "LOW "} ${s.price}`);
}

await conn.end();
