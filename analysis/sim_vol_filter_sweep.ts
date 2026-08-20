import { getDb } from "../server/db";
import { sql } from "drizzle-orm";

// SHORT/LONG方式別の出来高フィルター最適値シミュレーション（30営業日）

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

interface VolConfig {
  shortMinVol_4a: number;      // 即4aの最低出来高倍率
  shortMinVol_dao: number;     // ダウ理論SHORTの最低出来高倍率
  shortMinVol_cb: number;      // CB2MW1の最低出来高倍率
  longMaxVol_break: number;    // 出来高ブレイクLONGの最大出来高倍率（上限）
  longMaxVol_bypass: number;   // バイパスLONGの最大出来高倍率（上限、999=なし）
}

function simulate(simDates: string[], tradeDates: string[], cfg: VolConfig): any[] {
  const allTrades: any[] = [];
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
        if (position && timeMin >= 687 && timeMin < 750) { const pnl = position.side === "short" ? (position.price - c.close) * position.lots : (c.close - position.price) * position.lots; allTrades.push({ date, sym, side: position.side, method: position.method, pnl: Math.round(pnl), volRatio: position.volRatio }); position = null; pullbackState = null; continue; }
        if (position && timeMin >= 925) { const pnl = position.side === "short" ? (position.price - c.close) * position.lots : (c.close - position.price) * position.lots; allTrades.push({ date, sym, side: position.side, method: position.method, pnl: Math.round(pnl), volRatio: position.volRatio }); position = null; pullbackState = null; continue; }
        if (position) {
          const slPct = position.side === "short" ? SL_MAP[sym]?.short || 0.8 : SL_MAP[sym]?.long || 0.5;
          const tpPct = position.side === "short" ? TP_SHORT : TP_LONG;
          const slPrice = position.side === "short" ? position.price * (1 + slPct/100) : position.price * (1 - slPct/100);
          const tpPrice = position.side === "short" ? position.price * (1 - tpPct/100) : position.price * (1 + tpPct/100);
          if (position.side === "short") {
            if (c.high >= slPrice) { allTrades.push({ date, sym, side: "short", method: position.method, pnl: Math.round((position.price - slPrice) * position.lots), volRatio: position.volRatio }); slAfterTime = time; position = null; continue; }
            if (c.low <= tpPrice) { allTrades.push({ date, sym, side: "short", method: position.method, pnl: Math.round((position.price - tpPrice) * position.lots), volRatio: position.volRatio }); position = null; continue; }
          } else {
            if (c.low <= slPrice) { allTrades.push({ date, sym, side: "long", method: position.method, pnl: Math.round((slPrice - position.price) * position.lots), volRatio: position.volRatio }); slAfterTime = time; position = null; continue; }
            if (c.high >= tpPrice) { allTrades.push({ date, sym, side: "long", method: position.method, pnl: Math.round((tpPrice - position.price) * position.lots), volRatio: position.volRatio }); position = null; continue; }
          }
          continue;
        }
        if (pullbackState) {
          pullbackState.waitCount++;
          if (c.low < pullbackState.swingLow) pullbackState = null;
          else if (pullbackState.waitCount > PULLBACK_MAX_WAIT) pullbackState = null;
          else {
            if (!pullbackState.pulledBack && c.close < pullbackState.signalPrice) pullbackState.pulledBack = true;
            if (pullbackState.pulledBack && c.close > pullbackState.signalPrice) { const v20 = buffer.length >= 21 ? buffer.slice(-21,-1).reduce((s:number,b:any)=>s+b.volume,0)/20 : 0; position = { sym, side: "long", price: c.close, lots: LOTS[sym]||100, time, method: "押し目確認", volRatio: v20>0?c.volume/v20:0 }; pullbackState = null; }
            if (pullbackState) continue;
          }
        }
        if (timeMin < 570 || timeMin >= 905) continue;
        if (timeMin >= 750 && timeMin < 770) continue;
        if (position) continue;
        if (slAfterTime) { const slH = parseInt(slAfterTime.split(":")[0]), slM = parseInt(slAfterTime.split(":")[1]); if (timeMin - (slH*60+slM) < 30) continue; slAfterTime = null; }
        let isBullish = false;
        if (buffer.length >= IS_BULLISH_MA_PERIOD + 1) { const ma2 = buffer.slice(-IS_BULLISH_MA_PERIOD).reduce((s:number,b:any)=>s+b.close,0)/IS_BULLISH_MA_PERIOD; const prevMa2 = buffer.slice(-IS_BULLISH_MA_PERIOD-1,-1).reduce((s:number,b:any)=>s+b.close,0)/IS_BULLISH_MA_PERIOD; isBullish = ((ma2-prevMa2)/prevMa2*100) > IS_BULLISH_SLOPE_THRESHOLD; }
        if (buffer.length >= 20) { const atr = buffer.slice(-20).reduce((s:number,b:any)=>s+(b.high-b.low),0)/20; if (atr/c.close*100 < ATR_FILTER_THRESHOLD) continue; }
        const vol20 = buffer.length >= 21 ? buffer.slice(-21,-1).reduce((s:number,b:any)=>s+b.volume,0)/20 : 0;
        const volRatio = vol20 > 0 ? c.volume / vol20 : 0;
        let shortBlocked = false;
        if (!isBullish && buffer.length >= 20) { const rh = Math.max(...buffer.slice(-20).map((b:any)=>b.high)); if ((rh-c.close)/rh*100 > SHORT_DROP_FROM_HIGH_MAX) shortBlocked = true; }
        // SHORT
        if (!shortBlocked && i > 0 && buffer.length >= 2 && !isBullish) {
          const prev = buffer[buffer.length-2];
          for (const rl of [100,500,1000,5000,10000]) {
            const na = Math.ceil(prev.close/rl)*rl;
            if (prev.close >= na && c.close < na && (na-c.close)/na < 0.008) {
              const prevDist = prev.close>0?(prev.close-na)/na*100:999;
              if (volRatio >= FAST_ENTRY_VOL_RATIO) { position = { sym, side:"short", price:c.close, lots:LOTS[sym]||100, time, method:"即vol", volRatio }; }
              else if (prevDist <= FAST_ENTRY_PREV_DIST_PCT && volRatio >= cfg.shortMinVol_4a) { position = { sym, side:"short", price:c.close, lots:LOTS[sym]||100, time, method:"即4a", volRatio }; }
              else if (volRatio >= cfg.shortMinVol_cb) { position = { sym, side:"short", price:c.close, lots:LOTS[sym]||100, time, method:"CB2", volRatio }; }
              break;
            }
          }
        }
        if (position) continue;
        if (!shortBlocked && buffer.length >= 21 && !isBullish) {
          const minLow = Math.min(...buffer.slice(-21,-1).map((b:any)=>b.low));
          if (c.close < minLow && volRatio >= cfg.shortMinVol_dao) { position = { sym, side:"short", price:c.close, lots:LOTS[sym]||100, time, method: volRatio >= SHORT_LOW_BREAK_VOL_RATIO ? "安値更新即" : "ダウ理論SHORT", volRatio }; }
        }
        if (position) continue;
        // LONG
        if (buffer.length >= 21 && isBullish) {
          const maxHigh = Math.max(...buffer.slice(-21,-1).map((b:any)=>b.high));
          if (c.close > maxHigh) {
            const ma3 = buffer.slice(-IS_BULLISH_MA_PERIOD).reduce((s:number,b:any)=>s+b.close,0)/IS_BULLISH_MA_PERIOD;
            const maDev = Math.abs((c.close-ma3)/ma3*100); const bb = Math.abs((c.close-c.open)/c.open*100); const bearB = buffer.slice(-10).filter((b:any)=>b.close<b.open).length;
            if (maDev < 0.5 && bb < 0.2 && bearB <= 4 && volRatio <= cfg.longMaxVol_bypass) { position = { sym, side:"long", price:c.close, lots:LOTS[sym]||100, time, method:"バイパス", volRatio }; }
            if (!position && isAM && volRatio >= AM_VOL_BREAK_RATIO && volRatio <= cfg.longMaxVol_break) { position = { sym, side:"long", price:c.close, lots:LOTS[sym]||100, time, method:"出来高ブレイク", volRatio }; }
            if (!position && !pullbackState) { const swLow = Math.min(...buffer.slice(-20).map((b:any)=>b.low)); pullbackState = { signalPrice:c.close, swingLow:swLow, waitCount:0, pulledBack:false }; }
          }
        }
      }
      if (position) { const lc = dayCandles[dayCandles.length-1]; const pnl = position.side==="short"?(position.price-lc.close)*position.lots:(lc.close-position.price)*position.lots; allTrades.push({ date, sym, side:position.side, method:position.method, pnl:Math.round(pnl), volRatio:position.volRatio }); }
      buffer = dayCandles.slice(-100); pullbackState = null;
    }
  }
  return allTrades;
}

