import { callDataApi } from "../server/_core/dataApi";
const fmtFull = (s:number)=>{ const d=new Date(s*1000+9*3600*1000); return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}-${String(d.getUTCDate()).padStart(2,"0")} ${String(d.getUTCHours()).padStart(2,"0")}:${String(d.getUTCMinutes()).padStart(2,"0")}`; };
async function probe(range:string){
  const r = await callDataApi("YahooFinance/get_stock_chart",{query:{symbol:"7203.T",region:"JP",interval:"1m",range}}) as any;
  const res = r?.chart?.result?.[0];
  const meta = res?.meta;
  const ts = res?.timestamp ?? [];
  const q = res?.indicators?.quote?.[0];
  let validCount=0, firstV=null, lastV=null;
  for(let i=0;i<ts.length;i++){ if(q?.close?.[i]!=null){ validCount++; if(firstV==null)firstV=ts[i]; lastV=ts[i]; } }
  console.log(`\n=== range=${range} ===`);
  console.log("meta.regularMarketTime:", meta?.regularMarketTime?fmtFull(meta.regularMarketTime):"-");
  console.log("meta.regularMarketPrice:", meta?.regularMarketPrice);
  console.log("総ts:", ts.length, "有効close:", validCount);
  if(firstV) console.log("最初:", fmtFull(firstV), " 最後:", fmtFull(lastV!));
}
async function main(){ await probe("1d"); await probe("5d"); console.log("\n現在JST:", fmtFull(Math.floor(Date.now()/1000))); }
main().catch(e=>{console.error(e);process.exit(1);});
