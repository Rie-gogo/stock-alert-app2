/**
 * 売り板突破パターン v3: 全期間バックテスト (6/17〜6/30)
 * 最良設定D: 押し0.5-2.5% / SL=安値-0.3% / TP=+2.0%
 */
import { getDb } from '../server/db';
import { sql } from 'drizzle-orm';

interface Candle {
  candleTime: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  boardSig: string | null;
  bpr: number;
}

function detectSellWallBreakthrough(candles: Candle[], currentIdx: number) {
  let streak = 0;
  for (let i = currentIdx; i >= 0; i--) {
    const c = candles[i];
    if (c.boardSig === 'sell_pressure' && c.close > c.open) {
      streak++;
    } else {
      break;
    }
  }
  
  if (streak < 3) return { detected: false } as any;
  
  const streakStart = currentIdx - streak + 1;
  const startCandle = candles[streakStart];
  const endCandle = candles[currentIdx];
  
  // BPR rising
  const startBpr = candles[streakStart].bpr;
  const endBprAvg = (candles[currentIdx].bpr + candles[Math.max(streakStart, currentIdx - 1)].bpr + candles[Math.max(streakStart, currentIdx - 2)].bpr) / Math.min(3, streak);
  const bprDelta = endBprAvg - startBpr;
  if (bprDelta < 0.05) return { detected: false } as any;
  
  // Volume maintained
  const firstHalfVol = candles.slice(streakStart, streakStart + Math.ceil(streak / 2)).reduce((s, c) => s + c.volume, 0) / Math.ceil(streak / 2);
  const secondHalfVol = candles.slice(streakStart + Math.ceil(streak / 2), currentIdx + 1).reduce((s, c) => s + c.volume, 0) / Math.max(1, Math.floor(streak / 2));
  if (firstHalfVol > 0 && secondHalfVol < firstHalfVol * 0.8) return { detected: false } as any;
  
  // Cumulative gain >= 1.0%
  const cumulativeGain = (endCandle.close - startCandle.open) / startCandle.open * 100;
  if (cumulativeGain < 1.0) return { detected: false } as any;
  
  // Average body >= 0.3%
  let totalBody = 0;
  for (let i = streakStart; i <= currentIdx; i++) {
    totalBody += (candles[i].close - candles[i].open) / candles[i].open * 100;
  }
  if (totalBody / streak < 0.3) return { detected: false } as any;
  
  let strength = 0;
  if (streak >= 5) strength++;
  if (bprDelta >= 0.10) strength++;
  if (cumulativeGain >= 2.0) strength++;
  
  return { detected: true, peakPrice: endCandle.high, strength, cumulativeGain, bprDelta, consecutiveBulls: streak };
}

