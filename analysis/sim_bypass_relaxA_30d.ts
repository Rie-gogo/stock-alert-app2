/**
 * 静かな上昇バイパス 緩和A（MA乖離<0.5% / 実体<0.2% / 陰線≤4本）
 * 30営業日シミュレーション
 * 
 * rt_score0_blocksテーブルからBUYのブロック記録を取得し、
 * 緩和A条件を満たす場合にエントリーしていたらどうなったかを検証
 * 
 * 比較: 現行（MA乖離<0.3% / 実体<0.1% / 陰線≤3本）vs 緩和A
 */
import mysql from "mysql2/promise";
const DATABASE_URL = process.env.DATABASE_URL!;
const TP_PCT = 1.5;
const SL_MAP: Record<string, {long: number; short: number}> = {
  "8035": {long:0.5, short:0.8}, "6857": {long:0.6, short:0.6}, "6976": {long:0.6, short:0.8},
  "6526": {long:0.9, short:1.0}, "5803": {long:0.5, short:0.6}, "6981": {long:0.4, short:0.9},
  "285A": {long:0.8, short:0.6}, "6146": {long:0.8, short:0.8}, "6594": {long:0.5, short:0.5},
  "8316": {long:0.5, short:0.5},
};

async function main() {
  const conn = await mysql.createConnection(DATABASE_URL);

  // スコア0ブロックされたBUYシグナルを全件取得
  const [blocks] = await conn.query(`
    SELECT trade_date, symbol, candle_time, entry_price, signal_reason
    FROM rt_score0_blocks
    WHERE side = 'BUY'
    ORDER BY trade_date, candle_time
  `) as any[];

  console.log(`スコア0ブロック BUY件数: ${(blocks as any[]).length}件\n`);

  // 各ブロックについて、バイパス条件を判定し、エントリーした場合の損益を計算
  const results: {
    date: string; time: string; symbol: string; entryPrice: number; signal: string;
    maDeviation: number; barBody: number; bearBars: number;
    currentBypass: boolean; relaxABypass: boolean;
    pnl: number; result: string;
  }[] = [];

  for (const block of blocks as any[]) {
    const tradeDate = String(block.trade_date);
    const symbol = block.symbol;
    const candleTime = block.candle_time;
    const entryPrice = Number(block.entry_price);
    const signal = block.signal_reason;

    // 当日のローソク足を取得
    const [candles] = await conn.query(`
      SELECT candleTime as t, open as o, high as h, low as l, close as c, volume as v
      FROM rt_candles
      WHERE tradeDate = ? AND symbol = ?
      ORDER BY candleTime
    `, [tradeDate, symbol]) as any[];

    const candleArr = candles as any[];
    const entryIdx = candleArr.findIndex((c: any) => c.t === candleTime);
    if (entryIdx < 0) continue;

    const entryCandle = candleArr[entryIdx];

    // 前日のデータも取得してMA20計算
    const [prevCandles] = await conn.query(`
      SELECT candleTime as t, open as o, high as h, low as l, close as c
      FROM rt_candles
      WHERE tradeDate < ? AND symbol = ?
      ORDER BY tradeDate DESC, candleTime DESC
      LIMIT 300
    `, [tradeDate, symbol]) as any[];

    const prevArr = (prevCandles as any[]).reverse();
    const allCloses = [...prevArr.map((c: any) => Number(c.c)), ...candleArr.slice(0, entryIdx + 1).map((c: any) => Number(c.c))];

    // MA20計算
    const maPeriod = 20;
    let maDeviation = 999;
    let isBullish = false;
    if (allCloses.length >= maPeriod + 1) {
      const maSlice = allCloses.slice(allCloses.length - maPeriod);
      const ma = maSlice.reduce((s, v) => s + v, 0) / maPeriod;
      maDeviation = ma > 0 ? (Number(entryCandle.c) - ma) / ma * 100 : 999;
      
      const prevMaSlice = allCloses.slice(allCloses.length - maPeriod - 1, allCloses.length - 1);
      const prevMa = prevMaSlice.reduce((s, v) => s + v, 0) / maPeriod;
      isBullish = (ma - prevMa) / prevMa * 100 > 0;
    }

    // 実体計算
    const barBody = Math.abs(Number(entryCandle.c) - Number(entryCandle.o)) / Number(entryCandle.o) * 100;

    // 陰線本数
    const recentSlice = candleArr.slice(Math.max(0, entryIdx - 10), entryIdx);
    const bearBars = recentSlice.filter((c: any) => Number(c.c) < Number(c.o)).length;

    // バイパス判定
    const currentBypass = isBullish && maDeviation < 0.3 && barBody < 0.1 && bearBars <= 3;
    const relaxABypass = isBullish && maDeviation < 0.5 && barBody < 0.2 && bearBars <= 4;

    // エントリーした場合の損益計算
    const sl = SL_MAP[symbol]?.long || 0.5;
    const slPrice = entryPrice * (1 - sl / 100);
    const tpPrice = entryPrice * (1 + TP_PCT / 100);
    let pnl = 0;
    let resultType = "EOD";
    const shares = Math.floor(3000000 / entryPrice / 100) * 100 || 100;

    for (let j = entryIdx + 1; j < candleArr.length; j++) {
      const c = candleArr[j];
      // 前場強制決済
      if (c.t >= "11:27" && c.t < "11:30") {
        pnl = Math.round((Number(c.c) - entryPrice) * shares);
        resultType = "前場決済";
        break;
      }
      // 大引け強制決済
      if (c.t >= "15:25") {
        pnl = Math.round((Number(c.c) - entryPrice) * shares);
        resultType = "大引け";
        break;
      }
      if (Number(c.l) <= slPrice) {
        pnl = Math.round((slPrice - entryPrice) * shares);
        resultType = "SL";
        break;
      }
      if (Number(c.h) >= tpPrice) {
        pnl = Math.round((tpPrice - entryPrice) * shares);
        resultType = "TP";
        break;
      }
    }

    results.push({
      date: tradeDate, time: candleTime, symbol, entryPrice, signal,
      maDeviation, barBody, bearBars,
      currentBypass, relaxABypass,
      pnl, result: resultType,
    });
  }

  // 集計
  const currentBypassed = results.filter(r => r.currentBypass);
  const relaxABypassed = results.filter(r => r.relaxABypass);
  const relaxAOnly = results.filter(r => r.relaxABypass && !r.currentBypass);
  const blocked = results.filter(r => !r.relaxABypass);

  console.log(`=== 全ブロック件数: ${results.length}件 ===\n`);

  console.log(`| 区分 | 件数 | 勝率 | 損益 | PF |`);
  console.log(`|------|------|------|------|-----|`);
  for (const [label, arr] of [
    ["現行バイパス適用", currentBypassed],
    ["緩和Aバイパス適用", relaxABypassed],
    ["緩和Aで追加される取引", relaxAOnly],
    ["緩和Aでもブロック", blocked],
    ["全件（ブロック解除した場合）", results],
  ] as [string, typeof results][]) {
    if (arr.length === 0) { console.log(`| ${label} | 0件 | - | - | - |`); continue; }
    const wins = arr.filter(r => r.pnl > 0).length;
    const pnl = arr.reduce((s, r) => s + r.pnl, 0);
    const gross = arr.filter(r => r.pnl > 0).reduce((s, r) => s + r.pnl, 0);
    const loss = Math.abs(arr.filter(r => r.pnl < 0).reduce((s, r) => s + r.pnl, 0));
    const pf = loss > 0 ? (gross / loss).toFixed(2) : "∞";
    console.log(`| ${label} | ${arr.length}件 | ${(wins/arr.length*100).toFixed(1)}% | ${pnl>=0?"+":""}${pnl.toLocaleString()}円 | ${pf} |`);
  }

  // 緩和Aバイパス適用の詳細
  console.log(`\n=== 緩和Aバイパス適用 ${relaxABypassed.length}件の詳細 ===`);
  console.log(`| 日付 | 時刻 | 銘柄 | エントリー | MA乖離 | 実体 | 陰線 | 結果 | 損益 |`);
  console.log(`|------|------|------|----------|--------|------|------|------|------|`);
  for (const r of relaxABypassed) {
    console.log(`| ${r.date} | ${r.time} | ${r.symbol} | @${r.entryPrice.toLocaleString()}円 | ${r.maDeviation.toFixed(3)}% | ${r.barBody.toFixed(3)}% | ${r.bearBars}本 | ${r.result} | ${r.pnl>=0?"+":""}${r.pnl.toLocaleString()}円 |`);
  }

  // 銘柄別
  console.log(`\n=== 緩和Aバイパス 銘柄別 ===`);
  const bySymbol: Record<string, {count: number; wins: number; pnl: number}> = {};
  for (const r of relaxABypassed) {
    if (!bySymbol[r.symbol]) bySymbol[r.symbol] = {count: 0, wins: 0, pnl: 0};
    bySymbol[r.symbol].count++;
    if (r.pnl > 0) bySymbol[r.symbol].wins++;
    bySymbol[r.symbol].pnl += r.pnl;
  }
  console.log(`| 銘柄 | 件数 | 勝敗 | 損益 |`);
  console.log(`|------|------|------|------|`);
  for (const [sym, data] of Object.entries(bySymbol).sort((a, b) => b[1].pnl - a[1].pnl)) {
    console.log(`| ${sym} | ${data.count}件 | ${data.wins}勝${data.count-data.wins}敗 | ${data.pnl>=0?"+":""}${data.pnl.toLocaleString()}円 |`);
  }

  await conn.end();
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
