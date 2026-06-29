import { getDb } from '../server/db';
import { sql } from 'drizzle-orm';

/**
 * 大台割れ Ver5 シミュレーション
 * 条件: 板スコア>=2 AND BPR>=0.44 AND BPR<0.54 AND ADX<30
 * 
 * 比較: 現行（全大台割れエントリー）vs Ver5（条件フィルター適用）
 */

interface Candle {
  candleTime: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  boardSnapshot: any;
}

// Simple ADX calculation
function calcADX(candles: Candle[], period: number = 14): number[] {
  const adx: number[] = new Array(candles.length).fill(0);
  if (candles.length < period * 2) return adx;
  
  const trueRanges: number[] = [];
  const plusDMs: number[] = [];
  const minusDMs: number[] = [];
  
  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i-1].close;
    const prevHigh = candles[i-1].high;
    const prevLow = candles[i-1].low;
    
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    const plusDM = (high - prevHigh) > (prevLow - low) ? Math.max(high - prevHigh, 0) : 0;
    const minusDM = (prevLow - low) > (high - prevHigh) ? Math.max(prevLow - low, 0) : 0;
    
    trueRanges.push(tr);
    plusDMs.push(plusDM);
    minusDMs.push(minusDM);
  }
  
  // Smoothed TR, +DM, -DM
  let smoothTR = trueRanges.slice(0, period).reduce((a, b) => a + b, 0);
  let smoothPlusDM = plusDMs.slice(0, period).reduce((a, b) => a + b, 0);
  let smoothMinusDM = minusDMs.slice(0, period).reduce((a, b) => a + b, 0);
  
  const dxValues: number[] = [];
  
  for (let i = period; i < trueRanges.length; i++) {
    if (i > period) {
      smoothTR = smoothTR - smoothTR / period + trueRanges[i];
      smoothPlusDM = smoothPlusDM - smoothPlusDM / period + plusDMs[i];
      smoothMinusDM = smoothMinusDM - smoothMinusDM / period + minusDMs[i];
    }
    
    const plusDI = smoothTR > 0 ? (smoothPlusDM / smoothTR) * 100 : 0;
    const minusDI = smoothTR > 0 ? (smoothMinusDM / smoothTR) * 100 : 0;
    const diSum = plusDI + minusDI;
    const dx = diSum > 0 ? Math.abs(plusDI - minusDI) / diSum * 100 : 0;
    dxValues.push(dx);
    
    if (dxValues.length >= period) {
      const adxVal = dxValues.slice(-period).reduce((a, b) => a + b, 0) / period;
      adx[i + 1] = adxVal; // +1 because trueRanges starts at index 1
    }
  }
  
  return adx;
}

// Board reading score calculation (simplified from realtimeSimEngine.ts)
function calcBoardScore(bs: any, side: 'short'): number {
  if (!bs) return 0;
  let score = 0;
  
  // E: Board pressure strength (BPR)
  if (side === 'short') {
    if (bs.buyPressureRatio <= 0.45) score += 1;
    else if (bs.buyPressureRatio >= 0.65) score -= 1;
  }
  
  // D: Market mode (simplified)
  if (bs.marketOrderRatio >= 0.08) score += 1;
  
  // G: Iceberg detection
  if (side === 'short' && bs.icebergAskDetected) score += 1;
  
  // F: Market order direction
  if (side === 'short' && bs.marketOrderDirection === 'downtick') score += 2;
  else if (side === 'short' && bs.marketOrderDirection === 'uptick') score -= 2;
  
  // B: Large wall anomaly
  if (side === 'short' && bs.largeSellWall) score -= 1; // sell wall blocks short
  if (side === 'short' && bs.largeBuyWall) score += 1; // buy wall = trapped longs
  
  // A: Aggressive orders (simplified - use marketOrderRatio as proxy)
  if (bs.marketOrderRatio >= 0.08) {
    if (side === 'short' && bs.marketOrderDirection === 'downtick') score += 2;
  }
  
  return score;
}

