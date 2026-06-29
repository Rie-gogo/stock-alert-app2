/**
 * Backtest 5 improvement proposals against all rt_trades/rt_candles data
 * 
 * Proposal A: PM (13:00+) BPR filter for 大台割れ SHORT → require BPR < 0.55
 * Proposal B: Entry candle direction check → block LONG on big bearish candle, SHORT on big bullish
 * Proposal C: Trailing stop (含み益+0.5%でSLを建値に移動)
 * Proposal D: VWAP deviation filter → SHORT blocked if price < VWAP-1.5%, LONG blocked if price > VWAP+3%
 * Proposal E: Breakeven stop (含み益+0.3%でSLを建値に移動 - more aggressive)
 */

import { getDb } from '../server/db';
import { sql } from 'drizzle-orm';

interface Trade {
  id: number;
  symbol: string;
  symbolName: string;
  tradeDate: string;
  tradeTime: string;
  action: string;
  price: number;
  shares: number;
  pnl: number | null;
  reason: string;
  side: string;
  boardSignal: string | null;
}

interface CandleRow {
  candleTime: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  boardSnapshot: any;
}

interface TradeResult {
  entry: Trade;
  exit: Trade;
  pnl: number;
  entryBPR: number | null;
  entryScore: number;
  isAfternoon: boolean;
  signalType: string;
  entryCandleBody: number; // positive = bullish, negative = bearish
  entryCandleATR: number;
  vwapDeviation: number; // (price - vwap) / vwap
  maxFavorable: number;
  maxAdverse: number;
  // For trailing/breakeven stop simulation
  breakevenExitPnl: number | null; // P&L if breakeven stop was active (+0.5% trigger)
  trailingExitPnl: number | null; // P&L if trailing stop was active (+0.3% trigger)
}

