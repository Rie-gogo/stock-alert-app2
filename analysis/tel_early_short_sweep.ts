import { sql } from "drizzle-orm";
import { getDb } from "../server/db";

type Board = { signal?: string; buyPressureRatio?: number };
type C = { tradeDate: string; candleTime: string; open: number; high: number; low: number; close: number; volume: number; boardSnapshot: unknown };
type Trade = { date: string; time: string; exitTime: string; pnl: number; outcome: string; kind: string };
const pct = (a: number, b: number) => (a / b - 1) * 100;
const avg = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
const board = (c: C): Board | null => typeof c.boardSnapshot === "string" ? JSON.parse(c.boardSnapshot) : c.boardSnapshot as Board | null;

function clean(rows: C[]) {
  const map = new Map<string, C[]>();
  for (const row of rows) {
    const day = map.get(row.tradeDate) ?? [];
    const prev = day.at(-1);
    if (prev && (row.low < prev.close * 0.5 || row.high > prev.close * 1.5)) continue;
    day.push(row); map.set(row.tradeDate, day);
  }
  return [...map.values()].filter((day) => day.length > 50).slice(-40);
}
function slope(day: C[], i: number) { return pct(avg(day.slice(i - 7, i + 1).map(x => x.close)), avg(day.slice(i - 9, i - 1).map(x => x.close))); }
function exit(day: C[], i: number): Omit<Trade, "date" | "time" | "kind"> {
  const entry = day[i].close, sl = entry * 1.006, tp = entry * 0.982;
  for (let j = i + 1; j < day.length && day[j].candleTime <= "11:27"; j++) {
    if (day[j].high >= sl) return { exitTime: day[j].candleTime, pnl: (entry - sl) * 100, outcome: "SL" };
    if (day[j].low <= tp) return { exitTime: day[j].candleTime, pnl: (entry - tp) * 100, outcome: "TP" };
  }
  const last = [...day].reverse().find(x => x.candleTime <= "11:27")!;
  return { exitTime: last.candleTime, pnl: (entry - last.close) * 100, outcome: "前場決済" };
}
function earlyPeak(day: C[], rise: number, drop: number, body: number, volMin: number, bprMax: number): Trade | null {
  const open = day[0].open; let high = -Infinity;
  for (let i = 20; i < day.length; i++) {
    const c = day[i]; high = Math.max(high, c.high);
    if (c.candleTime < "09:35" || c.candleTime > "11:00") continue;
    const b = board(c); const bpr = b?.buyPressureRatio ?? 1; const sig = b?.signal ?? "neutral";
    const vr = c.volume / avg(day.slice(i - 20, i).map(x => x.volume));
    const ok = pct(high, open) >= rise && pct(high, c.close) >= drop && pct(c.open, c.close) >= body && slope(day, i) <= -0.02 && vr >= volMin && (sig === "sell_pressure" || (sig === "neutral" && bpr <= bprMax));
    if (ok) return { date: c.tradeDate, time: c.candleTime, kind: "早期高値反転SHORT", ...exit(day, i) };
  }
  return null;
}
function neutralTrend(day: C[], bprMax: number, volMin: number, minSlope: number): Trade | null {
  const open = day[0].open;
  for (let i = 20; i < day.length; i++) {
    const c = day[i]; if (c.candleTime < "10:00" || c.candleTime > "11:00") continue;
    const b = board(c); const bpr = b?.buyPressureRatio ?? 1;
    const low5 = Math.min(...day.slice(i - 5, i).map(x => x.low));
    const vr = c.volume / avg(day.slice(i - 20, i).map(x => x.volume));
    const ok = pct(c.close, open) <= -0.5 && pct(c.close, open) >= -4 && slope(day, i) <= minSlope && c.low < low5 && c.close < c.open && vr >= volMin && b?.signal === "neutral" && bpr <= bprMax;
    if (ok) return { date: c.tradeDate, time: c.candleTime, kind: "neutral早期順張りSHORT", ...exit(day, i) };
  }
  return null;
}
function stats(trades: Trade[]) { const w = trades.filter(x => x.pnl > 0).length; const pnl = trades.reduce((s, x) => s + x.pnl, 0); const gp = trades.filter(x => x.pnl > 0).reduce((s, x) => s + x.pnl, 0); const gl = -trades.filter(x => x.pnl < 0).reduce((s, x) => s + x.pnl, 0); return { n: trades.length, w, rate: trades.length ? w / trades.length * 100 : 0, pnl, pf: gl ? gp / gl : Infinity }; }

