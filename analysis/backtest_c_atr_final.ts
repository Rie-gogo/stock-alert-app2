/**
 * Backtest Proposal C with ATR-adaptive BE trigger (FINAL VERSION)
 * 
 * Data issue: Only 6/25-6/29 have real OHLC bars. 6/17-6/24 have H=L=C (snapshot data).
 * 
 * Solution: Use "pseudo-ATR" = average |close[t] - close[t-1]| / close[t-1] for last 60 bars.
 * This works for ALL dates since close values are always available.
 * 
 * For dates with real OHLC (6/25-6/29), also compare with true ATR for validation.
 * 
 * Scenarios:
 * - Fixed 0.5% BE trigger (reference C1)
 * - max(0.5%, 0.8 * pseudoATR) - user's original proposal
 * - Various multipliers of pseudoATR
 */

import { getDb } from '../server/db';
import { sql } from 'drizzle-orm';

interface Trade {
  id: number;
  symbol: string;
  symbolName: string;
  tradeDate: string;
  tradeTime: string;
  price: number;
  shares: number;
  pnl: number | null;
  side: string;
}

interface EntryData {
  entry: Trade;
  exit: Trade;
  pseudoATR: number; // avg |close[t]-close[t-1]|/close as decimal
  realATR: number;   // avg (high-low)/close as decimal (0 for non-OHLC dates)
  holding: { high: number; low: number; close: number }[];
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
  const entryDataList: EntryData[] = [];
  
  for (const entry of entries) {
    const exit = allTrades.find(t => 
      t.symbol === entry.symbol && 
      t.tradeDate === entry.tradeDate &&
      t.tradeTime > entry.tradeTime && 
      t.pnl !== null
    );
    if (!exit) continue;
    
    // Fetch candles before entry (for ATR calculation)
    const beforeResult = await db.execute(
      sql`SELECT high, low, close
          FROM rt_candles 
          WHERE symbol = ${entry.symbol} AND tradeDate = ${entry.tradeDate}
          AND candleTime <= ${entry.tradeTime} AND candleTime >= '09:00'
          ORDER BY candleTime ASC`
    ) as any;
    const beforeRows = (beforeResult[0] ?? beforeResult).map((c: any) => ({
      high: Number(c.high), low: Number(c.low), close: Number(c.close)
    }));
    
    // Compute pseudo-ATR: average |close[t] - close[t-1]| / close[t-1]
    let pseudoATR = 0;
    if (beforeRows.length > 1) {
      const lastN = beforeRows.slice(-61); // last 60 pairs = 61 candles
      const changes: number[] = [];
      for (let i = 1; i < lastN.length; i++) {
        if (lastN[i-1].close > 0) {
          changes.push(Math.abs(lastN[i].close - lastN[i-1].close) / lastN[i-1].close);
        }
      }
      if (changes.length > 0) {
        pseudoATR = changes.reduce((a, b) => a + b, 0) / changes.length;
      }
    }
    
    // Compute real ATR (only meaningful for 6/25-6/29)
    let realATR = 0;
    if (beforeRows.length > 0) {
      const lastN = beforeRows.slice(-60);
      const ranges = lastN.filter(c => c.high !== c.low).map(c => (c.high - c.low) / c.close);
      if (ranges.length > 0) {
        realATR = ranges.reduce((a, b) => a + b, 0) / ranges.length;
      }
    }
    
    // Fetch holding candles
    const holdingResult = await db.execute(
      sql`SELECT high, low, close
          FROM rt_candles 
          WHERE symbol = ${entry.symbol} AND tradeDate = ${entry.tradeDate}
          AND candleTime > ${entry.tradeTime}
          ORDER BY candleTime`
    ) as any;
    const holding = (holdingResult[0] ?? holdingResult).map((c: any) => ({
      high: Number(c.high), low: Number(c.low), close: Number(c.close)
    }));
    
    entryDataList.push({ entry, exit, pseudoATR, realATR, holding });
  }
  
  console.log(`=== 提案C ATR適応型BEトリガー 最終バックテスト（全${entryDataList.length}取引、9日間） ===\n`);
  
