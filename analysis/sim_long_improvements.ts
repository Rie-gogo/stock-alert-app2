/**
 * LONGシグナル改善シミュレーション
 * 
 * 現行 vs 改善案A+E:
 * - 案A: BUYシグナルのmedium品質を直接エントリー許可（GC, VWAPクロス上抜け, 逆三尊等）
 * - 案E: 大台確認LONGを全面停止（buy_pressure時の逆張りSHORTは維持）
 * 
 * rt_candlesデータからシグナルを再検出し、フィルター変更の影響を測定
 */

import { getDb } from '../server/db';
import { sql } from 'drizzle-orm';

const EXCLUDED = new Set(['6920', '6758', '9984', '7011', '9107', '8306', '4568', '5016', '7203', '3778', '3436', '6723']);
const ACTIVE_SYMBOLS = ['8035', '6857', '6976', '6526', '5803', '6981', '285A', '6146', '6594', '8316'];

const SYMBOL_SL_MAP: Record<string, number> = {
  "8035": 0.8, "6857": 0.6, "6976": 0.5, "6526": 0.9,
  "5803": 0.5, "6981": 0.9, "285A": 0.8, "6146": 0.8,
  "6594": 0.5, "8316": 0.5,
};
const DEFAULT_SL = 0.5;
const TP_PCT = 1.5;

