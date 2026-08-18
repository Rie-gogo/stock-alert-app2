/**
 * MA期間の最適値検証
 * isBullish判定に使うMA期間を変えた場合、SHORTの成績がどう変わるかを検証
 * MA期間が短い → トレンド転換に早く反応 → 上昇日のSHORTを早くブロック
 * MA期間が長い → ノイズに強い → 一時的な反発でSHORTをブロックしない
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
const SYMBOLS = ["8035","6857","6976","6526","5803","6981","285A","6146","6594","8316"];
const MA_PERIODS = [5, 10, 15, 20, 30, 50];

function getRoundLevels(price: number): number[] {
  const levels: number[] = [];
  if (price >= 100000) { const b = Math.floor(price/1000)*1000; for(let i=-3;i<=3;i++) levels.push(b+i*1000); }
  else if (price >= 10000) { const b = Math.floor(price/500)*500; for(let i=-3;i<=3;i++) levels.push(b+i*500); }
  else if (price >= 5000) { const b = Math.floor(price/200)*200; for(let i=-3;i<=3;i++) levels.push(b+i*200); }
  else if (price >= 2000) { const b = Math.floor(price/100)*100; for(let i=-3;i<=3;i++) levels.push(b+i*100); }
  else { const b = Math.floor(price/50)*50; for(let i=-3;i<=3;i++) levels.push(b+i*50); }
  return levels.filter(l => l > 0);
}

async function main() {
  const conn = await mysql.createConnection(DATABASE_URL);
  
  // 30営業日分のデータ取得
  const [dateRows] = await conn.query(`
    SELECT DISTINCT tradeDate FROM rt_candles WHERE symbol = '8035' AND tradeDate <= '2026-08-18'
    ORDER BY tradeDate DESC LIMIT 31
  `) as any[];
  const allDates = (dateRows as any[]).map((r: any) => r.tradeDate).reverse();
  const prevDate = allDates[0];
  const dates = allDates.slice(1);
  console.log(`対象期間: ${dates[0]} 〜 ${dates[dates.length-1]} (${dates.length}営業日)\n`);

  const [allRows] = await conn.query(`
    SELECT tradeDate, symbol, candleTime as t, open as o, high as h, low as l, close as c, volume as v
    FROM rt_candles WHERE tradeDate IN (${allDates.map((d: string) => `'${d}'`).join(',')})
      AND symbol IN (${SYMBOLS.map(s => `'${s}'`).join(',')})
    ORDER BY symbol, tradeDate, candleTime
  `) as any[];

  const rawBuffers: Record<string, {date: string; c: {t:string;o:number;h:number;l:number;c:number;v:number}}[]> = {};
  for (const r of allRows as any[]) {
    if (!rawBuffers[r.symbol]) rawBuffers[r.symbol] = [];
    rawBuffers[r.symbol].push({ date: String(r.tradeDate), c: { t: r.t, o: Number(r.o), h: Number(r.h), l: Number(r.l), c: Number(r.c), v: Number(r.v) } });
  }

  // MA期間ごとにシミュレーション
  const results: Record<number, {trades: number; wins: number; pnl: number; blocked: number; blockedPnl: number}> = {};
  // isBullish無効も追加
  const noFilterResult = {trades: 0, wins: 0, pnl: 0, blocked: 0, blockedPnl: 0};

  for (const maPeriod of MA_PERIODS) {
    results[maPeriod] = {trades: 0, wins: 0, pnl: 0, blocked: 0, blockedPnl: 0};
  }

  for (const date of dates) {
    for (const symbol of SYMBOLS) {
      const allBuf = rawBuffers[symbol];
      if (!allBuf) continue;
      const bufUpToDate = allBuf.filter(b => b.date <= date);
      const todayCandles = allBuf.filter(b => b.date === date).map(b => b.c);
      if (todayCandles.length < 25) continue;

      // 各MA期間で1日1回制限
      const entered: Record<number, boolean> = {};
      let enteredNoFilter = false;

      for (let i = 1; i < todayCandles.length; i++) {
        const candle = todayCandles[i];
        if (candle.t < "09:30" || candle.t >= "15:05") continue;
        if (candle.t >= "12:30" && candle.t < "12:50") continue;

        const prevClose = todayCandles[i-1].c;
        const currClose = candle.c;
        const levels = getRoundLevels(prevClose);
        let shortSignal = false;
        for (const level of levels) {
          if (prevClose >= level && currClose < level) { shortSignal = true; break; }
        }
        if (!shortSignal) continue;

        const globalIdx = bufUpToDate.findIndex(b => b.date === date && b.c.t === candle.t);
        if (globalIdx < 0) continue;

        // シミュレーション（共通）
        const sl = SL_MAP[symbol]?.short || 0.8;
        const price = candle.c;
        const shares = Math.floor(3000000 / price / 100) * 100 || 100;
        const slPrice = price * (1 + sl / 100);
        const tpPrice = price * (1 - TP_PCT / 100);
        let pnl = 0;
        for (let j = i + 1; j < todayCandles.length; j++) {
          if (todayCandles[j].t >= "11:27" && todayCandles[j].t < "11:30") { pnl = Math.round((price - todayCandles[j].c) * shares); break; }
          if (todayCandles[j].t >= "15:25") { pnl = Math.round((price - todayCandles[j].c) * shares); break; }
          if (todayCandles[j].h >= slPrice) { pnl = Math.round((price - slPrice) * shares); break; }
          if (todayCandles[j].l <= tpPrice) { pnl = Math.round((price - tpPrice) * shares); break; }
        }

        // isBullish無効（全エントリー）
        if (!enteredNoFilter) {
          noFilterResult.trades++;
          if (pnl > 0) noFilterResult.wins++;
          noFilterResult.pnl += pnl;
          enteredNoFilter = true;
        }

        // 各MA期間で判定
        for (const maPeriod of MA_PERIODS) {
          if (entered[maPeriod]) continue;
          if (globalIdx < maPeriod + 1) continue;

          const w = bufUpToDate.slice(globalIdx - maPeriod + 1, globalIdx + 1).map(b => b.c.c);
          const pw = bufUpToDate.slice(globalIdx - maPeriod, globalIdx).map(b => b.c.c);
          const ma = w.reduce((s, v) => s + v, 0) / maPeriod;
          const prevMa = pw.reduce((s, v) => s + v, 0) / maPeriod;
          const isBullish = (ma - prevMa) / prevMa * 100 > 0;

          if (isBullish) {
            // ブロック
            results[maPeriod].blocked++;
            results[maPeriod].blockedPnl += pnl;
          } else {
            // エントリー
            results[maPeriod].trades++;
            if (pnl > 0) results[maPeriod].wins++;
            results[maPeriod].pnl += pnl;
            entered[maPeriod] = true;
          }
        }
      }
    }
  }

  // 結果表示
  console.log(`=== MA期間別 isBullish判定の最適値検証（大台割れSHORT）===\n`);
  console.log(`| MA期間 | 取引数 | 勝率 | 損益 | PF | ブロック数 | ブロック損益 | 判定 |`);
  console.log(`|--------|--------|------|------|-----|-----------|------------|------|`);

  // isBullish無効
  const nfGp = noFilterResult.pnl > 0 ? noFilterResult.pnl : 0; // 簡易
  console.log(`| なし | ${noFilterResult.trades}件 | ${(noFilterResult.wins/noFilterResult.trades*100).toFixed(1)}% | ${noFilterResult.pnl >= 0 ? "+" : ""}${noFilterResult.pnl.toLocaleString()}円 | - | 0件 | - | ベースライン |`);

  for (const maPeriod of MA_PERIODS) {
    const r = results[maPeriod];
    const wr = r.trades > 0 ? (r.wins/r.trades*100).toFixed(1) : "-";
    const gp = r.pnl; // 簡易表示
    const blockedJudge = r.blockedPnl < 0 ? "ブロック正解" : "★過剰ブロック";
    console.log(`| MA${maPeriod} | ${r.trades}件 | ${wr}% | ${r.pnl >= 0 ? "+" : ""}${r.pnl.toLocaleString()}円 | - | ${r.blocked}件 | ${r.blockedPnl >= 0 ? "+" : ""}${r.blockedPnl.toLocaleString()}円 | ${blockedJudge} |`);
  }

  // 詳細PF計算
  console.log(`\n--- 詳細PF ---`);
  for (const maPeriod of [...MA_PERIODS]) {
    const r = results[maPeriod];
    // PFは個別計算が必要だが、ここでは省略
    console.log(`  MA${maPeriod}: エントリー${r.trades}件 ブロック${r.blocked}件 ブロック損益${r.blockedPnl >= 0 ? "+" : ""}${r.blockedPnl.toLocaleString()}円`);
  }

  await conn.end();
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
