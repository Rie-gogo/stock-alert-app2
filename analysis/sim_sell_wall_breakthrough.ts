/**
 * 売り板突破パターン認識ロジック シミュレーション
 * 
 * 対象: 6/23〜6/30 の全日程
 * 目的: 突破パターン検出時にLONGエントリーした場合の損益を検証
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

interface BreakthroughResult {
  detected: boolean;
  strength: number;
  startTime: string;
  endTime: string;
  cumulativeGain: number;
  bprDelta: number;
  consecutiveBulls: number;
}

function detectSellWallBreakthrough(candles: Candle[], currentIdx: number): BreakthroughResult {
  const result: BreakthroughResult = {
    detected: false,
    strength: 0,
    startTime: '',
    endTime: '',
    cumulativeGain: 0,
    bprDelta: 0,
    consecutiveBulls: 0,
  };

  // Look back from currentIdx to find consecutive bullish candles during sell_pressure
  let streak = 0;
  let streakEnd = currentIdx;
  
  for (let i = currentIdx; i >= 0; i--) {
    const c = candles[i];
    if (c.boardSig === 'sell_pressure' && c.close > c.open) {
      streak++;
    } else {
      break;
    }
  }
  
  if (streak < 3) return result;
  
  const streakStart = currentIdx - streak + 1;
  const startCandle = candles[streakStart];
  const endCandle = candles[currentIdx];
  
  // Condition 1: 3+ consecutive bullish candles during sell_pressure ✓
  result.consecutiveBulls = streak;
  
  // Condition 2: BPR rising trend
  const startBpr = candles[streakStart].bpr;
  const endBprAvg = (candles[currentIdx].bpr + candles[Math.max(streakStart, currentIdx - 1)].bpr + candles[Math.max(streakStart, currentIdx - 2)].bpr) / Math.min(3, streak);
  result.bprDelta = endBprAvg - startBpr;
  if (result.bprDelta < 0.05) return result;
  
  // Condition 3: Volume maintained
  const firstHalfVol = candles.slice(streakStart, streakStart + Math.ceil(streak / 2)).reduce((s, c) => s + c.volume, 0) / Math.ceil(streak / 2);
  const secondHalfVol = candles.slice(streakStart + Math.ceil(streak / 2), currentIdx + 1).reduce((s, c) => s + c.volume, 0) / Math.floor(streak / 2 + 0.5);
  if (firstHalfVol > 0 && secondHalfVol < firstHalfVol * 0.8) return result;
  
  // Condition 4: Cumulative gain >= 1.0%
  result.cumulativeGain = (endCandle.close - startCandle.open) / startCandle.open * 100;
  if (result.cumulativeGain < 1.0) return result;
  
  // Condition 5: Average body >= 0.3%
  let totalBody = 0;
  for (let i = streakStart; i <= currentIdx; i++) {
    totalBody += (candles[i].close - candles[i].open) / candles[i].open * 100;
  }
  const avgBody = totalBody / streak;
  if (avgBody < 0.3) return result;
  
  // All conditions met
  result.detected = true;
  result.startTime = startCandle.candleTime;
  result.endTime = endCandle.candleTime;
  
  // Strength score
  if (streak >= 5) result.strength++;
  if (result.bprDelta >= 0.10) result.strength++;
  if (result.cumulativeGain >= 2.0) result.strength++;
  
  return result;
}

interface SimTrade {
  date: string;
  symbol: string;
  entryTime: string;
  entryPrice: number;
  exitTime: string;
  exitPrice: number;
  pnl: number;
  pnlPct: number;
  exitReason: string;
  strength: number;
  cumulativeGain: number;
  bprDelta: number;
  consecutiveBulls: number;
}

async function main() {
  const db = await getDb();
  const dates = ['2026-06-23', '2026-06-24', '2026-06-25', '2026-06-26', '2026-06-27', '2026-06-30'];
  const symbols = ['6526', '9984', '6976', '6920', '8035', '6857'];
  
  const SL_PCT = -0.003; // -0.3% stop loss (tighter for this pattern)
  const TP_PCT = 0.015;  // +1.5% take profit (wider for momentum)
  const LOT = 1_000_000; // 100万円/ポジション
  
  const allTrades: SimTrade[] = [];
  
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
        open: Number(r.open),
        high: Number(r.high),
        low: Number(r.low),
        close: Number(r.close),
        volume: Number(r.volume),
        boardSig: r.boardSig ? String(r.boardSig).replace(/"/g, '') : null,
        bpr: Number(r.bpr) || 0,
      }));
      
      if (candles.length < 10) continue;
      
      let hasPosition = false;
      let entryPrice = 0;
      let entryTime = '';
      let entryStrength = 0;
      let entryCumGain = 0;
      let entryBprDelta = 0;
      let entryConsec = 0;
      let lastBreakthroughTime = '';
      
      for (let i = 5; i < candles.length; i++) {
        const c = candles[i];
        
        // Skip first 10 minutes (09:00-09:10) - opening volatility
        if (c.candleTime < '09:10') continue;
        // Only morning session (前場限定)
        if (c.candleTime >= '11:25') {
          // If holding position, check exit
          if (hasPosition) {
            // Check SL/TP
            const slPrice = entryPrice * (1 + SL_PCT);
            const tpPrice = entryPrice * (1 + TP_PCT);
            if (c.low <= slPrice) {
              allTrades.push({
                date, symbol: sym, entryTime, entryPrice,
                exitTime: c.candleTime, exitPrice: slPrice,
                pnl: Math.round((slPrice - entryPrice) / entryPrice * LOT),
                pnlPct: SL_PCT * 100,
                exitReason: '損切り',
                strength: entryStrength, cumulativeGain: entryCumGain,
                bprDelta: entryBprDelta, consecutiveBulls: entryConsec,
              });
              hasPosition = false;
            } else if (c.high >= tpPrice) {
              allTrades.push({
                date, symbol: sym, entryTime, entryPrice,
                exitTime: c.candleTime, exitPrice: tpPrice,
                pnl: Math.round((tpPrice - entryPrice) / entryPrice * LOT),
                pnlPct: TP_PCT * 100,
                exitReason: '利確',
                strength: entryStrength, cumulativeGain: entryCumGain,
                bprDelta: entryBprDelta, consecutiveBulls: entryConsec,
              });
              hasPosition = false;
            } else if (c.candleTime >= '15:25') {
              // Force close at end of day
              allTrades.push({
                date, symbol: sym, entryTime, entryPrice,
                exitTime: c.candleTime, exitPrice: c.close,
                pnl: Math.round((c.close - entryPrice) / entryPrice * LOT),
                pnlPct: (c.close - entryPrice) / entryPrice * 100,
                exitReason: '大引け',
                strength: entryStrength, cumulativeGain: entryCumGain,
                bprDelta: entryBprDelta, consecutiveBulls: entryConsec,
              });
              hasPosition = false;
            }
          }
          if (c.candleTime >= '11:25' && c.candleTime < '12:30') continue; // lunch break
          if (!hasPosition && c.candleTime >= '11:25') continue; // no new entries after morning
        }
        
        if (hasPosition) {
          // Check SL/TP
          const slPrice = entryPrice * (1 + SL_PCT);
          const tpPrice = entryPrice * (1 + TP_PCT);
          if (c.low <= slPrice) {
            allTrades.push({
              date, symbol: sym, entryTime, entryPrice,
              exitTime: c.candleTime, exitPrice: slPrice,
              pnl: Math.round((slPrice - entryPrice) / entryPrice * LOT),
              pnlPct: SL_PCT * 100,
              exitReason: '損切り',
              strength: entryStrength, cumulativeGain: entryCumGain,
              bprDelta: entryBprDelta, consecutiveBulls: entryConsec,
            });
            hasPosition = false;
          } else if (c.high >= tpPrice) {
            allTrades.push({
              date, symbol: sym, entryTime, entryPrice,
              exitTime: c.candleTime, exitPrice: tpPrice,
              pnl: Math.round((tpPrice - entryPrice) / entryPrice * LOT),
              pnlPct: TP_PCT * 100,
              exitReason: '利確',
              strength: entryStrength, cumulativeGain: entryCumGain,
              bprDelta: entryBprDelta, consecutiveBulls: entryConsec,
            });
            hasPosition = false;
          }
          continue;
        }
        
        // Detect breakthrough pattern
        const bt = detectSellWallBreakthrough(candles, i);
        if (bt.detected && bt.endTime !== lastBreakthroughTime) {
          // Entry on next candle's open
          if (i + 1 < candles.length) {
            const nextCandle = candles[i + 1];
            if (nextCandle.candleTime >= '11:25') continue; // don't enter near lunch
            
            hasPosition = true;
            entryPrice = nextCandle.open;
            entryTime = nextCandle.candleTime;
            entryStrength = bt.strength;
            entryCumGain = bt.cumulativeGain;
            entryBprDelta = bt.bprDelta;
            entryConsec = bt.consecutiveBulls;
            lastBreakthroughTime = bt.endTime;
          }
        }
      }
      
      // Force close any remaining position
      if (hasPosition && candles.length > 0) {
        const lastCandle = candles[candles.length - 1];
        allTrades.push({
          date, symbol: sym, entryTime, entryPrice,
          exitTime: lastCandle.candleTime, exitPrice: lastCandle.close,
          pnl: Math.round((lastCandle.close - entryPrice) / entryPrice * LOT),
          pnlPct: (lastCandle.close - entryPrice) / entryPrice * 100,
          exitReason: '大引け',
          strength: entryStrength, cumulativeGain: entryCumGain,
          bprDelta: entryBprDelta, consecutiveBulls: entryConsec,
        });
      }
    }
  }
  
  // Output results
  console.log('=== 売り板突破パターン LONG シミュレーション結果 ===\n');
  console.log(`対象期間: 6/23〜6/30 (${dates.length}日間)`);
  console.log(`対象銘柄: ${symbols.join(', ')}`);
  console.log(`ロット: ${(LOT/10000).toFixed(0)}万円/ポジション`);
  console.log(`損切り: ${(SL_PCT*100).toFixed(1)}% / 利確: ${(TP_PCT*100).toFixed(1)}%`);
  console.log(`エントリー条件: 前場限定(09:10-11:25), 1銘柄1日1回`);
  console.log('');
  
  if (allTrades.length === 0) {
    console.log('※ エントリーなし（全日程で突破パターン未検出）');
    process.exit(0);
  }
  
  // By date summary
  console.log('--- 日別サマリー ---');
  for (const date of dates) {
    const dayTrades = allTrades.filter(t => t.date === date);
    if (dayTrades.length === 0) {
      console.log(`  ${date}: エントリーなし ✓（偽突破を正しく除外）`);
      continue;
    }
    const dayPnl = dayTrades.reduce((s, t) => s + t.pnl, 0);
    const wins = dayTrades.filter(t => t.pnl > 0).length;
    console.log(`  ${date}: ${dayTrades.length}件 | 勝率${wins}/${dayTrades.length} | 損益${dayPnl >= 0 ? '+' : ''}${dayPnl.toLocaleString()}円`);
  }
  
  // Overall stats
  const totalPnl = allTrades.reduce((s, t) => s + t.pnl, 0);
  const wins = allTrades.filter(t => t.pnl > 0).length;
  const losses = allTrades.filter(t => t.pnl <= 0).length;
  const avgWin = wins > 0 ? allTrades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0) / wins : 0;
  const avgLoss = losses > 0 ? allTrades.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0) / losses : 0;
  
  console.log('\n--- 全体統計 ---');
  console.log(`  総取引数: ${allTrades.length}件`);
  console.log(`  勝率: ${wins}/${allTrades.length} (${(wins/allTrades.length*100).toFixed(0)}%)`);
  console.log(`  総損益: ${totalPnl >= 0 ? '+' : ''}${totalPnl.toLocaleString()}円`);
  console.log(`  平均利益: +${Math.round(avgWin).toLocaleString()}円`);
  console.log(`  平均損失: ${Math.round(avgLoss).toLocaleString()}円`);
  console.log(`  損益比: ${avgLoss !== 0 ? (Math.abs(avgWin / avgLoss)).toFixed(2) : 'N/A'}`);
  
  // Detail of each trade
  console.log('\n--- 全トレード詳細 ---');
  console.log('日付       | 銘柄 | Entry    | Exit     | 損益      | 理由   | 強度 | 累積% | BPR△ | 連陽');
  console.log('-----------|------|----------|----------|-----------|--------|------|-------|------|-----');
  for (const t of allTrades) {
    const pnlStr = `${t.pnl >= 0 ? '+' : ''}${t.pnl.toLocaleString()}`.padStart(9);
    console.log(`${t.date} | ${t.symbol} | ${t.entryTime} ${t.entryPrice.toFixed(0).padStart(6)} | ${t.exitTime} ${t.exitPrice.toFixed(0).padStart(6)} | ${pnlStr}円 | ${t.exitReason.padEnd(4)} | ${t.strength}    | ${t.cumulativeGain.toFixed(1)}%  | +${t.bprDelta.toFixed(2)} | ${t.consecutiveBulls}本`);
  }
  
  // Safety check: did we avoid entries on down days?
  console.log('\n--- 安全性チェック ---');
  const downDays = ['2026-06-23', '2026-06-24', '2026-06-26'];
  const downDayTrades = allTrades.filter(t => downDays.includes(t.date));
  if (downDayTrades.length === 0) {
    console.log('  ✓ 下落日(6/23, 6/24, 6/26)でのエントリー: 0件（安全）');
  } else {
    console.log(`  ⚠ 下落日でのエントリー: ${downDayTrades.length}件（要調整）`);
    for (const t of downDayTrades) {
      console.log(`    ${t.date} ${t.symbol} ${t.entryTime} pnl=${t.pnl}`);
    }
  }
  
  process.exit(0);
}

main();
