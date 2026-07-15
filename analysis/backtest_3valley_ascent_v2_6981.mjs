/**
 * 3谷切り上げエントリー v2 (LONG) - 村田製作所(6981)専用
 * 
 * 3山切り下げv2のミラー版（上昇用）
 * 
 * 【条件】
 * ① スイングロー（押し安値）が3回連続で切り上がっている（HL >= 3）
 * ② 全体の方向が上昇（始値 < 現在値）
 * ③ 現在が「押し→再上昇」の転換点
 *    - 陽線転換（前足陰線→今足陽線）
 *    - 次足で前足高値更新
 * ④ 【v2条件】直近スイングロー以降、そのスイングローを下回る安値が出ていないこと
 *    （＝押しが前回の谷を割っていない → 上昇トレンド継続中を確認）
 * 
 * SL: 0.5%, TP: 1.5%, 大引け: 15:20
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

console.log(`=== 3谷切り上げエントリー v2 (LONG) - 村田製作所(6981) ===`);
console.log(`期間: ${days[0]} 〜 ${days[days.length - 1]} (${days.length}営業日)`);
console.log(`条件: HL>=3(連続切り上げ) + 始値<現在値 + 陽線転換 + 次足高値更新`);
console.log(`追加: 直近SL以降に安値更新なし（上昇トレンド継続確認）`);
console.log(`TP:1.5% SL:0.5%\n`);

// スイングロー検出（lookback=2）
function detectSwingLows(candles, upToIdx) {
  const lows = [];
  const lookback = 2;
  const end = Math.min(upToIdx, candles.length - 1);
  for (let i = lookback; i <= end - lookback; i++) {
    const curr = candles[i];
    let isSwingLow = true;
    for (let j = 1; j <= lookback; j++) {
      if (candles[i - j].low <= curr.low || candles[i + j].low <= curr.low) isSwingLow = false;
    }
    if (isSwingLow) lows.push({ price: curr.low, index: i, time: curr.candleTime });
  }
  return lows;
}

// 連続切り上げ回数をカウント（直近から遡る）
function countConsecutiveHL(swingLows) {
  if (swingLows.length < 2) return 0;
  let count = 0;
  for (let i = swingLows.length - 1; i > 0; i--) {
    if (swingLows[i].price > swingLows[i - 1].price) {
      count++;
    } else {
      break;
    }
  }
  return count;
}

// 【v2条件④】直近スイングロー以降に、そのスイングローを下回る安値が出ていないか
function isStillInUptrend(candles, swingLows, currentIdx) {
  if (swingLows.length === 0) return false;
  const lastSL = swingLows[swingLows.length - 1];
  for (let i = lastSL.index + 1; i <= currentIdx; i++) {
    if (candles[i].low < lastSL.price) {
      return false; // 直近スイングローを割った → 上昇トレンド崩壊
    }
  }
  return true;
}

// メインシミュレーション
const allTrades = [];
const blockedByV2 = [];

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
  
  const openPrice = candles[0].open;
  let inPosition = false;
  let entryPrice = 0, entryTime = "", entryIdx = 0;
  let lastEntryIdx = -10;
  
  for (let i = 6; i < candles.length; i++) {
    const candle = candles[i];
    
    // ポジション管理 (LONG)
    if (inPosition) {
      const lossPct = (entryPrice - candle.low) / entryPrice;
      const profitPct = (candle.high - entryPrice) / entryPrice;
      
      if (lossPct >= SL) {
        const exitPrice = entryPrice * (1 - SL);
        const shares = Math.floor(1000000 / entryPrice);
        const pnl = (exitPrice - entryPrice) * shares;
        allTrades.push({ day, entryTime, entryPrice, exitTime: candle.candleTime, exitPrice, pnl, exitReason: "SL", holdBars: i - entryIdx });
        inPosition = false;
        continue;
      }
      if (profitPct >= TP) {
        const exitPrice = entryPrice * (1 + TP);
        const shares = Math.floor(1000000 / entryPrice);
        const pnl = (exitPrice - entryPrice) * shares;
        allTrades.push({ day, entryTime, entryPrice, exitTime: candle.candleTime, exitPrice, pnl, exitReason: "TP", holdBars: i - entryIdx });
        inPosition = false;
        continue;
      }
      if (candle.candleTime >= FORCE_EXIT_TIME) {
        const exitPrice = candle.close;
        const shares = Math.floor(1000000 / entryPrice);
        const pnl = (exitPrice - entryPrice) * shares;
        allTrades.push({ day, entryTime, entryPrice, exitTime: candle.candleTime, exitPrice, pnl, exitReason: "EOD", holdBars: i - entryIdx });
        inPosition = false;
      }
      continue;
    }
    
    // エントリー条件チェック
    if (candle.candleTime >= NO_ENTRY_AFTER) continue;
    if (candle.candleTime < "09:10") continue;
    if (i - lastEntryIdx < 5) continue;
    if (i >= candles.length - 1) continue;
    
    // ① 3谷連続切り上げ
    const swingLows = detectSwingLows(candles, i);
    const consecutiveHL = countConsecutiveHL(swingLows);
    if (consecutiveHL < 3) continue;
    
    // ② 全体の方向が上昇（始値 < 現在値）
    if (openPrice >= candle.close) continue;
    
    // ③ 陽線転換（前足陰線→今足陽線）
    const prevCandle = candles[i - 1];
    const isCurrBullish = candle.close > candle.open;
    const isPrevBearish = prevCandle.close < prevCandle.open;
    if (!isCurrBullish || !isPrevBearish) continue;
    
    // ④ 【v2条件】直近スイングロー以降に安値更新なし
    if (!isStillInUptrend(candles, swingLows, i)) {
      blockedByV2.push({ day, time: candle.candleTime, price: candle.close, lastSL: swingLows[swingLows.length - 1] });
      continue;
    }
    
    // ⑤ 次足で前足高値更新
    const nextCandle = candles[i + 1];
    if (!(nextCandle.high > candle.high)) continue;
    
    // エントリー！(LONG)
    inPosition = true;
    entryPrice = nextCandle.close;
    entryTime = nextCandle.candleTime;
    entryIdx = i + 1;
    lastEntryIdx = i + 1;
    i++;
  }
  
  // 未決済
  if (inPosition && candles.length > 0) {
    const lastCandle = candles[candles.length - 1];
    const shares = Math.floor(1000000 / entryPrice);
    const pnl = (lastCandle.close - entryPrice) * shares;
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
const sl5min = allTrades.filter(t => t.exitReason === "SL" && t.holdBars <= 5).length;

let cumPnl = 0, maxCum = 0, maxDD = 0;
for (const t of allTrades) {
  cumPnl += t.pnl;
  if (cumPnl > maxCum) maxCum = cumPnl;
  const dd = maxCum - cumPnl;
  if (dd > maxDD) maxDD = dd;
}

console.log("=".repeat(80));
console.log("【結果サマリー】");
console.log("=".repeat(80));
console.log("");
console.log("┌──────────────────────┬──────────────────┬──────────────────┐");
console.log("│ 指標                 │ 3山v2 (SHORT)    │ 3谷v2 (LONG)     │");
console.log("├──────────────────────┼──────────────────┼──────────────────┤");
console.log(`│ 取引数               │ 24件             │ ${String(allTrades.length).padStart(3)}件             │`);
console.log(`│ 勝率                 │ 33.3%            │ ${((wins.length / Math.max(allTrades.length, 1)) * 100).toFixed(1).padStart(5)}%           │`);
console.log(`│ PF                   │ 1.50             │ ${pf === Infinity ? "∞    " : pf.toFixed(2).padStart(5)}            │`);
console.log(`│ 総損益               │ +39,753円        │ ${(totalPnl >= 0 ? "+" : "") + Math.round(totalPnl).toLocaleString().padStart(7)}円       │`);
console.log(`│ 最大DD               │ 24,919円         │ ${Math.round(maxDD).toLocaleString().padStart(7)}円       │`);
console.log(`│ 平均保有時間         │ 13.1分           │ ${avgHold.toFixed(1).padStart(5)}分         │`);
console.log(`│ 保有5分以内SL        │ 10件             │ ${String(sl5min).padStart(3)}件             │`);
console.log(`│ 期待値               │ +1,656円         │ ${(expectancy >= 0 ? "+" : "") + Math.round(expectancy).toLocaleString().padStart(6)}円        │`);
console.log("└──────────────────────┴──────────────────┴──────────────────┘");

// 決済理由別
console.log("\n--- 決済理由別 ---");
for (const reason of ["TP", "SL", "EOD"]) {
  const rTrades = allTrades.filter(t => t.exitReason === reason);
  if (rTrades.length === 0) continue;
  const rPnl = rTrades.reduce((s, t) => s + t.pnl, 0);
  console.log(`${reason.padEnd(4)}: ${String(rTrades.length).padStart(3)}件 | ${(rPnl >= 0 ? "+" : "") + Math.round(rPnl).toLocaleString()}円`);
}

// v2でブロックされた取引
console.log(`\n--- v2条件(上昇トレンド継続確認)でブロックされた件数: ${blockedByV2.length}件 ---`);
for (const b of blockedByV2.slice(0, 20)) {
  console.log(`  ${b.day} ${b.time} @${b.price} (直近SL: ${b.lastSL.time} ${b.lastSL.price} → その後に下回る安値あり)`);
}
if (blockedByV2.length > 20) console.log(`  ... 他${blockedByV2.length - 20}件`);

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
  console.log(`  ${t.day} ${t.entryTime} LONG @${t.entryPrice.toFixed(0)} → ${t.exitTime} @${t.exitPrice.toFixed(0)} (${t.exitReason}) PnL:${(t.pnl >= 0 ? "+" : "") + Math.round(t.pnl).toLocaleString()}円 [${t.holdBars}本]`);
}

// 本日(7/15)の結果
console.log("\n--- 本日(7/15)の結果 ---");
const todayTrades = allTrades.filter(t => t.day === "2026-07-15");
if (todayTrades.length > 0) {
  for (const t of todayTrades) {
    console.log(`  ${t.entryTime} LONG @${t.entryPrice.toFixed(0)} → ${t.exitTime} @${t.exitPrice.toFixed(0)} (${t.exitReason}) PnL:${(t.pnl >= 0 ? "+" : "") + Math.round(t.pnl).toLocaleString()}円`);
  }
  const todayPnl = todayTrades.reduce((s, t) => s + t.pnl, 0);
  console.log(`  合計: ${(todayPnl >= 0 ? "+" : "") + Math.round(todayPnl).toLocaleString()}円`);
} else {
  console.log("  エントリーなし");
}

await conn.end();
