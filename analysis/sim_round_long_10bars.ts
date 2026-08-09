/**
 * 大台確認LONG: 10本維持でエントリーのシミュレーション
 * 
 * 現行: 大台超え → 4本維持 → エントリー（遅すぎて底値掴み）
 * 提案: 大台超え → 10本維持 → エントリー（本物のブレイクアウト確認）
 * 
 * rt_candlesデータから大台超えを検出し、10本維持後にLONGした場合の損益を計算
 */

import { getDb } from '../server/db';
import { sql } from 'drizzle-orm';

const ACTIVE_SYMBOLS = ['8035', '6857', '6976', '6526', '5803', '6981', '285A', '6146', '6594', '8316'];

const SYMBOL_SL_MAP: Record<string, number> = {
  "8035": 0.8, "6857": 0.6, "6976": 0.5, "6526": 0.9,
  "5803": 0.5, "6981": 0.9, "285A": 0.8, "6146": 0.8,
  "6594": 0.5, "8316": 0.5,
};
const TP_PCT = 1.5;
const LOT_SIZE = 100; // simplified

// Round level detection
function getRoundLevel(price: number): number {
  if (price >= 100000) return 5000;
  if (price >= 50000) return 2000;
  if (price >= 10000) return 1000;
  if (price >= 5000) return 500;
  if (price >= 3000) return 200;
  if (price >= 1000) return 100;
  if (price >= 500) return 50;
  return 10;
}

function detectRoundLevelCross(prevClose: number, currClose: number): { crossedAbove: boolean; level: number | null } {
  const step = getRoundLevel(currClose);
  const prevLevel = Math.floor(prevClose / step) * step;
  const currLevel = Math.floor(currClose / step) * step;
  
  if (currLevel > prevLevel && currClose > currLevel) {
    return { crossedAbove: true, level: currLevel };
  }
  return { crossedAbove: false, level: null };
}

interface Candle {
  open: number; high: number; low: number; close: number;
  candleTime: string; volume: number;
}

interface Trade {
  symbol: string; date: string; entryTime: string; exitTime: string;
  entryPrice: number; exitPrice: number; pnl: number; pnlPct: number;
  exitReason: string; level: number; confirmBars: number;
}