async function main() {
  const db = await getDb(); if (!db) throw new Error("DB接続に失敗しました");
  const result = await db.execute(sql`SELECT tradeDate,candleTime,open,high,low,close,volume,boardSnapshot FROM rt_candles WHERE symbol='8035' ORDER BY tradeDate,candleTime`);
  const rows = (result as unknown as [Array<Record<string, unknown>>])[0].map(r => ({ tradeDate:String(r.tradeDate), candleTime:String(r.candleTime), open:Number(r.open), high:Number(r.high), low:Number(r.low), close:Number(r.close), volume:Number(r.volume), boardSnapshot:r.boardSnapshot })) as C[];
  const days = clean(rows); const out: Array<{ rise:number; drop:number; body:number; vol:number; bpr:number; trades:Trade[]; s:ReturnType<typeof stats> }> = [];
  for (const rise of [1, 1.5, 2, 2.5]) for (const drop of [0.3, 0.4, 0.5]) for (const body of [0.05, 0.1]) for (const vol of [0.8, 1, 1.2]) for (const bpr of [0.7, 0.8, 1.0]) {
    const trades = days.map(d => earlyPeak(d, rise, drop, body, vol, bpr)).filter(Boolean) as Trade[]; const s = stats(trades);
    const d17 = trades.find(t => t.date === "2026-08-17" && t.time <= "09:40"); const d18 = trades.find(t => t.date === "2026-08-18" && t.time >= "10:12" && t.time <= "10:40");
    if (d17 || d18) out.push({ rise, drop, body, vol, bpr, trades, s });
  }
  out.sort((a,b) => Number(!!b.trades.find(t=>t.date==="2026-08-17"&&t.time<="09:40"))+Number(!!b.trades.find(t=>t.date==="2026-08-18"&&t.time>="10:12"&&t.time<="10:40"))-Number(!!a.trades.find(t=>t.date==="2026-08-17"&&t.time<="09:40"))-Number(!!a.trades.find(t=>t.date==="2026-08-18"&&t.time>="10:12"&&t.time<="10:40")) || b.s.rate-a.s.rate || b.s.pnl-a.s.pnl);
  console.log(`8035 早期高値反転SHORT: ${days.length}営業日`);
  for (const x of out.slice(0, 20)) console.log(`rise${x.rise}/drop${x.drop}/body${x.body}/vol${x.vol}/bpr${x.bpr}: ${x.s.n}件 ${x.s.w}勝${x.s.n-x.s.w}敗 勝率${x.s.rate.toFixed(1)}% ${x.s.pnl>=0?'+':''}${x.s.pnl.toFixed(0)}円 PF${x.s.pf.toFixed(2)} | 8/17 ${x.trades.find(t=>t.date==='2026-08-17')?.time??'-'} / 8/18 ${x.trades.find(t=>t.date==='2026-08-18')?.time??'-'}`);
  console.log("--- neutral板の早期順張りSHORT ---");
  for (const bpr of [0.7,0.8]) for (const vol of [1.0,1.2,1.5]) for (const s of [-0.02,-0.05,-0.08]) { const t=days.map(d=>neutralTrend(d,bpr,vol,s)).filter(Boolean)as Trade[];const z=stats(t);console.log(`bpr${bpr}/vol${vol}/slope${s}: ${z.n}件 ${z.w}勝${z.n-z.w}敗 勝率${z.rate.toFixed(1)}% ${z.pnl>=0?'+':''}${z.pnl.toFixed(0)}円 | 8/18 ${t.find(x=>x.date==='2026-08-18')?.time??'-'}`); }
  const chosen = out.find(x=>x.rise===1.5&&x.drop===0.4&&x.body===0.1&&x.vol===1&&x.bpr===0.8);
  if(chosen){ console.log("--- 推奨候補明細 ---"); chosen.trades.forEach(t=>console.log(`${t.date} ${t.time} -> ${t.exitTime} ${t.outcome} ${t.pnl>=0?'+':''}${t.pnl.toFixed(0)}円`)); }
}
main().catch(e=>{console.error(e);process.exit(1)});
