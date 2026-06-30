/**
 * 6/26 SELLシグナルのフィルター通過率を分析
 */
import { getDb } from '../server/db';
import { sql } from 'drizzle-orm';
import { detectSignals, calcMA, calcRSI, calcBollinger } from '../server/routers/stockData';
import { boardReadingScore } from '../server/realtimeSimEngine';

async function main() {
  const db = await getDb();
  const symbols26 = ['6526', '9984', '6976', '6920', '8035', '6857', '7011'];

  console.log('=== 6/26 SELLシグナルのフィルター通過率 ===');
  console.log('(6/26は下落日でSHORTが成功した日)\n');

  let totalSell = 0, spBlocked = 0, boardBlocked = 0, medBlocked = 0;
  let timeBlocked = 0, htfBlocked = 0, wouldPass = 0;

  for (const sym of symbols26) {
    const [rows] = await db.execute(sql`
      SELECT candleTime, open, high, low, close, volume, boardSnapshot
      FROM rt_candles
      WHERE tradeDate = '2026-06-26' AND symbol = ${sym}
      ORDER BY candleTime ASC
    `);
    const candles = (rows as any[]).map(r => ({
      time: r.candleTime,
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
      volume: Number(r.volume),
      boardSnapshot: r.boardSnapshot,
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
    const sellSignals = withSignals.filter(c => c.signal?.type === 'sell');
    totalSell += sellSignals.length;

    let symPass = 0;
    for (const c of sellSignals) {
      const sig = c.signal;
      if (!sig) continue;
      const idx = candles.findIndex(x => x.time === c.time);
      const bs = candles[idx]?.boardSnapshot;
      const boardSig = bs?.signal || 'neutral';

      if (c.time >= '11:00' && c.time < '11:30') { timeBlocked++; continue; }
      if (c.time >= '12:30' && c.time < '13:00') { timeBlocked++; continue; }

      // buy_pressure時SHORT禁止
      if (boardSig === 'buy_pressure') { spBlocked++; continue; }

      // Board reading score for SHORT
      const brScore = boardReadingScore(sym, 'short', bs);
      if (brScore < 1) { boardBlocked++; continue; }

      // medium品質ブロック (ダウ理論以外)
      if (sig.confidence === 'medium' && !sig.reason.startsWith('ダウ理論')) { medBlocked++; continue; }

      // ダウ理論は押し目待機
      if (sig.reason.startsWith('ダウ理論: 直近安値更新')) { htfBlocked++; continue; }

      symPass++;
      wouldPass++;
      if (symPass <= 3) {
        console.log(`  [${sym}] PASS: ${c.time} ${sig.confidence} | ${sig.reason.substring(0, 60)} | board=${boardSig}`);
      }
    }
    if (symPass > 0) {
      console.log(`  ${sym}: ${sellSignals.length}件中 ${symPass}件通過\n`);
    }
  }

  console.log(`\n  SELLシグナル合計: ${totalSell}件`);
  console.log(`  ├─ 時間帯フィルター: ${timeBlocked}件`);
  console.log(`  ├─ buy_pressure時SHORT禁止: ${spBlocked}件`);
  console.log(`  ├─ 板読みスコア不足(<1): ${boardBlocked}件`);
  console.log(`  ├─ medium品質ブロック: ${medBlocked}件`);
  console.log(`  ├─ ダウ理論→押し目待機: ${htfBlocked}件`);
  console.log(`  └─ 通過候補: ${wouldPass}件`);

  console.log(`\n\n=== 比較まとめ ===`);
  console.log(`6/26 (下落日): SELLシグナル${totalSell}件 → 通過候補${wouldPass}件 → 実際エントリー6件`);
  console.log(`6/30 (上昇日): BUYシグナル305件 → 通過候補2件 → 実際エントリー0件`);
  console.log(``);
  console.log(`差の原因:`);
  console.log(`  6/26: sell_pressure=100%だが、SHORTにとってsell_pressureは味方（ブロックされない）`);
  console.log(`  6/30: sell_pressure=13-95%で、BUYにとってsell_pressureは敵（ブロックされる）`);
  console.log(``);
  console.log(`構造的非対称性:`);
  console.log(`  - 下落日: sell_pressure → SHORTは板読みスコアが高い → 通過しやすい`);
  console.log(`  - 上昇日: sell_pressure → LONGは板読みスコアが低い → 通過できない`);
  console.log(`  → 板データが「売り圧力」を示す日は、LONGが構造的に不利`);
  console.log(`  → しかし実際には「売り板が厚いのに買いが突破する」＝強い上昇日`);

  process.exit(0);
}
main();
