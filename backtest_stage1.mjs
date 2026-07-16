/**
 * バックテスト第1段階: Case 0, 1, 3, 7, 12
 * 
 * アプローチ: 実際のrt_tradesデータ（Baseline）に対してフィルターを事後適用し、
 * 各Caseでブロックされるトレードを特定する。
 * 
 * Case 0: Baseline（現行ロジックそのまま）
 * Case 1: 大台乖離率フィルター（大台割れ/超え後、キリ番からの乖離率が閾値超でブロック）
 * Case 3: 午前始値比急落フィルター（始値比-3%以下でSHORTブロック）
 * Case 7: 日次損失停止（-5万円到達で当日新規停止）+ 連敗停止（3連敗で当日停止）
 * Case 12: Case 3 + Case 7 の組み合わせ
 */

import mysql from 'mysql2/promise';

// ============================================================
// DB接続
// ============================================================
const conn = await mysql.createConnection(process.env.DATABASE_URL);

// ============================================================
// 全期間のrt_tradesを取得してJS側でペアリング（TiDB互換）
// ============================================================
const [rawTrades] = await conn.execute(`
  SELECT id, symbol, tradeDate, side, action, price, shares, reason, tradeTime, boardSignal, pnl
  FROM rt_trades
  ORDER BY tradeDate, id
`);

const allTrades = [];
const pendingEntries = new Map();
for (const row of rawTrades) {
  const key = `${row.tradeDate}_${row.symbol}_${row.side}`;
  if (row.action === 'short' || row.action === 'buy') {
    pendingEntries.set(key, row);
  } else if (row.action === 'cover' || row.action === 'sell') {
    const entry = pendingEntries.get(key);
    if (entry) {
      allTrades.push({
        id: entry.id,
        symbol: entry.symbol,
        tradeDate: entry.tradeDate,
        side: entry.side,
        action: entry.action,
        entryPrice: entry.price,
        shares: entry.shares,
        reason: entry.reason,
        entryTime: entry.tradeTime,
        boardSignal: entry.boardSignal,
        exitPrice: row.price,
        exitTime: row.tradeTime,
        pnl: row.pnl,
        exitReason: row.reason,
      });
      pendingEntries.delete(key);
    }
  }
}

console.log(`Total entry trades loaded: ${allTrades.length}`);

// ============================================================
// 始値データ取得（各銘柄・各日の最初の足のopen）
// ============================================================
// 始値取得: 各日各銘柄の最初の足のopenを取得
const [openPricesRaw] = await conn.execute(`
  SELECT symbol, tradeDate, candleTime, open as openPrice
  FROM rt_candles
  ORDER BY tradeDate, symbol, candleTime
`);

// JS側で各日各銘柄の最初の行だけ取得
const openPrices = [];
const seenOpen = new Set();
for (const row of openPricesRaw) {
  const key = `${row.symbol}_${row.tradeDate}`;
  if (!seenOpen.has(key)) {
    seenOpen.add(key);
    openPrices.push(row);
  }
}

const openPriceMap = new Map();
for (const row of openPrices) {
  openPriceMap.set(`${row.symbol}_${row.tradeDate}`, Number(row.openPrice));
}

await conn.end();

// ============================================================
// Case 0: Baseline
// ============================================================
function case0_baseline(trades) {
  return trades; // そのまま
}

// ============================================================
// Case 1: 大台乖離率フィルター
// 大台割れ/超えシグナルのトレードで、エントリー価格がキリ番から0.5%以上乖離していたらブロック
// ============================================================
const ROUND_DIVERGENCE_THRESHOLD = 0.5; // %

function extractRoundLevel(reason) {
  // "大台確認(5本維持): 大台割れ (29500円割り込み)" → 29500
  // "大台確認(5本維持): 大台超え (30000円突破)" → 30000
  const m = reason.match(/(\d+(?:\.\d+)?)円/);
  return m ? parseFloat(m[1]) : null;
}

function case1_roundDivergence(trades) {
  return trades.filter(t => {
    if (!t.reason.includes('大台')) return true; // 大台シグナル以外は通過
    const level = extractRoundLevel(t.reason);
    if (!level) return true; // パース失敗は通過
    const divergence = Math.abs(Number(t.entryPrice) - level) / level * 100;
    if (divergence > ROUND_DIVERGENCE_THRESHOLD) {
      return false; // ブロック
    }
    return true;
  });
}

