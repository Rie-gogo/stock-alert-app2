/**
 * concurrencySweep.ts
 * 同時保有枠(maxConcurrent) × 同業種上限(maxPerSector) を上昇相場・下落相場の両方でスイープ。
 *
 * dailyStopSweepBoth.ts と同じデータ生成ロジックを使い、各日の建玉イベント(PerStockTrades)を
 * 一度だけ生成して、設定違いで applyPortfolioRules を適用する（シミュレーション固定で枠設定だけ純粋比較）。
 *
 * 実行: cd /home/ubuntu/stock-alert-app && npx tsx analysis/concurrencySweep.ts
 */
import { callDataApi } from "../server/_core/dataApi";
import { TARGET_STOCKS } from "../shared/stocks";
import {
  applyPortfolioRules,
  DEFAULT_PORTFOLIO_CONFIG,
  type PerStockTrades,
  type PortfolioConfig,
} from "../server/portfolio";
import { simulateStockReal, computeMarketEfficiency, isRangeBoundDay } from "../server/realSimulation";

function calcMA(d: number[], p: number) { const r: (number|null)[] = new Array(d.length).fill(null); for (let i=p-1;i<d.length;i++){ r[i]=d.slice(i-p+1,i+1).reduce((a,b)=>a+b,0)/p; } return r; }
function calcRSI(d: number[], p=14) { const r: (number|null)[] = new Array(d.length).fill(null); if(d.length<p+1)return r; const g:number[]=[],l:number[]=[]; for(let i=1;i<d.length;i++){const x=d[i]-d[i-1];g.push(Math.max(x,0));l.push(Math.max(-x,0));} let ag=g.slice(0,p).reduce((a,b)=>a+b,0)/p, al=l.slice(0,p).reduce((a,b)=>a+b,0)/p; for(let i=p;i<d.length;i++){ r[i]= al===0?100:100-100/(1+ag/al); if(i<d.length-1){ag=(ag*(p-1)+g[i])/p;al=(al*(p-1)+l[i])/p;} } return r; }
function calcBB(d: number[], p=20, m=2) { const u:(number|null)[]=new Array(d.length).fill(null), lo:(number|null)[]=new Array(d.length).fill(null); for(let i=p-1;i<d.length;i++){const w=d.slice(i-p+1,i+1);const a=w.reduce((x,y)=>x+y,0)/p;const v=w.reduce((x,y)=>x+(y-a)**2,0)/p;const s=Math.sqrt(v);u[i]=a+m*s;lo[i]=a-m*s;} return {upper:u,lower:lo}; }

interface RealCandle { time:string;timestamp:number;open:number;high:number;low:number;close:number;volume:number;ma5:number|null;ma25:number|null;rsi:number|null;bbUpper:number|null;bbLower:number|null;flow:number|null;slope:number|null; }
interface RawBar { timestamp:number;jstDate:string;time:string;open:number;high:number;low:number;close:number;volume:number; }

