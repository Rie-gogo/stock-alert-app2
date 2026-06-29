import { getDb } from '../server/db';
import { sql } from 'drizzle-orm';

async function main() {
  const db = await getDb();
  const today = '2026-06-29';
  
  // Get all trades for today
  const tradeResult = await db.execute(
    sql`SELECT id, symbol, symbolName, tradeDate, tradeTime, action, price, shares, pnl, reason, side, boardSignal
        FROM rt_trades WHERE tradeDate = ${today} ORDER BY tradeTime`
  ) as any;
  const trades = tradeResult[0] ?? tradeResult;
  
  // Get all entries (pnl IS NULL)
  const entries = trades.filter((t: any) => t.pnl === null);
  
  console.log(`=== ${today} 全取引 詳細分析（チャート・出来高・板情報） ===\n`);
  console.log(`取引数: ${entries.length}件\n`);
  
  for (const entry of entries) {
    // Find corresponding exit
    const exit = trades.find((t: any) => 
      t.symbol === entry.symbol && 
      t.tradeTime > entry.tradeTime && 
      t.pnl !== null
    );
    
    if (!exit) continue;
    
    const entryTime = entry.tradeTime;
    const exitTime = exit.tradeTime;
    const pnl = Number(exit.pnl);
    const result = pnl > 0 ? '✓ 勝ち' : pnl < 0 ? '✗ 負け' : '→ 引分';
    
    console.log(`${'='.repeat(70)}`);
    console.log(`${result} | ${entry.symbol}(${entry.symbolName}) | ${entry.side} | ${entryTime}→${exitTime}`);
    console.log(`エントリー: @${Number(entry.price).toLocaleString()} | 決済: @${Number(exit.price).toLocaleString()} | P&L: ${pnl >= 0 ? '+' : ''}${pnl.toLocaleString()}円`);
    console.log(`理由: ${entry.reason}`);
    console.log(`決済理由: ${exit.reason}`);
    console.log('');
    
    // Get candles around entry (10 before)
    const beforeCandles = await db.execute(
      sql`SELECT candleTime, open, high, low, close, volume, boardSnapshot
          FROM rt_candles 
          WHERE symbol = ${entry.symbol} AND tradeDate = ${today}
          AND candleTime <= ${entryTime}
          ORDER BY candleTime DESC LIMIT 10`
    ) as any;
    const before = (beforeCandles[0] ?? beforeCandles).reverse();
    
    // Get candles during holding period
    const afterCandles = await db.execute(
      sql`SELECT candleTime, open, high, low, close, volume, boardSnapshot
          FROM rt_candles 
          WHERE symbol = ${entry.symbol} AND tradeDate = ${today}
          AND candleTime > ${entryTime} AND candleTime <= ${exitTime}
          ORDER BY candleTime LIMIT 30`
    ) as any;
    const after = afterCandles[0] ?? afterCandles;
    
    // Get candles after exit
    const postExit = await db.execute(
      sql`SELECT candleTime, open, high, low, close, volume, boardSnapshot
          FROM rt_candles 
          WHERE symbol = ${entry.symbol} AND tradeDate = ${today}
          AND candleTime > ${exitTime}
          ORDER BY candleTime LIMIT 10`
    ) as any;
    const postExitCandles = postExit[0] ?? postExit;
    
    // Calculate VWAP from all session candles up to entry
    const allCandlesBeforeEntry = await db.execute(
      sql`SELECT candleTime, open, high, low, close, volume
          FROM rt_candles 
          WHERE symbol = ${entry.symbol} AND tradeDate = ${today}
          AND candleTime <= ${entryTime}
          ORDER BY candleTime`
    ) as any;
    const allBefore = allCandlesBeforeEntry[0] ?? allCandlesBeforeEntry;
    
    let cumVol = 0, cumPV = 0;
    for (const c of allBefore) {
      const typicalPrice = (Number(c.high) + Number(c.low) + Number(c.close)) / 3;
      const vol = Number(c.volume);
      cumVol += vol;
      cumPV += typicalPrice * vol;
    }
    const vwapAtEntry = cumVol > 0 ? cumPV / cumVol : Number(entry.price);
    
    // Analyze entry context
    console.log('【エントリー前 チャート・出来高・板】');
    const avgVolBefore = before.length > 0 ? before.reduce((s: number, c: any) => s + Number(c.volume), 0) / before.length : 0;
    
    for (const c of before.slice(-5)) {
      const bs = typeof c.boardSnapshot === 'string' ? JSON.parse(c.boardSnapshot) : c.boardSnapshot;
      const bpr = bs?.buyPressureRatio?.toFixed(3) ?? 'N/A';
      const signal = bs?.signal ?? 'N/A';
      const mod = bs?.marketOrderDirection ?? 'N/A';
      const mor = bs?.marketOrderRatio?.toFixed(3) ?? 'N/A';
      const mode = bs?.mode ?? 'N/A';
      const vol = Number(c.volume);
      const volRatio = avgVolBefore > 0 ? (vol / avgVolBefore).toFixed(1) : 'N/A';
      const candle = Number(c.close) >= Number(c.open) ? '陽線' : '陰線';
      console.log(`  ${c.candleTime} O:${Number(c.open)} H:${Number(c.high)} L:${Number(c.low)} C:${Number(c.close)} ${candle} Vol:${vol}(${volRatio}x)`);
      console.log(`    板: BPR=${bpr} Signal=${signal} MktOrd=${mod}(${mor}) Mode=${mode}`);
    }
    
    // Entry candle
    const entryCandle = before.find((c: any) => c.candleTime === entryTime);
    if (entryCandle) {
      const bs = typeof entryCandle.boardSnapshot === 'string' ? JSON.parse(entryCandle.boardSnapshot) : entryCandle.boardSnapshot;
      console.log(`\n【エントリー足】 ${entryTime}`);
      console.log(`  O:${Number(entryCandle.open)} H:${Number(entryCandle.high)} L:${Number(entryCandle.low)} C:${Number(entryCandle.close)} Vol:${Number(entryCandle.volume)}`);
      console.log(`  VWAP(計算値): ${vwapAtEntry.toFixed(1)} | 価格位置: ${Number(entry.price) > vwapAtEntry ? 'VWAP上' : 'VWAP下'}`);
      if (bs) {
        console.log(`  板詳細:`);
        console.log(`    BPR: ${bs.buyPressureRatio?.toFixed(3)} (${bs.buyPressureRatio < 0.45 ? '売り優勢' : bs.buyPressureRatio > 0.55 ? '買い優勢' : '中立'})`);
        console.log(`    Signal: ${bs.signal}`);
        console.log(`    MarketOrder: ${bs.marketOrderDirection} (比率:${bs.marketOrderRatio?.toFixed(3)})`);
        console.log(`    Mode: ${bs.mode}`);
        console.log(`    Iceberg: Ask=${bs.icebergAskDetected}, Bid=${bs.icebergBidDetected}`);
        console.log(`    LargeWall: Buy=${bs.largeBuyWall}, Sell=${bs.largeSellWall}`);
        console.log(`    BPR Trend: ${bs.bprTrend}`);
        
        // Calculate board score
        const score = calcBoardScore(bs, entry.side);
        console.log(`    → 板スコア: ${score}`);
      }
    } else {
      // Entry time might be between candles, get nearest
      const nearestCandle = before[before.length - 1];
      if (nearestCandle) {
        const bs = typeof nearestCandle.boardSnapshot === 'string' ? JSON.parse(nearestCandle.boardSnapshot) : nearestCandle.boardSnapshot;
        console.log(`\n【エントリー時点の最近接足】 ${nearestCandle.candleTime}`);
        console.log(`  O:${Number(nearestCandle.open)} H:${Number(nearestCandle.high)} L:${Number(nearestCandle.low)} C:${Number(nearestCandle.close)} Vol:${Number(nearestCandle.volume)}`);
        console.log(`  VWAP(計算値): ${vwapAtEntry.toFixed(1)} | 価格位置: ${Number(entry.price) > vwapAtEntry ? 'VWAP上' : 'VWAP下'}`);
        if (bs) {
          console.log(`  板詳細:`);
          console.log(`    BPR: ${bs.buyPressureRatio?.toFixed(3)} (${bs.buyPressureRatio < 0.45 ? '売り優勢' : bs.buyPressureRatio > 0.55 ? '買い優勢' : '中立'})`);
          console.log(`    Signal: ${bs.signal}`);
          console.log(`    MarketOrder: ${bs.marketOrderDirection} (比率:${bs.marketOrderRatio?.toFixed(3)})`);
          console.log(`    Mode: ${bs.mode}`);
          console.log(`    Iceberg: Ask=${bs.icebergAskDetected}, Bid=${bs.icebergBidDetected}`);
          console.log(`    LargeWall: Buy=${bs.largeBuyWall}, Sell=${bs.largeSellWall}`);
          console.log(`    BPR Trend: ${bs.bprTrend}`);
          const score = calcBoardScore(bs, entry.side);
          console.log(`    → 板スコア: ${score}`);
        }
      }
    }
    
    // After entry (holding period)
    console.log(`\n【保有中の推移】`);
    let maxFavorable = 0;
    let maxAdverse = 0;
    const entryPrice = Number(entry.price);
    
    for (const c of after) {
      const bs = typeof c.boardSnapshot === 'string' ? JSON.parse(c.boardSnapshot) : c.boardSnapshot;
      const bpr = bs?.buyPressureRatio?.toFixed(3) ?? 'N/A';
      const signal = bs?.signal ?? 'N/A';
      const mode = bs?.mode ?? 'N/A';
      const close = Number(c.close);
      
      let unrealized = 0;
      if (entry.side === 'short') {
        unrealized = (entryPrice - close) * Number(entry.shares);
      } else {
        unrealized = (close - entryPrice) * Number(entry.shares);
      }
      
      if (unrealized > maxFavorable) maxFavorable = unrealized;
      if (unrealized < maxAdverse) maxAdverse = unrealized;
      
      const candle = Number(c.close) >= Number(c.open) ? '陽線' : '陰線';
      console.log(`  ${c.candleTime} C:${close} ${candle} Vol:${Number(c.volume)} BPR=${bpr} Sig=${signal} Mode=${mode} 含み:${unrealized >= 0 ? '+' : ''}${Math.round(unrealized).toLocaleString()}円`);
    }
    
    console.log(`\n  最大含み益: +${Math.round(maxFavorable).toLocaleString()}円`);
    console.log(`  最大含み損: ${Math.round(maxAdverse).toLocaleString()}円`);
    
    // Post-exit movement
    if (postExitCandles.length > 0) {
      console.log(`\n【決済後の推移（もし持ち続けていたら）】`);
      for (const c of postExitCandles.slice(0, 5)) {
        const close = Number(c.close);
        let hypothetical = 0;
        if (entry.side === 'short') {
          hypothetical = (entryPrice - close) * Number(entry.shares);
        } else {
          hypothetical = (close - entryPrice) * Number(entry.shares);
        }
        console.log(`  ${c.candleTime} C:${close} 仮想P&L:${hypothetical >= 0 ? '+' : ''}${Math.round(hypothetical).toLocaleString()}円`);
      }
    }
    
    // Summary for this trade
    const slPct = entry.side === 'short' 
      ? ((Number(exit.price) - entryPrice) / entryPrice * 100)
      : ((entryPrice - Number(exit.price)) / entryPrice * 100);
    
    console.log(`\n【この取引の要約】`);
    console.log(`  保有時間: ${calcHoldingMinutes(entryTime, exitTime)}分`);
    console.log(`  リターン: ${(pnl / (entryPrice * Number(entry.shares)) * 100).toFixed(2)}%`);
    console.log(`  最大含み益→結果: ${maxFavorable > 0 ? `+${Math.round(maxFavorable).toLocaleString()}円→${pnl >= 0 ? '+' : ''}${pnl.toLocaleString()}円 (${(pnl/maxFavorable*100).toFixed(0)}%回収)` : 'なし'}`);
    console.log('');
  }
  
  // Overall summary
  console.log('\n' + '='.repeat(70));
  console.log('=== 全体サマリー ===\n');
  
  const allPnls = trades.filter((t: any) => t.pnl !== null).map((t: any) => Number(t.pnl));
  const wins = allPnls.filter(p => p > 0);
  const losses = allPnls.filter(p => p < 0);
  
  console.log(`総取引数: ${allPnls.length}`);
  console.log(`勝敗: ${wins.length}W ${losses.length}L (勝率: ${(wins.length/allPnls.length*100).toFixed(1)}%)`);
  console.log(`総損益: ${allPnls.reduce((s, p) => s + p, 0).toLocaleString()}円`);
  console.log(`平均利益: +${Math.round(wins.reduce((s, p) => s + p, 0) / wins.length).toLocaleString()}円`);
  console.log(`平均損失: ${Math.round(losses.reduce((s, p) => s + p, 0) / losses.length).toLocaleString()}円`);
  
  // Signal type breakdown
  console.log('\n【シグナル別成績】');
  const signalMap: Record<string, {wins: number, losses: number, pnl: number}> = {};
  for (const entry of entries) {
    const exit = trades.find((t: any) => t.symbol === entry.symbol && t.tradeTime > entry.tradeTime && t.pnl !== null);
    if (!exit) continue;
    const pnl = Number(exit.pnl);
    const signal = extractSignalType(entry.reason);
    if (!signalMap[signal]) signalMap[signal] = {wins: 0, losses: 0, pnl: 0};
    signalMap[signal].pnl += pnl;
    if (pnl > 0) signalMap[signal].wins++;
    else signalMap[signal].losses++;
  }
  for (const [sig, data] of Object.entries(signalMap)) {
    console.log(`  ${sig}: ${data.wins}W${data.losses}L P&L=${data.pnl >= 0 ? '+' : ''}${data.pnl.toLocaleString()}円`);
  }
  
  // Time analysis
  console.log('\n【時間帯別】');
  const amTrades = entries.filter((t: any) => t.tradeTime < '12:00');
  const pmTrades = entries.filter((t: any) => t.tradeTime >= '12:00');
  const amPnl = amTrades.reduce((s: number, e: any) => {
    const ex = trades.find((t: any) => t.symbol === e.symbol && t.tradeTime > e.tradeTime && t.pnl !== null);
    return s + (ex ? Number(ex.pnl) : 0);
  }, 0);
  const pmPnl = pmTrades.reduce((s: number, e: any) => {
    const ex = trades.find((t: any) => t.symbol === e.symbol && t.tradeTime > e.tradeTime && t.pnl !== null);
    return s + (ex ? Number(ex.pnl) : 0);
  }, 0);
  console.log(`  前場: ${amTrades.length}件 → ${amPnl >= 0 ? '+' : ''}${amPnl.toLocaleString()}円`);
  console.log(`  後場: ${pmTrades.length}件 → ${pmPnl >= 0 ? '+' : ''}${pmPnl.toLocaleString()}円`);
  
  // Board score analysis
  console.log('\n【板スコア別成績（エントリー時点）】');
  const scoreMap: Record<number, {wins: number, losses: number, pnl: number}> = {};
  for (const entry of entries) {
    const exit = trades.find((t: any) => t.symbol === entry.symbol && t.tradeTime > entry.tradeTime && t.pnl !== null);
    if (!exit) continue;
    const pnl = Number(exit.pnl);
    
    // Get board snapshot at entry
    const candleAtEntry = await db.execute(
      sql`SELECT boardSnapshot FROM rt_candles 
          WHERE symbol = ${entry.symbol} AND tradeDate = ${today}
          AND candleTime <= ${entry.tradeTime}
          ORDER BY candleTime DESC LIMIT 1`
    ) as any;
    const row = (candleAtEntry[0] ?? candleAtEntry)[0];
    if (row) {
      const bs = typeof row.boardSnapshot === 'string' ? JSON.parse(row.boardSnapshot) : row.boardSnapshot;
      const score = calcBoardScore(bs, entry.side);
      if (!scoreMap[score]) scoreMap[score] = {wins: 0, losses: 0, pnl: 0};
      scoreMap[score].pnl += pnl;
      if (pnl > 0) scoreMap[score].wins++;
      else scoreMap[score].losses++;
    }
  }
  for (const [score, data] of Object.entries(scoreMap).sort((a, b) => Number(a[0]) - Number(b[0]))) {
    console.log(`  Score=${score}: ${data.wins}W${data.losses}L P&L=${data.pnl >= 0 ? '+' : ''}${data.pnl.toLocaleString()}円`);
  }
  
  process.exit(0);
}

