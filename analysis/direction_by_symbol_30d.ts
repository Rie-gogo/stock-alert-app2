/**
 * 30日間シミュレーション: 銘柄別方向正解率分析
 * 
 * 方向正解の定義:
 * - MFE（最大有利方向変動）が一定以上 → エントリー方向に動いた
 * - 引けまでにエントリー方向に動いた（引け値ベース）
 */

import { getDb } from '../server/db';
import { sql } from 'drizzle-orm';

const EXCLUDED = new Set(['6920', '6758', '9984', '7011', '9107', '8306', '4568', '5016', '7203', '3778', '3436', '6723']);

async function main() {
  const db = await getDb();
  
  // Get last 30 trade dates
  const datesRes = await db.execute(sql.raw(
    `SELECT DISTINCT tradeDate FROM rt_candles ORDER BY tradeDate DESC LIMIT 30`
  ));
  const dates = (datesRes as any)[0].map((r: any) => r.tradeDate).reverse();
  
  // Get all trades in this period
  const tradesRes = await db.execute(sql.raw(
    `SELECT * FROM rt_trades WHERE tradeDate >= '${dates[0]}' ORDER BY tradeDate, tradeTime`
  ));
  const allTrades = (tradesRes as any)[0] || [];
  
  // Pair entries with exits
  interface TradePair {
    symbol: string;
    date: string;
    side: string;
    entryPrice: number;
    exitPrice: number;
    shares: number;
    pnl: number;
    entryTime: string;
    exitTime: string;
    reason: string;
    exitReason: string;
  }
  
  const pairs: TradePair[] = [];
  const processed = new Set<number>();
  
  for (let i = 0; i < allTrades.length; i++) {
    if (processed.has(i)) continue;
    const t = allTrades[i];
    if (t.action !== 'buy' && t.action !== 'short') continue;
    if (EXCLUDED.has(t.symbol)) continue;
    
    for (let j = i + 1; j < allTrades.length; j++) {
      if (processed.has(j)) continue;
      const e = allTrades[j];
      if (e.symbol === t.symbol && e.tradeDate === t.tradeDate && 
          (e.action === 'sell' || e.action === 'cover') && e.pnl !== null) {
        pairs.push({
          symbol: t.symbol,
          date: t.tradeDate,
          side: t.side,
          entryPrice: Number(t.price),
          exitPrice: Number(e.price),
          shares: Number(t.shares),
          pnl: Number(e.pnl),
          entryTime: t.tradeTime,
          exitTime: e.tradeTime,
          reason: t.reason || '',
          exitReason: e.reason || '',
        });
        processed.add(j);
        break;
      }
    }
  }
  
  console.log(`${'='.repeat(80)}`);
  console.log(`  30日間シミュレーション: 銘柄別方向正解率分析`);
  console.log(`  期間: ${dates[0]} 〜 ${dates[dates.length - 1]}`);
  console.log(`  対象: ${pairs.length}件（除外銘柄を除く）`);
  console.log(`${'='.repeat(80)}`);
  
  // For each trade, calculate MFE (Maximum Favorable Excursion) and direction correctness
  interface TradeWithMFE extends TradePair {
    mfe: number;  // % - 最大有利方向変動
    mae: number;  // % - 最大不利方向変動
    eodPnlPct: number; // % - 引け値ベースの損益率
    directionCorrect: boolean; // MFE >= 0.5% (方向は合っていた)
    directionStrongCorrect: boolean; // MFE >= 1.0% (方向が明確に合っていた)
    tpReached: boolean; // MFE >= 1.5% (TP到達可能だった)
  }
  
  const results: TradeWithMFE[] = [];
  
  for (const pair of pairs) {
    // Get candles from entry to end of day
    const candlesRes = await db.execute(sql.raw(
      `SELECT candleTime, open, high, low, close FROM rt_candles 
       WHERE tradeDate = '${pair.date}' AND symbol = '${pair.symbol}' 
       AND candleTime > '${pair.entryTime}'
       ORDER BY candleTime`
    ));
    const candles = (candlesRes as any)[0] || [];
    
    let mfe = 0, mae = 0;
    for (const c of candles) {
      if (pair.side === 'long') {
        const profit = (Number(c.high) - pair.entryPrice) / pair.entryPrice * 100;
        const loss = (pair.entryPrice - Number(c.low)) / pair.entryPrice * 100;
        mfe = Math.max(mfe, profit);
        mae = Math.max(mae, loss);
      } else {
        const profit = (pair.entryPrice - Number(c.low)) / pair.entryPrice * 100;
        const loss = (Number(c.high) - pair.entryPrice) / pair.entryPrice * 100;
        mfe = Math.max(mfe, profit);
        mae = Math.max(mae, loss);
      }
    }
    
    // EOD PnL (last candle close vs entry)
    const lastCandle = candles.length > 0 ? candles[candles.length - 1] : null;
    let eodPnlPct = 0;
    if (lastCandle) {
      if (pair.side === 'long') {
        eodPnlPct = (Number(lastCandle.close) - pair.entryPrice) / pair.entryPrice * 100;
      } else {
        eodPnlPct = (pair.entryPrice - Number(lastCandle.close)) / pair.entryPrice * 100;
      }
    }
    
    results.push({
      ...pair,
      mfe,
      mae,
      eodPnlPct,
      directionCorrect: mfe >= 0.5,
      directionStrongCorrect: mfe >= 1.0,
      tpReached: mfe >= 1.5,
    });
  }
  
  // ========== 銘柄別方向正解率 ==========
  console.log(`\n${'─'.repeat(80)}`);
  console.log(`  銘柄別方向正解率（MFE基準）`);
  console.log(`${'─'.repeat(80)}`);
  console.log(`  方向正解 = エントリー後にMFE(最大有利変動)が0.5%以上到達`);
  console.log(`  強い正解 = MFE 1.0%以上到達`);
  console.log(`  TP到達可能 = MFE 1.5%以上到達（利確ラインに届いた）\n`);
  
  // Group by symbol
  const bySymbol: Record<string, TradeWithMFE[]> = {};
  for (const r of results) {
    if (!bySymbol[r.symbol]) bySymbol[r.symbol] = [];
    bySymbol[r.symbol].push(r);
  }
  
  interface SymbolDirectionStats {
    symbol: string;
    count: number;
    dirCorrect: number;
    dirCorrectRate: number;
    strongCorrect: number;
    strongCorrectRate: number;
    tpReached: number;
    tpReachedRate: number;
    avgMfe: number;
    avgMae: number;
    mfeOverMae: number;
    totalPnl: number;
  }
  
  const symbolStats: SymbolDirectionStats[] = [];
  
  for (const [sym, trades] of Object.entries(bySymbol)) {
    const dirCorrect = trades.filter(t => t.directionCorrect).length;
    const strongCorrect = trades.filter(t => t.directionStrongCorrect).length;
    const tpReached = trades.filter(t => t.tpReached).length;
    const avgMfe = trades.reduce((s, t) => s + t.mfe, 0) / trades.length;
    const avgMae = trades.reduce((s, t) => s + t.mae, 0) / trades.length;
    const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
    
    symbolStats.push({
      symbol: sym,
      count: trades.length,
      dirCorrect,
      dirCorrectRate: dirCorrect / trades.length * 100,
      strongCorrect,
      strongCorrectRate: strongCorrect / trades.length * 100,
      tpReached,
      tpReachedRate: tpReached / trades.length * 100,
      avgMfe,
      avgMae,
      mfeOverMae: avgMae > 0 ? avgMfe / avgMae : Infinity,
      totalPnl,
    });
  }
  
  // Sort by direction correct rate
  symbolStats.sort((a, b) => b.dirCorrectRate - a.dirCorrectRate);
  
  console.log(`  銘柄    | 件数 | 方向正解  | 強い正解  | TP到達可能 | 平均MFE | 平均MAE | MFE/MAE | 総PnL`);
  console.log(`  ${'─'.repeat(95)}`);
  
  for (const s of symbolStats) {
    const pnlStr = s.totalPnl >= 0 ? `+${s.totalPnl.toLocaleString()}` : s.totalPnl.toLocaleString();
    console.log(
      `  ${s.symbol.padEnd(7)} | ${String(s.count).padStart(4)} | ` +
      `${s.dirCorrect}/${s.count} ${s.dirCorrectRate.toFixed(0).padStart(3)}% | ` +
      `${s.strongCorrect}/${s.count} ${s.strongCorrectRate.toFixed(0).padStart(3)}% | ` +
      `${s.tpReached}/${s.count} ${s.tpReachedRate.toFixed(0).padStart(4)}% | ` +
      `${s.avgMfe.toFixed(2).padStart(6)}% | ${s.avgMae.toFixed(2).padStart(6)}% | ` +
      `${s.mfeOverMae.toFixed(2).padStart(5)} | ${pnlStr.padStart(10)}円`
    );
  }
  
  // ========== 全体サマリー ==========
  const totalDirCorrect = results.filter(r => r.directionCorrect).length;
  const totalStrongCorrect = results.filter(r => r.directionStrongCorrect).length;
  const totalTpReached = results.filter(r => r.tpReached).length;
  
  console.log(`  ${'─'.repeat(95)}`);
  console.log(`  全体    | ${String(results.length).padStart(4)} | ${totalDirCorrect}/${results.length} ${(totalDirCorrect / results.length * 100).toFixed(0).padStart(3)}% | ${totalStrongCorrect}/${results.length} ${(totalStrongCorrect / results.length * 100).toFixed(0).padStart(3)}% | ${totalTpReached}/${results.length} ${(totalTpReached / results.length * 100).toFixed(0).padStart(4)}%`);
  
  // ========== 方向別の正解率 ==========
  console.log(`\n${'─'.repeat(80)}`);
  console.log(`  方向別の正解率`);
  console.log(`${'─'.repeat(80)}`);
  
  const longs = results.filter(r => r.side === 'long');
  const shorts = results.filter(r => r.side === 'short');
  
  const longDirCorrect = longs.filter(r => r.directionCorrect).length;
  const shortDirCorrect = shorts.filter(r => r.directionCorrect).length;
  const longTpReached = longs.filter(r => r.tpReached).length;
  const shortTpReached = shorts.filter(r => r.tpReached).length;
  
  console.log(`  LONG:  ${longs.length}件 | 方向正解: ${longDirCorrect}/${longs.length} (${(longDirCorrect / longs.length * 100).toFixed(1)}%) | TP到達可能: ${longTpReached}/${longs.length} (${(longTpReached / longs.length * 100).toFixed(1)}%)`);
  console.log(`  SHORT: ${shorts.length}件 | 方向正解: ${shortDirCorrect}/${shorts.length} (${(shortDirCorrect / shorts.length * 100).toFixed(1)}%) | TP到達可能: ${shortTpReached}/${shorts.length} (${(shortTpReached / shorts.length * 100).toFixed(1)}%)`);
  
  // ========== 方向不正解トレードの詳細（銘柄別） ==========
  console.log(`\n${'─'.repeat(80)}`);
  console.log(`  方向不正解トレード（MFE < 0.5%）の内訳`);
  console.log(`${'─'.repeat(80)}`);
  
  const wrongDir = results.filter(r => !r.directionCorrect);
  const wrongBySymbol: Record<string, number> = {};
  for (const r of wrongDir) {
    wrongBySymbol[r.symbol] = (wrongBySymbol[r.symbol] || 0) + 1;
  }
  
  console.log(`  銘柄    | 方向不正解件数 | 全件数 | 不正解率`);
  console.log(`  ${'─'.repeat(50)}`);
  for (const [sym, count] of Object.entries(wrongBySymbol).sort((a, b) => b[1] - a[1])) {
    const total = bySymbol[sym].length;
    console.log(`  ${sym.padEnd(7)} | ${String(count).padStart(5)}件 | ${String(total).padStart(4)}件 | ${((count / total) * 100).toFixed(1)}%`);
  }
  
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