async function main() {
  const db = await getDb();
  const dates = ['2026-06-17', '2026-06-18', '2026-06-19', '2026-06-22', '2026-06-23', '2026-06-24', '2026-06-25', '2026-06-26', '2026-06-29', '2026-06-30'];
  
  // Get all symbols that have data
  const [symRows] = await db.execute(sql`SELECT DISTINCT symbol FROM rt_candles WHERE tradeDate >= '2026-06-17'`);
  const symbols = (symRows as any[]).map(r => r.symbol);
  console.log(`銘柄数: ${symbols.length} (${symbols.join(', ')})`);
  
  const LOT = 1_000_000;
  const PULLBACK_MIN = 0.005;
  const PULLBACK_MAX = 0.025;
  const SL_BUFFER = 0.003;
  const TP_PCT = 0.020;
  const MAX_WAIT = 25;
  
  interface Trade {
    date: string; symbol: string; entryTime: string; entryPrice: number;
    exitTime: string; exitPrice: number; pnl: number; pnlPct: number;
    exitReason: string; strength: number; pullbackPct: number;
  }
  
  const allTrades: Trade[] = [];
  
  for (const date of dates) {
    for (const sym of symbols) {
      const [rows] = await db.execute(sql`
        SELECT candleTime, open, high, low, close, volume,
               JSON_EXTRACT(boardSnapshot, '$.signal') as boardSig,
               JSON_EXTRACT(boardSnapshot, '$.buyPressureRatio') as bpr
        FROM rt_candles
        WHERE tradeDate = ${date} AND symbol = ${sym}
        ORDER BY candleTime ASC
      `);
      const candles: Candle[] = (rows as any[]).map(r => ({
        candleTime: r.candleTime,
        open: Number(r.open), high: Number(r.high),
        low: Number(r.low), close: Number(r.close),
        volume: Number(r.volume),
        boardSig: r.boardSig ? String(r.boardSig).replace(/"/g, '') : null,
        bpr: Number(r.bpr) || 0,
      }));
      
      if (candles.length < 10) continue;
      
      let state: 'IDLE' | 'WAITING' | 'IN_POS' = 'IDLE';
      let peakPrice = 0, pullbackLow = Infinity, waitCount = 0;
      let entryPrice = 0, entryTime = '', slPrice = 0, entryStrength = 0, pullbackPct = 0;
      let usedToday = false;
      
      for (let i = 5; i < candles.length; i++) {
        const c = candles[i];
        if (c.candleTime < '09:10') continue;
        
        // Force close at end of day
        if (c.candleTime >= '15:25' && state === 'IN_POS') {
          allTrades.push({
            date, symbol: sym, entryTime, entryPrice,
            exitTime: c.candleTime, exitPrice: c.close,
            pnl: Math.round((c.close - entryPrice) / entryPrice * LOT),
            pnlPct: (c.close - entryPrice) / entryPrice * 100,
            exitReason: '大引け', strength: entryStrength, pullbackPct,
          });
          state = 'IDLE';
          continue;
        }
        
        // No new entries after 11:25 (but keep managing positions)
        if (c.candleTime >= '11:25' && state === 'WAITING') { state = 'IDLE'; }
        
        if (state === 'IN_POS') {
          const tpPrice = entryPrice * (1 + TP_PCT);
          if (c.low <= slPrice) {
            allTrades.push({
              date, symbol: sym, entryTime, entryPrice,
              exitTime: c.candleTime, exitPrice: slPrice,
              pnl: Math.round((slPrice - entryPrice) / entryPrice * LOT),
              pnlPct: (slPrice - entryPrice) / entryPrice * 100,
              exitReason: '損切り', strength: entryStrength, pullbackPct,
            });
            state = 'IDLE';
          } else if (c.high >= tpPrice) {
            allTrades.push({
              date, symbol: sym, entryTime, entryPrice,
              exitTime: c.candleTime, exitPrice: tpPrice,
              pnl: Math.round((tpPrice - entryPrice) / entryPrice * LOT),
              pnlPct: TP_PCT * 100,
              exitReason: '利確', strength: entryStrength, pullbackPct,
            });
            state = 'IDLE';
          }
          continue;
        }
        
        if (state === 'WAITING') {
          waitCount++;
          if (waitCount > MAX_WAIT) { state = 'IDLE'; continue; }
          if (c.low < pullbackLow) pullbackLow = c.low;
          const currentPullback = (peakPrice - pullbackLow) / peakPrice;
          
          if (currentPullback >= PULLBACK_MIN && currentPullback <= PULLBACK_MAX && c.close > c.open) {
            entryPrice = c.close;
            entryTime = c.candleTime;
            slPrice = pullbackLow * (1 - SL_BUFFER);
            pullbackPct = currentPullback * 100;
            state = 'IN_POS';
            usedToday = true;
          }
          continue;
        }
        
        // IDLE - detect pattern
        if (usedToday || c.candleTime >= '11:25') continue;
        
        const bt = detectSellWallBreakthrough(candles, i);
        if (bt.detected) {
          state = 'WAITING';
          peakPrice = bt.peakPrice;
          pullbackLow = candles[i].close;
          waitCount = 0;
          entryStrength = bt.strength;
        }
      }
    }
  }
  
  // Results
  console.log('\n=== 売り板突破パターン 全期間バックテスト (6/17〜6/30) ===\n');
  console.log(`設定: 押し0.5-2.5% / SL=安値-0.3% / TP=+2.0% / 前場限定 / 1銘柄1日1回`);
  console.log(`ロット: 100万円/ポジション\n`);
  
  // Daily summary
  console.log('--- 日別サマリー ---');
  for (const date of dates) {
    const dayTrades = allTrades.filter(t => t.date === date);
    if (dayTrades.length === 0) {
      console.log(`  ${date}: エントリーなし`);
    } else {
      const dayPnl = dayTrades.reduce((s, t) => s + t.pnl, 0);
      const wins = dayTrades.filter(t => t.pnl > 0).length;
      console.log(`  ${date}: ${dayTrades.length}件 | 勝率${wins}/${dayTrades.length} | ${dayPnl >= 0 ? '+' : ''}${dayPnl.toLocaleString()}円`);
    }
  }
  
  // Overall
  const totalPnl = allTrades.reduce((s, t) => s + t.pnl, 0);
  const wins = allTrades.filter(t => t.pnl > 0);
  const losses = allTrades.filter(t => t.pnl <= 0);
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;
  
  console.log('\n--- 全体統計 ---');
  console.log(`  総取引数: ${allTrades.length}件`);
  console.log(`  勝率: ${wins.length}/${allTrades.length} (${allTrades.length > 0 ? (wins.length/allTrades.length*100).toFixed(0) : 0}%)`);
  console.log(`  総損益: ${totalPnl >= 0 ? '+' : ''}${totalPnl.toLocaleString()}円`);
  console.log(`  平均利益: +${Math.round(avgWin).toLocaleString()}円`);
  console.log(`  平均損失: ${Math.round(avgLoss).toLocaleString()}円`);
  console.log(`  損益比: ${avgLoss !== 0 ? Math.abs(avgWin / avgLoss).toFixed(2) : 'N/A'}`);
  console.log(`  期待値: ${allTrades.length > 0 ? Math.round(totalPnl / allTrades.length).toLocaleString() : 0}円/トレード`);
  
  // All trades detail
  console.log('\n--- 全トレード ---');
  for (const t of allTrades) {
    const pnlStr = `${t.pnl >= 0 ? '+' : ''}${t.pnl.toLocaleString()}`;
    console.log(`  ${t.date} ${t.symbol} | ${t.entryTime}@${t.entryPrice.toFixed(0)} → ${t.exitTime}@${t.exitPrice.toFixed(0)} | ${pnlStr}円 (${t.exitReason}) | 強度${t.strength} 押し${t.pullbackPct.toFixed(1)}%`);
  }
  
  // Check down days
  // 6/23, 6/24, 6/26 were down days
  const downDays = ['2026-06-23', '2026-06-24', '2026-06-26'];
  const downDayTrades = allTrades.filter(t => downDays.includes(t.date));
  console.log(`\n安全性: 下落日(6/23,24,26)エントリー = ${downDayTrades.length}件`);
  if (downDayTrades.length > 0) {
    for (const t of downDayTrades) {
      console.log(`  ⚠ ${t.date} ${t.symbol} ${t.entryTime} pnl=${t.pnl}`);
    }
  }
  
  process.exit(0);
}

main();
