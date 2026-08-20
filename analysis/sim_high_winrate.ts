import { getDb } from "../server/db";
import { sql } from "drizzle-orm";

// 勝率70%以上を達成する条件を探索

const IS_BULLISH_MA_PERIOD = 8;
const IS_BULLISH_SLOPE_THRESHOLD = 0;
const FAST_ENTRY_VOL_RATIO = 1.5;
const FAST_ENTRY_PREV_DIST_PCT = 0.05;
const SHORT_LOW_BREAK_VOL_RATIO = 1.2;
const AM_VOL_BREAK_RATIO = 1.5;
const TP_SHORT = 1.5;
const TP_LONG = 0.5;
const ATR_FILTER_THRESHOLD = 0.12;
const SHORT_DROP_FROM_HIGH_MAX = 2.0;
const PULLBACK_MAX_WAIT = 5;

const SL_MAP: Record<string, { long: number; short: number }> = {
  "8035": { long: 0.5, short: 0.8 }, "6857": { long: 0.6, short: 0.6 },
  "6976": { long: 0.6, short: 0.8 }, "6526": { long: 0.9, short: 1.0 },
  "5803": { long: 0.5, short: 0.6 }, "6981": { long: 0.4, short: 0.9 },
  "285A": { long: 0.8, short: 0.6 }, "6146": { long: 0.8, short: 0.8 },
  "6594": { long: 0.5, short: 0.5 }, "8316": { long: 0.5, short: 0.5 },
};
const LOTS: Record<string, number> = {
  "8035": 100, "6857": 100, "285A": 100, "6146": 100,
  "6976": 200, "6981": 300, "8316": 400, "5803": 400, "6526": 1400, "6594": 1000,
};
const SYMBOLS = ["8035", "6857", "6976", "6526", "5803", "6981", "285A", "6146", "6594", "8316"];

let cachedData: Record<string, Record<string, any[]>> = {};

async function loadData(db: any, tradeDates: string[]) {
  for (const sym of SYMBOLS) {
    const [rows] = await db.execute(sql`SELECT tradeDate, candleTime, open, high, low, close, volume FROM rt_candles WHERE symbol=${sym} AND tradeDate>=${tradeDates[0]} ORDER BY tradeDate, candleTime`);
    const byDate: Record<string, any[]> = {};
    for (const c of rows as any[]) { if (!byDate[c.tradeDate]) byDate[c.tradeDate] = []; byDate[c.tradeDate].push({...c, open:+c.open, high:+c.high, low:+c.low, close:+c.close, volume:+c.volume}); }
    cachedData[sym] = byDate;
  }
}

interface Trade {
  date: string; sym: string; side: string; method: string; price: number; lots: number;
  time: string; pnl: number; volRatio: number; maSlope: number; barBody: number;
  bearBars: number; dropFromHigh: number; riseFromLow: number; isAM: boolean;
  holdBars: number; exitReason: string;
}

