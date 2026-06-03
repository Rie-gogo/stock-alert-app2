/**
 * lotAllocationBacktest.ts
 * 【動的資金配分(B)】の効果検証。
 *
 * 各営業日について「その日より前の実績(平均損益・勝率)」から銘柄ごとのロット倍率(0.5〜1.5)を
 * computeLotMultiplier で算出し、その倍率でシミュレーションした結果(配分ON)と、
 * 全て1.0倍(配分OFF)の結果を、上昇相場(直近1分足5日)で比較する。
 *
 * ※ 倍率は「前日までの実績」のみで決めるため後知恵にならない（walk-forward）。
 *
 * 実行: cd /home/ubuntu/stock-alert-app && npx tsx analysis/lotAllocationBacktest.ts
 */
import { callDataApi } from "../server/_core/dataApi";
import { TARGET_STOCKS } from "../shared/stocks";
import {
  applyPortfolioRules,
  DEFAULT_PORTFOLIO_CONFIG,
  computeLotMultiplier,
  type PerStockTrades,
  type SymbolHistoryInput,
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

// 当日の銘柄別実績を履歴に積算するためのレコード
interface DayResult { symbol: string; name: string; profit: number; win: number; loss: number; }

async function main(){
  console.log("[lot] 上昇相場(1分足5日)を取得...");
  const byTicker=new Map<string,Map<string,RawBar[]>>();
  for(const s of TARGET_STOCKS){ try{byTicker.set(s.symbol,await fetch1mByDay(s.ticker));}catch{} await new Promise(r=>setTimeout(r,250)); }
  const dayCount=new Map<string,number>();
  for(const byDay of byTicker.values())for(const d of byDay.keys())dayCount.set(d,(dayCount.get(d)??0)+1);
  const allDays=Array.from(dayCount.keys()).sort();
  console.log(`[lot] 対象日: ${allDays.join(", ")}`);

  // walk-forward の履歴（その日より前の実績を蓄積）
  const history=new Map<string,{name:string;totalProfit:number;totalWin:number;totalLoss:number;appearances:number}>();

  let totOff=0,totOn=0;
  const perDay: Array<{day:string;off:number;on:number;mults:string}>=[];

  for(const day of allDays){
    // 当日の市場環境を準備
    const candleMap=new Map<string,RealCandle[]>();
    for(const s of TARGET_STOCKS){ const bars=byTicker.get(s.symbol)?.get(day); if(!bars||bars.length<60)continue; candleMap.set(s.symbol,toCandles1m(bars)); }
    if(candleMap.size<5){ continue; }
    const symbols=Array.from(candleMap.keys());
    const ratioSeries=symbols.map(sym=>{const cs=candleMap.get(sym)!;const open=cs[0]?.open??0;return cs.map(c=>(open>0?(c.close-open)/open:0));});
    const marketBiasByProgress=(p:number):number=>{let sum=0,cnt=0;for(const series of ratioSeries){if(!series.length)continue;const idx=Math.min(series.length-1,Math.max(0,Math.round(p*(series.length-1))));sum+=series[idx];cnt++;}return cnt>0?sum/cnt:0;};
    const dayStats=symbols.map(sym=>{const cs=candleMap.get(sym)!;return{open:cs[0]?.open??0,high:Math.max(...cs.map(c=>c.high)),low:Math.min(...cs.map(c=>c.low)),close:cs[cs.length-1]?.close??0};});
    const rangeBound=isRangeBoundDay(computeMarketEfficiency(dayStats));

    // ロット倍率（前日までの履歴から算出）
    const multBySymbol=new Map<string,number>();
    const multLog: string[]=[];
    for(const s of TARGET_STOCKS){
      const h=history.get(s.symbol);
      const hist: SymbolHistoryInput = h
        ? { symbol:s.symbol, name:s.name, appearances:h.appearances, totalProfit:h.totalProfit, totalWin:h.totalWin, totalLoss:h.totalLoss, avgWinRate:(h.totalWin+h.totalLoss)>0?h.totalWin/(h.totalWin+h.totalLoss):0 }
        : { symbol:s.symbol, name:s.name, appearances:0, totalProfit:0, totalWin:0, totalLoss:0, avgWinRate:0 };
      const m=computeLotMultiplier(hist);
      multBySymbol.set(s.symbol,m);
      if(Math.abs(m-1.0)>0.001) multLog.push(`${s.symbol}:${m.toFixed(2)}`);
    }

    // 配分OFF（全1.0）と配分ON（倍率適用）でそれぞれシミュレーション
    const perStockOff: PerStockTrades[]=[]; const perStockOn: PerStockTrades[]=[];
    const todayResults: DayResult[]=[];
    for(const s of TARGET_STOCKS){
      const candles=candleMap.get(s.symbol); if(!candles)continue;
      const off=simulateStockReal(s.symbol,s.ticker,s.name,candles,marketBiasByProgress,3_000_000,70,30,2.0,rangeBound,1.0);
      const on=simulateStockReal(s.symbol,s.ticker,s.name,candles,marketBiasByProgress,3_000_000,70,30,2.0,rangeBound,multBySymbol.get(s.symbol)??1.0);
      if(off)perStockOff.push({symbol:s.symbol,trades:off.trades});
      if(on)perStockOn.push({symbol:s.symbol,trades:on.trades});
      // 履歴蓄積は「配分OFF（=素の実力）」の当日成績で更新する（倍率が倍率を生む暴走を防ぐ）
      if(off)todayResults.push({symbol:s.symbol,name:s.name,profit:off.profitAmount,win:off.winCount,loss:off.lossCount});
    }

    const pfOff=applyPortfolioRules(perStockOff,DEFAULT_PORTFOLIO_CONFIG);
    const pfOn=applyPortfolioRules(perStockOn,DEFAULT_PORTFOLIO_CONFIG);
    totOff+=pfOff.acceptedProfit; totOn+=pfOn.acceptedProfit;
    perDay.push({day,off:pfOff.acceptedProfit,on:pfOn.acceptedProfit,mults:multLog.join(" ")||"(全1.0)"});

    // 当日の実績を履歴へ反映（翌日の倍率に使う）
    for(const r of todayResults){ const h=history.get(r.symbol)??{name:r.name,totalProfit:0,totalWin:0,totalLoss:0,appearances:0}; h.totalProfit+=r.profit; h.totalWin+=r.win; h.totalLoss+=r.loss; h.appearances+=1; history.set(r.symbol,h); }
  }

  console.log("\n===== 動的資金配分(B) 効果: 配分OFF vs 配分ON（上昇相場・walk-forward）=====");
  console.log("day\t配分OFF\t配分ON\t差分\t適用倍率(≠1.0の銘柄)");
  for(const d of perDay){ console.log(`${d.day}\t${Math.round(d.off)}\t${Math.round(d.on)}\t${Math.round(d.on-d.off)}\t${d.mults}`); }
  console.log(`合計\t${Math.round(totOff)}\t${Math.round(totOn)}\t${Math.round(totOn-totOff)}`);
  console.log(`日平均\t${Math.round(totOff/perDay.length)}\t${Math.round(totOn/perDay.length)}\t${Math.round((totOn-totOff)/perDay.length)}`);
  console.log("\n注: 倍率は前日までの実績のみで決定(後知恵なし)。履歴は素の実力(配分OFF)で蓄積。");
}
main().catch(e=>{console.error(e);process.exit(1);});
