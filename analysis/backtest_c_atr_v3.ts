/**
 * Backtest Proposal C with ATR-adaptive BE trigger (FIXED ATR calculation)
 * 
 * Previous versions had a bug: subquery with LIMIT in TiDB returned incorrect results.
 * Fix: compute ATR in application code after fetching candles.
 * 
 * ATR = average of (high-low)/close for the last 60 1-min candles before entry.
 * BE trigger = max(0.5%, multiplier * ATR)
 * 
 * The idea: volatile stocks should have a wider BE trigger to avoid premature exits.
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
  atr60: number; // as decimal (e.g., 0.003 = 0.3%)
  holding: { high: number; low: number }[];
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
    
    // Fetch last 60 candles BEFORE entry (application-side LIMIT)
    const beforeResult = await db.execute(
      sql`SELECT high, low, close
          FROM rt_candles 
          WHERE symbol = ${entry.symbol} AND tradeDate = ${entry.tradeDate}
          AND candleTime <= ${entry.tradeTime} AND candleTime >= '09:00'
          ORDER BY candleTime DESC`
    ) as any;
    const beforeRows = (beforeResult[0] ?? beforeResult).slice(0, 60);
    
    // Calculate ATR in application code
    let atr60 = 0;
    if (beforeRows.length > 0) {
      const ranges = beforeRows.map((c: any) => (Number(c.high) - Number(c.low)) / Number(c.close));
      atr60 = ranges.reduce((a: number, b: number) => a + b, 0) / ranges.length;
    }
    
    // Fetch holding candles
    const holdingResult = await db.execute(
      sql`SELECT high, low
          FROM rt_candles 
          WHERE symbol = ${entry.symbol} AND tradeDate = ${entry.tradeDate}
          AND candleTime > ${entry.tradeTime}
          ORDER BY candleTime`
    ) as any;
    const holding = (holdingResult[0] ?? holdingResult).map((c: any) => ({
      high: Number(c.high),
      low: Number(c.low),
    }));
    
    entryDataList.push({ entry, exit, atr60, holding });
  }
  
  console.log(`=== 提案C ATR適応型BEトリガー バックテスト（全${entryDataList.length}取引、9日間） ===\n`);
  
  // ATR distribution
  const atrPcts = entryDataList.map(d => d.atr60 * 100);
  atrPcts.sort((a, b) => a - b);
  console.log('【60-bar ATR分布（%）- 修正版】');
  console.log(`  最小: ${atrPcts[0].toFixed(3)}% | 25%: ${atrPcts[Math.floor(atrPcts.length * 0.25)].toFixed(3)}% | 中央: ${atrPcts[Math.floor(atrPcts.length * 0.5)].toFixed(3)}% | 75%: ${atrPcts[Math.floor(atrPcts.length * 0.75)].toFixed(3)}% | 最大: ${atrPcts[atrPcts.length - 1].toFixed(3)}%`);
  
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
  
  // Sweep multipliers: 0 = fixed 0.5%, then various ATR multipliers
  const configs = [
    { label: '固定0.5%', mult: 0 },
    { label: '0.8x ATR', mult: 0.8 },
    { label: '1.0x ATR', mult: 1.0 },
    { label: '1.5x ATR', mult: 1.5 },
    { label: '2.0x ATR', mult: 2.0 },
    { label: '2.5x ATR', mult: 2.5 },
    { label: '3.0x ATR', mult: 3.0 },
  ];
  
  interface ScenarioResult {
    label: string;
    mult: number;
    pnls: number[];
    reasons: string[];
    triggers: number[];
  }
  const scenarioResults: ScenarioResult[] = [];
  
  console.log('\n【ATR倍率スイープ: BEトリガー = max(0.5%, X * ATR60)】');
  console.log('  設定       | BEトリガー範囲       | 総損益      | PF   | 勝率  | W  | L  | D  | TP | BE | SL');
  console.log('  ' + '-'.repeat(100));
  
  for (const cfg of configs) {
    const pnls: number[] = [];
    const reasons: string[] = [];
    const triggers: number[] = [];
    
    for (const d of entryDataList) {
      const trigger = cfg.mult === 0 ? 0.005 : Math.max(0.005, cfg.mult * d.atr60);
      triggers.push(trigger * 100);
      const result = simulate(d, trigger);
      pnls.push(result.pnl);
      reasons.push(result.exitReason);
    }
    
    scenarioResults.push({ label: cfg.label, mult: cfg.mult, pnls, reasons, triggers });
    
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
    
    const trigMin = Math.min(...triggers).toFixed(2);
    const trigMax = Math.max(...triggers).toFixed(2);
    const trigMed = triggers.sort((a, b) => a - b)[Math.floor(triggers.length / 2)].toFixed(2);
    
    console.log(`  ${cfg.label.padEnd(10)} | ${trigMin}%-${trigMed}%-${trigMax}% | ${fmt(total)} | ${pf.toFixed(2)} | ${(wins.length / pnls.length * 100).toFixed(1)}% | ${wins.length.toString().padStart(2)} | ${losses.length.toString().padStart(2)} | ${zeros.length.toString().padStart(2)} | ${tpCount.toString().padStart(2)} | ${beCount.toString().padStart(2)} | ${slCount.toString().padStart(2)}`);
  }
  
  // Detailed comparison: fixed vs best ATR variant
  const c1 = scenarioResults[0]; // fixed 0.5%
  
  // Find best ATR variant
  const bestATR = scenarioResults.slice(1).reduce((best, s) => 
    s.pnls.reduce((a, b) => a + b, 0) > best.pnls.reduce((a, b) => a + b, 0) ? s : best
  );
  
  console.log(`\n【最良ATR設定: ${bestATR.label}】`);
  console.log(`  固定0.5%との差分: ${fmt(bestATR.pnls.reduce((a, b) => a + b, 0) - c1.pnls.reduce((a, b) => a + b, 0))}`);
  
  // Show differences between fixed and best ATR
  console.log('\n' + '='.repeat(60));
  console.log(`【詳細比較: 固定0.5% vs ${bestATR.label}】`);
  
  let atrBetter = 0, fixedBetter = 0, same = 0;
  let atrImprovement = 0, fixedImprovement = 0;
  
  interface DiffItem { idx: number; diff: number; }
  const diffs: DiffItem[] = [];
  
  for (let i = 0; i < entryDataList.length; i++) {
    const diff = bestATR.pnls[i] - c1.pnls[i];
    if (Math.abs(diff) < 10) { same++; continue; }
    if (diff > 0) { atrBetter++; atrImprovement += diff; }
    else { fixedBetter++; fixedImprovement += Math.abs(diff); }
    diffs.push({ idx: i, diff });
  }
  
  console.log(`  ATR版が有利: ${atrBetter}件 (合計 +${Math.round(atrImprovement).toLocaleString()}円)`);
  console.log(`  固定版が有利: ${fixedBetter}件 (合計 +${Math.round(fixedImprovement).toLocaleString()}円)`);
  console.log(`  同じ: ${same}件`);
  console.log(`  ネット差分: ${Math.round(atrImprovement - fixedImprovement) >= 0 ? '+' : ''}${Math.round(atrImprovement - fixedImprovement).toLocaleString()}円`);
  
  diffs.sort((a, b) => b.diff - a.diff);
  
  if (diffs.filter(d => d.diff > 0).length > 0) {
    console.log(`\n  ${bestATR.label}が有利な取引（BEトリガーが高くTP到達まで持てた）:`);
    for (const { idx, diff } of diffs.filter(d => d.diff > 0).slice(0, 10)) {
      const d = entryDataList[idx];
      console.log(`    ${d.entry.tradeDate} ${d.entry.tradeTime} ${d.entry.symbol}(${d.entry.symbolName}) ${d.entry.side} ATR=${(d.atr60*100).toFixed(2)}% trigger=${bestATR.triggers[idx].toFixed(2)}% | 固定:${c1.reasons[idx]}=${fmt2(c1.pnls[idx])} → ATR:${bestATR.reasons[idx]}=${fmt2(bestATR.pnls[idx])} (差:+${Math.round(diff).toLocaleString()})`);
    }
  }
  
  if (diffs.filter(d => d.diff < 0).length > 0) {
    console.log(`\n  固定0.5%が有利な取引（ATRトリガーが高すぎてBE発動せずSLヒット）:`);
    for (const { idx, diff } of diffs.filter(d => d.diff < 0).slice(0, 10)) {
      const d = entryDataList[idx];
      console.log(`    ${d.entry.tradeDate} ${d.entry.tradeTime} ${d.entry.symbol}(${d.entry.symbolName}) ${d.entry.side} ATR=${(d.atr60*100).toFixed(2)}% trigger=${bestATR.triggers[idx].toFixed(2)}% | 固定:${c1.reasons[idx]}=${fmt2(c1.pnls[idx])} → ATR:${bestATR.reasons[idx]}=${fmt2(bestATR.pnls[idx])} (差:${Math.round(diff).toLocaleString()})`);
    }
  }
  
  // Per-symbol breakdown
  console.log('\n' + '='.repeat(60));
  console.log('【銘柄別: 固定0.5% vs 2.0x ATR vs 2.5x ATR】');
  const c2x = scenarioResults.find(s => s.mult === 2.0)!;
  const c25x = scenarioResults.find(s => s.mult === 2.5)!;
  
  const symbols = [...new Set(entryDataList.map(d => d.entry.symbol))];
  console.log('  銘柄            | 取引数 | ATR60  | trigger(2x) | 固定0.5%  | 2.0x ATR  | 2.5x ATR  | 最良');
  console.log('  ' + '-'.repeat(100));
  for (const sym of symbols) {
    const indices = entryDataList.map((d, i) => d.entry.symbol === sym ? i : -1).filter(i => i >= 0);
    const avgATR = indices.reduce((s, i) => s + entryDataList[i].atr60, 0) / indices.length * 100;
    const avgTrigger2x = indices.reduce((s, i) => s + c2x.triggers[i], 0) / indices.length;
    const c1Total = indices.reduce((s, i) => s + c1.pnls[i], 0);
    const c2xTotal = indices.reduce((s, i) => s + c2x.pnls[i], 0);
    const c25xTotal = indices.reduce((s, i) => s + c25x.pnls[i], 0);
    const best = c2xTotal > c1Total && c2xTotal >= c25xTotal ? '2.0x' : c25xTotal > c1Total && c25xTotal > c2xTotal ? '2.5x' : '固定';
    const name = entryDataList[indices[0]].entry.symbolName;
    console.log(`  ${name.padEnd(14)} | ${indices.length.toString().padStart(4)} | ${avgATR.toFixed(2)}% | ${avgTrigger2x.toFixed(2)}%       | ${fmt(c1Total)} | ${fmt(c2xTotal)} | ${fmt(c25xTotal)} | ${best}`);
  }
  
  // Daily breakdown
  console.log('\n' + '='.repeat(60));
  console.log('【日別比較】');
  console.log('  日付        | 固定0.5%  | 1.5x ATR  | 2.0x ATR  | 2.5x ATR');
  console.log('  ' + '-'.repeat(65));
  const c15x = scenarioResults.find(s => s.mult === 1.5)!;
  const dates = [...new Set(entryDataList.map(d => d.entry.tradeDate))].sort();
  for (const date of dates) {
    const indices = entryDataList.map((d, i) => d.entry.tradeDate === date ? i : -1).filter(i => i >= 0);
    const c1Day = indices.reduce((s, i) => s + c1.pnls[i], 0);
    const c15xDay = indices.reduce((s, i) => s + c15x.pnls[i], 0);
    const c2xDay = indices.reduce((s, i) => s + c2x.pnls[i], 0);
    const c25xDay = indices.reduce((s, i) => s + c25x.pnls[i], 0);
    console.log(`  ${date} | ${fmt(c1Day)} | ${fmt(c15xDay)} | ${fmt(c2xDay)} | ${fmt(c25xDay)}`);
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
