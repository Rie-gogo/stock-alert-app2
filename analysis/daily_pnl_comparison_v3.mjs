/**
 * 日別損益比較 v3: 取引数付き
 * SHORT限定
 */
import mysql from "mysql2/promise";

const POSITION_SIZE = 3_000_000;
const SL_PCT = 0.005;
const TP_PCT = 0.015;
const FORCE_EXIT_TIME = "15:25";

const conn = await mysql.createConnection(process.env.DATABASE_URL);

// 全取引を取得
const [allEntries] = await conn.execute(`
  SELECT id, tradeDate, symbol, symbolName, action, price, shares, amount, reason, tradeTime, side, boardSignal
  FROM rt_trades WHERE action IN ('buy','short') ORDER BY tradeDate, tradeTime
`);
const [allExits] = await conn.execute(`
  SELECT id, tradeDate, symbol, action, price, shares, pnl, reason, tradeTime, side
  FROM rt_trades WHERE action IN ('sell','cover') ORDER BY tradeDate, tradeTime
`);

// ペアリング
const exitsCopy = [...allExits];
const trades = [];
for (const entry of allEntries) {
  const exit = exitsCopy.find(
    e => e.tradeDate === entry.tradeDate && e.symbol === entry.symbol && e.side === entry.side
      && e.tradeTime >= entry.tradeTime && e.pnl !== null
  );
  if (exit) {
    trades.push({
      tradeDate: entry.tradeDate, symbol: entry.symbol, side: entry.side,
      entryPrice: parseFloat(entry.price), exitPrice: parseFloat(exit.price),
      pnl: exit.pnl, shares: entry.shares,
      reason: entry.reason, tradeTime: entry.tradeTime,
      exitTime: exit.tradeTime, exitReason: exit.reason,
    });
    exitsCopy.splice(exitsCopy.indexOf(exit), 1);
  }
}

// 大台シグナル判定
function isRoundSignal(reason) {
  return reason.includes("大台確認") || reason.includes("大台超え") || reason.includes("大台割れ");
}
function getRoundLevel(reason) {
  const m = reason.match(/(\d+(?:\.\d+)?)円/);
  return m ? parseFloat(m[1]) : null;
}

// 分類
for (const t of trades) {
  t.isRound = isRoundSignal(t.reason);
  t.roundLevel = t.isRound ? getRoundLevel(t.reason) : null;
  t.divergence = t.isRound && t.roundLevel ? Math.abs(t.entryPrice - t.roundLevel) / t.roundLevel : null;
}

// 0.8%フィルター分類
const blocked08 = trades.filter(t => t.isRound && t.divergence !== null && t.divergence > 0.008);
const passed08 = trades.filter(t => !t.isRound || t.divergence === null || t.divergence <= 0.008);

// Case 1: passed08のSHORT
const case1Trades = passed08.filter(t => t.side === "short");
const blocked08Short = blocked08.filter(t => t.side === "short");

// 1分足データ取得
const uniquePairs = [...new Set(blocked08Short.map(t => `${t.symbol}|${t.tradeDate}`))];
const candleCache = {};
for (const pair of uniquePairs) {
  const [sym, date] = pair.split("|");
  const [rows] = await conn.execute(
    `SELECT symbol, tradeDate, candleTime, open, high, low, close, volume FROM rt_candles WHERE symbol = ? AND tradeDate = ? ORDER BY candleTime ASC`,
    [sym, date]
  );
  candleCache[pair] = rows.map(r => ({
    ...r, open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close), volume: Number(r.volume),
  }));
}

// drop_0.6判定
function calcDropRate3(candles, idx) {
  if (idx < 3) return 0;
  const open3ago = candles[idx - 2].open;
  return (candles[idx].close - open3ago) / open3ago;
}

function checkDrop06(candles, blockTime) {
  const idx = candles.findIndex(c => c.candleTime >= blockTime);
  if (idx < 3) return false;
  const dropRate = calcDropRate3(candles, idx);
  return dropRate <= -0.006;
}

