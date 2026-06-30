/**
 * 3つの改善案シミュレーション
 * 1. 上昇日SHORT抑制フィルター
 * 2. VWAPクロス下抜けSHORTの急落フィルター
 * 3. 固定0.5%ブレイクイーブンストップ
 * 
 * 既存トレードデータを再シミュレーションして改善効果を検証
 */
import { getDb } from '../server/db';
import { sql } from 'drizzle-orm';

interface Trade {
  id: number;
  tradeDate: string;
  symbol: string;
  side: string;
  action: string;
  price: number;
  pnl: number;
  reason: string;
  tradeTime: string;
  shares: number;
}

interface CandleData {
  candleTime: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  boardSig: string | null;
  bpr: number;
}

interface DayMetrics {
  date: string;
  symbols: string[];
  symbolChanges: Record<string, number>; // symbol -> % change from open
  medianChange: number;
  upRatio: number; // up / down ratio
  pctAboveHalf: number; // % of symbols with +0.5% or more
  isUpDay: boolean;
}

async function computeDayMetrics(db: any, date: string): Promise<DayMetrics> {
  // Get all symbols with data on this date
  const [symRows] = await db.execute(sql`
    SELECT DISTINCT symbol FROM rt_candles WHERE tradeDate = ${date}
  `);
  const symbols = (symRows as any[]).map((r: any) => r.symbol);
  
  const symbolChanges: Record<string, number> = {};
  
  for (const sym of symbols) {
    // Get first and latest candle to compute intraday change
    const [first] = await db.execute(sql`
      SELECT open FROM rt_candles 
      WHERE tradeDate = ${date} AND symbol = ${sym} AND volume > 0
      ORDER BY candleTime ASC LIMIT 1
    `);
    const [latest] = await db.execute(sql`
      SELECT close, candleTime FROM rt_candles 
      WHERE tradeDate = ${date} AND symbol = ${sym}
      ORDER BY candleTime DESC LIMIT 1
    `);
    
    if ((first as any[]).length > 0 && (latest as any[]).length > 0) {
      const openPrice = Number((first as any[])[0].open);
      const closePrice = Number((latest as any[])[0].close);
      if (openPrice > 0) {
        symbolChanges[sym] = (closePrice - openPrice) / openPrice * 100;
      }
    }
  }
  
  const changes = Object.values(symbolChanges);
  if (changes.length === 0) {
    return { date, symbols, symbolChanges, medianChange: 0, upRatio: 0, pctAboveHalf: 0, isUpDay: false };
  }
  
  changes.sort((a, b) => a - b);
  const medianChange = changes[Math.floor(changes.length / 2)];
  const upCount = changes.filter(c => c > 0).length;
  const downCount = changes.filter(c => c < 0).length;
  const upRatio = downCount > 0 ? upCount / downCount : upCount > 0 ? 99 : 0;
  const pctAboveHalf = changes.filter(c => c >= 0.5).length / changes.length;
  
  // Up day criteria (any one of these)
  const isUpDay = (
    pctAboveHalf >= 0.6 ||          // 60%以上が+0.5%以上
    upRatio >= 2.0 ||                // 上昇/下落 >= 2.0
    medianChange >= 0.5              // 中央値 >= +0.5%
  );
  
  return { date, symbols, symbolChanges, medianChange, upRatio, pctAboveHalf, isUpDay };
}

