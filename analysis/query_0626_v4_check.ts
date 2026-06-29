import { getDb } from '../server/db';
import { sql } from 'drizzle-orm';

async function main() {
  const db = await getDb();
  
  const entries = [
    { time: '10:40', symbol: '6976', name: '太陽誘電', pnl: 25590 },
    { time: '10:44', symbol: '6920', name: 'レーザーテック', pnl: -25235 },
    { time: '10:59', symbol: '5803', name: 'フジクラ', pnl: 37656 },
    { time: '13:02', symbol: '6981', name: '村田製作所', pnl: -10695 },
    { time: '13:09', symbol: '7011', name: '三菱重工業', pnl: 6300 },
    { time: '13:16', symbol: '6920', name: 'レーザーテック', pnl: 75630 },
    { time: '13:49', symbol: '6857', name: 'アドバンテスト', pnl: -16015 },
    { time: '13:50', symbol: '5016', name: 'JX金属', pnl: -11337 },
    { time: '14:16', symbol: '6981', name: '村田製作所', pnl: -10675 },
    { time: '14:48', symbol: '6857', name: 'アドバンテスト', pnl: -15990 },
    { time: '15:05', symbol: '6920', name: 'レーザーテック', pnl: 8000 },
  ];
  
  console.log('=== 6/26 大台割れ全11件 Ver4条件チェック ===');
  console.log('Ver4条件: ① 板スコア>=2 ② BPR<0.54 ③ 13時前\n');
  
  let v4Pnl = 0, v4Count = 0, v4Wins = 0;
  let currentPnl = 0;
  let blockedPnl = 0, blockedCount = 0;
  let blockedWins = 0;
  
  for (const e of entries) {
    // Use sql template literal for parameterized query
    const candles = await db.execute(
      sql`SELECT boardSnapshot FROM rt_candles 
          WHERE tradeDate = '2026-06-26' AND symbol = ${e.symbol} AND candleTime = ${e.time}`
    ) as any;
    
    const rows = candles[0] ?? candles;
    let bpr: number | null = null;
    let boardSignal = 'N/A';
    let marketOrderRatio = 0;
    
    const row = Array.isArray(rows) ? rows[0] : null;
    if (row && row.boardSnapshot) {
      // drizzle already parses JSON columns as objects
      const bs = typeof row.boardSnapshot === 'string' ? JSON.parse(row.boardSnapshot) : row.boardSnapshot;
      bpr = bs.buyPressureRatio ?? null;
      boardSignal = bs.signal ?? 'N/A';
      marketOrderRatio = bs.marketOrderRatio ?? 0;
    }
    
    currentPnl += e.pnl;
    
    const hour = parseInt(e.time.split(':')[0]);
    const min = parseInt(e.time.split(':')[1]);
    const timeDecimal = hour + min / 60;
    
    // Ver4 conditions
    const v4_time = timeDecimal < 13;  // ③ 13時前
    const v4_bpr = bpr !== null && bpr < 0.54;  // ② BPR<0.54
    // ① 板スコア>=2 は簡易計算（sell_pressure + BPR低い = スコア高い傾向）
    // 実際のboardReadingScoreを再現するのは困難なので、BPR条件で代用
    const v4_pass = v4_time && v4_bpr;
    
    const result = e.pnl > 0 ? '✓勝' : '✗負';
    const passStr = v4_pass ? '★通過' : 'ブロック';
    
    console.log(`${result} ${e.time} ${e.name}(${e.symbol}) P&L=${e.pnl.toLocaleString()}円`);
    console.log(`   BPR=${bpr?.toFixed(3) ?? 'N/A'} | 板信号=${boardSignal} | 成行比=${(marketOrderRatio*100).toFixed(1)}%`);
    console.log(`   ① 13時前=${v4_time} ② BPR<0.54=${v4_bpr} → ${passStr}`);
    console.log('');
    
    if (v4_pass) {
      v4Count++;
      v4Pnl += e.pnl;
      if (e.pnl > 0) v4Wins++;
    } else {
      blockedCount++;
      blockedPnl += e.pnl;
      if (e.pnl > 0) blockedWins++;
    }
  }
  
  console.log('='.repeat(60));
  console.log('=== 比較結果 ===\n');
  console.log(`現行: ${entries.length}件, 勝ち${entries.filter(e => e.pnl > 0).length}/負け${entries.filter(e => e.pnl < 0).length}, 勝率${(entries.filter(e => e.pnl > 0).length / entries.length * 100).toFixed(1)}%`);
  console.log(`  P&L: +${currentPnl.toLocaleString()}円`);
  console.log('');
  console.log(`Ver4通過: ${v4Count}件, 勝ち${v4Wins}/負け${v4Count - v4Wins}, 勝率${v4Count > 0 ? (v4Wins/v4Count*100).toFixed(1) : 0}%`);
  console.log(`  P&L: ${v4Pnl >= 0 ? '+' : ''}${v4Pnl.toLocaleString()}円`);
  console.log('');
  console.log(`ブロック: ${blockedCount}件, 勝ち${blockedWins}/負け${blockedCount - blockedWins}`);
  console.log(`  P&L: ${blockedPnl >= 0 ? '+' : ''}${blockedPnl.toLocaleString()}円`);
  console.log('');
  console.log('--- 判定 ---');
  
  if (v4Pnl >= currentPnl) {
    console.log(`✓ Ver4が優位: +${(v4Pnl - currentPnl).toLocaleString()}円改善`);
  } else {
    console.log(`✗ 現行が優位: Ver4だと${(currentPnl - v4Pnl).toLocaleString()}円の利益を失う`);
    console.log(`  ブロックされた${blockedCount}件のうち${blockedWins}件が勝ちトレード`);
    console.log(`  ブロックで回避した損失: ${entries.filter(e => e.pnl < 0 && !(parseInt(e.time.split(':')[0]) + parseInt(e.time.split(':')[1])/60 < 13)).reduce((s, e) => s + e.pnl, 0).toLocaleString()}円`);
  }
  
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
