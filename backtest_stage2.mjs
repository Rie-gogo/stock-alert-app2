/**
 * バックテスト第2段階: アウトオブサンプル検証 + ブロック取引分析
 * 
 * 検証対象:
 * - 大台乖離率: 0.7%, 0.8%, 0.9%
 * - 始値比: -3.5%, -4.0%, -4.5%, -5.0%
 * 
 * 期間分割:
 * - 訓練期間: 前半11営業日 (6/17～6/30)
 * - 検証期間: 後半11営業日 (7/1～7/16)
 * 
 * 条件付き: 単独条件がOOS(検証期間)でBaselineを上回った場合のみ日次-6万停止と組み合わせ
 */

import mysql from 'mysql2/promise';

const conn = await mysql.createConnection(process.env.DATABASE_URL);

// ============================================================
// データ取得
// ============================================================
const [rawTrades] = await conn.execute(`
  SELECT id, symbol, tradeDate, side, action, price, shares, reason, tradeTime, boardSignal, pnl
  FROM rt_trades
  ORDER BY tradeDate, id
`);

// エントリーと決済をペアリング
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

// 始値データ取得
const [openPricesRaw] = await conn.execute(`
  SELECT symbol, tradeDate, candleTime, open as openPrice
  FROM rt_candles
  ORDER BY tradeDate, symbol, candleTime
`);

const openPriceMap = new Map();
const seenOpen = new Set();
for (const row of openPricesRaw) {
  const key = `${row.symbol}_${row.tradeDate}`;
  if (!seenOpen.has(key)) {
    seenOpen.add(key);
    openPriceMap.set(key, Number(row.openPrice));
  }
}

await conn.end();

console.log(`Total trades loaded: ${allTrades.length}`);

// ============================================================
// 期間分割
// ============================================================
const allDates = [...new Set(allTrades.map(t => t.tradeDate))].sort();
const midpoint = Math.ceil(allDates.length / 2);
const trainDates = new Set(allDates.slice(0, midpoint));
const testDates = new Set(allDates.slice(midpoint));

console.log(`\n期間分割:`);
console.log(`  訓練期間: ${allDates[0]} ～ ${allDates[midpoint - 1]} (${trainDates.size}日)`);
console.log(`  検証期間: ${allDates[midpoint]} ～ ${allDates[allDates.length - 1]} (${testDates.size}日)`);

const trainTrades = allTrades.filter(t => trainDates.has(t.tradeDate));
const testTrades = allTrades.filter(t => testDates.has(t.tradeDate));

// ============================================================
// フィルター関数
// ============================================================
function extractRoundLevel(reason) {
  const m = reason.match(/(\d+(?:\.\d+)?)円/);
  return m ? parseFloat(m[1]) : null;
}

function filterRoundDivergence(trades, threshold) {
  return trades.filter(t => {
    if (!t.reason.includes('大台')) return true;
    const level = extractRoundLevel(t.reason);
    if (!level) return true;
    const divergence = Math.abs(Number(t.entryPrice) - level) / level * 100;
    return divergence <= threshold;
  });
}

function filterAmDrop(trades, threshold) {
  return trades.filter(t => {
    if (t.side !== 'short') return true;
    const openPrice = openPriceMap.get(`${t.symbol}_${t.tradeDate}`);
    if (!openPrice) return true;
    const changeFromOpen = (Number(t.entryPrice) - openPrice) / openPrice * 100;
    return changeFromOpen > threshold;
  });
}

function filterDailyStop(trades, limit, consecutiveLimit) {
  const result = [];
  let currentDate = '';
  let dailyPnl = 0;
  let consecutiveLosses = 0;
  let stopped = false;
  for (const t of trades) {
    if (t.tradeDate !== currentDate) {
      currentDate = t.tradeDate;
      dailyPnl = 0;
      consecutiveLosses = 0;
      stopped = false;
    }
    if (stopped) continue;
    result.push(t);
    const pnl = Number(t.pnl) || 0;
    dailyPnl += pnl;
    if (pnl < 0) consecutiveLosses++;
    else consecutiveLosses = 0;
    if (dailyPnl <= limit || consecutiveLosses >= consecutiveLimit) stopped = true;
  }
  return result;
}