  // Pseudo-ATR distribution
  const pATRs = entryDataList.map(d => d.pseudoATR * 100);
  pATRs.sort((a, b) => a - b);
  console.log('【Pseudo-ATR分布（|Δclose|/close 60期間平均、%）】');
  console.log(`  最小: ${pATRs[0].toFixed(3)}% | 25%: ${pATRs[Math.floor(pATRs.length * 0.25)].toFixed(3)}% | 中央: ${pATRs[Math.floor(pATRs.length * 0.5)].toFixed(3)}% | 75%: ${pATRs[Math.floor(pATRs.length * 0.75)].toFixed(3)}% | 最大: ${pATRs[pATRs.length - 1].toFixed(3)}%`);
  
  // Show what 0.8*pseudoATR looks like
  const triggers08 = entryDataList.map(d => Math.max(0.5, 0.8 * d.pseudoATR * 100));
  triggers08.sort((a, b) => a - b);
  console.log(`\n【BEトリガー max(0.5%, 0.8*pATR)】`);
  console.log(`  最小: ${triggers08[0].toFixed(3)}% | 25%: ${triggers08[Math.floor(triggers08.length * 0.25)].toFixed(3)}% | 中央: ${triggers08[Math.floor(triggers08.length * 0.5)].toFixed(3)}% | 75%: ${triggers08[Math.floor(triggers08.length * 0.75)].toFixed(3)}% | 最大: ${triggers08[triggers08.length - 1].toFixed(3)}%`);
  console.log(`  0.5%より大きい: ${triggers08.filter(t => t > 0.501).length}件 / ${triggers08.length}件`);
  
  // Simulate function
  function simulate(d: EntryData, beTrigger: number): { pnl: number; exitReason: string } {
    const slPct = 0.005;
    const tpPct = 0.015;
    let beTriggered = false;
    
    for (const c of d.holding) {
      let unrealizedHigh: number, unrealizedLow: number;
      if (d.entry.side === 'short') {
        unrealizedHigh = (d.entry.price - c.low) / d.entry.price;
        unrealizedLow = (d.entry.price - c.high) / d.entry.price;
      } else {
        unrealizedHigh = (c.high - d.entry.price) / d.entry.price;
        unrealizedLow = (c.low - d.entry.price) / d.entry.price;
      }
      
      if (!beTriggered && unrealizedHigh >= beTrigger) beTriggered = true;
      
      if (beTriggered) {
        if (unrealizedLow <= 0) return { pnl: 0, exitReason: 'BE(建値)' };
        if (unrealizedHigh >= tpPct) return { pnl: tpPct * d.entry.price * d.entry.shares, exitReason: 'TP(+1.5%)' };
      } else {
        if (unrealizedLow <= -slPct) return { pnl: -slPct * d.entry.price * d.entry.shares, exitReason: 'SL(-0.5%)' };
        if (unrealizedHigh >= tpPct) return { pnl: tpPct * d.entry.price * d.entry.shares, exitReason: 'TP(+1.5%)' };
      }
    }
    
    return { pnl: d.exit.pnl!, exitReason: '大引け' };
  }
  
  // Sweep configurations
  const configs = [
    { label: '固定0.5%', getTriger: (d: EntryData) => 0.005 },
    { label: '0.8x pATR', getTriger: (d: EntryData) => Math.max(0.005, 0.8 * d.pseudoATR) },
    { label: '1.0x pATR', getTriger: (d: EntryData) => Math.max(0.005, 1.0 * d.pseudoATR) },
    { label: '1.5x pATR', getTriger: (d: EntryData) => Math.max(0.005, 1.5 * d.pseudoATR) },
    { label: '2.0x pATR', getTriger: (d: EntryData) => Math.max(0.005, 2.0 * d.pseudoATR) },
    { label: '2.5x pATR', getTriger: (d: EntryData) => Math.max(0.005, 2.5 * d.pseudoATR) },
    { label: '3.0x pATR', getTriger: (d: EntryData) => Math.max(0.005, 3.0 * d.pseudoATR) },
    { label: '固定0.7%', getTriger: (d: EntryData) => 0.007 },
    { label: '固定0.8%', getTriger: (d: EntryData) => 0.008 },
  ];
  
  interface ScenarioResult {
    label: string;
    pnls: number[];
    reasons: string[];
    triggers: number[];
  }
  const scenarioResults: ScenarioResult[] = [];
  
  console.log('\n【BEトリガー スイープ結果】');
  console.log('  設定       | BEトリガー(min-med-max) | 総損益      | PF   | 勝率  | W  | L  | D  | TP | BE | SL | 大引');
  console.log('  ' + '-'.repeat(110));
  
