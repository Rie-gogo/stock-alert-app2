/**
 * 3つの改善案シミュレーション v3
 * 改善1の例外条件を緩和: symChange < -0.5% のみで例外許可
 * + 改善2+3の組み合わせ最適解
 */
import { getDb } from '../server/db';
import { sql } from 'drizzle-orm';

async function main() {
  const db = await getDb();
  
  // Load all trades
  const [tradeRows] = await db.execute(sql`
    SELECT id, tradeDate, symbol, side, action, price, pnl, reason, tradeTime, shares
    FROM rt_trades WHERE tradeDate >= '2026-06-17' AND tradeDate <= '2026-06-30'
    ORDER BY tradeDate ASC, tradeTime ASC
  `);
  
  interface TradePair {
    date: string; symbol: string; side: string;
    entryTime: string; entryPrice: number;
    exitTime: string; exitPrice: number;
    pnl: number; reason: string; shares: number;
  }
  const pairs: TradePair[] = [];
  const pending: Record<string, any> = {};
  for (const t of tradeRows as any[]) {
    const key = `${t.tradeDate}_${t.symbol}_${t.side}`;
    if (t.action === 'short' || t.action === 'buy') {
      pending[key] = t;
    } else {
      const entry = pending[key];
      if (entry) {
        pairs.push({
          date: t.tradeDate, symbol: t.symbol, side: t.side,
          entryTime: entry.tradeTime, entryPrice: Number(entry.price),
          exitTime: t.tradeTime, exitPrice: Number(t.price),
          pnl: Number(t.pnl), reason: entry.reason || '', shares: Number(entry.shares),
        });
        delete pending[key];
      }
    }
  }
  
  const baselinePnl = pairs.reduce((s, p) => s + p.pnl, 0);
  const baselineWins = pairs.filter(p => p.pnl > 0).length;
  console.log(`=== ベースライン: ${pairs.length}件 | 勝率${baselineWins}/${pairs.length} (${(baselineWins/pairs.length*100).toFixed(0)}%) | 総損益${baselinePnl >= 0 ? '+' : ''}${baselinePnl.toLocaleString()}円 ===\n`);
  
  // Pre-cache candles
  const tradeDates = [...new Set(pairs.map(p => p.date))].sort();
  const candleCache: Record<string, Record<string, any[]>> = {};
  for (const date of tradeDates) {
    candleCache[date] = {};
    const [rows] = await db.execute(sql`
      SELECT symbol, candleTime, open, high, low, close, volume,
             JSON_EXTRACT(boardSnapshot, '$.signal') as boardSig
      FROM rt_candles WHERE tradeDate = ${date} ORDER BY symbol ASC, candleTime ASC
    `);
    for (const r of rows as any[]) {
      if (!candleCache[date][r.symbol]) candleCache[date][r.symbol] = [];
      candleCache[date][r.symbol].push({
        time: r.candleTime, open: Number(r.open), high: Number(r.high),
        low: Number(r.low), close: Number(r.close), volume: Number(r.volume),
        boardSig: r.boardSig ? String(r.boardSig).replace(/"/g, '') : null,
      });
    }
  }
  
  function getMetricsAtTime(date: string, byTime: string) {
    const allSyms = Object.keys(candleCache[date] || {});
    const changes: number[] = [];
    const symChanges: Record<string, number> = {};
    for (const sym of allSyms) {
      const candles = candleCache[date][sym];
      if (!candles || candles.length === 0) continue;
      const first = candles.find((c: any) => c.volume > 0);
      if (!first) continue;
      let latest = null;
      for (let i = candles.length - 1; i >= 0; i--) {
        if (candles[i].time <= byTime) { latest = candles[i]; break; }
      }
      if (!latest) continue;
      const change = (latest.close - first.open) / first.open * 100;
      changes.push(change);
      symChanges[sym] = change;
    }
    if (changes.length === 0) return { isUpDay: false, medianChange: 0, upRatio: 0, pctAboveHalf: 0, symChanges };
    changes.sort((a, b) => a - b);
    const medianChange = changes[Math.floor(changes.length / 2)];
    const up = changes.filter(c => c > 0).length;
    const down = changes.filter(c => c < 0).length;
    const upRatio = down > 0 ? up / down : up > 0 ? 99 : 0;
    const pctAboveHalf = changes.filter(c => c >= 0.5).length / changes.length;
    const isUpDay = pctAboveHalf >= 0.6 || upRatio >= 2.0 || medianChange >= 0.5;
    return { isUpDay, medianChange, upRatio, pctAboveHalf, symChanges };
  }
  
  // ===== Test multiple exception thresholds for Improvement 1 =====
  console.log('========================================');
  console.log('【改善1】上昇日SHORT抑制 - 例外条件スイープ');
  console.log('========================================\n');
  
  const exceptionThresholds = [-0.3, -0.5, -0.8, -1.0];
  
  for (const threshold of exceptionThresholds) {
    let imp1Pnl = 0;
    let blocked = 0;
    let blockedLoss = 0;
    let blockedProfit = 0;
    
    for (const pair of pairs) {
      if (pair.side !== 'short') { imp1Pnl += pair.pnl; continue; }
      
      const metrics = getMetricsAtTime(pair.date, pair.entryTime);
      if (!metrics.isUpDay) { imp1Pnl += pair.pnl; continue; }
      
      // Exception: individual stock below threshold
      const symChange = metrics.symChanges[pair.symbol] || 0;
      if (symChange < threshold) {
        imp1Pnl += pair.pnl; // Exception - allow
        continue;
      }
      
      // Block
      blocked++;
      if (pair.pnl < 0) blockedLoss += Math.abs(pair.pnl);
      else blockedProfit += pair.pnl;
    }
    
    const effect = imp1Pnl - baselinePnl;
    console.log(`  例外: symChange < ${threshold}% | block=${blocked}件 | 回避損失+${blockedLoss.toLocaleString()}円 | 逃利益-${blockedProfit.toLocaleString()}円 | 純効果${effect >= 0 ? '+' : ''}${effect.toLocaleString()}円`);
  }
  
  // Also test: exception = symChange < -0.5% OR (5min HTF downtrend)
  // And: no exception at all (block all shorts on up days)
  let imp1NoException = 0;
  let noExBlocked = 0, noExLoss = 0, noExProfit = 0;
  for (const pair of pairs) {
    if (pair.side !== 'short') { imp1NoException += pair.pnl; continue; }
    const metrics = getMetricsAtTime(pair.date, pair.entryTime);
    if (!metrics.isUpDay) { imp1NoException += pair.pnl; continue; }
    noExBlocked++;
    if (pair.pnl < 0) noExLoss += Math.abs(pair.pnl);
    else noExProfit += pair.pnl;
  }
  console.log(`  例外なし(全ブロック)    | block=${noExBlocked}件 | 回避損失+${noExLoss.toLocaleString()}円 | 逃利益-${noExProfit.toLocaleString()}円 | 純効果${(imp1NoException - baselinePnl) >= 0 ? '+' : ''}${(imp1NoException - baselinePnl).toLocaleString()}円`);
  
  // Best: use -0.5% threshold (allows both profitable trades through)
  console.log('\n  → 推奨: symChange < -0.5% で例外許可');
  
  // ===== Improvement 2: unchanged (perfect) =====
  console.log('\n========================================');
  console.log('【改善2】VWAP急落フィルター (5本≤-0.8%)');
  console.log('========================================\n');
  
  interface Imp2 { pair: TradePair; isVwap: boolean; drop5: number; blocked: boolean; }
  const imp2Results: Imp2[] = [];
  
  for (const pair of pairs) {
    const isVwap = pair.side === 'short' && pair.reason.includes('VWAP') && pair.reason.includes('下抜');
    if (!isVwap) { imp2Results.push({ pair, isVwap: false, drop5: 0, blocked: false }); continue; }
    
    const candles = candleCache[pair.date]?.[pair.symbol] || [];
    const entryIdx = candles.findIndex((c: any) => c.time === pair.entryTime);
    let drop5 = 0;
    if (entryIdx >= 5) {
      drop5 = (candles[entryIdx].close - candles[entryIdx - 5].close) / candles[entryIdx - 5].close * 100;
    }
    const blocked = drop5 <= -0.8;
    imp2Results.push({ pair, isVwap: true, drop5, blocked });
    if (blocked) {
      console.log(`  ブロック: ${pair.date} ${pair.symbol} ${pair.entryTime} | pnl=${pair.pnl >= 0 ? '+' : ''}${pair.pnl.toLocaleString()}円 | drop5=${drop5.toFixed(2)}%`);
    }
  }
  
  const imp2Effect = imp2Results.filter(r => r.blocked).reduce((s, r) => s - r.pair.pnl, 0);
  console.log(`  純効果: +${imp2Effect.toLocaleString()}円 (全てが損失回避、利益損失なし)`);
  
  // ===== Improvement 3: BE stop =====
  console.log('\n========================================');
  console.log('【改善3】BEストップ');
  console.log('========================================\n');
  
  interface Imp3 { pair: TradePair; beTriggered: boolean; beExitTime: string; adjustedPnl: number; maxProfit: number; }
  const imp3Results: Imp3[] = [];
  
  for (const pair of pairs) {
    const candles = candleCache[pair.date]?.[pair.symbol] || [];
    const entryIdx = candles.findIndex((c: any) => c.time === pair.entryTime);
    if (entryIdx < 0) { imp3Results.push({ pair, beTriggered: false, beExitTime: '', adjustedPnl: pair.pnl, maxProfit: 0 }); continue; }
    
    let beTriggered = false, beTriggerTime = '', beExitTime = '', maxProfit = 0, adjustedPnl = pair.pnl;
    
    for (let i = entryIdx + 1; i < candles.length; i++) {
      const c = candles[i];
      if (c.time > pair.exitTime && !beTriggered) break;
      
      if (!beTriggered) {
        if (pair.side === 'short' && (pair.entryPrice - c.low) / pair.entryPrice >= 0.005) {
          beTriggered = true; beTriggerTime = c.time;
        } else if (pair.side === 'long' && (c.high - pair.entryPrice) / pair.entryPrice >= 0.005) {
          beTriggered = true; beTriggerTime = c.time;
        }
      }
      
      if (beTriggered) {
        if (pair.side === 'short') {
          const p = (pair.entryPrice - c.low) / pair.entryPrice * 100;
          if (p > maxProfit) maxProfit = p;
          if (c.high >= pair.entryPrice) { beExitTime = c.time; adjustedPnl = 0; break; }
        } else {
          const p = (c.high - pair.entryPrice) / pair.entryPrice * 100;
          if (p > maxProfit) maxProfit = p;
          if (c.low <= pair.entryPrice) { beExitTime = c.time; adjustedPnl = 0; break; }
        }
        if (c.time >= pair.exitTime) break;
      }
    }
    
    imp3Results.push({ pair, beTriggered, beExitTime, adjustedPnl, maxProfit });
  }
  
  const beExited = imp3Results.filter(r => r.beExitTime !== '');
  const beSavedLoss = beExited.filter(r => r.pair.pnl < 0).reduce((s, r) => s + Math.abs(r.pair.pnl), 0);
  const beLostProfit = beExited.filter(r => r.pair.pnl > 0).reduce((s, r) => s + r.pair.pnl, 0);
  console.log(`  BE決済: ${beExited.length}件 | 回避損失+${beSavedLoss.toLocaleString()}円 | 失利益-${beLostProfit.toLocaleString()}円 | 純効果+${(beSavedLoss - beLostProfit).toLocaleString()}円`);
  
  // ===== COMBINED: All 3 with best settings =====
  console.log('\n\n========================================');
  console.log('【最適組み合わせ】改善1(例外-0.5%) + 改善2(5本-0.8%) + 改善3(BE)');
  console.log('========================================\n');
  
  let combinedPnl = 0;
  let combinedWins = 0;
  let combinedTrades = 0;
  
  for (const pair of pairs) {
    // Imp1: Up day block with -0.5% exception
    if (pair.side === 'short') {
      const metrics = getMetricsAtTime(pair.date, pair.entryTime);
      if (metrics.isUpDay) {
        const symChange = metrics.symChanges[pair.symbol] || 0;
        if (symChange >= -0.5) { continue; } // Blocked (no exception)
      }
    }
    
    // Imp2: VWAP drop filter
    const r2 = imp2Results.find(r => r.pair === pair)!;
    if (r2.isVwap && r2.blocked) { continue; }
    
    // Imp3: BE stop
    const r3 = imp3Results.find(r => r.pair === pair)!;
    const pnl = r3.beExitTime !== '' ? 0 : pair.pnl;
    
    combinedPnl += pnl;
    combinedTrades++;
    if (pnl > 0) combinedWins++;
  }
  
  console.log(`  ベースライン: ${pairs.length}件 | 勝率${baselineWins}/${pairs.length} (${(baselineWins/pairs.length*100).toFixed(0)}%) | ${baselinePnl >= 0 ? '+' : ''}${baselinePnl.toLocaleString()}円`);
  console.log(`  全改善適用: ${combinedTrades}件 | 勝率${combinedWins}/${combinedTrades} (${(combinedWins/combinedTrades*100).toFixed(0)}%) | ${combinedPnl >= 0 ? '+' : ''}${combinedPnl.toLocaleString()}円`);
  console.log(`  改善額: ${(combinedPnl - baselinePnl) >= 0 ? '+' : ''}${(combinedPnl - baselinePnl).toLocaleString()}円`);
  
  // ===== Also test: Imp2 + Imp3 only (without Imp1) =====
  console.log('\n========================================');
  console.log('【改善2+3のみ】(改善1なし)');
  console.log('========================================\n');
  
  let combo23Pnl = 0, combo23Wins = 0, combo23Trades = 0;
  for (const pair of pairs) {
    const r2 = imp2Results.find(r => r.pair === pair)!;
    if (r2.isVwap && r2.blocked) { continue; }
    const r3 = imp3Results.find(r => r.pair === pair)!;
    const pnl = r3.beExitTime !== '' ? 0 : pair.pnl;
    combo23Pnl += pnl;
    combo23Trades++;
    if (pnl > 0) combo23Wins++;
  }
  console.log(`  改善2+3: ${combo23Trades}件 | 勝率${combo23Wins}/${combo23Trades} (${(combo23Wins/combo23Trades*100).toFixed(0)}%) | ${combo23Pnl >= 0 ? '+' : ''}${combo23Pnl.toLocaleString()}円`);
  console.log(`  改善額: ${(combo23Pnl - baselinePnl) >= 0 ? '+' : ''}${(combo23Pnl - baselinePnl).toLocaleString()}円`);
  
  // ===== Daily breakdown for best combo =====
  console.log('\n--- 日別比較 (改善2+3) ---');
  console.log('日付       | ベースライン | 改善2+3    | 差分       | 全3改善    | 差分');
  console.log('-----------|-------------|-----------|-----------|-----------|----------');
  
  for (const date of tradeDates) {
    const dayPairs = pairs.filter(p => p.date === date);
    const dayBase = dayPairs.reduce((s, p) => s + p.pnl, 0);
    
    let day23 = 0;
    for (const pair of dayPairs) {
      const r2 = imp2Results.find(r => r.pair === pair)!;
      if (r2.isVwap && r2.blocked) continue;
      const r3 = imp3Results.find(r => r.pair === pair)!;
      day23 += r3.beExitTime !== '' ? 0 : pair.pnl;
    }
    
    let dayAll = 0;
    for (const pair of dayPairs) {
      if (pair.side === 'short') {
        const metrics = getMetricsAtTime(pair.date, pair.entryTime);
        if (metrics.isUpDay) {
          const symChange = metrics.symChanges[pair.symbol] || 0;
          if (symChange >= -0.5) continue;
        }
      }
      const r2 = imp2Results.find(r => r.pair === pair)!;
      if (r2.isVwap && r2.blocked) continue;
      const r3 = imp3Results.find(r => r.pair === pair)!;
      dayAll += r3.beExitTime !== '' ? 0 : pair.pnl;
    }
    
    const diff23 = day23 - dayBase;
    const diffAll = dayAll - dayBase;
    console.log(`${date} | ${dayBase >= 0 ? '+' : ''}${dayBase.toLocaleString().padStart(9)}円 | ${day23 >= 0 ? '+' : ''}${day23.toLocaleString().padStart(8)}円 | ${diff23 >= 0 ? '+' : ''}${diff23.toLocaleString().padStart(8)}円 | ${dayAll >= 0 ? '+' : ''}${dayAll.toLocaleString().padStart(8)}円 | ${diffAll >= 0 ? '+' : ''}${diffAll.toLocaleString().padStart(8)}円`);
  }
  
  // ===== 6/30 specific analysis =====
  console.log('\n--- 6/30 詳細 ---');
  const day30 = pairs.filter(p => p.date === '2026-06-30');
  for (const pair of day30) {
    const r2 = imp2Results.find(r => r.pair === pair)!;
    const r3 = imp3Results.find(r => r.pair === pair)!;
    let status = '';
    let finalPnl = pair.pnl;
    if (r2.isVwap && r2.blocked) { status = '[VWAP急落ブロック]'; finalPnl = 0; }
    else if (r3.beExitTime !== '') { status = `[BE決済@${r3.beExitTime}]`; finalPnl = 0; }
    console.log(`  ${pair.symbol} ${pair.side} ${pair.entryTime} | 元${pair.pnl >= 0 ? '+' : ''}${pair.pnl.toLocaleString()}円 → ${finalPnl >= 0 ? '+' : ''}${finalPnl.toLocaleString()}円 ${status} | ${pair.reason}`);
  }
  
  process.exit(0);
}

main();