async function main() {
  const db = await getDb();
  
  // Get last 30 trade dates
  const datesRes = await db.execute(sql.raw(
    `SELECT DISTINCT tradeDate FROM rt_candles WHERE symbol IN ('8035','6857','6976','6526','5803','6981','285A') ORDER BY tradeDate DESC LIMIT 30`
  ));
  const dates = (datesRes as any)[0].map((r: any) => r.tradeDate).reverse();
  
  console.log('='.repeat(80));
  console.log('  大台確認LONG: 確認本数別シミュレーション');
  console.log('  期間: ' + dates[0] + ' 〜 ' + dates[dates.length - 1] + ' (' + dates.length + '日)');
  console.log('='.repeat(80));
  
  // Test multiple confirm bar counts
  const confirmBarOptions = [4, 6, 8, 10, 12, 15];
  const resultsByBars: Map<number, Trade[]> = new Map();
  
  for (const confirmBars of confirmBarOptions) {
    resultsByBars.set(confirmBars, []);
  }
  
  for (const sym of ACTIVE_SYMBOLS) {
    for (const date of dates) {
      // Get candles for this symbol/date
      const candlesRes = await db.execute(sql.raw(
        `SELECT open, high, low, close, candleTime, volume FROM rt_candles WHERE tradeDate = '${date}' AND symbol = '${sym}' ORDER BY candleTime`
      ));
      const candles: Candle[] = ((candlesRes as any)[0] || []).map((r: any) => ({
        open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close),
        candleTime: r.candleTime, volume: Number(r.volume || 0),
      }));
      
      if (candles.length < 20) continue;
      
      const slPct = SYMBOL_SL_MAP[sym] || 0.5;
      
      // For each confirm bar option, simulate independently
      for (const confirmBars of confirmBarOptions) {
        const trades = resultsByBars.get(confirmBars)!;
        
        let pendingLevel: number | null = null;
        let confirmCount = 0;
        let inPosition = false;
        let entryPrice = 0;
        let entryTime = '';
        let entryLevel = 0;
        
        for (let i = 1; i < candles.length; i++) {
          const prev = candles[i - 1];
          const curr = candles[i];
          
          // If in position, check SL/TP
          if (inPosition) {
            const tpPrice = entryPrice * (1 + TP_PCT / 100);
            const slPrice = entryPrice * (1 - slPct / 100);
            
            if (curr.high >= tpPrice) {
              // TP hit
              const lots = Math.floor(2000000 / entryPrice);
              const pnl = Math.round((tpPrice - entryPrice) * lots);
              trades.push({
                symbol: sym, date, entryTime, exitTime: curr.candleTime,
                entryPrice, exitPrice: tpPrice, pnl, pnlPct: TP_PCT,
                exitReason: '利確(TP)', level: entryLevel, confirmBars,
              });
              inPosition = false;
            } else if (curr.low <= slPrice) {
              // SL hit
              const lots = Math.floor(2000000 / entryPrice);
              const pnl = Math.round((slPrice - entryPrice) * lots);
              trades.push({
                symbol: sym, date, entryTime, exitTime: curr.candleTime,
                entryPrice, exitPrice: slPrice, pnl, pnlPct: -slPct,
                exitReason: '損切り(SL)', level: entryLevel, confirmBars,
              });
              inPosition = false;
            } else if (i === candles.length - 1) {
              // EOD
              const lots = Math.floor(2000000 / entryPrice);
              const pnl = Math.round((curr.close - entryPrice) * lots);
              const pnlPct = (curr.close - entryPrice) / entryPrice * 100;
              trades.push({
                symbol: sym, date, entryTime, exitTime: curr.candleTime,
                entryPrice, exitPrice: curr.close, pnl, pnlPct,
                exitReason: '大引け', level: entryLevel, confirmBars,
              });
              inPosition = false;
            }
            continue; // Don't look for new signals while in position
          }
          
          // Detect round level cross above
          const { crossedAbove, level } = detectRoundLevelCross(prev.close, curr.close);
          
          if (crossedAbove && level !== null) {
            // New round level break - start confirmation
            pendingLevel = level;
            confirmCount = 1; // This bar counts as first confirmation
          } else if (pendingLevel !== null) {
            // Check if price still above the level
            if (curr.close > pendingLevel) {
              confirmCount++;
              
              if (confirmCount >= confirmBars) {
                // Confirmed! Enter LONG
                entryPrice = curr.close;
                entryTime = curr.candleTime;
                entryLevel = pendingLevel;
                inPosition = true;
                pendingLevel = null;
                confirmCount = 0;
              }
            } else {
              // Failed confirmation - price fell back below level
              pendingLevel = null;
              confirmCount = 0;
            }
          }
        }
      }
    }
  }
  
  // Print results
  console.log('\n  ─── 確認本数別 総合結果 ───\n');
  console.log('  確認本数 | 件数 | 勝率   | 総PnL         | 平均PnL      | PF    | 勝ち平均   | 負け平均');
  console.log('  ' + '─'.repeat(95));
  
  for (const confirmBars of confirmBarOptions) {
    const trades = resultsByBars.get(confirmBars)!;
    if (trades.length === 0) {
      console.log('  ' + String(confirmBars).padStart(4) + '本   | 0件  | N/A');
      continue;
    }
    const wins = trades.filter(t => t.pnl > 0);
    const losses = trades.filter(t => t.pnl <= 0);
    const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
    const avgPnl = Math.round(totalPnl / trades.length);
    const avgWin = wins.length > 0 ? Math.round(wins.reduce((s, t) => s + t.pnl, 0) / wins.length) : 0;
    const avgLoss = losses.length > 0 ? Math.round(losses.reduce((s, t) => s + t.pnl, 0) / losses.length) : 0;
    const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
    const pf = grossLoss > 0 ? (grossWin / grossLoss).toFixed(2) : 'INF';
    
    const marker = confirmBars === 4 ? ' ← 現行' : confirmBars === 10 ? ' ← 提案' : '';
    console.log('  ' + String(confirmBars).padStart(4) + '本   | ' + String(trades.length).padStart(3) + '件 | ' + (wins.length / trades.length * 100).toFixed(1).padStart(5) + '% | ' + totalPnl.toLocaleString().padStart(12) + '円 | ' + avgPnl.toLocaleString().padStart(10) + '円 | ' + pf.padStart(5) + ' | ' + avgWin.toLocaleString().padStart(9) + '円 | ' + avgLoss.toLocaleString().padStart(9) + '円' + marker);
  }
  
  // Detailed results for 10-bar
  console.log('\n\n  ─── 10本確認 全トレード詳細 ───\n');
  const trades10 = resultsByBars.get(10)!;
  console.log('  # | 日付       | 銘柄    | Entry    | Level  | PnL        | 決済理由    | 保有時間');
  console.log('  ' + '─'.repeat(90));
  
  for (let i = 0; i < trades10.length; i++) {
    const t = trades10[i];
    const pnlStr = t.pnl >= 0 ? '+' + t.pnl.toLocaleString() : t.pnl.toLocaleString();
    const result = t.pnl > 0 ? '○' : '×';
    // Calculate holding time (rough)
    const entryMin = parseInt(t.entryTime.split(':')[0]) * 60 + parseInt(t.entryTime.split(':')[1]);
    const exitMin = parseInt(t.exitTime.split(':')[0]) * 60 + parseInt(t.exitTime.split(':')[1]);
    const holdMin = exitMin - entryMin;
    console.log('  ' + result + String(i + 1).padStart(2) + ' | ' + t.date + ' | ' + t.symbol.padEnd(6) + ' | ' + t.entryPrice.toLocaleString().padStart(8) + ' | ' + t.level.toLocaleString().padStart(6) + ' | ' + pnlStr.padStart(10) + '円 | ' + t.exitReason.padEnd(8) + ' | ' + holdMin + '分');
  }
  
  // By symbol for 10-bar
  console.log('\n\n  ─── 10本確認 銘柄別 ───\n');
  const symMap10 = new Map<string, Trade[]>();
  for (const t of trades10) {
    const arr = symMap10.get(t.symbol) || [];
    arr.push(t);
    symMap10.set(t.symbol, arr);
  }
  
  for (const [sym, trades] of [...symMap10.entries()].sort((a, b) => b[1].reduce((s, t) => s + t.pnl, 0) - a[1].reduce((s, t) => s + t.pnl, 0))) {
    const wins = trades.filter(t => t.pnl > 0).length;
    const pnl = trades.reduce((s, t) => s + t.pnl, 0);
    console.log('    ' + sym.padEnd(6) + ' | ' + trades.length + '件 | 勝率: ' + (wins / trades.length * 100).toFixed(1) + '% | PnL: ' + pnl.toLocaleString() + '円');
  }
  
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