function simulateDetailed(simDates: string[], tradeDates: string[]): Trade[] {
  const allTrades: Trade[] = [];
  for (const sym of SYMBOLS) {
    const byDate = cachedData[sym]; if (!byDate) continue;
    let buffer: any[] = byDate[tradeDates[0]] ? [...byDate[tradeDates[0]]] : [];
    for (const date of simDates) {
      const dayCandles = byDate[date] || [];
      if (dayCandles.length < 10) continue;
      let position: any = null; let slAfterTime: string | null = null; let pullbackState: any = null;
      for (let i = 0; i < dayCandles.length; i++) {
        const c = dayCandles[i]; buffer.push(c); if (buffer.length > 300) buffer = buffer.slice(-300);
        const time = c.candleTime;
        const [h, m] = time.split(":").map(Number); const timeMin = h*60+m; const isAM = timeMin < 688;
        
        const finalize = (exitReason: string) => {
          if (!position) return;
          const pnl = position.side==="short"?(position.price-c.close)*position.lots:(c.close-position.price)*position.lots;
          allTrades.push({ ...position, date, pnl: Math.round(pnl), holdBars: i - position.entryIdx, exitReason, isAM: position.isAM });
          position = null; pullbackState = null;
        };
        
        if (position && timeMin >= 687 && timeMin < 750) { finalize("前場決済"); continue; }
        if (position && timeMin >= 925) { finalize("大引け"); continue; }
        if (position) {
          const slPct = position.side==="short"?SL_MAP[sym]?.short||0.8:SL_MAP[sym]?.long||0.5;
          const tpPct = position.side==="short"?TP_SHORT:TP_LONG;
          const slPrice = position.side==="short"?position.price*(1+slPct/100):position.price*(1-slPct/100);
          const tpPrice = position.side==="short"?position.price*(1-tpPct/100):position.price*(1+tpPct/100);
          if (position.side==="short") {
            if (c.high>=slPrice) { const pnl=Math.round((position.price-slPrice)*position.lots); allTrades.push({...position,date,pnl,holdBars:i-position.entryIdx,exitReason:"SL",isAM:position.isAM}); slAfterTime=time; position=null; continue; }
            if (c.low<=tpPrice) { const pnl=Math.round((position.price-tpPrice)*position.lots); allTrades.push({...position,date,pnl,holdBars:i-position.entryIdx,exitReason:"TP",isAM:position.isAM}); position=null; continue; }
          } else {
            if (c.low<=slPrice) { const pnl=Math.round((slPrice-position.price)*position.lots); allTrades.push({...position,date,pnl,holdBars:i-position.entryIdx,exitReason:"SL",isAM:position.isAM}); slAfterTime=time; position=null; continue; }
            if (c.high>=tpPrice) { const pnl=Math.round((tpPrice-position.price)*position.lots); allTrades.push({...position,date,pnl,holdBars:i-position.entryIdx,exitReason:"TP",isAM:position.isAM}); position=null; continue; }
          }
          continue;
        }
        if (pullbackState) {
          pullbackState.waitCount++;
          if (c.low < pullbackState.swingLow) pullbackState=null;
          else if (pullbackState.waitCount > PULLBACK_MAX_WAIT) pullbackState=null;
          else {
            if (!pullbackState.pulledBack && c.close < pullbackState.signalPrice) pullbackState.pulledBack=true;
            if (pullbackState.pulledBack && c.close > pullbackState.signalPrice) {
              const v20=buffer.length>=21?buffer.slice(-21,-1).reduce((s:number,b:any)=>s+b.volume,0)/20:0;
              const vr=v20>0?c.volume/v20:0;
              const ma3=buffer.slice(-IS_BULLISH_MA_PERIOD).reduce((s:number,b:any)=>s+b.close,0)/IS_BULLISH_MA_PERIOD;
              const pm3=buffer.slice(-IS_BULLISH_MA_PERIOD-1,-1).reduce((s:number,b:any)=>s+b.close,0)/IS_BULLISH_MA_PERIOD;
              const ms=(ma3-pm3)/pm3*100;
              const bb=Math.abs((c.close-c.open)/c.open*100);
              const bearB=buffer.slice(-10).filter((b:any)=>b.close<b.open).length;
              const rh=Math.max(...buffer.slice(-20).map((b:any)=>b.high));
              const rl2=Math.min(...buffer.slice(-20).map((b:any)=>b.low));
              position={sym,side:"long",price:c.close,lots:LOTS[sym]||100,time,method:"押し目確認",volRatio:vr,maSlope:ms,barBody:bb,bearBars:bearB,dropFromHigh:(rh-c.close)/rh*100,riseFromLow:rl2>0?(c.close-rl2)/rl2*100:0,isAM,entryIdx:i};
              pullbackState=null;
            }
            if (pullbackState) continue;
          }
        }
        if (timeMin < 570 || timeMin >= 905) continue;
        if (timeMin >= 750 && timeMin < 770) continue;
        if (position) continue;
        if (slAfterTime) { const slH=parseInt(slAfterTime.split(":")[0]),slM=parseInt(slAfterTime.split(":")[1]); if (timeMin-(slH*60+slM)<30) continue; slAfterTime=null; }
        let isBullish=false;
        const ma=buffer.length>=IS_BULLISH_MA_PERIOD?buffer.slice(-IS_BULLISH_MA_PERIOD).reduce((s:number,b:any)=>s+b.close,0)/IS_BULLISH_MA_PERIOD:0;
        const pm=buffer.length>=IS_BULLISH_MA_PERIOD+1?buffer.slice(-IS_BULLISH_MA_PERIOD-1,-1).reduce((s:number,b:any)=>s+b.close,0)/IS_BULLISH_MA_PERIOD:0;
        const maSlope=pm>0?(ma-pm)/pm*100:0;
        if (buffer.length>=IS_BULLISH_MA_PERIOD+1) isBullish=maSlope>IS_BULLISH_SLOPE_THRESHOLD;
        if (buffer.length>=20) { const atr=buffer.slice(-20).reduce((s:number,b:any)=>s+(b.high-b.low),0)/20; if (atr/c.close*100<ATR_FILTER_THRESHOLD) continue; }
        const vol20=buffer.length>=21?buffer.slice(-21,-1).reduce((s:number,b:any)=>s+b.volume,0)/20:0;
        const volRatio=vol20>0?c.volume/vol20:0;
        const barBody=Math.abs((c.close-c.open)/c.open*100);
        const bearBars=buffer.slice(-10).filter((b:any)=>b.close<b.open).length;
        const recentHigh=buffer.length>=20?Math.max(...buffer.slice(-20).map((b:any)=>b.high)):c.high;
        const recentLow=buffer.length>=20?Math.min(...buffer.slice(-20).map((b:any)=>b.low)):c.low;
        const dropFromHigh=(recentHigh-c.close)/recentHigh*100;
        const riseFromLow=recentLow>0?(c.close-recentLow)/recentLow*100:0;
        let shortBlocked=false;
        if (!isBullish && buffer.length>=20 && dropFromHigh>SHORT_DROP_FROM_HIGH_MAX) shortBlocked=true;
        // SHORT
        if (!shortBlocked && i>0 && buffer.length>=2 && !isBullish) {
          const prev=buffer[buffer.length-2];
          for (const rl of [100,500,1000,5000,10000]) {
            const na=Math.ceil(prev.close/rl)*rl;
            if (prev.close>=na && c.close<na && (na-c.close)/na<0.008) {
              const prevDist=prev.close>0?(prev.close-na)/na*100:999;
              let method="CB2"; if (volRatio>=FAST_ENTRY_VOL_RATIO) method="即vol"; else if (prevDist<=FAST_ENTRY_PREV_DIST_PCT) method="即4a";
              position={sym,side:"short",price:c.close,lots:LOTS[sym]||100,time,method,volRatio,maSlope,barBody,bearBars,dropFromHigh,riseFromLow,isAM,entryIdx:i};
              break;
            }
          }
        }
        if (position) continue;
        if (!shortBlocked && buffer.length>=21 && !isBullish) {
          const minLow=Math.min(...buffer.slice(-21,-1).map((b:any)=>b.low));
          if (c.close<minLow) { position={sym,side:"short",price:c.close,lots:LOTS[sym]||100,time,method:volRatio>=SHORT_LOW_BREAK_VOL_RATIO?"安値更新即":"ダウ理論SHORT",volRatio,maSlope,barBody,bearBars,dropFromHigh,riseFromLow,isAM,entryIdx:i}; }
        }
        if (position) continue;
        if (buffer.length>=21 && isBullish) {
          const maxHigh=Math.max(...buffer.slice(-21,-1).map((b:any)=>b.high));
          if (c.close>maxHigh) {
            const maDev=Math.abs((c.close-ma)/ma*100);
            if (maDev<0.5 && barBody<0.2 && bearBars<=4) position={sym,side:"long",price:c.close,lots:LOTS[sym]||100,time,method:"バイパス",volRatio,maSlope,barBody,bearBars,dropFromHigh,riseFromLow,isAM,entryIdx:i};
            if (!position && isAM && volRatio>=AM_VOL_BREAK_RATIO) position={sym,side:"long",price:c.close,lots:LOTS[sym]||100,time,method:"出来高ブレイク",volRatio,maSlope,barBody,bearBars,dropFromHigh,riseFromLow,isAM,entryIdx:i};
            if (!position && !pullbackState) { const swLow=Math.min(...buffer.slice(-20).map((b:any)=>b.low)); pullbackState={signalPrice:c.close,swingLow:swLow,waitCount:0,pulledBack:false}; }
          }
        }
      }
      if (position) { const lc=dayCandles[dayCandles.length-1]; const pnl=position.side==="short"?(position.price-lc.close)*position.lots:(lc.close-position.price)*position.lots; allTrades.push({...position,date,pnl:Math.round(pnl),holdBars:dayCandles.length-1-position.entryIdx,exitReason:"EOD",isAM:position.isAM}); }
      buffer=dayCandles.slice(-100); pullbackState=null;
    }
  }
  return allTrades;
}

