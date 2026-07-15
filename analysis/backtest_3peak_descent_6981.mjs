/**
 * 3山切り下げエントリー (SHORT) - 村田製作所(6981)専用
 * 
 * 【条件】
 * ① 戻り高値（スイングハイ）が3回連続で切り下がっている（LH >= 3）
 * ② 全体の方向が下落（始値 > 現在値）
 * ③ 現在が「戻り→再下落」の転換点
 *    - 陰線転換（前足陽線→今足陰線）
 *    - 次足で前足安値更新
 * 
 * SL: 0.5%, TP: 1.5%, 大引け: 15:20
 * 
 * 比較: Pullback Confirmation / Confirm Break Entry / 3山切り下げ
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

console.log(`=== 3山切り下げエントリー (SHORT) - 村田製作所(6981) ===`);
console.log(`期間: ${days[0]} 〜 ${days[days.length - 1]} (${days.length}営業日)`);
console.log(`条件: LH>=3(連続切り下げ) + 始値>現在値 + 陰線転換 + 次足安値更新`);
console.log(`TP:1.5% SL:0.5%\n`);

// スイングハイ検出（lookback=2）
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

// 連続切り下げ回数をカウント（直近から遡る）
function countConsecutiveLH(swingHighs) {
  if (swingHighs.length < 2) return 0;
  let count = 0;
  for (let i = swingHighs.length - 1; i > 0; i--) {
    if (swingHighs[i].price < swingHighs[i - 1].price) {
      count++;
    } else {
      break; // 連続が途切れたら終了
    }
  }
  return count;
}

// メインシミュレーション
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
  
  if (candles.length < 10) continue;
  
  const openPrice = candles[0].open; // 始値
  let inPosition = false;
  let entryPrice = 0, entryTime = "", entryIdx = 0;
  let lastEntryIdx = -10;
  let dayTrades = [];
  
  for (let i = 6; i < candles.length; i++) {
    const candle = candles[i];
    
    // ポジション管理
    if (inPosition) {
      const lossPct = (candle.high - entryPrice) / entryPrice;
      const profitPct = (entryPrice - candle.low) / entryPrice;
      
      if (lossPct >= SL) {
        const exitPrice = entryPrice * (1 + SL);
        const shares = Math.floor(1000000 / entryPrice);
        const pnl = (entryPrice - exitPrice) * shares;
        const trade = { day, entryTime, entryPrice, exitTime: candle.candleTime, exitPrice, pnl, exitReason: "SL", holdBars: i - entryIdx };
        allTrades.push(trade);
        dayTrades.push(trade);
        inPosition = false;
        continue;
      }
      if (profitPct >= TP) {
        const exitPrice = entryPrice * (1 - TP);
        const shares = Math.floor(1000000 / entryPrice);
        const pnl = (entryPrice - exitPrice) * shares;
        const trade = { day, entryTime, entryPrice, exitTime: candle.candleTime, exitPrice, pnl, exitReason: "TP", holdBars: i - entryIdx };
        allTrades.push(trade);
        dayTrades.push(trade);
        inPosition = false;
        continue;
      }
      if (candle.candleTime >= FORCE_EXIT_TIME) {
        const exitPrice = candle.close;
        const shares = Math.floor(1000000 / entryPrice);
        const pnl = (entryPrice - exitPrice) * shares;
        const trade = { day, entryTime, entryPrice, exitTime: candle.candleTime, exitPrice, pnl, exitReason: "EOD", holdBars: i - entryIdx };
        allTrades.push(trade);
        dayTrades.push(trade);
        inPosition = false;
      }
      continue;
    }
    
    // エントリー条件チェック
    if (candle.candleTime >= NO_ENTRY_AFTER) continue;
    if (candle.candleTime < "09:10") continue;
    if (i - lastEntryIdx < 5) continue; // 連続エントリー防止
    if (i >= candles.length - 1) continue; // 次足が必要
    
    // ① 3山連続切り下げ
    const swingHighs = detectSwingHighs(candles, i);
    const consecutiveLH = countConsecutiveLH(swingHighs);
    if (consecutiveLH < 3) continue;
    
    // ② 全体の方向が下落（始値 > 現在値）
    if (openPrice <= candle.close) continue;
    
    // ③ 陰線転換（前足陽線→今足陰線）
    const prevCandle = candles[i - 1];
    const isCurrBearish = candle.close < candle.open;
    const isPrevBullish = prevCandle.close >= prevCandle.open;
    if (!isCurrBearish || !isPrevBullish) continue;
    
    // ④ 次足で前足安値更新
    const nextCandle = candles[i + 1];
    if (!(nextCandle.low < candle.low)) continue;
    
    // エントリー！（次足のcloseでエントリー）
    inPosition = true;
    entryPrice = nextCandle.close;
    entryTime = nextCandle.candleTime;
    entryIdx = i + 1;
    lastEntryIdx = i + 1;
    i++; // 次足をスキップ
  }
  
  // 未決済
  if (inPosition && candles.length > 0) {
    const lastCandle = candles[candles.length - 1];
    const shares = Math.floor(1000000 / entryPrice);
    const pnl = (entryPrice - lastCandle.close) * shares;
    const trade = { day, entryTime, entryPrice, exitTime: lastCandle.candleTime, exitPrice: lastCandle.close, pnl, exitReason: "EOD", holdBars: candles.length - 1 - entryIdx };
    allTrades.push(trade);
    dayTrades.push(trade);
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
console.log("┌──────────────────────┬──────────────────┬──────────────────┬──────────────────┐");
console.log("│ 指標                 │ Pullback Confirm │ Confirm Break    │ 3山切り下げ      │");
console.log("├──────────────────────┼──────────────────┼──────────────────┼──────────────────┤");
console.log(`│ 取引数               │ 10件             │ 7件              │ ${String(allTrades.length).padStart(3)}件             │`);
console.log(`│ 勝率                 │ 20.0%            │ 42.9%            │ ${((wins.length / Math.max(allTrades.length, 1)) * 100).toFixed(1).padStart(5)}%           │`);
console.log(`│ PF                   │ 0.75             │ 2.25             │ ${pf === Infinity ? "∞" : pf.toFixed(2).padStart(5)}            │`);
console.log(`│ 総損益               │ -10,081円        │ +24,838円        │ ${(totalPnl >= 0 ? "+" : "") + Math.round(totalPnl).toLocaleString().padStart(8)}円      │`);
console.log(`│ 最大DD               │ 24,912円         │ 9,975円          │ ${Math.round(maxDD).toLocaleString().padStart(8)}円      │`);
console.log(`│ 平均保有時間         │ 11.0分           │ 9.7分            │ ${avgHold.toFixed(1).padStart(5)}分          │`);
console.log(`│ 保有5分以内SL        │ 5件              │ 2件              │ ${String(sl5min).padStart(3)}件             │`);
console.log(`│ 期待値               │ -1,008円         │ +3,548円         │ ${(expectancy >= 0 ? "+" : "") + Math.round(expectancy).toLocaleString().padStart(6)}円        │`);
console.log("└──────────────────────┴──────────────────┴──────────────────┴──────────────────┘");

// 目標判定
console.log("\n--- 目標達成判定 ---");
console.log(`取引数: ${allTrades.length}件`);
console.log(`勝率35%+: ${(wins.length / Math.max(allTrades.length, 1)) >= 0.35 ? "✅" : "❌"} (${((wins.length / Math.max(allTrades.length, 1)) * 100).toFixed(1)}%)`);
console.log(`PF 1.30+: ${pf >= 1.30 ? "✅" : "❌"} (${pf === Infinity ? "∞" : pf.toFixed(2)})`);
console.log(`最大DD改善: ${maxDD <= 55473 ? "✅" : "❌"} (${Math.round(maxDD).toLocaleString()}円)`);

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
  console.log(`  ${day}: ${trades.length}件 (${dayWins}勝) PnL:${(dayPnl >= 0 ? "+" : "") + Math.round(dayPnl).toLocaleString()}円`);
}

// 全取引詳細
console.log("\n--- 全取引詳細 ---");
for (const t of allTrades) {
  console.log(`  ${t.day} ${t.entryTime} SHORT @${t.entryPrice.toFixed(0)} → ${t.exitTime} @${t.exitPrice.toFixed(0)} (${t.exitReason}) PnL:${(t.pnl >= 0 ? "+" : "") + Math.round(t.pnl).toLocaleString()}円 [${t.holdBars}本]`);
}

// 本日(7/15)の結果を特出し
console.log("\n--- 本日(7/15)の結果 ---");
const todayTrades = allTrades.filter(t => t.day === "2026-07-15");
if (todayTrades.length > 0) {
  for (const t of todayTrades) {
    console.log(`  ${t.entryTime} SHORT @${t.entryPrice.toFixed(0)} → ${t.exitTime} @${t.exitPrice.toFixed(0)} (${t.exitReason}) PnL:${(t.pnl >= 0 ? "+" : "") + Math.round(t.pnl).toLocaleString()}円`);
  }
} else {
  console.log("  エントリーなし");
}
console.log("  現行ロジック: 10:08 SHORT @8,813 → 10:18 SL @8,857 PnL:-13,219円");

await conn.end();
