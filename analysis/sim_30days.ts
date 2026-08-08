/**
 * 直近30日間シミュレーション（現在の設定）
 * 
 * 現在の設定:
 * - 銘柄別SL（SYMBOL_SL_MAP）
 * - 6920/6758除外、6146/6594追加
 * - TP 1.5%
 * - 大台確認4本維持
 * - 後場BPRフィルター
 * - 各種時間帯フィルター
 */

import { getDb } from '../server/db';
import { sql } from 'drizzle-orm';

// 現在の設定を再現
const SYMBOL_SL_MAP: Record<string, number> = {
  "8035": 0.8,
  "6857": 0.6,
  "6976": 0.5,
  "6526": 0.9,
  "5803": 0.5,
  "6981": 0.9,
  "285A": 0.8,
  "6920": 0.9,
  "6146": 0.8,
  "6594": 0.5,
  "8316": 0.5,
};

const DEFAULT_SL = 0.5;
const TP_PERCENT = 1.5;

// 取引除外銘柄
const EXCLUDED = new Set(['6920', '6758', '9984', '7011', '9107', '8306', '4568', '5016', '7203', '3778', '3436', '6723']);

// アクティブ取引銘柄
const ACTIVE_SYMBOLS = ['8035', '6857', '6976', '6526', '5803', '6981', '285A', '6146', '6594', '8316'];

function getSL(symbol: string): number {
  return SYMBOL_SL_MAP[symbol] ?? DEFAULT_SL;
}

interface TradeResult {
  date: string;
  symbol: string;
  side: string;
  entryPrice: number;
  exitPrice: number;
  shares: number;
  pnl: number;
  reason: string;
  entryTime: string;
  exitTime: string;
}

