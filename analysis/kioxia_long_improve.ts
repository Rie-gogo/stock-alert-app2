import { getDb } from '../server/db';
import { sql } from 'drizzle-orm';

interface TradeResult {
  date: string; time: string; entry: number; drop: number;
  exitType: string; exitTime: string; pnl: number;
  volume: number; avgVol: number; volRatio: number;
  prevBarBullish: boolean; // 前足が陽線か
  recentBearBars: number; // 直近5本の陰線数
}

async function runSim(params: {
  dropPct: number; slPct: number; tpPct: number;
  amOnly: boolean; minTime?: string; minVolRatio?: number;
  requirePrevBullish?: boolean; maxBearBars?: number;
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
      const h = Number(c.high), cl = Number(c.close), o = Number(c.open), vol = Number(c.volume);
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

      // 出来高条件
      const volLookback = Math.min(20, i);
      const avgVol = candles.slice(i - volLookback, i).reduce((s: number, x: any) => s + Number(x.volume), 0) / volLookback;
      const volRatio = avgVol > 0 ? vol / avgVol : 0;
      if (params.minVolRatio && volRatio < params.minVolRatio) continue;

      // 前足陽線条件
      const prevBar = candles[i - 1];
      const prevBullish = Number(prevBar.close) > Number(prevBar.open);
      if (params.requirePrevBullish && !prevBullish) continue;

      // 直近5本の陰線数
      const recent5 = candles.slice(Math.max(0, i - 5), i);
      const bearBars = recent5.filter((x: any) => Number(x.close) < Number(x.open)).length;
      if (params.maxBearBars !== undefined && bearBars > params.maxBearBars) continue;

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

async function main() {
  console.log('=== キオクシア反転LONG 勝率70%改善案の検証 ===\n');

  // ベースライン（現行設定）
  console.log('--- ベースライン（現行: 落2.5%/SL0.6%/TP0.8%/前場） ---');
  const baseline = await runSim({ dropPct: 2.5, slPct: 0.6, tpPct: 0.8, amOnly: true });
  printResults('ベースライン', baseline);

  // 改善案1: 10時以降に限定（09時台は勝率46%、10時台70%、11時台75%）
  console.log('\n--- 改善案1: 10:00以降に限定 ---');
  const plan1 = await runSim({ dropPct: 2.5, slPct: 0.6, tpPct: 0.8, amOnly: true, minTime: '10:00' });
  printResults('案1', plan1);

  // 改善案2: 出来高1.2倍以上
  console.log('\n--- 改善案2: 出来高1.2倍以上 ---');
  const plan2 = await runSim({ dropPct: 2.5, slPct: 0.6, tpPct: 0.8, amOnly: true, minVolRatio: 1.2 });
  printResults('案2', plan2);

  // 改善案3: 前足が陽線
  console.log('\n--- 改善案3: 前足が陽線 ---');
  const plan3 = await runSim({ dropPct: 2.5, slPct: 0.6, tpPct: 0.8, amOnly: true, requirePrevBullish: true });
  printResults('案3', plan3);

  // 改善案4: 直近5本で陰線2本以下
  console.log('\n--- 改善案4: 直近5本で陰線2本以下 ---');
  const plan4 = await runSim({ dropPct: 2.5, slPct: 0.6, tpPct: 0.8, amOnly: true, maxBearBars: 2 });
  printResults('案4', plan4);

  // 改善案5: 案1+案3（10時以降 + 前足陽線）
  console.log('\n--- 改善案5: 10:00以降 + 前足陽線 ---');
  const plan5 = await runSim({ dropPct: 2.5, slPct: 0.6, tpPct: 0.8, amOnly: true, minTime: '10:00', requirePrevBullish: true });
  printResults('案5', plan5);

  // 改善案6: 案1+案4（10時以降 + 陰線2本以下）
  console.log('\n--- 改善案6: 10:00以降 + 陰線2本以下 ---');
  const plan6 = await runSim({ dropPct: 2.5, slPct: 0.6, tpPct: 0.8, amOnly: true, minTime: '10:00', maxBearBars: 2 });
  printResults('案6', plan6);

  // 改善案7: SL 0.5%に縮小
  console.log('\n--- 改善案7: SL 0.5%（損切り幅縮小） ---');
  const plan7 = await runSim({ dropPct: 2.5, slPct: 0.5, tpPct: 0.8, amOnly: true });
  printResults('案7', plan7);

  // 改善案8: TP 1.0%に拡大
  console.log('\n--- 改善案8: TP 1.0%（利確幅拡大） ---');
  const plan8 = await runSim({ dropPct: 2.5, slPct: 0.6, tpPct: 1.0, amOnly: true });
  printResults('案8', plan8);

  // 改善案9: 10:00以降 + 出来高1.2倍
  console.log('\n--- 改善案9: 10:00以降 + 出来高1.2倍 ---');
  const plan9 = await runSim({ dropPct: 2.5, slPct: 0.6, tpPct: 0.8, amOnly: true, minTime: '10:00', minVolRatio: 1.2 });
  printResults('案9', plan9);

  // 改善案10: 10:00以降 + 陰線2本以下 + 前足陽線
  console.log('\n--- 改善案10: 10:00以降 + 陰線2本以下 + 前足陽線 ---');
  const plan10 = await runSim({ dropPct: 2.5, slPct: 0.6, tpPct: 0.8, amOnly: true, minTime: '10:00', maxBearBars: 2, requirePrevBullish: true });
  printResults('案10', plan10);

  // 改善案11: 09:45以降（09:30-09:44の3勝5敗を除外）
  console.log('\n--- 改善案11: 09:45以降 ---');
  const plan11 = await runSim({ dropPct: 2.5, slPct: 0.6, tpPct: 0.8, amOnly: true, minTime: '09:45' });
  printResults('案11', plan11);

  // 改善案12: 09:45以降 + 前足陽線
  console.log('\n--- 改善案12: 09:45以降 + 前足陽線 ---');
  const plan12 = await runSim({ dropPct: 2.5, slPct: 0.6, tpPct: 0.8, amOnly: true, minTime: '09:45', requirePrevBullish: true });
  printResults('案12', plan12);

  // 8/19と8/20の発火確認
  console.log('\n--- 8/19・8/20の発火確認 ---');
  for (const plan of [
    { name: 'ベースライン', results: baseline },
    { name: '案1(10:00以降)', results: plan1 },
    { name: '案5(10:00以降+前足陽線)', results: plan5 },
    { name: '案6(10:00以降+陰線2本以下)', results: plan6 },
    { name: '案11(09:45以降)', results: plan11 },
  ]) {
    const aug19 = plan.results.find(r => r.date === '2026-08-19');
    const aug20 = plan.results.find(r => r.date === '2026-08-20');
    console.log(`${plan.name}: 8/19=${aug19 ? `${aug19.time} @${aug19.entry} ${aug19.exitType} ${aug19.pnl > 0 ? '+' : ''}${aug19.pnl.toFixed(0)}` : '発火なし'} | 8/20=${aug20 ? `${aug20.time} @${aug20.entry} ${aug20.exitType} ${aug20.pnl > 0 ? '+' : ''}${aug20.pnl.toFixed(0)}` : '発火なし'}`);
  }

  // マイナス取引の詳細分析（ベースラインの負け取引の特徴）
  console.log('\n--- マイナス取引の出来高・前足分析 ---');
  const lossTrades = baseline.filter(r => r.pnl <= 0);
  const winTrades = baseline.filter(r => r.pnl > 0);
  console.log('マイナス取引:');
  for (const t of lossTrades) {
    console.log(`  ${t.date} ${t.time} | 落${t.drop.toFixed(1)}% | vol比${t.volRatio.toFixed(1)}x | 前足${t.prevBarBullish ? '陽線' : '陰線'} | 陰線${t.recentBearBars}本 | ${t.pnl.toFixed(0)}円`);
  }
  console.log('プラス取引:');
  for (const t of winTrades) {
    console.log(`  ${t.date} ${t.time} | 落${t.drop.toFixed(1)}% | vol比${t.volRatio.toFixed(1)}x | 前足${t.prevBarBullish ? '陽線' : '陰線'} | 陰線${t.recentBearBars}本 | +${t.pnl.toFixed(0)}円`);
  }

  // 統計
  const avgVolWin = winTrades.reduce((s, t) => s + t.volRatio, 0) / winTrades.length;
  const avgVolLoss = lossTrades.reduce((s, t) => s + t.volRatio, 0) / lossTrades.length;
  const prevBullWin = winTrades.filter(t => t.prevBarBullish).length;
  const prevBullLoss = lossTrades.filter(t => t.prevBarBullish).length;
  const avgBearWin = winTrades.reduce((s, t) => s + t.recentBearBars, 0) / winTrades.length;
  const avgBearLoss = lossTrades.reduce((s, t) => s + t.recentBearBars, 0) / lossTrades.length;
  console.log(`\n出来高比 プラス平均:${avgVolWin.toFixed(1)}x マイナス平均:${avgVolLoss.toFixed(1)}x`);
  console.log(`前足陽線 プラス:${prevBullWin}/${winTrades.length} マイナス:${prevBullLoss}/${lossTrades.length}`);
  console.log(`陰線数 プラス平均:${avgBearWin.toFixed(1)}本 マイナス平均:${avgBearLoss.toFixed(1)}本`);

  process.exit(0);
}
main();