  for (const cfg of configs) {
    const pnls: number[] = [];
    const reasons: string[] = [];
    const triggers: number[] = [];
    
    for (const d of entryDataList) {
      const trigger = cfg.getTriger(d);
      triggers.push(trigger * 100);
      const result = simulate(d, trigger);
      pnls.push(result.pnl);
      reasons.push(result.exitReason);
    }
    
    scenarioResults.push({ label: cfg.label, pnls, reasons, triggers });
    
    const wins = pnls.filter(p => p > 0);
    const losses = pnls.filter(p => p < 0);
    const zeros = pnls.filter(p => p === 0);
    const total = pnls.reduce((a, b) => a + b, 0);
    const grossWin = wins.reduce((a, b) => a + b, 0);
    const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
    const pf = grossLoss > 0 ? grossWin / grossLoss : Infinity;
    const tpCount = reasons.filter(r => r.includes('TP')).length;
    const beCount = reasons.filter(r => r.includes('BE')).length;
    const slCount = reasons.filter(r => r.includes('SL')).length;
    const closeCount = reasons.filter(r => r.includes('大引')).length;
    
    const sortedTriggers = [...triggers].sort((a, b) => a - b);
    const trigMin = sortedTriggers[0].toFixed(2);
    const trigMed = sortedTriggers[Math.floor(sortedTriggers.length / 2)].toFixed(2);
    const trigMax = sortedTriggers[sortedTriggers.length - 1].toFixed(2);
    
    console.log(`  ${cfg.label.padEnd(10)} | ${trigMin}%-${trigMed}%-${trigMax}% | ${fmt(total)} | ${pf.toFixed(2)} | ${(wins.length / pnls.length * 100).toFixed(1)}% | ${wins.length.toString().padStart(2)} | ${losses.length.toString().padStart(2)} | ${zeros.length.toString().padStart(2)} | ${tpCount.toString().padStart(2)} | ${beCount.toString().padStart(2)} | ${slCount.toString().padStart(2)} | ${closeCount.toString().padStart(2)}`);
  }
  
  // Detailed comparison: fixed 0.5% vs 0.8x pATR (user's original proposal)
  const c1 = scenarioResults[0];
  const cATR = scenarioResults[1]; // 0.8x pATR
  
  console.log('\n' + '='.repeat(60));
  console.log('【詳細比較: 固定0.5% vs 0.8x pseudoATR (ユーザー提案)】');
  
  let atrBetter = 0, fixedBetter = 0, same = 0;
  let atrImprovement = 0, fixedImprovement = 0;
  const diffs: { idx: number; diff: number }[] = [];
  
  for (let i = 0; i < entryDataList.length; i++) {
    const diff = cATR.pnls[i] - c1.pnls[i];
    if (Math.abs(diff) < 10) { same++; continue; }
    if (diff > 0) { atrBetter++; atrImprovement += diff; }
    else { fixedBetter++; fixedImprovement += Math.abs(diff); }
    diffs.push({ idx: i, diff });
  }
  
  console.log(`  0.8x pATR版が有利: ${atrBetter}件 (合計 +${Math.round(atrImprovement).toLocaleString()}円)`);
  console.log(`  固定0.5%が有利: ${fixedBetter}件 (合計 +${Math.round(fixedImprovement).toLocaleString()}円)`);
  console.log(`  同じ: ${same}件`);
  console.log(`  ネット差分: ${Math.round(atrImprovement - fixedImprovement) >= 0 ? '+' : ''}${Math.round(atrImprovement - fixedImprovement).toLocaleString()}円`);
  