// Compute metrics at a specific time (for intraday detection)
async function computeIntradayMetrics(db: any, date: string, byTime: string): Promise<DayMetrics> {
  const [symRows] = await db.execute(sql`
    SELECT DISTINCT symbol FROM rt_candles WHERE tradeDate = ${date}
  `);
  const symbols = (symRows as any[]).map((r: any) => r.symbol);
  
  const symbolChanges: Record<string, number> = {};
  
  for (const sym of symbols) {
    const [first] = await db.execute(sql`
      SELECT open FROM rt_candles 
      WHERE tradeDate = ${date} AND symbol = ${sym} AND volume > 0
      ORDER BY candleTime ASC LIMIT 1
    `);
    const [atTime] = await db.execute(sql`
      SELECT close FROM rt_candles 
      WHERE tradeDate = ${date} AND symbol = ${sym} AND candleTime <= ${byTime}
      ORDER BY candleTime DESC LIMIT 1
    `);
    
    if ((first as any[]).length > 0 && (atTime as any[]).length > 0) {
      const openPrice = Number((first as any[])[0].open);
      const currentPrice = Number((atTime as any[])[0].close);
      if (openPrice > 0) {
        symbolChanges[sym] = (currentPrice - openPrice) / openPrice * 100;
      }
    }
  }
  
  const changes = Object.values(symbolChanges);
  if (changes.length === 0) {
    return { date, symbols, symbolChanges, medianChange: 0, upRatio: 0, pctAboveHalf: 0, isUpDay: false };
  }
  
  changes.sort((a, b) => a - b);
  const medianChange = changes[Math.floor(changes.length / 2)];
  const upCount = changes.filter(c => c > 0).length;
  const downCount = changes.filter(c => c < 0).length;
  const upRatio = downCount > 0 ? upCount / downCount : upCount > 0 ? 99 : 0;
  const pctAboveHalf = changes.filter(c => c >= 0.5).length / changes.length;
  
  const isUpDay = (
    pctAboveHalf >= 0.6 ||
    upRatio >= 2.0 ||
    medianChange >= 0.5
  );
  
  return { date, symbols, symbolChanges, medianChange, upRatio, pctAboveHalf, isUpDay };
}

