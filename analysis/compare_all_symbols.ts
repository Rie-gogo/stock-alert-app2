import { getDb } from '../server/db';
import { sql } from 'drizzle-orm';

/**
 * ① 全10銘柄の成績比較
 * ② データ取得中の非対象銘柄の確認
 */

async function main() {
  const db = await getDb();
  
  // ========== ① 全10銘柄の成績比較 ==========
  console.log(`${'='.repeat(80)}`);
  console.log(`  ① 全10銘柄の成績比較`);
  console.log(`${'='.repeat(80)}`);
  
  // Get all trades grouped by symbol
  const tradesRes = await db.execute(sql.raw(
    `SELECT symbol, symbolName, side, action, price, shares, pnl, tradeDate, tradeTime, reason, boardSignal
     FROM rt_trades ORDER BY tradeDate, tradeTime`
  ));
  const allTrades = (tradesRes as any)[0] || [];
  
  // Pair entries with exits
  interface TradePair {
    symbol: string;
    name: string;
    date: string;
    side: string;
    entryPrice: number;
    shares: number;
    pnl: number;
    entryTime: string;
    exitTime: string;
    reason: string;
    boardSignal: string;
  }
  
  const pairs: TradePair[] = [];
  const processed = new Set<number>();
  
  for (let i = 0; i < allTrades.length; i++) {
    if (processed.has(i)) continue;
    const t = allTrades[i];
    if (t.action !== 'buy' && t.action !== 'short') continue;
    
    for (let j = i + 1; j < allTrades.length; j++) {
      if (processed.has(j)) continue;
      const e = allTrades[j];
      if (e.symbol === t.symbol && e.tradeDate === t.tradeDate && 
          (e.action === 'sell' || e.action === 'cover') && e.pnl !== null) {
        pairs.push({
          symbol: t.symbol,
          name: t.symbolName,
          date: t.tradeDate,
          side: t.side,
          entryPrice: Number(t.price),
          shares: Number(t.shares),
          pnl: Number(e.pnl),
          entryTime: t.tradeTime,
          exitTime: e.tradeTime,
          reason: t.reason,
          boardSignal: t.boardSignal || 'unknown',
        });
        processed.add(j);
        break;
      }
    }
  }
  
  // Group by symbol
  const bySymbol: Record<string, TradePair[]> = {};
  for (const p of pairs) {
    if (!bySymbol[p.symbol]) bySymbol[p.symbol] = [];
    bySymbol[p.symbol].push(p);
  }
  
  // Calculate stats per symbol
  interface SymbolStats {
    symbol: string;
    name: string;
    count: number;
    wins: number;
    losses: number;
    winRate: number;
    totalPnl: number;
    avgPnl: number;
    avgWin: number;
    avgLoss: number;
    maxWin: number;
    maxLoss: number;
    rr: number;
    profitFactor: number;
  }
  
  const stats: SymbolStats[] = [];
  
  for (const [sym, trades] of Object.entries(bySymbol)) {
    const wins = trades.filter(t => t.pnl > 0);
    const losses = trades.filter(t => t.pnl <= 0);
    const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
    const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
    const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((s, t) => s + t.pnl, 0) / losses.length) : 0;
    const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
    
    stats.push({
      symbol: sym,
      name: trades[0].name,
      count: trades.length,
      wins: wins.length,
      losses: losses.length,
      winRate: wins.length / trades.length * 100,
      totalPnl,
      avgPnl: totalPnl / trades.length,
      avgWin,
      avgLoss,
      maxWin: wins.length > 0 ? Math.max(...wins.map(t => t.pnl)) : 0,
      maxLoss: losses.length > 0 ? Math.min(...losses.map(t => t.pnl)) : 0,
      rr: avgLoss > 0 ? avgWin / avgLoss : 0,
      profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
    });
  }
  
  // Sort by totalPnl
  stats.sort((a, b) => b.totalPnl - a.totalPnl);
  
  console.log(`\n  期間: ${pairs[0]?.date} 〜 ${pairs[pairs.length - 1]?.date}`);
  console.log(`  総取引数: ${pairs.length}件\n`);
  
  console.log('  銘柄    | 名前           | 件数 | 勝率   | 総PnL        | 平均PnL    | 平均勝ち   | 平均負け   | RR比  | PF');
  console.log('  ' + '─'.repeat(110));
  
  for (const s of stats) {
    const pnlStr = s.totalPnl >= 0 ? `+${s.totalPnl.toLocaleString()}` : s.totalPnl.toLocaleString();
    console.log(
      `  ${s.symbol.padEnd(7)} | ${s.name.padEnd(14)} | ${String(s.count).padStart(4)} | ${s.winRate.toFixed(1).padStart(5)}% | ${pnlStr.padStart(12)}円 | ${s.avgPnl.toFixed(0).padStart(8)}円 | +${s.avgWin.toFixed(0).padStart(7)}円 | -${s.avgLoss.toFixed(0).padStart(7)}円 | ${s.rr.toFixed(2)} | ${s.profitFactor === Infinity ? '∞' : s.profitFactor.toFixed(2)}`
    );
  }
  
  const grandTotal = stats.reduce((s, st) => s + st.totalPnl, 0);
  console.log('  ' + '─'.repeat(110));
  console.log(`  合計: ${grandTotal.toLocaleString()}円`);
  
  // ========== ② 非対象銘柄のデータ確認 ==========
  console.log(`\n\n${'='.repeat(80)}`);
  console.log(`  ② データ取得中の全銘柄一覧（rt_candlesに記録あり）`);
  console.log(`${'='.repeat(80)}`);
  
  const allSymbols = await db.execute(sql.raw(
    `SELECT symbol, COUNT(*) as candle_count, COUNT(DISTINCT tradeDate) as days, 
     MIN(tradeDate) as first_date, MAX(tradeDate) as last_date
     FROM rt_candles 
     GROUP BY symbol 
     ORDER BY candle_count DESC`
  ));
  const symbolRows = (allSymbols as any)[0] || [];
  
  const tradingSymbols = new Set(Object.keys(bySymbol));
  
  console.log(`\n  全${symbolRows.length}銘柄のデータ取得状況:\n`);
  console.log('  銘柄    | 足数     | 日数 | 期間                    | 取引対象');
  console.log('  ' + '─'.repeat(75));
  
  for (const s of symbolRows) {
    const isTrading = tradingSymbols.has(s.symbol);
    console.log(
      `  ${s.symbol.padEnd(7)} | ${String(s.candle_count).padStart(8)} | ${String(s.days).padStart(4)} | ${s.first_date} 〜 ${s.last_date} | ${isTrading ? '★対象' : '  非対象'}`
    );
  }
  
  // ========== ③ 非対象銘柄の値動き分析（シグナル検出なしでもMFE/MAEを推定） ==========
  console.log(`\n\n${'='.repeat(80)}`);
  console.log(`  ③ 非対象銘柄のボラティリティ・トレンド特性`);
  console.log(`${'='.repeat(80)}`);
  
  const nonTradingSymbols = symbolRows.filter((s: any) => !tradingSymbols.has(s.symbol) && s.days >= 5);
  
  for (const symInfo of nonTradingSymbols) {
    const sym = symInfo.symbol;
    
    // Get daily OHLC stats
    const dailyStats = await db.execute(sql.raw(
      `SELECT tradeDate,
       (SELECT open FROM rt_candles c2 WHERE c2.symbol = '${sym}' AND c2.tradeDate = c.tradeDate ORDER BY candleTime LIMIT 1) as dayOpen,
       MAX(high) as dayHigh,
       MIN(low) as dayLow,
       (SELECT close FROM rt_candles c3 WHERE c3.symbol = '${sym}' AND c3.tradeDate = c.tradeDate ORDER BY candleTime DESC LIMIT 1) as dayClose,
       COUNT(*) as barCount
       FROM rt_candles c
       WHERE symbol = '${sym}'
       GROUP BY tradeDate
       ORDER BY tradeDate`
    ));
    const days = (dailyStats as any)[0] || [];
    
    if (days.length < 3) continue;
    
    // Calculate average daily range, trend consistency
    let totalRange = 0;
    let totalAbsChange = 0;
    let upDays = 0;
    let downDays = 0;
    let avgPrice = 0;
    
    for (const d of days) {
      const open = Number(d.dayOpen);
      const high = Number(d.dayHigh);
      const low = Number(d.dayLow);
      const close = Number(d.dayClose);
      if (open === 0) continue;
      
      const range = (high - low) / open * 100;
      const change = (close - open) / open * 100;
      totalRange += range;
      totalAbsChange += Math.abs(change);
      avgPrice += close;
      if (change > 0) upDays++;
      else downDays++;
    }
    
    const avgRange = totalRange / days.length;
    const avgAbsChange = totalAbsChange / days.length;
    avgPrice = avgPrice / days.length;
    
    // Estimate shares for 270万円 position
    const estShares = Math.floor(2700000 / avgPrice / 100) * 100;
    const estPnlPerPercent = avgPrice * estShares / 100; // PnL per 1% move
    
    console.log(`\n  [${sym}] ${symInfo.days}日分 | 平均価格: ${avgPrice.toFixed(0)}円 | 推定株数: ${estShares}株`);
    console.log(`    日中平均レンジ: ${avgRange.toFixed(2)}% | 平均変動: ${avgAbsChange.toFixed(2)}%`);
    console.log(`    上昇日: ${upDays} / 下落日: ${downDays} | 1%あたり推定PnL: ${estPnlPerPercent.toFixed(0)}円`);
    console.log(`    足数/日: ${(Number(symInfo.candle_count) / symInfo.days).toFixed(0)}本`);
  }
  
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