function calcBoardScore(bs: any, side: string): number {
  if (!bs) return 0;
  let score = 0;
  const isShort = side === 'short' || side === 'sell';
  
  // Factor A: BPR
  const bpr = bs.buyPressureRatio ?? 0.5;
  if (isShort) {
    if (bpr <= 0.45) score += 1;
    else if (bpr >= 0.65) score -= 1;
  } else {
    if (bpr >= 0.55) score += 1;
    else if (bpr <= 0.35) score -= 1;
  }
  
  // Factor B: Market Order Direction
  const mod = bs.marketOrderDirection;
  if (isShort) {
    if (mod === 'downtick') score += 2;
    else if (mod === 'uptick') score -= 2;
  } else {
    if (mod === 'uptick') score += 2;
    else if (mod === 'downtick') score -= 2;
  }
  
  // Factor C: Aggressive Orders (MOR >= 0.08)
  const mor = bs.marketOrderRatio ?? 0;
  if (mor >= 0.08) {
    if (isShort && mod === 'downtick') score += 2;
    else if (!isShort && mod === 'uptick') score += 2;
    else if (isShort && mod === 'uptick') score -= 2;
    else if (!isShort && mod === 'downtick') score -= 2;
  }
  
  // Factor D: Mode
  if (bs.mode === 'active') score += 1;
  else if (bs.mode === 'trap') score -= 2;
  
  // Factor E: Iceberg
  if (isShort) {
    if (bs.icebergAskDetected) score += 1;
    if (bs.icebergBidDetected) score -= 1;
  } else {
    if (bs.icebergBidDetected) score += 1;
    if (bs.icebergAskDetected) score -= 1;
  }
  
  // Factor F: Large Walls
  if (isShort) {
    if (bs.largeSellWall) score -= 1;
    if (bs.largeBuyWall) score += 1;
  } else {
    if (bs.largeBuyWall) score -= 1;
    if (bs.largeSellWall) score += 1;
  }
  
  // Factor G: Signal
  if (isShort) {
    if (bs.signal === 'sell_pressure') score += 1;
    else if (bs.signal === 'buy_pressure') score -= 1;
  } else {
    if (bs.signal === 'buy_pressure') score += 1;
    else if (bs.signal === 'sell_pressure') score -= 1;
  }
  
  return score;
}

function calcHoldingMinutes(entry: string, exit: string): number {
  const [eh, em] = entry.split(':').map(Number);
  const [xh, xm] = exit.split(':').map(Number);
  return (xh * 60 + xm) - (eh * 60 + em);
}

function extractSignalType(reason: string): string {
  if (reason.includes('大台割れ')) return '大台割れ';
  if (reason.includes('大台超え')) return '大台超え';
  if (reason.includes('VWAPクロス')) return 'VWAPクロス';
  if (reason.includes('三尊') || reason.includes('H&S')) return '三尊H&S';
  if (reason.includes('ゴールデンクロス')) return 'ゴールデンクロス';
  if (reason.includes('デッドクロス')) return 'デッドクロス';
  if (reason.includes('ダウ理論')) return 'ダウ理論';
  return 'その他';
}

main().catch(e => { console.error(e); process.exit(1); });