// Detect round number break - matches production logic (100円 fixed step)
function detectRoundBreak(candles: Candle[], idx: number, maintainBars: number = 5): { detected: boolean; level: number } {
  if (idx < 1) return { detected: false, level: 0 };
  
  const prev = candles[idx - 1].close;
  const curr = candles[idx].close;
  const step = 100; // 100円単位のキリ番（本番と同じ）
  
  const prevLevel = Math.floor(prev / step) * step;
  const currLevel = Math.floor(curr / step) * step;
  
  // 下方向にキリ番を割った
  if (currLevel < prevLevel) {
    const level = currLevel + step; // 割り込んだキリ番
    
    // maintainBars本の維持確認（本番のステートマシンを簡略化）
    // 本番では5本待機するが、ここでは「直前maintainBars本がlevel以上」で代用
    if (idx >= maintainBars) {
      let maintained = true;
      for (let j = 1; j <= maintainBars; j++) {
        if (candles[idx - j].close < level) {
          maintained = false;
          break;
        }
      }
      if (maintained) {
        return { detected: true, level };
      }
    }
  }
  
  return { detected: false, level: 0 };
}

async function main() {
  const db = await getDb();
  
  // Get all dates
  const dateResult = await db.execute(
    sql`SELECT DISTINCT tradeDate FROM rt_candles ORDER BY tradeDate`
  ) as any;
  const dates = (dateResult[0] ?? dateResult).map((r: any) => r.tradeDate);
  console.log(`データ期間: ${dates.length}日 (${dates[0]} 〜 ${dates[dates.length - 1]})`);
  
  // Get all symbols
  const symResult = await db.execute(
    sql`SELECT DISTINCT symbol FROM rt_candles`
  ) as any;
  const symbols = (symResult[0] ?? symResult).map((r: any) => r.symbol);
  
  // Results
  interface Trade {
    date: string;
    time: string;
    symbol: string;
    entryPrice: number;
    exitPrice: number;
    pnl: number;
    exitReason: string;
    bpr: number;
    boardScore: number;
    adx: number;
    v5Pass: boolean;
  }
  
  const allTrades: Trade[] = [];
  
  const SL_PCT = 0.005;
  const TP_PCT = 0.015;
  
  for (const date of dates) {
    for (const sym of symbols) {
      // Get candles for this date/symbol
      const candleResult = await db.execute(
        sql`SELECT candleTime, open, high, low, close, volume, boardSnapshot 
            FROM rt_candles 
            WHERE tradeDate = ${date} AND symbol = ${sym}
            ORDER BY candleTime`
      ) as any;
      const candles: Candle[] = (candleResult[0] ?? candleResult).map((r: any) => ({
        candleTime: r.candleTime,
        open: Number(r.open),
        high: Number(r.high),
        low: Number(r.low),
        close: Number(r.close),
        volume: Number(r.volume),
        boardSnapshot: typeof r.boardSnapshot === 'string' ? JSON.parse(r.boardSnapshot) : r.boardSnapshot,
      }));
      
      if (candles.length < 30) continue;
      
      // Calculate ADX
      const adxValues = calcADX(candles, 14);
      
      // Scan for round number breaks
      let inPosition = false;
      let entryPrice = 0;
      let entryBar = 0;
      let entryBpr = 0;
      let entryBoardScore = 0;
      let entryAdx = 0;
      let entryTime = '';
      
      for (let i = 10; i < candles.length; i++) {
        const c = candles[i];
        const hour = parseInt(c.candleTime.split(':')[0]);
        const min = parseInt(c.candleTime.split(':')[1]);
        
        // Skip lunch break
        if (hour === 11 && min >= 30) continue;
        if (hour === 12 && min < 30) continue;
        
        if (inPosition) {
          // Check exits
          const pnlPct = (entryPrice - c.close) / entryPrice; // short
          
          let exitReason = '';
          let exitPrice = c.close;
          
          if (c.high >= entryPrice * (1 + SL_PCT)) {
            exitReason = '損切り';
            exitPrice = entryPrice * (1 + SL_PCT);
          } else if (c.low <= entryPrice * (1 - TP_PCT)) {
            exitReason = '利確';
            exitPrice = entryPrice * (1 - TP_PCT);
          } else if (hour === 15 && min >= 25) {
            exitReason = '大引け';
            exitPrice = c.close;
          } else if (i - entryBar >= 60) {
            exitReason = '時間切れ';
            exitPrice = c.close;
          }
          
          if (exitReason) {
            const pnl = Math.round((entryPrice - exitPrice) * 100); // 100 shares
            allTrades.push({
              date, time: entryTime, symbol: sym,
              entryPrice, exitPrice, pnl, exitReason,
              bpr: entryBpr, boardScore: entryBoardScore, adx: entryAdx,
              v5Pass: entryBoardScore >= 2 && entryBpr >= 0.44 && entryBpr < 0.54 && entryAdx < 30,
            });
            inPosition = false;
          }
        } else {
          // Check for round number break (SHORT only)
          const rb = detectRoundBreak(candles, i, 3); // 3本維持
          if (rb.detected) {
            const bs = c.boardSnapshot;
            const bpr = bs?.buyPressureRatio ?? 0.5;
            const boardScore = calcBoardScore(bs, 'short');
            const adx = adxValues[i] ?? 0;
            
            inPosition = true;
            entryPrice = c.close;
            entryBar = i;
            entryBpr = bpr;
            entryBoardScore = boardScore;
            entryAdx = adx;
            entryTime = c.candleTime;
          }
        }
      }
      
      // Force close at end of day
      if (inPosition) {
        const lastCandle = candles[candles.length - 1];
        const pnl = Math.round((entryPrice - lastCandle.close) * 100);
        allTrades.push({
          date, time: entryTime, symbol: sym,
          entryPrice, exitPrice: lastCandle.close, pnl, exitReason: '大引け',
          bpr: entryBpr, boardScore: entryBoardScore, adx: entryAdx,
          v5Pass: entryBoardScore >= 2 && entryBpr >= 0.44 && entryBpr < 0.54 && entryAdx < 30,
        });
      }
    }
  }
  
  // Results
  console.log(`\n=== 大台割れ全取引: ${allTrades.length}件 ===\n`);
  
  const currentTrades = allTrades;
  const v5Trades = allTrades.filter(t => t.v5Pass);
  const blockedTrades = allTrades.filter(t => !t.v5Pass);
  
  const sum = (arr: Trade[]) => arr.reduce((s, t) => s + t.pnl, 0);
  const wins = (arr: Trade[]) => arr.filter(t => t.pnl > 0).length;
  const losses = (arr: Trade[]) => arr.filter(t => t.pnl < 0).length;
  const avgWin = (arr: Trade[]) => {
    const w = arr.filter(t => t.pnl > 0);
    return w.length > 0 ? Math.round(w.reduce((s, t) => s + t.pnl, 0) / w.length) : 0;
  };
  const avgLoss = (arr: Trade[]) => {
    const l = arr.filter(t => t.pnl < 0);
    return l.length > 0 ? Math.round(l.reduce((s, t) => s + t.pnl, 0) / l.length) : 0;
  };
  const maxDD = (arr: Trade[]) => {
    let peak = 0, dd = 0, maxDd = 0;
    for (const t of arr) {
      peak += t.pnl;
      if (peak < dd) { dd = peak; }
      const currentDD = peak - dd;
      // Actually track drawdown properly
    }
    // Simple: worst cumulative drawdown
    let cum = 0, peakCum = 0, worstDD = 0;
    for (const t of arr) {
      cum += t.pnl;
      if (cum > peakCum) peakCum = cum;
      const drawdown = peakCum - cum;
      if (drawdown > worstDD) worstDD = drawdown;
    }
    return worstDD;
  };
  const pf = (arr: Trade[]) => {
    const grossProfit = arr.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
    const grossLoss = Math.abs(arr.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
    return grossLoss > 0 ? (grossProfit / grossLoss).toFixed(2) : 'Inf';
  };
  
  console.log('=== 現行（全大台割れ） ===');
  console.log(`件数: ${currentTrades.length}`);
  console.log(`勝敗: ${wins(currentTrades)}勝 ${losses(currentTrades)}敗`);
  console.log(`勝率: ${(wins(currentTrades) / currentTrades.length * 100).toFixed(1)}%`);
  console.log(`P&L: ${sum(currentTrades).toLocaleString()}円`);
  console.log(`平均利益: ${avgWin(currentTrades).toLocaleString()}円`);
  console.log(`平均損失: ${avgLoss(currentTrades).toLocaleString()}円`);
  console.log(`最大DD: ${maxDD(currentTrades).toLocaleString()}円`);
  console.log(`PF: ${pf(currentTrades)}`);
  
  console.log('\n=== Ver5（板スコア>=2 + BPR 0.44-0.54 + ADX<30） ===');
  console.log(`件数: ${v5Trades.length}`);
  if (v5Trades.length > 0) {
    console.log(`勝敗: ${wins(v5Trades)}勝 ${losses(v5Trades)}敗`);
    console.log(`勝率: ${(wins(v5Trades) / v5Trades.length * 100).toFixed(1)}%`);
    console.log(`P&L: ${sum(v5Trades).toLocaleString()}円`);
    console.log(`平均利益: ${avgWin(v5Trades).toLocaleString()}円`);
    console.log(`平均損失: ${avgLoss(v5Trades).toLocaleString()}円`);
    console.log(`最大DD: ${maxDD(v5Trades).toLocaleString()}円`);
    console.log(`PF: ${pf(v5Trades)}`);
  } else {
    console.log('通過取引なし');
  }
  
  console.log('\n=== ブロックされた取引 ===');
  console.log(`件数: ${blockedTrades.length}`);
  console.log(`勝敗: ${wins(blockedTrades)}勝 ${losses(blockedTrades)}敗`);
  console.log(`P&L: ${sum(blockedTrades).toLocaleString()}円`);
  
  // Per-date breakdown
  console.log('\n=== 日別内訳 ===');
  for (const date of dates) {
    const dayAll = allTrades.filter(t => t.date === date);
    const dayV5 = v5Trades.filter(t => t.date === date);
    if (dayAll.length > 0) {
      console.log(`${date}: 全${dayAll.length}件(${sum(dayAll).toLocaleString()}円) → Ver5: ${dayV5.length}件(${sum(dayV5).toLocaleString()}円)`);
    }
  }
  
  // Show Ver5 trades detail
  console.log('\n=== Ver5通過取引の詳細 ===');
  for (const t of v5Trades) {
    const result = t.pnl > 0 ? '✓' : '✗';
    console.log(`${result} ${t.date} ${t.time} ${t.symbol} @${t.entryPrice} → ${t.exitReason} P&L=${t.pnl.toLocaleString()}円 | BPR=${t.bpr.toFixed(3)} Score=${t.boardScore} ADX=${t.adx.toFixed(1)}`);
  }
  
  // Condition distribution
  console.log('\n=== 条件分布 ===');
  const scorePass = allTrades.filter(t => t.boardScore >= 2);
  const bprPass = allTrades.filter(t => t.bpr >= 0.44 && t.bpr < 0.54);
  const adxPass = allTrades.filter(t => t.adx < 30);
  console.log(`板スコア>=2: ${scorePass.length}件 (勝率${(wins(scorePass)/scorePass.length*100).toFixed(1)}%, P&L=${sum(scorePass).toLocaleString()}円)`);
  console.log(`BPR 0.44-0.54: ${bprPass.length}件 (勝率${bprPass.length > 0 ? (wins(bprPass)/bprPass.length*100).toFixed(1) : 0}%, P&L=${sum(bprPass).toLocaleString()}円)`);
  console.log(`ADX<30: ${adxPass.length}件 (勝率${adxPass.length > 0 ? (wins(adxPass)/adxPass.length*100).toFixed(1) : 0}%, P&L=${sum(adxPass).toLocaleString()}円)`);
  
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