function calcBoardScore(bs: any, side: string): number {
  if (!bs) return 0;
  let score = 0;
  const isShort = side === 'short' || side === 'sell';
  
  const bpr = bs.buyPressureRatio ?? 0.5;
  if (isShort) {
    if (bpr <= 0.45) score += 1;
    else if (bpr >= 0.65) score -= 1;
  } else {
    if (bpr >= 0.55) score += 1;
    else if (bpr <= 0.35) score -= 1;
  }
  
  const mod = bs.marketOrderDirection;
  if (isShort) {
    if (mod === 'downtick') score += 2;
    else if (mod === 'uptick') score -= 2;
  } else {
    if (mod === 'uptick') score += 2;
    else if (mod === 'downtick') score -= 2;
  }
  
  const mor = bs.marketOrderRatio ?? 0;
  if (mor >= 0.08) {
    if (isShort && mod === 'downtick') score += 2;
    else if (!isShort && mod === 'uptick') score += 2;
    else if (isShort && mod === 'uptick') score -= 2;
    else if (!isShort && mod === 'downtick') score -= 2;
  }
  
  if (bs.mode === 'active') score += 1;
  else if (bs.mode === 'trap') score -= 2;
  
  if (isShort) {
    if (bs.icebergAskDetected) score += 1;
    if (bs.icebergBidDetected) score -= 1;
  } else {
    if (bs.icebergBidDetected) score += 1;
    if (bs.icebergAskDetected) score -= 1;
  }
  
  if (isShort) {
    if (bs.largeSellWall) score -= 1;
    if (bs.largeBuyWall) score += 1;
  } else {
    if (bs.largeBuyWall) score -= 1;
    if (bs.largeSellWall) score += 1;
  }
  
  if (isShort) {
    if (bs.signal === 'sell_pressure') score += 1;
    else if (bs.signal === 'buy_pressure') score -= 1;
  } else {
    if (bs.signal === 'buy_pressure') score += 1;
    else if (bs.signal === 'sell_pressure') score -= 1;
  }
  
  return score;
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

async function main() {
  const db = await getDb();
  
  // Get all trades
  const tradeResult = await db.execute(
    sql`SELECT id, symbol, symbolName, tradeDate, tradeTime, action, price, shares, pnl, reason, side, boardSignal
        FROM rt_trades ORDER BY tradeDate, tradeTime`
  ) as any;
  const allTrades: Trade[] = (tradeResult[0] ?? tradeResult).map((t: any) => ({
    ...t,
    price: Number(t.price),
    shares: Number(t.shares),
    pnl: t.pnl !== null ? Number(t.pnl) : null,
  }));
  
  // Pair entries with exits
  const entries = allTrades.filter(t => t.pnl === null);
  const results: TradeResult[] = [];
  
  for (const entry of entries) {
    const exit = allTrades.find(t => 
      t.symbol === entry.symbol && 
      t.tradeDate === entry.tradeDate &&
      t.tradeTime > entry.tradeTime && 
      t.pnl !== null
    );
    if (!exit) continue;
    
    // Get candle at entry time
    const candleAtEntry = await db.execute(
      sql`SELECT candleTime, open, high, low, close, volume, boardSnapshot
          FROM rt_candles 
          WHERE symbol = ${entry.symbol} AND tradeDate = ${entry.tradeDate}
          AND candleTime <= ${entry.tradeTime}
          ORDER BY candleTime DESC LIMIT 1`
    ) as any;
    const entryRow = (candleAtEntry[0] ?? candleAtEntry)[0];
    
    let entryBPR: number | null = null;
    let entryScore = 0;
    let entryCandleBody = 0;
    let entryCandleATR = 0;
    
    if (entryRow) {
      const bs = typeof entryRow.boardSnapshot === 'string' ? JSON.parse(entryRow.boardSnapshot) : entryRow.boardSnapshot;
      entryBPR = bs?.buyPressureRatio ?? null;
      entryScore = calcBoardScore(bs, entry.side);
      
      const o = Number(entryRow.open);
      const h = Number(entryRow.high);
      const l = Number(entryRow.low);
      const c = Number(entryRow.close);
      entryCandleBody = (c - o) / o * 100; // positive = bullish, negative = bearish
      entryCandleATR = (h - l) / o * 100;
    }
    
    // Calculate VWAP at entry
    const allCandlesBefore = await db.execute(
      sql`SELECT high, low, close, volume
          FROM rt_candles 
          WHERE symbol = ${entry.symbol} AND tradeDate = ${entry.tradeDate}
          AND candleTime <= ${entry.tradeTime}
          ORDER BY candleTime`
    ) as any;
    const candlesBefore = allCandlesBefore[0] ?? allCandlesBefore;
    
    let cumVol = 0, cumPV = 0;
    for (const c of candlesBefore) {
      const tp = (Number(c.high) + Number(c.low) + Number(c.close)) / 3;
      const vol = Number(c.volume);
      cumVol += vol;
      cumPV += tp * vol;
    }
    const vwap = cumVol > 0 ? cumPV / cumVol : entry.price;
    const vwapDeviation = (entry.price - vwap) / vwap;
    
    // Simulate holding period for trailing/breakeven stop
    const holdingCandles = await db.execute(
      sql`SELECT candleTime, open, high, low, close, volume
          FROM rt_candles 
          WHERE symbol = ${entry.symbol} AND tradeDate = ${entry.tradeDate}
          AND candleTime > ${entry.tradeTime}
          ORDER BY candleTime`
    ) as any;
    const holding = holdingCandles[0] ?? holdingCandles;
    
    let maxFavorable = 0;
    let maxAdverse = 0;
    let breakevenExitPnl: number | null = null;
    let trailingExitPnl: number | null = null;
    let breakevenTriggered = false;
    let trailingTriggered = false;
    
    const slPct = 0.005; // 0.5%
    const tpPct = 0.015; // 1.5%
    const breakevenTrigger = 0.005; // +0.5% triggers breakeven
    const trailingTrigger = 0.003; // +0.3% triggers breakeven (more aggressive)
    
    for (const c of holding) {
      const high = Number(c.high);
      const low = Number(c.low);
      const close = Number(c.close);
      
      let unrealizedHigh: number, unrealizedLow: number, unrealizedClose: number;
      
      if (entry.side === 'short') {
        unrealizedHigh = (entry.price - low) / entry.price; // best case for short
        unrealizedLow = (entry.price - high) / entry.price; // worst case for short
        unrealizedClose = (entry.price - close) / entry.price;
      } else {
        unrealizedHigh = (high - entry.price) / entry.price; // best case for long
        unrealizedLow = (low - entry.price) / entry.price; // worst case for long
        unrealizedClose = (close - entry.price) / entry.price;
      }
      
      const unrealizedPnlHigh = unrealizedHigh * entry.price * entry.shares;
      const unrealizedPnlLow = unrealizedLow * entry.price * entry.shares;
      
      if (unrealizedPnlHigh > maxFavorable) maxFavorable = unrealizedPnlHigh;
      if (unrealizedPnlLow < maxAdverse) maxAdverse = unrealizedPnlLow;
      
      // Breakeven stop simulation (+0.5% trigger)
      if (!breakevenTriggered && unrealizedHigh >= breakevenTrigger) {
        breakevenTriggered = true;
      }
      if (breakevenTriggered && breakevenExitPnl === null) {
        // Check if price hits breakeven (entry price) or TP
        if (unrealizedLow <= 0) {
          breakevenExitPnl = 0; // Exit at breakeven
        } else if (unrealizedHigh >= tpPct) {
          breakevenExitPnl = tpPct * entry.price * entry.shares; // TP hit
        }
      }
      
      // Trailing stop simulation (+0.3% trigger)
      if (!trailingTriggered && unrealizedHigh >= trailingTrigger) {
        trailingTriggered = true;
      }
      if (trailingTriggered && trailingExitPnl === null) {
        if (unrealizedLow <= 0) {
          trailingExitPnl = 0; // Exit at breakeven
        } else if (unrealizedHigh >= tpPct) {
          trailingExitPnl = tpPct * entry.price * entry.shares; // TP hit
        }
      }
      
      // Check if original exit would have happened (SL or TP)
      if (unrealizedLow <= -slPct || unrealizedHigh >= tpPct) {
        break; // Original trade would have exited here
      }
    }
    
    // If breakeven/trailing was triggered but never exited, use original exit
    if (breakevenExitPnl === null) breakevenExitPnl = exit.pnl!;
    if (trailingExitPnl === null) trailingExitPnl = exit.pnl!;
    
    results.push({
      entry,
      exit,
      pnl: exit.pnl!,
      entryBPR,
      entryScore,
      isAfternoon: entry.tradeTime >= '13:00',
      signalType: extractSignalType(entry.reason),
      entryCandleBody,
      entryCandleATR,
      vwapDeviation,
      maxFavorable,
      maxAdverse,
      breakevenExitPnl,
      trailingExitPnl,
    });
  }
  
  console.log(`=== 改善案バックテスト（全${results.length}取引、${[...new Set(results.map(r => r.entry.tradeDate))].length}日間） ===\n`);
  
  // Baseline
  const baseline = calcStats(results, results.map(r => r.pnl));
  console.log('【ベースライン（現行システム）】');
  printStats(baseline);
  
  // Proposal A: PM BPR filter for 大台割れ SHORT
  console.log('\n' + '='.repeat(60));
  console.log('【提案A: 後場BPRフィルター（13時以降の大台割れSHORT → BPR < 0.55必須）】');
  const proposalA_blocked: number[] = [];
  const proposalA_pnls = results.map((r, i) => {
    if (r.isAfternoon && r.signalType === '大台割れ' && r.entry.side === 'short' && r.entryBPR !== null && r.entryBPR >= 0.55) {
      proposalA_blocked.push(i);
      return null; // blocked
    }
    return r.pnl;
  });
  const proposalA = calcStats(results, proposalA_pnls);
  printStats(proposalA);
  console.log(`  ブロック数: ${proposalA_blocked.length}件`);
  printBlockedTrades(results, proposalA_blocked);
  
  // Proposal B: Entry candle direction check
  console.log('\n' + '='.repeat(60));
  console.log('【提案B: エントリー足方向チェック（LONG時大陰線/SHORT時大陽線ブロック）】');
  console.log('  条件: |実体| > ATRの50%かつ逆方向');
  const proposalB_blocked: number[] = [];
  const proposalB_pnls = results.map((r, i) => {
    if (r.entryCandleATR === 0) return r.pnl;
    const bodyRatio = Math.abs(r.entryCandleBody) / r.entryCandleATR;
    if (r.entry.side === 'long' && r.entryCandleBody < 0 && bodyRatio > 0.5) {
      proposalB_blocked.push(i);
      return null;
    }
    if (r.entry.side === 'short' && r.entryCandleBody > 0 && bodyRatio > 0.5) {
      proposalB_blocked.push(i);
      return null;
    }
    return r.pnl;
  });
  const proposalB = calcStats(results, proposalB_pnls);
  printStats(proposalB);
  console.log(`  ブロック数: ${proposalB_blocked.length}件`);
  printBlockedTrades(results, proposalB_blocked);
  
  // Proposal C: Breakeven stop at +0.5%
  console.log('\n' + '='.repeat(60));
  console.log('【提案C: ブレイクイーブンストップ（含み益+0.5%でSLを建値に移動）】');
  const proposalC_pnls = results.map(r => r.breakevenExitPnl!);
  const proposalC = calcStats(results, proposalC_pnls.map(p => p));
  printStats(proposalC);
  // Show trades that changed
  const changedC = results.filter((r, i) => Math.abs(r.pnl - proposalC_pnls[i]) > 1);
  console.log(`  結果が変わった取引: ${changedC.length}件`);
  let improvedC = 0, worsenedC = 0;
  for (let i = 0; i < results.length; i++) {
    const diff = proposalC_pnls[i] - results[i].pnl;
    if (diff > 100) improvedC++;
    if (diff < -100) worsenedC++;
  }
  console.log(`  改善: ${improvedC}件 / 悪化: ${worsenedC}件`);
  
  // Proposal D: VWAP deviation filter
  console.log('\n' + '='.repeat(60));
  console.log('【提案D: VWAP乖離フィルター（SHORT: price < VWAP-1.5%でブロック、LONG: price > VWAP+3%でブロック）】');
  const proposalD_blocked: number[] = [];
  const proposalD_pnls = results.map((r, i) => {
    if (r.entry.side === 'short' && r.vwapDeviation < -0.015) {
      proposalD_blocked.push(i);
      return null;
    }
    if (r.entry.side === 'long' && r.vwapDeviation > 0.03) {
      proposalD_blocked.push(i);
      return null;
    }
    return r.pnl;
  });
  const proposalD = calcStats(results, proposalD_pnls);
  printStats(proposalD);
  console.log(`  ブロック数: ${proposalD_blocked.length}件`);
  printBlockedTrades(results, proposalD_blocked);
  
  // Proposal E: More aggressive breakeven at +0.3%
  console.log('\n' + '='.repeat(60));
  console.log('【提案E: 早期ブレイクイーブンストップ（含み益+0.3%でSLを建値に移動）】');
  const proposalE_pnls = results.map(r => r.trailingExitPnl!);
  const proposalE = calcStats(results, proposalE_pnls.map(p => p));
  printStats(proposalE);
  let improvedE = 0, worsenedE = 0;
  for (let i = 0; i < results.length; i++) {
    const diff = proposalE_pnls[i] - results[i].pnl;
    if (diff > 100) improvedE++;
    if (diff < -100) worsenedE++;
  }
  console.log(`  改善: ${improvedE}件 / 悪化: ${worsenedE}件`);
  
  // Combined: A + D (most promising filters)
  console.log('\n' + '='.repeat(60));
  console.log('【組み合わせ: A + B + D（フィルター系全適用）】');
  const combined_pnls = results.map((r, i) => {
    // A: PM BPR filter
    if (r.isAfternoon && r.signalType === '大台割れ' && r.entry.side === 'short' && r.entryBPR !== null && r.entryBPR >= 0.55) return null;
    // B: Entry candle direction
    if (r.entryCandleATR > 0) {
      const bodyRatio = Math.abs(r.entryCandleBody) / r.entryCandleATR;
      if (r.entry.side === 'long' && r.entryCandleBody < 0 && bodyRatio > 0.5) return null;
      if (r.entry.side === 'short' && r.entryCandleBody > 0 && bodyRatio > 0.5) return null;
    }
    // D: VWAP deviation
    if (r.entry.side === 'short' && r.vwapDeviation < -0.015) return null;
    if (r.entry.side === 'long' && r.vwapDeviation > 0.03) return null;
    return r.pnl;
  });
  const combined = calcStats(results, combined_pnls);
  printStats(combined);
  const combinedBlocked = combined_pnls.filter(p => p === null).length;
  console.log(`  ブロック数: ${combinedBlocked}件`);
  
  // Combined filters + breakeven stop
  console.log('\n' + '='.repeat(60));
  console.log('【最終案: A + B + D フィルター + ブレイクイーブンストップ(+0.5%)】');
  const final_pnls = results.map((r, i) => {
    if (r.isAfternoon && r.signalType === '大台割れ' && r.entry.side === 'short' && r.entryBPR !== null && r.entryBPR >= 0.55) return null;
    if (r.entryCandleATR > 0) {
      const bodyRatio = Math.abs(r.entryCandleBody) / r.entryCandleATR;
      if (r.entry.side === 'long' && r.entryCandleBody < 0 && bodyRatio > 0.5) return null;
      if (r.entry.side === 'short' && r.entryCandleBody > 0 && bodyRatio > 0.5) return null;
    }
    if (r.entry.side === 'short' && r.vwapDeviation < -0.015) return null;
    if (r.entry.side === 'long' && r.vwapDeviation > 0.03) return null;
    return r.breakevenExitPnl;
  });
  const finalStats = calcStats(results, final_pnls);
  printStats(finalStats);
  const finalBlocked = final_pnls.filter(p => p === null).length;
  console.log(`  ブロック数: ${finalBlocked}件`);
  
  // Daily breakdown for baseline vs final
  console.log('\n' + '='.repeat(60));
  console.log('【日別比較: ベースライン vs 最終案】');
  const dates = [...new Set(results.map(r => r.entry.tradeDate))].sort();
  console.log('  日付        | ベースライン | 最終案    | 差分');
  console.log('  ' + '-'.repeat(55));
  for (const date of dates) {
    const dayResults = results.filter(r => r.entry.tradeDate === date);
    const dayBaseline = dayResults.reduce((s, r) => s + r.pnl, 0);
    const dayFinal = dayResults.reduce((s, r, i) => {
      const idx = results.indexOf(r);
      const p = final_pnls[idx];
      return s + (p ?? 0);
    }, 0);
    const diff = dayFinal - dayBaseline;
    console.log(`  ${date} | ${dayBaseline >= 0 ? '+' : ''}${Math.round(dayBaseline).toLocaleString().padStart(10)} | ${dayFinal >= 0 ? '+' : ''}${Math.round(dayFinal).toLocaleString().padStart(10)} | ${diff >= 0 ? '+' : ''}${Math.round(diff).toLocaleString()}`);
  }
  
  process.exit(0);
}

function calcStats(allResults: TradeResult[], pnls: (number | null)[]) {
  const activePnls = pnls.filter(p => p !== null) as number[];
  const wins = activePnls.filter(p => p > 0);
  const losses = activePnls.filter(p => p < 0);
  const totalPnl = activePnls.reduce((s, p) => s + p, 0);
  const winRate = activePnls.length > 0 ? wins.length / activePnls.length : 0;
  const avgWin = wins.length > 0 ? wins.reduce((s, p) => s + p, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, p) => s + p, 0) / losses.length : 0;
  const pf = Math.abs(avgLoss) > 0 ? (wins.reduce((s, p) => s + p, 0)) / Math.abs(losses.reduce((s, p) => s + p, 0)) : Infinity;
  
  return { totalTrades: activePnls.length, wins: wins.length, losses: losses.length, totalPnl, winRate, avgWin, avgLoss, pf };
}

