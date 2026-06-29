/**
 * Backtest Proposal C variants:
 * - Baseline: SL 0.5%, TP 1.5%
 * - C1: SL 0.5%, TP 1.5% + BE stop at +0.5%
 * - C2: SL 0.5%, TP 2.0% + BE stop at +0.5%
 * - C3: SL 0.5%, TP 2.0% (no BE stop) for reference
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
  
  // Get all trades
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
  
  // Pair entries with exits
  const entries = allTrades.filter(t => t.pnl === null);
  
  interface SimResult {
    symbol: string;
    symbolName: string;
    date: string;
    time: string;
    side: string;
    entryPrice: number;
    shares: number;
    baseline_pnl: number;     // SL 0.5%, TP 1.5%
    c1_pnl: number;           // SL 0.5%, TP 1.5% + BE at +0.5%
    c2_pnl: number;           // SL 0.5%, TP 2.0% + BE at +0.5%
    c3_pnl: number;           // SL 0.5%, TP 2.0% (no BE)
    exitReason_baseline: string;
    exitReason_c1: string;
    exitReason_c2: string;
    exitReason_c3: string;
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
    
    // Get all candles during holding period + after
    const holdingCandles = await db.execute(
      sql`SELECT candleTime, open, high, low, close, volume
          FROM rt_candles 
          WHERE symbol = ${entry.symbol} AND tradeDate = ${entry.tradeDate}
          AND candleTime > ${entry.tradeTime}
          ORDER BY candleTime`
    ) as any;
    const holding = holdingCandles[0] ?? holdingCandles;
    
    const slPct = 0.005;
    const tp15 = 0.015;
    const tp20 = 0.020;
    const beTrigger = 0.005;
    
    // Simulate all 4 scenarios
    let baseline_pnl: number | null = null;
    let c1_pnl: number | null = null;
    let c2_pnl: number | null = null;
    let c3_pnl: number | null = null;
    let exitReason_baseline = 'close';
    let exitReason_c1 = 'close';
    let exitReason_c2 = 'close';
    let exitReason_c3 = 'close';
    
    let c1_beTriggered = false;
    let c2_beTriggered = false;
    
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
      
      // --- Baseline: SL 0.5%, TP 1.5% ---
      if (baseline_pnl === null) {
        if (unrealizedLow <= -slPct) {
          baseline_pnl = -slPct * entry.price * entry.shares;
          exitReason_baseline = 'SL(-0.5%)';
        } else if (unrealizedHigh >= tp15) {
          baseline_pnl = tp15 * entry.price * entry.shares;
          exitReason_baseline = 'TP(+1.5%)';
        }
      }
      
      // --- C1: SL 0.5%, TP 1.5% + BE at +0.5% ---
      if (c1_pnl === null) {
        if (!c1_beTriggered && unrealizedHigh >= beTrigger) {
          c1_beTriggered = true;
        }
        if (c1_beTriggered) {
          if (unrealizedLow <= 0) {
            c1_pnl = 0;
            exitReason_c1 = 'BE(建値)';
          } else if (unrealizedHigh >= tp15) {
            c1_pnl = tp15 * entry.price * entry.shares;
            exitReason_c1 = 'TP(+1.5%)';
          }
        } else {
          if (unrealizedLow <= -slPct) {
            c1_pnl = -slPct * entry.price * entry.shares;
            exitReason_c1 = 'SL(-0.5%)';
          } else if (unrealizedHigh >= tp15) {
            c1_pnl = tp15 * entry.price * entry.shares;
            exitReason_c1 = 'TP(+1.5%)';
          }
        }
      }
      
      // --- C2: SL 0.5%, TP 2.0% + BE at +0.5% ---
      if (c2_pnl === null) {
        if (!c2_beTriggered && unrealizedHigh >= beTrigger) {
          c2_beTriggered = true;
        }
        if (c2_beTriggered) {
          if (unrealizedLow <= 0) {
            c2_pnl = 0;
            exitReason_c2 = 'BE(建値)';
          } else if (unrealizedHigh >= tp20) {
            c2_pnl = tp20 * entry.price * entry.shares;
            exitReason_c2 = 'TP(+2.0%)';
          }
        } else {
          if (unrealizedLow <= -slPct) {
            c2_pnl = -slPct * entry.price * entry.shares;
            exitReason_c2 = 'SL(-0.5%)';
          } else if (unrealizedHigh >= tp20) {
            c2_pnl = tp20 * entry.price * entry.shares;
            exitReason_c2 = 'TP(+2.0%)';
          }
        }
      }
      
      // --- C3: SL 0.5%, TP 2.0% (no BE) ---
      if (c3_pnl === null) {
        if (unrealizedLow <= -slPct) {
          c3_pnl = -slPct * entry.price * entry.shares;
          exitReason_c3 = 'SL(-0.5%)';
        } else if (unrealizedHigh >= tp20) {
          c3_pnl = tp20 * entry.price * entry.shares;
          exitReason_c3 = 'TP(+2.0%)';
        }
      }
      
      // If all scenarios resolved, break
      if (baseline_pnl !== null && c1_pnl !== null && c2_pnl !== null && c3_pnl !== null) break;
    }
    
    // Unresolved → use forced close (last candle close or original exit pnl)
    if (baseline_pnl === null) { baseline_pnl = exit.pnl!; exitReason_baseline = '大引け'; }
    if (c1_pnl === null) { c1_pnl = exit.pnl!; exitReason_c1 = '大引け'; }
    if (c2_pnl === null) {
      // For TP 2.0% scenarios, use last close price
      const lastCandle = holding[holding.length - 1];
      if (lastCandle) {
        const lastClose = Number(lastCandle.close);
        if (entry.side === 'short') {
          c2_pnl = (entry.price - lastClose) / entry.price * entry.price * entry.shares;
        } else {
          c2_pnl = (lastClose - entry.price) / entry.price * entry.price * entry.shares;
        }
      } else {
        c2_pnl = exit.pnl!;
      }
      exitReason_c2 = '大引け';
    }
    if (c3_pnl === null) {
      const lastCandle = holding[holding.length - 1];
      if (lastCandle) {
        const lastClose = Number(lastCandle.close);
        if (entry.side === 'short') {
          c3_pnl = (entry.price - lastClose) / entry.price * entry.price * entry.shares;
        } else {
          c3_pnl = (lastClose - entry.price) / entry.price * entry.price * entry.shares;
        }
      } else {
        c3_pnl = exit.pnl!;
      }
      exitReason_c3 = '大引け';
    }
    
    results.push({
      symbol: entry.symbol,
      symbolName: entry.symbolName,
      date: entry.tradeDate,
      time: entry.tradeTime,
      side: entry.side,
      entryPrice: entry.price,
      shares: entry.shares,
      baseline_pnl,
      c1_pnl,
      c2_pnl,
      c3_pnl,
      exitReason_baseline,
      exitReason_c1,
      exitReason_c2,
      exitReason_c3,
    });
  }
  
  console.log(`=== 提案C TP変更バックテスト（全${results.length}取引、9日間） ===\n`);
  
  // Print summary for each scenario
  const scenarios = [
    { name: 'ベースライン (SL0.5% / TP1.5%)', key: 'baseline_pnl' as const, reasonKey: 'exitReason_baseline' as const },
    { name: 'C1: BE(+0.5%) + TP1.5%', key: 'c1_pnl' as const, reasonKey: 'exitReason_c1' as const },
    { name: 'C2: BE(+0.5%) + TP2.0%', key: 'c2_pnl' as const, reasonKey: 'exitReason_c2' as const },
    { name: 'C3: TP2.0%のみ (BEなし)', key: 'c3_pnl' as const, reasonKey: 'exitReason_c3' as const },
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
    
    // Exit reason breakdown
    const reasons: Record<string, number> = {};
    for (const r of results) {
      const reason = r[s.reasonKey];
      reasons[reason] = (reasons[reason] || 0) + 1;
    }
    
    console.log('='.repeat(60));
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
  
  // C1 vs C2 comparison - which trades differ
  console.log('\n' + '='.repeat(60));
  console.log('【C1 vs C2 差分分析（TP1.5% vs TP2.0% with BE）】');
  console.log('');
  
  let c2Better = 0, c1Better = 0, same = 0;
  let c2Improvement = 0, c1Improvement = 0;
  
  const diffs: { r: SimResult; diff: number }[] = [];
  
  for (const r of results) {
    const diff = r.c2_pnl - r.c1_pnl;
    if (Math.abs(diff) < 10) { same++; continue; }
    if (diff > 0) { c2Better++; c2Improvement += diff; }
    else { c1Better++; c1Improvement += Math.abs(diff); }
    diffs.push({ r, diff });
  }
  
  console.log(`  C2が有利: ${c2Better}件 (合計 +${Math.round(c2Improvement).toLocaleString()}円)`);
  console.log(`  C1が有利: ${c1Better}件 (合計 +${Math.round(c1Improvement).toLocaleString()}円)`);
  console.log(`  同じ: ${same}件`);
  console.log(`  ネット差分: ${Math.round(c2Improvement - c1Improvement) >= 0 ? '+' : ''}${Math.round(c2Improvement - c1Improvement).toLocaleString()}円`);
  
  // Show top differences
  diffs.sort((a, b) => b.diff - a.diff);
  console.log('\n  C2が有利な取引（TP2.0%到達）:');
  for (const { r, diff } of diffs.filter(d => d.diff > 0).slice(0, 10)) {
    console.log(`    ${r.date} ${r.time} ${r.symbol}(${r.symbolName}) ${r.side} | C1:${r.exitReason_c1}=${r.c1_pnl >= 0 ? '+' : ''}${Math.round(r.c1_pnl).toLocaleString()} → C2:${r.exitReason_c2}=${r.c2_pnl >= 0 ? '+' : ''}${Math.round(r.c2_pnl).toLocaleString()} (差:+${Math.round(diff).toLocaleString()})`);
  }
  
  console.log('\n  C1が有利な取引（TP1.5%で利確できたがTP2.0%未達）:');
  for (const { r, diff } of diffs.filter(d => d.diff < 0).slice(0, 10)) {
    console.log(`    ${r.date} ${r.time} ${r.symbol}(${r.symbolName}) ${r.side} | C1:${r.exitReason_c1}=${r.c1_pnl >= 0 ? '+' : ''}${Math.round(r.c1_pnl).toLocaleString()} → C2:${r.exitReason_c2}=${r.c2_pnl >= 0 ? '+' : ''}${Math.round(r.c2_pnl).toLocaleString()} (差:${Math.round(diff).toLocaleString()})`);
  }
  
  // Daily breakdown
  console.log('\n' + '='.repeat(60));
  console.log('【日別比較】');
  console.log('  日付        | ベースライン | C1(BE+TP1.5%) | C2(BE+TP2.0%) | C3(TP2.0%のみ)');
  console.log('  ' + '-'.repeat(75));
  const dates = [...new Set(results.map(r => r.date))].sort();
  for (const date of dates) {
    const dayResults = results.filter(r => r.date === date);
    const bl = dayResults.reduce((s, r) => s + r.baseline_pnl, 0);
    const c1 = dayResults.reduce((s, r) => s + r.c1_pnl, 0);
    const c2 = dayResults.reduce((s, r) => s + r.c2_pnl, 0);
    const c3 = dayResults.reduce((s, r) => s + r.c3_pnl, 0);
    console.log(`  ${date} | ${fmt(bl)} | ${fmt(c1)} | ${fmt(c2)} | ${fmt(c3)}`);
  }
  
  process.exit(0);
}

function fmt(n: number): string {
  const s = `${n >= 0 ? '+' : ''}${Math.round(n).toLocaleString()}`;
  return s.padStart(12);
}

main().catch(e => { console.error(e); process.exit(1); });
