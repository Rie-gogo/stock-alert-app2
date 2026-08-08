/**
 * 30日間完全再シミュレーション
 * 
 * 現在の設定:
 * - CONFIRM_BARS = 4
 * - 銘柄別SL (SYMBOL_SL_MAP)
 * - TP = 1.5%
 * - 6920/6758除外
 * - rt_candlesデータを使い、大台確認シグナルを再現
 * 
 * 簡略化: 大台確認シグナルのみ再現（全取引の82/122件 = 67%を占める主要シグナル）
 * VWAPクロス、三尊等は再現が複雑なため、大台確認のみで比較
 */

import { getDb } from '../server/db';
import { sql } from 'drizzle-orm';

// Current settings
const CONFIRM_BARS = 4;
const TP_PCT = 1.5;
const SYMBOL_SL_MAP: Record<string, number> = {
  "8035": 0.8, "6857": 0.6, "6976": 0.5, "6526": 0.9,
  "5803": 0.5, "6981": 0.9, "285A": 0.8, "6146": 0.8,
  "6594": 0.5, "8316": 0.5,
};
const DEFAULT_SL = 0.5;

const ACTIVE_SYMBOLS = ['8035', '6857', '6976', '6526', '5803', '6981', '285A', '8316', '6146', '6594'];

// Round level detection
function getRoundLevels(price: number): number[] {
  const levels: number[] = [];
  if (price >= 50000) {
    const base = Math.floor(price / 1000) * 1000;
    levels.push(base - 1000, base, base + 1000, base + 2000);
  } else if (price >= 10000) {
    const base = Math.floor(price / 500) * 500;
    levels.push(base - 500, base, base + 500, base + 1000);
  } else if (price >= 5000) {
    const base = Math.floor(price / 100) * 100;
    levels.push(base - 100, base, base + 100, base + 200);
  } else if (price >= 1000) {
    const base = Math.floor(price / 50) * 50;
    levels.push(base - 50, base, base + 50, base + 100);
  } else {
    const base = Math.floor(price / 10) * 10;
    levels.push(base - 10, base, base + 10, base + 20);
  }
  return levels;
}

interface Candle {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface SimTrade {
  symbol: string;
  date: string;
  side: 'long' | 'short';
  entryTime: string;
  entryPrice: number;
  exitTime: string;
  exitPrice: number;
  pnl: number;
  exitReason: string;
  slPct: number;
}

function simulateDay(symbol: string, candles: Candle[]): SimTrade[] {
  const trades: SimTrade[] = [];
  const slPct = SYMBOL_SL_MAP[symbol] ?? DEFAULT_SL;
  
  if (candles.length < 10) return trades;
  
  // Track round level crossings
  interface RoundPending {
    level: number;
    direction: 'above' | 'below';
    confirmCount: number;
    startIdx: number;
  }
  
  let pendingRound: RoundPending | null = null;
  let inPosition = false;
  let positionSide: 'long' | 'short' = 'long';
  let entryPrice = 0;
  let entryTime = '';
  let entryIdx = 0;
  
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1];
    const curr = candles[i];
    
    // If in position, check SL/TP
    if (inPosition) {
      const sl = slPct / 100;
      const tp = TP_PCT / 100;
      
      if (positionSide === 'long') {
        // Check SL
        if (curr.low <= entryPrice * (1 - sl)) {
          const exitPrice = entryPrice * (1 - sl);
          const shares = Math.floor(2000000 / entryPrice);
          trades.push({
            symbol, date: '', side: 'long',
            entryTime, entryPrice,
            exitTime: curr.time, exitPrice,
            pnl: Math.round((exitPrice - entryPrice) * shares),
            exitReason: '損切り(SL)', slPct,
          });
          inPosition = false;
          continue;
        }
        // Check TP
        if (curr.high >= entryPrice * (1 + tp)) {
          const exitPrice = entryPrice * (1 + tp);
          const shares = Math.floor(2000000 / entryPrice);
          trades.push({
            symbol, date: '', side: 'long',
            entryTime, entryPrice,
            exitTime: curr.time, exitPrice,
            pnl: Math.round((exitPrice - entryPrice) * shares),
            exitReason: '利確(TP)', slPct,
          });
          inPosition = false;
          continue;
        }
      } else {
        // SHORT
        if (curr.high >= entryPrice * (1 + sl)) {
          const exitPrice = entryPrice * (1 + sl);
          const shares = Math.floor(2000000 / entryPrice);
          trades.push({
            symbol, date: '', side: 'short',
            entryTime, entryPrice,
            exitTime: curr.time, exitPrice,
            pnl: Math.round((entryPrice - exitPrice) * shares),
            exitReason: '損切り(SL)', slPct,
          });
          inPosition = false;
          continue;
        }
        if (curr.low <= entryPrice * (1 - tp)) {
          const exitPrice = entryPrice * (1 - tp);
          const shares = Math.floor(2000000 / entryPrice);
          trades.push({
            symbol, date: '', side: 'short',
            entryTime, entryPrice,
            exitTime: curr.time, exitPrice,
            pnl: Math.round((entryPrice - exitPrice) * shares),
            exitReason: '利確(TP)', slPct,
          });
          inPosition = false;
          continue;
        }
      }
      
      // EOD check (last candle)
      if (i === candles.length - 1) {
        const shares = Math.floor(2000000 / entryPrice);
        const exitPrice = curr.close;
        const pnl = positionSide === 'long' 
          ? Math.round((exitPrice - entryPrice) * shares)
          : Math.round((entryPrice - exitPrice) * shares);
        trades.push({
          symbol, date: '', side: positionSide,
          entryTime, entryPrice,
          exitTime: curr.time, exitPrice,
          pnl, exitReason: '大引け強制決済', slPct,
        });
        inPosition = false;
      }
      continue;
    }
    
