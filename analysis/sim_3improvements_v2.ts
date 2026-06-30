/**
 * 3つの改善案シミュレーション (最適化版)
 * データを事前にキャッシュしてクエリ数を最小化
 */
import { getDb } from '../server/db';
import { sql } from 'drizzle-orm';

async function main() {
  const db = await getDb();
  
  // ===== STEP 1: Load all trades =====
  const [tradeRows] = await db.execute(sql`
    SELECT id, tradeDate, symbol, side, action, price, pnl, reason, tradeTime, shares
    FROM rt_trades
    WHERE tradeDate >= '2026-06-17' AND tradeDate <= '2026-06-30'
    ORDER BY tradeDate ASC, tradeTime ASC
  `);
  const trades = tradeRows as any[];
  
  // Pair up trades
  interface TradePair {
    date: string; symbol: string; side: string;
    entryTime: string; entryPrice: number;
    exitTime: string; exitPrice: number;
    pnl: number; reason: string; shares: number;
  }
  const pairs: TradePair[] = [];
  const pending: Record<string, any> = {};
  for (const t of trades) {
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
  
  // ===== STEP 2: Pre-cache all candle data for trade dates/symbols =====
  const tradeDates = [...new Set(pairs.map(p => p.date))].sort();
  const tradeSymbols = [...new Set(pairs.map(p => p.symbol))];
  
  // Cache: date -> symbol -> candles[]
  const candleCache: Record<string, Record<string, any[]>> = {};
  
  for (const date of tradeDates) {
    candleCache[date] = {};
    const [rows] = await db.execute(sql`
      SELECT symbol, candleTime, open, high, low, close, volume,
             JSON_EXTRACT(boardSnapshot, '$.signal') as boardSig
      FROM rt_candles
      WHERE tradeDate = ${date}
      ORDER BY symbol ASC, candleTime ASC
    `);
    for (const r of rows as any[]) {
      if (!candleCache[date][r.symbol]) candleCache[date][r.symbol] = [];
      candleCache[date][r.symbol].push({
        time: r.candleTime,
        open: Number(r.open), high: Number(r.high),
        low: Number(r.low), close: Number(r.close),
        volume: Number(r.volume),
        boardSig: r.boardSig ? String(r.boardSig).replace(/"/g, '') : null,
      });
    }
  }
  
  // ===== IMPROVEMENT 1: 上昇日SHORT抑制 =====
  console.log('========================================');
  console.log('【改善1】上昇日SHORT抑制フィルター');
  console.log('========================================\n');
  
  // Compute intraday metrics at each entry time
  function getMetricsAtTime(date: string, byTime: string) {
    const allSyms = Object.keys(candleCache[date] || {});
    const changes: number[] = [];
    const symChanges: Record<string, number> = {};
    
    for (const sym of allSyms) {
      const candles = candleCache[date][sym];
      if (!candles || candles.length === 0) continue;
      
      // Find first candle with volume
      const first = candles.find((c: any) => c.volume > 0);
      if (!first) continue;
      
      // Find latest candle at or before byTime
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
  
  // End-of-day metrics for context
  console.log('  日別地合い判定 (09:30時点):');
  for (const date of tradeDates) {
    const m = getMetricsAtTime(date, '09:30');
    console.log(`    ${date}: median=${m.medianChange.toFixed(2)}% upRatio=${m.upRatio.toFixed(1)} pct≥0.5%=${(m.pctAboveHalf*100).toFixed(0)}% → ${m.isUpDay ? '【上昇日】' : '通常'}`);
  }
  
  interface Imp1Result { pair: TradePair; blocked: boolean; exception: boolean; reason: string; metrics: any; }
  const imp1Results: Imp1Result[] = [];
  
  for (const pair of pairs) {
    if (pair.side !== 'short') {
      imp1Results.push({ pair, blocked: false, exception: false, reason: '', metrics: null });
      continue;
    }
    
    const metrics = getMetricsAtTime(pair.date, pair.entryTime);
    
    if (!metrics.isUpDay) {
      imp1Results.push({ pair, blocked: false, exception: false, reason: '', metrics });
      continue;
    }
    
    // Exception check: individual stock down + sell_pressure
    const symChange = metrics.symChanges[pair.symbol] || 0;
    const candles = candleCache[pair.date]?.[pair.symbol] || [];
    const entryCandle = candles.find((c: any) => c.time === pair.entryTime);
    const boardSig = entryCandle?.boardSig || '';
    
    if (symChange < -0.3 && boardSig === 'sell_pressure') {
      imp1Results.push({ pair, blocked: false, exception: true, reason: `個別下落${symChange.toFixed(1)}%+sell_pressure`, metrics });
    } else {
      imp1Results.push({ pair, blocked: true, exception: false, reason: `上昇日(median=${metrics.medianChange.toFixed(2)}% upR=${metrics.upRatio.toFixed(1)})`, metrics });
    }
  }
  
  const imp1Blocked = imp1Results.filter(r => r.blocked);
  console.log(`\n  ブロックされたSHORT: ${imp1Blocked.length}件`);
  for (const r of imp1Blocked) {
    console.log(`    ${r.pair.date} ${r.pair.symbol} ${r.pair.entryTime} | 元${r.pair.pnl >= 0 ? '+' : ''}${r.pair.pnl.toLocaleString()}円 | ${r.reason}`);
  }
  const imp1Exceptions = imp1Results.filter(r => r.exception);
  if (imp1Exceptions.length > 0) {
    console.log(`  例外許可: ${imp1Exceptions.length}件`);
    for (const r of imp1Exceptions) {
      console.log(`    ${r.pair.date} ${r.pair.symbol} ${r.pair.entryTime} | ${r.reason}`);
    }
  }
  
  const imp1Pnl = imp1Results.reduce((s, r) => s + (r.blocked ? 0 : r.pair.pnl), 0);
  const imp1BlockedLoss = imp1Blocked.filter(r => r.pair.pnl < 0).reduce((s, r) => s + Math.abs(r.pair.pnl), 0);
  const imp1BlockedProfit = imp1Blocked.filter(r => r.pair.pnl > 0).reduce((s, r) => s + r.pair.pnl, 0);
  
  console.log(`\n  【改善1結果】`);
  console.log(`    回避した損失: +${imp1BlockedLoss.toLocaleString()}円 (${imp1Blocked.filter(r => r.pair.pnl < 0).length}件)`);
  console.log(`    逃した利益: -${imp1BlockedProfit.toLocaleString()}円 (${imp1Blocked.filter(r => r.pair.pnl > 0).length}件)`);
  console.log(`    ベースライン: ${baselinePnl >= 0 ? '+' : ''}${baselinePnl.toLocaleString()}円`);
  console.log(`    改善後: ${imp1Pnl >= 0 ? '+' : ''}${imp1Pnl.toLocaleString()}円`);
  console.log(`    純効果: ${(imp1Pnl - baselinePnl) >= 0 ? '+' : ''}${(imp1Pnl - baselinePnl).toLocaleString()}円`);
  
  // Half-lot mode
  const imp1HalfPnl = imp1Results.reduce((s, r) => s + (r.blocked ? Math.round(r.pair.pnl * 0.5) : r.pair.pnl), 0);
  console.log(`    半ロットモード: ${imp1HalfPnl >= 0 ? '+' : ''}${imp1HalfPnl.toLocaleString()}円 (純効果: ${(imp1HalfPnl - baselinePnl) >= 0 ? '+' : ''}${(imp1HalfPnl - baselinePnl).toLocaleString()}円)`);
  
  // ===== IMPROVEMENT 2: VWAP急落フィルター =====
  console.log('\n\n========================================');
  console.log('【改善2】VWAPクロス下抜けSHORT急落フィルター');
  console.log('========================================\n');
  
  interface Imp2Result { pair: TradePair; isVwap: boolean; drop3: number; drop5: number; volRatio: number; }
  const imp2Results: Imp2Result[] = [];
  
  for (const pair of pairs) {
    const isVwap = pair.side === 'short' && pair.reason.includes('VWAP') && pair.reason.includes('下抜');
    
    if (!isVwap) {
      imp2Results.push({ pair, isVwap: false, drop3: 0, drop5: 0, volRatio: 0 });
      continue;
    }
    
    const candles = candleCache[pair.date]?.[pair.symbol] || [];
    const entryIdx = candles.findIndex((c: any) => c.time === pair.entryTime);
    
    let drop3 = 0, drop5 = 0, volRatio = 0;
    
    if (entryIdx >= 3) {
      drop3 = (candles[entryIdx].close - candles[entryIdx - 3].close) / candles[entryIdx - 3].close * 100;
    }
    if (entryIdx >= 5) {
      drop5 = (candles[entryIdx].close - candles[entryIdx - 5].close) / candles[entryIdx - 5].close * 100;
    }
    
    // Volume ratio
    if (entryIdx >= 1) {
      const prevVols = candles.slice(Math.max(0, entryIdx - 20), entryIdx).filter((c: any) => c.volume > 0).map((c: any) => c.volume);
      if (prevVols.length > 0) {
        const avgVol = prevVols.reduce((s: number, v: number) => s + v, 0) / prevVols.length;
        volRatio = avgVol > 0 ? candles[entryIdx].volume / avgVol : 0;
      }
    }
    
    imp2Results.push({ pair, isVwap: true, drop3, drop5, volRatio });
  }
  
  const vwapShorts = imp2Results.filter(r => r.isVwap);
  console.log(`  VWAPクロス下抜けSHORT: ${vwapShorts.length}件\n`);
  
  for (const r of vwapShorts) {
    const b3 = r.drop3 <= -0.6 ? '★' : ' ';
    const b5 = r.drop5 <= -0.8 ? '★' : ' ';
    console.log(`  ${r.pair.date} ${r.pair.symbol} ${r.pair.entryTime} | pnl=${r.pair.pnl >= 0 ? '+' : ''}${r.pair.pnl.toLocaleString().padStart(7)}円 | drop3=${r.drop3.toFixed(2)}%${b3} drop5=${r.drop5.toFixed(2)}%${b5} volR=${r.volRatio.toFixed(1)}`);
  }
  
  // Filter variants
  const filterTests = [
    { name: '3本≤-0.6%', fn: (r: Imp2Result) => r.drop3 <= -0.6 },
    { name: '5本≤-0.8%', fn: (r: Imp2Result) => r.drop5 <= -0.8 },
    { name: '5本≤-1.0%', fn: (r: Imp2Result) => r.drop5 <= -1.0 },
    { name: '出来高2x+drop3≤-0.5%', fn: (r: Imp2Result) => r.volRatio >= 2.0 && r.drop3 <= -0.5 },
    { name: '3本≤-0.6% OR 5本≤-0.8%', fn: (r: Imp2Result) => r.drop3 <= -0.6 || r.drop5 <= -0.8 },
  ];
  
  console.log('\n  --- フィルター別効果 ---');
  for (const ft of filterTests) {
    const blocked = vwapShorts.filter(r => ft.fn(r));
    const savedLoss = blocked.filter(r => r.pair.pnl < 0).reduce((s, r) => s + Math.abs(r.pair.pnl), 0);
    const missedProfit = blocked.filter(r => r.pair.pnl > 0).reduce((s, r) => s + r.pair.pnl, 0);
    console.log(`  ${ft.name.padEnd(25)} | block=${blocked.length}件 | 回避損失+${savedLoss.toLocaleString().padStart(7)}円 | 逃利益-${missedProfit.toLocaleString().padStart(7)}円 | 純効果${(savedLoss - missedProfit) >= 0 ? '+' : ''}${(savedLoss - missedProfit).toLocaleString()}円`);
  }
  
  // Best variant for combined: 5本≤-0.8%
  const imp2BestFilter = (r: Imp2Result) => r.drop5 <= -0.8;
  const imp2Pnl = pairs.reduce((s, p) => {
    const r = imp2Results.find(x => x.pair === p)!;
    if (r.isVwap && imp2BestFilter(r)) return s;
    return s + p.pnl;
  }, 0);
  console.log(`\n  【改善2結果 (5本≤-0.8%)】`);
  console.log(`    ベースライン: ${baselinePnl >= 0 ? '+' : ''}${baselinePnl.toLocaleString()}円`);
  console.log(`    改善後: ${imp2Pnl >= 0 ? '+' : ''}${imp2Pnl.toLocaleString()}円`);
  console.log(`    純効果: ${(imp2Pnl - baselinePnl) >= 0 ? '+' : ''}${(imp2Pnl - baselinePnl).toLocaleString()}円`);
  
  // ===== IMPROVEMENT 3: BEストップ =====
  console.log('\n\n========================================');
  console.log('【改善3】固定0.5%ブレイクイーブンストップ');
  console.log('========================================\n');
  
  interface Imp3Result {
    pair: TradePair; beTriggered: boolean; beTriggerTime: string;
    beExitTime: string; maxProfitAfterBE: number; adjustedPnl: number;
  }
  const imp3Results: Imp3Result[] = [];
  
  for (const pair of pairs) {
    const candles = candleCache[pair.date]?.[pair.symbol] || [];
    const entryIdx = candles.findIndex((c: any) => c.time === pair.entryTime);
    
    if (entryIdx < 0) {
      imp3Results.push({ pair, beTriggered: false, beTriggerTime: '', beExitTime: '', maxProfitAfterBE: 0, adjustedPnl: pair.pnl });
      continue;
    }
    
    const entryPrice = pair.entryPrice;
    let beTriggered = false, beTriggerTime = '', beExitTime = '', maxProfitAfterBE = 0, adjustedPnl = pair.pnl;
    
    for (let i = entryIdx + 1; i < candles.length; i++) {
      const c = candles[i];
      if (c.time > pair.exitTime && !beTriggered) break; // Past original exit without BE
      
      if (!beTriggered) {
        // Check BE trigger: +0.5% profit
        if (pair.side === 'short' && (entryPrice - c.low) / entryPrice >= 0.005) {
          beTriggered = true;
          beTriggerTime = c.time;
        } else if (pair.side === 'long' && (c.high - entryPrice) / entryPrice >= 0.005) {
          beTriggered = true;
          beTriggerTime = c.time;
        }
      }
      
      if (beTriggered) {
        // Track max profit
        if (pair.side === 'short') {
          const profit = (entryPrice - c.low) / entryPrice * 100;
          if (profit > maxProfitAfterBE) maxProfitAfterBE = profit;
          // Check if price returns to entry (BE exit)
          if (c.high >= entryPrice) {
            beExitTime = c.time;
            adjustedPnl = 0;
            break;
          }
        } else {
          const profit = (c.high - entryPrice) / entryPrice * 100;
          if (profit > maxProfitAfterBE) maxProfitAfterBE = profit;
          if (c.low <= entryPrice) {
            beExitTime = c.time;
            adjustedPnl = 0;
            break;
          }
        }
        
        // If we reach original exit time, use original result
        if (c.time >= pair.exitTime) break;
      }
    }
    
    imp3Results.push({ pair, beTriggered, beTriggerTime, beExitTime, maxProfitAfterBE, adjustedPnl });
  }
  
  const beTriggered = imp3Results.filter(r => r.beTriggered);
  const beExited = imp3Results.filter(r => r.beExitTime !== '');
  
  console.log(`  BEトリガー発動: ${beTriggered.length}/${pairs.length}件`);
  console.log(`  BE決済(建値撤退): ${beExited.length}件\n`);
  
  console.log('  BE決済の詳細:');
  for (const r of beExited) {
    const saved = r.pair.pnl < 0 ? `損失回避+${Math.abs(r.pair.pnl).toLocaleString()}円` : `利益減少-${r.pair.pnl.toLocaleString()}円`;
    console.log(`    ${r.pair.date} ${r.pair.symbol} ${r.pair.side} | 元${r.pair.pnl >= 0 ? '+' : ''}${r.pair.pnl.toLocaleString()}円→0円 | ${saved} | BE@${r.beTriggerTime}→exit@${r.beExitTime} | maxProfit=${r.maxProfitAfterBE.toFixed(2)}%`);
  }
  
  console.log('\n  BEトリガー後にTP到達したトレード:');
  const beButTP = beTriggered.filter(r => r.beExitTime === '' && r.pair.pnl > 0);
  for (const r of beButTP) {
    console.log(`    ${r.pair.date} ${r.pair.symbol} ${r.pair.side} | +${r.pair.pnl.toLocaleString()}円 (BE後もTP到達) | maxProfit=${r.maxProfitAfterBE.toFixed(2)}%`);
  }
  
  const imp3Pnl = imp3Results.reduce((s, r) => s + r.adjustedPnl, 0);
  const imp3SavedLoss = beExited.filter(r => r.pair.pnl < 0).reduce((s, r) => s + Math.abs(r.pair.pnl), 0);
  const imp3LostProfit = beExited.filter(r => r.pair.pnl > 0).reduce((s, r) => s + r.pair.pnl, 0);
  
  console.log(`\n  【改善3結果】`);
  console.log(`    回避した損失: +${imp3SavedLoss.toLocaleString()}円`);
  console.log(`    失った利益: -${imp3LostProfit.toLocaleString()}円`);
  console.log(`    ベースライン: ${baselinePnl >= 0 ? '+' : ''}${baselinePnl.toLocaleString()}円`);
  console.log(`    改善後: ${imp3Pnl >= 0 ? '+' : ''}${imp3Pnl.toLocaleString()}円`);
  console.log(`    純効果: ${(imp3Pnl - baselinePnl) >= 0 ? '+' : ''}${(imp3Pnl - baselinePnl).toLocaleString()}円`);
  
  // ===== COMBINED =====
  console.log('\n\n========================================');
  console.log('【全改善組み合わせ】');
  console.log('========================================\n');
  
  let combinedPnl = 0;
  const changes: string[] = [];
  
  for (const pair of pairs) {
    // Check Imp1
    const r1 = imp1Results.find(r => r.pair === pair)!;
    if (r1.blocked) {
      changes.push(`  ${pair.date} ${pair.symbol} ${pair.side} ${pair.entryTime} | ${pair.pnl >= 0 ? '+' : ''}${pair.pnl.toLocaleString()}円 → 0円 [上昇日ブロック]`);
      continue;
    }
    
    // Check Imp2
    const r2 = imp2Results.find(r => r.pair === pair)!;
    if (r2.isVwap && imp2BestFilter(r2)) {
      changes.push(`  ${pair.date} ${pair.symbol} ${pair.side} ${pair.entryTime} | ${pair.pnl >= 0 ? '+' : ''}${pair.pnl.toLocaleString()}円 → 0円 [VWAP急落ブロック]`);
      continue;
    }
    
    // Check Imp3
    const r3 = imp3Results.find(r => r.pair === pair)!;
    if (r3.beExitTime !== '') {
      combinedPnl += 0;
      changes.push(`  ${pair.date} ${pair.symbol} ${pair.side} ${pair.entryTime} | ${pair.pnl >= 0 ? '+' : ''}${pair.pnl.toLocaleString()}円 → 0円 [BE決済]`);
      continue;
    }
    
    combinedPnl += pair.pnl;
  }
  
  console.log('  変更があったトレード:');
  for (const c of changes) console.log(c);
  
  console.log(`\n  【組み合わせ結果】`);
  console.log(`    ベースライン: ${baselinePnl >= 0 ? '+' : ''}${baselinePnl.toLocaleString()}円 (${pairs.length}件, 勝率${baselineWins}/${pairs.length})`);
  console.log(`    全改善適用後: ${combinedPnl >= 0 ? '+' : ''}${combinedPnl.toLocaleString()}円`);
  console.log(`    改善額: ${(combinedPnl - baselinePnl) >= 0 ? '+' : ''}${(combinedPnl - baselinePnl).toLocaleString()}円`);
  
  // Daily breakdown
  console.log('\n  --- 日別比較 ---');
  console.log('  日付       | ベースライン | 改善後      | 差分');
  console.log('  -----------|-------------|------------|----------');
  for (const date of tradeDates) {
    const dayPairs = pairs.filter(p => p.date === date);
    const dayBase = dayPairs.reduce((s, p) => s + p.pnl, 0);
    
    let dayImproved = 0;
    for (const pair of dayPairs) {
      const r1 = imp1Results.find(r => r.pair === pair)!;
      if (r1.blocked) continue;
      const r2 = imp2Results.find(r => r.pair === pair)!;
      if (r2.isVwap && imp2BestFilter(r2)) continue;
      const r3 = imp3Results.find(r => r.pair === pair)!;
      if (r3.beExitTime !== '') continue;
      dayImproved += pair.pnl;
    }
    
    const diff = dayImproved - dayBase;
    const marker = diff > 0 ? ' ✓' : diff < 0 ? ' ✗' : '';
    console.log(`  ${date} | ${dayBase >= 0 ? '+' : ''}${dayBase.toLocaleString().padStart(9)}円 | ${dayImproved >= 0 ? '+' : ''}${dayImproved.toLocaleString().padStart(9)}円 | ${diff >= 0 ? '+' : ''}${diff.toLocaleString().padStart(8)}円${marker}`);
  }
  
  process.exit(0);
}

main();
