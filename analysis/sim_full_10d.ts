/**
 * 全ロジック込みフルシミュレーション（10営業日）
 * - 大台割れSHORT: ①即vol(1.5倍) → ②即4a(前足+0.05%) → ③CB2MW1
 * - 大台超えLONG: 停止（buy_pressure時のみ逆張りSHORT）
 * - ダウ理論LONG: スコア0バイパス緩和A（MA乖離<0.5%, 実体<0.2%, 陰線≤4本）
 * - isBullish判定: MA20傾き > 0% → SHORT禁止
 * - 前場強制決済: 11:27
 * - 後場序盤禁止: 12:30〜12:50
 * - 同一銘柄1ポジション制限
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

interface C { t: string; o: number; h: number; l: number; c: number; v: number; }

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
  
  const [dateRows] = await conn.query(`
    SELECT DISTINCT tradeDate FROM rt_candles WHERE symbol = '8035' AND tradeDate <= '2026-08-18'
    ORDER BY tradeDate DESC LIMIT 11
  `) as any[];
  const allDates = (dateRows as any[]).map((r: any) => r.tradeDate).reverse();
  const prevDate = allDates[0];
  const dates = allDates.slice(1); // 10営業日
  console.log(`対象期間: ${dates[0]} 〜 ${dates[dates.length-1]} (${dates.length}営業日)\n`);

  const [allRows] = await conn.query(`
    SELECT tradeDate, symbol, candleTime as t, open as o, high as h, low as l, close as c, volume as v
    FROM rt_candles WHERE tradeDate IN (${allDates.map((d: string) => `'${d}'`).join(',')})
      AND symbol IN (${SYMBOLS.map(s => `'${s}'`).join(',')})
    ORDER BY symbol, tradeDate, candleTime
  `) as any[];

  // 銘柄ごとにバッファ構築
  const rawBuffers: Record<string, {date: string; c: C}[]> = {};
  for (const r of allRows as any[]) {
    if (!rawBuffers[r.symbol]) rawBuffers[r.symbol] = [];
    rawBuffers[r.symbol].push({ date: String(r.tradeDate), c: { t: r.t, o: Number(r.o), h: Number(r.h), l: Number(r.l), c: Number(r.c), v: Number(r.v) } });
  }

  interface Trade { date: string; time: string; symbol: string; side: string; price: number; shares: number; result: string; pnl: number; exitTime: string; method: string; }
  const trades: Trade[] = [];

  for (const date of dates) {
    for (const symbol of SYMBOLS) {
      const allBuf = rawBuffers[symbol];
      if (!allBuf) continue;

      // 当日+前日バッファ
      const bufUpToDate = allBuf.filter(b => b.date <= date);
      const todayCandles = allBuf.filter(b => b.date === date).map(b => b.c);
      if (todayCandles.length < 25) continue;

      let inPosition = false;
      let positionSide = "";
      let entryPrice = 0;
      let entryShares = 0;
      let entryTime = "";
      let entryMethod = "";
      let slPrice = 0;
      let tpPrice = 0;

      // 大台割れ待機状態
      let pendingState: "none"|"confirming"|"waiting" = "none";
      let pendingLevel = 0;
      let pendingConfirm = 0;
      let pendingWait = 0;

      for (let i = 0; i < todayCandles.length; i++) {
        const candle = todayCandles[i];
        const globalIdx = bufUpToDate.findIndex(b => b.date === date && b.c.t === candle.t);

        // ポジション決済チェック
        if (inPosition) {
          // 前場強制決済
          if (candle.t >= "11:27" && candle.t < "11:30") {
            const pnl = positionSide === "short" ? Math.round((entryPrice - candle.c) * entryShares) : Math.round((candle.c - entryPrice) * entryShares);
            trades.push({ date, time: entryTime, symbol, side: positionSide, price: entryPrice, shares: entryShares, result: "前場決済", pnl, exitTime: candle.t, method: entryMethod });
            inPosition = false; continue;
          }
          // 大引け
          if (candle.t >= "15:25") {
            const pnl = positionSide === "short" ? Math.round((entryPrice - candle.c) * entryShares) : Math.round((candle.c - entryPrice) * entryShares);
            trades.push({ date, time: entryTime, symbol, side: positionSide, price: entryPrice, shares: entryShares, result: "大引け", pnl, exitTime: candle.t, method: entryMethod });
            inPosition = false; continue;
          }
          // SL/TP
          if (positionSide === "short") {
            if (candle.h >= slPrice) {
              trades.push({ date, time: entryTime, symbol, side: "short", price: entryPrice, shares: entryShares, result: "SL", pnl: Math.round((entryPrice - slPrice) * entryShares), exitTime: candle.t, method: entryMethod });
              inPosition = false; continue;
            }
            if (candle.l <= tpPrice) {
              trades.push({ date, time: entryTime, symbol, side: "short", price: entryPrice, shares: entryShares, result: "TP", pnl: Math.round((entryPrice - tpPrice) * entryShares), exitTime: candle.t, method: entryMethod });
              inPosition = false; continue;
            }
          } else {
            if (candle.l <= slPrice) {
              trades.push({ date, time: entryTime, symbol, side: "long", price: entryPrice, shares: entryShares, result: "SL", pnl: Math.round((slPrice - entryPrice) * entryShares), exitTime: candle.t, method: entryMethod });
              inPosition = false; continue;
            }
            if (candle.h >= tpPrice) {
              trades.push({ date, time: entryTime, symbol, side: "long", price: entryPrice, shares: entryShares, result: "TP", pnl: Math.round((tpPrice - entryPrice) * entryShares), exitTime: candle.t, method: entryMethod });
              inPosition = false; continue;
            }
          }
          continue;
        }

        // エントリー禁止時間帯
        if (candle.t < "09:30" || candle.t >= "15:05") continue;
        if (candle.t >= "12:30" && candle.t < "12:50") continue;
        if (inPosition) continue;

        // isBullish計算
        let isBullish = false;
        if (globalIdx >= 21) {
          const w = bufUpToDate.slice(globalIdx - 19, globalIdx + 1).map(b => b.c);
          const pw = bufUpToDate.slice(globalIdx - 20, globalIdx).map(b => b.c);
          const ma20 = w.reduce((s, c) => s + c.c, 0) / 20;
          const prevMa20 = pw.reduce((s, c) => s + c.c, 0) / 20;
          isBullish = (ma20 - prevMa20) / prevMa20 * 100 > 0;
        }

        // 大台割れ待機処理
        if (pendingState === "confirming") {
          if (candle.c <= pendingLevel) {
            pendingConfirm++;
            if (pendingConfirm >= 2) { pendingState = "waiting"; pendingWait = 0; }
          } else { pendingState = "none"; }
          continue;
        }
        if (pendingState === "waiting") {
          pendingWait++;
          if (candle.c > pendingLevel) { pendingState = "none"; continue; }
          if (pendingWait > 1) {
            if (!isBullish) {
              const sl = SL_MAP[symbol]?.short || 0.8;
              entryPrice = candle.c; entryShares = Math.floor(3000000/entryPrice/100)*100||100;
              slPrice = entryPrice * (1 + sl/100); tpPrice = entryPrice * (1 - TP_PCT/100);
              positionSide = "short"; inPosition = true; entryTime = candle.t; entryMethod = "③CB2MW1";
            }
            pendingState = "none";
          }
          continue;
        }

        if (i < 2) continue;
        const prevClose = todayCandles[i-1].c;
        const currClose = candle.c;
        const levels = getRoundLevels(prevClose);

        // === 大台割れSHORT検出 ===
        for (const level of levels) {
          if (prevClose >= level && currClose < level) {
            if (isBullish) break; // isBullish時はSHORT禁止

            let volRatio = 0;
            if (i >= 20) {
              const rv = todayCandles.slice(i-20, i);
              const avg = rv.reduce((s,c) => s + c.v, 0) / 20;
              volRatio = avg > 0 ? candle.v / avg : 0;
            }
            const prevDist = (prevClose - level) / level * 100;

            // ① 即vol
            if (volRatio >= 1.5) {
              const sl = SL_MAP[symbol]?.short || 0.8;
              entryPrice = candle.c; entryShares = Math.floor(3000000/entryPrice/100)*100||100;
              slPrice = entryPrice * (1 + sl/100); tpPrice = entryPrice * (1 - TP_PCT/100);
              positionSide = "short"; inPosition = true; entryTime = candle.t; entryMethod = "①即vol";
              break;
            }
            // ② 即4a
            if (prevDist <= 0.05) {
              const sl = SL_MAP[symbol]?.short || 0.8;
              entryPrice = candle.c; entryShares = Math.floor(3000000/entryPrice/100)*100||100;
              slPrice = entryPrice * (1 + sl/100); tpPrice = entryPrice * (1 - TP_PCT/100);
              positionSide = "short"; inPosition = true; entryTime = candle.t; entryMethod = "②即4a";
              break;
            }
            // ③ 従来
            pendingLevel = level; pendingConfirm = 0; pendingWait = 0; pendingState = "confirming";
            break;
          }
        }
        if (inPosition) continue;

        // === ダウ理論LONG検出（スコア0バイパス緩和A） ===
        if (i >= 20 && globalIdx >= 21 && isBullish) {
          const recent20 = todayCandles.slice(Math.max(0, i-19), i);
          const highMax = Math.max(...recent20.map(c => c.h));
          if (candle.h > highMax && candle.c > candle.o) { // 高値更新 + 陽線
            // 緩和A条件チェック
            const w = bufUpToDate.slice(globalIdx - 19, globalIdx + 1).map(b => b.c);
            const ma20 = w.reduce((s, c) => s + c.c, 0) / 20;
            const maDeviation = Math.abs(candle.c - ma20) / ma20 * 100;
            const bodyPct = Math.abs(candle.c - candle.o) / candle.o * 100;
            const recent10 = todayCandles.slice(Math.max(0, i-9), i+1);
            const bearBars = recent10.filter(c => c.c < c.o).length;

            if (maDeviation < 0.5 && bodyPct < 0.2 && bearBars <= 4) {
              const sl = SL_MAP[symbol]?.long || 0.5;
              entryPrice = candle.c; entryShares = Math.floor(3000000/entryPrice/100)*100||100;
              slPrice = entryPrice * (1 - sl/100); tpPrice = entryPrice * (1 + TP_PCT/100);
              positionSide = "long"; inPosition = true; entryTime = candle.t; entryMethod = "LONG(バイパスA)";
            }
          }
        }
      }

      // 未決済ポジション（EOD）
      if (inPosition) {
        const lastC = todayCandles[todayCandles.length - 1].c;
        const pnl = positionSide === "short" ? Math.round((entryPrice - lastC) * entryShares) : Math.round((lastC - entryPrice) * entryShares);
        trades.push({ date, time: entryTime, symbol, side: positionSide, price: entryPrice, shares: entryShares, result: "EOD", pnl, exitTime: todayCandles[todayCandles.length-1].t, method: entryMethod });
      }
    }
  }

  // 結果表示
  trades.sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const wins = trades.filter(t => t.pnl > 0).length;
  const shorts = trades.filter(t => t.side === "short");
  const longs = trades.filter(t => t.side === "long");

  console.log(`=== 全ロジック込み10営業日シミュレーション（緩和A適用） ===\n`);
  console.log(`全体: ${trades.length}件 ${wins}勝${trades.length-wins}敗 勝率${(wins/trades.length*100).toFixed(1)}% ${totalPnl>=0?"+":""}${totalPnl.toLocaleString()}円\n`);
  console.log(`SHORT: ${shorts.length}件 ${shorts.filter(t=>t.pnl>0).length}勝${shorts.filter(t=>t.pnl<=0).length}敗 ${shorts.reduce((s,t)=>s+t.pnl,0)>=0?"+":""}${shorts.reduce((s,t)=>s+t.pnl,0).toLocaleString()}円`);
  console.log(`LONG:  ${longs.length}件 ${longs.filter(t=>t.pnl>0).length}勝${longs.filter(t=>t.pnl<=0).length}敗 ${longs.reduce((s,t)=>s+t.pnl,0)>=0?"+":""}${longs.reduce((s,t)=>s+t.pnl,0).toLocaleString()}円\n`);

  // 日別
  console.log(`--- 日別損益 ---`);
  console.log(`| 日付 | SHORT | LONG | 合計 | 件数 |`);
  console.log(`|------|-------|------|------|------|`);
  for (const d of dates) {
    const dt = trades.filter(t => t.date === d);
    const sp = dt.filter(t => t.side === "short").reduce((s,t) => s+t.pnl, 0);
    const lp = dt.filter(t => t.side === "long").reduce((s,t) => s+t.pnl, 0);
    const tp = sp + lp;
    console.log(`| ${d} | ${sp>=0?"+":""}${sp.toLocaleString()}円 | ${lp>=0?"+":""}${lp.toLocaleString()}円 | ${tp>=0?"+":""}${tp.toLocaleString()}円 | ${dt.length}件 |`);
  }

  // 方式別
  console.log(`\n--- 方式別 ---`);
  const byMethod: Record<string, {cnt:number;wins:number;pnl:number}> = {};
  for (const t of trades) {
    if (!byMethod[t.method]) byMethod[t.method] = {cnt:0,wins:0,pnl:0};
    byMethod[t.method].cnt++;
    if (t.pnl > 0) byMethod[t.method].wins++;
    byMethod[t.method].pnl += t.pnl;
  }
  console.log(`| 方式 | 件数 | 勝率 | 損益 |`);
  console.log(`|------|------|------|------|`);
  for (const [m, v] of Object.entries(byMethod).sort((a,b) => b[1].pnl - a[1].pnl)) {
    console.log(`| ${m} | ${v.cnt}件 | ${(v.wins/v.cnt*100).toFixed(1)}% | ${v.pnl>=0?"+":""}${v.pnl.toLocaleString()}円 |`);
  }

  await conn.end();
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
