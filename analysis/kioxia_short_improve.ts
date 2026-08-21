import { getDb } from '../server/db';
import { sql } from 'drizzle-orm';

interface TradeResult {
  date: string; time: string; entry: number;
  riseFromOpen: number; dropFromHigh: number;
  exitType: string; exitTime: string; pnl: number;
  minsFromHigh: number; maSlope: number;
  volume: number; avgVol: number; volRatio: number;
  dropSpeed: number; // 下落速度 (%/分)
  consecutiveBear: number; // 連続陰線数
  entryBodyPct: number; // エントリー足実体率
}

async function loadAllCandles() {
  const db = await getDb();
  const rDates = await db.execute(sql`
    SELECT DISTINCT tradeDate FROM rt_candles WHERE symbol = '285A' ORDER BY tradeDate
  `);
  const allDates = ((rDates as any)[0] as any[]).map((r: any) => r.tradeDate);
  const allCandles: Record<string, any[]> = {};
  for (const date of allDates) {
    const rr = await db.execute(sql`
      SELECT candleTime, open, high, low, close, volume FROM rt_candles
      WHERE symbol = '285A' AND tradeDate = ${date}
      ORDER BY candleTime
    `);
    allCandles[date] = (rr as any)[0] as any[];
  }
  return { allDates, allCandles };
}

function runSimFromCache(allDates: string[], allCandles: Record<string, any[]>, params: {
  minRiseFromOpen: number; dropFromHighPct: number;
  slPct: number; tpPct: number;
  startTime: string; endTime: string;
  minMinsFromHigh?: number; maxDropSpeed?: number; minDropSpeed?: number;
  minConsecutiveBear?: number; minVolRatio?: number;
  maPeriod?: number; minSlope?: number;
}): TradeResult[] {
  const results: TradeResult[] = [];
  const maPeriod = params.maPeriod ?? 8;

  for (const date of allDates) {
    const candles = allCandles[date];
    if (!candles || candles.length < maPeriod + 2) continue;

    let dayHigh = 0, dayHighIdx = 0, fired = false;
    const dayOpen = Number(candles[0].open);

    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];
      const h = Number(c.high), cl = Number(c.close), o = Number(c.open), vol = Number(c.volume);
      const t = c.candleTime;
      if (h > dayHigh) { dayHigh = h; dayHighIdx = i; }
      if (t < params.startTime || t > params.endTime || i < maPeriod + 1 || fired) continue;

      const riseFromOpen = dayOpen > 0 ? (dayHigh - dayOpen) / dayOpen * 100 : 0;
      if (riseFromOpen < params.minRiseFromOpen) continue;

      const dropFromHigh = dayHigh > 0 ? (dayHigh - cl) / dayHigh * 100 : 0;
      if (dropFromHigh < params.dropFromHighPct) continue;

      // MA下向き
      const currentSlice = candles.slice(i - maPeriod + 1, i + 1).map((x: any) => Number(x.close));
      const currentMA = currentSlice.reduce((a: number, b: number) => a + b, 0) / maPeriod;
      const prevSlice = candles.slice(i - maPeriod, i).map((x: any) => Number(x.close));
      const prevMA = prevSlice.reduce((a: number, b: number) => a + b, 0) / maPeriod;
      if (currentMA >= prevMA) continue;

      // MA傾き
      const slice2ago = candles.slice(i - maPeriod - 1, i - 1).map((x: any) => Number(x.close));
      const ma2ago = slice2ago.reduce((a: number, b: number) => a + b, 0) / maPeriod;
      const maSlope = ma2ago > 0 ? (currentMA - ma2ago) / ma2ago * 100 : 0;
      if (params.minSlope && maSlope > -params.minSlope) continue;

      // 直近10本安値更新
      const lookback = Math.min(10, i);
      const recent10Lows = candles.slice(i - lookback, i).map((x: any) => Number(x.low));
      const recent10Low = Math.min(...recent10Lows);
      if (Number(c.low) >= recent10Low) continue;

      // 追加指標計算
      const minsFromHigh = i - dayHighIdx;
      const dropSpeed = minsFromHigh > 0 ? dropFromHigh / minsFromHigh : dropFromHigh;
      const volLookback = Math.min(20, i);
      const avgVol = candles.slice(i - volLookback, i).reduce((s: number, x: any) => s + Number(x.volume), 0) / volLookback;
      const volRatio = avgVol > 0 ? vol / avgVol : 0;
      let consecutiveBear = 0;
      for (let k = i; k >= 0; k--) {
        if (Number(candles[k].close) < Number(candles[k].open)) consecutiveBear++;
        else break;
      }
      const entryBodyPct = o > 0 ? Math.abs(cl - o) / o * 100 : 0;

      // フィルター適用
      if (params.minMinsFromHigh && minsFromHigh < params.minMinsFromHigh) continue;
      if (params.maxDropSpeed && dropSpeed > params.maxDropSpeed) continue;
      if (params.minDropSpeed && dropSpeed < params.minDropSpeed) continue;
      if (params.minConsecutiveBear && consecutiveBear < params.minConsecutiveBear) continue;
      if (params.minVolRatio && volRatio < params.minVolRatio) continue;

      fired = true;

      const tpLine = cl * (1 - params.tpPct / 100);
      const slLine = cl * (1 + params.slPct / 100);
      let pnl = 0, exitType = '未決済', exitTime = '';

      for (let j = i + 1; j < candles.length; j++) {
        const fc = candles[j];
        const fh = Number(fc.high), fl = Number(fc.low);
        if (fh >= slLine) { pnl = cl - slLine; exitType = '損切り'; exitTime = fc.candleTime; break; }
        if (fl <= tpLine) { pnl = cl - tpLine; exitType = '利確'; exitTime = fc.candleTime; break; }
        if (fc.candleTime >= '15:00') { pnl = cl - Number(fc.close); exitType = '大引け'; exitTime = fc.candleTime; break; }
      }

      results.push({
        date, time: t, entry: cl, riseFromOpen, dropFromHigh,
        exitType, exitTime, pnl, minsFromHigh, maSlope,
        volume: vol, avgVol, volRatio, dropSpeed, consecutiveBear, entryBodyPct,
      });
    }
  }
  return results;
}

