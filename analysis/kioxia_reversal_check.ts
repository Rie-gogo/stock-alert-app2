import { getDb } from '../server/db';
import { sql } from 'drizzle-orm';

async function main() {
  const db = await getDb();

  for (const date of ['2026-08-19', '2026-08-20']) {
    console.log('\n========================================');
    console.log(`=== ${date} キオクシア(285A) 反転LONG検証 ===`);
    console.log('========================================');

    const r = await db.execute(sql`
      SELECT candleTime, open, high, low, close, volume FROM rt_candles
      WHERE symbol = '285A' AND tradeDate = ${date}
      ORDER BY candleTime
    `);
    const candles = (r as any)[0] as any[];
    console.log('足数:', candles.length);

    if (candles.length === 0) continue;

    // 当日高値追跡
    let dayHigh = 0;
    let reversalFired = false;

    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];
      const o = Number(c.open), h = Number(c.high), l = Number(c.low), cl = Number(c.close), v = Number(c.volume);
      const t = c.candleTime;

      if (h > dayHigh) dayHigh = h;

      // 前場のみ（09:30〜11:27）
      if (t < '09:30' || t > '11:27') continue;

      // 当日高値からの下落率
      const dropFromHigh = dayHigh > 0 ? (dayHigh - cl) / dayHigh * 100 : 0;

      // MA8計算
      if (i < 9) continue;
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

      // 条件チェック（下落2.5%以上）
      if (dropFromHigh >= 2.0 && !reversalFired) {
        const status = maRising && highBreak ? '★発火★' : (maRising ? 'MA上向き(高値更新待ち)' : (highBreak ? '高値更新(MA下向き)' : '条件未達'));
        console.log(`${t} | 高値:${dayHigh} 現在:${cl} 落:${dropFromHigh.toFixed(1)}% | MA上向き:${maRising} 高値更新:${highBreak} → ${status}`);

        if (dropFromHigh >= 2.5 && maRising && highBreak) {
          reversalFired = true;
          console.log(`  → 反転LONG発火! エントリー@${cl}`);

          // TP 0.8%到達チェック
          const tpLine = cl * 1.008;
          const slLine = cl * (1 - 0.006); // SL 0.6%
          let exitResult = '未決済';
          for (let j = i + 1; j < candles.length; j++) {
            const fc = candles[j];
            const fh = Number(fc.high), fl = Number(fc.low);
            if (fl <= slLine) { exitResult = `損切り@${slLine.toFixed(0)} (${fc.candleTime})`; break; }
            if (fh >= tpLine) { exitResult = `利確@${tpLine.toFixed(0)} (${fc.candleTime})`; break; }
            if (fc.candleTime >= '11:27') { exitResult = `前場強制決済@${Number(fc.close).toFixed(0)} (${fc.candleTime})`; break; }
          }
          console.log(`  → 結果: ${exitResult}`);
          const pnl = exitResult.includes('利確') ? (tpLine - cl) : exitResult.includes('損切り') ? (slLine - cl) : 0;
          console.log(`  → 損益: ${pnl > 0 ? '+' : ''}${pnl.toFixed(0)}円/株`);
        }
      }
    }

    if (!reversalFired) {
      console.log('反転LONG: 発火せず');
      // 当日高値と最安値を表示
      const allHighs = candles.map((c: any) => Number(c.high));
      const allLows = candles.map((c: any) => Number(c.low));
      const maxHigh = Math.max(...allHighs);
      const minLow = Math.min(...allLows);
      console.log(`当日高値: ${maxHigh} 当日安値: ${minLow} 値幅: ${((maxHigh - minLow) / maxHigh * 100).toFixed(1)}%`);

      // 前場の最大下落率を表示
      let maxDrop = 0;
      let maxDropTime = '';
      let runningHigh = 0;
      for (const c of candles) {
        if (c.candleTime > '11:27') break;
        const ch = Number(c.high), ccl = Number(c.close);
        if (ch > runningHigh) runningHigh = ch;
        const drop = runningHigh > 0 ? (runningHigh - ccl) / runningHigh * 100 : 0;
        if (drop > maxDrop) { maxDrop = drop; maxDropTime = c.candleTime; }
      }
      console.log(`前場最大下落率: ${maxDrop.toFixed(1)}% (${maxDropTime})`);
    }
  }

  // 全40営業日での反転LONG結果サマリー
  console.log('\n========================================');
  console.log('=== 全期間 反転LONG結果サマリー ===');
  console.log('========================================');

  const rDates = await db.execute(sql`
    SELECT DISTINCT tradeDate FROM rt_candles WHERE symbol = '285A' ORDER BY tradeDate
  `);
  const dates = ((rDates as any)[0] as any[]).map(r => r.tradeDate);
  console.log(`対象日数: ${dates.length}日`);

  let totalTrades = 0, wins = 0, losses = 0, totalPnl = 0;
  const tradeDetails: any[] = [];

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
      const h = Number(c.high), cl = Number(c.close);
      const t = c.candleTime;

      if (h > dayHigh) dayHigh = h;

      if (t < '09:30' || t > '11:27' || i < 9 || fired) continue;

      const dropFromHigh = dayHigh > 0 ? (dayHigh - cl) / dayHigh * 100 : 0;
      if (dropFromHigh < 2.5) continue;

      const currentSlice = candles.slice(i - 7, i + 1).map((x: any) => Number(x.close));
      const currentMA = currentSlice.reduce((a: number, b: number) => a + b, 0) / 8;
      const prevSlice = candles.slice(i - 8, i).map((x: any) => Number(x.close));
      const prevMA = prevSlice.reduce((a: number, b: number) => a + b, 0) / 8;
      const maRising = currentMA > prevMA;

      const lookback = Math.min(10, i);
      const recent10Highs = candles.slice(i - lookback, i).map((x: any) => Number(x.high));
      const recent10High = recent10Highs.length > 0 ? Math.max(...recent10Highs) : 0;
      const highBreak = h > recent10High;

      if (maRising && highBreak) {
        fired = true;
        totalTrades++;

        const tpLine = cl * 1.008;
        const slLine = cl * (1 - 0.006);
        let pnl = 0;
        let exitType = '未決済';
        let exitTime = '';

        for (let j = i + 1; j < candles.length; j++) {
          const fc = candles[j];
          const fh = Number(fc.high), fl = Number(fc.low);
          if (fl <= slLine) { pnl = slLine - cl; exitType = '損切り'; exitTime = fc.candleTime; break; }
          if (fh >= tpLine) { pnl = tpLine - cl; exitType = '利確'; exitTime = fc.candleTime; break; }
          if (fc.candleTime >= '11:27') { pnl = Number(fc.close) - cl; exitType = '前場決済'; exitTime = fc.candleTime; break; }
        }

        if (pnl > 0) wins++;
        else losses++;
        totalPnl += pnl;

        tradeDetails.push({ date, time: t, entry: cl, drop: dropFromHigh.toFixed(1), exitType, exitTime, pnl: pnl.toFixed(0) });
      }
    }
  }

  console.log(`\n取引数: ${totalTrades}件 ${wins}勝${losses}敗 勝率${(wins/totalTrades*100).toFixed(1)}%`);
  console.log(`損益合計: ${totalPnl > 0 ? '+' : ''}${totalPnl.toFixed(0)}円/株`);
  console.log('\n--- 全取引一覧 ---');
  for (const t of tradeDetails) {
    console.log(`${t.date} ${t.time} | @${t.entry} 落${t.drop}% | ${t.exitType}(${t.exitTime}) | ${Number(t.pnl) > 0 ? '+' : ''}${t.pnl}円/株`);
  }

  // マイナス取引の共通点を分析
  console.log('\n--- マイナス取引の分析 ---');
  const lossTrades = tradeDetails.filter(t => Number(t.pnl) <= 0);
  const winTrades = tradeDetails.filter(t => Number(t.pnl) > 0);
  console.log(`マイナス: ${lossTrades.length}件`);
  for (const t of lossTrades) {
    console.log(`  ${t.date} ${t.time} | 落${t.drop}% | ${t.exitType} | ${t.pnl}円/株`);
  }
  console.log(`プラス: ${winTrades.length}件`);
  for (const t of winTrades) {
    console.log(`  ${t.date} ${t.time} | 落${t.drop}% | ${t.exitType} | ${t.pnl}円/株`);
  }

  // 下落率別の勝率
  console.log('\n--- 下落率別の勝率 ---');
  for (const threshold of [2.5, 3.0, 3.5, 4.0, 5.0]) {
    const filtered = tradeDetails.filter(t => Number(t.drop) >= threshold);
    const w = filtered.filter(t => Number(t.pnl) > 0).length;
    const l = filtered.filter(t => Number(t.pnl) <= 0).length;
    const p = filtered.reduce((s, t) => s + Number(t.pnl), 0);
    console.log(`落>=${threshold}%: ${filtered.length}件 ${w}勝${l}敗 勝率${filtered.length > 0 ? (w/filtered.length*100).toFixed(0) : 0}% 損益${p.toFixed(0)}円/株`);
  }

  // エントリー時間帯別の勝率
  console.log('\n--- エントリー時間帯別 ---');
  const timeGroups: Record<string, any[]> = {};
  for (const t of tradeDetails) {
    const hour = t.time.substring(0, 2);
    if (!timeGroups[hour]) timeGroups[hour] = [];
    timeGroups[hour].push(t);
  }
  for (const [hour, trades] of Object.entries(timeGroups).sort()) {
    const w = trades.filter(t => Number(t.pnl) > 0).length;
    const l = trades.filter(t => Number(t.pnl) <= 0).length;
    const p = trades.reduce((s: number, t: any) => s + Number(t.pnl), 0);
    console.log(`${hour}時台: ${trades.length}件 ${w}勝${l}敗 勝率${(w/trades.length*100).toFixed(0)}% 損益${p.toFixed(0)}円/株`);
  }

  process.exit(0);
}
main();
