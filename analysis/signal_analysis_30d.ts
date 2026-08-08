/**
 * 30日間シミュレーション: シグナル別成績分析
 */

import { getDb } from '../server/db';
import { sql } from 'drizzle-orm';

const EXCLUDED = new Set(['6920', '6758', '9984', '7011', '9107', '8306', '4568', '5016', '7203', '3778', '3436', '6723']);

interface Pair {
  symbol: string;
  name: string;
  date: string;
  side: string;
  entryPrice: number;
  pnl: number;
  entryTime: string;
  signalType: string;
  exitReason: string;
  confidence: string;
  boardSignal: string;
}

async function main() {
  const db = await getDb();
  
  // Get last 30 trade dates
  const datesRes = await db.execute(sql.raw(
    `SELECT DISTINCT tradeDate FROM rt_candles ORDER BY tradeDate DESC LIMIT 30`
  ));
  const dates = (datesRes as any)[0].map((r: any) => r.tradeDate).reverse();
  
  // Get all trades
  const tradesRes = await db.execute(sql.raw(
    `SELECT * FROM rt_trades WHERE tradeDate >= '${dates[0]}' ORDER BY tradeDate, tradeTime`
  ));
  const allTrades = (tradesRes as any)[0] || [];
  
  // Pair entries with exits
  const pairs: Pair[] = [];
  const processed = new Set<number>();
  
  for (let i = 0; i < allTrades.length; i++) {
    if (processed.has(i)) continue;
    const t = allTrades[i];
    if (t.action !== 'buy' && t.action !== 'short') continue;
    if (EXCLUDED.has(t.symbol)) continue;
    
    for (let j = i + 1; j < allTrades.length; j++) {
      if (processed.has(j)) continue;
      const e = allTrades[j];
      if (e.symbol === t.symbol && e.tradeDate === t.tradeDate && 
          (e.action === 'sell' || e.action === 'cover') && e.pnl !== null) {
        
        const reason = t.reason || '';
        let signalType = 'その他';
        if (reason.includes('大台確認')) signalType = '大台確認(4本維持)';
        else if (reason.includes('デッドクロス')) signalType = 'デッドクロス';
        else if (reason.includes('ゴールデンクロス')) signalType = 'ゴールデンクロス';
        else if (reason.includes('VWAPクロス')) signalType = 'VWAPクロス';
        else if (reason.includes('三尊') || reason.includes('H&S')) signalType = '三尊/逆三尊';
        else if (reason.includes('ダウ理論') || reason.includes('高値更新') || reason.includes('安値更新')) signalType = 'ダウ理論';
        
        let confidence = '不明';
        if (reason.includes('信頼度：強')) confidence = '強';
        else if (reason.includes('信頼度：中')) confidence = '中';
        else if (reason.includes('信頼度：弱')) confidence = '弱';
        
        pairs.push({
          symbol: t.symbol,
          name: t.symbolName || t.symbol,
          date: t.tradeDate,
          side: t.side,
          entryPrice: Number(t.price),
          pnl: Number(e.pnl),
          entryTime: t.tradeTime,
          signalType,
          exitReason: e.reason || '',
          confidence,
          boardSignal: t.boardSignal || '',
        });
        processed.add(j);
        break;
      }
    }
  }
  
  console.log('='.repeat(80));
  console.log('  30日間シミュレーション: シグナル別成績');
  console.log('  期間: ' + dates[0] + ' 〜 ' + dates[dates.length - 1]);
  console.log('  総取引: ' + pairs.length + '件');
  console.log('='.repeat(80));
  
  // Overall
  const totalWins = pairs.filter(p => p.pnl > 0).length;
  const totalPnl = pairs.reduce((s, p) => s + p.pnl, 0);
  console.log('\n  【全体】');
  console.log('  件数: ' + pairs.length + ' | 勝率: ' + (totalWins / pairs.length * 100).toFixed(1) + '% | 総PnL: ' + totalPnl.toLocaleString() + '円');
  
  // By signal type
  console.log('\n  ─── シグナル別 ───');
  const bySignal = new Map<string, Pair[]>();
  for (const p of pairs) {
    const arr = bySignal.get(p.signalType) || [];
    arr.push(p);
    bySignal.set(p.signalType, arr);
  }
  
  console.log('  シグナル            | 件数 | 勝率   | 総PnL        | 平均PnL      | PF');
  console.log('  ' + '─'.repeat(85));
  
  const signalEntries = [...bySignal.entries()].sort((a, b) => {
    return b[1].reduce((s, t) => s + t.pnl, 0) - a[1].reduce((s, t) => s + t.pnl, 0);
  });
  
  for (const [sig, trades] of signalEntries) {
    const wins = trades.filter(t => t.pnl > 0).length;
    const pnl = trades.reduce((s, t) => s + t.pnl, 0);
    const avgPnl = Math.round(pnl / trades.length);
    const grossProfit = trades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
    const grossLoss = Math.abs(trades.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
    const pf = grossLoss > 0 ? (grossProfit / grossLoss).toFixed(2) : 'INF';
    console.log('  ' + sig.padEnd(18) + ' | ' + String(trades.length).padStart(4) + ' | ' + (wins / trades.length * 100).toFixed(1).padStart(5) + '% | ' + pnl.toLocaleString().padStart(12) + '円 | ' + avgPnl.toLocaleString().padStart(11) + '円 | ' + pf);
  }
  
  // By confidence
  console.log('\n  ─── 信頼度別 ───');
  const byConf = new Map<string, Pair[]>();
  for (const p of pairs) {
    const arr = byConf.get(p.confidence) || [];
    arr.push(p);
    byConf.set(p.confidence, arr);
  }
  
  console.log('  信頼度 | 件数 | 勝率   | 総PnL        | 平均PnL');
  console.log('  ' + '─'.repeat(60));
  const confOrder = ['強', '中', '弱', '不明'];
  for (const conf of confOrder) {
    const trades = byConf.get(conf);
    if (!trades || trades.length === 0) continue;
    const wins = trades.filter(t => t.pnl > 0).length;
    const pnl = trades.reduce((s, t) => s + t.pnl, 0);
    const avgPnl = Math.round(pnl / trades.length);
    console.log('  ' + conf.padEnd(4) + '   | ' + String(trades.length).padStart(4) + ' | ' + (wins / trades.length * 100).toFixed(1).padStart(5) + '% | ' + pnl.toLocaleString().padStart(12) + '円 | ' + avgPnl.toLocaleString().padStart(11) + '円');
  }
  
  // By direction
  console.log('\n  ─── 方向別 ───');
  const longs = pairs.filter(p => p.side === 'long');
  const shorts = pairs.filter(p => p.side === 'short');
  const longWins = longs.filter(p => p.pnl > 0).length;
  const shortWins = shorts.filter(p => p.pnl > 0).length;
  const longPnl = longs.reduce((s, p) => s + p.pnl, 0);
  const shortPnl = shorts.reduce((s, p) => s + p.pnl, 0);
  console.log('  LONG:  ' + longs.length + '件 | 勝率: ' + (longWins / longs.length * 100).toFixed(1) + '% | 総PnL: ' + longPnl.toLocaleString() + '円');
  console.log('  SHORT: ' + shorts.length + '件 | 勝率: ' + (shortWins / shorts.length * 100).toFixed(1) + '% | 総PnL: ' + shortPnl.toLocaleString() + '円');
  
  // By exit reason
  console.log('\n  ─── 決済理由別 ───');
  const byExit = new Map<string, Pair[]>();
  for (const p of pairs) {
    let exitType = 'その他';
    if (p.exitReason.includes('利確')) exitType = '利確(TP)';
    else if (p.exitReason.includes('損切り')) exitType = '損切り(SL)';
    else if (p.exitReason.includes('大引け')) exitType = '大引け強制決済';
    else if (p.exitReason.includes('板読み')) exitType = '板読み早期決済';
    const arr = byExit.get(exitType) || [];
    arr.push(p);
    byExit.set(exitType, arr);
  }
  
  console.log('  決済理由         | 件数 | 総PnL        | 平均PnL');
  console.log('  ' + '─'.repeat(55));
  for (const [reason, trades] of [...byExit.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const pnl = trades.reduce((s, t) => s + t.pnl, 0);
    const avgPnl = Math.round(pnl / trades.length);
    console.log('  ' + reason.padEnd(14) + '   | ' + String(trades.length).padStart(4) + ' | ' + pnl.toLocaleString().padStart(12) + '円 | ' + avgPnl.toLocaleString().padStart(11) + '円');
  }
  
  // Signal + Direction combination
  console.log('\n  ─── シグナル×方向 ───');
  console.log('  シグナル            | 方向  | 件数 | 勝率   | 総PnL');
  console.log('  ' + '─'.repeat(70));
  for (const [sig, trades] of signalEntries) {
    const sigLongs = trades.filter(t => t.side === 'long');
    const sigShorts = trades.filter(t => t.side === 'short');
    if (sigLongs.length > 0) {
      const w = sigLongs.filter(t => t.pnl > 0).length;
      const p = sigLongs.reduce((s, t) => s + t.pnl, 0);
      console.log('  ' + sig.padEnd(18) + ' | LONG  | ' + String(sigLongs.length).padStart(4) + ' | ' + (w / sigLongs.length * 100).toFixed(1).padStart(5) + '% | ' + p.toLocaleString().padStart(12) + '円');
    }
    if (sigShorts.length > 0) {
      const w = sigShorts.filter(t => t.pnl > 0).length;
      const p = sigShorts.reduce((s, t) => s + t.pnl, 0);
      console.log('  ' + sig.padEnd(18) + ' | SHORT | ' + String(sigShorts.length).padStart(4) + ' | ' + (w / sigShorts.length * 100).toFixed(1).padStart(5) + '% | ' + p.toLocaleString().padStart(12) + '円');
    }
  }
  
  // Board signal analysis
  console.log('\n  ─── 板シグナル別 ───');
  const byBoard = new Map<string, Pair[]>();
  for (const p of pairs) {
    const board = p.boardSignal || 'unknown';
    const arr = byBoard.get(board) || [];
    arr.push(p);
    byBoard.set(board, arr);
  }
  
  console.log('  板シグナル     | 件数 | 勝率   | 総PnL        | 平均PnL');
  console.log('  ' + '─'.repeat(65));
  for (const [board, trades] of [...byBoard.entries()].sort((a, b) => {
    return b[1].reduce((s, t) => s + t.pnl, 0) - a[1].reduce((s, t) => s + t.pnl, 0);
  })) {
    const wins = trades.filter(t => t.pnl > 0).length;
    const pnl = trades.reduce((s, t) => s + t.pnl, 0);
    const avgPnl = Math.round(pnl / trades.length);
    console.log('  ' + board.padEnd(14) + ' | ' + String(trades.length).padStart(4) + ' | ' + (wins / trades.length * 100).toFixed(1).padStart(5) + '% | ' + pnl.toLocaleString().padStart(12) + '円 | ' + avgPnl.toLocaleString().padStart(11) + '円');
  }
  
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
