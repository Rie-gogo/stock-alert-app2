import { getDb } from "../server/db";
import { sql } from "drizzle-orm";

// 8/19-8/20のマイナス取引の共通点分析

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
const NAMES: Record<string, string> = {
  "8035": "東京エレクトロン", "6857": "アドバンテスト", "6976": "太陽誘電",
  "6526": "ソシオネクスト", "5803": "フジクラ", "6981": "村田製作所",
  "285A": "キオクシア", "6146": "ディスコ", "6594": "ニデック", "8316": "三井住友FG",
};
const SYMBOLS = ["8035", "6857", "6976", "6526", "5803", "6981", "285A", "6146", "6594", "8316"];

interface TradeDetail {
  date: string; sym: string; side: string; price: number; lots: number;
  time: string; method: string; exitTime: string; exitReason: string; pnl: number;
  // 分析用
  volRatio: number; maSlope: number; barBody: number; bearBars: number;
  dropFromHigh: number; riseFromLow: number; prevBarDir: string;
  minutesSinceOpen: number; isAM: boolean; entryNumber: number;
  maxFavorable: number; maxAdverse: number; holdBars: number;
}

async function simulateWithDetail(db: any, targetDate: string, prevDate: string): Promise<TradeDetail[]> {
  const trades: TradeDetail[] = [];
  
  for (const sym of SYMBOLS) {
    const [rows] = await db.execute(sql`
      SELECT tradeDate, candleTime, open, high, low, close, volume
      FROM rt_candles WHERE symbol=${sym} AND tradeDate IN (${prevDate}, ${targetDate}) ORDER BY tradeDate, candleTime
    `);
    const candles = (rows as any[]).map((r: any) => ({...r, open:+r.open, high:+r.high, low:+r.low, close:+r.close, volume:+r.volume}));
    const prevCandles = candles.filter(c => c.tradeDate === prevDate);
    const dayCandles = candles.filter(c => c.tradeDate === targetDate);
    if (dayCandles.length < 10) continue;
    
    let buffer: any[] = [...prevCandles];
    let position: any = null;
    let slAfterTime: string | null = null;
    let pullbackState: any = null;
    let entryCount = 0;
    const dayOpen = dayCandles[0]?.open || 0;
    const dayHigh = Math.max(...dayCandles.map(c => c.high));
    const dayLow = Math.min(...dayCandles.map(c => c.low));
    
    for (let i = 0; i < dayCandles.length; i++) {
      const c = dayCandles[i]; buffer.push(c); if (buffer.length > 300) buffer = buffer.slice(-300);
      const time = c.candleTime;
      const [h, m] = time.split(":").map(Number); const timeMin = h*60+m;
      const isAM = timeMin < 688;
      const minutesSinceOpen = timeMin - 570;
      
      // 前場強制決済
      if (position && timeMin >= 687 && timeMin < 750) {
        const pnl = position.side === "short" ? (position.price - c.close) * position.lots : (c.close - position.price) * position.lots;
        const maxFav = position.side === "short" ? (position.price - position.minPrice) / position.price * 100 : (position.maxPrice - position.price) / position.price * 100;
        const maxAdv = position.side === "short" ? (position.maxPrice - position.price) / position.price * 100 : (position.price - position.minPrice) / position.price * 100;
        trades.push({ ...position, date: targetDate, exitTime: time, exitReason: "前場決済", pnl: Math.round(pnl), maxFavorable: maxFav, maxAdverse: maxAdv, holdBars: i - position.entryIdx });
        position = null; pullbackState = null; continue;
      }
      if (position && timeMin >= 925) {
        const pnl = position.side === "short" ? (position.price - c.close) * position.lots : (c.close - position.price) * position.lots;
        const maxFav = position.side === "short" ? (position.price - position.minPrice) / position.price * 100 : (position.maxPrice - position.price) / position.price * 100;
        const maxAdv = position.side === "short" ? (position.maxPrice - position.price) / position.price * 100 : (position.price - position.minPrice) / position.price * 100;
        trades.push({ ...position, date: targetDate, exitTime: time, exitReason: "大引け", pnl: Math.round(pnl), maxFavorable: maxFav, maxAdverse: maxAdv, holdBars: i - position.entryIdx });
        position = null; pullbackState = null; continue;
      }
      if (position) {
        if (c.high > position.maxPrice) position.maxPrice = c.high;
        if (c.low < position.minPrice) position.minPrice = c.low;
        const slPct = position.side === "short" ? SL_MAP[sym]?.short || 0.8 : SL_MAP[sym]?.long || 0.5;
        const tpPct = position.side === "short" ? TP_SHORT : TP_LONG;
        const slPrice = position.side === "short" ? position.price * (1 + slPct/100) : position.price * (1 - slPct/100);
        const tpPrice = position.side === "short" ? position.price * (1 - tpPct/100) : position.price * (1 + tpPct/100);
        if (position.side === "short") {
          if (c.high >= slPrice) { const maxFav = (position.price - position.minPrice) / position.price * 100; const maxAdv = (c.high - position.price) / position.price * 100; trades.push({ ...position, date: targetDate, exitTime: time, exitReason: "SL", pnl: Math.round((position.price - slPrice) * position.lots), maxFavorable: maxFav, maxAdverse: maxAdv, holdBars: i - position.entryIdx }); slAfterTime = time; position = null; continue; }
          if (c.low <= tpPrice) { const maxFav = (position.price - c.low) / position.price * 100; const maxAdv = (position.maxPrice - position.price) / position.price * 100; trades.push({ ...position, date: targetDate, exitTime: time, exitReason: "TP", pnl: Math.round((position.price - tpPrice) * position.lots), maxFavorable: maxFav, maxAdverse: maxAdv, holdBars: i - position.entryIdx }); position = null; continue; }
        } else {
          if (c.low <= slPrice) { const maxFav = (position.maxPrice - position.price) / position.price * 100; const maxAdv = (position.price - c.low) / position.price * 100; trades.push({ ...position, date: targetDate, exitTime: time, exitReason: "SL", pnl: Math.round((slPrice - position.price) * position.lots), maxFavorable: maxFav, maxAdverse: maxAdv, holdBars: i - position.entryIdx }); slAfterTime = time; position = null; continue; }
          if (c.high >= tpPrice) { const maxFav = (c.high - position.price) / position.price * 100; const maxAdv = (position.price - position.minPrice) / position.price * 100; trades.push({ ...position, date: targetDate, exitTime: time, exitReason: "TP", pnl: Math.round((tpPrice - position.price) * position.lots), maxFavorable: maxFav, maxAdverse: maxAdv, holdBars: i - position.entryIdx }); position = null; continue; }
        }
        continue;
      }
      if (pullbackState) {
        pullbackState.waitCount++;
        if (c.low < pullbackState.swingLow) pullbackState = null;
        else if (pullbackState.waitCount > PULLBACK_MAX_WAIT) pullbackState = null;
        else {
          if (!pullbackState.pulledBack && c.close < pullbackState.signalPrice) pullbackState.pulledBack = true;
          if (pullbackState.pulledBack && c.close > pullbackState.signalPrice) {
            entryCount++;
            const vol20 = buffer.length >= 21 ? buffer.slice(-21, -1).reduce((s: number, b: any) => s + b.volume, 0) / 20 : 0;
            const volRatio = vol20 > 0 ? c.volume / vol20 : 0;
            const ma = buffer.slice(-IS_BULLISH_MA_PERIOD).reduce((s: number, b: any) => s + b.close, 0) / IS_BULLISH_MA_PERIOD;
            const prevMa = buffer.slice(-IS_BULLISH_MA_PERIOD-1, -1).reduce((s: number, b: any) => s + b.close, 0) / IS_BULLISH_MA_PERIOD;
            const maSlope = (ma - prevMa) / prevMa * 100;
            const barBody = Math.abs((c.close - c.open) / c.open * 100);
            const bearBars = buffer.slice(-10).filter((b: any) => b.close < b.open).length;
            const recentHigh = Math.max(...buffer.slice(-20).map((b: any) => b.high));
            const recentLow = Math.min(...buffer.slice(-20).map((b: any) => b.low));
            const dropFromHigh = (recentHigh - c.close) / recentHigh * 100;
            const riseFromLow = (c.close - recentLow) / recentLow * 100;
            const prevBar = buffer[buffer.length - 2];
            position = { sym, side: "long", price: c.close, lots: LOTS[sym] || 100, time, method: "押し目確認LONG", volRatio, maSlope, barBody, bearBars, dropFromHigh, riseFromLow, prevBarDir: prevBar.close >= prevBar.open ? "陽" : "陰", minutesSinceOpen: minutesSinceOpen, isAM, entryNumber: entryCount, entryIdx: i, maxPrice: c.high, minPrice: c.low };
            pullbackState = null;
          }
          if (pullbackState) continue;
        }
      }
      if (timeMin < 570 || timeMin >= 905) continue;
      if (timeMin >= 750 && timeMin < 770) continue;
      if (position) continue;
      if (slAfterTime) { const slH = parseInt(slAfterTime.split(":")[0]), slM = parseInt(slAfterTime.split(":")[1]); if (timeMin - (slH*60+slM) < 30) continue; slAfterTime = null; }
      
      let isBullish = false;
      const ma = buffer.length >= IS_BULLISH_MA_PERIOD ? buffer.slice(-IS_BULLISH_MA_PERIOD).reduce((s: number, b: any) => s + b.close, 0) / IS_BULLISH_MA_PERIOD : 0;
      const prevMa = buffer.length >= IS_BULLISH_MA_PERIOD + 1 ? buffer.slice(-IS_BULLISH_MA_PERIOD-1, -1).reduce((s: number, b: any) => s + b.close, 0) / IS_BULLISH_MA_PERIOD : 0;
      const maSlope = prevMa > 0 ? (ma - prevMa) / prevMa * 100 : 0;
      if (buffer.length >= IS_BULLISH_MA_PERIOD + 1) isBullish = maSlope > IS_BULLISH_SLOPE_THRESHOLD;
      if (buffer.length >= 20) { const atr = buffer.slice(-20).reduce((s: number, b: any) => s + (b.high - b.low), 0) / 20; if (atr / c.close * 100 < ATR_FILTER_THRESHOLD) continue; }
      
      const vol20 = buffer.length >= 21 ? buffer.slice(-21, -1).reduce((s: number, b: any) => s + b.volume, 0) / 20 : 0;
      const volRatio = vol20 > 0 ? c.volume / vol20 : 0;
      const barBody = Math.abs((c.close - c.open) / c.open * 100);
      const bearBars = buffer.slice(-10).filter((b: any) => b.close < b.open).length;
      const recentHigh = buffer.length >= 20 ? Math.max(...buffer.slice(-20).map((b: any) => b.high)) : c.high;
      const recentLow = buffer.length >= 20 ? Math.min(...buffer.slice(-20).map((b: any) => b.low)) : c.low;
      const dropFromHigh = (recentHigh - c.close) / recentHigh * 100;
      const riseFromLow = recentLow > 0 ? (c.close - recentLow) / recentLow * 100 : 0;
      const prevBar = buffer.length >= 2 ? buffer[buffer.length - 2] : c;
      const prevBarDir = prevBar.close >= prevBar.open ? "陽" : "陰";
      
      let shortBlocked = false;
      if (!isBullish && buffer.length >= 20) { if (dropFromHigh > SHORT_DROP_FROM_HIGH_MAX) shortBlocked = true; }
      
      // SHORT
      if (!shortBlocked && i > 0 && buffer.length >= 2 && !isBullish) {
        const prev = buffer[buffer.length - 2];
        for (const rl of [100, 500, 1000, 5000, 10000]) {
          const nearestAbove = Math.ceil(prev.close / rl) * rl;
          if (prev.close >= nearestAbove && c.close < nearestAbove && (nearestAbove - c.close) / nearestAbove < 0.008) {
            const prevDist = prev.close > 0 ? (prev.close - nearestAbove) / nearestAbove * 100 : 999;
            let method = "CB2"; if (volRatio >= FAST_ENTRY_VOL_RATIO) method = "即vol"; else if (prevDist <= FAST_ENTRY_PREV_DIST_PCT) method = "即4a";
            entryCount++;
            position = { sym, side: "short", price: c.close, lots: LOTS[sym] || 100, time, method, volRatio, maSlope, barBody, bearBars, dropFromHigh, riseFromLow, prevBarDir, minutesSinceOpen, isAM, entryNumber: entryCount, entryIdx: i, maxPrice: c.high, minPrice: c.low };
            break;
          }
        }
      }
      if (position) continue;
      if (!shortBlocked && buffer.length >= 21 && !isBullish) {
        const minLow = Math.min(...buffer.slice(-21, -1).map((b: any) => b.low));
        if (c.close < minLow) {
          entryCount++;
          const method = volRatio >= SHORT_LOW_BREAK_VOL_RATIO ? "安値更新即" : "ダウ理論SHORT";
          position = { sym, side: "short", price: c.close, lots: LOTS[sym] || 100, time, method, volRatio, maSlope, barBody, bearBars, dropFromHigh, riseFromLow, prevBarDir, minutesSinceOpen, isAM, entryNumber: entryCount, entryIdx: i, maxPrice: c.high, minPrice: c.low };
        }
      }
      if (position) continue;
      // LONG
      if (buffer.length >= 21 && isBullish) {
        const maxHigh = Math.max(...buffer.slice(-21, -1).map((b: any) => b.high));
        if (c.close > maxHigh) {
          const maDeviation = Math.abs((c.close - ma) / ma * 100);
          if (maDeviation < 0.5 && barBody < 0.2 && bearBars <= 4) { entryCount++; position = { sym, side: "long", price: c.close, lots: LOTS[sym] || 100, time, method: "バイパスLONG", volRatio, maSlope, barBody, bearBars, dropFromHigh, riseFromLow, prevBarDir, minutesSinceOpen, isAM, entryNumber: entryCount, entryIdx: i, maxPrice: c.high, minPrice: c.low }; }
          if (!position && isAM && volRatio >= AM_VOL_BREAK_RATIO) { entryCount++; position = { sym, side: "long", price: c.close, lots: LOTS[sym] || 100, time, method: "出来高ブレイク", volRatio, maSlope, barBody, bearBars, dropFromHigh, riseFromLow, prevBarDir, minutesSinceOpen, isAM, entryNumber: entryCount, entryIdx: i, maxPrice: c.high, minPrice: c.low }; }
          if (!position && !pullbackState) { const swingLow = Math.min(...buffer.slice(-20).map((b: any) => b.low)); pullbackState = { signalPrice: c.close, swingLow, waitCount: 0, pulledBack: false }; }
        }
      }
    }
    if (position) {
      const lastC = dayCandles[dayCandles.length - 1];
      const pnl = position.side === "short" ? (position.price - lastC.close) * position.lots : (lastC.close - position.price) * position.lots;
      trades.push({ ...position, date: targetDate, exitTime: "15:30", exitReason: "EOD", pnl: Math.round(pnl), maxFavorable: 0, maxAdverse: 0, holdBars: 0 });
    }
  }
  return trades;
}