async function main() {
  const db = await getDb();
  const [dates] = await db.execute(sql`SELECT DISTINCT tradeDate FROM rt_candles WHERE symbol='8035' ORDER BY tradeDate DESC LIMIT 31`);
  const tradeDates = (dates as any[]).map((d:any)=>d.tradeDate).reverse();
  const simDates = tradeDates.slice(1); const days = simDates.length;
  console.log(`期間: ${simDates[0]}〜${simDates[simDates.length-1]} (${days}営業日)\n`);
  await loadData(db, tradeDates);
  
  const trades = simulateDetailed(simDates, tradeDates);
  const wins = trades.filter(t => t.pnl > 0);
  const total = trades.reduce((s, t) => s + t.pnl, 0);
  console.log(`全体: ${trades.length}件 ${wins.length}勝${trades.length-wins.length}敗 勝率${(wins.length/trades.length*100).toFixed(1)}% +${total.toLocaleString()}円\n`);
  
  // 高勝率サブセットを探索
  console.log("=== 高勝率サブセット探索 ===\n");
  
  // 方式別
  console.log("--- 方式別 ---");
  for (const m of [...new Set(trades.map(t => t.method))]) {
    const mt = trades.filter(t => t.method === m);
    const mw = mt.filter(t => t.pnl > 0);
    const mp = mt.reduce((s, t) => s + t.pnl, 0);
    console.log(`${m}: ${mt.length}件 勝率${(mw.length/mt.length*100).toFixed(1)}% ${mp>=0?"+":""}${mp.toLocaleString()}円`);
  }
  
  // 方式×時間帯
  console.log("\n--- 方式×時間帯 ---");
  for (const m of [...new Set(trades.map(t => t.method))]) {
    for (const am of [true, false]) {
      const mt = trades.filter(t => t.method === m && t.isAM === am);
      if (mt.length < 5) continue;
      const mw = mt.filter(t => t.pnl > 0);
      const mp = mt.reduce((s, t) => s + t.pnl, 0);
      const wr = mw.length/mt.length*100;
      if (wr >= 55) console.log(`★ ${m} ${am?"前場":"後場"}: ${mt.length}件 勝率${wr.toFixed(1)}% ${mp>=0?"+":""}${mp.toLocaleString()}円`);
      else console.log(`  ${m} ${am?"前場":"後場"}: ${mt.length}件 勝率${wr.toFixed(1)}% ${mp>=0?"+":""}${mp.toLocaleString()}円`);
    }
  }
  
  // 出来高倍率別
  console.log("\n--- SHORT: 出来高倍率別 ---");
  const shortT = trades.filter(t => t.side === "short");
  for (const [lo, hi, label] of [[0,0.5,"<0.5x"],[0.5,1.0,"0.5-1.0x"],[1.0,1.5,"1.0-1.5x"],[1.5,2.0,"1.5-2.0x"],[2.0,3.0,"2.0-3.0x"],[3.0,999,">3.0x"]] as [number,number,string][]) {
    const st = shortT.filter(t => t.volRatio >= lo && t.volRatio < hi);
    if (st.length < 3) continue;
    const sw = st.filter(t => t.pnl > 0);
    const sp = st.reduce((s, t) => s + t.pnl, 0);
    const wr = sw.length/st.length*100;
    if (wr >= 55) console.log(`★ ${label}: ${st.length}件 勝率${wr.toFixed(1)}% ${sp>=0?"+":""}${sp.toLocaleString()}円`);
    else console.log(`  ${label}: ${st.length}件 勝率${wr.toFixed(1)}% ${sp>=0?"+":""}${sp.toLocaleString()}円`);
  }
  
  console.log("\n--- LONG: 出来高倍率別 ---");
  const longT = trades.filter(t => t.side === "long");
  for (const [lo, hi, label] of [[0,0.5,"<0.5x"],[0.5,1.0,"0.5-1.0x"],[1.0,1.5,"1.0-1.5x"],[1.5,2.0,"1.5-2.0x"],[2.0,3.0,"2.0-3.0x"],[3.0,999,">3.0x"]] as [number,number,string][]) {
    const lt = longT.filter(t => t.volRatio >= lo && t.volRatio < hi);
    if (lt.length < 3) continue;
    const lw = lt.filter(t => t.pnl > 0);
    const lp = lt.reduce((s, t) => s + t.pnl, 0);
    const wr = lw.length/lt.length*100;
    if (wr >= 55) console.log(`★ ${label}: ${lt.length}件 勝率${wr.toFixed(1)}% ${lp>=0?"+":""}${lp.toLocaleString()}円`);
    else console.log(`  ${label}: ${lt.length}件 勝率${wr.toFixed(1)}% ${lp>=0?"+":""}${lp.toLocaleString()}円`);
  }
  
  // MA傾き別
  console.log("\n--- SHORT: MA傾き別 ---");
  for (const [lo, hi, label] of [[-999,-0.1,"<-0.1%"],[-0.1,-0.05,"-0.1~-0.05%"],[-0.05,0,"-0.05~0%"]] as [number,number,string][]) {
    const st = shortT.filter(t => t.maSlope >= lo && t.maSlope < hi);
    if (st.length < 5) continue;
    const sw = st.filter(t => t.pnl > 0);
    const sp = st.reduce((s, t) => s + t.pnl, 0);
    const wr = sw.length/st.length*100;
    if (wr >= 55) console.log(`★ ${label}: ${st.length}件 勝率${wr.toFixed(1)}% ${sp>=0?"+":""}${sp.toLocaleString()}円`);
    else console.log(`  ${label}: ${st.length}件 勝率${wr.toFixed(1)}% ${sp>=0?"+":""}${sp.toLocaleString()}円`);
  }
  
  // 高値下落幅別
  console.log("\n--- SHORT: 高値下落幅別 ---");
  for (const [lo, hi, label] of [[0,0.3,"0-0.3%"],[0.3,0.6,"0.3-0.6%"],[0.6,1.0,"0.6-1.0%"],[1.0,1.5,"1.0-1.5%"],[1.5,2.0,"1.5-2.0%"]] as [number,number,string][]) {
    const st = shortT.filter(t => t.dropFromHigh >= lo && t.dropFromHigh < hi);
    if (st.length < 5) continue;
    const sw = st.filter(t => t.pnl > 0);
    const sp = st.reduce((s, t) => s + t.pnl, 0);
    const wr = sw.length/st.length*100;
    if (wr >= 55) console.log(`★ ${label}: ${st.length}件 勝率${wr.toFixed(1)}% ${sp>=0?"+":""}${sp.toLocaleString()}円`);
    else console.log(`  ${label}: ${st.length}件 勝率${wr.toFixed(1)}% ${sp>=0?"+":""}${sp.toLocaleString()}円`);
  }
  
  // TP幅別の勝率
  console.log("\n=== TP/SL幅と勝率の関係 ===");
  console.log("\n--- SHORT: TP幅別 ---");
  for (const tp of [0.5, 0.8, 1.0, 1.2, 1.5, 2.0]) {
    // TP幅を変えた場合の勝率を概算（maxFavorableがないので、SL到達前にTP到達するかで判定）
    console.log(`  TP${tp}%: (別途シミュレーション必要)`);
  }
  
  // 勝率70%以上の条件組み合わせ探索
  console.log("\n=== 勝率70%以上の条件組み合わせ ===");
  const conditions: { label: string; filter: (t: Trade) => boolean }[] = [
    { label: "押し目確認LONG 前場", filter: t => t.method === "押し目確認" && t.isAM },
    { label: "押し目確認LONG 後場", filter: t => t.method === "押し目確認" && !t.isAM },
    { label: "バイパスLONG 後場", filter: t => t.method === "バイパス" && !t.isAM },
    { label: "バイパスLONG 前場", filter: t => t.method === "バイパス" && t.isAM },
    { label: "即4a 前場", filter: t => t.method === "即4a" && t.isAM },
    { label: "即4a 後場", filter: t => t.method === "即4a" && !t.isAM },
    { label: "SHORT 高値下落<0.5%", filter: t => t.side === "short" && t.dropFromHigh < 0.5 },
    { label: "SHORT 高値下落<0.3%", filter: t => t.side === "short" && t.dropFromHigh < 0.3 },
    { label: "SHORT 出来高>2.0x", filter: t => t.side === "short" && t.volRatio > 2.0 },
    { label: "SHORT 出来高>3.0x", filter: t => t.side === "short" && t.volRatio > 3.0 },
    { label: "LONG 出来高<1.0x", filter: t => t.side === "long" && t.volRatio < 1.0 },
    { label: "LONG 出来高<0.8x", filter: t => t.side === "long" && t.volRatio < 0.8 },
    { label: "SHORT MA傾き<-0.1%", filter: t => t.side === "short" && t.maSlope < -0.1 },
    { label: "SHORT 陰線≥7本", filter: t => t.side === "short" && t.bearBars >= 7 },
    { label: "LONG 陰線≤2本", filter: t => t.side === "long" && t.bearBars <= 2 },
    { label: "LONG 陰線≤1本", filter: t => t.side === "long" && t.bearBars <= 1 },
    { label: "ダウ理論SHORT 前場", filter: t => t.method === "ダウ理論SHORT" && t.isAM },
    { label: "ダウ理論SHORT 後場", filter: t => t.method === "ダウ理論SHORT" && !t.isAM },
  ];
  
  const highWr: { label: string; cnt: number; wr: number; pnl: number }[] = [];
  for (const cond of conditions) {
    const ct = trades.filter(cond.filter);
    if (ct.length < 10) continue;
    const cw = ct.filter(t => t.pnl > 0);
    const cp = ct.reduce((s, t) => s + t.pnl, 0);
    const wr = cw.length / ct.length * 100;
    highWr.push({ label: cond.label, cnt: ct.length, wr, pnl: cp });
  }
  highWr.sort((a, b) => b.wr - a.wr);
  for (const h of highWr) {
    const mark = h.wr >= 65 ? "★★" : h.wr >= 55 ? "★" : "  ";
    console.log(`${mark} ${h.label}: ${h.cnt}件 勝率${h.wr.toFixed(1)}% ${h.pnl>=0?"+":""}${h.pnl.toLocaleString()}円`);
  }
  
  process.exit(0);
}
main();
