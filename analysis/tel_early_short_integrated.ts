import { sql } from "drizzle-orm";
import { getDb } from "../server/db";

type Board = { signal?: string; buyPressureRatio?: number };
type Candle = { tradeDate: string; candleTime: string; open: number; high: number; low: number; close: number; volume: number; boardSnapshot: unknown };
type Trade = { date: string; time: string; exitTime: string; side: "long" | "short"; kind: string; pnl: number; outcome: string };
const avg = (v: number[]) => v.reduce((s, x) => s + x, 0) / v.length;
const pct = (a: number, b: number) => (a / b - 1) * 100;
const b = (c: Candle): Board | null => typeof c.boardSnapshot === "string" ? JSON.parse(c.boardSnapshot) : c.boardSnapshot as Board | null;
const slope = (d: Candle[], i: number) => pct(avg(d.slice(i - 7, i + 1).map(x => x.close)), avg(d.slice(i - 9, i - 1).map(x => x.close)));
function exit(d: Candle[], i: number, side: "long" | "short", sl: number, tp: number): Omit<Trade, "date"|"time"|"side"|"kind"> {
  const entry=d[i].close, slPx=side === "long" ? entry*(1-sl/100) : entry*(1+sl/100), tpPx=side === "long" ? entry*(1+tp/100) : entry*(1-tp/100);
  for(let j=i+1;j<d.length && d[j].candleTime <= "11:27";j++) {
    const c=d[j]; if(side === "long" ? c.low <= slPx : c.high >= slPx) return {exitTime:c.candleTime,pnl:(side === "long" ? slPx-entry : entry-slPx)*100,outcome:"SL"};
    if(side === "long" ? c.high >= tpPx : c.low <= tpPx) return {exitTime:c.candleTime,pnl:(side === "long" ? tpPx-entry : entry-tpPx)*100,outcome:"TP"};
  }
  const last=[...d].reverse().find(x=>x.candleTime<="11:27")!; return {exitTime:last.candleTime,pnl:(side === "long" ? last.close-entry : entry-last.close)*100,outcome:"前場強制決済"};
}
function candidate(d:Candle[], type:"long"|"trendShort"|"peak"|"earlyPeak"|"neutral"):Trade|null {
  const open=d[0].open; let high=-Infinity;
  for(let i=20;i<d.length;i++) {
    const c=d[i], vr=c.volume/avg(d.slice(i-20,i).map(x=>x.volume)); high=Math.max(high,c.high); const bd=b(c), bpr=bd?.buyPressureRatio??1;
    if(type === "long" && c.candleTime >= "10:00" && c.candleTime <= "11:27" && pct(c.close,open)>=1.5 && pct(c.close,open)<=2.5 && slope(d,i)>=0.02 && c.close>Math.max(...d.slice(i-20,i).map(x=>x.high)) && c.close>c.open && vr>=1) return {date:c.tradeDate,time:c.candleTime,side:"long",kind:"現行順張りLONG",...exit(d,i,"long",.7,1)};
    if(type === "trendShort" && c.candleTime >= "10:00" && c.candleTime <= "11:00" && pct(c.close,open)>=-4 && pct(c.close,open)<=-.5 && slope(d,i)<=-.02 && c.low<Math.min(...d.slice(i-5,i).map(x=>x.low)) && c.close<c.open && vr>=1.2) return {date:c.tradeDate,time:c.candleTime,side:"short",kind:"現行順張りSHORT",...exit(d,i,"short",.6,1.8)};
    if(type === "peak" && c.candleTime >= "09:45" && c.candleTime <= "11:27" && pct(high,open)>=2.5 && pct(high,c.close)>=.4 && pct(c.open,c.close)>=.1 && vr>=1 && Math.max(...d.slice(Math.max(0,i-2),i+1).map(x=>x.high)) === high) return {date:c.tradeDate,time:c.candleTime,side:"short",kind:"現行高値反転SHORT",...exit(d,i,"short",.6,1.8)};
    if(type === "earlyPeak" && c.candleTime >= "09:35" && c.candleTime <= "11:00" && pct(high,open)>=1 && pct(high,c.close)>=.3 && pct(c.open,c.close)>=.05 && slope(d,i)<=-.02 && vr>=1 && (bd?.signal === "sell_pressure" || (bd?.signal === "neutral" && bpr<=1.0))) return {date:c.tradeDate,time:c.candleTime,side:"short",kind:"候補A: 早期高値反転SHORT",...exit(d,i,"short",.6,1.8)};
    if(type === "neutral" && c.candleTime >= "10:00" && c.candleTime <= "11:00" && pct(c.close,open)>=-4 && pct(c.close,open)<=-.5 && slope(d,i)<=-.02 && c.low<Math.min(...d.slice(i-5,i).map(x=>x.low)) && c.close<c.open && vr>=1 && bd?.signal === "neutral" && bpr<=.8) return {date:c.tradeDate,time:c.candleTime,side:"short",kind:"候補B: neutral例外SHORT",...exit(d,i,"short",.6,1.8)};
  } return null;
}
function integrate(items: Trade[]) { const accepted:Trade[]=[]; for(const day of Object.values(items.reduce((m:Record<string,Trade[]>,x)=>(m[x.date]??=[]).push(x)&&m,{}))) {let busy="00:00"; for(const x of day.sort((a,b)=>a.time.localeCompare(b.time)||a.kind.localeCompare(b.kind))) if(x.time>busy){accepted.push(x);busy=x.exitTime;}} return accepted; }
function stat(t:Trade[]){const w=t.filter(x=>x.pnl>0).length,p=t.reduce((s,x)=>s+x.pnl,0),gp=t.filter(x=>x.pnl>0).reduce((s,x)=>s+x.pnl,0),gl=-t.filter(x=>x.pnl<0).reduce((s,x)=>s+x.pnl,0);return `${t.length}件 ${w}勝${t.length-w}敗 勝率${t.length?(w/t.length*100).toFixed(1):"0.0"}% ${p>=0?"+":""}${p.toFixed(0)}円 PF${gl?(gp/gl).toFixed(2):"∞"}`;}
async function main(){const db=await getDb();if(!db)throw new Error("DB接続に失敗");const r=await db.execute(sql`SELECT tradeDate,candleTime,open,high,low,close,volume,boardSnapshot FROM rt_candles WHERE symbol='8035' ORDER BY tradeDate,candleTime`);const m=new Map<string,Candle[]>();for(const x of (r as any)[0]){const c={...x,open:+x.open,high:+x.high,low:+x.low,close:+x.close,volume:+x.volume}as Candle;const d=m.get(c.tradeDate)??[];const prev=d.at(-1);if(!prev||!(c.low<prev.close*.5||c.high>prev.close*1.5))d.push(c);m.set(c.tradeDate,d);}const ds=[...m.keys()].sort().slice(-40).map(k=>m.get(k)!).filter(d=>d.length>50);const base=integrate(ds.flatMap(d=>[candidate(d,"long"),candidate(d,"trendShort"),candidate(d,"peak")].filter(Boolean)as Trade[]));const a=integrate(ds.flatMap(d=>[candidate(d,"long"),candidate(d,"trendShort"),candidate(d,"peak"),candidate(d,"earlyPeak")].filter(Boolean)as Trade[]));const ab=integrate(ds.flatMap(d=>[candidate(d,"long"),candidate(d,"trendShort"),candidate(d,"peak"),candidate(d,"earlyPeak"),candidate(d,"neutral")].filter(Boolean)as Trade[]));console.log(`8035: ${ds[0][0].tradeDate}〜${ds.at(-1)![0].tradeDate}・KABUステーション保存1分足・SL0.6%/TP1.8%（SHORT）`);for(const [n,x] of [["現行三方式",base],["現行+候補A",a],["現行+候補A+B",ab]] as const)console.log(`${n}: ${stat(x)}`);console.log("--- 8/17・8/18の統合エントリー ---");ab.filter(x=>x.date>="2026-08-17").forEach(x=>console.log(`${x.date} ${x.time} ${x.kind} -> ${x.exitTime} ${x.outcome} ${x.pnl>=0?"+":""}${x.pnl.toFixed(0)}円`));console.log("--- 追加候補の採否 ---");for(const x of ab.filter(x=>x.kind.startsWith("候補")))console.log(`${x.date} ${x.time} ${x.kind} -> ${x.exitTime} ${x.outcome} ${x.pnl>=0?"+":""}${x.pnl.toFixed(0)}円`);process.exit(0);}
main().catch(e=>{console.error(e);process.exit(1)});