// ============================================================
// 集計関数（フル版）
// ============================================================
function fullAnalysis(trades, allTradesForComparison, caseName) {
  const totalTrades = trades.length;
  if (totalTrades === 0) return { caseName, totalTrades: 0, totalPnl: 0 };

  const wins = trades.filter(t => Number(t.pnl) > 0);
  const losses = trades.filter(t => Number(t.pnl) <= 0);
  const totalPnl = trades.reduce((s, t) => s + (Number(t.pnl) || 0), 0);
  const winRate = (wins.length / totalTrades * 100).toFixed(1);
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + Number(t.pnl), 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + Number(t.pnl), 0) / losses.length : 0;
  const pf = (avgLoss !== 0 && losses.length > 0) ? Math.abs(avgWin * wins.length / (avgLoss * losses.length)) : Infinity;
  const expectancy = totalPnl / totalTrades;

  // 最大DD
  let peak = 0, cumPnl = 0, maxDD = 0;
  for (const t of trades) {
    cumPnl += Number(t.pnl) || 0;
    if (cumPnl > peak) peak = cumPnl;
    const dd = peak - cumPnl;
    if (dd > maxDD) maxDD = dd;
  }

  // 日別集計
  const dailyMap = new Map();
  for (const t of trades) {
    if (!dailyMap.has(t.tradeDate)) dailyMap.set(t.tradeDate, 0);
    dailyMap.set(t.tradeDate, dailyMap.get(t.tradeDate) + (Number(t.pnl) || 0));
  }
  const profitDays = [...dailyMap.values()].filter(v => v > 0).length;
  const lossDays = [...dailyMap.values()].filter(v => v <= 0).length;
  const dailyWinRate = (profitDays / (profitDays + lossDays) * 100).toFixed(1);

  // 銘柄別損益
  const symbolMap = new Map();
  for (const t of trades) {
    if (!symbolMap.has(t.symbol)) symbolMap.set(t.symbol, 0);
    symbolMap.set(t.symbol, symbolMap.get(t.symbol) + (Number(t.pnl) || 0));
  }

  // ブロック取引分析
  const blocked = allTradesForComparison.filter(t => !trades.includes(t));
  const blockedWins = blocked.filter(t => Number(t.pnl) > 0);
  const blockedLosses = blocked.filter(t => Number(t.pnl) <= 0);
  const lostProfit = blockedWins.reduce((s, t) => s + Number(t.pnl), 0);
  const avoidedLoss = blockedLosses.reduce((s, t) => s + Number(t.pnl), 0);

  // 上位1日除外
  const dailyPnls = [...dailyMap.entries()].sort((a, b) => b[1] - a[1]);
  const bestDay = dailyPnls[0] || ['', 0];
  const pnlExBestDay = totalPnl - bestDay[1];

  // 上位1銘柄除外
  const symbolPnls = [...symbolMap.entries()].sort((a, b) => b[1] - a[1]);
  const bestSymbol = symbolPnls[0] || ['', 0];
  const pnlExBestSymbol = totalPnl - bestSymbol[1];

  return {
    caseName,
    totalTrades,
    wins: wins.length,
    losses: losses.length,
    winRate: parseFloat(winRate),
    totalPnl,
    avgWin: Math.round(avgWin),
    avgLoss: Math.round(avgLoss),
    pf: pf === Infinity ? 'Inf' : pf.toFixed(2),
    maxDD,
    expectancy: Math.round(expectancy),
    profitDays,
    lossDays,
    dailyWinRate: parseFloat(dailyWinRate),
    symbolMap,
    blockedCount: blocked.length,
    blockedWinCount: blockedWins.length,
    blockedLossCount: blockedLosses.length,
    lostProfit,
    avoidedLoss,
    bestDay,
    pnlExBestDay,
    bestSymbol,
    pnlExBestSymbol,
  };
}

