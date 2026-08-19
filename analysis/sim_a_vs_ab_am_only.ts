import { getDb } from "../server/db";
import { sql } from "drizzle-orm";

// 案A単体（前場ブースト09:30-11:30）vs 案A+B前場のみ（ブースト+出来高ブレイク前場限定）
// 30営業日

const SL_MAP: Record<string, number> = { "8035":0.5,"6857":0.6,"6976":0.6,"6526":0.9,"5803":0.5,"6981":0.4,"285A":0.8,"6146":0.8,"6594":0.5,"8316":0.5 };
const LOTS: Record<string, number> = { "8035":100,"6857":100,"285A":100,"6146":100,"6976":200,"6981":300,"8316":400,"5803":400,"6526":1400,"6594":1000 };
const SYMBOLS = ["8035","6857","6976","6526","5803","6981","285A","6146","6594","8316"];
const TP_LONG = 0.5;

async function runSim(mode: "current" | "a_only" | "ab_am") {
  const db = await getDb();
  const [dates] = await db.execute(sql`SELECT DISTINCT tradeDate FROM rt_candles WHERE symbol='8035' ORDER BY tradeDate DESC LIMIT 31`);
  const tradeDates = (dates as any[]).map(d => d.tradeDate).reverse();
  const simDates = tradeDates.slice(1);
  
  const allData: Record<string, Record<string, any[]>> = {};
  for (const sym of SYMBOLS) {
    const [rows] = await db.execute(sql`SELECT tradeDate, candleTime, open, high, low, close, volume FROM rt_candles WHERE symbol=${sym} AND tradeDate>=${tradeDates[0]} ORDER BY tradeDate, candleTime`);
    allData[sym] = {};
    for (const r of rows as any[]) {
      if (!allData[sym][r.tradeDate]) allData[sym][r.tradeDate] = [];
      allData[sym][r.tradeDate].push({...r, open:+r.open, high:+r.high, low:+r.low, close:+r.close, volume:+r.volume});
    }
  }
  
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
          const slP = position.price*(1-(SL_MAP[sym]||0.5)/100); const tpP = position.price*(1+TP_LONG/100);
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
        
        const inAM = timeMin <= 690; // 前場（〜11:30）
        let canEntry = false;
        let method = "バイパス";
        
        if (mode === "a_only") {
          // 案A単体: 前場ブースト + 後場は現行
          if (inAM && maDeviation < 1.0 && barBody < 0.5 && bearBars <= 5) { canEntry = true; method = "ブースト"; }
          if (maDeviation < 0.5 && barBody < 0.2 && bearBars <= 4) { canEntry = true; method = "バイパス"; }
        } else if (mode === "ab_am") {
          // 案A+B前場のみ: 前場ブースト + 前場出来高ブレイク + 後場は現行
          if (inAM && maDeviation < 1.0 && barBody < 0.5 && bearBars <= 5) { canEntry = true; method = "ブースト"; }
          if (inAM && volRatio >= 1.5) { canEntry = true; method = "出来高ブレイク"; }
          if (maDeviation < 0.5 && barBody < 0.2 && bearBars <= 4) { canEntry = true; method = "バイパス"; }
        } else {
          // 現行
          if (maDeviation < 0.5 && barBody < 0.2 && bearBars <= 4) { canEntry = true; method = "バイパス"; }
        }
        
        if (canEntry) {
          position = { sym, date, time: c.candleTime, price: c.close, lots: LOTS[sym]||100, timeSlot: inAM?"前場":"後場", method };
        }
      }
      if (position) { const last=dayCandles[dayCandles.length-1]; trades.push({...position, pnl: Math.round((last.close-position.price)*position.lots), exit:"EOD"}); position=null; }
      buffer = dayCandles.slice(-100);
    }
  }
  return { trades, simDates };
}

async function main() {
  for (const mode of ["current", "a_only", "ab_am"] as const) {
    const label = mode === "current" ? "現行（静かな上昇バイパスのみ）" 
      : mode === "a_only" ? "案A単体（前場ブースト09:30-11:30）"
      : "案A+B前場のみ（ブースト + 出来高ブレイク前場限定）";
    const { trades, simDates } = await runSim(mode);
    
    const wins = trades.filter(t=>t.pnl>0);
    const am = trades.filter(t=>t.timeSlot==="前場");
    const pm = trades.filter(t=>t.timeSlot==="後場");
    const totalPnl = trades.reduce((s,t)=>s+t.pnl,0);
    const grossWin = wins.reduce((s,t)=>s+t.pnl,0);
    const grossLoss = Math.abs(trades.filter(t=>t.pnl<=0).reduce((s,t)=>s+t.pnl,0));
    const pf = grossLoss > 0 ? (grossWin/grossLoss).toFixed(2) : "∞";
    
    console.log(`\n=== ${label} ===`);
    console.log(`期間: ${simDates[0]}〜${simDates[simDates.length-1]}（${simDates.length}営業日）`);
    console.log(`全体: ${trades.length}件 ${wins.length}勝${trades.length-wins.length}敗 勝率${(wins.length/trades.length*100).toFixed(1)}% ${totalPnl.toLocaleString()}円 PF${pf}`);
    console.log(`前場: ${am.length}件 ${am.filter(t=>t.pnl>0).length}勝${am.filter(t=>t.pnl<=0).length}敗 ${am.reduce((s:number,t:any)=>s+t.pnl,0).toLocaleString()}円`);
    console.log(`後場: ${pm.length}件 ${pm.filter(t=>t.pnl>0).length}勝${pm.filter(t=>t.pnl<=0).length}敗 ${pm.reduce((s:number,t:any)=>s+t.pnl,0).toLocaleString()}円`);
    console.log(`1日平均: ${Math.round(totalPnl/simDates.length).toLocaleString()}円/日`);
    
    // 方式別（案A+Bのみ）
    if (mode !== "current") {
      console.log(`\n方式別:`);
      for (const m of ["ブースト","出来高ブレイク","バイパス"]) {
        const mt = trades.filter(t=>t.method===m);
        if (mt.length) console.log(`  ${m}: ${mt.length}件 ${mt.filter(t=>t.pnl>0).length}勝${mt.filter(t=>t.pnl<=0).length}敗 ${mt.reduce((s,t)=>s+t.pnl,0).toLocaleString()}円 勝率${(mt.filter(t=>t.pnl>0).length/mt.length*100).toFixed(1)}%`);
      }
    }
    
    // 日別
    console.log(`\n日別:`);
    let plusDays = 0, minusDays = 0;
    for (const d of simDates) {
      const dt = trades.filter(t=>t.date===d);
      if (dt.length === 0) continue;
      const dp = dt.reduce((s,t)=>s+t.pnl,0);
      if (dp > 0) plusDays++; else minusDays++;
      console.log(`  ${d}: ${dt.length}件 ${dp>=0?"+":""}${dp.toLocaleString()}円`);
    }
    console.log(`  プラス日: ${plusDays}日 / マイナス日: ${minusDays}日`);
  }
  
  process.exit(0);
}
main();