function printStats(stats: ReturnType<typeof calcStats>) {
  console.log(`  取引数: ${stats.totalTrades} | ${stats.wins}W${stats.losses}L | 勝率: ${(stats.winRate * 100).toFixed(1)}%`);
  console.log(`  総損益: ${stats.totalPnl >= 0 ? '+' : ''}${Math.round(stats.totalPnl).toLocaleString()}円`);
  console.log(`  平均利益: +${Math.round(stats.avgWin).toLocaleString()}円 | 平均損失: ${Math.round(stats.avgLoss).toLocaleString()}円`);
  console.log(`  PF: ${stats.pf === Infinity ? '∞' : stats.pf.toFixed(2)}`);
}

function printBlockedTrades(results: TradeResult[], blocked: number[]) {
  if (blocked.length === 0) return;
  const blockedWins = blocked.filter(i => results[i].pnl > 0).length;
  const blockedLosses = blocked.filter(i => results[i].pnl < 0).length;
  const blockedPnl = blocked.reduce((s, i) => s + results[i].pnl, 0);
  console.log(`  ブロック内訳: ${blockedWins}W${blockedLosses}L → 除外P&L: ${blockedPnl >= 0 ? '+' : ''}${Math.round(blockedPnl).toLocaleString()}円`);
  // Show individual blocked trades
  for (const i of blocked.slice(0, 10)) {
    const r = results[i];
    console.log(`    ${r.entry.tradeDate} ${r.entry.tradeTime} ${r.entry.symbol}(${r.entry.symbolName}) ${r.entry.side} ${r.signalType} BPR=${r.entryBPR?.toFixed(3)} VWAP乖離=${(r.vwapDeviation*100).toFixed(2)}% → ${r.pnl >= 0 ? '+' : ''}${Math.round(r.pnl).toLocaleString()}円`);
  }
  if (blocked.length > 10) console.log(`    ... 他${blocked.length - 10}件`);
}

main().catch(e => { console.error(e); process.exit(1); });
