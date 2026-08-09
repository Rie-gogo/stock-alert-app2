/**
 * LONG/SHORTの成績を「上昇日/下落日」別に分析
 * 
 * 各銘柄の日足変動を基に「その銘柄にとっての上昇日/下落日」を判定し、
 * LONGが上昇日で勝てているか、SHORTが下落日でしか勝てていないかを検証
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
  
  // Get all trades
  const tradesRes = await db.execute(sql.raw(
    `SELECT * FROM rt_trades WHERE tradeDate >= '${dates[0]}' ORDER BY tradeDate, tradeTime`
  ));
  const allTrades = (tradesRes as any)[0] || [];
  
  // Pair entries with exits
  interface Pair {
    symbol: string; name: string; date: string; side: string;
    entryPrice: number; pnl: number; entryTime: string;
    signalType: string; boardSignal: string;
  }
  const pairs: Pair[] = [];
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
        
        const reason = t.reason || '';
        let signalType = 'その他';
        if (reason.includes('大台確認')) signalType = '大台確認';
        else if (reason.includes('三尊') || reason.includes('H&S')) signalType = '三尊';
        else if (reason.includes('VWAPクロス')) signalType = 'VWAPクロス';
        else if (reason.includes('ゴールデンクロス')) signalType = 'GC';
        else if (reason.includes('デッドクロス')) signalType = 'DC';
        else if (reason.includes('ダウ理論')) signalType = 'ダウ理論';
        
        pairs.push({
          symbol: t.symbol, name: t.symbolName || t.symbol,
          date: t.tradeDate, side: t.side || (t.action === 'buy' ? 'long' : 'short'),
          entryPrice: Number(t.price), pnl: Number(e.pnl),
          entryTime: t.tradeTime, signalType,
          boardSignal: t.boardSignal || '',
        });
        processed.add(j);
        break;
      }
    }
  }
  
  // For each trade, get the day's open/close for that symbol to determine up/down day
  interface TradeWithDay extends Pair {
    dayOpen: number;
    dayClose: number;
    dayChange: number; // %
    isUpDay: boolean;
  }
  
  const results: TradeWithDay[] = [];
  
  // Cache day open/close per symbol/date
  const dayCache = new Map<string, { open: number; close: number }>();
  
  for (const p of pairs) {
    const key = p.symbol + '_' + p.date;
    let dayData = dayCache.get(key);
    
    if (!dayData) {
      const dayRes = await db.execute(sql.raw(
        `SELECT 
          (SELECT open FROM rt_candles WHERE tradeDate = '${p.date}' AND symbol = '${p.symbol}' ORDER BY candleTime LIMIT 1) as dayOpen,
          (SELECT close FROM rt_candles WHERE tradeDate = '${p.date}' AND symbol = '${p.symbol}' ORDER BY candleTime DESC LIMIT 1) as dayClose`
      ));
      const row = (dayRes as any)[0][0];
      dayData = { open: Number(row.dayOpen), close: Number(row.dayClose) };
      dayCache.set(key, dayData);
    }
    
    const dayChange = (dayData.close - dayData.open) / dayData.open * 100;
    results.push({
      ...p,
      dayOpen: dayData.open,
      dayClose: dayData.close,
      dayChange,
      isUpDay: dayChange > 0,
    });
  }
  
  console.log('='.repeat(80));
  console.log('  LONG/SHORT × 上昇日/下落日 クロス分析');
  console.log('  期間: ' + dates[0] + ' 〜 ' + dates[dates.length - 1]);
  console.log('  総取引: ' + results.length + '件');
  console.log('='.repeat(80));
  
  // Cross analysis: side × day direction
  const categories = [
    { label: 'LONG × 上昇日', filter: (t: TradeWithDay) => t.side === 'long' && t.isUpDay },
    { label: 'LONG × 下落日', filter: (t: TradeWithDay) => t.side === 'long' && !t.isUpDay },
    { label: 'SHORT × 上昇日', filter: (t: TradeWithDay) => t.side === 'short' && t.isUpDay },
    { label: 'SHORT × 下落日', filter: (t: TradeWithDay) => t.side === 'short' && !t.isUpDay },
  ];
  
  console.log('\n  ─── 方向 × 日足方向 ───');
  console.log('  カテゴリ          | 件数 | 勝率   | 総PnL        | 平均PnL      | 期待値');
  console.log('  ' + '─'.repeat(80));
  
  for (const cat of categories) {
    const trades = results.filter(cat.filter);
    if (trades.length === 0) continue;
    const wins = trades.filter(t => t.pnl > 0).length;
    const pnl = trades.reduce((s, t) => s + t.pnl, 0);
    const avgPnl = Math.round(pnl / trades.length);
    const comment = (cat.label.includes('LONG') && cat.label.includes('上昇')) ? '← LONGが上昇日で勝てているか？' :
                    (cat.label.includes('SHORT') && cat.label.includes('下落')) ? '← SHORTの主力' : '';
    console.log('  ' + cat.label.padEnd(16) + ' | ' + String(trades.length).padStart(4) + ' | ' + (wins / trades.length * 100).toFixed(1).padStart(5) + '% | ' + pnl.toLocaleString().padStart(12) + '円 | ' + avgPnl.toLocaleString().padStart(11) + '円 | ' + comment);
  }
  
  // Detailed: LONG on up days
  console.log('\n\n' + '='.repeat(80));
  console.log('  LONG × 上昇日 全トレード詳細');
  console.log('='.repeat(80));
  
  const longUpDays = results.filter(t => t.side === 'long' && t.isUpDay);
  console.log('  件数: ' + longUpDays.length + ' | 勝率: ' + (longUpDays.filter(t => t.pnl > 0).length / longUpDays.length * 100).toFixed(1) + '%\n');
  
  console.log('  # | 日付       | 時刻  | 銘柄         | Entry    | PnL        | 日足変動 | シグナル    | 板');
  console.log('  ' + '─'.repeat(100));
  
  for (let i = 0; i < longUpDays.length; i++) {
    const t = longUpDays[i];
    const pnlStr = t.pnl >= 0 ? '+' + t.pnl.toLocaleString() : t.pnl.toLocaleString();
    const result = t.pnl > 0 ? '○' : '×';
    console.log('  ' + result + String(i + 1).padStart(2) + ' | ' + t.date + ' | ' + t.entryTime + ' | ' + t.name.padEnd(10) + ' | ' + t.entryPrice.toLocaleString().padStart(8) + ' | ' + pnlStr.padStart(10) + '円 | ' + (t.dayChange >= 0 ? '+' : '') + t.dayChange.toFixed(2) + '% | ' + t.signalType.padEnd(8) + ' | ' + t.boardSignal);
  }
  
  // SHORT on up days (逆張り候補)
  console.log('\n\n' + '='.repeat(80));
  console.log('  SHORT × 上昇日 全トレード詳細（SHORTが上昇日で負けているケース）');
  console.log('='.repeat(80));
  
  const shortUpDays = results.filter(t => t.side === 'short' && t.isUpDay);
  console.log('  件数: ' + shortUpDays.length + ' | 勝率: ' + (shortUpDays.filter(t => t.pnl > 0).length / shortUpDays.length * 100).toFixed(1) + '%\n');
  
  console.log('  # | 日付       | 時刻  | 銘柄         | Entry    | PnL        | 日足変動 | シグナル    | 板');
  console.log('  ' + '─'.repeat(100));
  
  for (let i = 0; i < shortUpDays.length; i++) {
    const t = shortUpDays[i];
    const pnlStr = t.pnl >= 0 ? '+' + t.pnl.toLocaleString() : t.pnl.toLocaleString();
    const result = t.pnl > 0 ? '○' : '×';
    console.log('  ' + result + String(i + 1).padStart(2) + ' | ' + t.date + ' | ' + t.entryTime + ' | ' + t.name.padEnd(10) + ' | ' + t.entryPrice.toLocaleString().padStart(8) + ' | ' + pnlStr.padStart(10) + '円 | ' + (t.dayChange >= 0 ? '+' : '') + t.dayChange.toFixed(2) + '% | ' + t.signalType.padEnd(8) + ' | ' + t.boardSignal);
  }
  
  // Summary by signal type for LONG
  console.log('\n\n' + '='.repeat(80));
  console.log('  LONG シグナル別 × 日足方向');
  console.log('='.repeat(80));
  
  const longTrades = results.filter(t => t.side === 'long');
  const longSignals = new Map<string, TradeWithDay[]>();
  for (const t of longTrades) {
    const arr = longSignals.get(t.signalType) || [];
    arr.push(t);
    longSignals.set(t.signalType, arr);
  }
  
  console.log('\n  シグナル    | 上昇日件数 | 上昇日勝率 | 上昇日PnL    | 下落日件数 | 下落日勝率 | 下落日PnL');
  console.log('  ' + '─'.repeat(95));
  
  for (const [sig, trades] of [...longSignals.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const upTrades = trades.filter(t => t.isUpDay);
    const downTrades = trades.filter(t => !t.isUpDay);
    const upWins = upTrades.filter(t => t.pnl > 0).length;
    const downWins = downTrades.filter(t => t.pnl > 0).length;
    const upPnl = upTrades.reduce((s, t) => s + t.pnl, 0);
    const downPnl = downTrades.reduce((s, t) => s + t.pnl, 0);
    
    const upWinRate = upTrades.length > 0 ? (upWins / upTrades.length * 100).toFixed(1) + '%' : 'N/A';
    const downWinRate = downTrades.length > 0 ? (downWins / downTrades.length * 100).toFixed(1) + '%' : 'N/A';
    
    console.log('  ' + sig.padEnd(10) + ' | ' + String(upTrades.length).padStart(6) + '件 | ' + upWinRate.padStart(8) + ' | ' + upPnl.toLocaleString().padStart(11) + '円 | ' + String(downTrades.length).padStart(6) + '件 | ' + downWinRate.padStart(8) + ' | ' + downPnl.toLocaleString().padStart(11) + '円');
  }
  
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
