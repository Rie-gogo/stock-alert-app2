import { getDb } from '../server/db';
import { sql } from 'drizzle-orm';

// 2つのSHORTロジックを併用した場合の損益を検証
// 1. 大台割れCB SHORT（現行・前場のみに制限）
// 2. 反転SHORT（追加の利益源）
// 同日に両方発火した場合は1ポジ制限で先着優先

interface Trade {
  date: string; time: string; entry: number; pnl: number;
  type: string; // 'CB' or '反転'
  exitType: string; exitTime: string;
}

async function main() {
  const db = await getDb();
  const rDates = await db.execute(sql`
    SELECT DISTINCT tradeDate FROM rt_candles WHERE symbol = '285A' ORDER BY tradeDate
  `);
  const allDates = ((rDates as any)[0] as any[]).map((r: any) => r.tradeDate);

  // 全日のデータをロード
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

  // === 現行の大台割れCB SHORTの結果（本番データから） ===
  // 前場のみに制限した場合: 6件5勝1敗 勝率83% +474,829円
  // 後場を含む場合: 9件5勝4敗 勝率56% +357,119円
  // → 改善案1: 後場SHORTを制限

  // === 反転SHORTのシミュレーション ===
  // 大台割れCBと同日に発火する場合を考慮

  // 反転SHORTの各設定でシミュレーション
  const reversalConfigs = [
    { label: 'A: SL0.6/TP1.5/経過>=10分', slPct: 0.6, tpPct: 1.5, minMinsFromHigh: 10 },
    { label: 'B: SL0.8/TP1.5/経過>=10分', slPct: 0.8, tpPct: 1.5, minMinsFromHigh: 10 },
    { label: 'C: SL0.8/TP2.0/経過>=10分', slPct: 0.8, tpPct: 2.0, minMinsFromHigh: 10 },
    { label: 'D: SL1.0/TP0.8/フィルターなし', slPct: 1.0, tpPct: 0.8, minMinsFromHigh: 0 },
    { label: 'E: SL0.6/TP1.5/フィルターなし', slPct: 0.6, tpPct: 1.5, minMinsFromHigh: 0 },
    { label: 'F: SL0.8/TP1.0/経過>=10分', slPct: 0.8, tpPct: 1.0, minMinsFromHigh: 10 },
  ];

  for (const config of reversalConfigs) {
    // 反転SHORTのみの結果
    const reversalTrades: Trade[] = [];

    for (const date of allDates) {
      const candles = allCandles[date];
      if (!candles || candles.length < 10) continue;

      let dayHigh = 0, dayHighIdx = 0, fired = false;
      const dayOpen = Number(candles[0].open);

      for (let i = 0; i < candles.length; i++) {
        const c = candles[i];
        const h = Number(c.high), cl = Number(c.close);
        const t = c.candleTime;
        if (h > dayHigh) { dayHigh = h; dayHighIdx = i; }
        if (t < '09:45' || t > '14:30' || i < 10 || fired) continue;

        const riseFromOpen = dayOpen > 0 ? (dayHigh - dayOpen) / dayOpen * 100 : 0;
        if (riseFromOpen < 1.0) continue;

        const dropFromHigh = dayHigh > 0 ? (dayHigh - cl) / dayHigh * 100 : 0;
        if (dropFromHigh < 1.0) continue;

        // MA8下向き
        const currentSlice = candles.slice(i - 7, i + 1).map((x: any) => Number(x.close));
        const currentMA = currentSlice.reduce((a: number, b: number) => a + b, 0) / 8;
        const prevSlice = candles.slice(i - 8, i).map((x: any) => Number(x.close));
        const prevMA = prevSlice.reduce((a: number, b: number) => a + b, 0) / 8;
        if (currentMA >= prevMA) continue;

        // 直近10本安値更新
        const lookback = Math.min(10, i);
        const recent10Lows = candles.slice(i - lookback, i).map((x: any) => Number(x.low));
        const recent10Low = Math.min(...recent10Lows);
        if (Number(c.low) >= recent10Low) continue;

        // 経過時間フィルター
        const minsFromHigh = i - dayHighIdx;
        if (config.minMinsFromHigh > 0 && minsFromHigh < config.minMinsFromHigh) continue;

        fired = true;

        const tpLine = cl * (1 - config.tpPct / 100);
        const slLine = cl * (1 + config.slPct / 100);
        let pnl = 0, exitType = '未決済', exitTime = '';

        for (let j = i + 1; j < candles.length; j++) {
          const fc = candles[j];
          const fh = Number(fc.high), fl = Number(fc.low);
          if (fh >= slLine) { pnl = cl - slLine; exitType = '損切り'; exitTime = fc.candleTime; break; }
          if (fl <= tpLine) { pnl = cl - tpLine; exitType = '利確'; exitTime = fc.candleTime; break; }
          if (fc.candleTime >= '15:00') { pnl = cl - Number(fc.close); exitType = '大引け'; exitTime = fc.candleTime; break; }
        }

        reversalTrades.push({ date, time: t, entry: cl, pnl, type: '反転', exitType, exitTime });
      }
    }

    // 大台割れCB SHORT（本番データ）
    // 前場のみ: 7/7 09:43(+113k), 7/7 10:13(+112k), 7/10 13:41(+121k), 7/13 09:49(+110k), 7/13 13:10(-34k), 7/16 10:13(-63k), 8/7 09:40(+71k), 8/7 10:15(+69k), 8/18 09:45(-37k), 8/18 12:32(-34k)
    // 前場制限（11:27まで）: 7/7 09:43, 7/7 10:13, 7/13 09:49, 7/16 10:13, 8/7 09:40, 8/7 10:15, 8/18 09:45 = 7件5勝2敗
    const cbTrades: Trade[] = [
      { date: '2026-07-07', time: '09:43', entry: 75660, pnl: 113490, type: 'CB', exitType: '利確', exitTime: '09:47' },
      { date: '2026-07-07', time: '10:13', entry: 74570, pnl: 111855, type: 'CB', exitType: '利確', exitTime: '10:20' },
      { date: '2026-07-10', time: '13:41', entry: 80390, pnl: 120585, type: 'CB', exitType: '利確', exitTime: '14:10' },
      { date: '2026-07-13', time: '09:49', entry: 73240, pnl: 109860, type: 'CB', exitType: '利確', exitTime: '09:57' },
      { date: '2026-07-13', time: '13:10', entry: 67200, pnl: -33600, type: 'CB', exitType: '損切り', exitTime: '13:13' },
      { date: '2026-07-16', time: '10:13', entry: 62800, pnl: -62800, type: 'CB', exitType: '損切り', exitTime: '10:21' },
      { date: '2026-08-07', time: '09:40', entry: 47270, pnl: 70905, type: 'CB', exitType: '利確', exitTime: '09:47' },
      { date: '2026-08-07', time: '10:15', entry: 45770, pnl: 68655, type: 'CB', exitType: '利確', exitTime: '10:23' },
      { date: '2026-08-18', time: '09:45', entry: 60970, pnl: -36582, type: 'CB', exitType: '損切り', exitTime: '10:10' },
      { date: '2026-08-18', time: '12:32', entry: 57240, pnl: -34344, type: 'CB', exitType: '損切り', exitTime: '12:37' },
    ];

    // 改善案1: CB前場のみ（11:27まで）
    const cbAmOnly = cbTrades.filter(t => t.time <= '11:27');
    // 改善案2: CB全時間帯（現行）
    const cbAll = cbTrades;

    // 併用シミュレーション（同日の重複を除外）
    // CB前場のみ + 反転SHORT（CBがない日のみ反転SHORTを適用）
    const cbAmDates = new Set(cbAmOnly.map(t => t.date));
    const cbAllDates = new Set(cbAll.map(t => t.date));

    // パターン1: CB前場のみ + 反転SHORT（CB日以外）
    const combined1 = [...cbAmOnly, ...reversalTrades.filter(t => !cbAmDates.has(t.date))];
    // パターン2: CB全体 + 反転SHORT（CB日以外）
    const combined2 = [...cbAll, ...reversalTrades.filter(t => !cbAllDates.has(t.date))];
    // パターン3: CB前場のみ + 反転SHORT（全日、CBと同日でも後から発火なら許可）
    const combined3: Trade[] = [...cbAmOnly];
    for (const rt of reversalTrades) {
      const sameDayCb = cbAmOnly.find(cb => cb.date === rt.date);
      if (!sameDayCb) {
        combined3.push(rt);
      } else if (rt.time > sameDayCb.exitTime) {
        // CBの決済後に反転SHORTが発火した場合は追加
        combined3.push(rt);
      }
    }

    // 結果表示
    const printCombined = (label: string, trades: Trade[]) => {
      const w = trades.filter(t => t.pnl > 0).length;
      const l = trades.filter(t => t.pnl <= 0).length;
      const pnl = trades.reduce((s, t) => s + t.pnl, 0);
      const wr = trades.length > 0 ? (w / trades.length * 100).toFixed(1) : '0';
      const cbCount = trades.filter(t => t.type === 'CB').length;
      const revCount = trades.filter(t => t.type === '反転').length;
      const cbPnl = trades.filter(t => t.type === 'CB').reduce((s, t) => s + t.pnl, 0);
      const revPnl = trades.filter(t => t.type === '反転').reduce((s, t) => s + t.pnl, 0);
      console.log(`${label}: ${trades.length}件 ${w}勝${l}敗 勝率${wr}% 損益${pnl > 0 ? '+' : ''}${pnl.toLocaleString()}円 (CB:${cbCount}件${cbPnl > 0 ? '+' : ''}${cbPnl.toLocaleString()}円 反転:${revCount}件${revPnl > 0 ? '+' : ''}${revPnl.toLocaleString()}円)`);
    };

    console.log(`\n=== ${config.label} ===`);
    const revW = reversalTrades.filter(t => t.pnl > 0).length;
    const revL = reversalTrades.filter(t => t.pnl <= 0).length;
    const revPnl = reversalTrades.reduce((s, t) => s + t.pnl, 0);
    // 株数換算（300万÷株価で概算。平均株価60,000円として50株）
    const avgPrice = reversalTrades.length > 0 ? reversalTrades.reduce((s, t) => s + t.entry, 0) / reversalTrades.length : 60000;
    const shares = Math.floor(3000000 / avgPrice);
    console.log(`反転SHORT単体: ${reversalTrades.length}件 ${revW}勝${revL}敗 勝率${(revW / reversalTrades.length * 100).toFixed(1)}% 損益${revPnl > 0 ? '+' : ''}${revPnl.toFixed(0)}円/株 (×${shares}株≒${(revPnl * shares).toLocaleString()}円)`);

    printCombined('CB前場のみ + 反転(CB日以外)', combined1);
    printCombined('CB全体 + 反転(CB日以外)', combined2);
    printCombined('CB前場のみ + 反転(CB決済後も可)', combined3);

    // 8/19・8/20の確認
    const aug19Rev = reversalTrades.find(t => t.date === '2026-08-19');
    const aug20Rev = reversalTrades.find(t => t.date === '2026-08-20');
    if (aug19Rev) console.log(`  8/19反転: ${aug19Rev.time} @${aug19Rev.entry} ${aug19Rev.exitType} ${aug19Rev.pnl > 0 ? '+' : ''}${aug19Rev.pnl.toFixed(0)}円/株`);
    if (aug20Rev) console.log(`  8/20反転: ${aug20Rev.time} @${aug20Rev.entry} ${aug20Rev.exitType} ${aug20Rev.pnl > 0 ? '+' : ''}${aug20Rev.pnl.toFixed(0)}円/株`);
  }

  // 現行との比較
  console.log('\n=== 現行との比較 ===');
  console.log('現行SHORT: 13件 7勝6敗 勝率53.8% +371,008円');
  console.log('目標: 勝率70%以上 かつ 損益+571,008円以上（現行+20万円）');

  process.exit(0);
}
main();
