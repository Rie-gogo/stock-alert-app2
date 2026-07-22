/**
 * 日別損益比較: 0.8%フィルター単独 vs drop_0.6バイパス+CB v2
 * 
 * Case 1: 0.8%フィルター単独 (LONG+SHORT) = +373,696円
 * Case 2: 0.8%フィルター + drop_0.6バイパス + CB v2 (LONG+SHORT) = +716,342円
 */
import mysql from "mysql2/promise";

const conn = await mysql.createConnection(process.env.DATABASE_URL);

// 全取引を取得（エントリー+決済をペアリング）
const [entries] = await conn.execute(`
  SELECT id, tradeDate, symbol, symbolName, action, price, shares, amount, reason, tradeTime, side, boardSignal
  FROM rt_trades WHERE action IN ('buy','short') ORDER BY tradeDate, tradeTime
`);
const [exits] = await conn.execute(`
  SELECT id, tradeDate, symbol, action, price, shares, pnl, reason, tradeTime, side
  FROM rt_trades WHERE action IN ('sell','cover') ORDER BY tradeDate, tradeTime
`);

// ペアリング
const trades = [];
for (const entry of entries) {
  const exit = exits.find(
    e => e.tradeDate === entry.tradeDate && e.symbol === entry.symbol && e.side === entry.side
  );
  if (exit) {
    trades.push({
      tradeDate: entry.tradeDate, symbol: entry.symbol, side: entry.side,
      entryPrice: Number(entry.price), exitPrice: Number(exit.price),
      pnl: Number(exit.pnl), shares: Number(entry.shares),
      reason: entry.reason, tradeTime: entry.tradeTime
    });
  }
}

// 大台シグナル判定
function isRoundSignal(reason) {
  return reason && (reason.includes("大台") || reason.includes("キリ番"));
}

// 大台乖離率を計算
function getRoundLevel(reason) {
  const m = reason.match(/(\d+)円割/);
  if (m) return Number(m[1]);
  const m2 = reason.match(/キリ番(\d+)円/);
  if (m2) return Number(m2[1]);
  return null;
}

function calcDivergence(price, level) {
  if (!level) return 0;
  return Math.abs(price - level) / level;
}

// 0.8%フィルターでブロックされる取引を特定
const blocked08 = [];
const passed08 = [];

for (const t of trades) {
  if (isRoundSignal(t.reason)) {
    const level = getRoundLevel(t.reason);
    const div = calcDivergence(t.entryPrice, level);
    if (div > 0.008) {
      blocked08.push(t);
    } else {
      passed08.push(t);
    }
  } else {
    passed08.push(t); // 大台シグナルでない取引はそのまま通過
  }
}

// Case 1: 0.8%フィルター単独の日別損益（SHORT限定）
const case1DailyPnl = {};
for (const t of passed08) {
  if (t.side !== 'short') continue; // SHORT限定
  if (!case1DailyPnl[t.tradeDate]) case1DailyPnl[t.tradeDate] = 0;
  case1DailyPnl[t.tradeDate] += t.pnl;
}

// ブロックされたSHORTを取得（バイパス/CB v2の対象）
const blocked08Short = blocked08.filter(t => t.side === "short");

// 1分足データを取得してバイパス/CB v2シミュレーション
const uniquePairs = [...new Set(blocked08Short.map(t => `${t.symbol}|${t.tradeDate}`))];
const candleCache = {};
for (const pair of uniquePairs) {
  const [sym, date] = pair.split("|");
  const [rows] = await conn.execute(
    `SELECT symbol, tradeDate, candleTime, open, high, low, close, volume FROM rt_candles WHERE symbol = ? AND tradeDate = ? ORDER BY candleTime ASC`,
    [sym, date]
  );
  candleCache[pair] = rows.map(r => ({
    ...r, open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close), volume: Number(r.volume)
  }));
}

