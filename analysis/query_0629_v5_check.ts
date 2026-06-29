import { getDb } from '../server/db';
import { sql } from 'drizzle-orm';

async function main() {
  const db = await getDb();
  const today = '2026-06-29';
  
  // Get all round-break/round-exceed entry trades
  const entryResult = await db.execute(
    sql`SELECT id, symbol, symbolName, tradeDate, tradeTime, action, price, reason, boardSignal, side
        FROM rt_trades 
        WHERE tradeDate = ${today}
        AND (reason LIKE '%大台割れ%' OR reason LIKE '%大台超え%' OR reason LIKE '%大台確認%')
        AND pnl IS NULL
        ORDER BY tradeTime`
  ) as any;
  const entries = entryResult[0] ?? entryResult;
  
  console.log(`=== ${today} 大台割れ/超え 板スコア>=2 フィルター検証 ===\n`);
  console.log(`対象エントリー: ${entries.length}件\n`);
  
  interface TradeResult {
    time: string;
    symbol: string;
    name: string;
    side: string;
    entryPrice: number;
    exitPrice: number;
    pnl: number;
    exitReason: string;
    boardScore: number;
    bpr: number;
    boardSignal: string;
    pass: boolean;
    reason: string;
  }
  
  const results: TradeResult[] = [];
  
  for (const entry of entries) {
    // Find exit
    const exitResult = await db.execute(
      sql`SELECT price, reason, pnl FROM rt_trades 
          WHERE symbol = ${entry.symbol}
          AND tradeDate = ${today}
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
    
    // Get board data from rt_candles at entry time
    const candleResult = await db.execute(
      sql`SELECT boardSnapshot FROM rt_candles 
          WHERE symbol = ${entry.symbol}
          AND tradeDate = ${today}
          AND candleTime = ${entry.tradeTime}
          LIMIT 1`
    ) as any;
    const candles = candleResult[0] ?? candleResult;
    
    let bpr = 0.5;
    let boardScore = 0;
    let boardSignalFromCandle = '';
    
    if (candles.length > 0) {
      const bs = typeof candles[0].boardSnapshot === 'string' 
        ? JSON.parse(candles[0].boardSnapshot) 
        : candles[0].boardSnapshot;
      if (bs) {
        bpr = bs.buyPressureRatio ?? 0.5;
        boardSignalFromCandle = bs.signal || '';
        boardScore = calcBoardScore(bs, entry.side || entry.action);
      }
    } else {
      // Try adjacent candle times
      const nearResult = await db.execute(
        sql`SELECT candleTime, boardSnapshot FROM rt_candles 
            WHERE symbol = ${entry.symbol}
            AND tradeDate = ${today}
            AND candleTime >= ${entry.tradeTime}
            ORDER BY candleTime LIMIT 1`
      ) as any;
      const near = nearResult[0] ?? nearResult;
      if (near.length > 0) {
        const bs = typeof near[0].boardSnapshot === 'string' 
          ? JSON.parse(near[0].boardSnapshot) 
          : near[0].boardSnapshot;
        if (bs) {
          bpr = bs.buyPressureRatio ?? 0.5;
          boardSignalFromCandle = bs.signal || '';
          boardScore = calcBoardScore(bs, entry.side || entry.action);
        }
      }
    }
    
    const pass = boardScore >= 2;
    
    results.push({
      time: entry.tradeTime,
      symbol: entry.symbol,
      name: entry.symbolName || entry.symbol,
      side: entry.side || entry.action,
      entryPrice: Number(entry.price),
      exitPrice, pnl, exitReason,
      boardScore, bpr,
      boardSignal: entry.boardSignal || boardSignalFromCandle,
      pass,
      reason: entry.reason || '',
    });
  }
  
  // Display results
  console.log('時刻    | 銘柄 | 方向 | P&L | Score | BPR | 判定');
  console.log('--------|------|------|------|-------|-----|------');
  
  let currentTotal = 0, v5Total = 0;
  let currentWins = 0, v5Wins = 0;
  let currentCount = results.length, v5Count = 0;
  
  for (const r of results) {
    const mark = r.pass ? '★通過' : 'ブロック';
    const pnlStr = `${r.pnl >= 0 ? '+' : ''}${r.pnl.toLocaleString()}円`;
    console.log(`${r.time} | ${r.symbol}(${r.name}) | ${r.side} | ${pnlStr} | ${r.boardScore} | ${r.bpr.toFixed(3)} | ${mark}`);
    console.log(`  理由: ${r.reason.substring(0, 60)}`);
    console.log(`  決済: ${r.exitReason}`);
    console.log('');
    
    currentTotal += r.pnl;
    if (r.pnl > 0) currentWins++;
    if (r.pass) {
      v5Total += r.pnl;
      v5Count++;
      if (r.pnl > 0) v5Wins++;
    }
  }
  
  const blockedTrades = results.filter(r => !r.pass);
  const blockedPnl = blockedTrades.reduce((s, r) => s + r.pnl, 0);
  const blockedWins = blockedTrades.filter(r => r.pnl > 0);
  const blockedLosses = blockedTrades.filter(r => r.pnl < 0);
  
  console.log('\n=== 比較結果 ===\n');
  console.log(`| 指標 | 現行 | 板スコア>=2 |`);
  console.log(`|------|------|------------|`);
  console.log(`| 件数 | ${currentCount} | ${v5Count} |`);
  console.log(`| 勝敗 | ${currentWins}勝${currentCount - currentWins}敗 | ${v5Wins}勝${v5Count - v5Wins}敗 |`);
  console.log(`| 勝率 | ${(currentWins/currentCount*100).toFixed(1)}% | ${v5Count > 0 ? (v5Wins/v5Count*100).toFixed(1) : 'N/A'}% |`);
  console.log(`| 総損益 | ${currentTotal >= 0 ? '+' : ''}${currentTotal.toLocaleString()}円 | ${v5Total >= 0 ? '+' : ''}${v5Total.toLocaleString()}円 |`);
  
  console.log(`\nブロック: ${blockedTrades.length}件`);
  console.log(`  勝ちブロック(逸失利益): ${blockedWins.length}件, ${blockedWins.reduce((s,r)=>s+r.pnl,0).toLocaleString()}円`);
  console.log(`  負けブロック(損失回避): ${blockedLosses.length}件, ${blockedLosses.reduce((s,r)=>s+r.pnl,0).toLocaleString()}円`);
  console.log(`  ブロック合計P&L: ${blockedPnl >= 0 ? '+' : ''}${blockedPnl.toLocaleString()}円`);
  
  process.exit(0);
}

function calcBoardScore(bs: any, side: string): number {
  if (!bs) return 0;
  let score = 0;
  const isShort = side === 'short' || side === 'sell';
  
  // E: 板圧力の強さ (BPR)
  const bpr = bs.buyPressureRatio ?? 0.5;
  if (isShort) {
    if (bpr <= 0.45) score += 1;
    else if (bpr >= 0.65) score -= 1;
  } else {
    if (bpr >= 0.55) score += 1;
    else if (bpr <= 0.35) score -= 1;
  }
  
  // F: 歩み値方向推定 (marketOrderDirection)
  const mod = bs.marketOrderDirection;
  if (isShort) {
    if (mod === 'downtick') score += 2;
    else if (mod === 'uptick') score -= 2;
  } else {
    if (mod === 'uptick') score += 2;
    else if (mod === 'downtick') score -= 2;
  }
  
  // A: アグレッシブ注文 (marketOrderRatio + direction)
  const mor = bs.marketOrderRatio ?? 0;
  if (mor >= 0.08) {
    if (isShort && mod === 'downtick') score += 2;
    else if (!isShort && mod === 'uptick') score += 2;
    else if (isShort && mod === 'uptick') score -= 2;
    else if (!isShort && mod === 'downtick') score -= 2;
  }
  
  // D: 相場モード
  if (bs.mode === 'active') score += 1;
  else if (bs.mode === 'trap') score -= 2;
  
  // G: アイスバーグ検出
  if (isShort) {
    if (bs.icebergAskDetected) score += 1;
    if (bs.icebergBidDetected) score -= 1;
  } else {
    if (bs.icebergBidDetected) score += 1;
    if (bs.icebergAskDetected) score -= 1;
  }
  
  // 板の壁
  if (isShort) {
    if (bs.largeSellWall) score -= 1; // 売り壁=ショートに不利
    if (bs.largeBuyWall) score += 1;  // 買い壁=割れたら加速
  } else {
    if (bs.largeBuyWall) score -= 1;
    if (bs.largeSellWall) score += 1;
  }
  
  // 板シグナル
  if (isShort) {
    if (bs.signal === 'sell_pressure') score += 1;
    else if (bs.signal === 'buy_pressure') score -= 1;
  } else {
    if (bs.signal === 'buy_pressure') score += 1;
    else if (bs.signal === 'sell_pressure') score -= 1;
  }
  
  return score;
}

main().catch(e => { console.error(e); process.exit(1); });