const FLOW_LOOKBACK=10,SLOPE_LOOKBACK=25;
async function fetch1mByDay(ticker: string): Promise<Map<string, RawBar[]>> {
  const raw=await callDataApi("YahooFinance/get_stock_chart",{query:{symbol:ticker,region:"JP",interval:"1m",range:"5d"}}) as { chart?:{result?:Array<{timestamp:number[];indicators:{quote:Array<{open:(number|null)[];high:(number|null)[];low:(number|null)[];close:(number|null)[];volume:(number|null)[]}>}}>}};
  const byDay=new Map<string,RawBar[]>(); const result=raw?.chart?.result?.[0]; if(!result)return byDay;
  const ts=result.timestamp??[]; const q=result.indicators.quote[0];
  for(let i=0;i<ts.length;i++){ const o=q.open[i],h=q.high[i],l=q.low[i],c=q.close[i],v=q.volume[i]; if(o==null||c==null)continue; const jst=new Date(ts[i]*1000+9*3600*1000); const jstDate=`${jst.getUTCFullYear()}-${String(jst.getUTCMonth()+1).padStart(2,"0")}-${String(jst.getUTCDate()).padStart(2,"0")}`; const time=`${String(jst.getUTCHours()).padStart(2,"0")}:${String(jst.getUTCMinutes()).padStart(2,"0")}`; const arr=byDay.get(jstDate)??[]; arr.push({timestamp:ts[i]*1000,jstDate,time,open:o,high:h??o,low:l??o,close:c,volume:v??0}); byDay.set(jstDate,arr); }
  return byDay;
}
function toCandles1m(bars: RawBar[]): RealCandle[] {
  const candles: RealCandle[]=bars.map(b=>({time:b.time,timestamp:b.timestamp,open:b.open,high:b.high,low:b.low,close:b.close,volume:b.volume,ma5:null,ma25:null,rsi:null,bbUpper:null,bbLower:null,flow:null,slope:null}));
  const closes=candles.map(c=>c.close); const ma5=calcMA(closes,5),ma25=calcMA(closes,25),rsi=calcRSI(closes,14),bb=calcBB(closes,20,2);
  candles.forEach((c,i)=>{c.ma5=ma5[i];c.ma25=ma25[i];c.rsi=rsi[i];c.bbUpper=bb.upper[i];c.bbLower=bb.lower[i];});
  const signed=candles.map(c=>{const r=(c.high-c.low)||1;const clv=((c.close-c.low)-(c.high-c.close))/r;return clv*c.volume;});
  candles.forEach((c,i)=>{ if(i>=FLOW_LOOKBACK-1){let s=0;for(let k=i-FLOW_LOOKBACK+1;k<=i;k++)s+=signed[k];c.flow=s;} if(i>=SLOPE_LOOKBACK&&c.ma25!=null){const pm=candles[i-SLOPE_LOOKBACK].ma25;if(pm!=null&&pm!==0)c.slope=(c.ma25-pm)/pm;} });
  return candles;
}

