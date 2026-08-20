import { getDb } from "../server/db";
import { sql } from "drizzle-orm";

// 高値下落フィルターのルックバック期間の最適値検証
// 直近N本の高値から1.5%以上下落済みならSHORTブロック

const IS_BULLISH_MA_PERIOD = 8;
const IS_BULLISH_SLOPE_THRESHOLD = 0;
const FAST_ENTRY_VOL_RATIO = 1.5;
const FAST_ENTRY_PREV_DIST_PCT = 0.05;
const SHORT_LOW_BREAK_VOL_RATIO = 1.2;
const AM_VOL_BREAK_RATIO = 1.5;
const TP_SHORT = 1.5;
const TP_LONG = 0.5;
const ATR_FILTER_THRESHOLD = 0.12;
const SHORT_DROP_FROM_HIGH_MAX = 1.5;
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

async function simulate(db: any, simDates: string[], tradeDates: string[], lookback: number): Promise<any[]> {
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
      let pullbackState: any = null;
      for (let i = 0; i < dayCandles.length; i++) {
        const c = dayCandles[i]; buffer.push(c); if (buffer.length > 300) buffer = buffer.slice(-300);
        const time = c.candleTime;
        const [h, m] = time.split(":").map(Number); const timeMin = h*60+m;
        const isAM = timeMin < 688;
        if (position && timeMin >= 687 && timeMin < 750) {
          const pnl = position.side === "short" ? (position.price - c.close) * position.lots : (c.close - position.price) * position.lots;
          allTrades.push({ date, sym, ...position, exitTime: time, exitReason: "前場決済", pnl: Math.round(pnl) }); position = null; pullbackState = null; continue;
        }
        if (position && timeMin >= 925) {
          const pnl = position.side === "short" ? (position.price - c.close) * position.lots : (c.close - position.price) * position.lots;
          allTrades.push({ date, sym, ...position, exitTime: time, exitReason: "大引け", pnl: Math.round(pnl) }); position = null; pullbackState = null; continue;
        }
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
        if (pullbackState) {
          pullbackState.waitCount++;
          if (c.low < pullbackState.swingLow) { pullbackState = null; }
          else if (pullbackState.waitCount > PULLBACK_MAX_WAIT) { pullbackState = null; }
          else {
            if (!pullbackState.pulledBack && c.close < pullbackState.signalPrice) pullbackState.pulledBack = true;
            if (pullbackState.pulledBack && c.close > pullbackState.signalPrice) {
              position = { sym, side: "long", price: c.close, lots: LOTS[sym] || 100, time, method: "押し目確認LONG" }; pullbackState = null;
            }
            if (pullbackState) continue;
          }
        }
        if (timeMin < 570 || timeMin >= 905) continue;
        if (timeMin >= 750 && timeMin < 770) continue;
        if (position) continue;
        if (slAfterTime) { const slH = parseInt(slAfterTime.split(":")[0]), slM = parseInt(slAfterTime.split(":")[1]); if (timeMin - (slH*60+slM) < 30) continue; slAfterTime = null; }
        let isBullish = false;
        if (buffer.length >= IS_BULLISH_MA_PERIOD + 1) {
          const ma = buffer.slice(-IS_BULLISH_MA_PERIOD).reduce((s: number, b: any) => s + b.close, 0) / IS_BULLISH_MA_PERIOD;
          const prevMa = buffer.slice(-IS_BULLISH_MA_PERIOD-1, -1).reduce((s: number, b: any) => s + b.close, 0) / IS_BULLISH_MA_PERIOD;
          isBullish = ((ma - prevMa) / prevMa * 100) > IS_BULLISH_SLOPE_THRESHOLD;
        }
        if (buffer.length >= 20) { const atrBuf = buffer.slice(-20); const atr = atrBuf.reduce((s: number, b: any) => s + (b.high - b.low), 0) / 20; if (atr / c.close * 100 < ATR_FILTER_THRESHOLD) continue; }
        
        // SHORT: 高値下落フィルター
        let shortBlocked = false;
        if (!isBullish && buffer.length >= lookback) {
          const recentHigh = Math.max(...buffer.slice(-lookback).map((b: any) => b.high));
          const dropPct = (recentHigh - c.close) / recentHigh * 100;
          if (dropPct > SHORT_DROP_FROM_HIGH_MAX) shortBlocked = true;
        }
        
        if (!shortBlocked && i > 0 && buffer.length >= 2 && !isBullish) {
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
              position = { sym, side: "short", price: c.close, lots: LOTS[sym] || 100, time, method }; break;
            }
          }
        }
        if (position) continue;
        if (!shortBlocked && buffer.length >= 21 && !isBullish) {
          const minLow = Math.min(...buffer.slice(-21, -1).map((b: any) => b.low));
          if (c.close < minLow) {
            const vol20 = buffer.slice(-21, -1).reduce((s: number, b: any) => s + b.volume, 0) / 20;
            const volRatio = vol20 > 0 ? c.volume / vol20 : 0;
            position = { sym, side: "short", price: c.close, lots: LOTS[sym] || 100, time, method: volRatio >= SHORT_LOW_BREAK_VOL_RATIO ? "安値更新即" : "ダウ理論SHORT" };
          }
        }
        if (position) continue;
        if (buffer.length >= 21 && isBullish) {
          const maxHigh = Math.max(...buffer.slice(-21, -1).map((b: any) => b.high));
          if (c.close > maxHigh) {
            const ma = buffer.slice(-IS_BULLISH_MA_PERIOD).reduce((s: number, b: any) => s + b.close, 0) / IS_BULLISH_MA_PERIOD;
            const maDeviation = Math.abs((c.close - ma) / ma * 100);
            const barBody = Math.abs((c.close - c.open) / c.open * 100);
            const bearBars = buffer.slice(-10).filter((b: any) => b.close < b.open).length;
            if (maDeviation < 0.5 && barBody < 0.2 && bearBars <= 4) position = { sym, side: "long", price: c.close, lots: LOTS[sym] || 100, time, method: "バイパスLONG" };
            if (!position && isAM) { const vol20 = buffer.slice(-21, -1).reduce((s: number, b: any) => s + b.volume, 0) / 20; const volRatio = vol20 > 0 ? c.volume / vol20 : 0; if (volRatio >= AM_VOL_BREAK_RATIO) position = { sym, side: "long", price: c.close, lots: LOTS[sym] || 100, time, method: "出来高ブレイク" }; }
            if (!position && !pullbackState) { const swingLow = Math.min(...buffer.slice(-20).map((b: any) => b.low)); pullbackState = { signalPrice: c.close, swingLow, waitCount: 0, pulledBack: false }; }
          }
        }
      }
      if (position) { const lastC = dayCandles[dayCandles.length - 1]; const pnl = position.side === "short" ? (position.price - lastC.close) * position.lots : (lastC.close - position.price) * position.lots; allTrades.push({ date, sym, ...position, exitTime: "15:30", exitReason: "EOD", pnl: Math.round(pnl) }); }
      buffer = dayCandles.slice(-100); pullbackState = null;
    }
  }
  return allTrades;
}

