import "dotenv/config";
import fs from "fs";
const FORGE_URL = process.env.BUILT_IN_FORGE_API_URL;
const FORGE_KEY = process.env.BUILT_IN_FORGE_API_KEY;
async function call(apiId, options) {
  const b = FORGE_URL.endsWith("/")?FORGE_URL:`${FORGE_URL}/`;
  const u = new URL("webdevtoken.v1.WebDevService/CallApi", b).toString();
  const r = await fetch(u,{method:"POST",headers:{accept:"application/json","content-type":"application/json","connect-protocol-version":"1",authorization:`Bearer ${FORGE_KEY}`},body:JSON.stringify({apiId,...options})});
  return await r.json();
}
const out = JSON.parse(fs.readFileSync("/home/ubuntu/history_candles.json"));
for (let attempt=1; attempt<=3; attempt++) {
  try {
    const raw = await call("YahooFinance/get_stock_chart",{query:{symbol:"8035.T",region:"JP",interval:"2m",range:"1mo"}});
    const data = raw.jsonData?JSON.parse(raw.jsonData):(raw.data??raw);
    const result = data?.chart?.result?.[0];
    if (!result) { console.log(`attempt ${attempt}: no result`); await new Promise(r=>setTimeout(r,1500)); continue; }
    const ts=result.timestamp??[]; const q=result.indicators.quote[0];
    const byDay={};
    for (let i=0;i<ts.length;i++){
      if(q.open[i]==null||q.close[i]==null)continue;
      const jd=new Date(ts[i]*1000+9*3600*1000);
      const dayKey=jd.toISOString().slice(0,10);
      const time=`${String(jd.getUTCHours()).padStart(2,"0")}:${String(jd.getUTCMinutes()).padStart(2,"0")}`;
      if(!byDay[dayKey])byDay[dayKey]=[];
      byDay[dayKey].push({time,timestamp:ts[i]*1000,open:q.open[i],high:q.high[i]??q.open[i],low:q.low[i]??q.open[i],close:q.close[i],volume:q.volume[i]??0});
    }
    out["8035"]={name:"東京エレクトロン",byDay};
    const days=Object.keys(byDay).filter(d=>byDay[d].length>=30);
    console.log(`8035: ${ts.length} bars, ${days.length} valid days`);
    fs.writeFileSync("/home/ubuntu/history_candles.json",JSON.stringify(out));
    break;
  } catch(e){ console.log(`attempt ${attempt}: ERROR ${e.message}`); await new Promise(r=>setTimeout(r,1500)); }
}