const MA_FAST=3,MA_SLOW=10,RSI_PERIOD=9,BB_PERIOD=10,D_SLOPE_LOOKBACK=8,D_FLOW_LOOKBACK=5,WARMUP_BARS=4;
const SLOPE_THRESHOLD=0.0006,SHORT_RSI_MIN=55,SHORT_NEAR_MA=0.006,SHORT_BREAKDOWN_RSI_MIN=35,PULLBACK_RSI=45,PULLBACK_NEAR_MA=0.006,MARKET_REGIME_THRESHOLD=0.004,BREAKEVEN_TRIGGER=0.005,TRAIL_TRIGGER=0.01,TRAIL_GAP=0.005,MAX_TRADES_PER_DAY=4,CIRCUIT_BREAKER=20000,HIGH_VOL_DAY_THRESHOLD=0.08,STOP_LOSS=0.02;
const SUPPRESS_ENTRY_HOURS=new Set([12]);
const HIGH_VOL_SYMBOLS=new Set(["9984","4568","6526","9107","6723","5803","8316","7203","5016"]);
const LOT_NORMAL=0.49,LOT_SMALL=0.05,INITIAL_CAPITAL=3_000_000;
interface DCandle { time:string;hour:number;open:number;high:number;low:number;close:number;volume:number;ma5:number|null;ma25:number|null;rsi:number|null;bbUpper:number|null;bbLower:number|null;flow:number|null;slope:number|null; }
async function fetch5mByDay(ticker: string): Promise<Map<string, DCandle[]>> {
  const raw=await callDataApi("YahooFinance/get_stock_chart",{query:{symbol:ticker,region:"JP",interval:"5m",range:"1mo"}}) as { chart?:{result?:Array<{timestamp:number[];indicators:{quote:Array<{open:(number|null)[];high:(number|null)[];low:(number|null)[];close:(number|null)[];volume:(number|null)[]}>}}>}};
  const result=raw?.chart?.result?.[0]; const byDay=new Map<string,DCandle[]>(); if(!result)return byDay;
  const ts=result.timestamp??[]; const q=result.indicators.quote[0];
  for(let i=0;i<ts.length;i++){ const o=q.open[i],h=q.high[i],l=q.low[i],c=q.close[i],v=q.volume[i]; if(o==null||c==null)continue; const jst=new Date(ts[i]*1000+9*3600*1000); const day=`${jst.getUTCFullYear()}-${String(jst.getUTCMonth()+1).padStart(2,"0")}-${String(jst.getUTCDate()).padStart(2,"0")}`; const hh=jst.getUTCHours(),mm=jst.getUTCMinutes(); const arr=byDay.get(day)??[]; arr.push({time:`${String(hh).padStart(2,"0")}:${String(mm).padStart(2,"0")}`,hour:hh,open:o,high:h??o,low:l??o,close:c,volume:v??0,ma5:null,ma25:null,rsi:null,bbUpper:null,bbLower:null,flow:null,slope:null}); byDay.set(day,arr); }
  return byDay;
}
function enrich5m(bars: DCandle[]) {
  const closes=bars.map(b=>b.close); const ma5=calcMA(closes,MA_FAST),ma25=calcMA(closes,MA_SLOW),rsi=calcRSI(closes,RSI_PERIOD),bb=calcBB(closes,BB_PERIOD,2);
  bars.forEach((c,i)=>{c.ma5=ma5[i];c.ma25=ma25[i];c.rsi=rsi[i];c.bbUpper=bb.upper[i];c.bbLower=bb.lower[i];});
  const signed=bars.map(c=>{const r=(c.high-c.low)||1;const clv=((c.close-c.low)-(c.high-c.close))/r;return clv*c.volume;});
  bars.forEach((c,i)=>{ if(i>=D_FLOW_LOOKBACK-1){let s=0;for(let k=i-D_FLOW_LOOKBACK+1;k<=i;k++)s+=signed[k];c.flow=s;} if(i>=D_SLOPE_LOOKBACK&&c.ma25!=null){const pm=bars[i-D_SLOPE_LOOKBACK].ma25;if(pm!=null&&pm!==0)c.slope=(c.ma25-pm)/pm;} });
}
interface DTrade { time:string;type:"buy"|"sell"|"short"|"cover";price:number;profit?:number; }
function simulate5m(symbol: string, bars: DCandle[], mktBias: number): DTrade[] {
  const trades: DTrade[]=[];
  let longShares=0,longEntry=0,longHigh=0,shortShares=0,shortEntry=0,shortLow=0,realized=0,tradeCount=0,halted=false;
  const lot=HIGH_VOL_SYMBOLS.has(symbol)?LOT_SMALL:LOT_NORMAL; const capital=INITIAL_CAPITAL*lot;
  const dayOpen=bars[0]?.open??0,dayHigh=Math.max(...bars.map(b=>b.high)),dayLow=Math.min(...bars.map(b=>b.low));
  const dayRange=dayOpen>0?(dayHigh-dayLow)/dayOpen:0; const isHighVolDay=dayRange>=HIGH_VOL_DAY_THRESHOLD;
  const mktUp=mktBias>MARKET_REGIME_THRESHOLD,mktDown=mktBias<-MARKET_REGIME_THRESHOLD;
  for(let i=1;i<bars.length;i++){
    const curr=bars[i],prev=bars[i-1];
    if(curr.rsi==null||curr.ma5==null||curr.ma25==null||curr.bbLower==null||curr.bbUpper==null||prev.ma5==null||prev.ma25==null)continue;
    const slope=curr.slope??0,flow=curr.flow??0;
    const trendUp=slope>SLOPE_THRESHOLD,trendDown=slope<-SLOPE_THRESHOLD,flowUp=flow>0,flowDown=flow<0;
    const inWarmup=i<WARMUP_BARS,suppressByHour=SUPPRESS_ENTRY_HOURS.has(curr.hour);
    const allowLong=trendUp&&flowUp&&!mktDown&&!inWarmup&&!halted&&!suppressByHour;
    const allowShort=trendDown&&flowDown&&!mktUp&&!inWarmup&&!halted&&!isHighVolDay&&!suppressByHour;
    const isGC=prev.ma5<=prev.ma25&&curr.ma5>curr.ma25;
    const isBbLower=curr.close<=curr.bbLower,isBbUpper=curr.close>=curr.bbUpper;
    const isRsiOversold=curr.rsi<=30,isRsiOverbought=curr.rsi>=70;
    if(longShares>0){ if(curr.close>longHigh)longHigh=curr.close; const gain=(curr.close-longEntry)/longEntry; let stopLine=longEntry*(1-STOP_LOSS); if(gain>BREAKEVEN_TRIGGER)stopLine=Math.max(stopLine,longEntry); let exit=false; if(curr.close<=stopLine)exit=true; else if(gain>TRAIL_TRIGGER&&curr.close<=longHigh*(1-TRAIL_GAP))exit=true; else if(isGC===false&&(isRsiOverbought&&isBbUpper))exit=true; if(exit){const profit=(curr.close-longEntry)*longShares;realized+=profit;tradeCount++;if(realized<=-CIRCUIT_BREAKER)halted=true;trades.push({time:curr.time,type:"sell",price:curr.close,profit});longShares=0;} }
    if(shortShares>0){ if(curr.close<shortLow)shortLow=curr.close; const gain=(shortEntry-curr.close)/shortEntry; let stopLine=shortEntry*(1+STOP_LOSS); if(gain>BREAKEVEN_TRIGGER)stopLine=Math.min(stopLine,shortEntry); let exit=false; if(curr.close>=stopLine)exit=true; else if(gain>TRAIL_TRIGGER&&curr.close>=shortLow*(1+TRAIL_GAP))exit=true; else if(isGC||(isRsiOversold&&isBbLower))exit=true; if(exit){const profit=(shortEntry-curr.close)*shortShares;realized+=profit;tradeCount++;if(realized<=-CIRCUIT_BREAKER)halted=true;trades.push({time:curr.time,type:"cover",price:curr.close,profit});shortShares=0;} }
    const nearMA=curr.ma25>0&&Math.abs(curr.close-curr.ma25)/curr.ma25<=PULLBACK_NEAR_MA;
    const isPullbackBuy=slope>SLOPE_THRESHOLD&&curr.rsi<=PULLBACK_RSI&&nearMA&&curr.close>=curr.ma25;
    if(longShares===0&&shortShares===0&&allowLong&&tradeCount<MAX_TRADES_PER_DAY&&(isGC||isPullbackBuy||(isRsiOversold&&isBbLower))){ const shares=Math.floor(capital/curr.close); if(shares>0){longShares=shares;longEntry=curr.close;longHigh=curr.close;trades.push({time:curr.time,type:"buy",price:curr.close});} }
    const nearMAShort=curr.ma25>0&&Math.abs(curr.close-curr.ma25)/curr.ma25<=SHORT_NEAR_MA;
    const isPullbackShort=trendDown&&curr.rsi>=SHORT_RSI_MIN&&nearMAShort&&curr.close<=curr.ma25;
    const isStrongDownForShort=curr.ma5<curr.ma25&&curr.close<curr.ma25;
    const isBreakdownShort=mktDown&&trendDown&&isStrongDownForShort&&flowDown&&curr.rsi>SHORT_BREAKDOWN_RSI_MIN&&curr.rsi<70;
    if(longShares===0&&shortShares===0&&allowShort&&tradeCount<MAX_TRADES_PER_DAY&&(isPullbackShort||isBreakdownShort||(isRsiOverbought&&isBbUpper))){ const shares=Math.floor(capital/curr.close); if(shares>0){shortShares=shares;shortEntry=curr.close;shortLow=curr.close;trades.push({time:curr.time,type:"short",price:curr.close});} }
  }
  const last=bars[bars.length-1];
  if(longShares>0){const profit=(last.close-longEntry)*longShares;trades.push({time:last.time,type:"sell",price:last.close,profit});}
  if(shortShares>0){const profit=(shortEntry-last.close)*shortShares;trades.push({time:last.time,type:"cover",price:last.close,profit});}
  return trades;
}