// ============================================================
// メイン実行
// ============================================================
const output = [];

function printSection(title) {
  output.push(`\n${'='.repeat(70)}`);
  output.push(`  ${title}`);
  output.push(`${'='.repeat(70)}\n`);
}

function printResult(r, period) {
  output.push(`--- ${r.caseName} [${period}] ---`);
  output.push(`  取引数: ${r.totalTrades} (勝${r.wins} / 負${r.losses})`);
  output.push(`  勝率: ${r.winRate}% | 日別勝率: ${r.dailyWinRate}%`);
  output.push(`  総損益: ${r.totalPnl.toLocaleString()}円`);
  output.push(`  PF: ${r.pf} | 期待値: ${r.expectancy.toLocaleString()}円/取引`);
  output.push(`  最大DD: ${r.maxDD.toLocaleString()}円`);
  output.push(`  利益日数: ${r.profitDays} / 損失日数: ${r.lossDays}`);
  output.push(`  ブロック: ${r.blockedCount}件 (利益${r.blockedWinCount}件 / 損失${r.blockedLossCount}件)`);
  output.push(`  失った利益: ${r.lostProfit.toLocaleString()}円 | 回避した損失: ${r.avoidedLoss.toLocaleString()}円`);
  output.push(`  上位1日(${r.bestDay[0]}: ${r.bestDay[1].toLocaleString()})除外後: ${r.pnlExBestDay.toLocaleString()}円`);
  output.push(`  上位1銘柄(${r.bestSymbol[0]}: ${r.bestSymbol[1].toLocaleString()})除外後: ${r.pnlExBestSymbol.toLocaleString()}円`);
  output.push(`  銘柄別損益:`);
  for (const [sym, pnl] of [...r.symbolMap.entries()].sort((a, b) => b[1] - a[1])) {
    output.push(`    ${sym}: ${pnl.toLocaleString()}円`);
  }
  output.push('');
}

// ============================================================
// Baseline
// ============================================================
printSection('Baseline (Case 0)');
const baseAll = fullAnalysis(allTrades, allTrades, 'Baseline');
const baseTrain = fullAnalysis(trainTrades, trainTrades, 'Baseline');
const baseTest = fullAnalysis(testTrades, testTrades, 'Baseline');
printResult(baseAll, '全期間');
printResult(baseTrain, '訓練期間');
printResult(baseTest, '検証期間');

// ============================================================
// 大台乖離率
// ============================================================
printSection('大台乖離率フィルター');

const roundResults = {};
for (const threshold of [0.7, 0.8, 0.9]) {
  const label = `大台乖離率 ${threshold}%`;
  const filtAll = filterRoundDivergence(allTrades, threshold);
  const filtTrain = filterRoundDivergence(trainTrades, threshold);
  const filtTest = filterRoundDivergence(testTrades, threshold);
  
  const rAll = fullAnalysis(filtAll, allTrades, label);
  const rTrain = fullAnalysis(filtTrain, trainTrades, label);
  const rTest = fullAnalysis(filtTest, testTrades, label);
  
  roundResults[threshold] = { all: rAll, train: rTrain, test: rTest };
  
  output.push(`\n### ${label}`);
  printResult(rAll, '全期間');
  printResult(rTrain, '訓練期間');
  printResult(rTest, '検証期間');
  
  // 訓練/検証の成績差
  output.push(`  【訓練vs検証】`);
  output.push(`    訓練PnL: ${rTrain.totalPnl.toLocaleString()} | 検証PnL: ${rTest.totalPnl.toLocaleString()}`);
  output.push(`    訓練PF: ${rTrain.pf} | 検証PF: ${rTest.pf}`);
  output.push(`    訓練期待値: ${rTrain.expectancy.toLocaleString()} | 検証期待値: ${rTest.expectancy.toLocaleString()}`);
  output.push(`    差異: ${rTest.totalPnl - rTrain.totalPnl > 0 ? '+' : ''}${(rTest.totalPnl - rTrain.totalPnl).toLocaleString()}円`);
  output.push('');
}

