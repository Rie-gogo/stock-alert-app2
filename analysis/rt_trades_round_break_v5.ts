import { getDb } from '../server/db';
import { sql } from 'drizzle-orm';

/**
 * 実際のrt_tradesから大台割れ取引を抽出し、Ver5条件で再検証
 * 
 * Ver5条件:
 *   板スコア >= 2
 *   AND 買い圧力比率 >= 0.44
 *   AND 買い圧力比率 < 0.54
 *   AND ADX < 30
 */

interface RtTrade {
  id: number;
  symbol: string;
  tradeDate: string;
  candleTime: string;
  action: string;
  price: number;
  reason: string;
  pnl: number | null;
  boardSignal: string | null;
  confidence: string | null;
}

async function main() {
  const db = await getDb();
  
  // 1. Get all round-break entry trades
  const entryResult = await db.execute(
    sql`SELECT id, symbol, tradeDate, tradeTime, action, price, reason, boardSignal, side
        FROM rt_trades 
        WHERE reason LIKE '%大台割れ%'
        AND (action = 'sell' OR action = 'short' OR side = 'short')
        AND pnl IS NULL
        ORDER BY tradeDate, tradeTime`
  ) as any;
  const entries: RtTrade[] = (entryResult[0] ?? entryResult).map((r: any) => ({
    id: r.id,
    symbol: r.symbol,
    tradeDate: r.tradeDate,
    candleTime: r.tradeTime,
    action: r.action,
    price: Number(r.price),
    reason: r.reason,
    pnl: null,
    boardSignal: r.boardSignal,
    confidence: 'unknown',
  }));
  
  console.log(`=== 大台割れエントリー: ${entries.length}件 ===\n`);
  
  // 2. For each entry, find the corresponding exit and get board data from rt_candles
  interface TradeResult {
    date: string;
    time: string;
    symbol: string;
    entryPrice: number;
    exitPrice: number;
    pnl: number;
    exitReason: string;
    confidence: string;
    boardSignal: string;
    bpr: number;
    boardScore: number;
    adx: number;
    v5Pass: boolean;
  }
  
  const results: TradeResult[] = [];
  
  for (const entry of entries) {
    // Find the exit for this entry (next trade with pnl for same symbol on same date after this time)
    const exitResult = await db.execute(
      sql`SELECT id, symbol, tradeDate, tradeTime, action, price, reason, pnl
          FROM rt_trades 
          WHERE symbol = ${entry.symbol}
          AND tradeDate = ${entry.tradeDate}
          AND tradeTime > ${entry.candleTime}
          AND pnl IS NOT NULL
          ORDER BY tradeTime
          LIMIT 1`
    ) as any;
    const exits = exitResult[0] ?? exitResult;
    
    let exitPrice = entry.price;
    let exitReason = '不明';
    let pnl = 0;
    
    if (exits.length > 0) {
      exitPrice = Number(exits[0].price);
      exitReason = exits[0].reason || exits[0].action;
      pnl = Number(exits[0].pnl) || Math.round((entry.price - exitPrice) * 100);
    }
    
    // Get board data from rt_candles at entry time
    const candleResult = await db.execute(
      sql`SELECT boardSnapshot FROM rt_candles 
          WHERE symbol = ${entry.symbol}
          AND tradeDate = ${entry.tradeDate}
          AND candleTime = ${entry.candleTime}
          LIMIT 1`
    ) as any;
    const candleRows = candleResult[0] ?? candleResult;
    
    let bpr = 0.5;
    let boardScore = 0;
    
    if (candleRows.length > 0) {
      const bs = typeof candleRows[0].boardSnapshot === 'string' 
        ? JSON.parse(candleRows[0].boardSnapshot) 
        : candleRows[0].boardSnapshot;
      
      if (bs) {
        bpr = bs.buyPressureRatio ?? 0.5;
        // Use the actual board score from the snapshot if available
        // Otherwise calculate from components
        boardScore = calcBoardScoreFromSnapshot(bs);
      }
    }
    
    // Get ADX from nearby candles (need 14+ candles before)
    const adxResult = await db.execute(
      sql`SELECT high, low, close FROM rt_candles 
          WHERE symbol = ${entry.symbol}
          AND tradeDate = ${entry.tradeDate}
          AND candleTime <= ${entry.candleTime}
          ORDER BY candleTime DESC
          LIMIT 30`
    ) as any;
    const adxCandles = (adxResult[0] ?? adxResult).reverse();
    const adx = calcADXFromCandles(adxCandles);
    
    const v5Pass = boardScore >= 2 && bpr >= 0.44 && bpr < 0.54 && adx < 30;
    
    results.push({
      date: entry.tradeDate,
      time: entry.candleTime,
      symbol: entry.symbol,
      entryPrice: entry.price,
      exitPrice,
      pnl,
      exitReason,
      confidence: entry.confidence || 'unknown',
      boardSignal: entry.boardSignal || 'unknown',
      bpr,
      boardScore,
      adx,
      v5Pass,
    });
  }
  
  // 3. Output results
  console.log(`\n=== 全${results.length}件の大台割れ取引（実データ） ===\n`);
  
  const wins = results.filter(t => t.pnl > 0);
  const losses = results.filter(t => t.pnl < 0);
  const totalPnl = results.reduce((s, t) => s + t.pnl, 0);
  
  console.log('--- 現行（全件） ---');
  console.log(`件数: ${results.length}`);
  console.log(`勝敗: ${wins.length}勝 ${losses.length}敗`);
  console.log(`勝率: ${(wins.length / results.length * 100).toFixed(1)}%`);
  console.log(`P&L: ${totalPnl.toLocaleString()}円`);
  console.log(`平均利益: ${wins.length > 0 ? Math.round(wins.reduce((s, t) => s + t.pnl, 0) / wins.length).toLocaleString() : 0}円`);
  console.log(`平均損失: ${losses.length > 0 ? Math.round(losses.reduce((s, t) => s + t.pnl, 0) / losses.length).toLocaleString() : 0}円`);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  console.log(`PF: ${grossLoss > 0 ? (grossProfit / grossLoss).toFixed(2) : 'Inf'}`);
  
  // Ver5
  const v5Trades = results.filter(t => t.v5Pass);
  const v5Wins = v5Trades.filter(t => t.pnl > 0);
  const v5Losses = v5Trades.filter(t => t.pnl < 0);
  const v5Pnl = v5Trades.reduce((s, t) => s + t.pnl, 0);
  
  console.log('\n--- Ver5（板スコア>=2 + BPR 0.44-0.54 + ADX<30） ---');
  console.log(`件数: ${v5Trades.length}`);
  if (v5Trades.length > 0) {
    console.log(`勝敗: ${v5Wins.length}勝 ${v5Losses.length}敗`);
    console.log(`勝率: ${(v5Wins.length / v5Trades.length * 100).toFixed(1)}%`);
    console.log(`P&L: ${v5Pnl.toLocaleString()}円`);
  } else {
    console.log('通過取引なし');
  }
  
  // Blocked
  const blocked = results.filter(t => !t.v5Pass);
  const blockedWins = blocked.filter(t => t.pnl > 0);
  const blockedPnl = blocked.reduce((s, t) => s + t.pnl, 0);
  
  console.log('\n--- ブロックされた取引 ---');
  console.log(`件数: ${blocked.length}`);
  console.log(`勝敗: ${blockedWins.length}勝 ${(blocked.length - blockedWins.length)}敗`);
  console.log(`P&L: ${blockedPnl.toLocaleString()}円`);
  
  // Individual condition analysis
  console.log('\n=== 各条件の個別効果 ===');
  
  // Board score >= 2
  const bs2 = results.filter(t => t.boardScore >= 2);
  const bs2Wins = bs2.filter(t => t.pnl > 0);
  console.log(`\n板スコア>=2: ${bs2.length}件 | 勝率${bs2.length > 0 ? (bs2Wins.length/bs2.length*100).toFixed(1) : 0}% | P&L=${bs2.reduce((s,t)=>s+t.pnl,0).toLocaleString()}円`);
  
  // Board score >= 1
  const bs1 = results.filter(t => t.boardScore >= 1);
  const bs1Wins = bs1.filter(t => t.pnl > 0);
  console.log(`板スコア>=1: ${bs1.length}件 | 勝率${bs1.length > 0 ? (bs1Wins.length/bs1.length*100).toFixed(1) : 0}% | P&L=${bs1.reduce((s,t)=>s+t.pnl,0).toLocaleString()}円`);
  
  // Board score distribution
  console.log('\n板スコア分布:');
  for (let s = -3; s <= 5; s++) {
    const group = results.filter(t => t.boardScore === s);
    if (group.length > 0) {
      const gWins = group.filter(t => t.pnl > 0);
      console.log(`  スコア${s}: ${group.length}件 | 勝率${(gWins.length/group.length*100).toFixed(1)}% | P&L=${group.reduce((a,t)=>a+t.pnl,0).toLocaleString()}円`);
    }
  }
  
  // BPR ranges
  console.log('\nBPR分布:');
  const bprRanges = [
    { label: '0.00-0.30', min: 0, max: 0.30 },
    { label: '0.30-0.44', min: 0.30, max: 0.44 },
    { label: '0.44-0.54', min: 0.44, max: 0.54 },
    { label: '0.54-0.70', min: 0.54, max: 0.70 },
    { label: '0.70-1.00', min: 0.70, max: 1.00 },
  ];
  for (const range of bprRanges) {
    const group = results.filter(t => t.bpr >= range.min && t.bpr < range.max);
    if (group.length > 0) {
      const gWins = group.filter(t => t.pnl > 0);
      console.log(`  BPR ${range.label}: ${group.length}件 | 勝率${(gWins.length/group.length*100).toFixed(1)}% | P&L=${group.reduce((a,t)=>a+t.pnl,0).toLocaleString()}円`);
    }
  }
  
  // ADX ranges
  console.log('\nADX分布:');
  const adxRanges = [
    { label: '0-15', min: 0, max: 15 },
    { label: '15-20', min: 15, max: 20 },
    { label: '20-25', min: 20, max: 25 },
    { label: '25-30', min: 25, max: 30 },
    { label: '30-40', min: 30, max: 40 },
    { label: '40+', min: 40, max: 100 },
  ];
  for (const range of adxRanges) {
    const group = results.filter(t => t.adx >= range.min && t.adx < range.max);
    if (group.length > 0) {
      const gWins = group.filter(t => t.pnl > 0);
      console.log(`  ADX ${range.label}: ${group.length}件 | 勝率${(gWins.length/group.length*100).toFixed(1)}% | P&L=${group.reduce((a,t)=>a+t.pnl,0).toLocaleString()}円`);
    }
  }
  
  // Time distribution
  console.log('\n時間帯分布:');
  const timeRanges = [
    { label: '09:00-10:00', min: '09:00', max: '10:00' },
    { label: '10:00-11:00', min: '10:00', max: '11:00' },
    { label: '11:00-12:00', min: '11:00', max: '12:00' },
    { label: '12:30-13:00', min: '12:30', max: '13:00' },
    { label: '13:00-14:00', min: '13:00', max: '14:00' },
    { label: '14:00-15:00', min: '14:00', max: '15:00' },
    { label: '15:00-15:30', min: '15:00', max: '15:30' },
  ];
  for (const range of timeRanges) {
    const group = results.filter(t => t.time >= range.min && t.time < range.max);
    if (group.length > 0) {
      const gWins = group.filter(t => t.pnl > 0);
      console.log(`  ${range.label}: ${group.length}件 | 勝率${(gWins.length/group.length*100).toFixed(1)}% | P&L=${group.reduce((a,t)=>a+t.pnl,0).toLocaleString()}円`);
    }
  }
  
  // Confidence distribution
  console.log('\n信頼度分布:');
  const confGroups = ['strong', 'medium', 'weak'];
  for (const conf of confGroups) {
    const group = results.filter(t => t.confidence === conf);
    if (group.length > 0) {
      const gWins = group.filter(t => t.pnl > 0);
      console.log(`  ${conf}: ${group.length}件 | 勝率${(gWins.length/group.length*100).toFixed(1)}% | P&L=${group.reduce((a,t)=>a+t.pnl,0).toLocaleString()}円`);
    }
  }
  
  // Detail of each trade
  console.log('\n=== 全取引詳細 ===');
  for (const t of results) {
    const mark = t.pnl > 0 ? '✓' : '✗';
    const v5 = t.v5Pass ? '★V5通過' : '';
    console.log(`${mark} ${t.date} ${t.time} ${t.symbol} @${t.entryPrice} → ${t.exitReason} P&L=${t.pnl.toLocaleString()}円 | BPR=${t.bpr.toFixed(3)} Score=${t.boardScore} ADX=${t.adx.toFixed(1)} ${v5}`);
  }
  
  // Combination analysis
  console.log('\n=== 組み合わせ分析 ===');
  
  // BPR < 0.54 only
  const bprOnly = results.filter(t => t.bpr >= 0.44 && t.bpr < 0.54);
  console.log(`BPR 0.44-0.54のみ: ${bprOnly.length}件 | 勝率${bprOnly.length > 0 ? (bprOnly.filter(t=>t.pnl>0).length/bprOnly.length*100).toFixed(1) : 0}% | P&L=${bprOnly.reduce((s,t)=>s+t.pnl,0).toLocaleString()}円`);
  
  // BPR < 0.54 + ADX < 30
  const bprAdx = results.filter(t => t.bpr >= 0.44 && t.bpr < 0.54 && t.adx < 30);
  console.log(`BPR 0.44-0.54 + ADX<30: ${bprAdx.length}件 | 勝率${bprAdx.length > 0 ? (bprAdx.filter(t=>t.pnl>0).length/bprAdx.length*100).toFixed(1) : 0}% | P&L=${bprAdx.reduce((s,t)=>s+t.pnl,0).toLocaleString()}円`);
  
  // BPR < 0.54 + 13時前
  const bprTime = results.filter(t => t.bpr >= 0.44 && t.bpr < 0.54 && t.time < '13:00');
  console.log(`BPR 0.44-0.54 + 13時前: ${bprTime.length}件 | 勝率${bprTime.length > 0 ? (bprTime.filter(t=>t.pnl>0).length/bprTime.length*100).toFixed(1) : 0}% | P&L=${bprTime.reduce((s,t)=>s+t.pnl,0).toLocaleString()}円`);
  
  // ADX < 30 only
  const adxOnly = results.filter(t => t.adx < 30);
  console.log(`ADX<30のみ: ${adxOnly.length}件 | 勝率${adxOnly.length > 0 ? (adxOnly.filter(t=>t.pnl>0).length/adxOnly.length*100).toFixed(1) : 0}% | P&L=${adxOnly.reduce((s,t)=>s+t.pnl,0).toLocaleString()}円`);
  
  // 13時前 only
  const timeOnly = results.filter(t => t.time < '13:00');
  console.log(`13時前のみ: ${timeOnly.length}件 | 勝率${timeOnly.length > 0 ? (timeOnly.filter(t=>t.pnl>0).length/timeOnly.length*100).toFixed(1) : 0}% | P&L=${timeOnly.reduce((s,t)=>s+t.pnl,0).toLocaleString()}円`);
  
  process.exit(0);
}

