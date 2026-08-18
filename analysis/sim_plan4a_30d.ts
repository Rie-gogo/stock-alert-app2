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

function getRoundLevels(price: number): number[] {
  const levels: number[] = [];
  if (price >= 100000) {
    const base = Math.floor(price / 1000) * 1000;
    for (let i = -3; i <= 3; i++) levels.push(base + i * 1000);
  } else if (price >= 10000) {
    const base = Math.floor(price / 500) * 500;
    for (let i = -3; i <= 3; i++) levels.push(base + i * 500);
  } else if (price >= 5000) {
    const base = Math.floor(price / 200) * 200;
    for (let i = -3; i <= 3; i++) levels.push(base + i * 200);
  } else if (price >= 2000) {
    const base = Math.floor(price / 100) * 100;
    for (let i = -3; i <= 3; i++) levels.push(base + i * 100);
  } else {
    const base = Math.floor(price / 50) * 50;
    for (let i = -3; i <= 3; i++) levels.push(base + i * 50);
  }
  return levels.filter(l => l > 0);
}

interface C { t: string; o: number; h: number; l: number; c: number; v: number; }
interface Trade { date: string; symbol: string; time: string; price: number; result: string; pnl: number; method: string; }

function simulate(candles: C[], entryIdx: number, symbol: string): { result: string; pnl: number; shares: number } {
  const sl = SL_MAP[symbol]?.short || 0.8;
  const entryPrice = candles[entryIdx].c;
  const shares = Math.floor(3000000 / entryPrice / 100) * 100 || 100;
  const slPrice = entryPrice * (1 + sl / 100);
  const tpPrice = entryPrice * (1 - TP_PCT / 100);
  for (let j = entryIdx + 1; j < candles.length; j++) {
    if (candles[j].t >= "11:27" && candles[j].t < "11:30") {
      return { result: "AM_CLOSE", pnl: Math.round((entryPrice - candles[j].c) * shares), shares };
    }
    if (candles[j].h >= slPrice) return { result: "SL", pnl: Math.round((entryPrice - slPrice) * shares), shares };
    if (candles[j].l <= tpPrice) return { result: "TP", pnl: Math.round((entryPrice - tpPrice) * shares), shares };
  }
  const lastC = candles[candles.length - 1].c;
  return { result: "EOD", pnl: Math.round((entryPrice - lastC) * shares), shares };
}