function summarize(trades: any[], label: string) {
  const wins = trades.filter((t:any)=>t.pnl>0);
  const total = trades.reduce((s:number,t:any)=>s+t.pnl,0);
  const gp = wins.reduce((s:number,t:any)=>s+t.pnl,0);
  const gl = Math.abs(trades.filter((t:any)=>t.pnl<=0).reduce((s:number,t:any)=>s+t.pnl,0));
  const pf = gl>0?gp/gl:999;
  return `${label}: ${trades.length}件 ${wins.length}勝${trades.length-wins.length}敗 ${total>=0?"+":""}${total.toLocaleString()}円 PF${pf.toFixed(2)}`;
}

async function main() {
  const db = await getDb();
  const [dates] = await db.execute(sql`SELECT DISTINCT tradeDate FROM rt_candles WHERE symbol='8035' ORDER BY tradeDate DESC LIMIT 31`);
  const tradeDates = (dates as any[]).map((d:any)=>d.tradeDate).reverse();
  const simDates = tradeDates.slice(1); const days = simDates.length;
  console.log(`期間: ${simDates[0]}〜${simDates[simDates.length-1]} (${days}営業日)\n`);
  await loadData(db, tradeDates);
  
  // 現行（出来高フィルターなし/現行値）
  const baseline: VolConfig = { shortMinVol_4a: 0, shortMinVol_dao: 0, shortMinVol_cb: 0, longMaxVol_break: 999, longMaxVol_bypass: 999 };
  const baseTrades = simulate(simDates, tradeDates, baseline);
  console.log("=== 現行 ===");
  console.log(summarize(baseTrades, "全体"));
  for (const m of [...new Set(baseTrades.map((t:any)=>t.method))]) {
    console.log("  " + summarize(baseTrades.filter((t:any)=>t.method===m), m));
  }
  
  // ① SHORT即4aに出来高フィルター追加
  console.log("\n=== ① SHORT即4a: 出来高最低条件 ===");
  for (const minVol of [0, 0.5, 0.8, 1.0, 1.2, 1.5]) {
    const cfg: VolConfig = { ...baseline, shortMinVol_4a: minVol };
    const trades = simulate(simDates, tradeDates, cfg);
    const t4a = trades.filter((t:any)=>t.method==="即4a");
    const total = trades.reduce((s:number,t:any)=>s+t.pnl,0);
    console.log(`  ≥${minVol.toFixed(1)}x: ${summarize(t4a, "即4a")} | 全体${total>=0?"+":""}${total.toLocaleString()}円`);
  }
  
  // ② SHORTダウ理論/安値更新に出来高フィルター追加
  console.log("\n=== ② SHORT ダウ理論/安値更新: 出来高最低条件 ===");
  for (const minVol of [0, 0.5, 0.8, 1.0, 1.2, 1.5]) {
    const cfg: VolConfig = { ...baseline, shortMinVol_dao: minVol };
    const trades = simulate(simDates, tradeDates, cfg);
    const tDao = trades.filter((t:any)=>t.method==="ダウ理論SHORT" || t.method==="安値更新即");
    const total = trades.reduce((s:number,t:any)=>s+t.pnl,0);
    console.log(`  ≥${minVol.toFixed(1)}x: ${summarize(tDao, "ダウ/安値")} | 全体${total>=0?"+":""}${total.toLocaleString()}円`);
  }
  
  // ③ LONG出来高ブレイク: 上限フィルター
  console.log("\n=== ③ LONG出来高ブレイク: 出来高上限 ===");
  for (const maxVol of [1.5, 2.0, 2.5, 3.0, 5.0, 999]) {
    const cfg: VolConfig = { ...baseline, longMaxVol_break: maxVol };
    const trades = simulate(simDates, tradeDates, cfg);
    const tBrk = trades.filter((t:any)=>t.method==="出来高ブレイク");
    const total = trades.reduce((s:number,t:any)=>s+t.pnl,0);
    console.log(`  ≤${maxVol >= 999 ? "なし" : maxVol.toFixed(1)+"x"}: ${summarize(tBrk, "出来高ブレイク")} | 全体${total>=0?"+":""}${total.toLocaleString()}円`);
  }
  
  // ④ LONGバイパス: 出来高上限
  console.log("\n=== ④ LONGバイパス: 出来高上限 ===");
  for (const maxVol of [1.0, 1.2, 1.5, 2.0, 2.5, 999]) {
    const cfg: VolConfig = { ...baseline, longMaxVol_bypass: maxVol };
    const trades = simulate(simDates, tradeDates, cfg);
    const tByp = trades.filter((t:any)=>t.method==="バイパス");
    const total = trades.reduce((s:number,t:any)=>s+t.pnl,0);
    console.log(`  ≤${maxVol >= 999 ? "なし" : maxVol.toFixed(1)+"x"}: ${summarize(tByp, "バイパス")} | 全体${total>=0?"+":""}${total.toLocaleString()}円`);
  }
  
  // ⑤ 最適組み合わせ
  console.log("\n=== ⑤ 最適組み合わせ候補 ===");
  const combos = [
    { label: "現行", cfg: baseline },
    { label: "即4a≥1.0x", cfg: { ...baseline, shortMinVol_4a: 1.0 } },
    { label: "即4a≥0.8x", cfg: { ...baseline, shortMinVol_4a: 0.8 } },
    { label: "ダウ≥0.8x", cfg: { ...baseline, shortMinVol_dao: 0.8 } },
    { label: "出来高ブレイク撤廃", cfg: { ...baseline, longMaxVol_break: 0 } },
    { label: "即4a≥1.0+ダウ≥0.8", cfg: { ...baseline, shortMinVol_4a: 1.0, shortMinVol_dao: 0.8 } },
    { label: "即4a≥1.0+ブレイク撤廃", cfg: { ...baseline, shortMinVol_4a: 1.0, longMaxVol_break: 0 } },
    { label: "即4a≥1.0+ダウ≥0.8+ブレイク撤廃", cfg: { ...baseline, shortMinVol_4a: 1.0, shortMinVol_dao: 0.8, longMaxVol_break: 0 } },
  ];
  for (const { label, cfg } of combos) {
    const trades = simulate(simDates, tradeDates, cfg);
    const total = trades.reduce((s:number,t:any)=>s+t.pnl,0);
    const wins = trades.filter((t:any)=>t.pnl>0);
    const gp = wins.reduce((s:number,t:any)=>s+t.pnl,0);
    const gl = Math.abs(trades.filter((t:any)=>t.pnl<=0).reduce((s:number,t:any)=>s+t.pnl,0));
    const pf = gl>0?gp/gl:999;
    console.log(`  ${label}: ${trades.length}件 ${wins.length}勝 勝率${(wins.length/trades.length*100).toFixed(1)}% ${total>=0?"+":""}${total.toLocaleString()}円 PF${pf.toFixed(2)} 1日平均${Math.round(total/days).toLocaleString()}円`);
  }
  
  process.exit(0);
}
main();
