import { getDb } from "../server/db";
import { sql } from "drizzle-orm";

// 案A+B前場のみ実装後のTP最適値を方式別に検証
// 前場ブースト/出来高ブレイクは「静かな上昇」より値幅が大きい可能性

const SL_MAP: Record<string, number> = { "8035":0.5,"6857":0.6,"6976":0.6,"6526":0.9,"5803":0.5,"6981":0.4,"285A":0.8,"6146":0.8,"6594":0.5,"8316":0.5 };
const LOTS: Record<string, number> = { "8035":100,"6857":100,"285A":100,"6146":100,"6976":200,"6981":300,"8316":400,"5803":400,"6526":1400,"6594":1000 };
const SYMBOLS = ["8035","6857","6976","6526","5803","6981","285A","6146","6594","8316"];

async function main() {
  const db = await getDb();
  const [dates] = await db.execute(sql`SELECT DISTINCT tradeDate FROM rt_candles WHERE symbol='8035' ORDER BY tradeDate DESC LIMIT 31`);
  const tradeDates = (dates as any[]).map(d => d.tradeDate).reverse();
  const simDates = tradeDates.slice(1);
  console.log(`対象: ${simDates[0]}〜${simDates[simDates.length-1]}（${simDates.length}営業日）\n`);
  
  const allData: Record<string, Record<string, any[]>> = {};
  for (const sym of SYMBOLS) {
    const [rows] = await db.execute(sql`SELECT tradeDate, candleTime, open, high, low, close, volume FROM rt_candles WHERE symbol=${sym} AND tradeDate>=${tradeDates[0]} ORDER BY tradeDate, candleTime`);
    allData[sym] = {};
    for (const r of rows as any[]) {
      if (!allData[sym][r.tradeDate]) allData[sym][r.tradeDate] = [];
      allData[sym][r.tradeDate].push({...r, open:+r.open, high:+r.high, low:+r.low, close:+r.close, volume:+r.volume});
    }
  }
  
  const tpValues = [0.3, 0.5, 0.6, 0.8, 1.0, 1.2, 1.5];
  
  for (const tp of tpValues) {
    let trades: any[] = [];
    for (const sym of SYMBOLS) {
      let buffer: any[] = allData[sym][tradeDates[0]] || [];
      for (const date of simDates) {
        const dayCandles = allData[sym][date] || [];
        if (dayCandles.length < 10) continue;
        let position: any = null;
        let slAfterTime: number | null = null;
        for (let i = 0; i < dayCandles.length; i++) {
          const c = dayCandles[i]; buffer.push(c); if (buffer.length > 300) buffer = buffer.slice(-300);
          const [h, m] = c.candleTime.split(":").map(Number); const timeMin = h*60+m;
          if (position) {
            if (timeMin >= 687 && timeMin < 750) { trades.push({...position, pnl: Math.round((c.close-position.price)*position.lots), exit:"前場"}); position=null; continue; }
            if (timeMin >= 925) { trades.push({...position, pnl: Math.round((c.close-position.price)*position.lots), exit:"大引け"}); position=null; continue; }
            const slP = position.price*(1-(SL_MAP[sym]||0.5)/100); const tpP = position.price*(1+tp/100);
            if (c.low<=slP) { trades.push({...position, pnl: Math.round((slP-position.price)*position.lots), exit:"SL"}); slAfterTime=timeMin; position=null; continue; }
            if (c.high>=tpP) { trades.push({...position, pnl: Math.round((tpP-position.price)*position.lots), exit:"TP"}); position=null; continue; }
            continue;
          }
          if (timeMin<570||timeMin>=905||position) continue;
          if (timeMin>=750&&timeMin<770) continue;
          if (slAfterTime && timeMin-slAfterTime<30) continue;
          if (buffer.length < 9) continue;
          const ma = buffer.slice(-8).reduce((s:number,b:any)=>s+b.close,0)/8;
          const prevMa = buffer.slice(-9,-1).reduce((s:number,b:any)=>s+b.close,0)/8;
          const isBullish = ((ma-prevMa)/prevMa*100) > 0;
          if (!isBullish) continue;
          if (buffer.length < 21) continue;
          const maxHigh = Math.max(...buffer.slice(-21,-1).map((b:any)=>b.high));
          if (c.close <= maxHigh) continue;
          let isRoundBreak = false;
          if (i > 0) { const prev = buffer[buffer.length-2]; for (const rl of [100,500,1000,5000,10000]) { const near = Math.ceil(c.close/rl)*rl; if (prev.close < near && c.close >= near) { isRoundBreak = true; break; } } }
          if (isRoundBreak) continue;
          const maDeviation = Math.abs((c.close - ma) / ma * 100);
          const barBody = Math.abs((c.close - c.open) / c.open * 100);
          const bearBars = buffer.slice(-10).filter((b:any)=>b.close<b.open).length;
          const vol20 = buffer.length >= 21 ? buffer.slice(-21,-1).reduce((s:number,b:any)=>s+b.volume,0)/20 : 0;
          const volRatio = vol20 > 0 ? c.volume / vol20 : 0;
          const inAM = timeMin <= 690;
          let canEntry = false;
          let method = "バイパス";
          // 案A+B前場のみ
          if (inAM && maDeviation < 1.0 && barBody < 0.5 && bearBars <= 5) { canEntry = true; method = "ブースト"; }
          if (inAM && volRatio >= 1.5) { canEntry = true; method = "出来高ブレイク"; }
          if (maDeviation < 0.5 && barBody < 0.2 && bearBars <= 4) { canEntry = true; method = "バイパス"; }
          if (canEntry) {
            position = { sym, date, time: c.candleTime, price: c.close, lots: LOTS[sym]||100, timeSlot: inAM?"前場":"後場", method };
          }
        }
        if (position) { const last=dayCandles[dayCandles.length-1]; trades.push({...position, pnl: Math.round((last.close-position.price)*position.lots), exit:"EOD"}); position=null; }
        buffer = dayCandles.slice(-100);
      }
    }
    
    const wins = trades.filter(t=>t.pnl>0);
    const totalPnl = trades.reduce((s,t)=>s+t.pnl,0);
    const grossWin = wins.reduce((s,t)=>s+t.pnl,0);
    const grossLoss = Math.abs(trades.filter(t=>t.pnl<=0).reduce((s,t)=>s+t.pnl,0));
    const pf = grossLoss > 0 ? (grossWin/grossLoss).toFixed(2) : "∞";
    const tpCount = trades.filter(t=>t.exit==="TP").length;
    const slCount = trades.filter(t=>t.exit==="SL").length;
    
    console.log(`TP${tp.toFixed(1)}%: ${trades.length}件 ${wins.length}勝${trades.length-wins.length}敗 勝率${(wins.length/trades.length*100).toFixed(1)}% ${totalPnl.toLocaleString()}円 PF${pf} | TP到達${tpCount}件(${(tpCount/trades.length*100).toFixed(0)}%) SL到達${slCount}件(${(slCount/trades.length*100).toFixed(0)}%)`);
    
    // 方式別
    for (const m of ["ブースト","出来高ブレイク","バイパス"]) {
      const mt = trades.filter(t=>t.method===m);
      if (mt.length === 0) continue;
      const mw = mt.filter(t=>t.pnl>0);
      const mp = mt.reduce((s,t)=>s+t.pnl,0);
      const mtp = mt.filter(t=>t.exit==="TP").length;
      const msl = mt.filter(t=>t.exit==="SL").length;
      console.log(`  ${m}: ${mt.length}件 勝率${(mw.length/mt.length*100).toFixed(1)}% ${mp.toLocaleString()}円 TP到達${mtp}件(${(mtp/mt.length*100).toFixed(0)}%) SL到達${msl}件(${(msl/mt.length*100).toFixed(0)}%)`);
    }
  }
  
  process.exit(0);
}
main();