async function main() {
  const conn = await mysql.createConnection(DATABASE_URL);
  
  const [dateRows] = await conn.query(`
    SELECT DISTINCT tradeDate FROM rt_candles 
    WHERE symbol = '8035' AND tradeDate <= '2026-08-18'
    ORDER BY tradeDate DESC LIMIT 30
  `) as any[];
  const dates = (dateRows as any[]).map((r: any) => r.tradeDate).reverse();
  console.log(`対象期間: ${dates[0]} 〜 ${dates[dates.length-1]} (${dates.length}営業日)\n`);

  const [allRows] = await conn.query(`
    SELECT tradeDate, symbol, candleTime as t, open as o, high as h, low as l, close as c, volume as v
    FROM rt_candles WHERE tradeDate IN (${dates.map((d: string) => `'${d}'`).join(',')}) 
      AND symbol IN (${SYMBOLS.map(s => `'${s}'`).join(',')})
    ORDER BY tradeDate, symbol, candleTime
  `) as any[];

  const data: Record<string, Record<string, C[]>> = {};
  for (const r of allRows as any[]) {
    if (!data[r.tradeDate]) data[r.tradeDate] = {};
    if (!data[r.tradeDate][r.symbol]) data[r.tradeDate][r.symbol] = [];
    data[r.tradeDate][r.symbol].push({ t: r.t, o: Number(r.o), h: Number(r.h), l: Number(r.l), c: Number(r.c), v: Number(r.v) });
  }

  // 案4a採用フロー
  const trades: Trade[] = [];
  for (const date of dates) {
    for (const symbol of SYMBOLS) {
      const candles = data[date]?.[symbol];
      if (!candles || candles.length < 25) continue;
      let inPosition = false;
      let pendingLevel = 0; let pendingConfirm = 0; let pendingWait = 0;
      let pendingState: "none"|"confirming"|"waiting" = "none";

      for (let i = 2; i < candles.length; i++) {
        if (candles[i].t < "09:30" || candles[i].t >= "15:05") continue;
        if (candles[i].t >= "12:30" && candles[i].t < "12:50") continue;
        if (inPosition) continue;

        if (pendingState === "confirming") {
          if (candles[i].c <= pendingLevel) {
            pendingConfirm++;
            if (pendingConfirm >= 2) { pendingState = "waiting"; pendingWait = 0; }
          } else { pendingState = "none"; }
          continue;
        }
        if (pendingState === "waiting") {
          pendingWait++;
          if (candles[i].c > pendingLevel) { pendingState = "none"; continue; }
          if (pendingWait > 1) {
            const { result, pnl } = simulate(candles, i, symbol);
            trades.push({ date, symbol, time: candles[i].t, price: candles[i].c, result, pnl, method: "従来(CB2MW1)" });
            inPosition = true; pendingState = "none";
          }
          continue;
        }

        const prevClose = candles[i-1].c;
        const currClose = candles[i].c;
        const levels = getRoundLevels(prevClose);

        for (const level of levels) {
          if (prevClose >= level && currClose < level) {
            // 大台割れ検出 — 優先順位で即エントリー判定

            // 条件1: 出来高1.5倍 → 即エントリー
            if (i >= 20) {
              const recentVols = candles.slice(i-20, i);
              const avgVol = recentVols.reduce((s,c) => s + c.v, 0) / 20;
              const volRatio = avgVol > 0 ? candles[i].v / avgVol : 0;
              if (volRatio >= 1.5) {
                const { result, pnl } = simulate(candles, i, symbol);
                trades.push({ date, symbol, time: candles[i].t, price: candles[i].c, result, pnl, method: "即vol(出来高1.5倍)" });
                inPosition = true; break;
              }
            }

            // 条件2: 前足がキリ番+0.05%以内 → 即エントリー（案4a）
            const prevDist = (prevClose - level) / level * 100;
            if (prevDist <= 0.05) {
              const { result, pnl } = simulate(candles, i, symbol);
              trades.push({ date, symbol, time: candles[i].t, price: candles[i].c, result, pnl, method: "即4a(前足近接)" });
              inPosition = true; break;
            }

            // どちらも不合致 → 従来通りCB=2, MW=1
            pendingLevel = level; pendingConfirm = 0; pendingWait = 0; pendingState = "confirming"; break;
          }
        }
      }
    }
  }

  // === 集計 ===
  console.log(`${"=".repeat(80)}`);
  console.log(`案4a採用時のエントリー方式配分（30営業日）`);
  console.log(`${"=".repeat(80)}\n`);

  // 方式別集計
  const byMethod: Record<string, {cnt: number; wins: number; pnl: number; trades: Trade[]}> = {};
  for (const t of trades) {
    if (!byMethod[t.method]) byMethod[t.method] = {cnt: 0, wins: 0, pnl: 0, trades: []};
    byMethod[t.method].cnt++;
    if (t.pnl > 0) byMethod[t.method].wins++;
    byMethod[t.method].pnl += t.pnl;
    byMethod[t.method].trades.push(t);
  }

  const totalCnt = trades.length;
  const totalWins = trades.filter(t => t.pnl > 0).length;
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const gp = trades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const gl = Math.abs(trades.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
  const pf = gl > 0 ? (gp / gl).toFixed(2) : "∞";

  console.log(`全体: ${totalCnt}件 ${totalWins}勝${totalCnt-totalWins}敗 勝率${(totalWins/totalCnt*100).toFixed(1)}% 損益${totalPnl >= 0 ? "+" : ""}${totalPnl.toLocaleString()}円 PF${pf}\n`);

  console.log(`| 方式 | 件数 | 配分 | 勝率 | 損益 | PF | 1件平均 |`);
  console.log(`|------|------|------|------|------|-----|---------|`);
  for (const [method, v] of Object.entries(byMethod).sort((a,b) => b[1].cnt - a[1].cnt)) {
    const methodGP = v.trades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
    const methodGL = Math.abs(v.trades.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
    const methodPF = methodGL > 0 ? (methodGP / methodGL).toFixed(2) : "∞";
    const avg = Math.round(v.pnl / v.cnt);
    console.log(`| ${method} | ${v.cnt}件 | ${(v.cnt/totalCnt*100).toFixed(1)}% | ${(v.wins/v.cnt*100).toFixed(1)}% | ${v.pnl >= 0 ? "+" : ""}${v.pnl.toLocaleString()}円 | ${methodPF} | ${avg >= 0 ? "+" : ""}${avg.toLocaleString()}円 |`);
  }

  // 銘柄別・方式別
  console.log(`\n\n--- 銘柄別・方式別配分 ---\n`);
  console.log(`| 銘柄 | 即vol | 即4a(前足) | 従来CB2MW1 | 合計 | 損益 |`);
  console.log(`|------|-------|-----------|-----------|------|------|`);
  for (const sym of SYMBOLS) {
    const symTrades = trades.filter(t => t.symbol === sym);
    if (symTrades.length === 0) continue;
    const vol = symTrades.filter(t => t.method.includes("vol")).length;
    const p4a = symTrades.filter(t => t.method.includes("4a")).length;
    const cb2 = symTrades.filter(t => t.method.includes("従来")).length;
    const symPnl = symTrades.reduce((s, t) => s + t.pnl, 0);
    console.log(`| ${sym} | ${vol}件 | ${p4a}件 | ${cb2}件 | ${symTrades.length}件 | ${symPnl >= 0 ? "+" : ""}${symPnl.toLocaleString()}円 |`);
  }

  // 日別集計
  console.log(`\n\n--- 日別損益 ---\n`);
  console.log(`| 日付 | 件数 | 即vol | 即4a | 従来 | 損益 |`);
  console.log(`|------|------|-------|------|------|------|`);
  for (const date of dates) {
    const dayTrades = trades.filter(t => t.date === date);
    if (dayTrades.length === 0) continue;
    const vol = dayTrades.filter(t => t.method.includes("vol")).length;
    const p4a = dayTrades.filter(t => t.method.includes("4a")).length;
    const cb2 = dayTrades.filter(t => t.method.includes("従来")).length;
    const dayPnl = dayTrades.reduce((s, t) => s + t.pnl, 0);
    console.log(`| ${date} | ${dayTrades.length}件 | ${vol} | ${p4a} | ${cb2} | ${dayPnl >= 0 ? "+" : ""}${dayPnl.toLocaleString()}円 |`);
  }

  // 決済理由別
  console.log(`\n\n--- 決済理由別 ---\n`);
  const byResult: Record<string, {cnt: number; pnl: number}> = {};
  for (const t of trades) {
    if (!byResult[t.result]) byResult[t.result] = {cnt: 0, pnl: 0};
    byResult[t.result].cnt++;
    byResult[t.result].pnl += t.pnl;
  }
  console.log(`| 理由 | 件数 | 損益 |`);
  console.log(`|------|------|------|`);
  for (const [r, v] of Object.entries(byResult).sort((a,b) => b[1].pnl - a[1].pnl)) {
    console.log(`| ${r} | ${v.cnt}件 | ${v.pnl >= 0 ? "+" : ""}${v.pnl.toLocaleString()}円 |`);
  }

  await conn.end();
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
