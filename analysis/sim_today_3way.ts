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

function simulate(candles: C[], entryIdx: number, symbol: string): { result: string; pnl: number; shares: number; exitTime: string; exitPrice: number } {
  const sl = SL_MAP[symbol]?.short || 0.8;
  const entryPrice = candles[entryIdx].c;
  const shares = Math.floor(3000000 / entryPrice / 100) * 100 || 100;
  const slPrice = entryPrice * (1 + sl / 100);
  const tpPrice = entryPrice * (1 - TP_PCT / 100);
  for (let j = entryIdx + 1; j < candles.length; j++) {
    if (candles[j].t >= "11:27" && candles[j].t < "11:30") {
      return { result: "前場決済", pnl: Math.round((entryPrice - candles[j].c) * shares), shares, exitTime: candles[j].t, exitPrice: candles[j].c };
    }
    if (candles[j].t >= "15:25") {
      return { result: "大引け", pnl: Math.round((entryPrice - candles[j].c) * shares), shares, exitTime: candles[j].t, exitPrice: candles[j].c };
    }
    if (candles[j].h >= slPrice) return { result: "SL", pnl: Math.round((entryPrice - slPrice) * shares), shares, exitTime: candles[j].t, exitPrice: slPrice };
    if (candles[j].l <= tpPrice) return { result: "TP", pnl: Math.round((entryPrice - tpPrice) * shares), shares, exitTime: candles[j].t, exitPrice: tpPrice };
  }
  const lastC = candles[candles.length - 1].c;
  return { result: "EOD", pnl: Math.round((entryPrice - lastC) * shares), shares, exitTime: candles[candles.length-1].t, exitPrice: lastC };
}

async function main() {
  const conn = await mysql.createConnection(DATABASE_URL);
  
  const [allRows] = await conn.query(`
    SELECT symbol, candleTime as t, open as o, high as h, low as l, close as c, volume as v
    FROM rt_candles WHERE tradeDate = '2026-08-18'
      AND symbol IN (${SYMBOLS.map(s => `'${s}'`).join(',')})
    ORDER BY symbol, candleTime
  `) as any[];

  const data: Record<string, C[]> = {};
  for (const r of allRows as any[]) {
    if (!data[r.symbol]) data[r.symbol] = [];
    data[r.symbol].push({ t: r.t, o: Number(r.o), h: Number(r.h), l: Number(r.l), c: Number(r.c), v: Number(r.v) });
  }

  interface Trade { symbol: string; time: string; price: number; result: string; pnl: number; method: string; shares: number; exitTime: string; exitPrice: number; level: number; prevDist: number; volRatio: number; }

  const trades: Trade[] = [];

  for (const symbol of SYMBOLS) {
    const candles = data[symbol];
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
          const { result, pnl, shares, exitTime, exitPrice } = simulate(candles, i, symbol);
          trades.push({ symbol, time: candles[i].t, price: candles[i].c, result, pnl, method: "③従来(CB2MW1)", shares, exitTime, exitPrice, level: pendingLevel, prevDist: -1, volRatio: 0 });
          inPosition = true; pendingState = "none";
        }
        continue;
      }

      const prevClose = candles[i-1].c;
      const currClose = candles[i].c;
      const levels = getRoundLevels(prevClose);

      for (const level of levels) {
        if (prevClose >= level && currClose < level) {
          // 出来高倍率計算
          let volRatio = 0;
          if (i >= 20) {
            const recentVols = candles.slice(i-20, i);
            const avgVol = recentVols.reduce((s,c) => s + c.v, 0) / 20;
            volRatio = avgVol > 0 ? candles[i].v / avgVol : 0;
          }
          const prevDist = (prevClose - level) / level * 100;

          // ① 出来高1.5倍 → 即エントリー
          if (volRatio >= 1.5) {
            const { result, pnl, shares, exitTime, exitPrice } = simulate(candles, i, symbol);
            trades.push({ symbol, time: candles[i].t, price: candles[i].c, result, pnl, method: "①即vol(出来高1.5倍)", shares, exitTime, exitPrice, level, prevDist, volRatio });
            inPosition = true; break;
          }

          // ② 前足がキリ番+0.05%以内 → 即エントリー
          if (prevDist <= 0.05) {
            const { result, pnl, shares, exitTime, exitPrice } = simulate(candles, i, symbol);
            trades.push({ symbol, time: candles[i].t, price: candles[i].c, result, pnl, method: "②即4a(前足近接)", shares, exitTime, exitPrice, level, prevDist, volRatio });
            inPosition = true; break;
          }

          // ③ 従来フロー
          pendingLevel = level; pendingConfirm = 0; pendingWait = 0; pendingState = "confirming"; break;
        }
      }
    }
  }

  // 表示
  console.log(`${"=".repeat(90)}`);
  console.log(`本日 2026-08-18（月）大台割れSHORT: 3方式シミュレーション`);
  console.log(`${"=".repeat(90)}\n`);

  // 時刻順にソート
  trades.sort((a, b) => a.time.localeCompare(b.time));

  console.log(`| # | 時刻 | 銘柄 | 方式 | エントリー | キリ番 | 前足乖離 | 出来高倍率 | 決済 | 損益 |`);
  console.log(`|---|------|------|------|-----------|--------|----------|-----------|------|------|`);
  let totalPnl = 0;
  trades.forEach((t, idx) => {
    totalPnl += t.pnl;
    const prevDistStr = t.prevDist >= 0 ? `${t.prevDist.toFixed(3)}%` : "-";
    const volStr = t.volRatio > 0 ? `${t.volRatio.toFixed(1)}倍` : "-";
    console.log(`| ${idx+1} | ${t.time} | ${t.symbol} | ${t.method} | @${t.price.toLocaleString()}円×${t.shares} | ${t.level.toLocaleString()}円 | ${prevDistStr} | ${volStr} | ${t.result}(${t.exitTime}) | ${t.pnl >= 0 ? "+" : ""}${t.pnl.toLocaleString()}円 |`);
  });

  console.log(`\n**合計: ${trades.length}件 ${trades.filter(t=>t.pnl>0).length}勝${trades.filter(t=>t.pnl<=0).length}敗 ${totalPnl >= 0 ? "+" : ""}${totalPnl.toLocaleString()}円**\n`);

  // 方式別集計
  console.log(`--- 方式別集計 ---\n`);
  const byMethod: Record<string, {cnt: number; wins: number; pnl: number}> = {};
  for (const t of trades) {
    if (!byMethod[t.method]) byMethod[t.method] = {cnt: 0, wins: 0, pnl: 0};
    byMethod[t.method].cnt++;
    if (t.pnl > 0) byMethod[t.method].wins++;
    byMethod[t.method].pnl += t.pnl;
  }
  console.log(`| 方式 | 件数 | 勝敗 | 損益 |`);
  console.log(`|------|------|------|------|`);
  for (const [m, v] of Object.entries(byMethod)) {
    console.log(`| ${m} | ${v.cnt}件 | ${v.wins}勝${v.cnt-v.wins}敗 | ${v.pnl >= 0 ? "+" : ""}${v.pnl.toLocaleString()}円 |`);
  }

  // 本番結果との比較
  console.log(`\n--- 本番結果との比較 ---\n`);
  console.log(`| 指標 | 本番実績 | 3方式シミュレーション |`);
  console.log(`|------|----------|---------------------|`);
  console.log(`| 取引数 | 8件 | ${trades.length}件 |`);
  console.log(`| 損益 | +110,106円 | ${totalPnl >= 0 ? "+" : ""}${totalPnl.toLocaleString()}円 |`);

  await conn.end();
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