// ============================================================
// Case 3: 午前始値比急落フィルター
// 始値比-3%以下の銘柄でSHORTエントリーをブロック
// ============================================================
const AM_DROP_THRESHOLD = -3.0; // %

function case3_amDropFilter(trades) {
  return trades.filter(t => {
    if (t.side !== 'short') return true; // LONGは通過
    const openPrice = openPriceMap.get(`${t.symbol}_${t.tradeDate}`);
    if (!openPrice) return true; // データなしは通過
    const changeFromOpen = (Number(t.entryPrice) - openPrice) / openPrice * 100;
    if (changeFromOpen <= AM_DROP_THRESHOLD) {
      return false; // ブロック
    }
    return true;
  });
}

// ============================================================
// Case 7: 日次損失停止 + 連敗停止
// - 当日確定損失が-50,000円に到達したら以降の新規エントリー停止
// - 3連敗したら当日停止
// ============================================================
const DAILY_LOSS_LIMIT = -50000; // 円
const CONSECUTIVE_LOSS_LIMIT = 3;

function case7_dailyStop(trades) {
  const result = [];
  let currentDate = '';
  let dailyPnl = 0;
  let consecutiveLosses = 0;
  let stopped = false;

  for (const t of trades) {
    if (t.tradeDate !== currentDate) {
      // 新しい日
      currentDate = t.tradeDate;
      dailyPnl = 0;
      consecutiveLosses = 0;
      stopped = false;
    }

    if (stopped) continue; // 停止中はスキップ

    result.push(t);

    // この取引の結果を反映
    const pnl = Number(t.pnl) || 0;
    dailyPnl += pnl;
    if (pnl < 0) {
      consecutiveLosses++;
    } else {
      consecutiveLosses = 0;
    }

    // 停止条件チェック
    if (dailyPnl <= DAILY_LOSS_LIMIT || consecutiveLosses >= CONSECUTIVE_LOSS_LIMIT) {
      stopped = true;
    }
  }
  return result;
}

// ============================================================
// Case 12: Case 3 + Case 7 の組み合わせ
// ============================================================
function case12_combined(trades) {
  // まずCase 3でフィルター
  const afterCase3 = case3_amDropFilter(trades);
  // 次にCase 7を適用（日次損失は残ったトレードのみでカウント）
  return case7_dailyStop(afterCase3);
}

// ============================================================
// 集計関数
// ============================================================
function summarize(trades, caseName) {
  const totalTrades = trades.length;
  const wins = trades.filter(t => Number(t.pnl) > 0).length;
  const losses = trades.filter(t => Number(t.pnl) <= 0).length;
  const totalPnl = trades.reduce((sum, t) => sum + (Number(t.pnl) || 0), 0);
  const winRate = totalTrades > 0 ? (wins / totalTrades * 100).toFixed(1) : '0.0';
  const avgWin = wins > 0 ? trades.filter(t => Number(t.pnl) > 0).reduce((s, t) => s + Number(t.pnl), 0) / wins : 0;
  const avgLoss = losses > 0 ? trades.filter(t => Number(t.pnl) <= 0).reduce((s, t) => s + Number(t.pnl), 0) / losses : 0;
  const maxDrawdown = calcMaxDrawdown(trades);
  const profitFactor = avgLoss !== 0 ? Math.abs(avgWin * wins / (avgLoss * losses)) : Infinity;

  // 日別集計
  const dailyMap = new Map();
  for (const t of trades) {
    if (!dailyMap.has(t.tradeDate)) dailyMap.set(t.tradeDate, { pnl: 0, trades: 0, wins: 0 });
    const d = dailyMap.get(t.tradeDate);
    d.pnl += Number(t.pnl) || 0;
    d.trades++;
    if (Number(t.pnl) > 0) d.wins++;
  }

  // 7/7と7/16の個別結果
  const pnl0707 = trades.filter(t => t.tradeDate === '2026-07-07').reduce((s, t) => s + (Number(t.pnl) || 0), 0);
  const pnl0716 = trades.filter(t => t.tradeDate === '2026-07-16').reduce((s, t) => s + (Number(t.pnl) || 0), 0);

  return {
    caseName,
    totalTrades,
    wins,
    losses,
    winRate: parseFloat(winRate),
    totalPnl,
    avgWin: Math.round(avgWin),
    avgLoss: Math.round(avgLoss),
    profitFactor: profitFactor === Infinity ? 'Inf' : profitFactor.toFixed(2),
    maxDrawdown,
    pnl0707,
    pnl0716,
    dailyMap,
  };
}