type DayPerStock = { day: string; perStock: PerStockTrades[] };

async function buildUpMarketDays(): Promise<DayPerStock[]> {
  const byTicker=new Map<string,Map<string,RawBar[]>>();
  for(const s of TARGET_STOCKS){ try{byTicker.set(s.symbol,await fetch1mByDay(s.ticker));}catch{} await new Promise(r=>setTimeout(r,250)); }
  const dayCount=new Map<string,number>();
  for(const byDay of byTicker.values())for(const d of byDay.keys())dayCount.set(d,(dayCount.get(d)??0)+1);
  const allDays=Array.from(dayCount.keys()).sort();
  const out: DayPerStock[]=[];
  for(const day of allDays){
    const candleMap=new Map<string,RealCandle[]>();
    for(const s of TARGET_STOCKS){ const bars=byTicker.get(s.symbol)?.get(day); if(!bars||bars.length<60)continue; candleMap.set(s.symbol,toCandles1m(bars)); }
    if(candleMap.size<5)continue;
    const symbols=Array.from(candleMap.keys());
    const ratioSeries=symbols.map(sym=>{const cs=candleMap.get(sym)!;const open=cs[0]?.open??0;return cs.map(c=>(open>0?(c.close-open)/open:0));});
    const marketBiasByProgress=(p:number):number=>{let sum=0,cnt=0;for(const series of ratioSeries){if(!series.length)continue;const idx=Math.min(series.length-1,Math.max(0,Math.round(p*(series.length-1))));sum+=series[idx];cnt++;}return cnt>0?sum/cnt:0;};
    const dayStats=symbols.map(sym=>{const cs=candleMap.get(sym)!;return{open:cs[0]?.open??0,high:Math.max(...cs.map(c=>c.high)),low:Math.min(...cs.map(c=>c.low)),close:cs[cs.length-1]?.close??0};});
    const rangeBound=isRangeBoundDay(computeMarketEfficiency(dayStats));
    const perStock: PerStockTrades[]=[];
    for(const s of TARGET_STOCKS){ const candles=candleMap.get(s.symbol); if(!candles)continue; const res=simulateStockReal(s.symbol,s.ticker,s.name,candles,marketBiasByProgress,3_000_000,70,30,2.0,rangeBound); if(!res)continue; perStock.push({symbol:s.symbol,trades:res.trades}); }
    out.push({day,perStock});
  }
  return out;
}