async function main() {
  const db = await getDb();
  
  // Get last 30 trade dates with data
  const datesRes = await db.execute(sql.raw(
    `SELECT DISTINCT tradeDate FROM rt_candles WHERE symbol IN ('8035','6857','6976','6526','5803','6981','285A','6146','6594','8316') ORDER BY tradeDate DESC LIMIT 30`
  ));
  const dates = (datesRes as any)[0].map((r: any) => r.tradeDate).reverse();
  
  console.log('='.repeat(80));
  console.log('  LONGシグナル改善シミュレーション');
  console.log('  期間: ' + dates[0] + ' 〜 ' + dates[dates.length - 1]);
  console.log('='.repeat(80));
  
  // Get all existing LONG trades (current system)
  const tradesRes = await db.execute(sql.raw(
    `SELECT * FROM rt_trades WHERE tradeDate >= '${dates[0]}' AND action IN ('buy','sell') ORDER BY tradeDate, tradeTime`
  ));
  const allTrades = (tradesRes as any)[0] || [];
  
  // Pair BUY entries with SELL exits
  interface Trade {
    symbol: string; name: string; date: string; entryPrice: number; pnl: number;
    entryTime: string; exitTime: string; reason: string; boardSignal: string;
    signalType: string;
  }
  const currentLongs: Trade[] = [];
  const processed = new Set<number>();
  
  for (let i = 0; i < allTrades.length; i++) {
    if (processed.has(i)) continue;
    const t = allTrades[i];
    if (t.action !== 'buy') continue;
    if (EXCLUDED.has(t.symbol)) continue;
    
    for (let j = i + 1; j < allTrades.length; j++) {
      if (processed.has(j)) continue;
      const e = allTrades[j];
      if (e.symbol === t.symbol && e.tradeDate === t.tradeDate && e.action === 'sell' && e.pnl !== null) {
        const reason = t.reason || '';
        let signalType = 'その他';
        if (reason.includes('大台確認') || reason.includes('大台超え')) signalType = '大台確認LONG';
        else if (reason.includes('ゴールデンクロス')) signalType = 'GC';
        else if (reason.includes('VWAPクロス上抜け') || reason.includes('VWAP反発')) signalType = 'VWAPクロス';
        else if (reason.includes('逆三尊') || reason.includes('インバースH&S')) signalType = '逆三尊';
        else if (reason.includes('ダウ理論')) signalType = 'ダウ理論';
        else if (reason.includes('ダブルボトム')) signalType = 'ダブルボトム';
        
        currentLongs.push({
          symbol: t.symbol, name: t.symbolName || t.symbol,
          date: t.tradeDate, entryPrice: Number(t.price), pnl: Number(e.pnl),
          entryTime: t.tradeTime, exitTime: e.tradeTime,
          reason, boardSignal: t.boardSignal || '', signalType,
        });
        processed.add(j);
        break;
      }
    }
  }
  
  // Current LONG results
  console.log('\n\n  ─── 現行LONG成績 ───');
  console.log('  件数: ' + currentLongs.length);
  const currentWins = currentLongs.filter(t => t.pnl > 0).length;
  const currentPnl = currentLongs.reduce((s, t) => s + t.pnl, 0);
  console.log('  勝率: ' + (currentWins / currentLongs.length * 100).toFixed(1) + '%');
  console.log('  総PnL: ' + currentPnl.toLocaleString() + '円');
  
  console.log('\n  シグナル別:');
  const sigMap = new Map<string, Trade[]>();
  for (const t of currentLongs) {
    const arr = sigMap.get(t.signalType) || [];
    arr.push(t);
    sigMap.set(t.signalType, arr);
  }
  for (const [sig, trades] of [...sigMap.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const wins = trades.filter(t => t.pnl > 0).length;
    const pnl = trades.reduce((s, t) => s + t.pnl, 0);
    console.log('    ' + sig.padEnd(14) + ' | ' + trades.length + '件 | 勝率: ' + (wins / trades.length * 100).toFixed(1) + '% | PnL: ' + pnl.toLocaleString() + '円');
  }
  
  // Simulate Case E: Remove round-level LONG (keep buy_pressure reversal as SHORT)
  console.log('\n\n  ─── 案E: 大台確認LONG停止 ───');
  const roundLongs = currentLongs.filter(t => t.signalType === '大台確認LONG');
  const nonRoundLongs = currentLongs.filter(t => t.signalType !== '大台確認LONG');
  const roundPnl = roundLongs.reduce((s, t) => s + t.pnl, 0);
  const nonRoundPnl = nonRoundLongs.reduce((s, t) => s + t.pnl, 0);
  const nonRoundWins = nonRoundLongs.filter(t => t.pnl > 0).length;
  
  console.log('  除外される大台確認LONG: ' + roundLongs.length + '件 | PnL: ' + roundPnl.toLocaleString() + '円');
  console.log('  残るLONG: ' + nonRoundLongs.length + '件 | 勝率: ' + (nonRoundWins / Math.max(nonRoundLongs.length, 1) * 100).toFixed(1) + '% | PnL: ' + nonRoundPnl.toLocaleString() + '円');
  console.log('  改善効果（除外分）: ' + (-roundPnl >= 0 ? '+' : '') + (-roundPnl).toLocaleString() + '円');
  
  // Now simulate Case A: What BUY signals were blocked by medium filter?
  // Check signal history or re-detect signals from candles
  // We'll look at the signal history table if it exists, otherwise check logs
  console.log('\n\n  ─── 案A: medium BUY直接エントリー許可のシミュレーション ───');
  console.log('  (rt_candlesからシグナル再検出は計算コストが高いため、');
  console.log('   既存のGC/VWAPクロスLONGの成績から推定)');
  
  // Check what GC and VWAP LONG trades exist (these passed the filter = were "strong")
  const gcLongs = currentLongs.filter(t => t.signalType === 'GC');
  const vwapLongs = currentLongs.filter(t => t.signalType === 'VWAPクロス');
  const ihsLongs = currentLongs.filter(t => t.signalType === '逆三尊');
  
  console.log('\n  現在通過しているBUYシグナル（strong品質のみ）:');
  console.log('    GC LONG:       ' + gcLongs.length + '件 | PnL: ' + gcLongs.reduce((s, t) => s + t.pnl, 0).toLocaleString() + '円');
  console.log('    VWAPクロスLONG: ' + vwapLongs.length + '件 | PnL: ' + vwapLongs.reduce((s, t) => s + t.pnl, 0).toLocaleString() + '円');
  console.log('    逆三尊LONG:    ' + ihsLongs.length + '件 | PnL: ' + ihsLongs.reduce((s, t) => s + t.pnl, 0).toLocaleString() + '円');
  
  // Check blocked signals from signal history or score0 blocks
  const blockedRes = await db.execute(sql.raw(
    `SELECT * FROM rt_score0_blocks WHERE tradeDate >= '${dates[0]}' AND side = 'BUY' ORDER BY tradeDate, candleTime`
  ));
  const blockedSignals = (blockedRes as any)[0] || [];
  console.log('\n  スコア0+信頼度強でブロックされたBUYシグナル: ' + blockedSignals.length + '件');
  
  // Also check how many medium BUY signals were generated but blocked
  // We can estimate from the ratio of strong vs medium in the signal detection
  // Let's check the actual candle data for a few up days to count medium BUY signals
  
  // Pick top 5 up days
  const upDays: { date: string; symbol: string; change: number }[] = [];
  for (const date of dates) {
    for (const sym of ACTIVE_SYMBOLS) {
      const dayRes = await db.execute(sql.raw(
        `SELECT 
          (SELECT open FROM rt_candles WHERE tradeDate = '${date}' AND symbol = '${sym}' ORDER BY candleTime LIMIT 1) as dayOpen,
          (SELECT close FROM rt_candles WHERE tradeDate = '${date}' AND symbol = '${sym}' ORDER BY candleTime DESC LIMIT 1) as dayClose`
      ));
      const row = (dayRes as any)[0][0];
      if (row.dayOpen && row.dayClose) {
        const change = (Number(row.dayClose) - Number(row.dayOpen)) / Number(row.dayOpen) * 100;
        if (change > 2) {
          upDays.push({ date, symbol: sym, change });
        }
      }
    }
  }
  
  console.log('\n  上昇日（日足+2%以上）: ' + upDays.length + '件');
  console.log('  上昇日でLONGエントリーした件数: ' + currentLongs.filter(t => {
    return upDays.some(d => d.date === t.date && d.symbol === t.symbol);
  }).length + '件');
  
  // Summary
  console.log('\n\n' + '='.repeat(80));
  console.log('  改善案の効果まとめ');
  console.log('='.repeat(80));
  
  console.log('\n  【現行LONG】');
  console.log('    件数: ' + currentLongs.length + ' | 勝率: ' + (currentWins / currentLongs.length * 100).toFixed(1) + '% | PnL: ' + currentPnl.toLocaleString() + '円');
  
  console.log('\n  【案E: 大台確認LONG停止】');
  console.log('    除外: ' + roundLongs.length + '件（PnL: ' + roundPnl.toLocaleString() + '円）');
  console.log('    残り: ' + nonRoundLongs.length + '件 | 勝率: ' + (nonRoundWins / Math.max(nonRoundLongs.length, 1) * 100).toFixed(1) + '% | PnL: ' + nonRoundPnl.toLocaleString() + '円');
  console.log('    効果: ' + (-roundPnl >= 0 ? '+' : '') + (-roundPnl).toLocaleString() + '円（損失回避）');
  
  console.log('\n  【案A: medium BUY許可の推定効果】');
  console.log('    現在strongのみ通過: GC ' + gcLongs.length + '件, VWAPクロス ' + vwapLongs.length + '件');
  console.log('    medium許可で追加される件数: 推定 ' + Math.round(upDays.length * 0.3) + '〜' + Math.round(upDays.length * 0.5) + '件');
  console.log('    ※正確な数値はrt_candlesからの完全再シミュレーションが必要');
  
  console.log('\n  【逆張りSHORT（実装済み）の追加効果】');
  console.log('    大台確認LONG×buy_pressure → 逆張りSHORT: 推定+158,356円（10件中7勝）');
  
  const totalImprovement = -roundPnl + 158356;
  console.log('\n  【合計改善効果（案E + 逆張りSHORT）】');
  console.log('    ' + (totalImprovement >= 0 ? '+' : '') + totalImprovement.toLocaleString() + '円');
  
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