function calcMaxDrawdown(trades) {
  let peak = 0;
  let cumPnl = 0;
  let maxDD = 0;
  for (const t of trades) {
    cumPnl += Number(t.pnl) || 0;
    if (cumPnl > peak) peak = cumPnl;
    const dd = peak - cumPnl;
    if (dd > maxDD) maxDD = dd;
  }
  return maxDD;
}

// ============================================================
// 実行
// ============================================================
const baseline = case0_baseline(allTrades);
const c1 = case1_roundDivergence(allTrades);
const c3 = case3_amDropFilter(allTrades);
const c7 = case7_dailyStop(allTrades);
const c12 = case12_combined(allTrades);

const results = [
  summarize(baseline, 'Case 0 (Baseline)'),
  summarize(c1, 'Case 1 (大台乖離率 0.5%)'),
  summarize(c3, 'Case 3 (始値比-3%フィルター)'),
  summarize(c7, 'Case 7 (日次-5万/3連敗停止)'),
  summarize(c12, 'Case 12 (Case3+Case7)'),
];

// ============================================================
// 結果出力
// ============================================================
console.log('\n====================================================');
console.log('  バックテスト第1段階結果 (2026-06-17 ～ 2026-07-16)');
console.log('====================================================\n');

console.log('| Case | 取引数 | 勝ち | 負け | 勝率 | 総損益 | 平均勝ち | 平均負け | PF | 最大DD | 7/7損益 | 7/16損益 |');
console.log('|------|--------|------|------|------|--------|----------|----------|-----|--------|---------|----------|');
for (const r of results) {
  console.log(`| ${r.caseName} | ${r.totalTrades} | ${r.wins} | ${r.losses} | ${r.winRate}% | ${r.totalPnl.toLocaleString()} | ${r.avgWin.toLocaleString()} | ${r.avgLoss.toLocaleString()} | ${r.profitFactor} | ${r.maxDrawdown.toLocaleString()} | ${r.pnl0707.toLocaleString()} | ${r.pnl0716.toLocaleString()} |`);
}

// ブロックされたトレード詳細
console.log('\n\n====================================================');
console.log('  Case 1 でブロックされたトレード');
console.log('====================================================');
const blocked1 = allTrades.filter(t => !c1.includes(t));
for (const t of blocked1) {
  const level = extractRoundLevel(t.reason);
  const div = level ? (Math.abs(Number(t.entryPrice) - level) / level * 100).toFixed(2) : '?';
  console.log(`  ${t.tradeDate} ${t.entryTime} ${t.symbol} ${t.side} @${t.entryPrice} 乖離${div}% pnl=${t.pnl} | ${t.reason.substring(0, 60)}`);
}

console.log('\n\n====================================================');
console.log('  Case 3 でブロックされたトレード');
console.log('====================================================');
const blocked3 = allTrades.filter(t => !c3.includes(t));
for (const t of blocked3) {
  const openPrice = openPriceMap.get(`${t.symbol}_${t.tradeDate}`);
  const change = openPrice ? ((Number(t.entryPrice) - openPrice) / openPrice * 100).toFixed(2) : '?';
  console.log(`  ${t.tradeDate} ${t.entryTime} ${t.symbol} ${t.side} @${t.entryPrice} 始値比${change}% pnl=${t.pnl} | ${t.reason.substring(0, 60)}`);
}

console.log('\n\n====================================================');
console.log('  Case 7 でブロックされたトレード');
console.log('====================================================');
const blocked7 = allTrades.filter(t => !c7.includes(t));
for (const t of blocked7) {
  console.log(`  ${t.tradeDate} ${t.entryTime} ${t.symbol} ${t.side} @${t.entryPrice} pnl=${t.pnl} | ${t.reason.substring(0, 60)}`);
}

// パラメータ感度分析
console.log('\n\n====================================================');
console.log('  パラメータ感度分析');
console.log('====================================================');