// drop_0.6判定
function checkDrop06(candles, blockTime) {
  const idx = candles.findIndex(c => c.candleTime >= blockTime);
  if (idx < 3) return false;
  const recent3 = candles.slice(idx - 3, idx);
  const highOfRecent3 = Math.max(...recent3.map(c => c.high));
  const currentClose = candles[idx]?.close || candles[idx - 1]?.close;
  const dropRate = (highOfRecent3 - currentClose) / highOfRecent3;
  return dropRate >= 0.006;
}

// バイパスエントリーシミュレーション
function simBypassEntry(candles, blockTime, entryPrice) {
  const idx = candles.findIndex(c => c.candleTime >= blockTime);
  if (idx < 0) return null;
  // 即時エントリー（ブロック時点の価格で）
  const tp = entryPrice * (1 - 0.015); // SHORT TP -1.5%
  const sl = entryPrice * (1 + 0.005); // SHORT SL +0.5%
  
  for (let i = idx + 1; i < candles.length; i++) {
    const c = candles[i];
    if (c.high >= sl) return { pnl: Math.round((entryPrice - sl) * 100), exitReason: "SL", exitTime: c.candleTime };
    if (c.low <= tp) return { pnl: Math.round((entryPrice - tp) * 100), exitReason: "TP", exitTime: c.candleTime };
  }
  // 引け決済
  const lastCandle = candles[candles.length - 1];
  return { pnl: Math.round((entryPrice - lastCandle.close) * 100), exitReason: "EOD", exitTime: lastCandle.candleTime };
}

// CB v2シミュレーション（簡易版）
function simCBv2(candles, blockTime, entryPrice) {
  const idx = candles.findIndex(c => c.candleTime >= blockTime);
  if (idx < 0) return null;
  
  // State 1: 反発確認 (0.2%以上反発)
  let state = 1;
  let impulseLow = entryPrice;
  let swingHigh = entryPrice;
  let consecutiveNoNewHigh = 0;
  let timeout = 0;
  const TIMEOUT = 20;
  
  for (let i = idx + 1; i < candles.length && timeout < TIMEOUT; i++) {
    const c = candles[i];
    timeout++;
    
    if (state === 1) {
      if (c.low < impulseLow) impulseLow = c.low;
      const rebound = (c.high - impulseLow) / impulseLow;
      if (rebound >= 0.002) { state = 2; swingHigh = c.high; consecutiveNoNewHigh = 0; }
    } else if (state === 2) {
      if (c.high > swingHigh) { swingHigh = c.high; consecutiveNoNewHigh = 0; }
      else { consecutiveNoNewHigh++; }
      if (consecutiveNoNewHigh >= 2) { state = 3; }
    } else if (state === 3) {
      // MA5クロス確認（簡易: close < 直近5本平均）
      const start = Math.max(0, i - 4);
      const ma5 = candles.slice(start, i + 1).reduce((s, x) => s + x.close, 0) / Math.min(5, i - start + 1);
      if (c.close < ma5) { state = 4; }
    } else if (state === 4) {
      // 再ブレイク確認
      if (c.close < impulseLow) {
        // エントリー成立
        const cbEntryPrice = c.close;
        const tp = cbEntryPrice * (1 - 0.015);
        const sl = cbEntryPrice * (1 + 0.005);
        for (let j = i + 1; j < candles.length; j++) {
          const cc = candles[j];
          if (cc.high >= sl) return { pnl: Math.round((cbEntryPrice - sl) * 100), exitReason: "SL" };
          if (cc.low <= tp) return { pnl: Math.round((cbEntryPrice - tp) * 100), exitReason: "TP" };
        }
        const last = candles[candles.length - 1];
        return { pnl: Math.round((cbEntryPrice - last.close) * 100), exitReason: "EOD" };
      }
    }
  }
  return null; // タイムアウト（エントリーなし）
}