// バイパスエントリーシミュレーション
function simBypassEntry(candles, blockTime) {
  const idx = candles.findIndex(c => c.candleTime >= blockTime);
  if (idx < 0 || idx + 1 >= candles.length) return null;
  
  const entryPrice = candles[idx + 1].open;
  const shares = Math.floor(POSITION_SIZE / entryPrice);
  if (shares <= 0) return null;
  
  const slPrice = entryPrice * (1 + SL_PCT);
  const tpPrice = entryPrice * (1 - TP_PCT);
  
  for (let j = idx + 1; j < candles.length; j++) {
    const c = candles[j];
    if (c.high >= slPrice) return { pnl: Math.round((entryPrice - slPrice) * shares), exitReason: "SL", entryPrice, shares };
    if (c.low <= tpPrice) return { pnl: Math.round((entryPrice - tpPrice) * shares), exitReason: "TP", entryPrice, shares };
    if (c.candleTime >= FORCE_EXIT_TIME) return { pnl: Math.round((entryPrice - c.close) * shares), exitReason: "EOD", entryPrice, shares };
  }
  return null;
}

// CB v2シミュレーション
function simCBv2(candles, blockTime) {
  const idx = candles.findIndex(c => c.candleTime >= blockTime);
  if (idx < 0) return null;
  
  const REBOUND_PCT = 0.002;
  const TIMEOUT = 20;
  
  let state = 1;
  let impulseLow = candles[idx].low;
  let swingHigh = candles[idx].high;
  let consecutiveNoNewHigh = 0;
  let prevAboveMA5 = false;
  
  for (let i = idx + 1; i < candles.length && (i - idx) <= TIMEOUT; i++) {
    const c = candles[i];
    
    if (state === 1) {
      if (c.low < impulseLow) impulseLow = c.low;
      const rebound = (c.high - impulseLow) / impulseLow;
      if (rebound >= REBOUND_PCT) { state = 2; swingHigh = c.high; consecutiveNoNewHigh = 0; }
    } else if (state === 2) {
      if (c.high > swingHigh) { swingHigh = c.high; consecutiveNoNewHigh = 0; }
      else { consecutiveNoNewHigh++; }
      if (consecutiveNoNewHigh >= 2) {
        state = 3;
        const start = Math.max(0, i - 4);
        const ma5 = candles.slice(start, i + 1).reduce((s, x) => s + x.close, 0) / (i - start + 1);
        prevAboveMA5 = c.close > ma5;
      }
    } else if (state === 3) {
      const start = Math.max(0, i - 4);
      const ma5 = candles.slice(start, i + 1).reduce((s, x) => s + x.close, 0) / (i - start + 1);
      const currentAbove = c.close > ma5;
      if (prevAboveMA5 && !currentAbove) { state = 4; }
      prevAboveMA5 = currentAbove;
    } else if (state === 4) {
      if (c.close < impulseLow) {
        if (i + 1 >= candles.length) return null;
        const entryPrice = candles[i + 1].open;
        const shares = Math.floor(POSITION_SIZE / entryPrice);
        if (shares <= 0) return null;
        const slPrice = entryPrice * (1 + SL_PCT);
        const tpPrice = entryPrice * (1 - TP_PCT);
        for (let j = i + 1; j < candles.length; j++) {
          const cc = candles[j];
          if (cc.high >= slPrice) return { pnl: Math.round((entryPrice - slPrice) * shares), exitReason: "SL", entryPrice, shares };
          if (cc.low <= tpPrice) return { pnl: Math.round((entryPrice - tpPrice) * shares), exitReason: "TP", entryPrice, shares };
          if (cc.candleTime >= FORCE_EXIT_TIME) return { pnl: Math.round((entryPrice - cc.close) * shares), exitReason: "EOD", entryPrice, shares };
        }
        return null;
      }
    }
  }
  return null;
}

// 日別集計用
const case1Daily = {}; // { date: { pnl, count } }
const case2Daily = {}; // { date: { pnl, count, bypassCount, cbv2Count } }

// Case 1
for (const t of case1Trades) {
  if (!case1Daily[t.tradeDate]) case1Daily[t.tradeDate] = { pnl: 0, count: 0 };
  case1Daily[t.tradeDate].pnl += t.pnl;
  case1Daily[t.tradeDate].count++;
}