// Case 1: 乖離率閾値を変えてテスト
console.log('\n--- Case 1: 乖離率閾値感度 ---');
console.log('| 閾値 | 取引数 | 総損益 | ブロック数 |');
console.log('|------|--------|--------|-----------|');
for (const threshold of [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 1.0]) {
  const filtered = allTrades.filter(t => {
    if (!t.reason.includes('大台')) return true;
    const level = extractRoundLevel(t.reason);
    if (!level) return true;
    const divergence = Math.abs(Number(t.entryPrice) - level) / level * 100;
    return divergence <= threshold;
  });
  const pnl = filtered.reduce((s, t) => s + (Number(t.pnl) || 0), 0);
  console.log(`| ${threshold}% | ${filtered.length} | ${pnl.toLocaleString()} | ${allTrades.length - filtered.length} |`);
}

// Case 3: 始値比閾値を変えてテスト
console.log('\n--- Case 3: 始値比閾値感度 ---');
console.log('| 閾値 | 取引数 | 総損益 | ブロック数 |');
console.log('|------|--------|--------|-----------|');
for (const threshold of [-1.5, -2.0, -2.5, -3.0, -3.5, -4.0, -5.0]) {
  const filtered = allTrades.filter(t => {
    if (t.side !== 'short') return true;
    const openPrice = openPriceMap.get(`${t.symbol}_${t.tradeDate}`);
    if (!openPrice) return true;
    const changeFromOpen = (Number(t.entryPrice) - openPrice) / openPrice * 100;
    return changeFromOpen > threshold;
  });
  const pnl = filtered.reduce((s, t) => s + (Number(t.pnl) || 0), 0);
  console.log(`| ${threshold}% | ${filtered.length} | ${pnl.toLocaleString()} | ${allTrades.length - filtered.length} |`);
}

// Case 7: 日次損失閾値を変えてテスト
console.log('\n--- Case 7: 日次損失閾値感度 ---');
console.log('| 閾値 | 取引数 | 総損益 | ブロック数 |');
console.log('|------|--------|--------|-----------|');
for (const limit of [-30000, -40000, -50000, -60000, -70000, -80000, -100000]) {
  const filtered = [];
  let currentDate = '';
  let dailyPnl = 0;
  let consecutiveLosses = 0;
  let stopped = false;
  for (const t of allTrades) {
    if (t.tradeDate !== currentDate) {
      currentDate = t.tradeDate;
      dailyPnl = 0;
      consecutiveLosses = 0;
      stopped = false;
    }
    if (stopped) continue;
    filtered.push(t);
    const pnl = Number(t.pnl) || 0;
    dailyPnl += pnl;
    if (pnl < 0) consecutiveLosses++;
    else consecutiveLosses = 0;
    if (dailyPnl <= limit || consecutiveLosses >= CONSECUTIVE_LOSS_LIMIT) stopped = true;
  }
  const totalPnl = filtered.reduce((s, t) => s + (Number(t.pnl) || 0), 0);
  console.log(`| ${limit.toLocaleString()} | ${filtered.length} | ${totalPnl.toLocaleString()} | ${allTrades.length - filtered.length} |`);
}

// 日別損益比較表
console.log('\n\n====================================================');
console.log('  日別損益比較');
console.log('====================================================');
console.log('| 日付 | Baseline | Case1 | Case3 | Case7 | Case12 |');
console.log('|------|----------|-------|-------|-------|--------|');

const allDates = [...new Set(allTrades.map(t => t.tradeDate))].sort();
for (const date of allDates) {
  const pnlBase = baseline.filter(t => t.tradeDate === date).reduce((s, t) => s + (Number(t.pnl) || 0), 0);
  const pnlC1 = c1.filter(t => t.tradeDate === date).reduce((s, t) => s + (Number(t.pnl) || 0), 0);
  const pnlC3 = c3.filter(t => t.tradeDate === date).reduce((s, t) => s + (Number(t.pnl) || 0), 0);
  const pnlC7 = c7.filter(t => t.tradeDate === date).reduce((s, t) => s + (Number(t.pnl) || 0), 0);
  const pnlC12 = c12.filter(t => t.tradeDate === date).reduce((s, t) => s + (Number(t.pnl) || 0), 0);
  console.log(`| ${date} | ${pnlBase.toLocaleString()} | ${pnlC1.toLocaleString()} | ${pnlC3.toLocaleString()} | ${pnlC7.toLocaleString()} | ${pnlC12.toLocaleString()} |`);
}

process.exit(0);