    // Detect round level crossing
    const levels = getRoundLevels(curr.close);
    
    for (const level of levels) {
      // Crossed above
      if (prev.close < level && curr.close >= level) {
        pendingRound = { level, direction: 'above', confirmCount: 1, startIdx: i };
        break;
      }
      // Crossed below
      if (prev.close > level && curr.close <= level) {
        pendingRound = { level, direction: 'below', confirmCount: 1, startIdx: i };
        break;
      }
    }
    
    // Confirm pending round level
    if (pendingRound && i > pendingRound.startIdx) {
      if (pendingRound.direction === 'above' && curr.close >= pendingRound.level) {
        pendingRound.confirmCount++;
      } else if (pendingRound.direction === 'below' && curr.close <= pendingRound.level) {
        pendingRound.confirmCount++;
      } else {
        // Failed confirmation
        pendingRound = null;
        continue;
      }
      
      // Check if confirmed
      if (pendingRound.confirmCount >= CONFIRM_BARS) {
        // Entry signal
        if (!inPosition) {
          inPosition = true;
          entryPrice = curr.close;
          entryTime = curr.time;
          entryIdx = i;
          positionSide = pendingRound.direction === 'above' ? 'long' : 'short';
        }
        pendingRound = null;
      }
    }
  }
  
  return trades;
}

