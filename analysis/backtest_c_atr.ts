/**
 * Backtest Proposal C with ATR-based BE trigger:
 * - Baseline: SL 0.5%, TP 1.5%
 * - C1: BE trigger = +0.5% (fixed)
 * - C_ATR: BE trigger = max(0.5%, 0.8 * ATR)
 * 
 * ATR is calculated as the average of (high-low)/close for the last 14 candles before entry.
 */

import { getDb } from '../server/db';
import { sql } from 'drizzle-orm';

interface Trade {
  id: number;
  symbol: string;
  symbolName: string;
  tradeDate: string;
  tradeTime: string;
  action: string;
  price: number;
  shares: number;
  pnl: number | null;
  reason: string;
  side: string;
}

async function main() {
  const db = await getDb();
  
  const tradeResult = await db.execute(
    sql`SELECT id, symbol, symbolName, tradeDate, tradeTime, action, price, shares, pnl, reason, side
        FROM rt_trades ORDER BY tradeDate, tradeTime`
  ) as any;
  const allTrades: Trade[] = (tradeResult[0] ?? tradeResult).map((t: any) => ({
    ...t,
    price: Number(t.price),
    shares: Number(t.shares),
    pnl: t.pnl !== null ? Number(t.pnl) : null,
  }));
  
  const entries = allTrades.filter(t => t.pnl === null);
  
  interface SimResult {
    symbol: string;
    symbolName: string;
    date: string;
    time: string;
    side: string;
    entryPrice: number;
    shares: number;
    atr: number;        // ATR as percentage
    beTrigger_fixed: number;  // 0.5%
    beTrigger_atr: number;    // max(0.5%, 0.8*ATR)
    baseline_pnl: number;
    c1_pnl: number;     // fixed 0.5% BE
    cATR_pnl: number;   // max(0.5%, 0.8*ATR) BE
    exitReason_baseline: string;
    exitReason_c1: string;
    exitReason_cATR: string;
  }
  
  const results: SimResult[] = [];
  
  for (const entry of entries) {
    const exit = allTrades.find(t => 
      t.symbol === entry.symbol && 
      t.tradeDate === entry.tradeDate &&
      t.tradeTime > entry.tradeTime && 
      t.pnl !== null
    );
    if (!exit) continue;
    
    // Calculate ATR (14-period) before entry
    const atrCandles = await db.execute(
      sql`SELECT high, low, close
          FROM rt_candles 
          WHERE symbol = ${entry.symbol} AND tradeDate = ${entry.tradeDate}
          AND candleTime <= ${entry.tradeTime}
          ORDER BY candleTime DESC LIMIT 14`
    ) as any;
    const atrRows = atrCandles[0] ?? atrCandles;
    
    let atr = 0;
    if (atrRows.length > 0) {
      const ranges = atrRows.map((c: any) => (Number(c.high) - Number(c.low)) / Number(c.close));
      atr = ranges.reduce((a: number, b: number) => a + b, 0) / ranges.length;
    }
    
    const beTrigger_fixed = 0.005; // 0.5%
    const beTrigger_atr = Math.max(0.005, 0.8 * atr); // max(0.5%, 0.8*ATR)
    
    // Get holding candles
    const holdingCandles = await db.execute(
      sql`SELECT candleTime, open, high, low, close, volume
          FROM rt_candles 
          WHERE symbol = ${entry.symbol} AND tradeDate = ${entry.tradeDate}
          AND candleTime > ${entry.tradeTime}
          ORDER BY candleTime`
    ) as any;
    const holding = holdingCandles[0] ?? holdingCandles;
    
    const slPct = 0.005;
    const tpPct = 0.015;
    
    let baseline_pnl: number | null = null;
    let c1_pnl: number | null = null;
    let cATR_pnl: number | null = null;
    let exitReason_baseline = '大引け';
    let exitReason_c1 = '大引け';
    let exitReason_cATR = '大引け';
    
    let c1_beTriggered = false;
    let cATR_beTriggered = false;
    
    for (const c of holding) {
      const high = Number(c.high);
      const low = Number(c.low);
      
      let unrealizedHigh: number, unrealizedLow: number;
      
      if (entry.side === 'short') {
        unrealizedHigh = (entry.price - low) / entry.price;
        unrealizedLow = (entry.price - high) / entry.price;
      } else {
        unrealizedHigh = (high - entry.price) / entry.price;
        unrealizedLow = (low - entry.price) / entry.price;
      }
      
      // --- Baseline ---
      if (baseline_pnl === null) {
        if (unrealizedLow <= -slPct) {
          baseline_pnl = -slPct * entry.price * entry.shares;
          exitReason_baseline = 'SL(-0.5%)';
        } else if (unrealizedHigh >= tpPct) {
          baseline_pnl = tpPct * entry.price * entry.shares;
          exitReason_baseline = 'TP(+1.5%)';
        }
      }
      
      // --- C1: fixed 0.5% BE ---
      if (c1_pnl === null) {
        if (!c1_beTriggered && unrealizedHigh >= beTrigger_fixed) {
          c1_beTriggered = true;
        }
        if (c1_beTriggered) {
          if (unrealizedLow <= 0) {
            c1_pnl = 0;
            exitReason_c1 = 'BE(建値)';
          } else if (unrealizedHigh >= tpPct) {
            c1_pnl = tpPct * entry.price * entry.shares;
            exitReason_c1 = 'TP(+1.5%)';
          }
        } else {
          if (unrealizedLow <= -slPct) {
            c1_pnl = -slPct * entry.price * entry.shares;
            exitReason_c1 = 'SL(-0.5%)';
          } else if (unrealizedHigh >= tpPct) {
            c1_pnl = tpPct * entry.price * entry.shares;
            exitReason_c1 = 'TP(+1.5%)';
          }
        }
      }
      
      // --- C_ATR: max(0.5%, 0.8*ATR) BE ---
      if (cATR_pnl === null) {
        if (!cATR_beTriggered && unrealizedHigh >= beTrigger_atr) {
          cATR_beTriggered = true;
        }
        if (cATR_beTriggered) {
          if (unrealizedLow <= 0) {
            cATR_pnl = 0;
            exitReason_cATR = 'BE(建値)';
          } else if (unrealizedHigh >= tpPct) {
            cATR_pnl = tpPct * entry.price * entry.shares;
            exitReason_cATR = 'TP(+1.5%)';
          }
        } else {
          if (unrealizedLow <= -slPct) {
            cATR_pnl = -slPct * entry.price * entry.shares;
            exitReason_cATR = 'SL(-0.5%)';
          } else if (unrealizedHigh >= tpPct) {
            cATR_pnl = tpPct * entry.price * entry.shares;
            exitReason_cATR = 'TP(+1.5%)';
          }
        }
      }
      
      if (baseline_pnl !== null && c1_pnl !== null && cATR_pnl !== null) break;
    }
    
    // Unresolved → forced close
    if (baseline_pnl === null) baseline_pnl = exit.pnl!;
    if (c1_pnl === null) c1_pnl = exit.pnl!;
    if (cATR_pnl === null) cATR_pnl = exit.pnl!;
    
    results.push({
      symbol: entry.symbol,
      symbolName: entry.symbolName,
      date: entry.tradeDate,
      time: entry.tradeTime,
      side: entry.side,
      entryPrice: entry.price,
      shares: entry.shares,
      atr: atr * 100, // as percentage
      beTrigger_fixed: beTrigger_fixed * 100,
      beTrigger_atr: beTrigger_atr * 100,
      baseline_pnl,
      c1_pnl,
      cATR_pnl,
      exitReason_baseline,
      exitReason_c1,
      exitReason_cATR,
    });
  }
  
  console.log(`=== 提案C ATRベースBEトリガー バックテスト（全${results.length}取引、9日間） ===\n`);
  
  // ATR distribution
  const atrs = results.map(r => r.atr);
  atrs.sort((a, b) => a - b);
  console.log('【ATR分布（14期間、%表示）】');
  console.log(`  最小: ${atrs[0].toFixed(3)}% | 25%: ${atrs[Math.floor(atrs.length * 0.25)].toFixed(3)}% | 中央: ${atrs[Math.floor(atrs.length * 0.5)].toFixed(3)}% | 75%: ${atrs[Math.floor(atrs.length * 0.75)].toFixed(3)}% | 最大: ${atrs[atrs.length - 1].toFixed(3)}%`);
  
  // BE trigger distribution for ATR variant
  const triggers = results.map(r => r.beTrigger_atr);
  triggers.sort((a, b) => a - b);
  console.log('【BEトリガー分布 max(0.5%, 0.8*ATR)】');
  console.log(`  最小: ${triggers[0].toFixed(3)}% | 25%: ${triggers[Math.floor(triggers.length * 0.25)].toFixed(3)}% | 中央: ${triggers[Math.floor(triggers.length * 0.5)].toFixed(3)}% | 75%: ${triggers[Math.floor(triggers.length * 0.75)].toFixed(3)}% | 最大: ${triggers[triggers.length - 1].toFixed(3)}%`);
  console.log(`  0.5%固定と同じ: ${results.filter(r => r.beTrigger_atr <= 0.501).length}件`);
  console.log(`  ATRで拡大: ${results.filter(r => r.beTrigger_atr > 0.501).length}件`);
  
  // Summary stats
  const scenarios = [
    { name: 'ベースライン (SL0.5% / TP1.5%)', key: 'baseline_pnl' as const, reasonKey: 'exitReason_baseline' as const },
    { name: 'C1: BE固定(+0.5%) + TP1.5%', key: 'c1_pnl' as const, reasonKey: 'exitReason_c1' as const },
    { name: 'C_ATR: BE=max(0.5%, 0.8ATR) + TP1.5%', key: 'cATR_pnl' as const, reasonKey: 'exitReason_cATR' as const },
  ];
  
  for (const s of scenarios) {
    const pnls = results.map(r => r[s.key]);
    const wins = pnls.filter(p => p > 0);
    const losses = pnls.filter(p => p < 0);
    const zeros = pnls.filter(p => p === 0);
    const total = pnls.reduce((a, b) => a + b, 0);
    const avgWin = wins.length > 0 ? wins.reduce((a, b) => a + b, 0) / wins.length : 0;
    const avgLoss = losses.length > 0 ? losses.reduce((a, b) => a + b, 0) / losses.length : 0;
    const grossWin = wins.reduce((a, b) => a + b, 0);
    const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
    const pf = grossLoss > 0 ? grossWin / grossLoss : Infinity;
    
    const reasons: Record<string, number> = {};
    for (const r of results) {
      const reason = r[s.reasonKey];
      reasons[reason] = (reasons[reason] || 0) + 1;
    }
    
    console.log('\n' + '='.repeat(60));
    console.log(`【${s.name}】`);
    console.log(`  取引数: ${results.length} | ${wins.length}W ${losses.length}L ${zeros.length}D | 勝率: ${(wins.length / results.length * 100).toFixed(1)}%`);
    console.log(`  総損益: ${total >= 0 ? '+' : ''}${Math.round(total).toLocaleString()}円`);
    console.log(`  平均利益: +${Math.round(avgWin).toLocaleString()}円 | 平均損失: ${Math.round(avgLoss).toLocaleString()}円`);
    console.log(`  PF: ${pf === Infinity ? '∞' : pf.toFixed(2)}`);
    console.log(`  決済理由内訳:`);
    for (const [reason, count] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) {
      const reasonPnl = results.filter(r => r[s.reasonKey] === reason).reduce((a, r) => a + r[s.key], 0);
      console.log(`    ${reason}: ${count}件 (${reasonPnl >= 0 ? '+' : ''}${Math.round(reasonPnl).toLocaleString()}円)`);
    }
  }
  
  // C1 vs C_ATR comparison
  console.log('\n' + '='.repeat(60));
  console.log('【C1(固定0.5%) vs C_ATR(max(0.5%, 0.8ATR)) 差分分析】');
  
  let atrBetter = 0, fixedBetter = 0, same = 0;
  let atrImprovement = 0, fixedImprovement = 0;
  
  interface DiffItem { r: SimResult; diff: number; }
  const diffs: DiffItem[] = [];
  
  for (const r of results) {
    const diff = r.cATR_pnl - r.c1_pnl;
    if (Math.abs(diff) < 10) { same++; continue; }
    if (diff > 0) { atrBetter++; atrImprovement += diff; }
    else { fixedBetter++; fixedImprovement += Math.abs(diff); }
    diffs.push({ r, diff });
  }
  
  console.log(`  ATR版が有利: ${atrBetter}件 (合計 +${Math.round(atrImprovement).toLocaleString()}円)`);
  console.log(`  固定版が有利: ${fixedBetter}件 (合計 +${Math.round(fixedImprovement).toLocaleString()}円)`);
  console.log(`  同じ: ${same}件`);
  console.log(`  ネット差分(ATR - 固定): ${Math.round(atrImprovement - fixedImprovement) >= 0 ? '+' : ''}${Math.round(atrImprovement - fixedImprovement).toLocaleString()}円`);
  
  diffs.sort((a, b) => b.diff - a.diff);
  console.log('\n  ATR版が有利な取引（BEトリガーが高くTP到達まで持てた）:');
  for (const { r, diff } of diffs.filter(d => d.diff > 0).slice(0, 10)) {
    console.log(`    ${r.date} ${r.time} ${r.symbol}(${r.symbolName}) ${r.side} ATR=${r.atr.toFixed(2)}% trigger=${r.beTrigger_atr.toFixed(3)}% | C1:${r.exitReason_c1}=${fmt2(r.c1_pnl)} → ATR:${r.exitReason_cATR}=${fmt2(r.cATR_pnl)} (差:+${Math.round(diff).toLocaleString()})`);
  }
  
  console.log('\n  固定版が有利な取引（ATRトリガーが高すぎてBE発動せずSLヒット）:');
  for (const { r, diff } of diffs.filter(d => d.diff < 0).slice(0, 10)) {
    console.log(`    ${r.date} ${r.time} ${r.symbol}(${r.symbolName}) ${r.side} ATR=${r.atr.toFixed(2)}% trigger=${r.beTrigger_atr.toFixed(3)}% | C1:${r.exitReason_c1}=${fmt2(r.c1_pnl)} → ATR:${r.exitReason_cATR}=${fmt2(r.cATR_pnl)} (差:${Math.round(diff).toLocaleString()})`);
  }
  
  // Per-symbol ATR analysis
  console.log('\n' + '='.repeat(60));
  console.log('【銘柄別ATR & BEトリガー】');
  const symbols = [...new Set(results.map(r => r.symbol))];
  console.log('  銘柄        | 平均ATR | BEトリガー | C1損益 | ATR損益 | 差分');
  console.log('  ' + '-'.repeat(70));
  for (const sym of symbols) {
    const symResults = results.filter(r => r.symbol === sym);
    const avgATR = symResults.reduce((s, r) => s + r.atr, 0) / symResults.length;
    const avgTrigger = symResults.reduce((s, r) => s + r.beTrigger_atr, 0) / symResults.length;
    const c1Total = symResults.reduce((s, r) => s + r.c1_pnl, 0);
    const atrTotal = symResults.reduce((s, r) => s + r.cATR_pnl, 0);
    const diff = atrTotal - c1Total;
    console.log(`  ${symResults[0].symbolName.padEnd(12)} | ${avgATR.toFixed(2)}% | ${avgTrigger.toFixed(3)}% | ${fmt2(c1Total)} | ${fmt2(atrTotal)} | ${diff >= 0 ? '+' : ''}${Math.round(diff).toLocaleString()}`);
  }
  
  // Daily breakdown
  console.log('\n' + '='.repeat(60));
  console.log('【日別比較】');
  console.log('  日付        | ベースライン | C1(固定0.5%) | C_ATR(0.8ATR)');
  console.log('  ' + '-'.repeat(60));
  const dates = [...new Set(results.map(r => r.date))].sort();
  for (const date of dates) {
    const dayResults = results.filter(r => r.date === date);
    const bl = dayResults.reduce((s, r) => s + r.baseline_pnl, 0);
    const c1 = dayResults.reduce((s, r) => s + r.c1_pnl, 0);
    const cATR = dayResults.reduce((s, r) => s + r.cATR_pnl, 0);
    console.log(`  ${date} | ${fmt(bl)} | ${fmt(c1)} | ${fmt(cATR)}`);
  }
  
  // Also test other ATR multipliers for comparison
  console.log('\n' + '='.repeat(60));
  console.log('【ATR倍率スイープ: max(0.5%, X * ATR) のXを変化】');
  console.log('  倍率 | 総損益     | PF   | BE発動数 | TP到達数');
  console.log('  ' + '-'.repeat(55));
  
  for (const mult of [0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.2]) {
    let totalPnl = 0;
    let grossWin = 0;
    let grossLoss = 0;
    let beCount = 0;
    let tpCount = 0;
    
    for (const r of results) {
      const trigger = Math.max(0.005, mult * r.atr / 100);
      let pnl: number | null = null;
      let beTriggered = false;
      
      // Re-simulate with this trigger
      // We need candle data - use the stored results approach
      // Since we can't re-query here efficiently, approximate using the relationship:
      // If trigger <= beTrigger_fixed (0.5%), behavior = C1
      // If trigger > beTrigger_fixed, behavior may differ
      // Actually we need to re-simulate properly...
    }
    
    // For proper sweep, we need to re-run the sim. Let's do it inline.
    let sweepTotal = 0;
    let sweepGrossWin = 0;
    let sweepGrossLoss = 0;
    let sweepBE = 0;
    let sweepTP = 0;
    
    for (const entry of entries) {
      const exit = allTrades.find(t => 
        t.symbol === entry.symbol && 
        t.tradeDate === entry.tradeDate &&
        t.tradeTime > entry.tradeTime && 
        t.pnl !== null
      );
      if (!exit) continue;
      
      // Get ATR
      const atrCandles = await db.execute(
        sql`SELECT high, low, close
            FROM rt_candles 
            WHERE symbol = ${entry.symbol} AND tradeDate = ${entry.tradeDate}
            AND candleTime <= ${entry.tradeTime}
            ORDER BY candleTime DESC LIMIT 14`
      ) as any;
      const atrRows = atrCandles[0] ?? atrCandles;
      let atrVal = 0;
      if (atrRows.length > 0) {
        const ranges = atrRows.map((c: any) => (Number(c.high) - Number(c.low)) / Number(c.close));
        atrVal = ranges.reduce((a: number, b: number) => a + b, 0) / ranges.length;
      }
      
      const trigger = Math.max(0.005, mult * atrVal);
      
      const holdingCandles = await db.execute(
        sql`SELECT high, low
            FROM rt_candles 
            WHERE symbol = ${entry.symbol} AND tradeDate = ${entry.tradeDate}
            AND candleTime > ${entry.tradeTime}
            ORDER BY candleTime`
      ) as any;
      const holding2 = holdingCandles[0] ?? holdingCandles;
      
      let pnl: number | null = null;
      let beTriggered = false;
      
      for (const c of holding2) {
        const high = Number(c.high);
        const low = Number(c.low);
        let unrealizedHigh: number, unrealizedLow: number;
        if (entry.side === 'short') {
          unrealizedHigh = (entry.price - low) / entry.price;
          unrealizedLow = (entry.price - high) / entry.price;
        } else {
          unrealizedHigh = (high - entry.price) / entry.price;
          unrealizedLow = (low - entry.price) / entry.price;
        }
        
        if (!beTriggered && unrealizedHigh >= trigger) beTriggered = true;
        
        if (beTriggered) {
          if (unrealizedLow <= 0) { pnl = 0; sweepBE++; break; }
          if (unrealizedHigh >= 0.015) { pnl = 0.015 * entry.price * entry.shares; sweepTP++; break; }
        } else {
          if (unrealizedLow <= -0.005) { pnl = -0.005 * entry.price * entry.shares; break; }
          if (unrealizedHigh >= 0.015) { pnl = 0.015 * entry.price * entry.shares; sweepTP++; break; }
        }
      }
      
      if (pnl === null) pnl = exit.pnl!;
      sweepTotal += pnl;
      if (pnl > 0) sweepGrossWin += pnl;
      if (pnl < 0) sweepGrossLoss += Math.abs(pnl);
    }
    
    const pf = sweepGrossLoss > 0 ? sweepGrossWin / sweepGrossLoss : Infinity;
    console.log(`  ${mult.toFixed(1)}x  | ${fmt(sweepTotal)} | ${pf.toFixed(2)} | ${sweepBE}件 | ${sweepTP}件`);
  }
  
  process.exit(0);
}

function fmt(n: number): string {
  return `${n >= 0 ? '+' : ''}${Math.round(n).toLocaleString()}`.padStart(12);
}

function fmt2(n: number): string {
  return `${n >= 0 ? '+' : ''}${Math.round(n).toLocaleString()}`;
}

main().catch(e => { console.error(e); process.exit(1); });
