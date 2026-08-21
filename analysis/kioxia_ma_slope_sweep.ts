import { getDb } from '../server/db';
import { sql } from 'drizzle-orm';

interface SimResult {
  maPeriod: number;
  slopeThreshold: number;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  aug19: boolean;
  aug20: boolean;
}

async function main() {
  const db = await getDb();
  const rDates = await db.execute(sql`
    SELECT DISTINCT tradeDate FROM rt_candles WHERE symbol = '285A' ORDER BY tradeDate
  `);
  const allDates = ((rDates as any)[0] as any[]).map((r: any) => r.tradeDate);

  // 全日のデータを事前にロード
  const allCandles: Record<string, any[]> = {};
  for (const date of allDates) {
    const rr = await db.execute(sql`
      SELECT candleTime, open, high, low, close, volume FROM rt_candles
      WHERE symbol = '285A' AND tradeDate = ${date}
      ORDER BY candleTime
    `);
    allCandles[date] = (rr as any)[0] as any[];
  }
  console.log(`データロード完了: ${allDates.length}日\n`);

  // グリッドサーチ
  const maPeriods = [3, 4, 5, 6, 8, 10, 12, 15, 20];
  const slopeThresholds = [0.0, 0.02, 0.05, 0.08, 0.1, 0.12, 0.15, 0.2, 0.25, 0.3];

  const results: SimResult[] = [];

  for (const maPeriod of maPeriods) {
    for (const slopeThreshold of slopeThresholds) {
      let trades = 0, wins = 0, losses = 0, totalPnl = 0;
      let aug19 = false, aug20 = false;

      for (const date of allDates) {
        const candles = allCandles[date];
        if (candles.length < maPeriod + 2) continue;

        let dayHigh = 0;
        let fired = false;

        for (let i = 0; i < candles.length; i++) {
          const c = candles[i];
          const h = Number(c.high), cl = Number(c.close);
          const t = c.candleTime;

          if (h > dayHigh) dayHigh = h;

          if (t < '09:45' || t > '11:27' || i < maPeriod + 1 || fired) continue;

          const dropFromHigh = dayHigh > 0 ? (dayHigh - cl) / dayHigh * 100 : 0;
          if (dropFromHigh < 2.5) continue;

          // MA計算（指定期間）
          const currentSlice = candles.slice(i - maPeriod + 1, i + 1).map((x: any) => Number(x.close));
          const currentMA = currentSlice.reduce((a: number, b: number) => a + b, 0) / maPeriod;
          const prevSlice = candles.slice(i - maPeriod, i).map((x: any) => Number(x.close));
          const prevMA = prevSlice.reduce((a: number, b: number) => a + b, 0) / maPeriod;
          const maRising = currentMA > prevMA;

          // MA傾き（2本前のMAとの比較）
          if (i < maPeriod + 1) continue;
          const slice2ago = candles.slice(i - maPeriod - 1, i - 1).map((x: any) => Number(x.close));
          const ma2ago = slice2ago.reduce((a: number, b: number) => a + b, 0) / maPeriod;
          const maSlope = ma2ago > 0 ? (currentMA - ma2ago) / ma2ago * 100 : 0;

          // 直近10本高値更新
          const lookback = Math.min(10, i);
          const recent10Highs = candles.slice(i - lookback, i).map((x: any) => Number(x.high));
          const recent10High = recent10Highs.length > 0 ? Math.max(...recent10Highs) : 0;
          const highBreak = h > recent10High;

          if (!maRising || !highBreak) continue;

          // 傾き閾値チェック
          if (maSlope < slopeThreshold) continue;

          fired = true;
          trades++;

          const tpLine = cl * 1.008;
          const slLine = cl * (1 - 0.006);
          let pnl = 0;

          for (let j = i + 1; j < candles.length; j++) {
            const fc = candles[j];
            const fh = Number(fc.high), fl = Number(fc.low);
            if (fl <= slLine) { pnl = slLine - cl; break; }
            if (fh >= tpLine) { pnl = tpLine - cl; break; }
            if (fc.candleTime >= '11:27') { pnl = Number(fc.close) - cl; break; }
          }

          if (pnl > 0) wins++;
          else losses++;
          totalPnl += pnl;

          if (date === '2026-08-19') aug19 = true;
          if (date === '2026-08-20') aug20 = true;
        }
      }

      const winRate = trades > 0 ? (wins / trades) * 100 : 0;
      results.push({ maPeriod, slopeThreshold, trades, wins, losses, winRate, totalPnl, aug19, aug20 });
    }
  }

  // 結果表示（勝率順）
  console.log('=== MA期間 × 傾き閾値 グリッドサーチ結果 ===\n');
  console.log('MA期間 | 傾き閾値 | 件数 | 勝敗      | 勝率   | 損益/株   | 8/19 | 8/20');
  console.log('-'.repeat(85));

  // 取引数5件以上のもののみ表示（少なすぎると信頼性なし）
  const validResults = results.filter(r => r.trades >= 5);
  validResults.sort((a, b) => {
    // 勝率が同じなら損益で比較
    if (Math.abs(a.winRate - b.winRate) < 0.1) return b.totalPnl - a.totalPnl;
    return b.winRate - a.winRate;
  });

  for (const r of validResults.slice(0, 40)) {
    const aug19Mark = r.aug19 ? '○' : '×';
    const aug20Mark = r.aug20 ? '○' : '×';
    console.log(`MA${String(r.maPeriod).padStart(2)}   | ${r.slopeThreshold.toFixed(2)}%    | ${String(r.trades).padStart(3)}件 | ${r.wins}勝${r.losses}敗 | ${r.winRate.toFixed(1)}% | ${r.totalPnl > 0 ? '+' : ''}${r.totalPnl.toFixed(0)}円 | ${aug19Mark}    | ${aug20Mark}`);
  }

  // 勝率70%以上 + 8/19・8/20両方発火のもの
  console.log('\n=== 勝率>=70% かつ 8/19・8/20両方発火 ===');
  const ideal = validResults.filter(r => r.winRate >= 70 && r.aug19 && r.aug20);
  if (ideal.length === 0) {
    console.log('該当なし');
    // 8/20のみ発火で70%以上
    console.log('\n=== 勝率>=70% かつ 8/20発火 ===');
    const aug20only = validResults.filter(r => r.winRate >= 70 && r.aug20);
    for (const r of aug20only.slice(0, 10)) {
      console.log(`MA${r.maPeriod} 傾き>=${r.slopeThreshold}%: ${r.trades}件 ${r.wins}勝${r.losses}敗 勝率${r.winRate.toFixed(1)}% 損益${r.totalPnl > 0 ? '+' : ''}${r.totalPnl.toFixed(0)}円 8/19=${r.aug19 ? '○' : '×'}`);
    }
    // 8/19・8/20両方発火で最高勝率
    console.log('\n=== 8/19・8/20両方発火で最高勝率 ===');
    const both = validResults.filter(r => r.aug19 && r.aug20);
    both.sort((a, b) => b.winRate - a.winRate || b.totalPnl - a.totalPnl);
    for (const r of both.slice(0, 10)) {
      console.log(`MA${r.maPeriod} 傾き>=${r.slopeThreshold}%: ${r.trades}件 ${r.wins}勝${r.losses}敗 勝率${r.winRate.toFixed(1)}% 損益${r.totalPnl > 0 ? '+' : ''}${r.totalPnl.toFixed(0)}円`);
    }
  } else {
    for (const r of ideal) {
      console.log(`MA${r.maPeriod} 傾き>=${r.slopeThreshold}%: ${r.trades}件 ${r.wins}勝${r.losses}敗 勝率${r.winRate.toFixed(1)}% 損益${r.totalPnl > 0 ? '+' : ''}${r.totalPnl.toFixed(0)}円`);
    }
  }

  // 損益最大のもの（勝率60%以上）
  console.log('\n=== 損益最大（勝率>=60%） ===');
  const profitable = validResults.filter(r => r.winRate >= 60);
  profitable.sort((a, b) => b.totalPnl - a.totalPnl);
  for (const r of profitable.slice(0, 10)) {
    const aug19Mark = r.aug19 ? '○' : '×';
    const aug20Mark = r.aug20 ? '○' : '×';
    console.log(`MA${r.maPeriod} 傾き>=${r.slopeThreshold}%: ${r.trades}件 ${r.wins}勝${r.losses}敗 勝率${r.winRate.toFixed(1)}% 損益${r.totalPnl > 0 ? '+' : ''}${r.totalPnl.toFixed(0)}円 8/19=${aug19Mark} 8/20=${aug20Mark}`);
  }

  process.exit(0);
}
main();
