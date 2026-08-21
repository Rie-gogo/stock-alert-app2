import { getDb } from '../server/db';
import { sql } from 'drizzle-orm';

interface TradeResult {
  date: string; time: string; entry: number; drop: number;
  exitType: string; exitTime: string; pnl: number;
  // 新しい指標
  dropSpeed: number; // 下落速度（%/分）: 高値から現在までの下落率÷経過分数
  minsFromHigh: number; // 高値からの経過分数
  maSlope: number; // MA8の傾き（現在MA - 2本前MA）/ 2本前MA * 100
  prevDayReturn: number; // 前日の日次リターン（%）
  gapFromPrevClose: number; // 前日終値からのギャップ（%）
  dropType: string; // 急落 or じわ下げ
}

async function main() {
  const db = await getDb();
  const rDates = await db.execute(sql`
    SELECT DISTINCT tradeDate FROM rt_candles WHERE symbol = '285A' ORDER BY tradeDate
  `);
  const allDates = ((rDates as any)[0] as any[]).map((r: any) => r.tradeDate);
  console.log(`対象日数: ${allDates.length}日\n`);

  const results: TradeResult[] = [];

  for (let di = 0; di < allDates.length; di++) {
    const date = allDates[di];
    const rr = await db.execute(sql`
      SELECT candleTime, open, high, low, close, volume FROM rt_candles
      WHERE symbol = '285A' AND tradeDate = ${date}
      ORDER BY candleTime
    `);
    const candles = (rr as any)[0] as any[];
    if (candles.length < 10) continue;

    // 前日データ
    let prevDayReturn = 0;
    let prevDayClose = 0;
    if (di > 0) {
      const prevDate = allDates[di - 1];
      const rPrev = await db.execute(sql`
        SELECT candleTime, open, high, low, close FROM rt_candles
        WHERE symbol = '285A' AND tradeDate = ${prevDate}
        ORDER BY candleTime
      `);
      const prevCandles = (rPrev as any)[0] as any[];
      if (prevCandles.length > 0) {
        const firstOpen = Number(prevCandles[0].open);
        const lastClose = Number(prevCandles[prevCandles.length - 1].close);
        prevDayReturn = firstOpen > 0 ? (lastClose - firstOpen) / firstOpen * 100 : 0;
        prevDayClose = lastClose;
      }
    }

    let dayHigh = 0;
    let dayHighIdx = 0;
    let fired = false;

    // 当日始値
    const todayOpen = Number(candles[0].open);
    const gapFromPrevClose = prevDayClose > 0 ? (todayOpen - prevDayClose) / prevDayClose * 100 : 0;

    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];
      const h = Number(c.high), cl = Number(c.close), o = Number(c.open);
      const t = c.candleTime;

      if (h > dayHigh) { dayHigh = h; dayHighIdx = i; }

      if (t < '09:45' || t > '11:27' || i < 9 || fired) continue;

      const dropFromHigh = dayHigh > 0 ? (dayHigh - cl) / dayHigh * 100 : 0;
      if (dropFromHigh < 2.5) continue;

      // MA8
      const currentSlice = candles.slice(i - 7, i + 1).map((x: any) => Number(x.close));
      const currentMA = currentSlice.reduce((a: number, b: number) => a + b, 0) / 8;
      const prevSlice = candles.slice(i - 8, i).map((x: any) => Number(x.close));
      const prevMA = prevSlice.reduce((a: number, b: number) => a + b, 0) / 8;
      const maRising = currentMA > prevMA;

      // MA8の傾き（2本前のMAとの比較）
      const slice2ago = candles.slice(i - 9, i - 1).map((x: any) => Number(x.close));
      const ma2ago = slice2ago.reduce((a: number, b: number) => a + b, 0) / 8;
      const maSlope = ma2ago > 0 ? (currentMA - ma2ago) / ma2ago * 100 : 0;

      // 直近10本高値更新
      const lookback = Math.min(10, i);
      const recent10Highs = candles.slice(i - lookback, i).map((x: any) => Number(x.high));
      const recent10High = recent10Highs.length > 0 ? Math.max(...recent10Highs) : 0;
      const highBreak = h > recent10High;

      if (!maRising || !highBreak) continue;

      // 下落速度と経過時間
      const minsFromHigh = i - dayHighIdx;
      const dropSpeed = minsFromHigh > 0 ? dropFromHigh / minsFromHigh : dropFromHigh;

      // 下落タイプ判定
      const dropType = dropSpeed > 0.3 ? '急落' : 'じわ下げ';

      fired = true;

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

      results.push({
        date, time: t, entry: cl, drop: dropFromHigh,
        exitType, exitTime, pnl,
        dropSpeed, minsFromHigh, maSlope, prevDayReturn, gapFromPrevClose, dropType,
      });
    }
  }

  // 全取引一覧
  console.log('=== 案11 全取引（別アプローチ指標付き） ===\n');
  console.log('日付       時間  | 落%   | 速度  | 経過分 | MA傾き | 前日% | ギャップ | 下落型 | 結果    | 損益');
  console.log('-'.repeat(110));
  for (const t of results) {
    const mark = t.pnl > 0 ? '○' : '×';
    console.log(`${mark} ${t.date} ${t.time} | ${t.drop.toFixed(1)}% | ${t.dropSpeed.toFixed(2)} | ${String(t.minsFromHigh).padStart(4)}分 | ${t.maSlope >= 0 ? '+' : ''}${t.maSlope.toFixed(3)}% | ${t.prevDayReturn >= 0 ? '+' : ''}${t.prevDayReturn.toFixed(1)}% | ${t.gapFromPrevClose >= 0 ? '+' : ''}${t.gapFromPrevClose.toFixed(1)}% | ${t.dropType} | ${t.exitType.padEnd(6)} | ${t.pnl > 0 ? '+' : ''}${t.pnl.toFixed(0)}円`);
  }

  // プラスとマイナスの統計比較
  const wins = results.filter(r => r.pnl > 0);
  const losses = results.filter(r => r.pnl <= 0);

  console.log('\n=== プラス vs マイナス 統計比較 ===\n');
  console.log(`| 指標 | プラス(${wins.length}件) | マイナス(${losses.length}件) | 差 |`);
  console.log('|------|---------|-----------|-----|');

  const avgDropSpeedW = wins.reduce((s, t) => s + t.dropSpeed, 0) / wins.length;
  const avgDropSpeedL = losses.reduce((s, t) => s + t.dropSpeed, 0) / losses.length;
  console.log(`| 下落速度(%/分) | ${avgDropSpeedW.toFixed(3)} | ${avgDropSpeedL.toFixed(3)} | ${(avgDropSpeedW - avgDropSpeedL).toFixed(3)} |`);

  const avgMinsW = wins.reduce((s, t) => s + t.minsFromHigh, 0) / wins.length;
  const avgMinsL = losses.reduce((s, t) => s + t.minsFromHigh, 0) / losses.length;
  console.log(`| 高値からの経過分 | ${avgMinsW.toFixed(1)} | ${avgMinsL.toFixed(1)} | ${(avgMinsW - avgMinsL).toFixed(1)} |`);

  const avgSlopeW = wins.reduce((s, t) => s + t.maSlope, 0) / wins.length;
  const avgSlopeL = losses.reduce((s, t) => s + t.maSlope, 0) / losses.length;
  console.log(`| MA傾き(%) | ${avgSlopeW.toFixed(4)} | ${avgSlopeL.toFixed(4)} | ${(avgSlopeW - avgSlopeL).toFixed(4)} |`);

  const avgPrevRetW = wins.reduce((s, t) => s + t.prevDayReturn, 0) / wins.length;
  const avgPrevRetL = losses.reduce((s, t) => s + t.prevDayReturn, 0) / losses.length;
  console.log(`| 前日リターン(%) | ${avgPrevRetW.toFixed(2)} | ${avgPrevRetL.toFixed(2)} | ${(avgPrevRetW - avgPrevRetL).toFixed(2)} |`);

  const avgGapW = wins.reduce((s, t) => s + t.gapFromPrevClose, 0) / wins.length;
  const avgGapL = losses.reduce((s, t) => s + t.gapFromPrevClose, 0) / losses.length;
  console.log(`| ギャップ(%) | ${avgGapW.toFixed(2)} | ${avgGapL.toFixed(2)} | ${(avgGapW - avgGapL).toFixed(2)} |`);

  // 急落 vs じわ下げ
  const rapidWins = wins.filter(t => t.dropType === '急落').length;
  const rapidLosses = losses.filter(t => t.dropType === '急落').length;
  const slowWins = wins.filter(t => t.dropType === 'じわ下げ').length;
  const slowLosses = losses.filter(t => t.dropType === 'じわ下げ').length;
  console.log(`\n急落: ${rapidWins + rapidLosses}件 ${rapidWins}勝${rapidLosses}敗 勝率${((rapidWins / (rapidWins + rapidLosses)) * 100).toFixed(0)}%`);
  console.log(`じわ下げ: ${slowWins + slowLosses}件 ${slowWins}勝${slowLosses}敗 勝率${((slowWins / (slowWins + slowLosses)) * 100).toFixed(0)}%`);

  // 前日リターン別
  console.log('\n--- 前日リターン別 ---');
  const prevUp = results.filter(t => t.prevDayReturn > 0);
  const prevDown = results.filter(t => t.prevDayReturn <= 0);
  const prevUpWins = prevUp.filter(t => t.pnl > 0).length;
  const prevDownWins = prevDown.filter(t => t.pnl > 0).length;
  console.log(`前日上昇: ${prevUp.length}件 ${prevUpWins}勝${prevUp.length - prevUpWins}敗 勝率${prevUp.length > 0 ? ((prevUpWins / prevUp.length) * 100).toFixed(0) : 0}%`);
  console.log(`前日下落: ${prevDown.length}件 ${prevDownWins}勝${prevDown.length - prevDownWins}敗 勝率${prevDown.length > 0 ? ((prevDownWins / prevDown.length) * 100).toFixed(0) : 0}%`);

  // ギャップ別
  console.log('\n--- ギャップ別 ---');
  const gapUp = results.filter(t => t.gapFromPrevClose > 0);
  const gapDown = results.filter(t => t.gapFromPrevClose <= 0);
  const gapUpWins = gapUp.filter(t => t.pnl > 0).length;
  const gapDownWins = gapDown.filter(t => t.pnl > 0).length;
  console.log(`ギャップアップ: ${gapUp.length}件 ${gapUpWins}勝${gapUp.length - gapUpWins}敗 勝率${gapUp.length > 0 ? ((gapUpWins / gapUp.length) * 100).toFixed(0) : 0}%`);
  console.log(`ギャップダウン: ${gapDown.length}件 ${gapDownWins}勝${gapDown.length - gapDownWins}敗 勝率${gapDown.length > 0 ? ((gapDownWins / gapDown.length) * 100).toFixed(0) : 0}%`);

  // 高値からの経過時間別
  console.log('\n--- 高値からの経過時間別 ---');
  for (const threshold of [5, 10, 15, 20, 30]) {
    const filtered = results.filter(t => t.minsFromHigh >= threshold);
    const w = filtered.filter(t => t.pnl > 0).length;
    const pnl = filtered.reduce((s, t) => s + t.pnl, 0);
    console.log(`>=${threshold}分: ${filtered.length}件 ${w}勝${filtered.length - w}敗 勝率${filtered.length > 0 ? ((w / filtered.length) * 100).toFixed(0) : 0}% 損益${pnl > 0 ? '+' : ''}${pnl.toFixed(0)}円`);
  }

  // MA傾き別
  console.log('\n--- MA傾き別 ---');
  for (const threshold of [0.0, 0.1, 0.2, 0.3, 0.5]) {
    const filtered = results.filter(t => t.maSlope >= threshold);
    const w = filtered.filter(t => t.pnl > 0).length;
    const pnl = filtered.reduce((s, t) => s + t.pnl, 0);
    console.log(`MA傾き>=${threshold}%: ${filtered.length}件 ${w}勝${filtered.length - w}敗 勝率${filtered.length > 0 ? ((w / filtered.length) * 100).toFixed(0) : 0}% 損益${pnl > 0 ? '+' : ''}${pnl.toFixed(0)}円`);
  }

  // 下落速度別
  console.log('\n--- 下落速度別 ---');
  for (const threshold of [0.1, 0.15, 0.2, 0.3, 0.5]) {
    const filtered = results.filter(t => t.dropSpeed >= threshold);
    const w = filtered.filter(t => t.pnl > 0).length;
    const pnl = filtered.reduce((s, t) => s + t.pnl, 0);
    console.log(`速度>=${threshold}%/分: ${filtered.length}件 ${w}勝${filtered.length - w}敗 勝率${filtered.length > 0 ? ((w / filtered.length) * 100).toFixed(0) : 0}% 損益${pnl > 0 ? '+' : ''}${pnl.toFixed(0)}円`);
  }
  for (const threshold of [0.1, 0.15, 0.2, 0.3]) {
    const filtered = results.filter(t => t.dropSpeed < threshold);
    const w = filtered.filter(t => t.pnl > 0).length;
    const pnl = filtered.reduce((s, t) => s + t.pnl, 0);
    console.log(`速度<${threshold}%/分: ${filtered.length}件 ${w}勝${filtered.length - w}敗 勝率${filtered.length > 0 ? ((w / filtered.length) * 100).toFixed(0) : 0}% 損益${pnl > 0 ? '+' : ''}${pnl.toFixed(0)}円`);
  }

  // 組み合わせ検証
  console.log('\n=== 有望な組み合わせ検証 ===');

  // 組み合わせ1: じわ下げ + 経過10分以上
  const combo1 = results.filter(t => t.dropType === 'じわ下げ' && t.minsFromHigh >= 10);
  const c1w = combo1.filter(t => t.pnl > 0).length;
  console.log(`じわ下げ + 経過>=10分: ${combo1.length}件 ${c1w}勝${combo1.length - c1w}敗 勝率${combo1.length > 0 ? ((c1w / combo1.length) * 100).toFixed(0) : 0}%`);

  // 組み合わせ2: 前日下落 + 経過10分以上
  const combo2 = results.filter(t => t.prevDayReturn <= 0 && t.minsFromHigh >= 10);
  const c2w = combo2.filter(t => t.pnl > 0).length;
  console.log(`前日下落 + 経過>=10分: ${combo2.length}件 ${c2w}勝${combo2.length - c2w}敗 勝率${combo2.length > 0 ? ((c2w / combo2.length) * 100).toFixed(0) : 0}%`);

  // 組み合わせ3: ギャップダウン + じわ下げ
  const combo3 = results.filter(t => t.gapFromPrevClose <= 0 && t.dropType === 'じわ下げ');
  const c3w = combo3.filter(t => t.pnl > 0).length;
  console.log(`ギャップダウン + じわ下げ: ${combo3.length}件 ${c3w}勝${combo3.length - c3w}敗 勝率${combo3.length > 0 ? ((c3w / combo3.length) * 100).toFixed(0) : 0}%`);

  // 組み合わせ4: 経過15分以上
  const combo4 = results.filter(t => t.minsFromHigh >= 15);
  const c4w = combo4.filter(t => t.pnl > 0).length;
  const c4pnl = combo4.reduce((s, t) => s + t.pnl, 0);
  console.log(`経過>=15分: ${combo4.length}件 ${c4w}勝${combo4.length - c4w}敗 勝率${combo4.length > 0 ? ((c4w / combo4.length) * 100).toFixed(0) : 0}% 損益${c4pnl > 0 ? '+' : ''}${c4pnl.toFixed(0)}円`);

  // 組み合わせ5: 速度<0.2 (じわ下げ)
  const combo5 = results.filter(t => t.dropSpeed < 0.2);
  const c5w = combo5.filter(t => t.pnl > 0).length;
  const c5pnl = combo5.reduce((s, t) => s + t.pnl, 0);
  console.log(`速度<0.2%/分: ${combo5.length}件 ${c5w}勝${combo5.length - c5w}敗 勝率${combo5.length > 0 ? ((c5w / combo5.length) * 100).toFixed(0) : 0}% 損益${c5pnl > 0 ? '+' : ''}${c5pnl.toFixed(0)}円`);

  // 組み合わせ6: 速度<0.2 + 経過15分以上
  const combo6 = results.filter(t => t.dropSpeed < 0.2 && t.minsFromHigh >= 15);
  const c6w = combo6.filter(t => t.pnl > 0).length;
  const c6pnl = combo6.reduce((s, t) => s + t.pnl, 0);
  console.log(`速度<0.2 + 経過>=15分: ${combo6.length}件 ${c6w}勝${combo6.length - c6w}敗 勝率${combo6.length > 0 ? ((c6w / combo6.length) * 100).toFixed(0) : 0}% 損益${c6pnl > 0 ? '+' : ''}${c6pnl.toFixed(0)}円`);

  // 8/19, 8/20の確認
  console.log('\n--- 8/19・8/20の各指標 ---');
  const aug19 = results.find(r => r.date === '2026-08-19');
  const aug20 = results.find(r => r.date === '2026-08-20');
  if (aug19) console.log(`8/19: 速度${aug19.dropSpeed.toFixed(2)} 経過${aug19.minsFromHigh}分 MA傾き${aug19.maSlope.toFixed(3)}% 前日${aug19.prevDayReturn.toFixed(1)}% ギャップ${aug19.gapFromPrevClose.toFixed(1)}% ${aug19.dropType}`);
  if (aug20) console.log(`8/20: 速度${aug20.dropSpeed.toFixed(2)} 経過${aug20.minsFromHigh}分 MA傾き${aug20.maSlope.toFixed(3)}% 前日${aug20.prevDayReturn.toFixed(1)}% ギャップ${aug20.gapFromPrevClose.toFixed(1)}% ${aug20.dropType}`);

  process.exit(0);
}
main();
