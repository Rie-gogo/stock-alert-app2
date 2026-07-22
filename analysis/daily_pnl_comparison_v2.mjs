/**
 * 日別損益比較 v2: 元のbacktest_crash_bypass.mjsと同一ロジックで再計算
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

// ペアリング（元のバックテストと同一ロジック）
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

// 大台シグナル判定（元のバックテストと同一）
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

// 0.8%フィルター分類（元のバックテストと同一）
const blocked08 = trades.filter(t => t.isRound && t.divergence !== null && t.divergence > 0.008);
const passed08 = trades.filter(t => !t.isRound || t.divergence === null || t.divergence <= 0.008);

// Case 1: passed08のSHORT（DBのpnlをそのまま使用）
const case1Trades = passed08.filter(t => t.side === "short");

// ブロックされたSHORT
const blocked08Short = blocked08.filter(t => t.side === "short");

console.log(`総トレード: ${trades.length}件`);
console.log(`Case 1 (0.8%通過SHORT): ${case1Trades.length}件, PnL=${case1Trades.reduce((s,t)=>s+t.pnl,0)}円`);
console.log(`ブロックSHORT: ${blocked08Short.length}件`);
console.log();

// 1分足データ取得
const uniquePairs = [...new Set(blocked08Short.map(t => `${t.symbol}|${t.tradeDate}`))];
const candleCache = {};
for (const pair of uniquePairs) {
  const [sym, date] = pair.split("|");
  const [rows] = await conn.execute(
    `SELECT symbol, tradeDate, candleTime, open, high, low, close, volume, boardSnapshot FROM rt_candles WHERE symbol = ? AND tradeDate = ? ORDER BY candleTime ASC`,
    [sym, date]
  );
  candleCache[pair] = rows.map(r => ({
    ...r, open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close), volume: Number(r.volume),
    boardSnapshot: r.boardSnapshot && typeof r.boardSnapshot === 'string' ? JSON.parse(r.boardSnapshot) : r.boardSnapshot || null,
  }));
}

// drop_0.6判定（元のバックテストと同一: 3本前の始値から現在足終値の下落率）
function calcDropRate3(candles, idx) {
  if (idx < 3) return 0;
  const open3ago = candles[idx - 2].open;
  return (candles[idx].close - open3ago) / open3ago;
}

function checkDrop06(candles, blockTime) {
  const idx = candles.findIndex(c => c.candleTime >= blockTime);
  if (idx < 3) return false;
  const dropRate = calcDropRate3(candles, idx);
  return dropRate <= -0.006; // 0.6%以上下落
}

// バイパスエントリーシミュレーション（元のバックテストと同一: 次足始値でエントリー）
function simBypassEntry(candles, blockTime) {
  const idx = candles.findIndex(c => c.candleTime >= blockTime);
  if (idx < 0 || idx + 1 >= candles.length) return null;
  
  const entryPrice = candles[idx + 1].open; // 次足始値
  const shares = Math.floor(POSITION_SIZE / entryPrice);
  if (shares <= 0) return null;
  
  const slPrice = entryPrice * (1 + SL_PCT);
  const tpPrice = entryPrice * (1 - TP_PCT);
  
  for (let j = idx + 1; j < candles.length; j++) {
    const c = candles[j];
    if (c.high >= slPrice) {
      return { pnl: Math.round((entryPrice - slPrice) * shares), exitReason: "SL", entryPrice, shares };
    }
    if (c.low <= tpPrice) {
      return { pnl: Math.round((entryPrice - tpPrice) * shares), exitReason: "TP", entryPrice, shares };
    }
    if (c.candleTime >= FORCE_EXIT_TIME) {
      return { pnl: Math.round((entryPrice - c.close) * shares), exitReason: "EOD", entryPrice, shares };
    }
  }
  return null;
}

// CB v2シミュレーション（元のバックテストと同一）
function calcATR7(candles, idx) {
  if (idx < 7) return null;
  let sum = 0;
  for (let i = idx - 6; i <= idx; i++) {
    sum += candles[i].high - candles[i].low;
  }
  return sum / 7;
}

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
      // 反発確認
      if (c.low < impulseLow) impulseLow = c.low;
      const rebound = (c.high - impulseLow) / impulseLow;
      if (rebound >= REBOUND_PCT) {
        state = 2;
        swingHigh = c.high;
        consecutiveNoNewHigh = 0;
      }
    } else if (state === 2) {
      // 戻り高値形成（2本連続高値未更新）
      if (c.high > swingHigh) {
        swingHigh = c.high;
        consecutiveNoNewHigh = 0;
      } else {
        consecutiveNoNewHigh++;
      }
      if (consecutiveNoNewHigh >= 2) {
        state = 3;
        // MA5の初期位置を確認
        const start = Math.max(0, i - 4);
        const ma5 = candles.slice(start, i + 1).reduce((s, x) => s + x.close, 0) / (i - start + 1);
        prevAboveMA5 = c.close > ma5;
      }
    } else if (state === 3) {
      // MA5下クロス確認
      const start = Math.max(0, i - 4);
      const ma5 = candles.slice(start, i + 1).reduce((s, x) => s + x.close, 0) / (i - start + 1);
      const currentAbove = c.close > ma5;
      if (prevAboveMA5 && !currentAbove) {
        state = 4;
      }
      prevAboveMA5 = currentAbove;
    } else if (state === 4) {
      // 再ブレイク確認（終値で安値再割れ）
      if (c.close < impulseLow) {
        // エントリー成立: 次足始値
        if (i + 1 >= candles.length) return null;
        const entryPrice = candles[i + 1].open;
        const shares = Math.floor(POSITION_SIZE / entryPrice);
        if (shares <= 0) return null;
        
        const slPrice = entryPrice * (1 + SL_PCT);
        const tpPrice = entryPrice * (1 - TP_PCT);
        
        for (let j = i + 1; j < candles.length; j++) {
          const cc = candles[j];
          if (cc.high >= slPrice) {
            return { pnl: Math.round((entryPrice - slPrice) * shares), exitReason: "SL", entryPrice, shares };
          }
          if (cc.low <= tpPrice) {
            return { pnl: Math.round((entryPrice - tpPrice) * shares), exitReason: "TP", entryPrice, shares };
          }
          if (cc.candleTime >= FORCE_EXIT_TIME) {
            return { pnl: Math.round((entryPrice - cc.close) * shares), exitReason: "EOD", entryPrice, shares };
          }
        }
        return null;
      }
    }
  }
  return null; // タイムアウト
}

// Case 2: drop_0.6バイパス + CB v2
const case2DailyPnl = {};
// Case 1の通過分をコピー
for (const t of case1Trades) {
  if (!case2DailyPnl[t.tradeDate]) case2DailyPnl[t.tradeDate] = 0;
  case2DailyPnl[t.tradeDate] += t.pnl;
}

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
    const result = simBypassEntry(candles, t.tradeTime);
    if (result) {
      if (!case2DailyPnl[t.tradeDate]) case2DailyPnl[t.tradeDate] = 0;
      case2DailyPnl[t.tradeDate] += result.pnl;
      bypassCount++;
      bypassPnl += result.pnl;
      bypassTrades.push({ date: t.tradeDate, symbol: t.symbol, entryPrice: result.entryPrice, ...result });
    }
  } else {
    const result = simCBv2(candles, t.tradeTime);
    if (result) {
      if (!case2DailyPnl[t.tradeDate]) case2DailyPnl[t.tradeDate] = 0;
      case2DailyPnl[t.tradeDate] += result.pnl;
      cbv2Count++;
      cbv2Pnl += result.pnl;
      cbv2Trades.push({ date: t.tradeDate, symbol: t.symbol, entryPrice: result.entryPrice, ...result });
    }
  }
}

// Case 1 日別
const case1DailyPnl = {};
for (const t of case1Trades) {
  if (!case1DailyPnl[t.tradeDate]) case1DailyPnl[t.tradeDate] = 0;
  case1DailyPnl[t.tradeDate] += t.pnl;
}

// 全日付
const allDates = [...new Set([...Object.keys(case1DailyPnl), ...Object.keys(case2DailyPnl)])].sort();

console.log("=== 日別損益比較 (SHORT限定) ===");
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
console.log(`Case 1 (0.8%フィルター単独 SHORT): ${cum1}円 (${case1Trades.length}件)`);
console.log(`Case 2 (0.8% + drop_0.6バイパス + CB v2 SHORT): ${cum2}円`);
console.log(`差分: +${cum2 - cum1}円`);
console.log(`\nバイパス: ${bypassCount}件, ${bypassPnl}円`);
console.log(`CB v2: ${cbv2Count}件, ${cbv2Pnl}円`);

// 元のバックテスト結果との照合
console.log(`\n=== 元のバックテストとの照合 ===`);
console.log(`元 Case 1: 201,955円 (72件) → 今回: ${cum1}円 (${case1Trades.length}件)`);
console.log(`元 drop_0.6全体: 544,601円 (93件) → 今回: ${cum2}円`);
console.log(`元 バイパス: 11件/312,771円 → 今回: ${bypassCount}件/${bypassPnl}円`);
console.log(`元 CB v2: 10件/29,875円 → 今回: ${cbv2Count}件/${cbv2Pnl}円`);

console.log(`\n=== バイパス取引詳細 ===`);
for (const t of bypassTrades) {
  console.log(`  ${t.date} ${t.symbol} @${t.entryPrice} → ${t.exitReason} pnl=${t.pnl}`);
}

console.log(`\n=== CB v2取引詳細 ===`);
for (const t of cbv2Trades) {
  console.log(`  ${t.date} ${t.symbol} @${t.entryPrice} → ${t.exitReason} pnl=${t.pnl}`);
}

await conn.end();