function print(label: string, results: TradeResult[]) {
  const w = results.filter(r => r.pnl > 0).length;
  const l = results.filter(r => r.pnl <= 0).length;
  const pnl = results.reduce((s, r) => s + r.pnl, 0);
  const wr = results.length > 0 ? (w / results.length * 100).toFixed(1) : '0';
  const a19 = results.find(r => r.date === '2026-08-19');
  const a20 = results.find(r => r.date === '2026-08-20');
  const mark19 = a19 ? (a19.pnl > 0 ? '○' : '×') : '-';
  const mark20 = a20 ? (a20.pnl > 0 ? '○' : '×') : '-';
  console.log(`${label}: ${results.length}件 ${w}勝${l}敗 勝率${wr}% 損益${pnl > 0 ? '+' : ''}${pnl.toFixed(0)}円 8/19=${mark19} 8/20=${mark20}`);
}

async function main() {
  const { allDates, allCandles } = await loadAllCandles();
  console.log(`データロード完了: ${allDates.length}日\n`);

  // ベースライン（最良: 上昇1%/落1.0%/SL0.6/TP1.5/全日）
  const base = { minRiseFromOpen: 1.0, dropFromHighPct: 1.0, slPct: 0.6, tpPct: 1.5, startTime: '09:45', endTime: '14:30' };
  console.log('=== ベースライン ===');
  print('base', runSimFromCache(allDates, allCandles, base));

  // --- SL/TP最適値検証 ---
  console.log('\n=== SL/TP最適値検証 ===');
  for (const sl of [0.4, 0.5, 0.6, 0.8, 1.0]) {
    for (const tp of [0.8, 1.0, 1.2, 1.5, 2.0, 2.5]) {
      const r = runSimFromCache(allDates, allCandles, { ...base, slPct: sl, tpPct: tp });
      if (r.length >= 5) print(`SL${sl}/TP${tp}`, r);
    }
  }

  // --- 経過時間フィルター ---
  console.log('\n=== 経過時間フィルター ===');
  for (const mins of [5, 8, 10, 15, 20, 30]) {
    const r = runSimFromCache(allDates, allCandles, { ...base, minMinsFromHigh: mins });
    if (r.length >= 3) print(`経過>=${mins}分`, r);
  }

  // --- 下落速度フィルター ---
  console.log('\n=== 下落速度フィルター ===');
  for (const speed of [0.05, 0.1, 0.15, 0.2, 0.3]) {
    const rMax = runSimFromCache(allDates, allCandles, { ...base, maxDropSpeed: speed });
    if (rMax.length >= 3) print(`速度<=${speed}`, rMax);
  }
  for (const speed of [0.05, 0.1, 0.15, 0.2]) {
    const rMin = runSimFromCache(allDates, allCandles, { ...base, minDropSpeed: speed });
    if (rMin.length >= 3) print(`速度>=${speed}`, rMin);
  }

  // --- 連続陰線フィルター ---
  console.log('\n=== 連続陰線フィルター ===');
  for (const bars of [2, 3, 4, 5]) {
    const r = runSimFromCache(allDates, allCandles, { ...base, minConsecutiveBear: bars });
    if (r.length >= 3) print(`陰線>=${bars}本`, r);
  }

  // --- 出来高フィルター ---
  console.log('\n=== 出来高フィルター ===');
  for (const vol of [0.8, 1.0, 1.2, 1.5, 2.0]) {
    const r = runSimFromCache(allDates, allCandles, { ...base, minVolRatio: vol });
    if (r.length >= 3) print(`出来高>=${vol}x`, r);
  }

  // --- 有望な組み合わせ ---
  console.log('\n=== 有望な組み合わせ ===');
  // 経過10分以上 + SL/TP調整
  for (const sl of [0.5, 0.6, 0.8]) {
    for (const tp of [1.0, 1.5, 2.0]) {
      const r = runSimFromCache(allDates, allCandles, { ...base, slPct: sl, tpPct: tp, minMinsFromHigh: 10 });
      if (r.length >= 5) print(`経過>=10分+SL${sl}/TP${tp}`, r);
    }
  }

  // 連続陰線2本以上 + SL/TP
  for (const sl of [0.5, 0.6, 0.8]) {
    for (const tp of [1.0, 1.5, 2.0]) {
      const r = runSimFromCache(allDates, allCandles, { ...base, slPct: sl, tpPct: tp, minConsecutiveBear: 2 });
      if (r.length >= 5) print(`陰線>=2本+SL${sl}/TP${tp}`, r);
    }
  }

  // 経過10分 + 連続陰線2本
  const combo1 = runSimFromCache(allDates, allCandles, { ...base, minMinsFromHigh: 10, minConsecutiveBear: 2 });
  print('経過>=10分+陰線>=2本', combo1);

  // 上昇2% + 落1.5% + 経過10分
  const combo2 = runSimFromCache(allDates, allCandles, { ...base, minRiseFromOpen: 2.0, dropFromHighPct: 1.5, minMinsFromHigh: 10 });
  print('上昇2%+落1.5%+経過>=10分', combo2);

  // 上昇2% + 落1.5% + 陰線2本
  const combo3 = runSimFromCache(allDates, allCandles, { ...base, minRiseFromOpen: 2.0, dropFromHighPct: 1.5, minConsecutiveBear: 2 });
  print('上昇2%+落1.5%+陰線>=2本', combo3);

  // 最良候補の全取引詳細
  console.log('\n=== プラスとマイナスの指標比較（ベースライン） ===');
  const baseResults = runSimFromCache(allDates, allCandles, base);
  const wins = baseResults.filter(r => r.pnl > 0);
  const losses = baseResults.filter(r => r.pnl <= 0);
  console.log(`| 指標 | プラス(${wins.length}件) | マイナス(${losses.length}件) |`);
  console.log('|------|---------|-----------|');
  const avgMinsW = wins.reduce((s, t) => s + t.minsFromHigh, 0) / wins.length;
  const avgMinsL = losses.reduce((s, t) => s + t.minsFromHigh, 0) / losses.length;
  console.log(`| 経過時間 | ${avgMinsW.toFixed(1)}分 | ${avgMinsL.toFixed(1)}分 |`);
  const avgSpeedW = wins.reduce((s, t) => s + t.dropSpeed, 0) / wins.length;
  const avgSpeedL = losses.reduce((s, t) => s + t.dropSpeed, 0) / losses.length;
  console.log(`| 下落速度 | ${avgSpeedW.toFixed(3)} | ${avgSpeedL.toFixed(3)} |`);
  const avgBearW = wins.reduce((s, t) => s + t.consecutiveBear, 0) / wins.length;
  const avgBearL = losses.reduce((s, t) => s + t.consecutiveBear, 0) / losses.length;
  console.log(`| 連続陰線 | ${avgBearW.toFixed(1)}本 | ${avgBearL.toFixed(1)}本 |`);
  const avgVolW = wins.reduce((s, t) => s + t.volRatio, 0) / wins.length;
  const avgVolL = losses.reduce((s, t) => s + t.volRatio, 0) / losses.length;
  console.log(`| 出来高比 | ${avgVolW.toFixed(2)}x | ${avgVolL.toFixed(2)}x |`);
  const avgSlopeW = wins.reduce((s, t) => s + t.maSlope, 0) / wins.length;
  const avgSlopeL = losses.reduce((s, t) => s + t.maSlope, 0) / losses.length;
  console.log(`| MA傾き | ${avgSlopeW.toFixed(4)}% | ${avgSlopeL.toFixed(4)}% |`);
  const avgRiseW = wins.reduce((s, t) => s + t.riseFromOpen, 0) / wins.length;
  const avgRiseL = losses.reduce((s, t) => s + t.riseFromOpen, 0) / losses.length;
  console.log(`| 始値上昇率 | ${avgRiseW.toFixed(1)}% | ${avgRiseL.toFixed(1)}% |`);
  const avgDropW = wins.reduce((s, t) => s + t.dropFromHigh, 0) / wins.length;
  const avgDropL = losses.reduce((s, t) => s + t.dropFromHigh, 0) / losses.length;
  console.log(`| 高値下落率 | ${avgDropW.toFixed(1)}% | ${avgDropL.toFixed(1)}% |`);

  process.exit(0);
}
main();
