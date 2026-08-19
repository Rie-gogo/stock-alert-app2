import { getDb } from "../server/db";
import { sql } from "drizzle-orm";

// ① MA4でのバイパスLONG成績
// ② 大台超えLONGでTP0.5%が狭すぎるか（TP別比較）
// ③ isBullish条件なしでの大台超えLONG
// ④ sell_pressure不在条件付きで大台超えLONG復活

const SL_MAP: Record<string, number> = { "8035":0.5,"6857":0.6,"6976":0.6,"6526":0.9,"5803":0.5,"6981":0.4,"285A":0.8,"6146":0.8,"6594":0.5,"8316":0.5 };
const LOTS: Record<string, number> = { "8035":100,"6857":100,"285A":100,"6146":100,"6976":200,"6981":300,"8316":400,"5803":400,"6526":1400,"6594":1000 };
const SYMBOLS = ["8035","6857","6976","6526","5803","6981","285A","6146","6594","8316"];

async function main() {
  const db = await getDb();
  const [dates] = await db.execute(sql`SELECT DISTINCT tradeDate FROM rt_candles WHERE symbol='8035' ORDER BY tradeDate DESC LIMIT 21`);
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
  
  // ===== ① MA4でのバイパスLONG =====
  console.log(`=== ① MA4でのバイパスLONG成績 ===`);
  for (const maPeriod of [4, 8]) {
    let trades: any[] = [];
    for (const sym of SYMBOLS) {
      let buffer: any[] = allData[sym][tradeDates[0]] || [];
      for (const date of simDates) {
        const dayCandles = allData[sym][date] || [];
        if (dayCandles.length < 10) continue;
        let position: any = null;
        for (let i = 0; i < dayCandles.length; i++) {
          const c = dayCandles[i]; buffer.push(c); if (buffer.length > 300) buffer = buffer.slice(-300);
          const [h, m] = c.candleTime.split(":").map(Number); const timeMin = h*60+m;
          if (position) {
            if (timeMin >= 687 && timeMin < 750) { trades.push({...position, pnl: Math.round((c.close-position.price)*position.lots)}); position=null; continue; }
            if (timeMin >= 925) { trades.push({...position, pnl: Math.round((c.close-position.price)*position.lots)}); position=null; continue; }
            const slP = position.price*(1-(SL_MAP[sym]||0.5)/100); const tpP = position.price*(1+0.5/100);
            if (c.low<=slP) { trades.push({...position, pnl: Math.round((slP-position.price)*position.lots)}); position=null; continue; }
            if (c.high>=tpP) { trades.push({...position, pnl: Math.round((tpP-position.price)*position.lots)}); position=null; continue; }
            continue;
          }
          if (timeMin<570||timeMin>=905||position) continue; if (timeMin>=750&&timeMin<770) continue;
          if (buffer.length < maPeriod+1) continue;
          const ma = buffer.slice(-maPeriod).reduce((s:number,b:any)=>s+b.close,0)/maPeriod;
          const prevMa = buffer.slice(-maPeriod-1,-1).reduce((s:number,b:any)=>s+b.close,0)/maPeriod;
          if (((ma-prevMa)/prevMa*100) <= 0) continue;
          if (buffer.length >= 21) {
            const maxH = Math.max(...buffer.slice(-21,-1).map((b:any)=>b.high));
            if (c.close > maxH) {
              const maDev = Math.abs((c.close-ma)/ma*100); const body = Math.abs((c.close-c.open)/c.open*100);
              const bears = buffer.slice(-10).filter((b:any)=>b.close<b.open).length;
              if (maDev<0.5 && body<0.2 && bears<=4) position = { sym, date, time: c.candleTime, price: c.close, lots: LOTS[sym]||100, timeSlot: timeMin<690?"前場":"後場" };
            }
          }
        }
        if (position) { const last=dayCandles[dayCandles.length-1]; trades.push({...position, pnl: Math.round((last.close-position.price)*position.lots)}); position=null; }
        buffer = dayCandles.slice(-100);
      }
    }
    const w=trades.filter(t=>t.pnl>0); const am=trades.filter(t=>t.timeSlot==="前場"); const pm=trades.filter(t=>t.timeSlot==="後場");
    console.log(`  MA${maPeriod}: ${trades.length}件 ${w.length}勝${trades.length-w.length}敗 勝率${(w.length/trades.length*100).toFixed(1)}% ${trades.reduce((s,t)=>s+t.pnl,0).toLocaleString()}円 (前場:${am.reduce((s:number,t:any)=>s+t.pnl,0).toLocaleString()}円 後場:${pm.reduce((s:number,t:any)=>s+t.pnl,0).toLocaleString()}円)`);
  }
  
  // ===== ② 大台超えLONGのTP別比較 =====
  console.log(`\n=== ② 大台超えLONGのTP別比較 ===`);
  for (const tpPct of [0.3, 0.5, 0.8, 1.0, 1.5]) {
    let trades: any[] = [];
    for (const sym of SYMBOLS) {
      let buffer: any[] = allData[sym][tradeDates[0]] || [];
      for (const date of simDates) {
        const dayCandles = allData[sym][date] || [];
        if (dayCandles.length < 10) continue;
        let position: any = null;
        for (let i = 0; i < dayCandles.length; i++) {
          const c = dayCandles[i]; buffer.push(c); if (buffer.length > 300) buffer = buffer.slice(-300);
          const [h, m] = c.candleTime.split(":").map(Number); const timeMin = h*60+m;
          if (position) {
            if (timeMin >= 687 && timeMin < 750) { trades.push({...position, pnl: Math.round((c.close-position.price)*position.lots)}); position=null; continue; }
            if (timeMin >= 925) { trades.push({...position, pnl: Math.round((c.close-position.price)*position.lots)}); position=null; continue; }
            const slP = position.price*(1-(SL_MAP[sym]||0.5)/100); const tpP = position.price*(1+tpPct/100);
            if (c.low<=slP) { trades.push({...position, pnl: Math.round((slP-position.price)*position.lots)}); position=null; continue; }
            if (c.high>=tpP) { trades.push({...position, pnl: Math.round((tpP-position.price)*position.lots)}); position=null; continue; }
            continue;
          }
          if (timeMin<570||timeMin>=905||position) continue; if (timeMin>=750&&timeMin<770) continue;
          if (i>0 && buffer.length>=2) {
            const prev = buffer[buffer.length-2];
            for (const rl of [100,500,1000,5000,10000]) {
              const near = Math.ceil(c.close/rl)*rl;
              if (prev.close < near && c.close >= near && (c.close-near)/near < 0.008) {
                position = { sym, date, time: c.candleTime, price: c.close, lots: LOTS[sym]||100 }; break;
              }
            }
          }
        }
        if (position) { const last=dayCandles[dayCandles.length-1]; trades.push({...position, pnl: Math.round((last.close-position.price)*position.lots)}); position=null; }
        buffer = dayCandles.slice(-100);
      }
    }
    const w=trades.filter(t=>t.pnl>0); const tp=trades.filter(t=>t.pnl>0&&Math.abs(t.pnl)>0); const sl=trades.filter(t=>t.pnl<0);
    console.log(`  TP${tpPct}%: ${trades.length}件 ${w.length}勝${trades.length-w.length}敗 勝率${(w.length/trades.length*100).toFixed(1)}% ${trades.reduce((s,t)=>s+t.pnl,0).toLocaleString()}円`);
  }
  
  // ===== ③ isBullish条件なしでの大台超えLONG =====
  console.log(`\n=== ③ isBullish条件の有無で大台超えLONG比較（TP=0.5%） ===`);
  for (const useBullish of [true, false]) {
    let trades: any[] = [];
    for (const sym of SYMBOLS) {
      let buffer: any[] = allData[sym][tradeDates[0]] || [];
      for (const date of simDates) {
        const dayCandles = allData[sym][date] || [];
        if (dayCandles.length < 10) continue;
        let position: any = null;
        for (let i = 0; i < dayCandles.length; i++) {
          const c = dayCandles[i]; buffer.push(c); if (buffer.length > 300) buffer = buffer.slice(-300);
          const [h, m] = c.candleTime.split(":").map(Number); const timeMin = h*60+m;
          if (position) {
            if (timeMin >= 687 && timeMin < 750) { trades.push({...position, pnl: Math.round((c.close-position.price)*position.lots)}); position=null; continue; }
            if (timeMin >= 925) { trades.push({...position, pnl: Math.round((c.close-position.price)*position.lots)}); position=null; continue; }
            const slP = position.price*(1-(SL_MAP[sym]||0.5)/100); const tpP = position.price*(1+0.5/100);
            if (c.low<=slP) { trades.push({...position, pnl: Math.round((slP-position.price)*position.lots)}); position=null; continue; }
            if (c.high>=tpP) { trades.push({...position, pnl: Math.round((tpP-position.price)*position.lots)}); position=null; continue; }
            continue;
          }
          if (timeMin<570||timeMin>=905||position) continue; if (timeMin>=750&&timeMin<770) continue;
          // isBullishチェック
          if (useBullish && buffer.length >= 9) {
            const ma = buffer.slice(-8).reduce((s:number,b:any)=>s+b.close,0)/8;
            const prevMa = buffer.slice(-9,-1).reduce((s:number,b:any)=>s+b.close,0)/8;
            if (((ma-prevMa)/prevMa*100) <= 0) continue; // isBullish=falseならスキップ
          }
          if (i>0 && buffer.length>=2) {
            const prev = buffer[buffer.length-2];
            for (const rl of [100,500,1000,5000,10000]) {
              const near = Math.ceil(c.close/rl)*rl;
              if (prev.close < near && c.close >= near && (c.close-near)/near < 0.008) {
                position = { sym, date, time: c.candleTime, price: c.close, lots: LOTS[sym]||100 }; break;
              }
            }
          }
        }
        if (position) { const last=dayCandles[dayCandles.length-1]; trades.push({...position, pnl: Math.round((last.close-position.price)*position.lots)}); position=null; }
        buffer = dayCandles.slice(-100);
      }
    }
    const w=trades.filter(t=>t.pnl>0);
    console.log(`  ${useBullish?"isBullish=true必須":"isBullish条件なし"}: ${trades.length}件 ${w.length}勝${trades.length-w.length}敗 勝率${(w.length/trades.length*100).toFixed(1)}% ${trades.reduce((s,t)=>s+t.pnl,0).toLocaleString()}円`);
  }
  
  // ===== ④ sell_pressure不在条件付きで大台超えLONG復活 =====
  console.log(`\n=== ④ sell_pressure不在条件付きで大台超えLONG復活 ===`);
  console.log(`（板情報はDBに保存されていないため、sell_pressureの代替として「直近の陰線率」で近似）`);
  console.log(`sell_pressure ≒ 直近5本中3本以上が陰線 → LONGブロック\n`);
  
  for (const bearThreshold of [0, 2, 3, 4]) { // 0=フィルターなし, 2=陰線2本以下で許可, 3=陰線3本以下, 4=ほぼ無制限
    let trades: any[] = [];
    for (const sym of SYMBOLS) {
      let buffer: any[] = allData[sym][tradeDates[0]] || [];
      for (const date of simDates) {
        const dayCandles = allData[sym][date] || [];
        if (dayCandles.length < 10) continue;
        let position: any = null;
        for (let i = 0; i < dayCandles.length; i++) {
          const c = dayCandles[i]; buffer.push(c); if (buffer.length > 300) buffer = buffer.slice(-300);
          const [h, m] = c.candleTime.split(":").map(Number); const timeMin = h*60+m;
          if (position) {
            if (timeMin >= 687 && timeMin < 750) { trades.push({...position, pnl: Math.round((c.close-position.price)*position.lots)}); position=null; continue; }
            if (timeMin >= 925) { trades.push({...position, pnl: Math.round((c.close-position.price)*position.lots)}); position=null; continue; }
            const slP = position.price*(1-(SL_MAP[sym]||0.5)/100); const tpP = position.price*(1+0.5/100);
            if (c.low<=slP) { trades.push({...position, pnl: Math.round((slP-position.price)*position.lots)}); position=null; continue; }
            if (c.high>=tpP) { trades.push({...position, pnl: Math.round((tpP-position.price)*position.lots)}); position=null; continue; }
            continue;
          }
          if (timeMin<570||timeMin>=905||position) continue; if (timeMin>=750&&timeMin<770) continue;
          // sell_pressure代替: 直近5本の陰線率
          if (buffer.length >= 5 && bearThreshold < 4) {
            const recent5 = buffer.slice(-5);
            const bearCount = recent5.filter((b:any)=>b.close<b.open).length;
            if (bearCount > bearThreshold) continue; // 陰線が多い=売り圧力 → LONGブロック
          }
          if (i>0 && buffer.length>=2) {
            const prev = buffer[buffer.length-2];
            for (const rl of [100,500,1000,5000,10000]) {
              const near = Math.ceil(c.close/rl)*rl;
              if (prev.close < near && c.close >= near && (c.close-near)/near < 0.008) {
                position = { sym, date, time: c.candleTime, price: c.close, lots: LOTS[sym]||100 }; break;
              }
            }
          }
        }
        if (position) { const last=dayCandles[dayCandles.length-1]; trades.push({...position, pnl: Math.round((last.close-position.price)*position.lots)}); position=null; }
        buffer = dayCandles.slice(-100);
      }
    }
    const w=trades.filter(t=>t.pnl>0);
    const label = bearThreshold === 0 ? "陰線0本以下（超厳格）" : bearThreshold === 2 ? "陰線2本以下（sell_pressure不在）" : bearThreshold === 3 ? "陰線3本以下（やや緩い）" : "フィルターなし";
    console.log(`  ${label}: ${trades.length}件 ${w.length}勝${trades.length-w.length}敗 勝率${(w.length/trades.length*100).toFixed(1)}% ${trades.reduce((s,t)=>s+t.pnl,0).toLocaleString()}円`);
  }
  
  process.exit(0);
}
main();