  diffs.sort((a, b) => b.diff - a.diff);
  if (diffs.filter(d => d.diff > 0).length > 0) {
    console.log('\n  ATR版が有利な取引:');
    for (const { idx, diff } of diffs.filter(d => d.diff > 0).slice(0, 10)) {
      const d = entryDataList[idx];
      console.log(`    ${d.entry.tradeDate} ${d.entry.tradeTime} ${d.entry.symbol}(${d.entry.symbolName}) ${d.entry.side} pATR=${(d.pseudoATR*100).toFixed(2)}% trigger=${cATR.triggers[idx].toFixed(2)}% | 固定:${c1.reasons[idx]}=${fmt2(c1.pnls[idx])} → ATR:${cATR.reasons[idx]}=${fmt2(cATR.pnls[idx])} (差:+${Math.round(diff).toLocaleString()})`);
    }
  }
  if (diffs.filter(d => d.diff < 0).length > 0) {
    console.log('\n  固定0.5%が有利な取引:');
    for (const { idx, diff } of diffs.filter(d => d.diff < 0).slice(0, 10)) {
      const d = entryDataList[idx];
      console.log(`    ${d.entry.tradeDate} ${d.entry.tradeTime} ${d.entry.symbol}(${d.entry.symbolName}) ${d.entry.side} pATR=${(d.pseudoATR*100).toFixed(2)}% trigger=${cATR.triggers[idx].toFixed(2)}% | 固定:${c1.reasons[idx]}=${fmt2(c1.pnls[idx])} → ATR:${cATR.reasons[idx]}=${fmt2(cATR.pnls[idx])} (差:${Math.round(diff).toLocaleString()})`);
    }
  }
  
  // Also compare with best multiplier
  const bestIdx = scenarioResults.reduce((bestI, s, i) => 
    s.pnls.reduce((a, b) => a + b, 0) > scenarioResults[bestI].pnls.reduce((a, b) => a + b, 0) ? i : bestI, 0);
  const best = scenarioResults[bestIdx];
  console.log(`\n【最良設定: ${best.label} (総損益: ${fmt(best.pnls.reduce((a, b) => a + b, 0))})】`);
  
  // Per-symbol pseudo-ATR
  console.log('\n' + '='.repeat(60));
  console.log('【銘柄別 pseudo-ATR & 結果比較】');
  const symbols = [...new Set(entryDataList.map(d => d.entry.symbol))];
  console.log('  銘柄            | 取引 | pATR   | 0.8xトリガー | 固定0.5%  | 0.8x pATR | 差分');
  console.log('  ' + '-'.repeat(85));
  for (const sym of symbols) {
    const indices = entryDataList.map((d, i) => d.entry.symbol === sym ? i : -1).filter(i => i >= 0);
    const avgPATR = indices.reduce((s, i) => s + entryDataList[i].pseudoATR, 0) / indices.length * 100;
    const avgTrigger = indices.reduce((s, i) => s + cATR.triggers[i], 0) / indices.length;
    const c1Total = indices.reduce((s, i) => s + c1.pnls[i], 0);
    const cATRTotal = indices.reduce((s, i) => s + cATR.pnls[i], 0);
    const diff = cATRTotal - c1Total;
    const name = entryDataList[indices[0]].entry.symbolName;
    console.log(`  ${name.padEnd(14)} | ${indices.length.toString().padStart(4)} | ${avgPATR.toFixed(2)}% | ${avgTrigger.toFixed(2)}%        | ${fmt(c1Total)} | ${fmt(cATRTotal)} | ${diff >= 0 ? '+' : ''}${Math.round(diff).toLocaleString()}`);
  }
  
  // Daily breakdown
  console.log('\n' + '='.repeat(60));
  console.log('【日別比較】');
  console.log('  日付        | 固定0.5%  | 0.8x pATR | 1.5x pATR | 2.0x pATR');
  console.log('  ' + '-'.repeat(65));
  const c15x = scenarioResults.find(s => s.label === '1.5x pATR')!;
  const c2x = scenarioResults.find(s => s.label === '2.0x pATR')!;
  const dates = [...new Set(entryDataList.map(d => d.entry.tradeDate))].sort();
  for (const date of dates) {
    const indices = entryDataList.map((d, i) => d.entry.tradeDate === date ? i : -1).filter(i => i >= 0);
    const c1Day = indices.reduce((s, i) => s + c1.pnls[i], 0);
    const cATRDay = indices.reduce((s, i) => s + cATR.pnls[i], 0);
    const c15xDay = indices.reduce((s, i) => s + c15x.pnls[i], 0);
    const c2xDay = indices.reduce((s, i) => s + c2x.pnls[i], 0);
    console.log(`  ${date} | ${fmt(c1Day)} | ${fmt(cATRDay)} | ${fmt(c15xDay)} | ${fmt(c2xDay)}`);
  }
  
  process.exit(0);
}

function fmt(n: number): string {
  return `${n >= 0 ? '+' : ''}${Math.round(n).toLocaleString()}`.padStart(11);
}
function fmt2(n: number): string {
  return `${n >= 0 ? '+' : ''}${Math.round(n).toLocaleString()}`;
}

main().catch(e => { console.error(e); process.exit(1); });
