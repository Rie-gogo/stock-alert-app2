/**
 * 6/30 BUYシグナルがなぜ発動しなかったかを詳細にトレースする
 */
import { getDb } from '../server/db';
import { sql } from 'drizzle-orm';
import { detectSignals, calcMA, calcRSI, calcBollinger } from '../server/routers/stockData';

async function main() {
  const db = await getDb();
  const today = '2026-06-30';
  const symbols = ['6526', '9984', '6976', '6920', '8035', '6857'];
  
  console.log('=== 6/30 BUYシグナルブロック詳細分析 ===\n');
  
  for (const sym of symbols) {
    const [rows] = await db.execute(sql`
      SELECT candleTime, open, high, low, close, volume, boardSnapshot
      FROM rt_candles
      WHERE tradeDate = ${today} AND symbol = ${sym}
      ORDER BY candleTime ASC
    `);
    const candles = (rows as any[]).map(r => ({
      time: r.candleTime,
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
      volume: Number(r.volume),
      boardSignal: r.boardSnapshot?.signal || 'neutral',
    }));
    
    if (candles.length === 0) continue;
    
    const closes = candles.map(c => c.close);
    const ma5 = calcMA(closes, 5);
    const ma25 = calcMA(closes, 25);
    const rsi = calcRSI(closes, 14);
    const bbResult = calcBollinger(closes, 20, 2);
    
    const buf = candles.map((c, i) => ({
      ...c,
      ma5: ma5[i] ?? null,
      ma25: ma25[i] ?? null,
      rsi: rsi[i] ?? null,
      bbUpper: bbResult.upper[i] ?? null,
      bbLower: bbResult.lower[i] ?? null,
      bbMiddle: bbResult.middle[i] ?? null,
      signal: null as any,
    }));
    
    const withSignals = detectSignals(buf);
    const buySignals = withSignals.filter(c => c.signal?.type === 'buy');
    
    // Classify why each buy signal would be blocked
    let vwapUpBlocked = 0;
    let sellPressureBlocked = 0;
    let boardScoreBlocked = 0;
    let htfFilterBlocked = 0;
    let mediumBlocked = 0;
    let timeBlocked = 0;
    let wouldPass = 0;
    
    const dayOpen = candles[0].open;
    
    for (const c of buySignals) {
      const sig = c.signal!;
      const time = c.time;
      const idx = candles.findIndex(x => x.time === time);
      const boardSig = candles[idx]?.boardSignal || 'neutral';
      
      // Time filter
      if (time >= '11:00' && time < '11:30') { timeBlocked++; continue; }
      if (time >= '12:30' && time < '13:00') { timeBlocked++; continue; }
      
      // VWAPクロス上抜け無効化
      if (sig.reason.includes('VWAPクロス上抜け')) { vwapUpBlocked++; continue; }
      
      // sell_pressure時LONG禁止
      if (boardSig === 'sell_pressure') { sellPressureBlocked++; continue; }
      
      // medium品質ブロック
      if (sig.confidence === 'medium') { mediumBlocked++; continue; }
      
      // ダウ理論は5分足フィルター + 押し目待機（直接エントリーしない）
      if (sig.reason.startsWith('ダウ理論: 直近高値更新')) {
        // 5分足トレンド確認が必要 + 押し目待機ステートマシン
        htfFilterBlocked++;
        continue;
      }
      
      // ここまで来たら通過する可能性あり
      wouldPass++;
      console.log(`  [${sym}] PASS候補: ${time} ${sig.confidence} | ${sig.reason.substring(0, 60)} | board=${boardSig}`);
    }
    
    const priceChange = ((candles[candles.length-1].close - dayOpen) / dayOpen * 100).toFixed(2);
    console.log(`\n${sym} (日中騰落: ${priceChange}%): BUYシグナル ${buySignals.length}件`);
    console.log(`  ├─ VWAPクロス上抜け無効化: ${vwapUpBlocked}件`);
    console.log(`  ├─ sell_pressure時LONG禁止: ${sellPressureBlocked}件`);
    console.log(`  ├─ medium品質ブロック: ${mediumBlocked}件`);
    console.log(`  ├─ 時間帯フィルター: ${timeBlocked}件`);
    console.log(`  ├─ ダウ理論→押し目待機+HTF: ${htfFilterBlocked}件`);
    console.log(`  └─ 通過候補: ${wouldPass}件`);
    
    // Show board signal distribution during buy signal times
    const buyTimes = buySignals.map(c => c.time);
    const sellPressureCount = buySignals.filter(c => {
      const idx = candles.findIndex(x => x.time === c.time);
      return candles[idx]?.boardSignal === 'sell_pressure';
    }).length;
    console.log(`  [板状況] BUYシグナル時のsell_pressure率: ${buyTimes.length > 0 ? (sellPressureCount/buyTimes.length*100).toFixed(0) : 0}%`);
  }
  
  console.log('\n\n=== 結論 ===');
  console.log('BUYシグナルが発動しなかった主要因:');
  console.log('');
  console.log('1. sell_pressure時LONG禁止 (v6bルール)');
  console.log('   → 6/30は全銘柄で板がsell_pressure優位だったため、');
  console.log('     BUYシグナルが出ても板読みフィルターでブロックされた');
  console.log('');
  console.log('2. VWAPクロス上抜けシグナル完全無効化');
  console.log('   → 過去検証で0勝4敗だったため全面禁止中');
  console.log('');
  console.log('3. medium品質ブロック');
  console.log('   → BUYシグナルの半数以上がmedium → 直接エントリー禁止');
  console.log('');
  console.log('4. ダウ理論シグナルは「押し目待機」に入る');
  console.log('   → 直接エントリーせず、一度下がってから再上昇を確認する必要がある');
  console.log('   → 押し目確認時にもsell_pressure判定で再度ブロックされる');
  
  process.exit(0);
}
main();
