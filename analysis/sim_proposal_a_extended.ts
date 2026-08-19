import { getDb } from "../server/db";
import { sql } from "drizzle-orm";

// 案Aの時間帯を変えて比較: 09:30-10:00 vs 09:30-11:30 vs 前場全体(09:30-11:27)

const SL_MAP: Record<string, number> = { "8035":0.5,"6857":0.6,"6976":0.6,"6526":0.9,"5803":0.5,"6981":0.4,"285A":0.8,"6146":0.8,"6594":0.5,"8316":0.5 };
const LOTS: Record<string, number> = { "8035":100,"6857":100,"285A":100,"6146":100,"6976":200,"6981":300,"8316":400,"5803":400,"6526":1400,"6594":1000 };
const SYMBOLS = ["8035","6857","6976","6526","5803","6981","285A","6146","6594","8316"];
const TP_LONG = 0.5;

async function runSim(boostEndMin: number, label: string) {
  const db = await getDb();
  const [dates] = await db.execute(sql`SELECT DISTINCT tradeDate FROM rt_candles WHERE symbol='8035' ORDER BY tradeDate DESC LIMIT 21`);
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
        
        // 大台超えチェック
        let isRoundBreak = false;
        if (i > 0) { const prev = buffer[buffer.length-2]; for (const rl of [100,500,1000,5000,10000]) { const near = Math.ceil(c.close/rl)*rl; if (prev.close < near && c.close >= near) { isRoundBreak = true; break; } } }
        if (isRoundBreak) continue; // 大台超えLONG停止維持
        
        const maDeviation = Math.abs((c.close - ma) / ma * 100);
        const barBody = Math.abs((c.close - c.open) / c.open * 100);
        const bearBars = buffer.slice(-10).filter((b:any)=>b.close<b.open).length;
        
        let canEntry = false;
        const inBoost = timeMin <= boostEndMin;
        if (inBoost) {
          // ブースト時間帯: 緩和条件
          if (maDeviation < 1.0 && barBody < 0.5 && bearBars <= 5) canEntry = true;
        }
        // 通常時間帯: 現行バイパス条件
        if (maDeviation < 0.5 && barBody < 0.2 && bearBars <= 4) canEntry = true;
        
        if (canEntry) {
          position = { sym, date, time: c.candleTime, price: c.close, lots: LOTS[sym]||100, timeSlot: timeMin<690?"前場":"後場" };
        }
      }
      if (position) { const last=dayCandles[dayCandles.length-1]; trades.push({...position, pnl: Math.round((last.close-position.price)*position.lots), exit:"EOD"}); position=null; }
      buffer = dayCandles.slice(-100);
    }
  }
  
  const wins = trades.filter(t=>t.pnl>0);
  const am = trades.filter(t=>t.timeSlot==="前場");
  const pm = trades.filter(t=>t.timeSlot==="後場");
  const totalPnl = trades.reduce((s,t)=>s+t.pnl,0);
  const grossWin = wins.reduce((s,t)=>s+t.pnl,0);
  const grossLoss = Math.abs(trades.filter(t=>t.pnl<=0).reduce((s,t)=>s+t.pnl,0));
  const pf = grossLoss > 0 ? (grossWin/grossLoss).toFixed(2) : "∞";
  
  console.log(`\n=== ${label} ===`);
  console.log(`  全体: ${trades.length}件 ${wins.length}勝${trades.length-wins.length}敗 勝率${(wins.length/trades.length*100).toFixed(1)}% ${totalPnl.toLocaleString()}円 PF${pf}`);
  console.log(`  前場: ${am.length}件 ${am.filter(t=>t.pnl>0).length}勝${am.length-am.filter(t=>t.pnl>0).length}敗 ${am.reduce((s:number,t:any)=>s+t.pnl,0).toLocaleString()}円`);
  console.log(`  後場: ${pm.length}件 ${pm.filter(t=>t.pnl>0).length}勝${pm.length-pm.filter(t=>t.pnl>0).length}敗 ${pm.reduce((s:number,t:any)=>s+t.pnl,0).toLocaleString()}円`);
  console.log(`  1日平均: ${Math.round(totalPnl/simDates.length).toLocaleString()}円/日`);
  
  // 本日
  const today = trades.filter(t=>t.date==="2026-08-19");
  if (today.length > 0) {
    console.log(`  ★本日8/19: ${today.length}件 ${today.filter(t=>t.pnl>0).length}勝${today.filter(t=>t.pnl<=0).length}敗 ${today.reduce((s:number,t:any)=>s+t.pnl,0).toLocaleString()}円`);
  }
  
  // 日別
  console.log(`  日別:`);
  for (const d of simDates) {
    const dt = trades.filter(t=>t.date===d);
    if (dt.length === 0) continue;
    const dp = dt.reduce((s,t)=>s+t.pnl,0);
    console.log(`    ${d}: ${dt.length}件 ${dp>=0?"+":""}${dp.toLocaleString()}円`);
  }
}

async function main() {
  // 現行
  await runSim(0, "現行（ブーストなし）");
  // 案A: 09:30-10:00
  await runSim(600, "案A: ブースト 09:30〜10:00");
  // 案A拡大: 09:30-10:30
  await runSim(630, "案A拡大: ブースト 09:30〜10:30");
  // 案A拡大: 09:30-11:00
  await runSim(660, "案A拡大: ブースト 09:30〜11:00");
  // 案A拡大: 09:30-11:30
  await runSim(690, "案A拡大: ブースト 09:30〜11:30（前場全体）");
  
  process.exit(0);
}
main();
