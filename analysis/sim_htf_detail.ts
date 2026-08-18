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
  if (price >= 100000) { const b = Math.floor(price/1000)*1000; for(let i=-3;i<=3;i++) levels.push(b+i*1000); }
  else if (price >= 10000) { const b = Math.floor(price/500)*500; for(let i=-3;i<=3;i++) levels.push(b+i*500); }
  else if (price >= 5000) { const b = Math.floor(price/200)*200; for(let i=-3;i<=3;i++) levels.push(b+i*200); }
  else if (price >= 2000) { const b = Math.floor(price/100)*100; for(let i=-3;i<=3;i++) levels.push(b+i*100); }
  else { const b = Math.floor(price/50)*50; for(let i=-3;i<=3;i++) levels.push(b+i*50); }
  return levels.filter(l => l > 0);
}

function get3mTrend(candles: {c: number}[], idx: number): "up"|"down"|"neutral" {
  if (idx < 3) return "neutral";
  const c0 = candles[idx].c;
  const c3 = candles[idx - 3].c;
  const pct = (c0 - c3) / c3 * 100;
  if (pct > 0.05) return "up";
  if (pct < -0.05) return "down";
  return "neutral";
}

async function main() {
  const conn = await mysql.createConnection(DATABASE_URL);
  
  const [dateRows] = await conn.query(`
    SELECT DISTINCT tradeDate FROM rt_candles WHERE symbol = '8035' AND tradeDate <= '2026-08-18'
    ORDER BY tradeDate DESC LIMIT 21
  `) as any[];
  const allDates = (dateRows as any[]).map((r: any) => r.tradeDate).reverse();
  const dates = allDates.slice(1);

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

  const htfBlocked: any[] = [];

  for (const date of dates) {
    for (const symbol of SYMBOLS) {
      const allBuf = rawBuffers[symbol];
      if (!allBuf) continue;
      const bufUpToDate = allBuf.filter(b => b.date <= date);
      const todayCandles = allBuf.filter(b => b.date === date).map(b => b.c);
      if (todayCandles.length < 25) continue;

      let found = false;
      for (let i = 20; i < todayCandles.length; i++) {
        if (found) break;
        const candle = todayCandles[i];
        if (candle.t < "09:30" || candle.t >= "15:05") continue;
        if (candle.t >= "12:30" && candle.t < "12:50") continue;

        const globalIdx = bufUpToDate.findIndex(b => b.date === date && b.c.t === candle.t);
        if (globalIdx < 21) continue;

        const w = bufUpToDate.slice(globalIdx - 19, globalIdx + 1).map(b => b.c);
        const pw = bufUpToDate.slice(globalIdx - 20, globalIdx).map(b => b.c);
        const ma20 = w.reduce((s, c) => s + c.c, 0) / 20;
        const prevMa20 = pw.reduce((s, c) => s + c.c, 0) / 20;
        const isBullish = (ma20 - prevMa20) / prevMa20 * 100 > 0;

        const prevClose = todayCandles[i-1].c;
        const currClose = candle.c;
        const levels = getRoundLevels(prevClose);
        let shortSignal = false;
        for (const level of levels) {
          if (prevClose >= level && currClose < level && !isBullish) { shortSignal = true; break; }
        }
        if (!shortSignal) continue;

        const trend3m = get3mTrend(todayCandles.map(c => ({c: c.c})), i);
        if (trend3m !== "up") continue; // HTFブロック対象のみ

        // ATRチェック（ATRブロックは除外）
        let atrBlocked = false;
        if (globalIdx >= 8) {
          const slice = bufUpToDate.slice(globalIdx - 7, globalIdx + 1).map(b => b.c);
          const trs: number[] = [];
          for (let k = 1; k < slice.length; k++) {
            trs.push(Math.max(slice[k].h - slice[k].l, Math.abs(slice[k].h - slice[k-1].c), Math.abs(slice[k].l - slice[k-1].c)));
          }
          if (trs.length >= 7) {
            const atr = trs.slice(-7).reduce((s,v)=>s+v,0)/7;
            if (atr / candle.c < 0.0012) atrBlocked = true;
          }
        }
        if (atrBlocked) continue;

        // シミュレーション
        const sl = SL_MAP[symbol]?.short || 0.8;
        const price = candle.c;
        const shares = Math.floor(3000000 / price / 100) * 100 || 100;
        const slPrice = price * (1 + sl / 100);
        const tpPrice = price * (1 - TP_PCT / 100);
        let pnl = 0; let result = "EOD"; let exitTime = "";
        for (let j = i + 1; j < todayCandles.length; j++) {
          if (todayCandles[j].t >= "11:27" && todayCandles[j].t < "11:30") { result = "前場決済"; pnl = Math.round((price - todayCandles[j].c) * shares); exitTime = todayCandles[j].t; break; }
          if (todayCandles[j].t >= "15:25") { result = "大引け"; pnl = Math.round((price - todayCandles[j].c) * shares); exitTime = todayCandles[j].t; break; }
          if (todayCandles[j].h >= slPrice) { result = "SL"; pnl = Math.round((price - slPrice) * shares); exitTime = todayCandles[j].t; break; }
          if (todayCandles[j].l <= tpPrice) { result = "TP"; pnl = Math.round((price - tpPrice) * shares); exitTime = todayCandles[j].t; break; }
        }
        if (!exitTime) { pnl = Math.round((price - todayCandles[todayCandles.length-1].c) * shares); exitTime = todayCandles[todayCandles.length-1].t; }

        htfBlocked.push({ date, time: candle.t, symbol, price, shares, result, pnl, exitTime, trend3m });
        found = true;
      }
    }
  }

  console.log(`=== HTFフィルターでブロックされた取引の詳細 ===\n`);
  console.log(`| # | 日付 | 時刻 | 銘柄 | エントリー | 株数 | 決済 | 損益 |`);
  console.log(`|---|------|------|------|-----------|------|------|------|`);
  let total = 0;
  for (let i = 0; i < htfBlocked.length; i++) {
    const t = htfBlocked[i];
    total += t.pnl;
    console.log(`| ${i+1} | ${t.date} | ${t.time} | ${t.symbol} | @${t.price.toLocaleString()}円 | ${t.shares}株 | ${t.result}(${t.exitTime}) | ${t.pnl >= 0 ? "+" : ""}${t.pnl.toLocaleString()}円 |`);
  }
  console.log(`\n合計: ${htfBlocked.length}件 ${htfBlocked.filter(t=>t.pnl>0).length}勝${htfBlocked.filter(t=>t.pnl<=0).length}敗 ${total>=0?"+":""}${total.toLocaleString()}円`);

  // 銘柄別
  console.log(`\n--- 銘柄別 ---`);
  const bySymbol: Record<string, {cnt:number;wins:number;pnl:number}> = {};
  for (const t of htfBlocked) {
    if (!bySymbol[t.symbol]) bySymbol[t.symbol] = {cnt:0,wins:0,pnl:0};
    bySymbol[t.symbol].cnt++;
    if (t.pnl > 0) bySymbol[t.symbol].wins++;
    bySymbol[t.symbol].pnl += t.pnl;
  }
  for (const [sym, v] of Object.entries(bySymbol).sort((a,b) => b[1].pnl - a[1].pnl)) {
    console.log(`  ${sym}: ${v.cnt}件 ${v.wins}勝${v.cnt-v.wins}敗 ${v.pnl >= 0 ? "+" : ""}${v.pnl.toLocaleString()}円`);
  }

  // 株価帯別
  console.log(`\n--- 株価帯別 ---`);
  const high = htfBlocked.filter(t => t.price >= 30000);
  const mid = htfBlocked.filter(t => t.price >= 5000 && t.price < 30000);
  const low = htfBlocked.filter(t => t.price < 5000);
  console.log(`  高額(≥3万円): ${high.length}件 ${high.filter(t=>t.pnl>0).length}勝${high.filter(t=>t.pnl<=0).length}敗 ${high.reduce((s,t)=>s+t.pnl,0)>=0?"+":""}${high.reduce((s,t)=>s+t.pnl,0).toLocaleString()}円`);
  console.log(`  中額(5千〜3万): ${mid.length}件 ${mid.filter(t=>t.pnl>0).length}勝${mid.filter(t=>t.pnl<=0).length}敗 ${mid.reduce((s,t)=>s+t.pnl,0)>=0?"+":""}${mid.reduce((s,t)=>s+t.pnl,0).toLocaleString()}円`);
  console.log(`  低額(<5千): ${low.length}件 ${low.filter(t=>t.pnl>0).length}勝${low.filter(t=>t.pnl<=0).length}敗 ${low.reduce((s,t)=>s+t.pnl,0)>=0?"+":""}${low.reduce((s,t)=>s+t.pnl,0).toLocaleString()}円`);

  await conn.end();
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