async function main() {
  const db = await getDb();
  const [dates] = await db.execute(sql`SELECT DISTINCT tradeDate FROM rt_candles WHERE symbol='8035' ORDER BY tradeDate DESC LIMIT 31`);
  const tradeDates = (dates as any[]).map((d: any) => d.tradeDate).reverse();
  const simDates = tradeDates.slice(1);
  const days = simDates.length;
  
  console.log(`期間: ${simDates[0]}〜${simDates[simDates.length-1]} (${days}営業日)\n`);
  console.log(`ルックバック | 件数 | 勝率 | 損益 | PF | SHORT件数 | SHORT損益 | LONG損益 | 1日平均 | +日/-日`);
  console.log(`------------|------|------|------|-----|----------|----------|---------|--------|-------`);
  
  for (const lb of [5, 8, 10, 15, 20, 25, 30, 40, 50]) {
    const trades = await simulate(db, simDates, tradeDates, lb);
    const wins = trades.filter((t: any) => t.pnl > 0);
    const total = trades.reduce((s: number, t: any) => s + t.pnl, 0);
    const gp = wins.reduce((s: number, t: any) => s + t.pnl, 0);
    const gl = Math.abs(trades.filter((t: any) => t.pnl <= 0).reduce((s: number, t: any) => s + t.pnl, 0));
    const pf = gl > 0 ? gp / gl : 999;
    const shortT = trades.filter((t: any) => t.side === "short");
    const longT = trades.filter((t: any) => t.side === "long");
    const sPnl = shortT.reduce((s: number, t: any) => s + t.pnl, 0);
    const lPnl = longT.reduce((s: number, t: any) => s + t.pnl, 0);
    const allDates = [...new Set(trades.map((t: any) => t.date))];
    let plusDays = 0, minusDays = 0;
    for (const d of allDates) { const dp = trades.filter((t: any) => t.date === d).reduce((s: number, t: any) => s + t.pnl, 0); if (dp > 0) plusDays++; else minusDays++; }
    
    console.log(`${String(lb).padStart(11)} | ${trades.length} | ${(wins.length/trades.length*100).toFixed(1)}% | ${total >= 0 ? "+" : ""}${total.toLocaleString()} | ${pf.toFixed(2)} | ${shortT.length} | ${sPnl >= 0 ? "+" : ""}${sPnl.toLocaleString()} | ${lPnl >= 0 ? "+" : ""}${lPnl.toLocaleString()} | ${Math.round(total/days).toLocaleString()} | ${plusDays}/${minusDays}`);
  }
  
  // フィルターなしも比較
  // lookback=1は実質フィルターなし（1本の高値からの下落は常に0%）
  const noFilter = await simulate(db, simDates, tradeDates, 1);
  const nfTotal = noFilter.reduce((s: number, t: any) => s + t.pnl, 0);
  const nfWins = noFilter.filter((t: any) => t.pnl > 0);
  const nfGp = nfWins.reduce((s: number, t: any) => s + t.pnl, 0);
  const nfGl = Math.abs(noFilter.filter((t: any) => t.pnl <= 0).reduce((s: number, t: any) => s + t.pnl, 0));
  const nfPf = nfGl > 0 ? nfGp / nfGl : 999;
  const nfShort = noFilter.filter((t: any) => t.side === "short");
  const nfLong = noFilter.filter((t: any) => t.side === "long");
  console.log(`   なし(1) | ${noFilter.length} | ${(nfWins.length/noFilter.length*100).toFixed(1)}% | ${nfTotal >= 0 ? "+" : ""}${nfTotal.toLocaleString()} | ${nfPf.toFixed(2)} | ${nfShort.length} | ${nfShort.reduce((s: number,t: any)=>s+t.pnl,0) >= 0 ? "+" : ""}${nfShort.reduce((s: number,t: any)=>s+t.pnl,0).toLocaleString()} | ${nfLong.reduce((s: number,t: any)=>s+t.pnl,0) >= 0 ? "+" : ""}${nfLong.reduce((s: number,t: any)=>s+t.pnl,0).toLocaleString()} | ${Math.round(nfTotal/days).toLocaleString()} | -`);
  
  process.exit(0);
}
main();