// ============================================================
// 始値比フィルター
// ============================================================
printSection('始値比フィルター');

const amResults = {};
for (const threshold of [-3.5, -4.0, -4.5, -5.0]) {
  const label = `始値比 ${threshold}%`;
  const filtAll = filterAmDrop(allTrades, threshold);
  const filtTrain = filterAmDrop(trainTrades, threshold);
  const filtTest = filterAmDrop(testTrades, threshold);
  
  const rAll = fullAnalysis(filtAll, allTrades, label);
  const rTrain = fullAnalysis(filtTrain, trainTrades, label);
  const rTest = fullAnalysis(filtTest, testTrades, label);
  
  amResults[threshold] = { all: rAll, train: rTrain, test: rTest };
  
  output.push(`\n### ${label}`);
  printResult(rAll, '全期間');
  printResult(rTrain, '訓練期間');
  printResult(rTest, '検証期間');
  
  output.push(`  【訓練vs検証】`);
  output.push(`    訓練PnL: ${rTrain.totalPnl.toLocaleString()} | 検証PnL: ${rTest.totalPnl.toLocaleString()}`);
  output.push(`    訓練PF: ${rTrain.pf} | 検証PF: ${rTest.pf}`);
  output.push(`    訓練期待値: ${rTrain.expectancy.toLocaleString()} | 検証期待値: ${rTest.expectancy.toLocaleString()}`);
  output.push(`    差異: ${rTest.totalPnl - rTrain.totalPnl > 0 ? '+' : ''}${(rTest.totalPnl - rTrain.totalPnl).toLocaleString()}円`);
  output.push('');
}

// ============================================================
// 組み合わせ検証（条件付き）
// ============================================================
printSection('組み合わせ検証（日次-6万停止）');

// 大台乖離率でOOSがBaselineを上回ったもの
const baseTestPnl = baseTest.totalPnl;
output.push(`検証期間Baseline総損益: ${baseTestPnl.toLocaleString()}円\n`);

let combinedRun = false;

for (const threshold of [0.7, 0.8, 0.9]) {
  const r = roundResults[threshold];
  if (r.test.totalPnl > baseTestPnl) {
    combinedRun = true;
    const label = `大台乖離率${threshold}% + 日次-6万停止`;
    output.push(`\n### ${label} (OOS: ${r.test.totalPnl.toLocaleString()} > Baseline: ${baseTestPnl.toLocaleString()})`);
    
    const filtAll = filterDailyStop(filterRoundDivergence(allTrades, threshold), -60000, 3);
    const filtTrain = filterDailyStop(filterRoundDivergence(trainTrades, threshold), -60000, 3);
    const filtTest = filterDailyStop(filterRoundDivergence(testTrades, threshold), -60000, 3);
    
    const rAll = fullAnalysis(filtAll, allTrades, label);
    const rTrain = fullAnalysis(filtTrain, trainTrades, label);
    const rTest = fullAnalysis(filtTest, testTrades, label);
    
    printResult(rAll, '全期間');
    printResult(rTrain, '訓練期間');
    printResult(rTest, '検証期間');
    
    output.push(`  【訓練vs検証】`);
    output.push(`    訓練PnL: ${rTrain.totalPnl.toLocaleString()} | 検証PnL: ${rTest.totalPnl.toLocaleString()}`);
    output.push(`    差異: ${rTest.totalPnl - rTrain.totalPnl > 0 ? '+' : ''}${(rTest.totalPnl - rTrain.totalPnl).toLocaleString()}円`);
  } else {
    output.push(`大台乖離率${threshold}%: OOS ${r.test.totalPnl.toLocaleString()} <= Baseline ${baseTestPnl.toLocaleString()} → 組み合わせスキップ`);
  }
}

