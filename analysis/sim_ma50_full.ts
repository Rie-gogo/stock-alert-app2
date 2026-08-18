/**
 * MA50 全フィルター込みシミュレーション（20営業日）
 * 本番エンジンの主要フィルターを再現:
 * - isBullish（MA傾き>0%）: SHORT禁止 / LONG許可
 * - ATRフィルター（0.12%）
 * - 3方式即エントリー（即vol、即4a、CB2MW1）
 * - 前場強制決済（11:27）
 * - 12:30-12:50エントリー禁止
 * - 同一銘柄1ポジション制限
 * - 損切り後30分再エントリー禁止
 * 
 * MA20（現行）vs MA50で比較
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
const ATR_PERIOD = 7;
const ATR_THRESHOLD = 0.0012;
const FAST_ENTRY_VOL_RATIO = 1.5;
const FAST_ENTRY_PREV_DIST_PCT = 0.05;
const NO_REENTRY_MIN = 30;

function getRoundLevels(price: number): number[] {
  const levels: number[] = [];
  if (price >= 100000) { const b = Math.floor(price/1000)*1000; for(let i=-3;i<=3;i++) levels.push(b+i*1000); }
  else if (price >= 10000) { const b = Math.floor(price/500)*500; for(let i=-3;i<=3;i++) levels.push(b+i*500); }
  else if (price >= 5000) { const b = Math.floor(price/200)*200; for(let i=-3;i<=3;i++) levels.push(b+i*200); }
  else if (price >= 2000) { const b = Math.floor(price/100)*100; for(let i=-3;i<=3;i++) levels.push(b+i*100); }
  else { const b = Math.floor(price/50)*50; for(let i=-3;i<=3;i++) levels.push(b+i*50); }
  return levels.filter(l => l > 0);
}

function calcATR(candles: {h:number;l:number;c:number}[], period: number): number | null {
  if (candles.length < period + 1) return null;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    trs.push(Math.max(candles[i].h - candles[i].l, Math.abs(candles[i].h - candles[i-1].c), Math.abs(candles[i].l - candles[i-1].c)));
  }
  if (trs.length < period) return null;
  let atr = trs.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }
  return atr;
}

function timeToMin(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

interface Trade {
  date: string; time: string; symbol: string; side: string; price: number;
  shares: number; pnl: number; result: string; exitTime: string; method: string;
}

async function runSim(maPeriod: number, label: string, conn: any, dates: string[], rawBuffers: Record<string, any[]>) {
  const trades: Trade[] = [];

  for (const date of dates) {
    // 銘柄ごとの状態管理
    const positions: Record<string, {price: number; shares: number; side: string; entryTime: string}> = {};
    const lastSLTime: Record<string, number> = {}; // 損切り後再エントリー禁止

    for (const symbol of SYMBOLS) {
      const allBuf = rawBuffers[symbol];
      if (!allBuf) continue;
      const bufUpToDate = allBuf.filter((b: any) => b.date <= date);
      const todayCandles = allBuf.filter((b: any) => b.date === date).map((b: any) => b.c);
      if (todayCandles.length < 25) continue;

      for (let i = 1; i < todayCandles.length; i++) {
        const candle = todayCandles[i];
        const tMin = timeToMin(candle.t);

        // 前場強制決済（11:27）
        if (candle.t >= "11:27" && candle.t < "11:30" && positions[symbol]) {
          const pos = positions[symbol];
          const pnl = pos.side === "short"
            ? Math.round((pos.price - candle.c) * pos.shares)
            : Math.round((candle.c - pos.price) * pos.shares);
          trades.push({ date, time: pos.entryTime, symbol, side: pos.side, price: pos.price, shares: pos.shares, pnl, result: "前場決済", exitTime: candle.t, method: "" });
          delete positions[symbol];
          continue;
        }

        // 大引け強制決済（15:25）
        if (candle.t >= "15:25" && positions[symbol]) {
          const pos = positions[symbol];
          const pnl = pos.side === "short"
            ? Math.round((pos.price - candle.c) * pos.shares)
            : Math.round((candle.c - pos.price) * pos.shares);
          trades.push({ date, time: pos.entryTime, symbol, side: pos.side, price: pos.price, shares: pos.shares, pnl, result: "大引け", exitTime: candle.t, method: "" });
          delete positions[symbol];
          continue;
        }

        // ポジション保有中: SL/TP判定
        if (positions[symbol]) {
          const pos = positions[symbol];
          const sl = pos.side === "short" ? SL_MAP[symbol]?.short || 0.8 : SL_MAP[symbol]?.long || 0.5;
          const slPrice = pos.side === "short" ? pos.price * (1 + sl / 100) : pos.price * (1 - sl / 100);
          const tpPrice = pos.side === "short" ? pos.price * (1 - TP_PCT / 100) : pos.price * (1 + TP_PCT / 100);

          if (pos.side === "short" && candle.h >= slPrice) {
            const pnl = Math.round((pos.price - slPrice) * pos.shares);
            trades.push({ date, time: pos.entryTime, symbol, side: pos.side, price: pos.price, shares: pos.shares, pnl, result: "SL", exitTime: candle.t, method: "" });
            lastSLTime[symbol] = tMin;
            delete positions[symbol];
          } else if (pos.side === "short" && candle.l <= tpPrice) {
            const pnl = Math.round((pos.price - tpPrice) * pos.shares);
            trades.push({ date, time: pos.entryTime, symbol, side: pos.side, price: pos.price, shares: pos.shares, pnl, result: "TP", exitTime: candle.t, method: "" });
            delete positions[symbol];
          } else if (pos.side === "long" && candle.l <= slPrice) {
            const pnl = Math.round((slPrice - pos.price) * pos.shares);
            trades.push({ date, time: pos.entryTime, symbol, side: pos.side, price: pos.price, shares: pos.shares, pnl, result: "SL", exitTime: candle.t, method: "" });
            lastSLTime[symbol] = tMin;
            delete positions[symbol];
          } else if (pos.side === "long" && candle.h >= tpPrice) {
            const pnl = Math.round((tpPrice - pos.price) * pos.shares);
            trades.push({ date, time: pos.entryTime, symbol, side: pos.side, price: pos.price, shares: pos.shares, pnl, result: "TP", exitTime: candle.t, method: "" });
            delete positions[symbol];
          }
          continue;
        }

        // エントリー判定
        if (candle.t < "09:30" || candle.t >= "15:05") continue;
        if (candle.t >= "12:30" && candle.t < "12:50") continue;
        if (positions[symbol]) continue;

        // 損切り後再エントリー禁止
        if (lastSLTime[symbol] && tMin - lastSLTime[symbol] < NO_REENTRY_MIN) continue;

        const globalIdx = bufUpToDate.findIndex((b: any) => b.date === date && b.c.t === candle.t);
        if (globalIdx < Math.max(maPeriod + 1, ATR_PERIOD + 1)) continue;

        // isBullish判定
        const w = bufUpToDate.slice(globalIdx - maPeriod + 1, globalIdx + 1).map((b: any) => b.c.c);
        const pw = bufUpToDate.slice(globalIdx - maPeriod, globalIdx).map((b: any) => b.c.c);
        if (w.length < maPeriod || pw.length < maPeriod) continue;
        const ma = w.reduce((s: number, v: number) => s + v, 0) / maPeriod;
        const prevMa = pw.reduce((s: number, v: number) => s + v, 0) / maPeriod;
        const isBullish = (ma - prevMa) / prevMa * 100 > 0;

        // ATRフィルター
        const atrSlice = bufUpToDate.slice(globalIdx - ATR_PERIOD, globalIdx + 1).map((b: any) => b.c);
        const atr = calcATR(atrSlice, ATR_PERIOD);
        if (atr !== null && candle.c > 0 && atr / candle.c < ATR_THRESHOLD) continue;

        // 大台割れSHORT検出
        const prevClose = todayCandles[i-1]?.c;
        if (!prevClose) continue;
        const levels = getRoundLevels(prevClose);
        let shortSignal = false;
        let roundLevel = 0;
        for (const level of levels) {
          if (prevClose >= level && candle.c < level) { shortSignal = true; roundLevel = level; break; }
        }

        if (shortSignal && !isBullish) {
          // SHORT: 3方式判定
          const sl = SL_MAP[symbol]?.short || 0.8;
          const price = candle.c;
          const shares = Math.floor(3000000 / price / 100) * 100 || 100;

          // 出来高チェック（即vol）
          const volSlice = bufUpToDate.slice(Math.max(0, globalIdx - 20), globalIdx).map((b: any) => b.c.v);
          const avgVol = volSlice.length > 0 ? volSlice.reduce((s: number, v: number) => s + v, 0) / volSlice.length : 0;
          const volRatio = avgVol > 0 ? candle.v / avgVol : 0;

          let method = "CB2MW1";
          if (volRatio >= FAST_ENTRY_VOL_RATIO) {
            method = "即vol";
          } else if (roundLevel > 0) {
            const prevDist = (prevClose - roundLevel) / roundLevel * 100;
            if (prevDist <= FAST_ENTRY_PREV_DIST_PCT) {
              method = "即4a";
            }
          }

          positions[symbol] = { price, shares, side: "short", entryTime: candle.t };
          // method記録用（後で集計）
          const lastTrade = trades.length;
          // positionに入れたので次のループでSL/TP判定される
          // ただしCB2MW1の場合は本来3分待つべきだが、簡易的に即エントリーとする
          continue;
        }

        // ダウ理論LONG検出（簡易: 直近20本高値更新）
        if (i >= 20 && isBullish) {
          const recent20 = todayCandles.slice(i - 20, i);
          const maxHigh = Math.max(...recent20.map((c: any) => c.h));
          if (candle.h > maxHigh) {
            const sl = SL_MAP[symbol]?.long || 0.5;
            const price = candle.c;
            const shares = Math.floor(3000000 / price / 100) * 100 || 100;
            positions[symbol] = { price, shares, side: "long", entryTime: candle.t };
            continue;
          }
        }
      }

      // 日末にポジションが残っている場合（15:25を超えた場合）
      if (positions[symbol]) {
        const lastCandle = todayCandles[todayCandles.length - 1];
        const pos = positions[symbol];
        const pnl = pos.side === "short"
          ? Math.round((pos.price - lastCandle.c) * pos.shares)
          : Math.round((lastCandle.c - pos.price) * pos.shares);
        trades.push({ date, time: pos.entryTime, symbol, side: pos.side, price: pos.price, shares: pos.shares, pnl, result: "EOD", exitTime: lastCandle.t, method: "" });
        delete positions[symbol];
      }
    }
  }

  // 集計
  const shortTrades = trades.filter(t => t.side === "short");
  const longTrades = trades.filter(t => t.side === "long");
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const wins = trades.filter(t => t.pnl > 0).length;
  const shortPnl = shortTrades.reduce((s, t) => s + t.pnl, 0);
  const longPnl = longTrades.reduce((s, t) => s + t.pnl, 0);
  const shortWins = shortTrades.filter(t => t.pnl > 0).length;
  const longWins = longTrades.filter(t => t.pnl > 0).length;

  console.log(`\n=== ${label} ===`);
  console.log(`全体: ${trades.length}件 ${wins}勝${trades.length-wins}敗 勝率${(wins/trades.length*100).toFixed(1)}% ${totalPnl>=0?"+":""}${totalPnl.toLocaleString()}円`);
  console.log(`SHORT: ${shortTrades.length}件 ${shortWins}勝${shortTrades.length-shortWins}敗 勝率${shortTrades.length>0?(shortWins/shortTrades.length*100).toFixed(1):"-"}% ${shortPnl>=0?"+":""}${shortPnl.toLocaleString()}円`);
  console.log(`LONG: ${longTrades.length}件 ${longWins}勝${longTrades.length-longWins}敗 勝率${longTrades.length>0?(longWins/longTrades.length*100).toFixed(1):"-"}% ${longPnl>=0?"+":""}${longPnl.toLocaleString()}円`);
  console.log(`1日平均: ${(totalPnl/dates.length).toFixed(0)}円/日`);

  // 日別
  const byDate: Record<string, number> = {};
  for (const t of trades) { byDate[t.date] = (byDate[t.date] || 0) + t.pnl; }
  const winDays = Object.values(byDate).filter(v => v > 0).length;
  console.log(`日別: ${winDays}勝${dates.length-winDays}敗`);

  return { trades, totalPnl, shortPnl, longPnl };
}

async function main() {
  const conn = await mysql.createConnection(DATABASE_URL);
  
  const [dateRows] = await conn.query(`
    SELECT DISTINCT tradeDate FROM rt_candles WHERE symbol = '8035' AND tradeDate <= '2026-08-18'
    ORDER BY tradeDate DESC LIMIT 21
  `) as any[];
  const allDates = (dateRows as any[]).map((r: any) => r.tradeDate).reverse();
  const dates = allDates.slice(1);
  console.log(`対象期間: ${dates[0]} 〜 ${dates[dates.length-1]} (${dates.length}営業日)`);

  const [allRows] = await conn.query(`
    SELECT tradeDate, symbol, candleTime as t, open as o, high as h, low as l, close as c, volume as v
    FROM rt_candles WHERE tradeDate IN (${allDates.map((d: string) => `'${d}'`).join(',')})
      AND symbol IN (${SYMBOLS.map(s => `'${s}'`).join(',')})
    ORDER BY symbol, tradeDate, candleTime
  `) as any[];

  const rawBuffers: Record<string, any[]> = {};
  for (const r of allRows as any[]) {
    if (!rawBuffers[r.symbol]) rawBuffers[r.symbol] = [];
    rawBuffers[r.symbol].push({ date: String(r.tradeDate), c: { t: r.t, o: Number(r.o), h: Number(r.h), l: Number(r.l), c: Number(r.c), v: Number(r.v) } });
  }

  const r20 = await runSim(20, "MA20（現行）", conn, dates, rawBuffers);
  const r50 = await runSim(50, "MA50（提案）", conn, dates, rawBuffers);

  console.log(`\n=== 比較サマリー ===`);
  console.log(`| 指標 | MA20（現行） | MA50（提案） | 差分 |`);
  console.log(`|------|-------------|-------------|------|`);
  console.log(`| 全体損益 | ${r20.totalPnl>=0?"+":""}${r20.totalPnl.toLocaleString()}円 | ${r50.totalPnl>=0?"+":""}${r50.totalPnl.toLocaleString()}円 | ${(r50.totalPnl-r20.totalPnl)>=0?"+":""}${(r50.totalPnl-r20.totalPnl).toLocaleString()}円 |`);
  console.log(`| SHORT損益 | ${r20.shortPnl>=0?"+":""}${r20.shortPnl.toLocaleString()}円 | ${r50.shortPnl>=0?"+":""}${r50.shortPnl.toLocaleString()}円 | ${(r50.shortPnl-r20.shortPnl)>=0?"+":""}${(r50.shortPnl-r20.shortPnl).toLocaleString()}円 |`);
  console.log(`| LONG損益 | ${r20.longPnl>=0?"+":""}${r20.longPnl.toLocaleString()}円 | ${r50.longPnl>=0?"+":""}${r50.longPnl.toLocaleString()}円 | ${(r50.longPnl-r20.longPnl)>=0?"+":""}${(r50.longPnl-r20.longPnl).toLocaleString()}円 |`);

  await conn.end();
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
