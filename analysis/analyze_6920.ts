import { getDb } from '../server/db';
import { sql } from 'drizzle-orm';

/**
 * レーザーテック（6920）全トレード詳細分析
 */

function timeToMinutes(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

async function main() {
  const db = await getDb();
  const symbol = '6920';
  
  // Get all trades for 6920
  const tradesRes = await db.execute(sql.raw(
    `SELECT * FROM rt_trades WHERE symbol = '${symbol}' ORDER BY tradeDate, tradeTime`
  ));
  const allTrades = (tradesRes as any)[0] || [];
  
  console.log(`${'='.repeat(80)}`);
  console.log(`  レーザーテック（6920）全トレード分析`);
  console.log(`${'='.repeat(80)}`);
  console.log(`  総レコード数: ${allTrades.length}`);
  
  // Pair entries with exits
  interface TradePair {
    date: string;
    entryTime: string;
    exitTime: string;
    side: string;
    entryPrice: number;
    exitPrice: number;
    shares: number;
    pnl: number;
    entryReason: string;
    exitReason: string;
    boardSignal: string;
    holdMinutes: number;
  }
  
  const pairs: TradePair[] = [];
  
  for (let i = 0; i < allTrades.length; i++) {
    const t = allTrades[i];
    if (t.action === 'buy' || t.action === 'short') {
      // Find matching exit
      const exit = allTrades.find((e: any, idx: number) => 
        idx > i && 
        e.symbol === symbol && 
        e.tradeDate === t.tradeDate &&
        (e.action === 'sell' || e.action === 'cover')
      );
      if (exit && exit.pnl !== null) {
        pairs.push({
          date: t.tradeDate,
          entryTime: t.tradeTime,
          exitTime: exit.tradeTime,
          side: t.side,
          entryPrice: Number(t.price),
          exitPrice: Number(exit.price),
          shares: Number(t.shares),
          pnl: Number(exit.pnl),
          entryReason: t.reason,
          exitReason: exit.reason,
          boardSignal: t.boardSignal || 'unknown',
          holdMinutes: timeToMinutes(exit.tradeTime) - timeToMinutes(t.tradeTime),
        });
      }
    }
  }
  
  console.log(`  完了ペア数: ${pairs.length}`);
  console.log(`  期間: ${pairs[0]?.date} 〜 ${pairs[pairs.length - 1]?.date}`);
  
  // ========== 1. 全体サマリー ==========
  console.log(`\n${'─'.repeat(80)}`);
  console.log(`  1. 全体サマリー`);
  console.log(`${'─'.repeat(80)}`);
  
  const wins = pairs.filter(p => p.pnl > 0);
  const losses = pairs.filter(p => p.pnl <= 0);
  const totalPnl = pairs.reduce((s, p) => s + p.pnl, 0);
  const avgPnl = totalPnl / pairs.length;
  const avgWin = wins.length > 0 ? wins.reduce((s, p) => s + p.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, p) => s + p.pnl, 0) / losses.length : 0;
  const maxWin = wins.length > 0 ? Math.max(...wins.map(p => p.pnl)) : 0;
  const maxLoss = losses.length > 0 ? Math.min(...losses.map(p => p.pnl)) : 0;
  
  console.log(`  総取引数: ${pairs.length}`);
  console.log(`  勝ち: ${wins.length}件 | 負け: ${losses.length}件`);
  console.log(`  勝率: ${(wins.length / pairs.length * 100).toFixed(1)}%`);
  console.log(`  総損益: ${totalPnl.toLocaleString()}円`);
  console.log(`  平均損益: ${avgPnl.toLocaleString()}円`);
  console.log(`  平均勝ち: +${avgWin.toLocaleString()}円 | 平均負け: ${avgLoss.toLocaleString()}円`);
  console.log(`  最大勝ち: +${maxWin.toLocaleString()}円 | 最大負け: ${maxLoss.toLocaleString()}円`);
  console.log(`  リスクリワード比: ${avgLoss !== 0 ? (avgWin / Math.abs(avgLoss)).toFixed(2) : 'N/A'}`);
  
  // ========== 2. 方向別分析 ==========
  console.log(`\n${'─'.repeat(80)}`);
  console.log(`  2. 方向別分析`);
  console.log(`${'─'.repeat(80)}`);
  
  for (const side of ['long', 'short']) {
    const sideTrades = pairs.filter(p => p.side === side);
    if (sideTrades.length === 0) continue;
    const sideWins = sideTrades.filter(p => p.pnl > 0);
    const sidePnl = sideTrades.reduce((s, p) => s + p.pnl, 0);
    console.log(`\n  [${side.toUpperCase()}] ${sideTrades.length}件 | 勝率: ${(sideWins.length / sideTrades.length * 100).toFixed(1)}% | 総PnL: ${sidePnl.toLocaleString()}円`);
    console.log(`    平均勝ち: +${sideWins.length > 0 ? (sideWins.reduce((s,p)=>s+p.pnl,0)/sideWins.length).toLocaleString() : 0}円`);
    const sideLosses = sideTrades.filter(p => p.pnl <= 0);
    console.log(`    平均負け: ${sideLosses.length > 0 ? (sideLosses.reduce((s,p)=>s+p.pnl,0)/sideLosses.length).toLocaleString() : 0}円`);
  }
  
  // ========== 3. シグナル別分析 ==========
  console.log(`\n${'─'.repeat(80)}`);
  console.log(`  3. エントリーシグナル別分析`);
  console.log(`${'─'.repeat(80)}`);
  
  const bySignalType: Record<string, TradePair[]> = {};
  for (const p of pairs) {
    let sigType = 'その他';
    if (p.entryReason.includes('大台確認') || p.entryReason.includes('大台超え') || p.entryReason.includes('大台割れ')) {
      sigType = '大台確認';
    } else if (p.entryReason.includes('逆三尊') || p.entryReason.includes('インバースH&S')) {
      sigType = '逆三尊';
    } else if (p.entryReason.includes('VWAP')) {
      sigType = 'VWAPクロス';
    } else if (p.entryReason.includes('ダウ理論')) {
      sigType = 'ダウ理論';
    } else if (p.entryReason.includes('三尊') || p.entryReason.includes('H&S')) {
      sigType = '三尊天井';
    }
    if (!bySignalType[sigType]) bySignalType[sigType] = [];
    bySignalType[sigType].push(p);
  }
  
  for (const [sig, trades] of Object.entries(bySignalType).sort((a, b) => b[1].length - a[1].length)) {
    const sigWins = trades.filter(p => p.pnl > 0);
    const sigPnl = trades.reduce((s, p) => s + p.pnl, 0);
    console.log(`\n  [${sig}] ${trades.length}件 | 勝率: ${(sigWins.length / trades.length * 100).toFixed(1)}% | 総PnL: ${sigPnl.toLocaleString()}円`);
  }
  
  // ========== 4. 決済理由別分析 ==========
  console.log(`\n${'─'.repeat(80)}`);
  console.log(`  4. 決済理由別分析`);
  console.log(`${'─'.repeat(80)}`);
  
  const byExitReason: Record<string, TradePair[]> = {};
  for (const p of pairs) {
    let exitType = 'その他';
    if (p.exitReason.includes('損切り')) exitType = '損切り';
    else if (p.exitReason.includes('利確')) exitType = '利確';
    else if (p.exitReason.includes('大引け') || p.exitReason.includes('強制決済')) exitType = '大引け決済';
    else if (p.exitReason.includes('板読み早期利確')) exitType = '板読み早期利確';
    if (!byExitReason[exitType]) byExitReason[exitType] = [];
    byExitReason[exitType].push(p);
  }
  
  for (const [reason, trades] of Object.entries(byExitReason).sort((a, b) => b[1].length - a[1].length)) {
    const reasonPnl = trades.reduce((s, p) => s + p.pnl, 0);
    const avgHold = trades.reduce((s, p) => s + p.holdMinutes, 0) / trades.length;
    console.log(`  [${reason}] ${trades.length}件 | 総PnL: ${reasonPnl.toLocaleString()}円 | 平均保有: ${avgHold.toFixed(0)}分`);
  }
  
  // ========== 5. 時間帯別分析 ==========
  console.log(`\n${'─'.repeat(80)}`);
  console.log(`  5. エントリー時間帯別分析`);
  console.log(`${'─'.repeat(80)}`);
  
  const byHour: Record<string, TradePair[]> = {};
  for (const p of pairs) {
    const hour = p.entryTime.substring(0, 2) + ':00';
    if (!byHour[hour]) byHour[hour] = [];
    byHour[hour].push(p);
  }
  
  for (const [hour, trades] of Object.entries(byHour).sort()) {
    const hourWins = trades.filter(p => p.pnl > 0);
    const hourPnl = trades.reduce((s, p) => s + p.pnl, 0);
    console.log(`  [${hour}台] ${trades.length}件 | 勝率: ${(hourWins.length / trades.length * 100).toFixed(0)}% | PnL: ${hourPnl.toLocaleString()}円`);
  }
  
  // ========== 6. MFE/MAE分析（足データがある日のみ） ==========
  console.log(`\n${'─'.repeat(80)}`);
  console.log(`  6. MFE/MAE分析（エントリー後の値動き）`);
  console.log(`${'─'.repeat(80)}`);
  
  const mfeResults: { pnl: number; mfe: number; mae: number; date: string; side: string; entryPrice: number }[] = [];
  
  for (const p of pairs) {
    const candlesRes = await db.execute(sql.raw(
      `SELECT candleTime, high, low, close FROM rt_candles WHERE tradeDate = '${p.date}' AND symbol = '${symbol}' AND candleTime > '${p.entryTime}' ORDER BY candleTime`
    ));
    const candles = (candlesRes as any)[0] || [];
    
    if (candles.length === 0) continue;
    
    let mfe = 0, mae = 0;
    for (const c of candles) {
      if (p.side === 'long') {
        const favorable = (Number(c.high) - p.entryPrice) / p.entryPrice * 100;
        const adverse = (p.entryPrice - Number(c.low)) / p.entryPrice * 100;
        if (favorable > mfe) mfe = favorable;
        if (adverse > mae) mae = adverse;
      } else {
        const favorable = (p.entryPrice - Number(c.low)) / p.entryPrice * 100;
        const adverse = (Number(c.high) - p.entryPrice) / p.entryPrice * 100;
        if (favorable > mfe) mfe = favorable;
        if (adverse > mae) mae = adverse;
      }
    }
    
    mfeResults.push({ pnl: p.pnl, mfe, mae, date: p.date, side: p.side, entryPrice: p.entryPrice });
  }
  
  if (mfeResults.length > 0) {
    const avgMFE = mfeResults.reduce((s, r) => s + r.mfe, 0) / mfeResults.length;
    const avgMAE = mfeResults.reduce((s, r) => s + r.mae, 0) / mfeResults.length;
    const tpReachable = mfeResults.filter(r => r.mfe >= 1.5);
    const slHit05 = mfeResults.filter(r => r.mae >= 0.5);
    const slHit09 = mfeResults.filter(r => r.mae >= 0.9);
    const slHit12 = mfeResults.filter(r => r.mae >= 1.2);
    
    console.log(`  分析対象: ${mfeResults.length}件`);
    console.log(`  平均MFE: +${avgMFE.toFixed(2)}%`);
    console.log(`  平均MAE: -${avgMAE.toFixed(2)}%`);
    console.log(`  TP(1.5%)到達率: ${(tpReachable.length / mfeResults.length * 100).toFixed(0)}% (${tpReachable.length}/${mfeResults.length})`);
    console.log(`  SL 0.5%ヒット率: ${(slHit05.length / mfeResults.length * 100).toFixed(0)}% (${slHit05.length}/${mfeResults.length})`);
    console.log(`  SL 0.9%ヒット率: ${(slHit09.length / mfeResults.length * 100).toFixed(0)}% (${slHit09.length}/${mfeResults.length})`);
    console.log(`  SL 1.2%ヒット率: ${(slHit12.length / mfeResults.length * 100).toFixed(0)}% (${slHit12.length}/${mfeResults.length})`);
    
    // TP到達可能だったがSLで刈られたケース
    const couldHaveWon = mfeResults.filter(r => r.mfe >= 1.5 && r.pnl <= 0);
    console.log(`\n  ★ TP到達可能だったが負けたケース: ${couldHaveWon.length}件`);
    for (const r of couldHaveWon) {
      console.log(`    ${r.date} | ${r.side} @${r.entryPrice.toLocaleString()} | MFE:+${r.mfe.toFixed(2)}% MAE:-${r.mae.toFixed(2)}% | PnL:${r.pnl.toLocaleString()}円`);
    }
    
    // 方向正解率（MFE > MAE なら方向正解）
    const directionCorrect = mfeResults.filter(r => r.mfe > r.mae);
    console.log(`\n  方向正解率（MFE > MAE）: ${(directionCorrect.length / mfeResults.length * 100).toFixed(0)}% (${directionCorrect.length}/${mfeResults.length})`);
    
    // SL別シミュレーション
    console.log(`\n  --- SL別期待損益シミュレーション ---`);
    for (const slPct of [0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.2, 1.5]) {
      let simPnl = 0;
      let simWins = 0;
      for (const r of mfeResults) {
        if (r.mae >= slPct && r.mfe < 1.5) {
          // SL hit, TP not reached
          simPnl -= slPct / 100 * r.entryPrice * (r.side === 'long' ? 100 : 100);
          // approximate with 100 shares
        } else if (r.mfe >= 1.5) {
          // Check if SL hit before TP
          // Simplified: if MAE >= SL, assume SL hit first (conservative)
          if (r.mae >= slPct) {
            // Could go either way - need candle-by-candle check
            // For now, mark as ambiguous
            simPnl -= slPct / 100 * r.entryPrice * 100;
          } else {
            simPnl += 1.5 / 100 * r.entryPrice * 100;
            simWins++;
          }
        } else {
          // Neither TP nor SL hit - forced close
          simPnl += r.pnl; // use actual PnL
        }
      }
      console.log(`    SL ${slPct}%: 勝ち${simWins}件 / 概算PnL ${simPnl.toLocaleString()}円`);
    }
  }
  
  // ========== 7. 全トレード一覧 ==========
  console.log(`\n${'─'.repeat(80)}`);
  console.log(`  7. 全トレード一覧`);
  console.log(`${'─'.repeat(80)}`);
  
  for (const p of pairs) {
    const result = p.pnl > 0 ? '○' : '×';
    const pnlStr = p.pnl > 0 ? `+${p.pnl.toLocaleString()}` : p.pnl.toLocaleString();
    console.log(`  ${result} ${p.date} ${p.entryTime}→${p.exitTime} | ${p.side.toUpperCase()} @${p.entryPrice.toLocaleString()} x${p.shares} | ${pnlStr}円 | ${p.holdMinutes}分 | ${p.exitReason.substring(0, 30)} | board:${p.boardSignal}`);
  }
  
  // ========== 8. 板シグナル別分析 ==========
  console.log(`\n${'─'.repeat(80)}`);
  console.log(`  8. 板シグナル別分析`);
  console.log(`${'─'.repeat(80)}`);
  
  const byBoard: Record<string, TradePair[]> = {};
  for (const p of pairs) {
    if (!byBoard[p.boardSignal]) byBoard[p.boardSignal] = [];
    byBoard[p.boardSignal].push(p);
  }
  
  for (const [board, trades] of Object.entries(byBoard).sort((a, b) => b[1].length - a[1].length)) {
    const bWins = trades.filter(p => p.pnl > 0);
    const bPnl = trades.reduce((s, p) => s + p.pnl, 0);
    console.log(`  [${board}] ${trades.length}件 | 勝率: ${(bWins.length / trades.length * 100).toFixed(0)}% | PnL: ${bPnl.toLocaleString()}円`);
  }
  
  // ========== 9. 連敗分析 ==========
  console.log(`\n${'─'.repeat(80)}`);
  console.log(`  9. 連敗・連勝分析`);
  console.log(`${'─'.repeat(80)}`);
  
  let currentStreak = 0;
  let maxLoseStreak = 0;
  let maxWinStreak = 0;
  let streakType: 'win' | 'loss' | null = null;
  
  for (const p of pairs) {
    if (p.pnl > 0) {
      if (streakType === 'win') {
        currentStreak++;
      } else {
        if (streakType === 'loss' && currentStreak > maxLoseStreak) maxLoseStreak = currentStreak;
        currentStreak = 1;
        streakType = 'win';
      }
    } else {
      if (streakType === 'loss') {
        currentStreak++;
      } else {
        if (streakType === 'win' && currentStreak > maxWinStreak) maxWinStreak = currentStreak;
        currentStreak = 1;
        streakType = 'loss';
      }
    }
  }
  if (streakType === 'loss' && currentStreak > maxLoseStreak) maxLoseStreak = currentStreak;
  if (streakType === 'win' && currentStreak > maxWinStreak) maxWinStreak = currentStreak;
  
  console.log(`  最大連勝: ${maxWinStreak}回`);
  console.log(`  最大連敗: ${maxLoseStreak}回`);
  
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