// Case 2: まずCase1の通過分をコピー
for (const t of case1Trades) {
  if (!case2Daily[t.tradeDate]) case2Daily[t.tradeDate] = { pnl: 0, count: 0, bypassCount: 0, cbv2Count: 0 };
  case2Daily[t.tradeDate].pnl += t.pnl;
  case2Daily[t.tradeDate].count++;
}

let bypassTotal = 0, cbv2Total = 0, bypassCountTotal = 0, cbv2CountTotal = 0;

for (const t of blocked08Short) {
  const key = `${t.symbol}|${t.tradeDate}`;
  const candles = candleCache[key];
  if (!candles || candles.length === 0) continue;
  
  const isDrop = checkDrop06(candles, t.tradeTime);
  
  if (isDrop) {
    const result = simBypassEntry(candles, t.tradeTime);
    if (result) {
      if (!case2Daily[t.tradeDate]) case2Daily[t.tradeDate] = { pnl: 0, count: 0, bypassCount: 0, cbv2Count: 0 };
      case2Daily[t.tradeDate].pnl += result.pnl;
      case2Daily[t.tradeDate].count++;
      case2Daily[t.tradeDate].bypassCount++;
      bypassTotal += result.pnl;
      bypassCountTotal++;
    }
  } else {
    const result = simCBv2(candles, t.tradeTime);
    if (result) {
      if (!case2Daily[t.tradeDate]) case2Daily[t.tradeDate] = { pnl: 0, count: 0, bypassCount: 0, cbv2Count: 0 };
      case2Daily[t.tradeDate].pnl += result.pnl;
      case2Daily[t.tradeDate].count++;
      case2Daily[t.tradeDate].cbv2Count++;
      cbv2Total += result.pnl;
      cbv2CountTotal++;
    }
  }
}

// 全日付
const allDates = [...new Set([...Object.keys(case1Daily), ...Object.keys(case2Daily)])].sort();

console.log("=== 日別損益比較 (SHORT限定) ===");
console.log("日付       | C1件数 | C1損益     | C2件数 | (bypass/CBv2) | C2損益     | 差分      | C1累計     | C2累計");
console.log("-----------|--------|------------|--------|---------------|------------|-----------|------------|----------");

let cum1 = 0, cum2 = 0, totalCount1 = 0, totalCount2 = 0;
for (const date of allDates) {
  const d1 = case1Daily[date] || { pnl: 0, count: 0 };
  const d2 = case2Daily[date] || { pnl: 0, count: 0, bypassCount: 0, cbv2Count: 0 };
  cum1 += d1.pnl;
  cum2 += d2.pnl;
  totalCount1 += d1.count;
  totalCount2 += d2.count;
  const diff = d2.pnl - d1.pnl;
  const extra = d2.bypassCount + d2.cbv2Count > 0 ? `${d2.bypassCount}B/${d2.cbv2Count}C` : "-";
  console.log(`${date} | ${String(d1.count).padStart(6)} | ${String(d1.pnl).padStart(10)} | ${String(d2.count).padStart(6)} | ${extra.padStart(13)} | ${String(d2.pnl).padStart(10)} | ${String(diff).padStart(9)} | ${String(cum1).padStart(10)} | ${String(cum2).padStart(10)}`);
}

console.log("-----------|--------|------------|--------|---------------|------------|-----------|------------|----------");
console.log(`合計       | ${String(totalCount1).padStart(6)} | ${String(cum1).padStart(10)} | ${String(totalCount2).padStart(6)} | ${String(bypassCountTotal+'B/'+cbv2CountTotal+'C').padStart(13)} | ${String(cum2).padStart(10)} | ${String(cum2-cum1).padStart(9)} |            |`);

console.log(`\n=== サマリー ===`);
console.log(`Case 1 (0.8%フィルター単独 SHORT): ${cum1}円 / ${totalCount1}件`);
console.log(`Case 2 (0.8% + drop_0.6バイパス + CB v2 SHORT): ${cum2}円 / ${totalCount2}件`);
console.log(`  うちバイパス: ${bypassCountTotal}件 / ${bypassTotal}円`);
console.log(`  うちCB v2: ${cbv2CountTotal}件 / ${cbv2Total}円`);
console.log(`差分: +${cum2 - cum1}円 / +${totalCount2 - totalCount1}件`);

await conn.end();