async function main() {
  const db = await getDb();
  
  // Get all trade dates (last 30)
  const datesRes = await db.execute(sql.raw(
    `SELECT DISTINCT tradeDate FROM rt_candles ORDER BY tradeDate DESC LIMIT 30`
  ));
  const dates = (datesRes as any)[0].map((r: any) => r.tradeDate).reverse();
  
  console.log(`${'='.repeat(80)}`);
  console.log(`  直近30日間シミュレーション（現在の設定）`);
  console.log(`  期間: ${dates[0]} 〜 ${dates[dates.length - 1]} (${dates.length}日間)`);
  console.log(`${'='.repeat(80)}`);
  console.log(`\n  アクティブ銘柄: ${ACTIVE_SYMBOLS.join(', ')}`);
  console.log(`  除外銘柄: ${[...EXCLUDED].join(', ')}`);
  
  // Get all actual trades from rt_trades
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
    boardSignal: string;
  }
  
  const actualPairs: TradePair[] = [];
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
        actualPairs.push({
          symbol: t.symbol,
          date: t.tradeDate,
          side: t.side,
          entryPrice: Number(t.price),
          exitPrice: Number(e.price),
          shares: Number(t.shares),
          pnl: Number(e.pnl),
          entryTime: t.tradeTime,
          exitTime: e.tradeTime,
          reason: e.reason || '',
          boardSignal: t.boardSignal || 'unknown',
        });
        processed.add(j);
        break;
      }
    }
  }
  
  // Now simulate with current SL settings
  // For each trade, recalculate what would happen with current SL
  const simResults: TradeResult[] = [];
  
  for (const pair of actualPairs) {
    // Skip excluded symbols
    if (EXCLUDED.has(pair.symbol)) continue;
    
    const sl = getSL(pair.symbol);
    
    // Get candles for this trade period
    const candlesRes = await db.execute(sql.raw(
      `SELECT candleTime, open, high, low, close, volume FROM rt_candles 
       WHERE tradeDate = '${pair.date}' AND symbol = '${pair.symbol}' 
       AND candleTime >= '${pair.entryTime}'
       ORDER BY candleTime`
    ));
    const candles = (candlesRes as any)[0] || [];
    
    if (candles.length === 0) {
      // No candle data, use actual result
      simResults.push({
        date: pair.date,
        symbol: pair.symbol,
        side: pair.side,
        entryPrice: pair.entryPrice,
        exitPrice: pair.exitPrice,
        shares: pair.shares,
        pnl: pair.pnl,
        reason: pair.reason,
        entryTime: pair.entryTime,
        exitTime: pair.exitTime,
      });
      continue;
    }
    
    // Simulate with current SL/TP
    const entryPrice = pair.entryPrice;
    const shares = pair.shares;
    let exitPrice = pair.exitPrice;
    let exitTime = pair.exitTime;
    let exitReason = pair.reason;
    let pnl = pair.pnl;
    
    const tpPrice = pair.side === 'long' 
      ? entryPrice * (1 + TP_PERCENT / 100)
      : entryPrice * (1 - TP_PERCENT / 100);
    const slPrice = pair.side === 'long'
      ? entryPrice * (1 - sl / 100)
      : entryPrice * (1 + sl / 100);
    
    let exited = false;
    for (const c of candles) {
      if (c.candleTime === pair.entryTime) continue; // Skip entry candle
      
      const high = Number(c.high);
      const low = Number(c.low);
      
      if (pair.side === 'long') {
        // Check SL first
        if (low <= slPrice) {
          exitPrice = slPrice;
          exitTime = c.candleTime;
          exitReason = `損切り(SL:${sl}%)`;
          pnl = (exitPrice - entryPrice) * shares;
          exited = true;
          break;
        }
        // Check TP
        if (high >= tpPrice) {
          exitPrice = tpPrice;
          exitTime = c.candleTime;
          exitReason = `利確(TP:${TP_PERCENT}%)`;
          pnl = (exitPrice - entryPrice) * shares;
          exited = true;
          break;
        }
      } else {
        // SHORT
        if (high >= slPrice) {
          exitPrice = slPrice;
          exitTime = c.candleTime;
          exitReason = `損切り(SL:${sl}%)`;
          pnl = (entryPrice - exitPrice) * shares;
          exited = true;
          break;
        }
        if (low <= tpPrice) {
          exitPrice = tpPrice;
          exitTime = c.candleTime;
          exitReason = `利確(TP:${TP_PERCENT}%)`;
          pnl = (entryPrice - exitPrice) * shares;
          exited = true;
          break;
        }
      }
    }
    
    if (!exited) {
      // Use the last candle close (forced close at EOD)
      const lastCandle = candles[candles.length - 1];
      exitPrice = Number(lastCandle.close);
      exitTime = lastCandle.candleTime;
      exitReason = '大引け強制決済';
      pnl = pair.side === 'long' 
        ? (exitPrice - entryPrice) * shares
        : (entryPrice - exitPrice) * shares;
    }
    
    simResults.push({
      date: pair.date,
      symbol: pair.symbol,
      side: pair.side,
      entryPrice,
      exitPrice,
      shares,
      pnl,
      reason: exitReason,
      entryTime: pair.entryTime,
      exitTime,
    });
  }
  
  // ========== 日別サマリー ==========
  console.log(`\n${'─'.repeat(80)}`);
  console.log(`  日別サマリー`);
  console.log(`${'─'.repeat(80)}`);
  console.log(`  日付       | 件数 | 勝率   | PnL          | 累計`);
  console.log(`  ${'─'.repeat(70)}`);
  
  let cumPnl = 0;
  const dailyResults: { date: string; count: number; wins: number; pnl: number; cumPnl: number }[] = [];
  
  for (const date of dates) {
    const dayTrades = simResults.filter(t => t.date === date);
    if (dayTrades.length === 0) continue;
    
    const wins = dayTrades.filter(t => t.pnl > 0).length;
    const dayPnl = dayTrades.reduce((s, t) => s + t.pnl, 0);
    cumPnl += dayPnl;
    
    const winRate = (wins / dayTrades.length * 100).toFixed(1);
    const pnlStr = dayPnl >= 0 ? `+${dayPnl.toLocaleString()}` : dayPnl.toLocaleString();
    const cumStr = cumPnl >= 0 ? `+${cumPnl.toLocaleString()}` : cumPnl.toLocaleString();
    
    console.log(`  ${date} | ${String(dayTrades.length).padStart(4)} | ${winRate.padStart(5)}% | ${pnlStr.padStart(12)}円 | ${cumStr.padStart(12)}円`);
    
    dailyResults.push({ date, count: dayTrades.length, wins, pnl: dayPnl, cumPnl });
  }
  
  // ========== 総合サマリー ==========
  console.log(`\n${'─'.repeat(80)}`);
  console.log(`  総合サマリー`);
  console.log(`${'─'.repeat(80)}`);
  
  const totalTrades = simResults.length;
  const totalWins = simResults.filter(t => t.pnl > 0).length;
  const totalLosses = simResults.filter(t => t.pnl <= 0).length;
  const totalPnl = simResults.reduce((s, t) => s + t.pnl, 0);
  const avgPnl = totalPnl / totalTrades;
  const winRate = totalWins / totalTrades * 100;
  const tradingDays = dailyResults.length;
  const avgDailyPnl = totalPnl / tradingDays;
  const winDays = dailyResults.filter(d => d.pnl > 0).length;
  const lossDays = dailyResults.filter(d => d.pnl <= 0).length;
  const maxDayPnl = Math.max(...dailyResults.map(d => d.pnl));
  const minDayPnl = Math.min(...dailyResults.map(d => d.pnl));
  const avgWin = totalWins > 0 ? simResults.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0) / totalWins : 0;
  const avgLoss = totalLosses > 0 ? Math.abs(simResults.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0) / totalLosses) : 0;
  const grossProfit = simResults.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(simResults.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
  const pf = grossLoss > 0 ? grossProfit / grossLoss : Infinity;
  
  console.log(`  期間: ${dates[0]} 〜 ${dates[dates.length - 1]} (${dates.length}日)`);
  console.log(`  取引日数: ${tradingDays}日`);
  console.log(`  総取引数: ${totalTrades}件 (勝ち${totalWins} / 負け${totalLosses})`);
  console.log(`  勝率: ${winRate.toFixed(1)}%`);
  console.log(`  総損益: ${totalPnl >= 0 ? '+' : ''}${totalPnl.toLocaleString()}円`);
  console.log(`  日平均損益: ${avgDailyPnl >= 0 ? '+' : ''}${avgDailyPnl.toFixed(0)}円`);
  console.log(`  平均損益/件: ${avgPnl >= 0 ? '+' : ''}${avgPnl.toFixed(0)}円`);
  console.log(`  平均勝ち: +${avgWin.toFixed(0)}円`);
  console.log(`  平均負け: -${avgLoss.toFixed(0)}円`);
  console.log(`  RR比: ${(avgWin / avgLoss).toFixed(2)}`);
  console.log(`  PF: ${pf.toFixed(2)}`);
  console.log(`  勝ち日/負け日: ${winDays}/${lossDays}`);
  console.log(`  最良日: +${maxDayPnl.toLocaleString()}円`);
  console.log(`  最悪日: ${minDayPnl.toLocaleString()}円`);
  
  // ========== 銘柄別サマリー ==========
  console.log(`\n${'─'.repeat(80)}`);
  console.log(`  銘柄別サマリー`);
  console.log(`${'─'.repeat(80)}`);
  console.log(`  銘柄    | SL   | 件数 | 勝率   | 総PnL        | 平均PnL    | PF`);
  console.log(`  ${'─'.repeat(70)}`);
  
  const bySymbol: Record<string, TradeResult[]> = {};
  for (const t of simResults) {
    if (!bySymbol[t.symbol]) bySymbol[t.symbol] = [];
    bySymbol[t.symbol].push(t);
  }
  
  const symbolStats = Object.entries(bySymbol).map(([sym, trades]) => {
    const wins = trades.filter(t => t.pnl > 0);
    const losses = trades.filter(t => t.pnl <= 0);
    const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
    const gp = wins.reduce((s, t) => s + t.pnl, 0);
    const gl = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
    return { sym, trades: trades.length, wins: wins.length, totalPnl, pf: gl > 0 ? gp / gl : gp > 0 ? Infinity : 0 };
  }).sort((a, b) => b.totalPnl - a.totalPnl);
  
  for (const s of symbolStats) {
    const sl = getSL(s.sym);
    const wr = (s.wins / s.trades * 100).toFixed(1);
    const pnlStr = s.totalPnl >= 0 ? `+${s.totalPnl.toLocaleString()}` : s.totalPnl.toLocaleString();
    const avgPnl = s.totalPnl / s.trades;
    console.log(`  ${s.sym.padEnd(7)} | ${(sl + '%').padStart(4)} | ${String(s.trades).padStart(4)} | ${wr.padStart(5)}% | ${pnlStr.padStart(12)}円 | ${avgPnl.toFixed(0).padStart(8)}円 | ${s.pf === Infinity ? '∞' : s.pf.toFixed(2)}`);
  }
  
  // ========== 決済理由別 ==========
  console.log(`\n${'─'.repeat(80)}`);
  console.log(`  決済理由別`);
  console.log(`${'─'.repeat(80)}`);
  
  const byReason: Record<string, TradeResult[]> = {};
  for (const t of simResults) {
    const key = t.reason.includes('利確') ? '利確(TP)' : t.reason.includes('損切') ? '損切り(SL)' : t.reason.includes('大引け') ? '大引け強制' : t.reason;
    if (!byReason[key]) byReason[key] = [];
    byReason[key].push(t);
  }
  
  for (const [reason, trades] of Object.entries(byReason).sort((a, b) => b[1].reduce((s, t) => s + t.pnl, 0) - a[1].reduce((s, t) => s + t.pnl, 0))) {
    const pnl = trades.reduce((s, t) => s + t.pnl, 0);
    const pnlStr = pnl >= 0 ? `+${pnl.toLocaleString()}` : pnl.toLocaleString();
    console.log(`  ${reason.padEnd(20)} | ${String(trades.length).padStart(4)}件 | ${pnlStr.padStart(12)}円`);
  }
  
  // ========== 方向別 ==========
  console.log(`\n${'─'.repeat(80)}`);
  console.log(`  方向別`);
  console.log(`${'─'.repeat(80)}`);
  
  const longs = simResults.filter(t => t.side === 'long');
  const shorts = simResults.filter(t => t.side === 'short');
  const longWins = longs.filter(t => t.pnl > 0).length;
  const shortWins = shorts.filter(t => t.pnl > 0).length;
  const longPnl = longs.reduce((s, t) => s + t.pnl, 0);
  const shortPnl = shorts.reduce((s, t) => s + t.pnl, 0);
  
  console.log(`  LONG:  ${longs.length}件 | 勝率${(longWins / longs.length * 100).toFixed(1)}% | ${longPnl >= 0 ? '+' : ''}${longPnl.toLocaleString()}円`);
  console.log(`  SHORT: ${shorts.length}件 | 勝率${(shortWins / shorts.length * 100).toFixed(1)}% | ${shortPnl >= 0 ? '+' : ''}${shortPnl.toLocaleString()}円`);
  
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