// Board score calculation matching production logic more closely
function calcBoardScoreFromSnapshot(bs: any): number {
  if (!bs) return 0;
  let score = 0;
  
  // E: Board pressure (BPR)
  const bpr = bs.buyPressureRatio ?? 0.5;
  if (bpr <= 0.45) score += 1;      // sell pressure strong → good for short
  else if (bpr >= 0.65) score -= 1;  // buy pressure strong → bad for short
  
  // F: Market order direction (downtick = good for short)
  const mod = bs.marketOrderDirection;
  if (mod === 'downtick') score += 2;
  else if (mod === 'uptick') score -= 2;
  
  // A: Aggressive orders + direction match
  const mor = bs.marketOrderRatio ?? 0;
  if (mor >= 0.08 && mod === 'downtick') score += 2;
  else if (mor >= 0.08 && mod === 'uptick') score -= 2;
  
  // D: Market mode
  const mode = bs.mode;
  if (mode === 'active') score += 1;
  else if (mode === 'trap') score -= 2;
  
  // G: Iceberg detection
  if (bs.icebergAskDetected) score += 1;  // sell-side iceberg = good for short
  if (bs.icebergBidDetected) score -= 1;  // buy-side iceberg = bad for short
  
  // B: Large wall
  if (bs.largeBuyWall) score += 1;   // buy wall = trapped longs
  if (bs.largeSellWall) score -= 1;  // sell wall blocks further decline
  
  // C: BPR trend (simplified - check if signal is sell_pressure)
  if (bs.signal === 'sell_pressure') score += 1;
  else if (bs.signal === 'buy_pressure') score -= 1;
  
  return score;
}

// Simple ADX calculation from candle array
function calcADXFromCandles(candles: any[]): number {
  if (candles.length < 28) return 20; // default if not enough data
  
  const period = 14;
  const trueRanges: number[] = [];
  const plusDMs: number[] = [];
  const minusDMs: number[] = [];
  
  for (let i = 1; i < candles.length; i++) {
    const high = Number(candles[i].high);
    const low = Number(candles[i].low);
    const prevClose = Number(candles[i-1].close);
    const prevHigh = Number(candles[i-1].high);
    const prevLow = Number(candles[i-1].low);
    
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    const plusDM = (high - prevHigh) > (prevLow - low) ? Math.max(high - prevHigh, 0) : 0;
    const minusDM = (prevLow - low) > (high - prevHigh) ? Math.max(prevLow - low, 0) : 0;
    
    trueRanges.push(tr);
    plusDMs.push(plusDM);
    minusDMs.push(minusDM);
  }
  
  if (trueRanges.length < period * 2) return 20;
  
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
  }
  
  if (dxValues.length >= period) {
    return dxValues.slice(-period).reduce((a, b) => a + b, 0) / period;
  }
  return 20;
}

main().catch(e => { console.error(e); process.exit(1); });
