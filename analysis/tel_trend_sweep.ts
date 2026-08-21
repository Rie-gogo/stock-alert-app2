import { getDb } from "../server/db";
import { sql } from "drizzle-orm";

type C = { tradeDate: string; candleTime: string; open: number; high: number; low: number; close: number; volume: number; boardSnapshot?: unknown };
type T = { date: string; time: string; side: "long" | "short"; price: number; exitTime: string; exitPrice: number; pnl: number; outcome: string };
const mean = (x: number[]) => x.reduce((a, b) => a + b, 0) / x.length;
const pct = (a: number, b: number) => (a / b - 1) * 100;

function sanitize(rows: C[]) {
  const map = new Map<string, C[]>();
  for (const row of rows) (map.get(row.tradeDate) ?? map.set(row.tradeDate, []).get(row.tradeDate)!).push(row);
  for (const [date, day] of map) {
    const good: C[] = [];
    for (const c of day) {
      const prev = good.at(-1);
      if (prev && (c.low < prev.close * 0.5 || c.high > prev.close * 1.5)) continue;
      good.push(c);
    }
    map.set(date, good);
  }
  return map;
}
function slope(day: C[], i: number) { return pct(mean(day.slice(i - 7, i + 1).map(c => c.close)), mean(day.slice(i - 9, i - 1).map(c => c.close))); }
function exit(day: C[], i: number, side: "long" | "short", sl: number, tp: number, limit: string): Omit<T, "date" | "time" | "side" | "price"> {
  const entry = day[i].close; const slPx = side === "long" ? entry * (1 - sl / 100) : entry * (1 + sl / 100); const tpPx = side === "long" ? entry * (1 + tp / 100) : entry * (1 - tp / 100);
  for (let j = i + 1; j < day.length && day[j].candleTime <= limit; j++) {
    const c = day[j], slHit = side === "long" ? c.low <= slPx : c.high >= slPx, tpHit = side === "long" ? c.high >= tpPx : c.low <= tpPx;
    if (slHit) return { exitTime: c.candleTime, exitPrice: slPx, pnl: (side === "long" ? slPx - entry : entry - slPx) * 100, outcome: "SL" };
    if (tpHit) return { exitTime: c.candleTime, exitPrice: tpPx, pnl: (side === "long" ? tpPx - entry : entry - tpPx) * 100, outcome: "TP" };
  }
  const last = [...day].reverse().find(c => c.candleTime <= limit) ?? day.at(-1)!;
  return { exitTime: last.candleTime, exitPrice: last.close, pnl: (side === "long" ? last.close - entry : entry - last.close) * 100, outcome: "時間決済" };
}
function trendLong(day: C[], minGain: number, maxGain: number, lb: number, vol: number, sl: number, tp: number) {
  const open = day[0].open;
  for (let i = 20; i < day.length; i++) {
    const c = day[i]; if (c.candleTime < "10:00" || c.candleTime > "11:27") continue;
    const gain = pct(c.close, open), prior = day.slice(i - lb, i), vr = c.volume / mean(day.slice(i - 20, i).map(x => x.volume));
    if (gain >= minGain && gain <= maxGain && slope(day, i) >= 0.02 && c.close > Math.max(...prior.map(x => x.high)) && c.close > c.open && vr >= vol) {
      return { date: c.tradeDate, time: c.candleTime, side: "long" as const, price: c.close, ...exit(day, i, "long", sl, tp, "11:27") };
    }
  }
  return null;
}
function trendShort(day: C[], minDrop: number, maxDrop: number, lb: number, vol: number) {
  const open = day[0].open;
  for (let i = 20; i < day.length; i++) {
    const c = day[i]; if (c.candleTime < "10:00" || c.candleTime > "11:27") continue;
    const drop = -pct(c.close, open), prior = day.slice(i - lb, i), vr = c.volume / mean(day.slice(i - 20, i).map(x => x.volume));
    if (drop >= minDrop && drop <= maxDrop && slope(day, i) <= -0.02 && c.close < Math.min(...prior.map(x => x.low)) && c.close < c.open && vr >= vol) {
      return { date: c.tradeDate, time: c.candleTime, side: "short" as const, price: c.close, ...exit(day, i, "short", 0.8, 1.5, "11:27") };
    }
  }
  return null;
}
function stat(trades: T[]) { const wins = trades.filter(t => t.pnl > 0).length, pnl = trades.reduce((s,t)=>s+t.pnl,0), win = trades.filter(t=>t.pnl>0).reduce((s,t)=>s+t.pnl,0), loss = -trades.filter(t=>t.pnl<0).reduce((s,t)=>s+t.pnl,0); return { n: trades.length,w:wins,rate:trades.length?wins/trades.length*100:0,pnl,pf:loss?win/loss:Infinity }; }
function peakShort(day: C[]) {
  const open = day[0].open;
  let high = -Infinity;
  for (let i = 20; i < day.length; i++) {
    const c = day[i]; high = Math.max(high, c.high);
    if (c.candleTime < "09:45" || c.candleTime > "11:27") continue;
    const vol = c.volume / mean(day.slice(i - 20, i).map(x => x.volume));
    if (pct(high, open) >= 2.5 && pct(high, c.close) >= 0.4 && -pct(c.close, c.open) >= 0.1 && vol >= 1.0 && Math.max(...day.slice(Math.max(0, i - 2), i + 1).map(x => x.high)) === high) {
      return { date: c.tradeDate, time: c.candleTime, side: "short" as const, price: c.close, ...exit(day, i, "short", 0.8, 1.5, "11:27") };
    }
  }
  return null;
}
function integrate(candidates: T[]) {
  const accepted: T[] = [];
  for (const [date, items] of Object.entries(candidates.reduce((m: Record<string, T[]>, t) => ((m[t.date] ??= []).push(t), m), {}))) {
    let busyUntil = "00:00";
    for (const item of items.sort((a, b) => a.time.localeCompare(b.time) || (a.side === "long" ? -1 : 1))) {
      if (item.time > busyUntil) { accepted.push(item); busyUntil = item.exitTime; }
    }
  }
  return accepted;
}
async function main(){
 const db=await getDb(); if(!db)throw new Error("DB接続に失敗しました");
 const r=await db.execute(sql`SELECT tradeDate,candleTime,open,high,low,close,volume,boardSnapshot FROM rt_candles WHERE symbol='8035' ORDER BY tradeDate,candleTime`);
 const map=sanitize(((r as any)[0] as any[]).map(x=>({...x,open:Number(x.open),high:Number(x.high),low:Number(x.low),close:Number(x.close),volume:Number(x.volume)})) as C[]);
 const days=[...map.keys()].sort().slice(-40).map(d=>map.get(d)!).filter(d=>d.length>50);
 const longRows:any[]=[]; for(const min of [0.5,1,1.5,2])for(const max of [2.5,3,4,5,6])for(const lb of [5,10,20])for(const vol of [0.7,1,1.2])for(const sl of [0.5,0.6,0.8])for(const tp of [0.8,1.0,1.2,1.5]){if(max<=min||tp<=sl)continue;const tr=days.map(d=>trendLong(d,min,max,lb,vol,sl,tp)).filter(Boolean)as T[];const s=stat(tr);longRows.push({min,max,lb,vol,sl,tp,...s,tr});}
 const shortRows:any[]=[];for(const min of [0.5,1,1.5,2])for(const max of [3,4,5,6])for(const lb of [5,10,20])for(const vol of [0.7,1,1.2]){if(max<=min)continue;const tr=days.map(d=>trendShort(d,min,max,lb,vol)).filter(Boolean)as T[];const s=stat(tr);shortRows.push({min,max,lb,vol,...s,tr});}
 const rank=(a:any,b:any)=>b.pnl-a.pnl||b.rate-a.rate;
 console.log(`8035 品質調整済み直近40営業日: ${days[0][0].tradeDate}〜${days.at(-1)![0].tradeDate}`);
 console.log("--- 順張りLONG 損益上位10（TP>SLのみ）---");longRows.sort(rank).slice(0,10).forEach(x=>console.log(`gain${x.min}-${x.max}% high${x.lb} vol${x.vol}x SL${x.sl}/TP${x.tp}: ${x.n}件 ${x.w}勝${x.n-x.w}敗 勝率${x.rate.toFixed(1)}% ${x.pnl>=0?"+":""}${x.pnl.toFixed(0)}円 PF${x.pf.toFixed(2)}`));
 console.log("--- 順張りSHORT 損益上位10（SL0.8/TP1.5）---");shortRows.sort(rank).slice(0,10).forEach(x=>console.log(`drop${x.min}-${x.max}% low${x.lb} vol${x.vol}x: ${x.n}件 ${x.w}勝${x.n-x.w}敗 勝率${x.rate.toFixed(1)}% ${x.pnl>=0?"+":""}${x.pnl.toFixed(0)}円 PF${x.pf.toFixed(2)}`));
 for(const [label,x] of [["LONG",longRows.sort(rank)[0]],["SHORT",shortRows.sort(rank)[0]]]){console.log(`--- 最上位${label} 明細 ---`);x.tr.forEach((t:T)=>console.log(`${t.date} ${t.time} @${t.price.toFixed(0)} -> ${t.exitTime} ${t.outcome} ${t.pnl>=0?"+":""}${t.pnl.toFixed(0)}円`));}
 const bestLong = longRows.sort(rank)[0];
 const safeTrendShort = shortRows.find(x => x.min === 0.5 && x.max === 4 && x.lb === 5 && x.vol === 1.2)!;
 const peaks = days.map(d => peakShort(d)).filter(Boolean) as T[];
 const combined = integrate([...bestLong.tr, ...safeTrendShort.tr, ...peaks]);
 const cs = stat(combined);
 console.log("--- 候補統合（順張りLONG最上位 + 順張りSHORT勝率70%候補 + 高値反転SHORT）---");
 console.log(`${cs.n}件 ${cs.w}勝${cs.n-cs.w}敗 勝率${cs.rate.toFixed(1)}% ${cs.pnl>=0?"+":""}${cs.pnl.toFixed(0)}円 PF${cs.pf.toFixed(2)}`);
 const boardOf = (trade: T) => {
   const raw = map.get(trade.date)?.find(c => c.candleTime === trade.time)?.boardSnapshot;
   const board = typeof raw === "string" ? JSON.parse(raw) : raw as any;
   return board ? `${board.signal ?? "unknown"}/BPR${Number(board.buyPressureRatio ?? 0).toFixed(2)}` : "板なし";
 };
 combined.forEach(t => console.log(`${t.date} ${t.time} ${t.side} @${t.price.toFixed(0)} -> ${t.exitTime} ${t.outcome} ${t.pnl>=0?"+":""}${t.pnl.toFixed(0)}円 board:${boardOf(t)}`));
 const boardCounts = combined.reduce((m: Record<string, number>, trade) => ((m[boardOf(trade)] = (m[boardOf(trade)] ?? 0) + 1), m), {});
 console.log(`--- 統合候補の板情報内訳 ---\n${Object.entries(boardCounts).map(([key, count]) => `${key}:${count}件`).join(" / ")}`);
 const early = combined.filter(t => t.date <= "2026-07-21"), late = combined.filter(t => t.date >= "2026-07-22");
 const es = stat(early), ls = stat(late);
  console.log(`--- 統合候補の時系列分割 ---\n前半: ${es.n}件 ${es.w}勝${es.n-es.w}敗 勝率${es.rate.toFixed(1)}% ${es.pnl>=0?"+":""}${es.pnl.toFixed(0)}円 PF${es.pf.toFixed(2)}\n後半: ${ls.n}件 ${ls.w}勝${ls.n-ls.w}敗 勝率${ls.rate.toFixed(1)}% ${ls.pnl>=0?"+":""}${ls.pnl.toFixed(0)}円 PF${ls.pf.toFixed(2)}`);
 const cappedLong = longRows.find(x => x.min === 1.5 && x.max === 2.5 && x.lb === 20 && x.vol === 1 && x.sl === 0.8 && x.tp === 1)!;
 if (cappedLong) {
   const cappedCombined = integrate([...cappedLong.tr, ...safeTrendShort.tr, ...peaks]);
   const ccs = stat(cappedCombined);
   console.log(`--- 上昇幅2.5%上限LONG + SHORT候補統合 ---\n${ccs.n}件 ${ccs.w}勝${ccs.n-ccs.w}敗 勝率${ccs.rate.toFixed(1)}% ${ccs.pnl>=0?"+":""}${ccs.pnl.toFixed(0)}円 PF${ccs.pf.toFixed(2)}`);
   cappedCombined.forEach(t => console.log(`CAPPED ${t.date} ${t.time} ${t.side} @${t.price.toFixed(0)} -> ${t.exitTime} ${t.outcome} ${t.pnl>=0?"+":""}${t.pnl.toFixed(0)}円 board:${boardOf(t)}`));
   cappedCombined.filter(t => t.date === "2026-08-19").forEach(t => console.log(`8/19 ${t.time} ${t.side} @${t.price.toFixed(0)} -> ${t.exitTime} ${t.outcome} ${t.pnl>=0?"+":""}${t.pnl.toFixed(0)}円`));
 }
 process.exit(0);
}
main().catch(e=>{console.error(e);process.exit(1)});