// Case 2: drop_0.6バイパス + CB v2 の日別損益
const case2DailyPnl = {};
// まずCase 1の通過分をコピー（SHORT限定）
for (const t of passed08) {
  if (t.side !== 'short') continue; // SHORT限定
  if (!case2DailyPnl[t.tradeDate]) case2DailyPnl[t.tradeDate] = 0;
  case2DailyPnl[t.tradeDate] += t.pnl;
}

// ブロックされたSHORTに対してバイパス/CB v2を適用
let bypassCount = 0, bypassPnl = 0;
let cbv2Count = 0, cbv2Pnl = 0;
const bypassTrades = [];
const cbv2Trades = [];

for (const t of blocked08Short) {
  const key = `${t.symbol}|${t.tradeDate}`;
  const candles = candleCache[key];
  if (!candles || candles.length === 0) continue;
  
  const isDrop = checkDrop06(candles, t.tradeTime);
  
  if (isDrop) {
    // バイパスエントリー
    const result = simBypassEntry(candles, t.tradeTime, t.entryPrice);
    if (result) {
      if (!case2DailyPnl[t.tradeDate]) case2DailyPnl[t.tradeDate] = 0;
      case2DailyPnl[t.tradeDate] += result.pnl;
      bypassCount++;
      bypassPnl += result.pnl;
      bypassTrades.push({ ...t, ...result, type: "bypass" });
    }
  } else {
    // CB v2
    const result = simCBv2(candles, t.tradeTime, t.entryPrice);
    if (result) {
      if (!case2DailyPnl[t.tradeDate]) case2DailyPnl[t.tradeDate] = 0;
      case2DailyPnl[t.tradeDate] += result.pnl;
      cbv2Count++;
      cbv2Pnl += result.pnl;
      cbv2Trades.push({ ...t, ...result, type: "cbv2" });
    }
  }
}

// 全日付を取得してソート
const allDates = [...new Set([...Object.keys(case1DailyPnl), ...Object.keys(case2DailyPnl)])].sort();

// 出力
console.log("=== 日別損益比較 ===");
console.log("日付        | Case1(0.8%単独) | Case2(+bypass+CBv2) | 差分     | Case1累計  | Case2累計");
console.log("------------|-----------------|---------------------|----------|------------|----------");

let cum1 = 0, cum2 = 0;
for (const date of allDates) {
  const pnl1 = case1DailyPnl[date] || 0;
  const pnl2 = case2DailyPnl[date] || 0;
  cum1 += pnl1;
  cum2 += pnl2;
  const diff = pnl2 - pnl1;
  console.log(`${date} | ${String(pnl1).padStart(15)} | ${String(pnl2).padStart(19)} | ${String(diff).padStart(8)} | ${String(cum1).padStart(10)} | ${String(cum2).padStart(10)}`);
}

console.log("------------|-----------------|---------------------|----------|------------|----------");
console.log(`合計        | ${String(cum1).padStart(15)} | ${String(cum2).padStart(19)} | ${String(cum2-cum1).padStart(8)} |            |`);

console.log(`\n=== サマリー ===`);
console.log(`Case 1 (0.8%フィルター単独): ${cum1}円`);
console.log(`Case 2 (0.8% + drop_0.6バイパス + CB v2): ${cum2}円`);
console.log(`差分: +${cum2 - cum1}円 (+${((cum2-cum1)/cum1*100).toFixed(1)}%改善)`);
console.log(`\nバイパス: ${bypassCount}件, ${bypassPnl}円`);
console.log(`CB v2: ${cbv2Count}件, ${cbv2Pnl}円`);

console.log(`\n=== バイパス取引詳細 ===`);
for (const t of bypassTrades) {
  console.log(`  ${t.tradeDate} ${t.symbol} @${t.entryPrice} → ${t.exitReason} pnl=${t.pnl}`);
}

console.log(`\n=== CB v2取引詳細 ===`);
for (const t of cbv2Trades) {
  console.log(`  ${t.tradeDate} ${t.symbol} @${t.entryPrice} → ${t.exitReason} pnl=${t.pnl}`);
}

await conn.end();
