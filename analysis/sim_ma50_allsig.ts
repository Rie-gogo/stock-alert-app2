/**
 * MA50統一 全シグナル込み20営業日シミュレーション
 * 
 * シグナル:
 * - 大台割れSHORT（3方式: 即vol, 即4a, CB2MW1）
 * - 大台超え逆張りSHORT（buy_pressure時のみ）
 * - ダウ理論LONG（直近20本高値更新）
 * - 逆三尊LONG（簡易: 3つの安値でW底パターン）
 * - GC LONG（MA5がMA20を上抜け）
 * 
 * フィルター:
 * - isBullish MA50（SHORT禁止 / LONG許可）
 * - ATRフィルター（0.12%）
 * - 同一銘柄1ポジション制限
 * - 損切り後30分再エントリー禁止
 * - 前場強制決済（11:27）
 * - 大引け強制決済（15:25）
 * - 12:30-12:50エントリー禁止
 * 
 * 比較: MA20（現行）vs MA50（提案）
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
  for (let i = period; i < trs.length; i++) { atr = (atr * (period - 1) + trs[i]) / period; }
  return atr;
}

function timeToMin(t: string): number { const [h, m] = t.split(":").map(Number); return h * 60 + m; }

function calcIsBullish(bufSlice: number[], maPeriod: number): boolean {
  if (bufSlice.length < maPeriod + 1) return false;
  const current = bufSlice.slice(bufSlice.length - maPeriod);
  const prev = bufSlice.slice(bufSlice.length - maPeriod - 1, bufSlice.length - 1);
  const ma = current.reduce((s, v) => s + v, 0) / maPeriod;
  const prevMa = prev.reduce((s, v) => s + v, 0) / maPeriod;
  return (ma - prevMa) / prevMa * 100 > 0;
}

interface Trade { date: string; time: string; symbol: string; side: string; pnl: number; result: string; signal: string; }

async function runSim(maPeriod: number, label: string, dates: string[], rawBuffers: Record<string, any[]>) {
  const trades: Trade[] = [];

  for (const date of dates) {
    const positions: Record<string, {price: number; shares: number; side: string; entryTime: string; signal: string}> = {};
    const lastSLTime: Record<string, number> = {};

    for (const symbol of SYMBOLS) {
      const allBuf = rawBuffers[symbol];
      if (!allBuf) continue;
      const todayCandles = allBuf.filter((b: any) => b.date === date).map((b: any) => b.c);
      if (todayCandles.length < 25) continue;

      // 前日までのclose値をバッファとして構築（isBullish計算用）
      const prevDayCloses = allBuf.filter((b: any) => b.date < date).map((b: any) => b.c.c);

      for (let i = 1; i < todayCandles.length; i++) {
        const candle = todayCandles[i];
        const tMin = timeToMin(candle.t);

        // 前場強制決済
        if (candle.t >= "11:27" && candle.t < "11:30" && positions[symbol]) {
          const pos = positions[symbol];
          const pnl = pos.side === "short" ? Math.round((pos.price - candle.c) * pos.shares) : Math.round((candle.c - pos.price) * pos.shares);
          trades.push({ date, time: pos.entryTime, symbol, side: pos.side, pnl, result: "前場決済", signal: pos.signal });
          delete positions[symbol]; continue;
        }
        // 大引け強制決済
        if (candle.t >= "15:25" && positions[symbol]) {
          const pos = positions[symbol];
          const pnl = pos.side === "short" ? Math.round((pos.price - candle.c) * pos.shares) : Math.round((candle.c - pos.price) * pos.shares);
          trades.push({ date, time: pos.entryTime, symbol, side: pos.side, pnl, result: "大引け", signal: pos.signal });
          delete positions[symbol]; continue;
        }

        // ポジション保有中: SL/TP
        if (positions[symbol]) {
          const pos = positions[symbol];
          const sl = pos.side === "short" ? SL_MAP[symbol]?.short || 0.8 : SL_MAP[symbol]?.long || 0.5;
          const slPrice = pos.side === "short" ? pos.price * (1 + sl / 100) : pos.price * (1 - sl / 100);
          const tpPrice = pos.side === "short" ? pos.price * (1 - TP_PCT / 100) : pos.price * (1 + TP_PCT / 100);
          if (pos.side === "short" && candle.h >= slPrice) { trades.push({ date, time: pos.entryTime, symbol, side: "short", pnl: Math.round((pos.price - slPrice) * pos.shares), result: "SL", signal: pos.signal }); lastSLTime[symbol] = tMin; delete positions[symbol]; }
          else if (pos.side === "short" && candle.l <= tpPrice) { trades.push({ date, time: pos.entryTime, symbol, side: "short", pnl: Math.round((pos.price - tpPrice) * pos.shares), result: "TP", signal: pos.signal }); delete positions[symbol]; }
          else if (pos.side === "long" && candle.l <= slPrice) { trades.push({ date, time: pos.entryTime, symbol, side: "long", pnl: Math.round((slPrice - pos.price) * pos.shares), result: "SL", signal: pos.signal }); lastSLTime[symbol] = tMin; delete positions[symbol]; }
          else if (pos.side === "long" && candle.h >= tpPrice) { trades.push({ date, time: pos.entryTime, symbol, side: "long", pnl: Math.round((tpPrice - pos.price) * pos.shares), result: "TP", signal: pos.signal }); delete positions[symbol]; }
          continue;
        }

        // エントリー判定
        if (candle.t < "09:30" || candle.t >= "15:05") continue;
        if (candle.t >= "12:30" && candle.t < "12:50") continue;
        if (positions[symbol]) continue;
        if (lastSLTime[symbol] && tMin - lastSLTime[symbol] < NO_REENTRY_MIN) continue;

        // isBullish判定
        const allCloses = [...prevDayCloses, ...todayCandles.slice(0, i + 1).map(c => c.c)];
        if (allCloses.length < maPeriod + 1) continue;
        const isBullish = calcIsBullish(allCloses, maPeriod);

        // ATRフィルター
        const atrCandles = todayCandles.slice(Math.max(0, i - ATR_PERIOD), i + 1);
        const prevDayForATR = allBuf.filter((b: any) => b.date < date).map((b: any) => b.c).slice(-ATR_PERIOD);
        const atrInput = [...prevDayForATR, ...todayCandles.slice(0, i + 1)].slice(-(ATR_PERIOD + 1));
        const atr = calcATR(atrInput, ATR_PERIOD);
        if (atr !== null && candle.c > 0 && atr / candle.c < ATR_THRESHOLD) continue;

        const prevClose = todayCandles[i-1]?.c;
        if (!prevClose) continue;
        const price = candle.c;
        const shares = Math.floor(3000000 / price / 100) * 100 || 100;

        // === SHORT シグナル ===
        if (!isBullish) {
          // 大台割れSHORT
          const levels = getRoundLevels(prevClose);
          for (const level of levels) {
            if (prevClose >= level && candle.c < level) {
              // 3方式判定
              const volSlice = todayCandles.slice(Math.max(0, i - 20), i).map((c: any) => c.v);
              const avgVol = volSlice.length > 0 ? volSlice.reduce((s: number, v: number) => s + v, 0) / volSlice.length : 0;
              const volRatio = avgVol > 0 ? candle.v / avgVol : 0;
              const prevDist = (prevClose - level) / level * 100;
              let signal = "大台割れ(CB2)";
              if (volRatio >= FAST_ENTRY_VOL_RATIO) signal = "大台割れ(即vol)";
              else if (prevDist <= FAST_ENTRY_PREV_DIST_PCT) signal = "大台割れ(即4a)";
              positions[symbol] = { price, shares, side: "short", entryTime: candle.t, signal };
              break;
            }
          }
          if (positions[symbol]) continue;

          // 大台超え逆張りSHORT（buy_pressure時のみ）
          for (const level of levels) {
            if (prevClose < level && candle.c >= level) {
              // buy_pressure: 直近3本中2本以上陽線
              const recent3 = todayCandles.slice(Math.max(0, i - 3), i);
              const bullBars = recent3.filter((c: any) => c.c > c.o).length;
              if (bullBars >= 2) {
                positions[symbol] = { price, shares, side: "short", entryTime: candle.t, signal: "大台超え逆張り" };
                break;
              }
            }
          }
          if (positions[symbol]) continue;
        }

        // === LONG シグナル ===
        if (isBullish && i >= 20) {
          // ダウ理論LONG
          const recent20 = todayCandles.slice(i - 20, i);
          const maxHigh = Math.max(...recent20.map((c: any) => c.h));
          if (candle.h > maxHigh) {
            positions[symbol] = { price, shares, side: "long", entryTime: candle.t, signal: "ダウ理論" };
            continue;
          }

          // GC LONG（MA5 > MA20クロス）
          if (i >= 20) {
            const ma5now = todayCandles.slice(i - 4, i + 1).reduce((s: number, c: any) => s + c.c, 0) / 5;
            const ma20now = todayCandles.slice(i - 19, i + 1).reduce((s: number, c: any) => s + c.c, 0) / 20;
            const ma5prev = todayCandles.slice(i - 5, i).reduce((s: number, c: any) => s + c.c, 0) / 5;
            const ma20prev = todayCandles.slice(i - 20, i).reduce((s: number, c: any) => s + c.c, 0) / 20;
            if (ma5prev <= ma20prev && ma5now > ma20now) {
              positions[symbol] = { price, shares, side: "long", entryTime: candle.t, signal: "GC" };
              continue;
            }
          }

          // 逆三尊LONG（簡易: 直近30本で安値が切り上がり）
          if (i >= 30) {
            const seg1 = todayCandles.slice(i - 30, i - 20);
            const seg2 = todayCandles.slice(i - 20, i - 10);
            const seg3 = todayCandles.slice(i - 10, i);
            const low1 = Math.min(...seg1.map((c: any) => c.l));
            const low2 = Math.min(...seg2.map((c: any) => c.l));
            const low3 = Math.min(...seg3.map((c: any) => c.l));
            if (low2 < low1 && low3 > low2 && candle.c > candle.o) {
              positions[symbol] = { price, shares, side: "long", entryTime: candle.t, signal: "逆三尊" };
              continue;
            }
          }
        }
      }

      // 日末残ポジション
      if (positions[symbol]) {
        const lastCandle = todayCandles[todayCandles.length - 1];
        const pos = positions[symbol];
        const pnl = pos.side === "short" ? Math.round((pos.price - lastCandle.c) * pos.shares) : Math.round((lastCandle.c - pos.price) * pos.shares);
        trades.push({ date, time: pos.entryTime, symbol, side: pos.side, pnl, result: "EOD", signal: pos.signal });
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
  console.log(`SHORT: ${shortTrades.length}件 ${shortWins}勝${shortTrades.length-shortWins}敗 勝率${(shortWins/shortTrades.length*100).toFixed(1)}% ${shortPnl>=0?"+":""}${shortPnl.toLocaleString()}円`);
  console.log(`LONG: ${longTrades.length}件 ${longWins}勝${longTrades.length-longWins}敗 勝率${(longWins/longTrades.length*100).toFixed(1)}% ${longPnl>=0?"+":""}${longPnl.toLocaleString()}円`);
  console.log(`1日平均: ${Math.round(totalPnl/dates.length).toLocaleString()}円/日`);

  // シグナル別
  const bySig: Record<string, {count: number; wins: number; pnl: number}> = {};
  for (const t of trades) {
    if (!bySig[t.signal]) bySig[t.signal] = {count: 0, wins: 0, pnl: 0};
    bySig[t.signal].count++;
    if (t.pnl > 0) bySig[t.signal].wins++;
    bySig[t.signal].pnl += t.pnl;
  }
  console.log(`\nシグナル別:`);
  console.log(`| シグナル | 件数 | 勝率 | 損益 |`);
  console.log(`|----------|------|------|------|`);
  for (const [sig, data] of Object.entries(bySig).sort((a, b) => b[1].pnl - a[1].pnl)) {
    console.log(`| ${sig} | ${data.count}件 | ${(data.wins/data.count*100).toFixed(1)}% | ${data.pnl>=0?"+":""}${data.pnl.toLocaleString()}円 |`);
  }

  // 日別
  const byDate: Record<string, {pnl: number; count: number}> = {};
  for (const t of trades) { 
    if (!byDate[t.date]) byDate[t.date] = {pnl: 0, count: 0};
    byDate[t.date].pnl += t.pnl; byDate[t.date].count++;
  }
  console.log(`\n日別損益:`);
  console.log(`| 日付 | 件数 | 損益 |`);
  console.log(`|------|------|------|`);
  for (const [d, data] of Object.entries(byDate).sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(`| ${d} | ${data.count}件 | ${data.pnl>=0?"+":""}${data.pnl.toLocaleString()}円 |`);
  }

  return { totalPnl, shortPnl, longPnl, trades: trades.length, wins, shortTrades: shortTrades.length, longTrades: longTrades.length };
}

async function main() {
  const conn = await mysql.createConnection(DATABASE_URL);
  
  const [dateRows] = await conn.query(`
    SELECT DISTINCT tradeDate FROM rt_candles WHERE symbol = '8035' AND tradeDate <= '2026-08-18'
    ORDER BY tradeDate DESC LIMIT 22
  `) as any[];
  const allDates = (dateRows as any[]).map((r: any) => r.tradeDate).reverse();
  const dates = allDates.slice(2); // 最初の2日はバッファ用
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

  const r20 = await runSim(20, "MA20（現行）全シグナル", dates, rawBuffers);
  const r50 = await runSim(50, "MA50（提案）全シグナル", dates, rawBuffers);

  console.log(`\n\n========== 比較サマリー ==========`);
  console.log(`| 指標 | MA20（現行） | MA50（提案） | 差分 |`);
  console.log(`|------|-------------|-------------|------|`);
  console.log(`| 全体損益 | ${r20.totalPnl>=0?"+":""}${r20.totalPnl.toLocaleString()}円 | ${r50.totalPnl>=0?"+":""}${r50.totalPnl.toLocaleString()}円 | ${(r50.totalPnl-r20.totalPnl)>=0?"+":""}${(r50.totalPnl-r20.totalPnl).toLocaleString()}円 |`);
  console.log(`| SHORT損益 | ${r20.shortPnl>=0?"+":""}${r20.shortPnl.toLocaleString()}円 | ${r50.shortPnl>=0?"+":""}${r50.shortPnl.toLocaleString()}円 | ${(r50.shortPnl-r20.shortPnl)>=0?"+":""}${(r50.shortPnl-r20.shortPnl).toLocaleString()}円 |`);
  console.log(`| LONG損益 | ${r20.longPnl>=0?"+":""}${r20.longPnl.toLocaleString()}円 | ${r50.longPnl>=0?"+":""}${r50.longPnl.toLocaleString()}円 | ${(r50.longPnl-r20.longPnl)>=0?"+":""}${(r50.longPnl-r20.longPnl).toLocaleString()}円 |`);
  console.log(`| 全体勝率 | ${(r20.wins/r20.trades*100).toFixed(1)}% | ${(r50.wins/r50.trades*100).toFixed(1)}% | ${((r50.wins/r50.trades - r20.wins/r20.trades)*100).toFixed(1)}pt |`);
  console.log(`| 取引数 | ${r20.trades}件 | ${r50.trades}件 | ${r50.trades-r20.trades}件 |`);

  await conn.end();
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
