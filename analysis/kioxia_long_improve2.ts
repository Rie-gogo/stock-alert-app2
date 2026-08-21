import { getDb } from '../server/db';
import { sql } from 'drizzle-orm';

interface TradeResult {
  date: string; time: string; entry: number; drop: number;
  exitType: string; exitTime: string; pnl: number;
  volume: number; avgVol: number; volRatio: number;
  prevBarBullish: boolean;
  recentBearBars: number;
  consecutiveBullish: number; // 直近の連続陽線数
  entryBodyPct: number; // エントリー足の実体率
  bounceFromLow: number; // 直近安値からの反発率
  maDeviation: number; // MA8からの乖離率
}

async function runSim(params: {
  dropPct: number; slPct: number; tpPct: number;
  amOnly: boolean; minTime?: string;
  minConsecutiveBullish?: number;
  minEntryBodyPct?: number;
  minBounceFromLow?: number;
  requirePrevBullish?: boolean;
  maxBearBars?: number;
  minVolRatio?: number;
}): Promise<TradeResult[]> {
  const db = await getDb();
  const rDates = await db.execute(sql`
    SELECT DISTINCT tradeDate FROM rt_candles WHERE symbol = '285A' ORDER BY tradeDate
  `);
  const dates = ((rDates as any)[0] as any[]).map((r: any) => r.tradeDate);

  const results: TradeResult[] = [];

  for (const date of dates) {
    const rr = await db.execute(sql`
      SELECT candleTime, open, high, low, close, volume FROM rt_candles
      WHERE symbol = '285A' AND tradeDate = ${date}
      ORDER BY candleTime
    `);
    const candles = (rr as any)[0] as any[];
    if (candles.length < 10) continue;

    let dayHigh = 0;
    let fired = false;

    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];
      const h = Number(c.high), cl = Number(c.close), o = Number(c.open), l = Number(c.low), vol = Number(c.volume);
      const t = c.candleTime;

      if (h > dayHigh) dayHigh = h;

      const endTime = params.amOnly ? '11:27' : '14:30';
      const startTime = params.minTime || '09:30';
      if (t < startTime || t > endTime || i < 9 || fired) continue;

      const dropFromHigh = dayHigh > 0 ? (dayHigh - cl) / dayHigh * 100 : 0;
      if (dropFromHigh < params.dropPct) continue;

      // MA8
      const currentSlice = candles.slice(i - 7, i + 1).map((x: any) => Number(x.close));
      const currentMA = currentSlice.reduce((a: number, b: number) => a + b, 0) / 8;
      const prevSlice = candles.slice(i - 8, i).map((x: any) => Number(x.close));
      const prevMA = prevSlice.reduce((a: number, b: number) => a + b, 0) / 8;
      const maRising = currentMA > prevMA;

      // 直近10本高値更新
      const lookback = Math.min(10, i);
      const recent10Highs = candles.slice(i - lookback, i).map((x: any) => Number(x.high));
      const recent10High = recent10Highs.length > 0 ? Math.max(...recent10Highs) : 0;
      const highBreak = h > recent10High;

      if (!maRising || !highBreak) continue;

      // 連続陽線数
      let consecutiveBullish = 0;
      for (let k = i; k >= 0; k--) {
        const kc = candles[k];
        if (Number(kc.close) > Number(kc.open)) consecutiveBullish++;
        else break;
      }

      // エントリー足の実体率
      const entryBodyPct = o > 0 ? Math.abs(cl - o) / o * 100 : 0;

      // 直近安値からの反発率
      const recentLows = candles.slice(Math.max(0, i - 10), i + 1).map((x: any) => Number(x.low));
      const recentLow = Math.min(...recentLows);
      const bounceFromLow = recentLow > 0 ? (cl - recentLow) / recentLow * 100 : 0;

      // MA8からの乖離率
      const maDeviation = currentMA > 0 ? (cl - currentMA) / currentMA * 100 : 0;

      // 出来高条件
      const volLookback = Math.min(20, i);
      const avgVol = candles.slice(i - volLookback, i).reduce((s: number, x: any) => s + Number(x.volume), 0) / volLookback;
      const volRatio = avgVol > 0 ? vol / avgVol : 0;

      // 前足
      const prevBar = candles[i - 1];
      const prevBullish = Number(prevBar.close) > Number(prevBar.open);

      // 直近5本の陰線数
      const recent5 = candles.slice(Math.max(0, i - 5), i);
      const bearBars = recent5.filter((x: any) => Number(x.close) < Number(x.open)).length;

      // フィルター適用
      if (params.minConsecutiveBullish && consecutiveBullish < params.minConsecutiveBullish) continue;
      if (params.minEntryBodyPct && entryBodyPct < params.minEntryBodyPct) continue;
      if (params.minBounceFromLow && bounceFromLow < params.minBounceFromLow) continue;
      if (params.requirePrevBullish && !prevBullish) continue;
      if (params.maxBearBars !== undefined && bearBars > params.maxBearBars) continue;
      if (params.minVolRatio && volRatio < params.minVolRatio) continue;

      fired = true;

      const tpLine = cl * (1 + params.tpPct / 100);
      const slLine = cl * (1 - params.slPct / 100);
      let pnl = 0;
      let exitType = '未決済';
      let exitTime = '';

      for (let j = i + 1; j < candles.length; j++) {
        const fc = candles[j];
        const fh = Number(fc.high), fl = Number(fc.low);
        if (fl <= slLine) { pnl = slLine - cl; exitType = '損切り'; exitTime = fc.candleTime; break; }
        if (fh >= tpLine) { pnl = tpLine - cl; exitType = '利確'; exitTime = fc.candleTime; break; }
        if (fc.candleTime >= '11:27' && params.amOnly) { pnl = Number(fc.close) - cl; exitType = '前場決済'; exitTime = fc.candleTime; break; }
        if (fc.candleTime >= '15:00') { pnl = Number(fc.close) - cl; exitType = '大引け'; exitTime = fc.candleTime; break; }
      }

      results.push({
        date, time: t, entry: cl, drop: dropFromHigh,
        exitType, exitTime, pnl, volume: vol, avgVol, volRatio,
        prevBarBullish: prevBullish, recentBearBars: bearBars,
        consecutiveBullish, entryBodyPct, bounceFromLow, maDeviation,
      });
    }
  }

  return results;
}

