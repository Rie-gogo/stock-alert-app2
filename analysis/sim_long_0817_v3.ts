import mysql from "mysql2/promise";
const DATABASE_URL = process.env.DATABASE_URL!;
const TP_PCT = 1.5;
const SL_MAP: Record<string, {long: number; short: number}> = {
  "6976": {long:0.6, short:0.8}, "6981": {long:0.4, short:0.9}, "6526": {long:0.9, short:1.0},
};

interface C { t: string; o: number; h: number; l: number; c: number; v: number; date: string; }

async function main() {
  const conn = await mysql.createConnection(DATABASE_URL);
  // 前日+当日のデータ取得
  const symbols = ["6976", "6981", "6526"];
  const [allRows] = await conn.query(`
    SELECT tradeDate, symbol, candleTime as t, open as o, high as h, low as l, close as c, volume as v
    FROM rt_candles WHERE tradeDate IN ('2026-08-14','2026-08-17')
      AND symbol IN ('6976','6981','6526')
    ORDER BY symbol, tradeDate, candleTime
  `) as any[];

  const buffers: Record<string, C[]> = {};
  for (const r of allRows as any[]) {
    if (!buffers[r.symbol]) buffers[r.symbol] = [];
    buffers[r.symbol].push({ t: r.t, o: Number(r.o), h: Number(r.h), l: Number(r.l), c: Number(r.c), v: Number(r.v), date: r.tradeDate });
  }

  const blocked = [
    { symbol: "6976", time: "09:44", price: 10860, sig: "ダウ理論" },
    { symbol: "6976", time: "09:48", price: 10905, sig: "ダウ理論" },
    { symbol: "6981", time: "10:10", price: 8093, sig: "ダウ理論" },
    { symbol: "6976", time: "10:20", price: 11070, sig: "ダウ理論" },
    { symbol: "6981", time: "10:25", price: 8148, sig: "ダウ理論" },
    { symbol: "6976", time: "13:52", price: 11025, sig: "ダウ理論" },
    { symbol: "6976", time: "14:02", price: 11060, sig: "ダウ理論" },
    { symbol: "6526", time: "14:07", price: 2128.5, sig: "逆三尊" },
    { symbol: "6976", time: "14:14", price: 11060, sig: "ダウ理論" },
  ];

  console.log(`8/17（月）LONGシグナル: 静かな上昇バイパス検証（前日バッファ込み）\n`);
  console.log(`| # | 時刻 | 銘柄 | isBullish | MA傾き | MA乖離 | 実体 | 陰線 | バイパス | 結果 | 損益 |`);
  console.log(`|---|------|------|:---------:|--------|--------|------|:----:|:-------:|------|------|`);

  let totalBypassPnl = 0; let bypassCount = 0; let bypassWins = 0;
  let totalAllPnl = 0;

  for (let idx = 0; idx < blocked.length; idx++) {
    const b = blocked[idx];
    const buf = buffers[b.symbol];
    if (!buf) continue;

    // 全バッファ内で該当足を探す
    const entryIdx = buf.findIndex(c => c.date === '2026-08-17' && c.t === b.time);
    if (entryIdx < 0) { console.log(`| ${idx+1} | ${b.time} | ${b.symbol} | - | - | - | - | - | - | 足なし | - |`); continue; }

    // MA20計算（entryIdxから20本前を使う）
    let isBullish = false; let slope = 0; let maDeviation = 0;
    if (entryIdx >= 21) {
      const window = buf.slice(entryIdx - 19, entryIdx + 1); // 20本
      const prevWindow = buf.slice(entryIdx - 20, entryIdx); // 前の20本
      const ma20 = window.reduce((s, c) => s + c.close, 0) / 20;
      const prevMa20 = prevWindow.reduce((s, c) => s + c.close, 0) / 20;
      slope = (ma20 - prevMa20) / prevMa20 * 100;
      isBullish = slope > 0;
      maDeviation = Math.abs(buf[entryIdx].c - ma20) / ma20 * 100;
    }

    const bodyPct = Math.abs(buf[entryIdx].c - buf[entryIdx].o) / buf[entryIdx].o * 100;
    const recent10 = buf.slice(Math.max(0, entryIdx - 9), entryIdx + 1);
    const bearBars = recent10.filter(c => c.c < c.o).length;
    const bypass = isBullish && maDeviation < 0.3 && bodyPct < 0.1 && bearBars <= 3;

    // シミュレーション
    const sl = SL_MAP[b.symbol]?.long || 0.5;
    const entryPrice = b.price;
    const shares = Math.floor(3000000 / entryPrice / 100) * 100 || 100;
    const slPrice = entryPrice * (1 - sl / 100);
    const tpPrice = entryPrice * (1 + TP_PCT / 100);
    const todayCandles = buf.filter(c => c.date === '2026-08-17');
    const todayIdx = todayCandles.findIndex(c => c.t === b.time);
    let result = "EOD"; let pnl = 0; let exitTime = "";
    if (todayIdx >= 0) {
      for (let j = todayIdx + 1; j < todayCandles.length; j++) {
        if (todayCandles[j].t >= "11:27" && todayCandles[j].t < "11:30") { result = "前場決済"; pnl = Math.round((todayCandles[j].c - entryPrice) * shares); exitTime = todayCandles[j].t; break; }
        if (todayCandles[j].t >= "15:25") { result = "大引け"; pnl = Math.round((todayCandles[j].c - entryPrice) * shares); exitTime = todayCandles[j].t; break; }
        if (todayCandles[j].l <= slPrice) { result = "SL"; pnl = Math.round((slPrice - entryPrice) * shares); exitTime = todayCandles[j].t; break; }
        if (todayCandles[j].h >= tpPrice) { result = "TP"; pnl = Math.round((tpPrice - entryPrice) * shares); exitTime = todayCandles[j].t; break; }
      }
      if (result === "EOD") { pnl = Math.round((todayCandles[todayCandles.length-1].c - entryPrice) * shares); exitTime = todayCandles[todayCandles.length-1].t; }
    }
    totalAllPnl += pnl;
    if (bypass) { totalBypassPnl += pnl; bypassCount++; if (pnl > 0) bypassWins++; }

    console.log(`| ${idx+1} | ${b.time} | ${b.symbol} | ${isBullish ? "✓" : "✗"} | ${entryIdx >= 21 ? slope.toFixed(3)+"%" : "N/A"} | ${entryIdx >= 21 ? maDeviation.toFixed(3)+"%" : "N/A"} | ${bodyPct.toFixed(3)}% | ${bearBars}本 | ${bypass ? "**✓**" : "✗"} | ${result}(${exitTime}) | ${pnl >= 0 ? "+" : ""}${pnl.toLocaleString()}円 |`);
  }

  console.log(`\n全9件合計: ${totalAllPnl >= 0 ? "+" : ""}${totalAllPnl.toLocaleString()}円`);
  console.log(`バイパス適用: ${bypassCount}件 → ${bypassCount > 0 ? `${bypassWins}勝 ${totalBypassPnl >= 0 ? "+" : ""}${totalBypassPnl.toLocaleString()}円` : "0件（全てブロック維持）"}`);

  console.log(`\n--- 不適用理由 ---`);
  for (let idx = 0; idx < blocked.length; idx++) {
    const b = blocked[idx];
    const buf = buffers[b.symbol];
    if (!buf) continue;
    const entryIdx = buf.findIndex(c => c.date === '2026-08-17' && c.t === b.time);
    if (entryIdx < 21) { console.log(`  ${b.time} ${b.symbol}: バッファ不足(${entryIdx}本)`); continue; }
    const window = buf.slice(entryIdx - 19, entryIdx + 1);
    const prevWindow = buf.slice(entryIdx - 20, entryIdx);
    const ma20 = window.reduce((s, c) => s + c.close, 0) / 20;
    const prevMa20 = prevWindow.reduce((s, c) => s + c.close, 0) / 20;
    const slope = (ma20 - prevMa20) / prevMa20 * 100;
    const isBullish = slope > 0;
    const maDeviation = Math.abs(buf[entryIdx].c - ma20) / ma20 * 100;
    const bodyPct = Math.abs(buf[entryIdx].c - buf[entryIdx].o) / buf[entryIdx].o * 100;
    const recent10 = buf.slice(Math.max(0, entryIdx - 9), entryIdx + 1);
    const bearBars = recent10.filter(c => c.c < c.o).length;
    const reasons: string[] = [];
    if (!isBullish) reasons.push(`MA傾き${slope.toFixed(4)}%≤0`);
    if (maDeviation >= 0.3) reasons.push(`MA乖離${maDeviation.toFixed(3)}%≥0.3%`);
    if (bodyPct >= 0.1) reasons.push(`実体${bodyPct.toFixed(3)}%≥0.1%`);
    if (bearBars > 3) reasons.push(`陰線${bearBars}本>3`);
    if (reasons.length === 0) reasons.push("全条件OK → バイパス適用");
    console.log(`  ${b.time} ${b.symbol}: ${reasons.join(' / ')}`);
  }

  await conn.end();
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
