/**
 * 売り板突破パターン v2: 押し目待ちエントリー
 * 
 * 改善点:
 * - 突破パターン検出後、即エントリーせず押し目を待つ
 * - 押し目（-0.5%以上の下落）後の反発足でエントリー
 * - SL = 押し目安値 - 0.2%（動的SL）
 * - TP = +1.5%
 * - 有効期限: 検出から20本以内
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
  peakPrice: number;
  startTime: string;
  endTime: string;
  cumulativeGain: number;
  bprDelta: number;
  consecutiveBulls: number;
}

function detectSellWallBreakthrough(candles: Candle[], currentIdx: number): BreakthroughResult {
  const result: BreakthroughResult = {
    detected: false, strength: 0, peakPrice: 0,
    startTime: '', endTime: '', cumulativeGain: 0, bprDelta: 0, consecutiveBulls: 0,
  };

  let streak = 0;
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
  
  result.consecutiveBulls = streak;
  
  // BPR rising
  const startBpr = candles[streakStart].bpr;
  const endBprAvg = (candles[currentIdx].bpr + candles[Math.max(streakStart, currentIdx - 1)].bpr + candles[Math.max(streakStart, currentIdx - 2)].bpr) / Math.min(3, streak);
  result.bprDelta = endBprAvg - startBpr;
  if (result.bprDelta < 0.05) return result;
  
  // Volume maintained
  const firstHalfVol = candles.slice(streakStart, streakStart + Math.ceil(streak / 2)).reduce((s, c) => s + c.volume, 0) / Math.ceil(streak / 2);
  const secondHalfVol = candles.slice(streakStart + Math.ceil(streak / 2), currentIdx + 1).reduce((s, c) => s + c.volume, 0) / Math.max(1, Math.floor(streak / 2));
  if (firstHalfVol > 0 && secondHalfVol < firstHalfVol * 0.8) return result;
  
  // Cumulative gain >= 1.0%
  result.cumulativeGain = (endCandle.close - startCandle.open) / startCandle.open * 100;
  if (result.cumulativeGain < 1.0) return result;
  
  // Average body >= 0.3%
  let totalBody = 0;
  for (let i = streakStart; i <= currentIdx; i++) {
    totalBody += (candles[i].close - candles[i].open) / candles[i].open * 100;
  }
  if (totalBody / streak < 0.3) return result;
  
  result.detected = true;
  result.peakPrice = endCandle.high;
  result.startTime = startCandle.candleTime;
  result.endTime = endCandle.candleTime;
  
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
  pullbackPct: number;
  slPrice: number;
}

async function runSim(params: { pullbackMin: number; pullbackMax: number; slBuffer: number; tpPct: number; maxWait: number; label: string }) {
  const db = await getDb();
  const dates = ['2026-06-23', '2026-06-24', '2026-06-25', '2026-06-26', '2026-06-27', '2026-06-30'];
  const symbols = ['6526', '9984', '6976', '6920', '8035', '6857'];
  const LOT = 1_000_000;
  
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
        open: Number(r.open), high: Number(r.high),
        low: Number(r.low), close: Number(r.close),
        volume: Number(r.volume),
        boardSig: r.boardSig ? String(r.boardSig).replace(/"/g, '') : null,
        bpr: Number(r.bpr) || 0,
      }));
      
      if (candles.length < 10) continue;
      
      // State machine: IDLE → WAITING_PULLBACK → IN_POSITION
      let state: 'IDLE' | 'WAITING_PULLBACK' | 'IN_POSITION' = 'IDLE';
      let peakPrice = 0;
      let pullbackLow = Infinity;
      let waitCount = 0;
      let entryPrice = 0;
      let entryTime = '';
      let slPrice = 0;
      let entryStrength = 0;
      let pullbackPct = 0;
      let usedToday = false;
      
      for (let i = 5; i < candles.length; i++) {
        const c = candles[i];
        if (c.candleTime < '09:10') continue;
        if (c.candleTime >= '15:25' && state === 'IN_POSITION') {
          // Force close
          allTrades.push({
            date, symbol: sym, entryTime, entryPrice,
            exitTime: c.candleTime, exitPrice: c.close,
            pnl: Math.round((c.close - entryPrice) / entryPrice * LOT),
            pnlPct: (c.close - entryPrice) / entryPrice * 100,
            exitReason: '大引け', strength: entryStrength, pullbackPct, slPrice,
          });
          state = 'IDLE';
          continue;
        }
        if (c.candleTime >= '11:25') {
          if (state === 'WAITING_PULLBACK') state = 'IDLE'; // cancel waiting at lunch
          if (state !== 'IN_POSITION') continue;
        }
        
        if (state === 'IN_POSITION') {
          const tpPrice = entryPrice * (1 + params.tpPct);
          if (c.low <= slPrice) {
            allTrades.push({
              date, symbol: sym, entryTime, entryPrice,
              exitTime: c.candleTime, exitPrice: slPrice,
              pnl: Math.round((slPrice - entryPrice) / entryPrice * LOT),
              pnlPct: (slPrice - entryPrice) / entryPrice * 100,
              exitReason: '損切り', strength: entryStrength, pullbackPct, slPrice,
            });
            state = 'IDLE';
          } else if (c.high >= tpPrice) {
            allTrades.push({
              date, symbol: sym, entryTime, entryPrice,
              exitTime: c.candleTime, exitPrice: tpPrice,
              pnl: Math.round((tpPrice - entryPrice) / entryPrice * LOT),
              pnlPct: params.tpPct * 100,
              exitReason: '利確', strength: entryStrength, pullbackPct, slPrice,
            });
            state = 'IDLE';
          }
          continue;
        }
        
        if (state === 'WAITING_PULLBACK') {
          waitCount++;
          if (waitCount > params.maxWait) { state = 'IDLE'; continue; }
          
          // Track pullback low
          if (c.low < pullbackLow) pullbackLow = c.low;
          
          const currentPullback = (peakPrice - pullbackLow) / peakPrice;
          
          // Check if pullback is deep enough AND current candle is a bounce
          if (currentPullback >= params.pullbackMin && currentPullback <= params.pullbackMax) {
            // Bounce condition: close > open (bullish candle after pullback)
            if (c.close > c.open) {
              // Entry!
              entryPrice = c.close;
              entryTime = c.candleTime;
              slPrice = pullbackLow * (1 - params.slBuffer);
              pullbackPct = currentPullback * 100;
              state = 'IN_POSITION';
              usedToday = true;
            }
          }
          continue;
        }
        
        // IDLE state - look for breakthrough pattern
        if (usedToday) continue;
        
        const bt = detectSellWallBreakthrough(candles, i);
        if (bt.detected) {
          state = 'WAITING_PULLBACK';
          peakPrice = bt.peakPrice;
          pullbackLow = c.close; // start tracking from detection
          waitCount = 0;
          entryStrength = bt.strength;
        }
      }
    }
  }
  
  return allTrades;
}

async function main() {
  // Run multiple parameter sets
  const configs = [
    { pullbackMin: 0.003, pullbackMax: 0.015, slBuffer: 0.002, tpPct: 0.015, maxWait: 20, label: 'A: 押し0.3-1.5% / SL安値-0.2% / TP+1.5%' },
    { pullbackMin: 0.005, pullbackMax: 0.020, slBuffer: 0.003, tpPct: 0.015, maxWait: 20, label: 'B: 押し0.5-2.0% / SL安値-0.3% / TP+1.5%' },
    { pullbackMin: 0.003, pullbackMax: 0.015, slBuffer: 0.002, tpPct: 0.010, maxWait: 15, label: 'C: 押し0.3-1.5% / SL安値-0.2% / TP+1.0%' },
    { pullbackMin: 0.005, pullbackMax: 0.025, slBuffer: 0.003, tpPct: 0.020, maxWait: 25, label: 'D: 押し0.5-2.5% / SL安値-0.3% / TP+2.0%' },
  ];
  
  console.log('=== 売り板突破パターン v2: 押し目待ちエントリー シミュレーション ===\n');
  console.log('対象期間: 6/23〜6/30 (6日間)');
  console.log('対象銘柄: 6526, 9984, 6976, 6920, 8035, 6857');
  console.log('ロット: 100万円/ポジション');
  console.log('エントリー: 前場限定(09:10-11:25), 1銘柄1日1回');
  console.log('');
  
  console.log('--- パラメータ比較 ---');
  console.log('設定 | 取引数 | 勝率 | 総損益 | 平均利益 | 平均損失 | 損益比');
  console.log('-----|--------|------|--------|---------|---------|------');
  
  let bestConfig = '';
  let bestPnl = -Infinity;
  let bestTrades: any[] = [];
  
  for (const cfg of configs) {
    const trades = await runSim(cfg);
    const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
    const wins = trades.filter(t => t.pnl > 0);
    const losses = trades.filter(t => t.pnl <= 0);
    const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
    const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;
    const ratio = avgLoss !== 0 ? Math.abs(avgWin / avgLoss) : 0;
    
    console.log(`${cfg.label.substring(0, 4)} | ${trades.length.toString().padStart(4)}件 | ${wins.length}/${trades.length} (${trades.length > 0 ? (wins.length/trades.length*100).toFixed(0) : 0}%) | ${totalPnl >= 0 ? '+' : ''}${totalPnl.toLocaleString().padStart(7)}円 | ${avgWin >= 0 ? '+' : ''}${Math.round(avgWin).toLocaleString().padStart(6)}円 | ${Math.round(avgLoss).toLocaleString().padStart(6)}円 | ${ratio.toFixed(2)}`);
    
    if (totalPnl > bestPnl) {
      bestPnl = totalPnl;
      bestConfig = cfg.label;
      bestTrades = trades;
    }
  }
  
  console.log(`\n最良設定: ${bestConfig}`);
  console.log(`\n--- 最良設定の全トレード詳細 ---`);
  
  if (bestTrades.length === 0) {
    console.log('  エントリーなし');
  } else {
    for (const t of bestTrades) {
      const pnlStr = `${t.pnl >= 0 ? '+' : ''}${t.pnl.toLocaleString()}`;
      console.log(`  ${t.date} ${t.symbol} | entry=${t.entryTime}@${t.entryPrice.toFixed(0)} | exit=${t.exitTime}@${t.exitPrice.toFixed(0)} | ${pnlStr}円 (${t.exitReason}) | 押し${t.pullbackPct.toFixed(1)}% SL=${t.slPrice.toFixed(0)}`);
    }
    
    // Safety check
    const downDays = ['2026-06-23', '2026-06-24', '2026-06-26'];
    const downDayTrades = bestTrades.filter(t => downDays.includes(t.date));
    console.log(`\n安全性: 下落日エントリー = ${downDayTrades.length}件`);
  }
  
  process.exit(0);
}

main();