function printResults(label: string, results: TradeResult[]) {
  const wins = results.filter(r => r.pnl > 0).length;
  const losses = results.filter(r => r.pnl <= 0).length;
  const totalPnl = results.reduce((s, r) => s + r.pnl, 0);
  const winRate = results.length > 0 ? (wins / results.length * 100).toFixed(1) : '0';
  console.log(`${label}: ${results.length}件 ${wins}勝${losses}敗 勝率${winRate}% 損益${totalPnl > 0 ? '+' : ''}${totalPnl.toFixed(0)}円/株`);
}

function check819_820(label: string, results: TradeResult[]) {
  const aug19 = results.find(r => r.date === '2026-08-19');
  const aug20 = results.find(r => r.date === '2026-08-20');
  console.log(`  8/19=${aug19 ? `${aug19.time} @${aug19.entry} ${aug19.exitType} ${aug19.pnl > 0 ? '+' : ''}${aug19.pnl.toFixed(0)}` : '発火なし'} | 8/20=${aug20 ? `${aug20.time} @${aug20.entry} ${aug20.exitType} ${aug20.pnl > 0 ? '+' : ''}${aug20.pnl.toFixed(0)}` : '発火なし'}`);
}

async function main() {
  console.log('=== キオクシア反転LONG 追加改善案の検証 ===\n');

  // ベースライン（案11: 09:45以降）
  console.log('--- ベースライン（案11: 09:45以降） ---');
  const base = await runSim({ dropPct: 2.5, slPct: 0.6, tpPct: 0.8, amOnly: true, minTime: '09:45' });
  printResults('案11', base);
  check819_820('案11', base);

  // 追加案A: 連続陽線2本以上
  console.log('\n--- 追加案A: 09:45以降 + 連続陽線2本以上 ---');
  const planA = await runSim({ dropPct: 2.5, slPct: 0.6, tpPct: 0.8, amOnly: true, minTime: '09:45', minConsecutiveBullish: 2 });
  printResults('案A', planA);
  check819_820('案A', planA);

  // 追加案A2: 連続陽線3本以上
  console.log('\n--- 追加案A2: 09:45以降 + 連続陽線3本以上 ---');
  const planA2 = await runSim({ dropPct: 2.5, slPct: 0.6, tpPct: 0.8, amOnly: true, minTime: '09:45', minConsecutiveBullish: 3 });
  printResults('案A2', planA2);
  check819_820('案A2', planA2);

  // 追加案B: エントリー足実体0.3%以上
  console.log('\n--- 追加案B: 09:45以降 + エントリー足実体>=0.3% ---');
  const planB = await runSim({ dropPct: 2.5, slPct: 0.6, tpPct: 0.8, amOnly: true, minTime: '09:45', minEntryBodyPct: 0.3 });
  printResults('案B', planB);
  check819_820('案B', planB);

  // 追加案B2: エントリー足実体0.5%以上
  console.log('\n--- 追加案B2: 09:45以降 + エントリー足実体>=0.5% ---');
  const planB2 = await runSim({ dropPct: 2.5, slPct: 0.6, tpPct: 0.8, amOnly: true, minTime: '09:45', minEntryBodyPct: 0.5 });
  printResults('案B2', planB2);
  check819_820('案B2', planB2);

  // 追加案C: 直近安値からの反発0.5%以上
  console.log('\n--- 追加案C: 09:45以降 + 安値からの反発>=0.5% ---');
  const planC = await runSim({ dropPct: 2.5, slPct: 0.6, tpPct: 0.8, amOnly: true, minTime: '09:45', minBounceFromLow: 0.5 });
  printResults('案C', planC);
  check819_820('案C', planC);

  // 追加案C2: 直近安値からの反発1.0%以上
  console.log('\n--- 追加案C2: 09:45以降 + 安値からの反発>=1.0% ---');
  const planC2 = await runSim({ dropPct: 2.5, slPct: 0.6, tpPct: 0.8, amOnly: true, minTime: '09:45', minBounceFromLow: 1.0 });
  printResults('案C2', planC2);
  check819_820('案C2', planC2);

  // 追加案D: 連続陽線2本 + 実体0.3%
  console.log('\n--- 追加案D: 09:45以降 + 連続陽線2本 + 実体>=0.3% ---');
  const planD = await runSim({ dropPct: 2.5, slPct: 0.6, tpPct: 0.8, amOnly: true, minTime: '09:45', minConsecutiveBullish: 2, minEntryBodyPct: 0.3 });
  printResults('案D', planD);
  check819_820('案D', planD);

  // 追加案E: 連続陽線2本 + 反発0.5%
  console.log('\n--- 追加案E: 09:45以降 + 連続陽線2本 + 反発>=0.5% ---');
  const planE = await runSim({ dropPct: 2.5, slPct: 0.6, tpPct: 0.8, amOnly: true, minTime: '09:45', minConsecutiveBullish: 2, minBounceFromLow: 0.5 });
  printResults('案E', planE);
  check819_820('案E', planE);

  // 追加案F: 連続陽線2本 + 前足陽線
  console.log('\n--- 追加案F: 09:45以降 + 連続陽線2本 + 前足陽線 ---');
  const planF = await runSim({ dropPct: 2.5, slPct: 0.6, tpPct: 0.8, amOnly: true, minTime: '09:45', minConsecutiveBullish: 2, requirePrevBullish: true });
  printResults('案F', planF);
  check819_820('案F', planF);

  // 追加案G: 反発0.5% + 実体0.3%
  console.log('\n--- 追加案G: 09:45以降 + 反発>=0.5% + 実体>=0.3% ---');
  const planG = await runSim({ dropPct: 2.5, slPct: 0.6, tpPct: 0.8, amOnly: true, minTime: '09:45', minBounceFromLow: 0.5, minEntryBodyPct: 0.3 });
  printResults('案G', planG);
  check819_820('案G', planG);

  // 追加案H: 連続陽線2本 + 反発0.5% + 実体0.3%
  console.log('\n--- 追加案H: 09:45以降 + 連続陽線2本 + 反発>=0.5% + 実体>=0.3% ---');
  const planH = await runSim({ dropPct: 2.5, slPct: 0.6, tpPct: 0.8, amOnly: true, minTime: '09:45', minConsecutiveBullish: 2, minBounceFromLow: 0.5, minEntryBodyPct: 0.3 });
  printResults('案H', planH);
  check819_820('案H', planH);

  // 各取引の詳細（ベースラインの全取引に追加指標を表示）
  console.log('\n--- 案11の全取引詳細（追加指標付き） ---');
  for (const t of base) {
    const mark = t.pnl > 0 ? '○' : '×';
    console.log(`${mark} ${t.date} ${t.time} | 落${t.drop.toFixed(1)}% | 連続陽線${t.consecutiveBullish}本 | 実体${t.entryBodyPct.toFixed(2)}% | 反発${t.bounceFromLow.toFixed(2)}% | MA乖離${t.maDeviation.toFixed(2)}% | ${t.exitType} ${t.pnl > 0 ? '+' : ''}${t.pnl.toFixed(0)}円`);
  }

  process.exit(0);
}
main();