for (const threshold of [-3.5, -4.0, -4.5, -5.0]) {
  const r = amResults[threshold];
  if (r.test.totalPnl > baseTestPnl) {
    combinedRun = true;
    const label = `始値比${threshold}% + 日次-6万停止`;
    output.push(`\n### ${label} (OOS: ${r.test.totalPnl.toLocaleString()} > Baseline: ${baseTestPnl.toLocaleString()})`);
    
    const filtAll = filterDailyStop(filterAmDrop(allTrades, threshold), -60000, 3);
    const filtTrain = filterDailyStop(filterAmDrop(trainTrades, threshold), -60000, 3);
    const filtTest = filterDailyStop(filterAmDrop(testTrades, threshold), -60000, 3);
    
    const rAll = fullAnalysis(filtAll, allTrades, label);
    const rTrain = fullAnalysis(filtTrain, trainTrades, label);
    const rTest = fullAnalysis(filtTest, testTrades, label);
    
    printResult(rAll, '全期間');
    printResult(rTrain, '訓練期間');
    printResult(rTest, '検証期間');
    
    output.push(`  【訓練vs検証】`);
    output.push(`    訓練PnL: ${rTrain.totalPnl.toLocaleString()} | 検証PnL: ${rTest.totalPnl.toLocaleString()}`);
    output.push(`    差異: ${rTest.totalPnl - rTrain.totalPnl > 0 ? '+' : ''}${(rTest.totalPnl - rTrain.totalPnl).toLocaleString()}円`);
  } else {
    output.push(`始値比${threshold}%: OOS ${r.test.totalPnl.toLocaleString()} <= Baseline ${baseTestPnl.toLocaleString()} → 組み合わせスキップ`);
  }
}

if (!combinedRun) {
  output.push(`\n※ いずれの単独条件もOOSでBaselineを上回らなかったため、組み合わせ検証は実施せず。`);
}

// ============================================================
// サマリーテーブル
// ============================================================
printSection('サマリーテーブル');

output.push('| Case | 期間 | 取引数 | 勝率 | 総損益 | PF | 期待値 | 最大DD | 日勝率 | 利益日/損失日 | ブロック利益件/損失件 | 失った利益 | 回避損失 | 上位1日除外PnL | 上位1銘柄除外PnL |');
output.push('|------|------|--------|------|--------|-----|--------|--------|--------|-------------|---------------------|-----------|---------|---------------|----------------|');

function tableRow(r, period) {
  return `| ${r.caseName} | ${period} | ${r.totalTrades} | ${r.winRate}% | ${r.totalPnl.toLocaleString()} | ${r.pf} | ${r.expectancy.toLocaleString()} | ${r.maxDD.toLocaleString()} | ${r.dailyWinRate}% | ${r.profitDays}/${r.lossDays} | ${r.blockedWinCount}/${r.blockedLossCount} | ${r.lostProfit.toLocaleString()} | ${r.avoidedLoss.toLocaleString()} | ${r.pnlExBestDay.toLocaleString()} | ${r.pnlExBestSymbol.toLocaleString()} |`;
}

output.push(tableRow(baseAll, '全'));
output.push(tableRow(baseTrain, '訓練'));
output.push(tableRow(baseTest, '検証'));

for (const threshold of [0.7, 0.8, 0.9]) {
  const r = roundResults[threshold];
  output.push(tableRow(r.all, '全'));
  output.push(tableRow(r.train, '訓練'));
  output.push(tableRow(r.test, '検証'));
}

for (const threshold of [-3.5, -4.0, -4.5, -5.0]) {
  const r = amResults[threshold];
  output.push(tableRow(r.all, '全'));
  output.push(tableRow(r.train, '訓練'));
  output.push(tableRow(r.test, '検証'));
}

// 出力
const fullOutput = output.join('\n');
console.log(fullOutput);

// ファイル保存
import { writeFileSync } from 'fs';
writeFileSync('/home/ubuntu/backtest/results_stage2.txt', fullOutput);

process.exit(0);
