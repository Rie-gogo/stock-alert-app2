import { getDb } from '../server/db';
import { sql } from 'drizzle-orm';

/**
 * 全日程の大台割れ取引を「板スコア>=2 AND BPR<0.54」でフィルターした結果
 */

async function main() {
  const db = await getDb();
  
  // Get all round-break entry trades (pnl IS NULL = entry)
  const entryResult = await db.execute(
    sql`SELECT id, symbol, tradeDate, tradeTime, action, price, reason, boardSignal, side
        FROM rt_trades 
        WHERE reason LIKE '%大台割れ%'
        AND pnl IS NULL
        ORDER BY tradeDate, tradeTime`
  ) as any;
  const entries = entryResult[0] ?? entryResult;
  
  console.log(`=== 全期間 大台割れ取引 Ver5最終版 ===`);
  console.log(`条件: 板スコア>=2 AND BPR<0.54`);
  console.log(`対象エントリー: ${entries.length}件\n`);
  
  interface Result {
    date: string;
    time: string;
    symbol: string;
    entryPrice: number;
    exitPrice: number;
    pnl: number;
    exitReason: string;
    bpr: number;
    boardScore: number;
    pass: boolean;
  }
  
  const results: Result[] = [];
  
  for (const entry of entries) {
    // Find exit
    const exitResult = await db.execute(
      sql`SELECT price, reason, pnl FROM rt_trades 
          WHERE symbol = ${entry.symbol}
          AND tradeDate = ${entry.tradeDate}
          AND tradeTime > ${entry.tradeTime}
          AND pnl IS NOT NULL
          ORDER BY tradeTime LIMIT 1`
    ) as any;
    const exits = exitResult[0] ?? exitResult;
    
    let exitPrice = Number(entry.price);
    let exitReason = '不明';
    let pnl = 0;
    if (exits.length > 0) {
      exitPrice = Number(exits[0].price);
      exitReason = exits[0].reason || '決済';
      pnl = Number(exits[0].pnl) || 0;
    }
    
    // Get board data from rt_candles
    const candleResult = await db.execute(
      sql`SELECT boardSnapshot FROM rt_candles 
          WHERE symbol = ${entry.symbol}
          AND tradeDate = ${entry.tradeDate}
          AND candleTime = ${entry.tradeTime}
          LIMIT 1`
    ) as any;
    const candles = candleResult[0] ?? candleResult;
    
    let bpr = 0.5;
    let boardScore = 0;
    if (candles.length > 0) {
      const bs = typeof candles[0].boardSnapshot === 'string' 
        ? JSON.parse(candles[0].boardSnapshot) 
        : candles[0].boardSnapshot;
      if (bs) {
        bpr = bs.buyPressureRatio ?? 0.5;
        boardScore = calcBoardScore(bs);
      }
    }
    
    const pass = boardScore >= 2 && bpr < 0.54;
    
    results.push({
      date: entry.tradeDate,
      time: entry.tradeTime,
      symbol: entry.symbol,
      entryPrice: Number(entry.price),
      exitPrice, pnl, exitReason,
      bpr, boardScore, pass,
    });
  }
  
  // === Summary by date ===
  const dates = [...new Set(results.map(r => r.date))].sort();
  
  console.log('=== 日別集計 ===\n');
  console.log('日付       | 現行件数 | 現行P&L    | V5件数 | V5 P&L     | ブロックP&L');
  console.log('-----------|---------|-----------|--------|-----------|----------');
  
  let totalCurrent = 0, totalV5 = 0, totalBlocked = 0;
  let totalCurrentCount = 0, totalV5Count = 0;
  let totalCurrentWins = 0, totalV5Wins = 0;
  
  for (const date of dates) {
    const dayTrades = results.filter(r => r.date === date);
    const dayV5 = dayTrades.filter(r => r.pass);
    const dayBlocked = dayTrades.filter(r => !r.pass);
    
    const dayPnl = dayTrades.reduce((s, r) => s + r.pnl, 0);
    const dayV5Pnl = dayV5.reduce((s, r) => s + r.pnl, 0);
    const dayBlockedPnl = dayBlocked.reduce((s, r) => s + r.pnl, 0);
    
    totalCurrent += dayPnl;
    totalV5 += dayV5Pnl;
    totalBlocked += dayBlockedPnl;
    totalCurrentCount += dayTrades.length;
    totalV5Count += dayV5.length;
    totalCurrentWins += dayTrades.filter(r => r.pnl > 0).length;
    totalV5Wins += dayV5.filter(r => r.pnl > 0).length;
    
    const dayWins = dayTrades.filter(r => r.pnl > 0).length;
    const dayV5Wins = dayV5.filter(r => r.pnl > 0).length;
    
    console.log(`${date} | ${dayTrades.length}件(${dayWins}勝)  | ${dayPnl >= 0 ? '+' : ''}${dayPnl.toLocaleString()}円 | ${dayV5.length}件(${dayV5Wins}勝) | ${dayV5Pnl >= 0 ? '+' : ''}${dayV5Pnl.toLocaleString()}円 | ${dayBlockedPnl >= 0 ? '+' : ''}${dayBlockedPnl.toLocaleString()}円`);
  }
  
  console.log('-----------|---------|-----------|--------|-----------|----------');
  console.log(`合計       | ${totalCurrentCount}件(${totalCurrentWins}勝) | ${totalCurrent >= 0 ? '+' : ''}${totalCurrent.toLocaleString()}円 | ${totalV5Count}件(${totalV5Wins}勝) | ${totalV5 >= 0 ? '+' : ''}${totalV5.toLocaleString()}円 | ${totalBlocked >= 0 ? '+' : ''}${totalBlocked.toLocaleString()}円`);
  
  // === Overall comparison ===
  const currentLosses = results.filter(r => r.pnl < 0);
  const v5Trades = results.filter(r => r.pass);
  const v5Losses = v5Trades.filter(r => r.pnl < 0);
  const v5Wins = v5Trades.filter(r => r.pnl > 0);
  const currentWins = results.filter(r => r.pnl > 0);
  
  const currentGrossProfit = currentWins.reduce((s, r) => s + r.pnl, 0);
  const currentGrossLoss = Math.abs(currentLosses.reduce((s, r) => s + r.pnl, 0));
  const v5GrossProfit = v5Wins.reduce((s, r) => s + r.pnl, 0);
  const v5GrossLoss = Math.abs(v5Losses.reduce((s, r) => s + r.pnl, 0));
  
  console.log('\n=== 総合比較 ===\n');
  console.log('指標          | 現行        | Ver5最終版');
  console.log('-------------|------------|----------');
  console.log(`件数          | ${results.length}          | ${v5Trades.length}`);
  console.log(`勝敗          | ${totalCurrentWins}勝${results.length - totalCurrentWins}敗     | ${totalV5Wins}勝${v5Trades.length - totalV5Wins}敗`);
  console.log(`勝率          | ${(totalCurrentWins/results.length*100).toFixed(1)}%      | ${v5Trades.length > 0 ? (totalV5Wins/v5Trades.length*100).toFixed(1) : 'N/A'}%`);
  console.log(`総損益        | ${totalCurrent >= 0 ? '+' : ''}${totalCurrent.toLocaleString()}円  | ${totalV5 >= 0 ? '+' : ''}${totalV5.toLocaleString()}円`);
  console.log(`平均利益      | ${currentWins.length > 0 ? '+' + Math.round(currentGrossProfit/currentWins.length).toLocaleString() : 0}円 | ${v5Wins.length > 0 ? '+' + Math.round(v5GrossProfit/v5Wins.length).toLocaleString() : 0}円`);
  console.log(`平均損失      | ${currentLosses.length > 0 ? Math.round(-currentGrossLoss/currentLosses.length).toLocaleString() : 0}円 | ${v5Losses.length > 0 ? Math.round(-v5GrossLoss/v5Losses.length).toLocaleString() : 0}円`);
  console.log(`PF            | ${currentGrossLoss > 0 ? (currentGrossProfit/currentGrossLoss).toFixed(2) : 'Inf'} | ${v5GrossLoss > 0 ? (v5GrossProfit/v5GrossLoss).toFixed(2) : 'Inf'}`);
  console.log(`損切り回数    | ${currentLosses.length}         | ${v5Losses.length}`);
  console.log(`ブロック件数  | -           | ${results.length - v5Trades.length}`);
  console.log(`ブロックP&L   | -           | ${totalBlocked >= 0 ? '+' : ''}${totalBlocked.toLocaleString()}円`);
  
  // Blocked analysis
  const blockedTrades = results.filter(r => !r.pass);
  const blockedWins = blockedTrades.filter(r => r.pnl > 0);
  const blockedLosses = blockedTrades.filter(r => r.pnl < 0);
  console.log(`\nブロック内訳: ${blockedWins.length}勝${blockedLosses.length}敗`);
  console.log(`  勝ちブロック(逸失利益): ${blockedWins.reduce((s,r)=>s+r.pnl,0).toLocaleString()}円`);
  console.log(`  負けブロック(損失回避): ${blockedLosses.reduce((s,r)=>s+r.pnl,0).toLocaleString()}円`);
  
  // === Detail per trade ===
  console.log('\n=== 全取引詳細 ===\n');
  for (const r of results) {
    const mark = r.pnl > 0 ? '✓' : r.pnl < 0 ? '✗' : '→';
    const v5 = r.pass ? '★通過' : 'ブロック';
    console.log(`${mark} ${r.date} ${r.time} ${r.symbol} @${r.entryPrice} → ${r.exitReason}`);
    console.log(`  P&L=${r.pnl.toLocaleString()}円 | BPR=${r.bpr.toFixed(3)} | Score=${r.boardScore} | ${v5}`);
  }
  
  process.exit(0);
}

function calcBoardScore(bs: any): number {
  if (!bs) return 0;
  let score = 0;
  
  const bpr = bs.buyPressureRatio ?? 0.5;
  if (bpr <= 0.45) score += 1;
  else if (bpr >= 0.65) score -= 1;
  
  const mod = bs.marketOrderDirection;
  if (mod === 'downtick') score += 2;
  else if (mod === 'uptick') score -= 2;
  
  const mor = bs.marketOrderRatio ?? 0;
  if (mor >= 0.08 && mod === 'downtick') score += 2;
  else if (mor >= 0.08 && mod === 'uptick') score -= 2;
  
  if (bs.mode === 'active') score += 1;
  else if (bs.mode === 'trap') score -= 2;
  
  if (bs.icebergAskDetected) score += 1;
  if (bs.icebergBidDetected) score -= 1;
  
  if (bs.largeBuyWall) score += 1;
  if (bs.largeSellWall) score -= 1;
  
  if (bs.signal === 'sell_pressure') score += 1;
  else if (bs.signal === 'buy_pressure') score -= 1;
  
  return score;
}

main().catch(e => { console.error(e); process.exit(1); });
