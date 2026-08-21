import { getDb } from '../server/db';
import { sql } from 'drizzle-orm';

// 反転SHORT: 当日高値を付けた後、MA8が下向きに転換し、直近安値を更新したらSHORTエントリー
// （反転LONGの逆バージョン）

interface TradeResult {
  date: string; time: string; entry: number;
  riseFromOpen: number; // 始値からの上昇率
  dropFromHigh: number; // 高値からの下落率（エントリー時点）
  exitType: string; exitTime: string; pnl: number;
  minsFromHigh: number; // 高値からの経過分数
  maSlope: number; // MA傾き
}

async function runSim(params: {
  minRiseFromOpen: number; // 始値からの最低上昇率（天井の高さ条件）
  dropFromHighPct: number; // 高値からの下落閾値（反落確認）
  slPct: number; tpPct: number;
  startTime: string; endTime: string;
  minSlope?: number; // MA傾き最小閾値（絶対値、下向き）
  maPeriod?: number;
}): Promise<TradeResult[]> {
  const db = await getDb();
  const rDates = await db.execute(sql`
    SELECT DISTINCT tradeDate FROM rt_candles WHERE symbol = '285A' ORDER BY tradeDate
  `);
  const allDates = ((rDates as any)[0] as any[]).map((r: any) => r.tradeDate);

  const results: TradeResult[] = [];
  const maPeriod = params.maPeriod ?? 8;

  for (const date of allDates) {
    const rr = await db.execute(sql`
      SELECT candleTime, open, high, low, close, volume FROM rt_candles
      WHERE symbol = '285A' AND tradeDate = ${date}
      ORDER BY candleTime
    `);
    const candles = (rr as any)[0] as any[];
    if (candles.length < maPeriod + 2) continue;

    let dayHigh = 0;
    let dayHighIdx = 0;
    let fired = false;
    const dayOpen = Number(candles[0].open);

    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];
      const h = Number(c.high), cl = Number(c.close);
      const t = c.candleTime;

      if (h > dayHigh) { dayHigh = h; dayHighIdx = i; }

      if (t < params.startTime || t > params.endTime || i < maPeriod + 1 || fired) continue;

      // 条件1: 始値からの上昇率が一定以上（天井が形成されている）
      const riseFromOpen = dayOpen > 0 ? (dayHigh - dayOpen) / dayOpen * 100 : 0;
      if (riseFromOpen < params.minRiseFromOpen) continue;

      // 条件2: 高値からの下落率が閾値以上
      const dropFromHigh = dayHigh > 0 ? (dayHigh - cl) / dayHigh * 100 : 0;
      if (dropFromHigh < params.dropFromHighPct) continue;

      // 条件3: MA下向き
      const currentSlice = candles.slice(i - maPeriod + 1, i + 1).map((x: any) => Number(x.close));
      const currentMA = currentSlice.reduce((a: number, b: number) => a + b, 0) / maPeriod;
      const prevSlice = candles.slice(i - maPeriod, i).map((x: any) => Number(x.close));
      const prevMA = prevSlice.reduce((a: number, b: number) => a + b, 0) / maPeriod;
      const maFalling = currentMA < prevMA;

      if (!maFalling) continue;

      // MA傾き計算
      const slice2ago = candles.slice(i - maPeriod - 1, i - 1).map((x: any) => Number(x.close));
      const ma2ago = slice2ago.reduce((a: number, b: number) => a + b, 0) / maPeriod;
      const maSlope = ma2ago > 0 ? (currentMA - ma2ago) / ma2ago * 100 : 0;

      // 傾き閾値チェック（下向きなのでマイナス値）
      if (params.minSlope && maSlope > -params.minSlope) continue;

      // 条件4: 直近10本の安値を更新
      const lookback = Math.min(10, i);
      const recent10Lows = candles.slice(i - lookback, i).map((x: any) => Number(x.low));
      const recent10Low = recent10Lows.length > 0 ? Math.min(...recent10Lows) : Infinity;
      const lowBreak = Number(c.low) < recent10Low;

      if (!lowBreak) continue;

      fired = true;
      const minsFromHigh = i - dayHighIdx;

      // SHORTエントリー
      const tpLine = cl * (1 - params.tpPct / 100);
      const slLine = cl * (1 + params.slPct / 100);
      let pnl = 0;
      let exitType = '未決済';
      let exitTime = '';

      for (let j = i + 1; j < candles.length; j++) {
        const fc = candles[j];
        const fh = Number(fc.high), fl = Number(fc.low);
        if (fh >= slLine) { pnl = cl - slLine; exitType = '損切り'; exitTime = fc.candleTime; break; }
        if (fl <= tpLine) { pnl = cl - tpLine; exitType = '利確'; exitTime = fc.candleTime; break; }
        if (fc.candleTime >= '11:27' && params.endTime <= '11:27') { pnl = cl - Number(fc.close); exitType = '前場決済'; exitTime = fc.candleTime; break; }
        if (fc.candleTime >= '15:00') { pnl = cl - Number(fc.close); exitType = '大引け'; exitTime = fc.candleTime; break; }
      }

      results.push({
        date, time: t, entry: cl, riseFromOpen, dropFromHigh,
        exitType, exitTime, pnl, minsFromHigh, maSlope,
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
  console.log('=== キオクシア 反転SHORT（高値反落SHORT）検証 ===\n');

  // パラメータスイープ: 上昇率 × 下落率 × SL × TP × 時間帯
  const configs = [
    // 基本パターン（前場のみ）
    { label: '上昇2%/落1.0%/SL0.6/TP1.5/前場', minRiseFromOpen: 2.0, dropFromHighPct: 1.0, slPct: 0.6, tpPct: 1.5, startTime: '09:45', endTime: '11:27' },
    { label: '上昇2%/落1.5%/SL0.6/TP1.5/前場', minRiseFromOpen: 2.0, dropFromHighPct: 1.5, slPct: 0.6, tpPct: 1.5, startTime: '09:45', endTime: '11:27' },
    { label: '上昇2%/落2.0%/SL0.6/TP1.5/前場', minRiseFromOpen: 2.0, dropFromHighPct: 2.0, slPct: 0.6, tpPct: 1.5, startTime: '09:45', endTime: '11:27' },
    { label: '上昇3%/落1.0%/SL0.6/TP1.5/前場', minRiseFromOpen: 3.0, dropFromHighPct: 1.0, slPct: 0.6, tpPct: 1.5, startTime: '09:45', endTime: '11:27' },
    { label: '上昇3%/落1.5%/SL0.6/TP1.5/前場', minRiseFromOpen: 3.0, dropFromHighPct: 1.5, slPct: 0.6, tpPct: 1.5, startTime: '09:45', endTime: '11:27' },
    { label: '上昇3%/落2.0%/SL0.6/TP1.5/前場', minRiseFromOpen: 3.0, dropFromHighPct: 2.0, slPct: 0.6, tpPct: 1.5, startTime: '09:45', endTime: '11:27' },
    // 全日パターン
    { label: '上昇2%/落1.0%/SL0.6/TP1.5/全日', minRiseFromOpen: 2.0, dropFromHighPct: 1.0, slPct: 0.6, tpPct: 1.5, startTime: '09:45', endTime: '14:30' },
    { label: '上昇2%/落1.5%/SL0.6/TP1.5/全日', minRiseFromOpen: 2.0, dropFromHighPct: 1.5, slPct: 0.6, tpPct: 1.5, startTime: '09:45', endTime: '14:30' },
    { label: '上昇3%/落1.0%/SL0.6/TP1.5/全日', minRiseFromOpen: 3.0, dropFromHighPct: 1.0, slPct: 0.6, tpPct: 1.5, startTime: '09:45', endTime: '14:30' },
    { label: '上昇3%/落1.5%/SL0.6/TP1.5/全日', minRiseFromOpen: 3.0, dropFromHighPct: 1.5, slPct: 0.6, tpPct: 1.5, startTime: '09:45', endTime: '14:30' },
    // SL/TP調整
    { label: '上昇2%/落1.0%/SL0.8/TP1.5/全日', minRiseFromOpen: 2.0, dropFromHighPct: 1.0, slPct: 0.8, tpPct: 1.5, startTime: '09:45', endTime: '14:30' },
    { label: '上昇2%/落1.0%/SL0.6/TP1.0/全日', minRiseFromOpen: 2.0, dropFromHighPct: 1.0, slPct: 0.6, tpPct: 1.0, startTime: '09:45', endTime: '14:30' },
    { label: '上昇2%/落1.0%/SL0.6/TP2.0/全日', minRiseFromOpen: 2.0, dropFromHighPct: 1.0, slPct: 0.6, tpPct: 2.0, startTime: '09:45', endTime: '14:30' },
    // 上昇率低め（より多くの日で発火）
    { label: '上昇1%/落1.0%/SL0.6/TP1.5/全日', minRiseFromOpen: 1.0, dropFromHighPct: 1.0, slPct: 0.6, tpPct: 1.5, startTime: '09:45', endTime: '14:30' },
    { label: '上昇1.5%/落1.0%/SL0.6/TP1.5/全日', minRiseFromOpen: 1.5, dropFromHighPct: 1.0, slPct: 0.6, tpPct: 1.5, startTime: '09:45', endTime: '14:30' },
    // MA傾き条件追加
    { label: '上昇2%/落1.0%/SL0.6/TP1.5/全日/傾き0.02', minRiseFromOpen: 2.0, dropFromHighPct: 1.0, slPct: 0.6, tpPct: 1.5, startTime: '09:45', endTime: '14:30', minSlope: 0.02 },
    { label: '上昇2%/落1.0%/SL0.6/TP1.5/全日/傾き0.05', minRiseFromOpen: 2.0, dropFromHighPct: 1.0, slPct: 0.6, tpPct: 1.5, startTime: '09:45', endTime: '14:30', minSlope: 0.05 },
  ];

  const allResults: { label: string; results: TradeResult[] }[] = [];

  for (const config of configs) {
    const results = await runSim(config);
    printResults(config.label, results);
    allResults.push({ label: config.label, results });
  }

  // 8/19・8/20の発火確認
  console.log('\n--- 8/19・8/20の発火確認 ---');
  for (const { label, results } of allResults) {
    const aug19 = results.find(r => r.date === '2026-08-19');
    const aug20 = results.find(r => r.date === '2026-08-20');
    if (aug19 || aug20) {
      console.log(`${label}:`);
      if (aug19) console.log(`  8/19: ${aug19.time} @${aug19.entry} 落${aug19.dropFromHigh.toFixed(1)}% ${aug19.exitType} ${aug19.pnl > 0 ? '+' : ''}${aug19.pnl.toFixed(0)}円`);
      if (aug20) console.log(`  8/20: ${aug20.time} @${aug20.entry} 落${aug20.dropFromHigh.toFixed(1)}% ${aug20.exitType} ${aug20.pnl > 0 ? '+' : ''}${aug20.pnl.toFixed(0)}円`);
    }
  }

  // 最良の設定の全取引詳細
  console.log('\n--- 最良設定の全取引詳細 ---');
  // 勝率70%以上かつ損益最大を探す
  let bestLabel = '';
  let bestResults: TradeResult[] = [];
  let bestScore = 0;
  for (const { label, results } of allResults) {
    if (results.length < 5) continue;
    const wins = results.filter(r => r.pnl > 0).length;
    const winRate = wins / results.length * 100;
    const pnl = results.reduce((s, r) => s + r.pnl, 0);
    const score = winRate >= 70 ? pnl * 2 : pnl; // 勝率70%以上を優遇
    if (score > bestScore) { bestScore = score; bestLabel = label; bestResults = results; }
  }
  console.log(`最良: ${bestLabel}`);
  for (const t of bestResults) {
    const mark = t.pnl > 0 ? '○' : '×';
    console.log(`${mark} ${t.date} ${t.time} | @${t.entry} 上昇${t.riseFromOpen.toFixed(1)}% 落${t.dropFromHigh.toFixed(1)}% 経過${t.minsFromHigh}分 MA傾${t.maSlope.toFixed(3)}% | ${t.exitType}(${t.exitTime}) ${t.pnl > 0 ? '+' : ''}${t.pnl.toFixed(0)}円`);
  }

  process.exit(0);
}
main();
