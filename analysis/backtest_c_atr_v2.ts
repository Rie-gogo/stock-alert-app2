/**
 * Backtest Proposal C with ATR-adaptive BE trigger:
 * 
 * Problem: 1-minute bar ATR is only 0.1-0.4%, so 0.8*ATR (0.08-0.32%) is always < 0.5%.
 * The formula max(0.5%, 0.8*ATR) therefore always equals 0.5%.
 * 
 * To make this meaningful, we interpret "ATR" as the 60-bar average range (%), 
 * and sweep multipliers from 1.0x to 3.0x so that volatile stocks get a higher BE trigger.
 * 
 * The intent: volatile stocks (太陽誘電 ATR=0.39%) should have a wider BE trigger
 * than low-vol stocks (三菱重工 ATR=0.14%) to avoid premature BE exits.
 * 
 * Scenarios tested:
 * - C1: fixed 0.5% BE trigger (reference)
 * - C_ATR_2x: max(0.5%, 2.0 * ATR60) → volatile stocks get ~0.6-0.8% trigger
 * - C_ATR_2.5x: max(0.5%, 2.5 * ATR60) → volatile stocks get ~0.7-1.0% trigger
 * - C_ATR_3x: max(0.5%, 3.0 * ATR60) → volatile stocks get ~0.8-1.2% trigger
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

async function simulateWithTrigger(
  db: any,
  entry: Trade,
  exit: Trade,
  beTrigger: number, // as decimal (e.g., 0.005 = 0.5%)
  holding: any[]
): Promise<{ pnl: number; exitReason: string }> {
  const slPct = 0.005;
  const tpPct = 0.015;
  let beTriggered = false;
  
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
    
    if (!beTriggered && unrealizedHigh >= beTrigger) beTriggered = true;
    
    if (beTriggered) {
      if (unrealizedLow <= 0) return { pnl: 0, exitReason: 'BE(建値)' };
      if (unrealizedHigh >= tpPct) return { pnl: tpPct * entry.price * entry.shares, exitReason: 'TP(+1.5%)' };
    } else {
      if (unrealizedLow <= -slPct) return { pnl: -slPct * entry.price * entry.shares, exitReason: 'SL(-0.5%)' };
      if (unrealizedHigh >= tpPct) return { pnl: tpPct * entry.price * entry.shares, exitReason: 'TP(+1.5%)' };
    }
  }
  
  return { pnl: exit.pnl!, exitReason: '大引け' };
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
  
  // Pre-compute ATR60 for each entry
  interface EntryData {
    entry: Trade;
    exit: Trade;
    atr60: number; // as decimal
    holding: any[];
  }
  
  const entryDataList: EntryData[] = [];
  
  for (const entry of entries) {
    const exit = allTrades.find(t => 
      t.symbol === entry.symbol && 
      t.tradeDate === entry.tradeDate &&
      t.tradeTime > entry.tradeTime && 
      t.pnl !== null
    );
    if (!exit) continue;
    
    // ATR60: average of (high-low)/close for last 60 candles
    const atrResult = await db.execute(
      sql`SELECT AVG((high-low)/close) as atr FROM (
        SELECT high, low, close FROM rt_candles 
        WHERE symbol = ${entry.symbol} AND tradeDate = ${entry.tradeDate}
        AND candleTime <= ${entry.tradeTime} AND candleTime >= '09:00'
        ORDER BY candleTime DESC LIMIT 60
      ) t`
    ) as any;
    const atr60 = Number((atrResult[0] ?? atrResult)[0]?.atr ?? 0);
    
    // Get holding candles
    const holdingResult = await db.execute(
      sql`SELECT candleTime, high, low, close
          FROM rt_candles 
          WHERE symbol = ${entry.symbol} AND tradeDate = ${entry.tradeDate}
          AND candleTime > ${entry.tradeTime}
          ORDER BY candleTime`
    ) as any;
    const holding = holdingResult[0] ?? holdingResult;
    
    entryDataList.push({ entry, exit, atr60, holding });
  }
  
  console.log(`=== 提案C ATR適応型BEトリガー バックテスト（全${entryDataList.length}取引、9日間） ===\n`);
  
  // Show ATR distribution
  const atrPcts = entryDataList.map(d => d.atr60 * 100);
  atrPcts.sort((a, b) => a - b);
  console.log('【60-bar ATR分布（%）】');
  console.log(`  最小: ${atrPcts[0].toFixed(3)}% | 25%: ${atrPcts[Math.floor(atrPcts.length * 0.25)].toFixed(3)}% | 中央: ${atrPcts[Math.floor(atrPcts.length * 0.5)].toFixed(3)}% | 75%: ${atrPcts[Math.floor(atrPcts.length * 0.75)].toFixed(3)}% | 最大: ${atrPcts[atrPcts.length - 1].toFixed(3)}%`);
  
  // Sweep multipliers
  const multipliers = [0, 1.5, 2.0, 2.5, 3.0];
  // 0 = fixed 0.5% (C1 reference)
  
  console.log('\n【ATR倍率スイープ: BEトリガー = max(0.5%, X * ATR60)】');
  console.log('  倍率  | BEトリガー範囲    | 総損益      | PF   | 勝率  | W  | L  | D  | TP到達 | BE決済 | SL決済');
  console.log('  ' + '-'.repeat(100));
  
  interface ScenarioResult {
    mult: number;
    pnls: number[];
    reasons: string[];
    triggers: number[];
  }
  const scenarioResults: ScenarioResult[] = [];
  
  for (const mult of multipliers) {
    const pnls: number[] = [];
    const reasons: string[] = [];
    const triggers: number[] = [];
    
    for (const d of entryDataList) {
      const trigger = mult === 0 ? 0.005 : Math.max(0.005, mult * d.atr60);
      triggers.push(trigger * 100);
      const result = await simulateWithTrigger(db, d.entry, d.exit, trigger, d.holding);
      pnls.push(result.pnl);
      reasons.push(result.exitReason);
    }
    
    scenarioResults.push({ mult, pnls, reasons, triggers });
    
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
    const label = mult === 0 ? '固定0.5%' : `${mult.toFixed(1)}x ATR`;
    
    console.log(`  ${label.padEnd(8)} | ${trigMin}%-${trigMax}% | ${fmt(total)} | ${pf.toFixed(2)} | ${(wins.length / pnls.length * 100).toFixed(1)}% | ${wins.length.toString().padStart(2)} | ${losses.length.toString().padStart(2)} | ${zeros.length.toString().padStart(2)} | ${tpCount.toString().padStart(4)}   | ${beCount.toString().padStart(4)}   | ${slCount.toString().padStart(4)}`);
  }
  
  // Detailed comparison: C1 (fixed 0.5%) vs best ATR variant
  console.log('\n' + '='.repeat(60));
  console.log('【詳細比較: 固定0.5% vs 2.0x ATR】');
  
  const c1 = scenarioResults.find(s => s.mult === 0)!;
  const c2x = scenarioResults.find(s => s.mult === 2.0)!;
  
  let better2x = 0, betterFixed = 0, same = 0;
  let improvement2x = 0, improvementFixed = 0;
  
  interface DiffItem { idx: number; diff: number; }
  const diffs: DiffItem[] = [];
  
  for (let i = 0; i < entryDataList.length; i++) {
    const diff = c2x.pnls[i] - c1.pnls[i];
    if (Math.abs(diff) < 10) { same++; continue; }
    if (diff > 0) { better2x++; improvement2x += diff; }
    else { betterFixed++; improvementFixed += Math.abs(diff); }
    diffs.push({ idx: i, diff });
  }
  
  console.log(`  2.0x ATRが有利: ${better2x}件 (合計 +${Math.round(improvement2x).toLocaleString()}円)`);
  console.log(`  固定0.5%が有利: ${betterFixed}件 (合計 +${Math.round(improvementFixed).toLocaleString()}円)`);
  console.log(`  同じ: ${same}件`);
  console.log(`  ネット差分: ${Math.round(improvement2x - improvementFixed) >= 0 ? '+' : ''}${Math.round(improvement2x - improvementFixed).toLocaleString()}円`);
  
  diffs.sort((a, b) => b.diff - a.diff);
  
  if (diffs.filter(d => d.diff > 0).length > 0) {
    console.log('\n  2.0x ATRが有利な取引（BEトリガーが高くTP到達まで持てた）:');
    for (const { idx, diff } of diffs.filter(d => d.diff > 0).slice(0, 8)) {
      const d = entryDataList[idx];
      const trigger = c2x.triggers[idx];
      console.log(`    ${d.entry.tradeDate} ${d.entry.tradeTime} ${d.entry.symbol}(${d.entry.symbolName}) ${d.entry.side} ATR=${(d.atr60*100).toFixed(2)}% trigger=${trigger.toFixed(2)}% | 固定:${c1.reasons[idx]}=${fmt2(c1.pnls[idx])} → ATR:${c2x.reasons[idx]}=${fmt2(c2x.pnls[idx])} (差:+${Math.round(diff).toLocaleString()})`);
    }
  }
  
  if (diffs.filter(d => d.diff < 0).length > 0) {
    console.log('\n  固定0.5%が有利な取引（ATRトリガーが高すぎてBE発動せずSLヒット）:');
    for (const { idx, diff } of diffs.filter(d => d.diff < 0).slice(0, 8)) {
      const d = entryDataList[idx];
      const trigger = c2x.triggers[idx];
      console.log(`    ${d.entry.tradeDate} ${d.entry.tradeTime} ${d.entry.symbol}(${d.entry.symbolName}) ${d.entry.side} ATR=${(d.atr60*100).toFixed(2)}% trigger=${trigger.toFixed(2)}% | 固定:${c1.reasons[idx]}=${fmt2(c1.pnls[idx])} → ATR:${c2x.reasons[idx]}=${fmt2(c2x.pnls[idx])} (差:${Math.round(diff).toLocaleString()})`);
    }
  }
  
  // Per-symbol comparison
  console.log('\n' + '='.repeat(60));
  console.log('【銘柄別比較: 固定0.5% vs 2.0x ATR vs 2.5x ATR】');
  const c25x = scenarioResults.find(s => s.mult === 2.5)!;
  
  const symbols = [...new Set(entryDataList.map(d => d.entry.symbol))];
  console.log('  銘柄            | ATR60  | トリガー(2x) | 固定0.5%  | 2.0x ATR  | 2.5x ATR  | 最良');
  console.log('  ' + '-'.repeat(90));
  for (const sym of symbols) {
    const indices = entryDataList.map((d, i) => d.entry.symbol === sym ? i : -1).filter(i => i >= 0);
    const avgATR = indices.reduce((s, i) => s + entryDataList[i].atr60, 0) / indices.length * 100;
    const avgTrigger2x = indices.reduce((s, i) => s + c2x.triggers[i], 0) / indices.length;
    const c1Total = indices.reduce((s, i) => s + c1.pnls[i], 0);
    const c2xTotal = indices.reduce((s, i) => s + c2x.pnls[i], 0);
    const c25xTotal = indices.reduce((s, i) => s + c25x.pnls[i], 0);
    const best = c2xTotal > c1Total && c2xTotal > c25xTotal ? '2.0x' : c25xTotal > c1Total ? '2.5x' : '固定';
    const name = entryDataList[indices[0]].entry.symbolName;
    console.log(`  ${name.padEnd(14)} | ${avgATR.toFixed(2)}% | ${avgTrigger2x.toFixed(2)}% | ${fmt(c1Total)} | ${fmt(c2xTotal)} | ${fmt(c25xTotal)} | ${best}`);
  }
  
  // Daily breakdown
  console.log('\n' + '='.repeat(60));
  console.log('【日別比較】');
  console.log('  日付        | 固定0.5%  | 2.0x ATR  | 2.5x ATR  | 3.0x ATR');
  console.log('  ' + '-'.repeat(65));
  const dates = [...new Set(entryDataList.map(d => d.entry.tradeDate))].sort();
  const c3x = scenarioResults.find(s => s.mult === 3.0)!;
  for (const date of dates) {
    const indices = entryDataList.map((d, i) => d.entry.tradeDate === date ? i : -1).filter(i => i >= 0);
    const c1Day = indices.reduce((s, i) => s + c1.pnls[i], 0);
    const c2xDay = indices.reduce((s, i) => s + c2x.pnls[i], 0);
    const c25xDay = indices.reduce((s, i) => s + c25x.pnls[i], 0);
    const c3xDay = indices.reduce((s, i) => s + c3x.pnls[i], 0);
    console.log(`  ${date} | ${fmt(c1Day)} | ${fmt(c2xDay)} | ${fmt(c25xDay)} | ${fmt(c3xDay)}`);
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
