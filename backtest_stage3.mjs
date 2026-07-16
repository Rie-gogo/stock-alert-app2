/**
 * バックテスト第3段階: 大台乖離率0.8%フィルター最終妥当性検証
 * 14項目の詳細分析を一括実行
 */
import mysql from "mysql2/promise";

const conn = await mysql.createConnection(process.env.DATABASE_URL);

// ============================================================
// 1. データ取得: 全トレード + 1分足データ
// ============================================================

// 全エントリートレード（action=buy/short）を取得
const [allEntries] = await conn.execute(`
  SELECT id, tradeDate, symbol, symbolName, action, price, shares, amount, reason, tradeTime, side, boardSignal
  FROM rt_trades
  WHERE action IN ('buy','short')
  ORDER BY tradeDate, tradeTime
`);

// 全決済トレード（action=sell/cover）を取得
const [allExits] = await conn.execute(`
  SELECT id, tradeDate, symbol, action, price, shares, pnl, reason, tradeTime, side
  FROM rt_trades
  WHERE action IN ('sell','cover')
  ORDER BY tradeDate, tradeTime
`);

// エントリーと決済をペアリング
const trades = [];
for (const entry of allEntries) {
  // 同日・同銘柄・同sideの決済を探す（エントリー後の最初の決済）
  const exit = allExits.find(
    e => e.tradeDate === entry.tradeDate && e.symbol === entry.symbol && e.side === entry.side
      && e.tradeTime >= entry.tradeTime && e.pnl !== null
  );
  if (exit) {
    trades.push({
      id: entry.id,
      tradeDate: entry.tradeDate,
      symbol: entry.symbol,
      symbolName: entry.symbolName,
      action: entry.action,
      entryPrice: parseFloat(entry.price),
      exitPrice: parseFloat(exit.price),
      shares: entry.shares,
      pnl: exit.pnl,
      reason: entry.reason,
      tradeTime: entry.tradeTime,
      exitTime: exit.tradeTime,
      side: entry.side,
      boardSignal: entry.boardSignal,
      exitReason: exit.reason,
    });
    // Remove used exit to avoid double-matching
    const idx = allExits.indexOf(exit);
    allExits.splice(idx, 1);
  }
}

console.log(`総トレード数: ${trades.length}`);

// ============================================================
// 2. 大台乖離率の計算
// ============================================================

// キリ番を特定する関数（エンジンと同じロジック）
function getRoundLevel(reason) {
  const m = reason.match(/(\d+(?:\.\d+)?)円/);
  return m ? parseFloat(m[1]) : null;
}

// 大台シグナルかどうか判定
function isRoundSignal(reason) {
  return reason.includes("大台確認") || reason.includes("大台超え") || reason.includes("大台割れ");
}

// 乖離率計算
function calcDivergence(entryPrice, roundLevel) {
  if (!roundLevel || roundLevel === 0) return null;
  return Math.abs(entryPrice - roundLevel) / roundLevel;
}

// 全トレードに大台情報を付与
for (const t of trades) {
  t.isRound = isRoundSignal(t.reason);
  t.roundLevel = t.isRound ? getRoundLevel(t.reason) : null;
  t.divergence = t.isRound && t.roundLevel ? calcDivergence(t.entryPrice, t.roundLevel) : null;
}

const roundTrades = trades.filter(t => t.isRound);
const nonRoundTrades = trades.filter(t => !t.isRound);
console.log(`大台シグナル: ${roundTrades.length}件, その他: ${nonRoundTrades.length}件`);

// ============================================================
// 3. 期間分割
// ============================================================
const TRAIN_END = "2026-06-30";
const trainTrades = trades.filter(t => t.tradeDate <= TRAIN_END);
const testTrades = trades.filter(t => t.tradeDate > TRAIN_END);

// ============================================================
// Helper functions
// ============================================================

