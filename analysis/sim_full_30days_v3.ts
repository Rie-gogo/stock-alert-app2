import { getDb } from "../server/db";
import { sql } from "drizzle-orm";

// 撤廃後の全ロジック30営業日シミュレーション v3
// 現行: 案2撤廃（大台割れisBullish免除なし）+ 前場ブースト撤廃
// 残存: 静かな上昇バイパス(緩和A) + 出来高ブレイクLONG(前場のみ) + 安値更新即(案1) + 3方式SHORT + SHORTスコア0緩和
// LONG TP=0.5%, SHORT TP=1.5%

const IS_BULLISH_MA_PERIOD = 8;
const IS_BULLISH_SLOPE_THRESHOLD = 0;
const FAST_ENTRY_VOL_RATIO = 1.5;
const FAST_ENTRY_PREV_DIST_PCT = 0.05;
const SHORT_LOW_BREAK_VOL_RATIO = 1.2;
const AM_VOL_BREAK_RATIO = 1.5;
const TP_SHORT = 1.5;
const TP_LONG = 0.5;
const ATR_FILTER_THRESHOLD = 0.12;

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

async function main() {
  const db = await getDb();
  const [dates] = await db.execute(sql`SELECT DISTINCT tradeDate FROM rt_candles WHERE symbol='8035' ORDER BY tradeDate DESC LIMIT 31`);
  const tradeDates = (dates as any[]).map(d => d.tradeDate).reverse();
  const simDates = tradeDates.slice(1);
  
  const allTrades: any[] = [];
  
  for (const sym of SYMBOLS) {
    const [rows] = await db.execute(sql`
      SELECT tradeDate, candleTime, open, high, low, close, volume
      FROM rt_candles WHERE symbol=${sym} AND tradeDate>=${tradeDates[0]} ORDER BY tradeDate, candleTime
    `);
    const candles = rows as any[];
    if (candles.length < 50) continue;
    const byDate: Record<string, any[]> = {};
    for (const c of candles) { if (!byDate[c.tradeDate]) byDate[c.tradeDate] = []; byDate[c.tradeDate].push({...c, open:+c.open, high:+c.high, low:+c.low, close:+c.close, volume:+c.volume}); }
    
    let buffer: any[] = byDate[tradeDates[0]] || [];
    
    for (const date of simDates) {
      const dayCandles = byDate[date] || [];
      if (dayCandles.length < 10) continue;
      let position: any = null;
      let slAfterTime: string | null = null;
      
      for (let i = 0; i < dayCandles.length; i++) {
        const c = dayCandles[i]; buffer.push(c); if (buffer.length > 300) buffer = buffer.slice(-300);
        const time = c.candleTime;
        const [h, m] = time.split(":").map(Number); const timeMin = h*60+m;
        const isAM = timeMin < 688;
        
        // 前場強制決済 (11:27)
        if (position && timeMin >= 687 && timeMin < 750) {
          const pnl = position.side === "short" ? (position.price - c.close) * position.lots : (c.close - position.price) * position.lots;
          allTrades.push({ date, sym, ...position, exitTime: time, exitReason: "前場決済", pnl: Math.round(pnl) });
          position = null; continue;
        }
        // 大引け (15:25)
        if (position && timeMin >= 925) {
          const pnl = position.side === "short" ? (position.price - c.close) * position.lots : (c.close - position.price) * position.lots;
          allTrades.push({ date, sym, ...position, exitTime: time, exitReason: "大引け", pnl: Math.round(pnl) });
          position = null; continue;
        }
        // SL/TP
        if (position) {
          const slPct = position.side === "short" ? SL_MAP[sym]?.short || 0.8 : SL_MAP[sym]?.long || 0.5;
          const tpPct = position.side === "short" ? TP_SHORT : TP_LONG;
          const slPrice = position.side === "short" ? position.price * (1 + slPct/100) : position.price * (1 - slPct/100);
          const tpPrice = position.side === "short" ? position.price * (1 - tpPct/100) : position.price * (1 + tpPct/100);
          if (position.side === "short") {
            if (c.high >= slPrice) { allTrades.push({ date, sym, ...position, exitTime: time, exitReason: "SL", pnl: Math.round((position.price - slPrice) * position.lots) }); slAfterTime = time; position = null; continue; }
            if (c.low <= tpPrice) { allTrades.push({ date, sym, ...position, exitTime: time, exitReason: "TP", pnl: Math.round((position.price - tpPrice) * position.lots) }); position = null; continue; }
          } else {
            if (c.low <= slPrice) { allTrades.push({ date, sym, ...position, exitTime: time, exitReason: "SL", pnl: Math.round((slPrice - position.price) * position.lots) }); slAfterTime = time; position = null; continue; }
            if (c.high >= tpPrice) { allTrades.push({ date, sym, ...position, exitTime: time, exitReason: "TP", pnl: Math.round((tpPrice - position.price) * position.lots) }); position = null; continue; }
          }
          continue;
        }
        if (timeMin < 570 || timeMin >= 905) continue;
        if (timeMin >= 750 && timeMin < 770) continue; // 12:30-12:50禁止
        if (position) continue;
        if (slAfterTime) {
          const slH = parseInt(slAfterTime.split(":")[0]), slM = parseInt(slAfterTime.split(":")[1]);
          if (timeMin - (slH*60+slM) < 30) continue;
          slAfterTime = null;
        }
        
        // isBullish
        const maPeriod = IS_BULLISH_MA_PERIOD;
        let isBullish = false;
        if (buffer.length >= maPeriod + 1) {
          const ma = buffer.slice(-maPeriod).reduce((s: number, b: any) => s + b.close, 0) / maPeriod;
          const prevMa = buffer.slice(-maPeriod-1, -1).reduce((s: number, b: any) => s + b.close, 0) / maPeriod;
          isBullish = ((ma - prevMa) / prevMa * 100) > IS_BULLISH_SLOPE_THRESHOLD;
        }
        // ATR
        if (buffer.length >= 20) {
          const atrBuf = buffer.slice(-20);
          const atr = atrBuf.reduce((s: number, b: any) => s + (b.high - b.low), 0) / 20;
          if (atr / c.close * 100 < ATR_FILTER_THRESHOLD) continue;
        }
        
        // === SHORT（isBullish免除なし = 撤廃後） ===
        // 大台割れSHORT
        if (i > 0 && buffer.length >= 2 && !isBullish) {
          const prev = buffer[buffer.length - 2];
          for (const rl of [100, 500, 1000, 5000, 10000]) {
            const nearestAbove = Math.ceil(prev.close / rl) * rl;
            if (prev.close >= nearestAbove && c.close < nearestAbove && (nearestAbove - c.close) / nearestAbove < 0.008) {
              const vol20 = buffer.length >= 21 ? buffer.slice(-21, -1).reduce((s: number, b: any) => s + b.volume, 0) / 20 : 0;
              const volRatio = vol20 > 0 ? c.volume / vol20 : 0;
              const prevDist = prev.close > 0 ? (prev.close - nearestAbove) / nearestAbove * 100 : 999;
              let method = "CB2";
              if (volRatio >= FAST_ENTRY_VOL_RATIO) method = "即vol";
              else if (prevDist <= FAST_ENTRY_PREV_DIST_PCT) method = "即4a";
              position = { side: "short", price: c.close, lots: LOTS[sym] || 100, time, method, signal: "大台割れ" };
              break;
            }
          }
        }
        if (position) continue;
        
        // ダウ理論SHORT + 安値更新即(案1)
        if (buffer.length >= 21 && !isBullish) {
          const minLow = Math.min(...buffer.slice(-21, -1).map((b: any) => b.low));
          if (c.close < minLow) {
            const vol20 = buffer.slice(-21, -1).reduce((s: number, b: any) => s + b.volume, 0) / 20;
            const volRatio = vol20 > 0 ? c.volume / vol20 : 0;
            const method = volRatio >= SHORT_LOW_BREAK_VOL_RATIO ? "安値更新即" : "ダウ理論";
            position = { side: "short", price: c.close, lots: LOTS[sym] || 100, time, method, signal: "ダウ理論SHORT" };
          }
        }
        if (position) continue;
        
        // === LONG ===
        if (buffer.length >= 21 && isBullish) {
          const maxHigh = Math.max(...buffer.slice(-21, -1).map((b: any) => b.high));
          if (c.close > maxHigh) {
            const ma = buffer.slice(-maPeriod).reduce((s: number, b: any) => s + b.close, 0) / maPeriod;
            const maDeviation = Math.abs((c.close - ma) / ma * 100);
            const barBody = Math.abs((c.close - c.open) / c.open * 100);
            const bearBars = buffer.slice(-10).filter((b: any) => b.close < b.open).length;
            
            // 静かな上昇バイパス(緩和A)
            if (maDeviation < 0.5 && barBody < 0.2 && bearBars <= 4) {
              position = { side: "long", price: c.close, lots: LOTS[sym] || 100, time, method: "バイパスLONG", signal: "静かな上昇" };
            }
            // 出来高ブレイクLONG（前場のみ）
            if (!position && isAM) {
              const vol20 = buffer.slice(-21, -1).reduce((s: number, b: any) => s + b.volume, 0) / 20;
              const volRatio = vol20 > 0 ? c.volume / vol20 : 0;
              if (volRatio >= AM_VOL_BREAK_RATIO) {
                position = { side: "long", price: c.close, lots: LOTS[sym] || 100, time, method: "出来高ブレイク", signal: "出来高ブレイク" };
              }
            }
          }
        }
      }
      if (position) {
        const lastC = dayCandles[dayCandles.length - 1];
        const pnl = position.side === "short" ? (position.price - lastC.close) * position.lots : (lastC.close - position.price) * position.lots;
        allTrades.push({ date, sym, ...position, exitTime: "15:30", exitReason: "EOD", pnl: Math.round(pnl) });
        position = null;
      }
      buffer = dayCandles.slice(-100);
    }
  }
  
  // === 集計 ===
  const wins = allTrades.filter(t => t.pnl > 0);
  const losses = allTrades.filter(t => t.pnl <= 0);
  const totalPnl = allTrades.reduce((s, t) => s + t.pnl, 0);
  const shortTrades = allTrades.filter(t => t.side === "short");
  const longTrades = allTrades.filter(t => t.side === "long");
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const pf = grossLoss > 0 ? grossProfit / grossLoss : 999;
  
  console.log(`=== 撤廃後 全ロジック30営業日シミュレーション ===\n`);
  console.log(`全体: ${allTrades.length}件 ${wins.length}勝${losses.length}敗 勝率${(wins.length/allTrades.length*100).toFixed(1)}% ${totalPnl >= 0 ? "+" : ""}${totalPnl.toLocaleString()}円 PF${pf.toFixed(2)}`);
  console.log(`SHORT: ${shortTrades.length}件 ${shortTrades.filter(t=>t.pnl>0).length}勝 ${shortTrades.reduce((s,t)=>s+t.pnl,0) >= 0 ? "+" : ""}${shortTrades.reduce((s,t)=>s+t.pnl,0).toLocaleString()}円`);
  console.log(`LONG: ${longTrades.length}件 ${longTrades.filter(t=>t.pnl>0).length}勝 ${longTrades.reduce((s,t)=>s+t.pnl,0) >= 0 ? "+" : ""}${longTrades.reduce((s,t)=>s+t.pnl,0).toLocaleString()}円`);
  console.log(`1日平均: ${Math.round(totalPnl/30).toLocaleString()}円/日\n`);
  
  // 方式別
  console.log(`--- 方式別 ---`);
  const methods = [...new Set(allTrades.map(t => t.method))].sort();
  for (const m of methods) {
    const mt = allTrades.filter(t => t.method === m);
    const mw = mt.filter(t => t.pnl > 0).length;
    const mp = mt.reduce((s, t) => s + t.pnl, 0);
    const mgp = mt.filter(t=>t.pnl>0).reduce((s,t)=>s+t.pnl,0);
    const mgl = Math.abs(mt.filter(t=>t.pnl<=0).reduce((s,t)=>s+t.pnl,0));
    const mpf = mgl > 0 ? mgp / mgl : 999;
    console.log(`  ${m}: ${mt.length}件 ${mw}勝${mt.length-mw}敗 勝率${(mw/mt.length*100).toFixed(1)}% ${mp >= 0 ? "+" : ""}${mp.toLocaleString()}円 PF${mpf.toFixed(2)}`);
  }
  
  // 日別
  console.log(`\n--- 日別 ---`);
  const allDates = [...new Set(allTrades.map(t => t.date))].sort();
  let plusDays = 0, minusDays = 0;
  const dayOfWeek = ["日", "月", "火", "水", "木", "金", "土"];
  for (const d of allDates) {
    const dt = allTrades.filter(t => t.date === d);
    const dp = dt.reduce((s, t) => s + t.pnl, 0);
    const dw = dt.filter(t => t.pnl > 0).length;
    const ds = dt.filter(t => t.side === "short").reduce((s, t) => s + t.pnl, 0);
    const dl = dt.filter(t => t.side === "long").reduce((s, t) => s + t.pnl, 0);
    const dateObj = new Date(d + "T00:00:00+09:00");
    const dow = dayOfWeek[dateObj.getDay()];
    if (dp > 0) plusDays++; else minusDays++;
    console.log(`  ${d}（${dow}） ${dt.length}件 ${dw}勝${dt.length-dw}敗 ${dp >= 0 ? "+" : ""}${dp.toLocaleString()}円 (S:${ds >= 0 ? "+" : ""}${ds.toLocaleString()} L:${dl >= 0 ? "+" : ""}${dl.toLocaleString()})`);
  }
  console.log(`  プラス日: ${plusDays}日 / マイナス日: ${minusDays}日`);
  
  // 銘柄別
  console.log(`\n--- 銘柄別 ---`);
  for (const sym of SYMBOLS) {
    const st = allTrades.filter(t => t.sym === sym);
    if (st.length === 0) continue;
    const sp = st.reduce((s, t) => s + t.pnl, 0);
    const sw = st.filter(t => t.pnl > 0).length;
    const ss = st.filter(t => t.side === "short").reduce((s, t) => s + t.pnl, 0);
    const sl = st.filter(t => t.side === "long").reduce((s, t) => s + t.pnl, 0);
    console.log(`  ${sym}: ${st.length}件 ${sw}勝${st.length-sw}敗 ${sp >= 0 ? "+" : ""}${sp.toLocaleString()}円 (S:${ss >= 0 ? "+" : ""}${ss.toLocaleString()} L:${sl >= 0 ? "+" : ""}${sl.toLocaleString()})`);
  }
  
  // 前場/後場
  const amTrades = allTrades.filter(t => { const [h,m] = t.time.split(":").map(Number); return h*60+m < 688; });
  const pmTrades = allTrades.filter(t => { const [h,m] = t.time.split(":").map(Number); return h*60+m >= 750; });
  console.log(`\n--- 前場/後場 ---`);
  console.log(`  前場: ${amTrades.length}件 ${amTrades.filter(t=>t.pnl>0).length}勝 ${amTrades.reduce((s,t)=>s+t.pnl,0) >= 0 ? "+" : ""}${amTrades.reduce((s,t)=>s+t.pnl,0).toLocaleString()}円`);
  console.log(`  後場: ${pmTrades.length}件 ${pmTrades.filter(t=>t.pnl>0).length}勝 ${pmTrades.reduce((s,t)=>s+t.pnl,0) >= 0 ? "+" : ""}${pmTrades.reduce((s,t)=>s+t.pnl,0).toLocaleString()}円`);
  
  process.exit(0);
}
main();