async function buildDownMarketDays(): Promise<DayPerStock[]> {
  const TARGET_DAYS=["2026-05-14","2026-05-15","2026-05-19","2026-05-27"];
  const byTicker=new Map<string,Map<string,DCandle[]>>();
  for(const s of TARGET_STOCKS){ try{byTicker.set(s.symbol,await fetch5mByDay(s.ticker));}catch{} await new Promise(r=>setTimeout(r,250)); }
  const out: DayPerStock[]=[];
  for(const day of TARGET_DAYS){
    let biasSum=0,cnt=0;
    for(const s of TARGET_STOCKS){ const bars=byTicker.get(s.symbol)?.get(day); if(!bars||bars.length<20)continue; const chg=bars[0].open>0?(bars[bars.length-1].close-bars[0].open)/bars[0].open:0; biasSum+=chg;cnt++; }
    const mktBias=cnt>0?biasSum/cnt:0;
    const perStock: PerStockTrades[]=[];
    for(const s of TARGET_STOCKS){ const bars=byTicker.get(s.symbol)?.get(day); if(!bars||bars.length<20)continue; enrich5m(bars); const trades=simulate5m(s.symbol,bars,mktBias); perStock.push({symbol:s.symbol,trades:trades.map(t=>({time:t.time,type:t.type,price:t.price,shares:0,totalAmount:0,profit:t.profit}))} as PerStockTrades); }
    out.push({day,perStock});
  }
  return out;
}