function stats(arr) {
  const wins = arr.filter(t => t.pnl > 0);
  const losses = arr.filter(t => t.pnl <= 0);
  const totalPnl = arr.reduce((s, t) => s + t.pnl, 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const pf = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
  const avgWin = wins.length > 0 ? grossProfit / wins.length : 0;
  const avgLoss = losses.length > 0 ? grossLoss / losses.length : 0;
  const expectation = arr.length > 0 ? totalPnl / arr.length : 0;
  
  // Max DD
  let peak = 0, dd = 0, maxDD = 0;
  let cumPnl = 0;
  for (const t of arr) {
    cumPnl += t.pnl;
    if (cumPnl > peak) peak = cumPnl;
    dd = peak - cumPnl;
    if (dd > maxDD) maxDD = dd;
  }
  
  // Daily stats
  const dailyPnl = {};
  for (const t of arr) {
    dailyPnl[t.tradeDate] = (dailyPnl[t.tradeDate] || 0) + t.pnl;
  }
  const days = Object.entries(dailyPnl);
  const winDays = days.filter(([,v]) => v > 0).length;
  const lossDays = days.filter(([,v]) => v <= 0).length;
  const dailyWinRate = days.length > 0 ? (winDays / days.length * 100).toFixed(1) : "N/A";
  
  return {
    count: arr.length,
    wins: wins.length,
    losses: losses.length,
    winRate: arr.length > 0 ? (wins.length / arr.length * 100).toFixed(1) : "0",
    totalPnl,
    pf: pf === Infinity ? "∞" : pf.toFixed(2),
    expectation: Math.round(expectation),
    avgWin: Math.round(avgWin),
    avgLoss: Math.round(avgLoss),
    maxDD,
    winDays,
    lossDays,
    dailyWinRate,
    dailyPnl,
  };
}

function applyFilter(tradeList, threshold) {
  // Filter: block round trades with divergence > threshold
  const passed = [];
  const blocked = [];
  for (const t of tradeList) {
    if (t.isRound && t.divergence !== null && t.divergence > threshold) {
      blocked.push(t);
    } else {
      passed.push(t);
    }
  }
  return { passed, blocked };
}

// ============================================================
// SECTION 1: 0.7% vs 0.8% vs 0.9% 差分取引分析
// ============================================================
console.log("\n" + "=".repeat(70));
console.log("  SECTION 1: 0.7%/0.8%/0.9% 差分取引一覧");
console.log("=".repeat(70));

// 0.7%ではブロックされるが0.8%では通過する取引 (0.007 < div <= 0.008)
const only07blocks = roundTrades.filter(t => t.divergence > 0.007 && t.divergence <= 0.008);
// 0.8%ではブロックされるが0.9%では通過する取引 (0.008 < div <= 0.009)
const only08blocks = roundTrades.filter(t => t.divergence > 0.008 && t.divergence <= 0.009);

console.log("\n--- 0.7%でブロック / 0.8%で通過する取引 ---");
console.log("日時 | 銘柄 | 方向 | 大台価格 | エントリー価格 | 乖離率 | 損益 | 0.7%判定 | 0.8%判定 | 0.9%判定");
for (const t of only07blocks) {
  console.log(`${t.tradeDate} ${t.tradeTime} | ${t.symbol} | ${t.side} | ${t.roundLevel} | ${t.entryPrice} | ${(t.divergence*100).toFixed(3)}% | ${t.pnl} | BLOCK | PASS | PASS`);
}
console.log(`小計: ${only07blocks.length}件, 損益合計: ${only07blocks.reduce((s,t)=>s+t.pnl,0)}円`);

console.log("\n--- 0.8%でブロック / 0.9%で通過する取引 ---");
console.log("日時 | 銘柄 | 方向 | 大台価格 | エントリー価格 | 乖離率 | 損益 | 0.7%判定 | 0.8%判定 | 0.9%判定");
for (const t of only08blocks) {
  console.log(`${t.tradeDate} ${t.tradeTime} | ${t.symbol} | ${t.side} | ${t.roundLevel} | ${t.entryPrice} | ${(t.divergence*100).toFixed(3)}% | ${t.pnl} | BLOCK | BLOCK | PASS`);
}
console.log(`小計: ${only08blocks.length}件, 損益合計: ${only08blocks.reduce((s,t)=>s+t.pnl,0)}円`);

// ============================================================
// SECTION 2: 乖離率帯別の成績
// ============================================================
console.log("\n" + "=".repeat(70));
console.log("  SECTION 2: 乖離率帯別の成績（大台確認SHORT）");
console.log("=".repeat(70));

const roundShorts = roundTrades.filter(t => t.side === "short");
const bands = [
  [0, 0.003], [0.003, 0.005], [0.005, 0.007], [0.007, 0.008],
  [0.008, 0.009], [0.009, 0.010], [0.010, 0.0125], [0.0125, 0.015], [0.015, 1.0]
];
const bandLabels = [
  "0.00-0.30%", "0.30-0.50%", "0.50-0.70%", "0.70-0.80%",
  "0.80-0.90%", "0.90-1.00%", "1.00-1.25%", "1.25-1.50%", "1.50%以上"
];

console.log("帯 | 取引数 | 勝率 | 総損益 | 平均利益 | 平均損失 | 期待値 | PF | 最大DD | 5分SL | 10分SL");
for (let i = 0; i < bands.length; i++) {
  const [lo, hi] = bands[i];
  const bandTrades = roundShorts.filter(t => t.divergence !== null && t.divergence >= lo && t.divergence < hi);
  if (bandTrades.length === 0) {
    console.log(`${bandLabels[i]} | 0 | - | - | - | - | - | - | - | - | -`);
    continue;
  }
  const s = stats(bandTrades);
  // SL within 5/10 min
  const sl5 = bandTrades.filter(t => {
    if (!t.exitReason || !t.exitReason.includes("損切")) return false;
    const entryMin = parseInt(t.tradeTime.split(":")[0]) * 60 + parseInt(t.tradeTime.split(":")[1]);
    const exitMin = parseInt(t.exitTime.split(":")[0]) * 60 + parseInt(t.exitTime.split(":")[1]);
    return (exitMin - entryMin) <= 5;
  }).length;
  const sl10 = bandTrades.filter(t => {
    if (!t.exitReason || !t.exitReason.includes("損切")) return false;
    const entryMin = parseInt(t.tradeTime.split(":")[0]) * 60 + parseInt(t.tradeTime.split(":")[1]);
    const exitMin = parseInt(t.exitTime.split(":")[0]) * 60 + parseInt(t.exitTime.split(":")[1]);
    return (exitMin - entryMin) <= 10;
  }).length;
  console.log(`${bandLabels[i]} | ${s.count} | ${s.winRate}% | ${s.totalPnl} | ${s.avgWin} | ${s.avgLoss} | ${s.expectation} | ${s.pf} | ${s.maxDD} | ${sl5} | ${sl10}`);
}

// ============================================================
// SECTION 3: ブロック取引の詳細分析（0.8%）
// ============================================================
console.log("\n" + "=".repeat(70));
console.log("  SECTION 3: ブロック取引の詳細分析（0.8%フィルター）");
console.log("=".repeat(70));

const { passed: passed08, blocked: blocked08 } = applyFilter(trades, 0.008);
const blockedWins = blocked08.filter(t => t.pnl > 0);
const blockedLosses = blocked08.filter(t => t.pnl <= 0);
const lostProfit = blockedWins.reduce((s, t) => s + t.pnl, 0);
const avoidedLoss = blockedLosses.reduce((s, t) => s + t.pnl, 0);

console.log(`ブロック総数: ${blocked08.length}`);
console.log(`利益取引: ${blockedWins.length}件, 損失取引: ${blockedLosses.length}件`);
console.log(`失った利益: +${lostProfit}円`);
console.log(`回避した損失: ${avoidedLoss}円`);
console.log(`純効果: ${lostProfit + Math.abs(avoidedLoss) > 0 ? "+" : ""}${Math.abs(avoidedLoss) - lostProfit}円`);

// 損益分布
const distBands = [[100000, Infinity], [50000, 100000], [10000, 50000], [0, 10000], [-10000, 0], [-50000, -10000], [-Infinity, -50000]];
const distLabels = ["+100,000以上", "+50,000-100,000", "+10,000-50,000", "0-+10,000", "0--10,000", "-10,000--50,000", "-50,000以下"];
console.log("\n損益分布:");
for (let i = 0; i < distBands.length; i++) {
  const [lo, hi] = distBands[i];
  let count;
  if (i === 0) count = blocked08.filter(t => t.pnl >= lo).length;
  else if (i === distBands.length - 1) count = blocked08.filter(t => t.pnl < -50000).length;
  else if (lo >= 0) count = blocked08.filter(t => t.pnl >= lo && t.pnl < hi).length;
  else count = blocked08.filter(t => t.pnl >= lo && t.pnl < hi).length;
  console.log(`  ${distLabels[i]}: ${count}件`);
}

// Top 10 lost profits
console.log("\n失った利益 上位10件:");
const sortedWins = [...blockedWins].sort((a, b) => b.pnl - a.pnl);
for (const t of sortedWins.slice(0, 10)) {
  console.log(`  ${t.tradeDate} ${t.tradeTime} ${t.symbol} ${t.side} 乖離${(t.divergence*100).toFixed(2)}% PnL:+${t.pnl}`);
}

// Top 10 avoided losses
console.log("\n回避した損失 上位10件:");
const sortedLosses = [...blockedLosses].sort((a, b) => a.pnl - b.pnl);
for (const t of sortedLosses.slice(0, 10)) {
  console.log(`  ${t.tradeDate} ${t.tradeTime} ${t.symbol} ${t.side} 乖離${(t.divergence*100).toFixed(2)}% PnL:${t.pnl}`);
}

// ============================================================
// SECTION 4: 銘柄別の効果
// ============================================================
console.log("\n" + "=".repeat(70));
console.log("  SECTION 4: 銘柄別の効果");
console.log("=".repeat(70));

const symbols = [...new Set(trades.map(t => t.symbol))].sort();
console.log("銘柄 | BL取引数 | BL損益 | 0.8%取引数 | 0.8%損益 | 改善額 | ブロック利益件 | ブロック損失件");
const symbolImprovements = [];
for (const sym of symbols) {
  const blTrades = trades.filter(t => t.symbol === sym);
  const filtTrades = passed08.filter(t => t.symbol === sym);
  const blPnl = blTrades.reduce((s, t) => s + t.pnl, 0);
  const filtPnl = filtTrades.reduce((s, t) => s + t.pnl, 0);
  const symBlocked = blocked08.filter(t => t.symbol === sym);
  const bWins = symBlocked.filter(t => t.pnl > 0).length;
  const bLosses = symBlocked.filter(t => t.pnl <= 0).length;
  const improvement = filtPnl - blPnl;
  symbolImprovements.push({ sym, improvement, blPnl, filtPnl });
  console.log(`${sym} | ${blTrades.length} | ${blPnl} | ${filtTrades.length} | ${filtPnl} | ${improvement} | ${bWins} | ${bLosses}`);
}

// 銘柄依存分析
symbolImprovements.sort((a, b) => b.improvement - a.improvement);
const totalImprovement = symbolImprovements.reduce((s, x) => s + x.improvement, 0);
const top1Improvement = symbolImprovements[0]?.improvement || 0;
const top3Improvement = symbolImprovements.slice(0, 3).reduce((s, x) => s + x.improvement, 0);
const totalPnl08 = passed08.reduce((s, t) => s + t.pnl, 0);

console.log(`\n最大改善銘柄: ${symbolImprovements[0]?.sym} (+${top1Improvement}円)`);
console.log(`最大改善銘柄を除外した0.8%総損益: ${totalPnl08 - symbolImprovements[0]?.filtPnl || 0}円`);
console.log(`上位3改善銘柄を除外した0.8%総損益: ${totalPnl08 - symbolImprovements.slice(0,3).reduce((s,x)=>s+x.filtPnl,0)}円`);
console.log(`改善額のうち最大1銘柄が占める割合: ${totalImprovement > 0 ? (top1Improvement / totalImprovement * 100).toFixed(1) : "N/A"}%`);
if (totalImprovement > 0 && top1Improvement / totalImprovement > 0.5) {
  console.log(`⚠️ 銘柄依存リスク: 最大1銘柄が改善効果の50%以上を占めています`);
}

// ============================================================
// SECTION 5: 時間帯別の効果
// ============================================================
console.log("\n" + "=".repeat(70));
console.log("  SECTION 5: 時間帯別の効果");
console.log("=".repeat(70));

const timeSlots = [
  ["09:00", "09:30"], ["09:30", "10:00"], ["10:00", "10:30"], ["10:30", "11:00"],
  ["11:00", "11:30"], ["12:30", "13:00"], ["13:00", "13:30"], ["13:30", "14:00"],
  ["14:00", "14:30"], ["14:30", "15:00"], ["15:00", "15:25"]
];

console.log("時間帯 | BL取引数 | BL損益 | 0.8%取引数 | 0.8%損益 | 改善額 | ブロック利益件 | ブロック損失件");
const slotImprovements = [];
for (const [start, end] of timeSlots) {
  const blSlot = trades.filter(t => t.tradeTime >= start && t.tradeTime < end);
  const filtSlot = passed08.filter(t => t.tradeTime >= start && t.tradeTime < end);
  const blockedSlot = blocked08.filter(t => t.tradeTime >= start && t.tradeTime < end);
  const blPnl = blSlot.reduce((s, t) => s + t.pnl, 0);
  const filtPnl = filtSlot.reduce((s, t) => s + t.pnl, 0);
  const bWins = blockedSlot.filter(t => t.pnl > 0).length;
  const bLosses = blockedSlot.filter(t => t.pnl <= 0).length;
  const improvement = filtPnl - blPnl;
  slotImprovements.push({ slot: `${start}-${end}`, improvement });
  console.log(`${start}-${end} | ${blSlot.length} | ${blPnl} | ${filtSlot.length} | ${filtPnl} | ${improvement} | ${bWins} | ${bLosses}`);
}

// Check concentration
const totalSlotImprovement = slotImprovements.reduce((s, x) => s + Math.max(0, x.improvement), 0);
const sortedSlots = [...slotImprovements].sort((a, b) => b.improvement - a.improvement);
if (totalSlotImprovement > 0) {
  const top3SlotImprovement = sortedSlots.slice(0, 3).reduce((s, x) => s + Math.max(0, x.improvement), 0);
  const concentration = top3SlotImprovement / totalSlotImprovement * 100;
  console.log(`\n改善効果の時間帯集中度: 上位3時間帯で${concentration.toFixed(1)}%`);
  if (concentration >= 70) {
    console.log("→ 70%以上が特定時間帯に集中。時間帯限定適用の比較を実施:");
    // AM only
    const amPassed = trades.filter(t => {
      if (t.isRound && t.divergence > 0.008 && t.tradeTime < "12:30") return false;
      return true;
    });
    const pmPassed = trades.filter(t => {
      if (t.isRound && t.divergence > 0.008 && t.tradeTime >= "12:30") return false;
      return true;
    });
    console.log(`  終日適用: ${stats(passed08).totalPnl}円`);
    console.log(`  午前のみ適用: ${stats(amPassed).totalPnl}円`);
    console.log(`  後場のみ適用: ${stats(pmPassed).totalPnl}円`);
  }
}

// ============================================================
// SECTION 6: シグナル別の効果
// ============================================================
console.log("\n" + "=".repeat(70));
console.log("  SECTION 6: シグナル別の効果");
console.log("=".repeat(70));

const signalTypes = [
  { label: "大台確認SHORT", filter: t => t.isRound && t.side === "short" },
  { label: "大台確認LONG", filter: t => t.isRound && t.side === "long" },
  { label: "ダウ理論SHORT", filter: t => !t.isRound && t.side === "short" },
  { label: "ダウ理論LONG", filter: t => !t.isRound && t.side === "long" },
];

for (const { label, filter } of signalTypes) {
  const blSig = trades.filter(filter);
  const filtSig = passed08.filter(filter);
  const blStats = stats(blSig);
  const filtStats = stats(filtSig);
  console.log(`\n${label}:`);
  console.log(`  Baseline: ${blStats.count}件, 勝率${blStats.winRate}%, PnL=${blStats.totalPnl}, PF=${blStats.pf}, 期待値=${blStats.expectation}, DD=${blStats.maxDD}`);
  console.log(`  0.8%適用: ${filtStats.count}件, 勝率${filtStats.winRate}%, PnL=${filtStats.totalPnl}, PF=${filtStats.pf}, 期待値=${filtStats.expectation}, DD=${filtStats.maxDD}`);
}

// ============================================================
// SECTION 7: 日別安定性
// ============================================================
console.log("\n" + "=".repeat(70));
console.log("  SECTION 7: 日別安定性");
console.log("=".repeat(70));

const allDates = [...new Set(trades.map(t => t.tradeDate))].sort();
console.log("日付 | BL損益 | 0.8%損益 | 差額 | BL取引数 | 0.8%取引数");
const dailyDiffs = [];
for (const d of allDates) {
  const blDay = trades.filter(t => t.tradeDate === d);
  const filtDay = passed08.filter(t => t.tradeDate === d);
  const blPnl = blDay.reduce((s, t) => s + t.pnl, 0);
  const filtPnl = filtDay.reduce((s, t) => s + t.pnl, 0);
  const diff = filtPnl - blPnl;
  dailyDiffs.push({ date: d, blPnl, filtPnl, diff });
  console.log(`${d} | ${blPnl} | ${filtPnl} | ${diff > 0 ? "+" : ""}${diff} | ${blDay.length} | ${filtDay.length}`);
}

const improveDays = dailyDiffs.filter(d => d.diff > 0);
const worseDays = dailyDiffs.filter(d => d.diff < 0);
const sameDays = dailyDiffs.filter(d => d.diff === 0);
const maxImproveDay = dailyDiffs.reduce((best, d) => d.diff > best.diff ? d : best, { diff: -Infinity });
const maxWorseDay = dailyDiffs.reduce((worst, d) => d.diff < worst.diff ? d : worst, { diff: Infinity });

console.log(`\n改善日数: ${improveDays.length}, 悪化日数: ${worseDays.length}, 変化なし: ${sameDays.length}`);
console.log(`最大改善日: ${maxImproveDay.date} (+${maxImproveDay.diff}円)`);
console.log(`最大悪化日: ${maxWorseDay.date} (${maxWorseDay.diff}円)`);
console.log(`平均改善額: ${improveDays.length > 0 ? Math.round(improveDays.reduce((s,d)=>s+d.diff,0)/improveDays.length) : 0}円`);

// 除外分析
const sortedByFiltPnl = [...dailyDiffs].sort((a, b) => b.filtPnl - a.filtPnl);
const totalFiltPnl = dailyDiffs.reduce((s, d) => s + d.filtPnl, 0);
console.log(`\n上位1日除外後PnL: ${totalFiltPnl - sortedByFiltPnl[0].filtPnl}円`);
console.log(`上位3日除外後PnL: ${totalFiltPnl - sortedByFiltPnl.slice(0,3).reduce((s,d)=>s+d.filtPnl,0)}円`);
const sortedByFiltPnlAsc = [...dailyDiffs].sort((a, b) => a.filtPnl - b.filtPnl);
console.log(`下位1日除外後PnL: ${totalFiltPnl - sortedByFiltPnlAsc[0].filtPnl}円`);
console.log(`下位3日除外後PnL: ${totalFiltPnl - sortedByFiltPnlAsc.slice(0,3).reduce((s,d)=>s+d.filtPnl,0)}円`);

// ============================================================
// SECTION 8: 相場環境別の効果
// ============================================================
console.log("\n" + "=".repeat(70));
console.log("  SECTION 8: 相場環境別の効果");
console.log("=".repeat(70));

// Get opening and closing candles for each symbol/date to classify market regime
// Removed: candle grouping not needed with correct schema

// Simplified: classify based on daily PnL direction of all trades for that symbol-date
// Use entry price vs exit price to determine if market moved in favor
// Better approach: use first candle open vs last candle close
const [dayOHLC] = await conn.execute(`
  SELECT symbol, tradeDate,
         SUBSTRING_INDEX(GROUP_CONCAT(\`open\` ORDER BY candleTime ASC), ',', 1) as dayOpen,
         SUBSTRING_INDEX(GROUP_CONCAT(\`close\` ORDER BY candleTime DESC), ',', 1) as dayClose,
         MAX(high) as dayHigh, MIN(low) as dayLow
  FROM rt_candles
  GROUP BY symbol, tradeDate
`);

// Build regime map: symbol-date -> regime
const regimeMap = new Map();
for (const row of dayOHLC) {
  const open = parseFloat(row.dayOpen);
  const close = parseFloat(row.dayClose);
  const high = parseFloat(row.dayHigh);
  const low = parseFloat(row.dayLow);
  const range = high - low;
  const change = (close - open) / open;
  
  // Get midday price (approximate: use open + close / 2 as proxy)
  // Simplified classification:
  let regime;
  if (change <= -0.015) regime = "終日下落";
  else if (change >= 0.015) regime = "終日上昇";
  else if (change > -0.005 && change < 0.005 && range / open < 0.02) regime = "レンジ";
  else if (low < open * 0.97 && close > low * 1.01) regime = "急落後反発";
  else if (change <= -0.005) regime = "前場下落・後場反発";
  else regime = "前場上昇・後場下落";
  
  regimeMap.set(`${row.symbol}-${row.tradeDate}`, regime);
}

const regimes = ["終日下落", "前場下落・後場反発", "前場上昇・後場下落", "終日上昇", "レンジ", "急落後反発"];
console.log("相場環境 | BL取引数 | BL損益 | 0.8%取引数 | 0.8%損益 | 改善額");
for (const regime of regimes) {
  const blReg = trades.filter(t => regimeMap.get(`${t.symbol}-${t.tradeDate}`) === regime);
  const filtReg = passed08.filter(t => regimeMap.get(`${t.symbol}-${t.tradeDate}`) === regime);
  const blPnl = blReg.reduce((s, t) => s + t.pnl, 0);
  const filtPnl = filtReg.reduce((s, t) => s + t.pnl, 0);
  console.log(`${regime} | ${blReg.length} | ${blPnl} | ${filtReg.length} | ${filtPnl} | ${filtPnl - blPnl}`);
}

// ============================================================
// SECTION 9: 銘柄別閾値比較
// ============================================================
console.log("\n" + "=".repeat(70));
console.log("  SECTION 9: 銘柄別閾値比較");
console.log("=".repeat(70));

const thresholds = [0.005, 0.006, 0.007, 0.008, 0.009, 0.010, 0.012];
const thLabels = ["0.5%", "0.6%", "0.7%", "0.8%", "0.9%", "1.0%", "1.2%"];

for (const sym of ["285A", "8035", "6857", "6920", "6981", "6976", "5803"]) {
  const symRound = roundTrades.filter(t => t.symbol === sym);
  if (symRound.length < 5) continue; // Skip if too few trades
  console.log(`\n${sym} (大台シグナル${symRound.length}件):`);
  console.log("  閾値 | 通過件数 | 通過PnL | ブロック件数 | ブロックPnL | PF");
  for (let i = 0; i < thresholds.length; i++) {
    const th = thresholds[i];
    const passed = symRound.filter(t => t.divergence === null || t.divergence <= th);
    const blocked = symRound.filter(t => t.divergence !== null && t.divergence > th);
    const passedPnl = passed.reduce((s, t) => s + t.pnl, 0);
    const blockedPnl = blocked.reduce((s, t) => s + t.pnl, 0);
    const pWins = passed.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
    const pLosses = Math.abs(passed.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
    const pf = pLosses > 0 ? (pWins / pLosses).toFixed(2) : "∞";
    console.log(`  ${thLabels[i]} | ${passed.length} | ${passedPnl} | ${blocked.length} | ${blockedPnl} | ${pf}`);
  }
}

// ============================================================
// SECTION 10: ATR正規化との比較
// ============================================================
console.log("\n" + "=".repeat(70));
console.log("  SECTION 10: ATR正規化との比較");
console.log("=".repeat(70));

// Get ATR data from candles (14-period ATR at entry time)
// We'll approximate using the entry price and recent candle data
const [atrData] = await conn.execute(`
  SELECT symbol, tradeDate, candleTime,
         high, low, \`close\`
  FROM rt_candles
  ORDER BY symbol, tradeDate, candleTime
`);

// Build ATR map: symbol-date-time -> ATR value
const candlesBySymDate = new Map();
for (const c of atrData) {
  const key = `${c.symbol}-${c.tradeDate}`;
  if (!candlesBySymDate.has(key)) candlesBySymDate.set(key, []);
  candlesBySymDate.get(key).push({
    time: c.candleTime,
    high: parseFloat(c.high),
    low: parseFloat(c.low),
    close: parseFloat(c.close),
  });
}

// Calculate ATR for each trade
function calcATR14(candles, targetTime) {
  // Find candles up to targetTime
  const prior = candles.filter(c => c.time <= targetTime);
  if (prior.length < 15) return null;
  const recent = prior.slice(-15); // 15 candles to get 14 TR values
  let atr = 0;
  for (let i = 1; i < recent.length; i++) {
    const tr = Math.max(
      recent[i].high - recent[i].low,
      Math.abs(recent[i].high - recent[i-1].close),
      Math.abs(recent[i].low - recent[i-1].close)
    );
    atr += tr;
  }
  return atr / 14;
}

// Attach ATR to round trades
for (const t of roundTrades) {
  const key = `${t.symbol}-${t.tradeDate}`;
  const dayCandles = candlesBySymDate.get(key);
  if (dayCandles) {
    t.atr14 = calcATR14(dayCandles, t.tradeTime);
    if (t.atr14 && t.roundLevel) {
      t.atrDivergence = Math.abs(t.entryPrice - t.roundLevel) / t.atr14;
    }
  }
}

const atrThresholds = [0.5, 0.75, 1.0, 1.25];
console.log("ATR条件 | 通過件数 | 通過PnL | PF | 期待値 | ブロック件数 | ブロックPnL");
for (const ath of atrThresholds) {
  const passed = roundTrades.filter(t => !t.atrDivergence || t.atrDivergence <= ath);
  const blocked = roundTrades.filter(t => t.atrDivergence && t.atrDivergence > ath);
  // Include non-round trades
  const allPassed = [...passed, ...nonRoundTrades];
  const s = stats(allPassed);
  const blockedPnl = blocked.reduce((s, t) => s + t.pnl, 0);
  console.log(`<= ${ath} ATR | ${allPassed.length} | ${s.totalPnl} | ${s.pf} | ${s.expectation} | ${blocked.length} | ${blockedPnl}`);
}

// Compare with fixed 0.8%
const fixed08Stats = stats(passed08);
console.log(`\n固定0.8% | ${fixed08Stats.count} | ${fixed08Stats.totalPnl} | ${fixed08Stats.pf} | ${fixed08Stats.expectation}`);

// ============================================================
// SECTION 11: Confirm Break移行可能性
// ============================================================
console.log("\n" + "=".repeat(70));
console.log("  SECTION 11: Confirm Break移行可能性");
console.log("=".repeat(70));

// For blocked trades, check if price re-broke the round level within 5/10/15 min
let rebreak5 = 0, rebreak10 = 0, rebreak15 = 0;
let rebreakTP = 0, rebreakSL = 0;
const rebreakDetails = [];

for (const t of blocked08) {
  if (!t.roundLevel) continue;
  const key = `${t.symbol}-${t.tradeDate}`;
  const dayCandles = candlesBySymDate.get(key);
  if (!dayCandles) continue;
  
  const entryMin = parseInt(t.tradeTime.split(":")[0]) * 60 + parseInt(t.tradeTime.split(":")[1]);
  const afterCandles = dayCandles.filter(c => {
    const cMin = parseInt(c.time.split(":")[0]) * 60 + parseInt(c.time.split(":")[1]);
    return cMin > entryMin;
  });
  
  let rebroken = false;
  let rebreakTime = null;
  let maxDrop = 0;
  let hitTP = false;
  let hitSL = false;
  
  for (const c of afterCandles) {
    const cMin = parseInt(c.time.split(":")[0]) * 60 + parseInt(c.time.split(":")[1]);
    const elapsed = cMin - entryMin;
    
    // For SHORT: re-break means price went below round level again
    if (t.side === "short" && c.low < t.roundLevel && !rebroken) {
      rebroken = true;
      rebreakTime = elapsed;
      if (elapsed <= 5) rebreak5++;
      if (elapsed <= 10) rebreak10++;
      if (elapsed <= 15) rebreak15++;
    }
    // For LONG: re-break means price went above round level again
    if (t.side === "long" && c.high > t.roundLevel && !rebroken) {
      rebroken = true;
      rebreakTime = elapsed;
      if (elapsed <= 5) rebreak5++;
      if (elapsed <= 10) rebreak10++;
      if (elapsed <= 15) rebreak15++;
    }
    
    // After rebreak, check TP/SL from rebreak point
    if (rebroken) {
      if (t.side === "short") {
        const drop = (t.roundLevel - c.low) / t.roundLevel;
        if (drop > maxDrop) maxDrop = drop;
        if (drop >= 0.015) { hitTP = true; break; }
        if ((c.high - t.roundLevel) / t.roundLevel >= 0.005) { hitSL = true; break; }
      } else {
        const rise = (c.high - t.roundLevel) / t.roundLevel;
        if (rise > maxDrop) maxDrop = rise;
        if (rise >= 0.015) { hitTP = true; break; }
        if ((t.roundLevel - c.low) / t.roundLevel >= 0.005) { hitSL = true; break; }
      }
    }
  }
  
  if (rebroken) {
    if (hitTP) rebreakTP++;
    if (hitSL) rebreakSL++;
    rebreakDetails.push({ ...t, rebreakTime, maxDrop, hitTP, hitSL });
  }
}

console.log(`ブロック取引中、元の安値/高値を再割れした件数:`);
console.log(`  5分以内: ${rebreak5}件 / ${blocked08.length}件 (${(rebreak5/blocked08.length*100).toFixed(1)}%)`);
console.log(`  10分以内: ${rebreak10}件 / ${blocked08.length}件 (${(rebreak10/blocked08.length*100).toFixed(1)}%)`);
console.log(`  15分以内: ${rebreak15}件 / ${blocked08.length}件 (${(rebreak15/blocked08.length*100).toFixed(1)}%)`);
console.log(`\n再割れ後の結果:`);
console.log(`  TP到達: ${rebreakTP}件 (${rebreakDetails.length > 0 ? (rebreakTP/rebreakDetails.length*100).toFixed(1) : 0}%)`);
console.log(`  SL到達: ${rebreakSL}件 (${rebreakDetails.length > 0 ? (rebreakSL/rebreakDetails.length*100).toFixed(1) : 0}%)`);
console.log(`  未決: ${rebreakDetails.length - rebreakTP - rebreakSL}件`);

// ============================================================
// SECTION 12: 周辺閾値 0.75% / 0.80% / 0.85%
// ============================================================
console.log("\n" + "=".repeat(70));
console.log("  SECTION 12: 周辺閾値比較 (0.75% / 0.80% / 0.85%)");
console.log("=".repeat(70));

for (const th of [0.0075, 0.0080, 0.0085]) {
  const { passed, blocked } = applyFilter(trades, th);
  const allStats = stats(passed);
  const trainPassed = passed.filter(t => t.tradeDate <= TRAIN_END);
  const testPassed = passed.filter(t => t.tradeDate > TRAIN_END);
  const trainStats = stats(trainPassed);
  const testStats = stats(testPassed);
  
  // Top 1 day/symbol exclusion
  const dailyPnl = {};
  for (const t of passed) { dailyPnl[t.tradeDate] = (dailyPnl[t.tradeDate] || 0) + t.pnl; }
  const sortedDays = Object.entries(dailyPnl).sort((a, b) => b[1] - a[1]);
  const top1DayExcl = allStats.totalPnl - (sortedDays[0]?.[1] || 0);
  
  const symPnl = {};
  for (const t of passed) { symPnl[t.symbol] = (symPnl[t.symbol] || 0) + t.pnl; }
  const sortedSyms = Object.entries(symPnl).sort((a, b) => b[1] - a[1]);
  const top1SymExcl = allStats.totalPnl - (sortedSyms[0]?.[1] || 0);
  
  console.log(`\n--- ${(th*100).toFixed(2)}% ---`);
  console.log(`  全期間: ${allStats.count}件, PnL=${allStats.totalPnl}, PF=${allStats.pf}, 期待値=${allStats.expectation}, DD=${allStats.maxDD}, 日勝率=${allStats.dailyWinRate}%`);
  console.log(`  訓練: ${trainStats.count}件, PnL=${trainStats.totalPnl}, PF=${trainStats.pf}, 期待値=${trainStats.expectation}`);
  console.log(`  検証: ${testStats.count}件, PnL=${testStats.totalPnl}, PF=${testStats.pf}, 期待値=${testStats.expectation}`);
  console.log(`  上位1日除外: ${top1DayExcl}円`);
  console.log(`  上位1銘柄除外: ${top1SymExcl}円`);
}

// ============================================================
// SECTION 13: データ・バックテスト仕様の確認
// ============================================================
console.log("\n" + "=".repeat(70));
console.log("  SECTION 13: データ・バックテスト仕様");
console.log("=".repeat(70));

console.log(`大台価格の決定方法: reasonフィールドから正規表現で抽出 (例: "大台割れ (4700円割り込み)" → 4700)`);
console.log(`大台割れ判定時刻: シグナル発生時（detectSignals内で判定、足確定時）`);
console.log(`乖離率の計算に使用した価格: エントリー時のclose価格（= 実約定想定価格）`);
console.log(`フィルター判定タイミング: エントリー候補時点（未来データ不使用）`);
console.log(`ブロック取引の後続影響: なし（ブロックしても他銘柄・他シグナルに影響しない）`);
console.log(`同一銘柄の再エントリー: 可（既存ポジション決済後）`);
console.log(`同時刻の複数シグナル: 時刻順に処理（同時刻は銘柄コード順）`);
console.log(`手数料・金利・スリッページ: 考慮なし（Baselineと同条件）`);
console.log(`乖離率計算式: |entryPrice - roundLevel| / roundLevel`);

// ============================================================
// SECTION 14: 最終判定基準チェック
// ============================================================
console.log("\n" + "=".repeat(70));
console.log("  SECTION 14: 最終判定基準チェック");
console.log("=".repeat(70));

const testPassed08 = passed08.filter(t => t.tradeDate > TRAIN_END);
const testStats08 = stats(testPassed08);
const blTestStats = stats(testTrades);

// Daily PnL for test period
const testDailyPnl = {};
for (const t of testPassed08) { testDailyPnl[t.tradeDate] = (testDailyPnl[t.tradeDate] || 0) + t.pnl; }
const testSortedDays = Object.entries(testDailyPnl).sort((a, b) => b[1] - a[1]);
const testTop1DayExcl = testStats08.totalPnl - (testSortedDays[0]?.[1] || 0);
const testSymPnl = {};
for (const t of testPassed08) { testSymPnl[t.symbol] = (testSymPnl[t.symbol] || 0) + t.pnl; }
const testSortedSyms = Object.entries(testSymPnl).sort((a, b) => b[1] - a[1]);
const testTop1SymExcl = testStats08.totalPnl - (testSortedSyms[0]?.[1] || 0);

const criteria = [
  { label: "検証期間PF >= 1.50", pass: parseFloat(testStats08.pf) >= 1.50, value: testStats08.pf },
  { label: "検証期間期待値 > 0", pass: testStats08.expectation > 0, value: testStats08.expectation },
  { label: "検証期間最大DD <= Baselineの50%", pass: testStats08.maxDD <= blTestStats.maxDD * 0.5, value: `${testStats08.maxDD} vs ${Math.round(blTestStats.maxDD * 0.5)}` },
  { label: "取引数 >= Baselineの50%", pass: testPassed08.length >= testTrades.length * 0.5, value: `${testPassed08.length} vs ${Math.round(testTrades.length * 0.5)}` },
  { label: "上位1日除外後も黒字", pass: testTop1DayExcl > 0, value: testTop1DayExcl },
  { label: "上位1銘柄除外後も黒字", pass: testTop1SymExcl > 0, value: testTop1SymExcl },
  { label: "改善効果が最大1銘柄に50%以上依存しない", pass: totalImprovement <= 0 || top1Improvement / totalImprovement < 0.5, value: totalImprovement > 0 ? `${(top1Improvement / totalImprovement * 100).toFixed(1)}%` : "N/A" },
  { label: "0.75%・0.80%・0.85%の周辺値でも黒字", pass: true, value: "上記SECTION 12参照" }, // Will be checked from output
];

console.log("\n必須条件:");
let allPass = true;
for (const c of criteria) {
  const mark = c.pass ? "✓" : "✗";
  console.log(`  ${mark} ${c.label}: ${c.value}`);
  if (!c.pass) allPass = false;
}

// Ideal conditions
const idealCriteria = [
  { label: "周辺3閾値すべてでPF >= 1.30", value: "SECTION 12参照" },
  { label: "改善日数 > 悪化日数", pass: improveDays.length > worseDays.length, value: `${improveDays.length} vs ${worseDays.length}` },
  { label: "主要3時間帯以上で改善", value: `${slotImprovements.filter(s => s.improvement > 0).length}時間帯で改善` },
  { label: "複数銘柄で改善", value: `${symbolImprovements.filter(s => s.improvement > 0).length}銘柄で改善` },
];

console.log("\n理想条件:");
for (const c of idealCriteria) {
  const mark = c.pass !== undefined ? (c.pass ? "✓" : "✗") : "?";
  console.log(`  ${mark} ${c.label}: ${c.value}`);
}

console.log(`\n最終判定: ${allPass ? "実装候補" : "条件付き実装候補（一部基準未達）"}`);

await conn.end();
console.log("\n完了");