async function main() {
  const db = await getDb();
  const allTrades: TradeDetail[] = [];
  allTrades.push(...await simulateWithDetail(db, "2026-08-19", "2026-08-18"));
  allTrades.push(...await simulateWithDetail(db, "2026-08-20", "2026-08-19"));
  
  const wins = allTrades.filter(t => t.pnl > 0);
  const losses = allTrades.filter(t => t.pnl <= 0);
  
  console.log(`=== 2日間 全${allTrades.length}件: ${wins.length}勝${losses.length}敗 ===\n`);
  
  // 方向別
  for (const side of ["short", "long"]) {
    const st = allTrades.filter(t => t.side === side);
    const sw = st.filter(t => t.pnl > 0);
    const sl = st.filter(t => t.pnl <= 0);
    console.log(`\n--- ${side.toUpperCase()} ---`);
    console.log(`プラス${sw.length}件 vs マイナス${sl.length}件\n`);
    
    const metrics = [
      { name: "出来高倍率", key: "volRatio", fmt: (v: number) => v.toFixed(2) + "x" },
      { name: "MA8傾き", key: "maSlope", fmt: (v: number) => v.toFixed(3) + "%" },
      { name: "エントリー足実体", key: "barBody", fmt: (v: number) => v.toFixed(3) + "%" },
      { name: "陰線本数(/10)", key: "bearBars", fmt: (v: number) => v.toFixed(1) },
      { name: "高値からの下落", key: "dropFromHigh", fmt: (v: number) => v.toFixed(2) + "%" },
      { name: "安値からの上昇", key: "riseFromLow", fmt: (v: number) => v.toFixed(2) + "%" },
      { name: "寄り付きからの分数", key: "minutesSinceOpen", fmt: (v: number) => v.toFixed(0) + "分" },
      { name: "保有本数", key: "holdBars", fmt: (v: number) => v.toFixed(1) },
      { name: "最大有利方向%", key: "maxFavorable", fmt: (v: number) => v.toFixed(3) + "%" },
      { name: "最大逆行方向%", key: "maxAdverse", fmt: (v: number) => v.toFixed(3) + "%" },
    ];
    
    console.log(`指標 | プラス平均 | マイナス平均 | 差`);
    console.log(`-----|----------|------------|---`);
    for (const m of metrics) {
      const wAvg = sw.length > 0 ? sw.reduce((s, t) => s + (t as any)[m.key], 0) / sw.length : 0;
      const lAvg = sl.length > 0 ? sl.reduce((s, t) => s + (t as any)[m.key], 0) / sl.length : 0;
      console.log(`${m.name} | ${m.fmt(wAvg)} | ${m.fmt(lAvg)} | ${m.fmt(wAvg - lAvg)}`);
    }
    
    // 方式別
    const methods = [...new Set(st.map(t => t.method))];
    console.log(`\n方式別:`);
    for (const method of methods) {
      const mt = st.filter(t => t.method === method);
      const mw = mt.filter(t => t.pnl > 0);
      console.log(`  ${method}: ${mt.length}件 ${mw.length}勝${mt.length-mw.length}敗 ${mt.reduce((s,t)=>s+t.pnl,0) >= 0 ? "+" : ""}${mt.reduce((s,t)=>s+t.pnl,0).toLocaleString()}円`);
    }
    
    // 時間帯別
    console.log(`\n時間帯別:`);
    const amT = st.filter(t => t.isAM);
    const pmT = st.filter(t => !t.isAM);
    console.log(`  前場: ${amT.length}件 ${amT.filter(t=>t.pnl>0).length}勝 ${amT.reduce((s,t)=>s+t.pnl,0) >= 0 ? "+" : ""}${amT.reduce((s,t)=>s+t.pnl,0).toLocaleString()}円`);
    console.log(`  後場: ${pmT.length}件 ${pmT.filter(t=>t.pnl>0).length}勝 ${pmT.reduce((s,t)=>s+t.pnl,0) >= 0 ? "+" : ""}${pmT.reduce((s,t)=>s+t.pnl,0).toLocaleString()}円`);
    
    // 前足方向別
    console.log(`\n前足方向別:`);
    const yangT = st.filter(t => t.prevBarDir === "陽");
    const yinT = st.filter(t => t.prevBarDir === "陰");
    console.log(`  前足陽線: ${yangT.length}件 ${yangT.filter(t=>t.pnl>0).length}勝 ${yangT.reduce((s,t)=>s+t.pnl,0) >= 0 ? "+" : ""}${yangT.reduce((s,t)=>s+t.pnl,0).toLocaleString()}円`);
    console.log(`  前足陰線: ${yinT.length}件 ${yinT.filter(t=>t.pnl>0).length}勝 ${yinT.reduce((s,t)=>s+t.pnl,0) >= 0 ? "+" : ""}${yinT.reduce((s,t)=>s+t.pnl,0).toLocaleString()}円`);
    
    // エントリー番号別
    console.log(`\nエントリー順番別:`);
    for (let n = 1; n <= 5; n++) {
      const nt = st.filter(t => t.entryNumber === n);
      if (nt.length === 0) continue;
      console.log(`  ${n}回目: ${nt.length}件 ${nt.filter(t=>t.pnl>0).length}勝 ${nt.reduce((s,t)=>s+t.pnl,0) >= 0 ? "+" : ""}${nt.reduce((s,t)=>s+t.pnl,0).toLocaleString()}円`);
    }
    const laterT = st.filter(t => t.entryNumber > 5);
    if (laterT.length > 0) console.log(`  6回目以降: ${laterT.length}件 ${laterT.filter(t=>t.pnl>0).length}勝 ${laterT.reduce((s,t)=>s+t.pnl,0) >= 0 ? "+" : ""}${laterT.reduce((s,t)=>s+t.pnl,0).toLocaleString()}円`);
  }
  
  process.exit(0);
}
main();