async function main() {
  const db = await getDb();
  
  // Get last 30 trade dates
  const datesRes = await db.execute(sql.raw(
    `SELECT DISTINCT tradeDate FROM rt_candles ORDER BY tradeDate DESC LIMIT 30`
  ));
  const dates = (datesRes as any)[0].map((r: any) => r.tradeDate).reverse();
  
  console.log('='.repeat(80));
  console.log('  30日間完全再シミュレーション（現在の設定）');
  console.log('  期間: ' + dates[0] + ' 〜 ' + dates[dates.length - 1]);
  console.log('  設定: CONFIRM_BARS=4, 銘柄別SL, TP=1.5%, 6920/6758除外');
  console.log('='.repeat(80));
  
  const allTrades: SimTrade[] = [];
  
  for (const date of dates) {
    for (const symbol of ACTIVE_SYMBOLS) {
      // Get candles for this symbol on this date
      const candlesRes = await db.execute(sql.raw(
        `SELECT candleTime, open, high, low, close, volume 
         FROM rt_candles 
         WHERE tradeDate = '${date}' AND symbol = '${symbol}' 
         ORDER BY candleTime`
      ));
      const rawCandles = (candlesRes as any)[0] || [];
      
      if (rawCandles.length < 20) continue;
      
      const candles: Candle[] = rawCandles.map((c: any) => ({
        time: c.candleTime,
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close),
        volume: Number(c.volume || 0),
      }));
      
      const dayTrades = simulateDay(symbol, candles);
      for (const t of dayTrades) {
        t.date = date;
      }
      allTrades.push(...dayTrades);
    }
  }
  
  // Summary
  const totalPnl = allTrades.reduce((s, t) => s + t.pnl, 0);
  const wins = allTrades.filter(t => t.pnl > 0).length;
  const losses = allTrades.filter(t => t.pnl <= 0).length;
  
  console.log('\n  【総合結果】');
  console.log('  取引件数: ' + allTrades.length + '件（勝ち' + wins + ' / 負け' + losses + '）');
  console.log('  勝率: ' + (wins / allTrades.length * 100).toFixed(1) + '%');
  console.log('  総PnL: ' + totalPnl.toLocaleString() + '円');
  console.log('  日平均: ' + Math.round(totalPnl / dates.length).toLocaleString() + '円');
  
  const avgWin = wins > 0 ? Math.round(allTrades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0) / wins) : 0;
  const avgLoss = losses > 0 ? Math.round(allTrades.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0) / losses) : 0;
  console.log('  平均勝ち: ' + avgWin.toLocaleString() + '円 | 平均負け: ' + avgLoss.toLocaleString() + '円');
  console.log('  RR比: ' + (Math.abs(avgWin / avgLoss)).toFixed(2));
  
  const grossProfit = allTrades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(allTrades.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
  console.log('  PF: ' + (grossLoss > 0 ? (grossProfit / grossLoss).toFixed(2) : 'INF'));
  
  // Daily breakdown
  console.log('\n  ─── 日別推移 ───');
  console.log('  日付       | 件数 | 勝率   | PnL          | 累計');
  console.log('  ' + '─'.repeat(65));
  
  let cumPnl = 0;
  for (const date of dates) {
    const dayTrades = allTrades.filter(t => t.date === date);
    if (dayTrades.length === 0) {
      cumPnl += 0;
      console.log('  ' + date + ' |    0 |   N/A  |            0円 | ' + cumPnl.toLocaleString().padStart(12) + '円');
      continue;
    }
    const dayPnl = dayTrades.reduce((s, t) => s + t.pnl, 0);
    const dayWins = dayTrades.filter(t => t.pnl > 0).length;
    cumPnl += dayPnl;
    console.log('  ' + date + ' | ' + String(dayTrades.length).padStart(4) + ' | ' + (dayWins / dayTrades.length * 100).toFixed(1).padStart(5) + '% | ' + dayPnl.toLocaleString().padStart(12) + '円 | ' + cumPnl.toLocaleString().padStart(12) + '円');
  }
  
  // By symbol
  console.log('\n  ─── 銘柄別 ───');
  console.log('  銘柄             | SL   | 件数 | 勝率   | 総PnL        | PF');
  console.log('  ' + '─'.repeat(70));
  
  const symbolNames: Record<string, string> = {
    '8035': '東京エレクトロン', '6857': 'アドバンテスト', '6976': '太陽誘電',
    '6526': 'ソシオネクスト', '5803': 'フジクラ', '6981': '村田製作所',
    '285A': 'キオクシアHD', '8316': '三井住友FG', '6146': 'ディスコ', '6594': 'ニデック'
  };
  
  for (const symbol of ACTIVE_SYMBOLS) {
    const symTrades = allTrades.filter(t => t.symbol === symbol);
    if (symTrades.length === 0) continue;
    const symPnl = symTrades.reduce((s, t) => s + t.pnl, 0);
    const symWins = symTrades.filter(t => t.pnl > 0).length;
    const symGP = symTrades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
    const symGL = Math.abs(symTrades.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
    const pf = symGL > 0 ? (symGP / symGL).toFixed(2) : 'INF';
    const name = symbolNames[symbol] || symbol;
    const sl = SYMBOL_SL_MAP[symbol] || DEFAULT_SL;
    console.log('  ' + name.padEnd(14) + ' | ' + sl.toFixed(1) + '% | ' + String(symTrades.length).padStart(4) + ' | ' + (symWins / symTrades.length * 100).toFixed(1).padStart(5) + '% | ' + symPnl.toLocaleString().padStart(12) + '円 | ' + pf);
  }
  
  // By direction
  console.log('\n  ─── 方向別 ───');
  const longs = allTrades.filter(t => t.side === 'long');
  const shorts = allTrades.filter(t => t.side === 'short');
  const longWins = longs.filter(t => t.pnl > 0).length;
  const shortWins = shorts.filter(t => t.pnl > 0).length;
  const longPnl = longs.reduce((s, t) => s + t.pnl, 0);
  const shortPnl = shorts.reduce((s, t) => s + t.pnl, 0);
  console.log('  LONG:  ' + longs.length + '件 | 勝率: ' + (longs.length > 0 ? (longWins / longs.length * 100).toFixed(1) : 'N/A') + '% | 総PnL: ' + longPnl.toLocaleString() + '円');
  console.log('  SHORT: ' + shorts.length + '件 | 勝率: ' + (shorts.length > 0 ? (shortWins / shorts.length * 100).toFixed(1) : 'N/A') + '% | 総PnL: ' + shortPnl.toLocaleString() + '円');
  
  // By exit reason
  console.log('\n  ─── 決済理由別 ───');
  const byExit = new Map<string, SimTrade[]>();
  for (const t of allTrades) {
    const arr = byExit.get(t.exitReason) || [];
    arr.push(t);
    byExit.set(t.exitReason, arr);
  }
  
  for (const [reason, trades] of [...byExit.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const pnl = trades.reduce((s, t) => s + t.pnl, 0);
    console.log('  ' + reason.padEnd(16) + ' | ' + String(trades.length).padStart(4) + '件 | ' + pnl.toLocaleString().padStart(12) + '円');
  }
  
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