function evalConfig(days: DayPerStock[], cfg: PortfolioConfig){
  let total=0,worst=Infinity,stops=0,wins=0,losses=0,maxConc=0;
  for(const d of days){ const pf=applyPortfolioRules(d.perStock,cfg); total+=pf.acceptedProfit; worst=Math.min(worst,pf.acceptedProfit); wins+=pf.acceptedWins; losses+=pf.acceptedLosses; if(pf.dailyStopTriggered)stops++; maxConc=Math.max(maxConc,pf.maxConcurrentObserved); }
  const winRate = (wins+losses)>0 ? wins/(wins+losses) : 0;
  return { total, avg: days.length?total/days.length:0, worst, stops, wins, losses, winRate, maxConc };
}

async function main(){
  console.log("[sweep] 上昇相場(1分足5日)のイベント生成...");
  const upDays=await buildUpMarketDays();
  console.log(`[sweep] 上昇相場 ${upDays.length}日 (${upDays.map(d=>d.day).join(", ")})`);
  console.log("[sweep] 下落相場(5分足4日)のイベント生成...");
  const downDays=await buildDownMarketDays();
  console.log(`[sweep] 下落相場 ${downDays.length}日 (${downDays.map(d=>d.day).join(", ")})`);

  const concurrents=[3,4,5,6];
  const sectors=[2,3];

  console.log("\n===== 同時保有枠 × 同業種上限 スイープ（上昇 vs 下落）=====");
  console.log("maxConc\tperSec\t|UP合計\tUP平均\tUP勝率\tUP最大同時\t|DOWN合計\tDOWN平均\tDOWN最悪\tDOWN勝率\t|総合計");
  const rows: Array<{mc:number;ps:number;up:ReturnType<typeof evalConfig>;down:ReturnType<typeof evalConfig>;combined:number}>=[];
  for(const mc of concurrents){
    for(const ps of sectors){
      const cfg={...DEFAULT_PORTFOLIO_CONFIG,maxConcurrent:mc,maxPerSector:ps};
      const up=evalConfig(upDays,cfg); const down=evalConfig(downDays,cfg);
      const combined=up.total+down.total;
      rows.push({mc,ps,up,down,combined});
      console.log(`${mc}\t${ps}\t|${Math.round(up.total)}\t${Math.round(up.avg)}\t${(up.winRate*100).toFixed(0)}%\t${up.maxConc}\t|${Math.round(down.total)}\t${Math.round(down.avg)}\t${Math.round(down.worst)}\t${(down.winRate*100).toFixed(0)}%\t|${Math.round(combined)}`);
    }
  }

  const baseline=rows.find(r=>r.mc===3&&r.ps===2)!;
  console.log(`\n[基準] maxConc=3/perSec=2: UP合計=${Math.round(baseline.up.total)} UP勝率=${(baseline.up.winRate*100).toFixed(0)}% / DOWN合計=${Math.round(baseline.down.total)} DOWN最悪=${Math.round(baseline.down.worst)}`);
  // 総合計が最大のものを推奨。ただしUP勝率が基準から5pt以上落ちないこと。
  const candidates=rows.filter(r=>r.up.winRate>=baseline.up.winRate-0.05);
  candidates.sort((a,b)=> b.combined - a.combined);
  const best=candidates[0];
  console.log(`\n[総合最良] maxConc=${best.mc}/perSec=${best.ps}: UP合計=${Math.round(best.up.total)}(基準比${((best.up.total/baseline.up.total)*100).toFixed(0)}%) UP勝率=${(best.up.winRate*100).toFixed(0)}% / DOWN合計=${Math.round(best.down.total)} DOWN最悪=${Math.round(best.down.worst)} / 総合計=${Math.round(best.combined)}(基準比${((best.combined/baseline.combined)*100).toFixed(0)}%)`);
}
main().catch(e=>{console.error(e);process.exit(1);});