async function main() {
  const db = await getDb();
  
  // Get all trades
  const [tradeRows] = await db.execute(sql`
    SELECT id, tradeDate, symbol, side, action, price, pnl, reason, tradeTime, shares
    FROM rt_trades
    WHERE tradeDate >= '2026-06-17' AND tradeDate <= '2026-06-30'
    ORDER BY tradeDate ASC, tradeTime ASC
  `);
  
  // Group trades into entry/exit pairs
  interface TradePair {
    date: string;
    symbol: string;
    side: string;
    entryTime: string;
    entryPrice: number;
    exitTime: string;
    exitPrice: number;
    pnl: number;
    reason: string;
    shares: number;
  }
  
  const pairs: TradePair[] = [];
  const trades = tradeRows as any[];
  
  // Pair up entry and exit trades
  const pendingEntries: Record<string, any> = {};
  for (const t of trades) {
    const key = `${t.tradeDate}_${t.symbol}_${t.side}`;
    if (t.action === 'short' || t.action === 'buy') {
      // Entry
      pendingEntries[key] = t;
    } else {
      // Exit (cover or sell)
      const entry = pendingEntries[key];
      if (entry) {
        const entryPrice = Number(entry.price);
        const exitPrice = Number(t.price);
        const pnl = Number(t.pnl);
        pairs.push({
          date: t.tradeDate,
          symbol: t.symbol,
          side: t.side,
          entryTime: entry.tradeTime,
          entryPrice,
          exitTime: t.tradeTime,
          exitPrice,
          pnl,
          reason: entry.reason || '',
          shares: Number(entry.shares),
        });
        delete pendingEntries[key];
      }
    }
  }
  
  console.log(`=== 既存トレードペア: ${pairs.length}件 ===\n`);
  
  // Baseline
  const baselinePnl = pairs.reduce((s, p) => s + p.pnl, 0);
  const baselineWins = pairs.filter(p => p.pnl > 0).length;
  console.log(`ベースライン: ${pairs.length}件 | 勝率${baselineWins}/${pairs.length} | 総損益${baselinePnl >= 0 ? '+' : ''}${baselinePnl.toLocaleString()}円`);
  
  // ============ IMPROVEMENT 1: 上昇日SHORT抑制 ============
  console.log('\n\n========================================');
  console.log('【改善1】上昇日SHORT抑制フィルター');
  console.log('========================================\n');
  
  // Compute day metrics for each trading date
  const dates = [...new Set(pairs.map(p => p.date))].sort();
  const dayMetricsCache: Record<string, DayMetrics> = {};
  
  for (const date of dates) {
    // Use metrics at 09:30 for early detection
    const metrics = await computeIntradayMetrics(db, date, '09:30');
    dayMetricsCache[date] = metrics;
    console.log(`  ${date}: median=${metrics.medianChange.toFixed(2)}% upRatio=${metrics.upRatio.toFixed(1)} pct>=0.5%=${(metrics.pctAboveHalf*100).toFixed(0)}% → ${metrics.isUpDay ? '【上昇日】' : '通常'}`);
  }
  
  // Also compute at entry time for more accurate detection
  console.log('\n  --- エントリー時点での判定 ---');
  
  interface Improvement1Result {
    pair: TradePair;
    blocked: boolean;
    halfLot: boolean;
    exception: boolean;
    exceptionReason: string;
    adjustedPnl: number;
    metricsAtEntry: DayMetrics;
  }
  
  const imp1Results: Improvement1Result[] = [];
  
  for (const pair of pairs) {
    if (pair.side !== 'short') {
      imp1Results.push({ pair, blocked: false, halfLot: false, exception: false, exceptionReason: '', adjustedPnl: pair.pnl, metricsAtEntry: dayMetricsCache[pair.date] });
      continue;
    }
    
    // Compute metrics at entry time
    const metrics = await computeIntradayMetrics(db, pair.date, pair.entryTime);
    
    let blocked = false;
    let halfLot = false;
    let exception = false;
    let exceptionReason = '';
    let adjustedPnl = pair.pnl;
    
    if (metrics.isUpDay) {
      // Check exception: individual stock in downtrend + board sell pressure
      const [boardAtEntry] = await db.execute(sql`
        SELECT JSON_EXTRACT(boardSnapshot, '$.signal') as boardSig
        FROM rt_candles
        WHERE tradeDate = ${pair.date} AND symbol = ${pair.symbol} AND candleTime = ${pair.entryTime}
        LIMIT 1
      `);
      const boardSig = (boardAtEntry as any[])[0]?.boardSig?.replace(/"/g, '') || '';
      const symbolChange = metrics.symbolChanges[pair.symbol] || 0;
      
      if (symbolChange < -0.3 && boardSig === 'sell_pressure') {
        exception = true;
        exceptionReason = `個別下落(${symbolChange.toFixed(1)}%) + sell_pressure`;
      } else {
        // Block or half lot
        blocked = true; // Full block mode
        adjustedPnl = 0;
      }
    }
    
    imp1Results.push({ pair, blocked, halfLot, exception, exceptionReason, adjustedPnl, metricsAtEntry: metrics });
  }
  
  // Results for Improvement 1
  const imp1Blocked = imp1Results.filter(r => r.blocked);
  const imp1Active = imp1Results.filter(r => !r.blocked);
  const imp1Pnl = imp1Results.reduce((s, r) => s + r.adjustedPnl, 0);
  
  console.log(`\n  ブロックされたSHORT: ${imp1Blocked.length}件`);
  for (const r of imp1Blocked) {
    console.log(`    ${r.pair.date} ${r.pair.symbol} ${r.pair.entryTime} | 元損益${r.pair.pnl >= 0 ? '+' : ''}${r.pair.pnl.toLocaleString()}円 → ブロック | median=${r.metricsAtEntry.medianChange.toFixed(2)}% upRatio=${r.metricsAtEntry.upRatio.toFixed(1)}`);
  }
  const imp1Exceptions = imp1Results.filter(r => r.exception);
  if (imp1Exceptions.length > 0) {
    console.log(`  例外許可: ${imp1Exceptions.length}件`);
    for (const r of imp1Exceptions) {
      console.log(`    ${r.pair.date} ${r.pair.symbol} ${r.pair.entryTime} | ${r.exceptionReason}`);
    }
  }
  
  console.log(`\n  【改善1結果】`);
  console.log(`    ベースライン: ${baselinePnl >= 0 ? '+' : ''}${baselinePnl.toLocaleString()}円`);
  console.log(`    改善後: ${imp1Pnl >= 0 ? '+' : ''}${imp1Pnl.toLocaleString()}円`);
  console.log(`    差分: ${(imp1Pnl - baselinePnl) >= 0 ? '+' : ''}${(imp1Pnl - baselinePnl).toLocaleString()}円`);
  
  // Also test half-lot mode
  let imp1HalfPnl = 0;
  for (const r of imp1Results) {
    if (r.blocked) {
      imp1HalfPnl += Math.round(r.pair.pnl * 0.5); // half lot
    } else {
      imp1HalfPnl += r.pair.pnl;
    }
  }
  console.log(`    半ロットモード: ${imp1HalfPnl >= 0 ? '+' : ''}${imp1HalfPnl.toLocaleString()}円 (差分: ${(imp1HalfPnl - baselinePnl) >= 0 ? '+' : ''}${(imp1HalfPnl - baselinePnl).toLocaleString()}円)`);
  
  // ============ IMPROVEMENT 2: VWAP急落フィルター ============
  console.log('\n\n========================================');
  console.log('【改善2】VWAPクロス下抜けSHORT急落フィルター');
  console.log('========================================\n');
  
  interface Improvement2Result {
    pair: TradePair;
    isVwapShort: boolean;
    recentDrop3: number;
    recentDrop5: number;
    volumeRatio: number;
    blocked3: boolean;
    blocked5: boolean;
    blocked5_10: boolean;
    blockedVolume: boolean;
  }
  
  const imp2Results: Improvement2Result[] = [];
  
  for (const pair of pairs) {
    const isVwapShort = pair.side === 'short' && pair.reason.includes('VWAP') && pair.reason.includes('下抜');
    
    if (!isVwapShort) {
      imp2Results.push({ pair, isVwapShort: false, recentDrop3: 0, recentDrop5: 0, volumeRatio: 0, blocked3: false, blocked5: false, blocked5_10: false, blockedVolume: false });
      continue;
    }
    
    // Get candles before entry
    const [candles] = await db.execute(sql`
      SELECT candleTime, open, high, low, close, volume
      FROM rt_candles
      WHERE tradeDate = ${pair.date} AND symbol = ${pair.symbol} AND candleTime <= ${pair.entryTime}
      ORDER BY candleTime DESC
      LIMIT 10
    `);
    const cs = (candles as any[]).reverse();
    
    let recentDrop3 = 0, recentDrop5 = 0, volumeRatio = 0;
    
    if (cs.length >= 4) {
      const ref3 = Number(cs[cs.length - 4].close);
      const cur = Number(cs[cs.length - 1].close);
      recentDrop3 = (cur - ref3) / ref3 * 100;
    }
    if (cs.length >= 6) {
      const ref5 = Number(cs[cs.length - 6].close);
      const cur = Number(cs[cs.length - 1].close);
      recentDrop5 = (cur - ref5) / ref5 * 100;
    }
    
    // Volume ratio: current bar vs average of previous 20
    const [volBars] = await db.execute(sql`
      SELECT volume FROM rt_candles
      WHERE tradeDate = ${pair.date} AND symbol = ${pair.symbol} AND candleTime < ${pair.entryTime} AND volume > 0
      ORDER BY candleTime DESC LIMIT 20
    `);
    const vols = (volBars as any[]).map((r: any) => Number(r.volume));
    if (vols.length > 1) {
      const avgVol = vols.slice(1).reduce((s: number, v: number) => s + v, 0) / (vols.length - 1);
      volumeRatio = avgVol > 0 ? vols[0] / avgVol : 0;
    }
    
    const blocked3 = recentDrop3 <= -0.6;
    const blocked5 = recentDrop5 <= -0.8;
    const blocked5_10 = recentDrop5 <= -1.0;
    const blockedVolume = volumeRatio >= 2.0 && recentDrop3 <= -0.5;
    
    imp2Results.push({ pair, isVwapShort: true, recentDrop3, recentDrop5, volumeRatio, blocked3, blocked5, blocked5_10, blockedVolume });
  }
  
  const vwapShorts = imp2Results.filter(r => r.isVwapShort);
  console.log(`  VWAPクロス下抜けSHORT: ${vwapShorts.length}件\n`);
  
  for (const r of vwapShorts) {
    console.log(`  ${r.pair.date} ${r.pair.symbol} ${r.pair.entryTime} | pnl=${r.pair.pnl >= 0 ? '+' : ''}${r.pair.pnl.toLocaleString()}円 | drop3=${r.recentDrop3.toFixed(2)}% drop5=${r.recentDrop5.toFixed(2)}% volR=${r.volumeRatio.toFixed(1)} | block3=${r.blocked3} block5=${r.blocked5} block5_10=${r.blocked5_10} blockVol=${r.blockedVolume}`);
  }
  
  // Calculate PnL for each filter variant
  const variants = [
    { name: '3本-0.6%', key: 'blocked3' as const },
    { name: '5本-0.8%', key: 'blocked5' as const },
    { name: '5本-1.0%', key: 'blocked5_10' as const },
    { name: '出来高2x+陰線', key: 'blockedVolume' as const },
  ];
  
  console.log('\n  --- フィルター別効果 ---');
  for (const v of variants) {
    const blockedTrades = vwapShorts.filter(r => r[v.key]);
    const savedLoss = blockedTrades.filter(r => r.pair.pnl < 0).reduce((s, r) => s + Math.abs(r.pair.pnl), 0);
    const missedProfit = blockedTrades.filter(r => r.pair.pnl > 0).reduce((s, r) => s + r.pair.pnl, 0);
    const netEffect = savedLoss - missedProfit;
    console.log(`  ${v.name}: ブロック${blockedTrades.length}件 | 回避損失+${savedLoss.toLocaleString()}円 | 逃した利益-${missedProfit.toLocaleString()}円 | 純効果${netEffect >= 0 ? '+' : ''}${netEffect.toLocaleString()}円`);
  }
  
  // ============ IMPROVEMENT 3: BEストップ ============
  console.log('\n\n========================================');
  console.log('【改善3】固定0.5%ブレイクイーブンストップ');
  console.log('========================================\n');
  
  interface Improvement3Result {
    pair: TradePair;
    beTriggered: boolean;
    beTriggerTime: string;
    beExitTime: string;
    maxProfitAfterBE: number;
    adjustedPnl: number;
    wouldHitTPWithoutBE: boolean;
    wouldHitSLWithoutBE: boolean;
    originalPnl: number;
  }
  
  const imp3Results: Improvement3Result[] = [];
  
  for (const pair of pairs) {
    // Get all candles from entry to end of day
    const [candles] = await db.execute(sql`
      SELECT candleTime, open, high, low, close
      FROM rt_candles
      WHERE tradeDate = ${pair.date} AND symbol = ${pair.symbol} AND candleTime >= ${pair.entryTime}
      ORDER BY candleTime ASC
    `);
    const cs = candles as any[];
    
    let beTriggered = false;
    let beTriggerTime = '';
    let beExitTime = '';
    let maxProfitAfterBE = 0;
    let adjustedPnl = pair.pnl;
    
    const entryPrice = pair.entryPrice;
    const beTriggerLevel = pair.side === 'short' 
      ? entryPrice * (1 - 0.005) // SHORT: price drops 0.5%
      : entryPrice * (1 + 0.005); // LONG: price rises 0.5%
    
    for (let i = 0; i < cs.length; i++) {
      const c = cs[i];
      const high = Number(c.high);
      const low = Number(c.low);
      
      if (!beTriggered) {
        // Check if BE trigger hit
        if (pair.side === 'short' && low <= beTriggerLevel) {
          beTriggered = true;
          beTriggerTime = c.candleTime;
        } else if (pair.side === 'long' && high >= beTriggerLevel) {
          beTriggered = true;
          beTriggerTime = c.candleTime;
        }
      } else {
        // BE is active - check if price returns to entry (exit at breakeven)
        if (pair.side === 'short') {
          const profitFromEntry = (entryPrice - low) / entryPrice * 100;
          if (profitFromEntry > maxProfitAfterBE) maxProfitAfterBE = profitFromEntry;
          
          if (high >= entryPrice) {
            // Hit breakeven stop
            beExitTime = c.candleTime;
            adjustedPnl = 0; // Exit at breakeven
            break;
          }
        } else {
          const profitFromEntry = (high - entryPrice) / entryPrice * 100;
          if (profitFromEntry > maxProfitAfterBE) maxProfitAfterBE = profitFromEntry;
          
          if (low <= entryPrice) {
            beExitTime = c.candleTime;
            adjustedPnl = 0;
            break;
          }
        }
      }
    }
    
    // If BE triggered but never hit breakeven, use original exit
    if (beTriggered && beExitTime === '') {
      // The trade continued to TP or SL as normal
      adjustedPnl = pair.pnl;
    }
    
    imp3Results.push({
      pair,
      beTriggered,
      beTriggerTime,
      beExitTime,
      maxProfitAfterBE,
      adjustedPnl,
      wouldHitTPWithoutBE: pair.pnl > 0,
      wouldHitSLWithoutBE: pair.pnl < 0,
      originalPnl: pair.pnl,
    });
  }
  
  console.log('  トレード別BE分析:');
  for (const r of imp3Results) {
    const beStatus = r.beTriggered 
      ? (r.beExitTime ? `BE決済@${r.beExitTime}` : `BEトリガー@${r.beTriggerTime}→TP/SL到達`)
      : 'BEなし(+0.5%未到達)';
    const pnlChange = r.adjustedPnl - r.originalPnl;
    console.log(`  ${r.pair.date} ${r.pair.symbol} ${r.pair.side} | 元${r.originalPnl >= 0 ? '+' : ''}${r.originalPnl.toLocaleString()}円 → BE後${r.adjustedPnl >= 0 ? '+' : ''}${r.adjustedPnl.toLocaleString()}円 (${pnlChange >= 0 ? '+' : ''}${pnlChange.toLocaleString()}) | ${beStatus} | maxProfit=${r.maxProfitAfterBE.toFixed(2)}%`);
  }
  
  const imp3Pnl = imp3Results.reduce((s, r) => s + r.adjustedPnl, 0);
  const beTriggeredCount = imp3Results.filter(r => r.beTriggered).length;
  const beExitCount = imp3Results.filter(r => r.beExitTime !== '').length;
  
  console.log(`\n  【改善3結果】`);
  console.log(`    BEトリガー発動: ${beTriggeredCount}/${pairs.length}件`);
  console.log(`    BE決済(建値撤退): ${beExitCount}件`);
  console.log(`    ベースライン: ${baselinePnl >= 0 ? '+' : ''}${baselinePnl.toLocaleString()}円`);
  console.log(`    改善後: ${imp3Pnl >= 0 ? '+' : ''}${imp3Pnl.toLocaleString()}円`);
  console.log(`    差分: ${(imp3Pnl - baselinePnl) >= 0 ? '+' : ''}${(imp3Pnl - baselinePnl).toLocaleString()}円`);
  
  // ============ COMBINED RESULTS ============
  console.log('\n\n========================================');
  console.log('【全改善組み合わせ】');
  console.log('========================================\n');
  
  // Apply all 3 improvements together
  let combinedPnl = 0;
  const combinedDetails: string[] = [];
  
  for (const pair of pairs) {
    let pnl = pair.pnl;
    let status = '';
    
    // Improvement 1: Up day SHORT block
    const imp1 = imp1Results.find(r => r.pair === pair);
    if (imp1?.blocked) {
      pnl = 0;
      status = '[上昇日ブロック]';
      combinedPnl += 0;
      combinedDetails.push(`  ${pair.date} ${pair.symbol} ${pair.side} ${pair.entryTime} | 元${pair.pnl >= 0 ? '+' : ''}${pair.pnl.toLocaleString()}円 → 0円 ${status}`);
      continue;
    }
    
    // Improvement 2: VWAP drop filter (using 5bar -0.8% variant)
    const imp2 = imp2Results.find(r => r.pair === pair);
    if (imp2?.isVwapShort && imp2.blocked5) {
      pnl = 0;
      status = '[VWAP急落ブロック]';
      combinedPnl += 0;
      combinedDetails.push(`  ${pair.date} ${pair.symbol} ${pair.side} ${pair.entryTime} | 元${pair.pnl >= 0 ? '+' : ''}${pair.pnl.toLocaleString()}円 → 0円 ${status}`);
      continue;
    }
    
    // Improvement 3: BE stop
    const imp3 = imp3Results.find(r => r.pair === pair);
    if (imp3 && imp3.beExitTime !== '') {
      pnl = imp3.adjustedPnl;
      status = '[BE決済]';
    }
    
    combinedPnl += pnl;
    if (status) {
      combinedDetails.push(`  ${pair.date} ${pair.symbol} ${pair.side} ${pair.entryTime} | 元${pair.pnl >= 0 ? '+' : ''}${pair.pnl.toLocaleString()}円 → ${pnl >= 0 ? '+' : ''}${pnl.toLocaleString()}円 ${status}`);
    }
  }
  
  console.log('  変更があったトレード:');
  for (const d of combinedDetails) console.log(d);
  
  console.log(`\n  【組み合わせ結果】`);
  console.log(`    ベースライン: ${baselinePnl >= 0 ? '+' : ''}${baselinePnl.toLocaleString()}円`);
  console.log(`    全改善適用後: ${combinedPnl >= 0 ? '+' : ''}${combinedPnl.toLocaleString()}円`);
  console.log(`    改善額: ${(combinedPnl - baselinePnl) >= 0 ? '+' : ''}${(combinedPnl - baselinePnl).toLocaleString()}円`);
  console.log(`    改善率: ${baselinePnl !== 0 ? ((combinedPnl - baselinePnl) / Math.abs(baselinePnl) * 100).toFixed(1) : 'N/A'}%`);
  
  // Daily breakdown
  console.log('\n  --- 日別比較 ---');
  console.log('  日付       | ベースライン | 改善後    | 差分');
  for (const date of dates) {
    const dayBase = pairs.filter(p => p.date === date).reduce((s, p) => s + p.pnl, 0);
    
    let dayImproved = 0;
    for (const pair of pairs.filter(p => p.date === date)) {
      const imp1 = imp1Results.find(r => r.pair === pair);
      if (imp1?.blocked) { continue; }
      const imp2 = imp2Results.find(r => r.pair === pair);
      if (imp2?.isVwapShort && imp2.blocked5) { continue; }
      const imp3 = imp3Results.find(r => r.pair === pair);
      if (imp3 && imp3.beExitTime !== '') { dayImproved += imp3.adjustedPnl; continue; }
      dayImproved += pair.pnl;
    }
    
    const diff = dayImproved - dayBase;
    console.log(`  ${date} | ${dayBase >= 0 ? '+' : ''}${dayBase.toLocaleString().padStart(9)}円 | ${dayImproved >= 0 ? '+' : ''}${dayImproved.toLocaleString().padStart(9)}円 | ${diff >= 0 ? '+' : ''}${diff.toLocaleString().padStart(8)}円`);
  }
  
  process.exit(0);
}

main();
