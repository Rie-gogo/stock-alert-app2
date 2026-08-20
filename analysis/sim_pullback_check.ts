import { getDb } from "../server/db";
import { sql } from "drizzle-orm";

// LONGの押し目確認ステートマシンの必要性と適正値を検証
// 現行: ダウ理論高値更新 → 押し目確認（一度下がって再上昇）→ エントリー
// 検証: 押し目確認なし（即エントリー）vs 現行 vs パラメータ変更

const IS_BULLISH_MA_PERIOD = 8;
const IS_BULLISH_SLOPE_THRESHOLD = 0;
const TP_LONG = 0.5;
const ATR_FILTER_THRESHOLD = 0.12;
const SHORT_DROP_FROM_HIGH_MAX = 1.5;

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

interface Trade { date: string; sym: string; price: number; lots: number; time: string; method: string; exitTime: string; exitReason: string; pnl: number; }

async function simulateLong(db: any, simDates: string[], tradeDates: string[], opts: {
  pullbackMode: "none" | "current" | "relaxed" | "strict";
  maxWait?: number;
  depthMin?: number;
  depthMax?: number;
}): Promise<Trade[]> {
  const allTrades: Trade[] = [];
  const PULLBACK_MAX_WAIT = opts.maxWait ?? 5;
  const DEPTH_MIN = opts.depthMin ?? 0.30;
  const DEPTH_MAX = opts.depthMax ?? 0.70;
  
  for (const sym of SYMBOLS) {
    const [rows] = await db.execute(sql`
      SELECT tradeDate, candleTime, open, high, low, close, volume
      FROM rt_candles WHERE symbol=${sym} AND tradeDate>=${tradeDates[0]} ORDER BY tradeDate, candleTime
    `);
    const candles = (rows as any[]).map((r: any) => ({...r, open:+r.open, high:+r.high, low:+r.low, close:+r.close, volume:+r.volume}));
    if (candles.length < 50) continue;
    const byDate: Record<string, any[]> = {};
    for (const c of candles) { if (!byDate[c.tradeDate]) byDate[c.tradeDate] = []; byDate[c.tradeDate].push(c); }
    
    let buffer: any[] = byDate[tradeDates[0]] || [];
    
    for (const date of simDates) {
      const dayCandles = byDate[date] || [];
      if (dayCandles.length < 10) continue;
      let position: any = null;
      let slAfterTime: string | null = null;
      
      // 押し目確認ステート
      let pullbackState: { signalPrice: number; swingLow: number; waitCount: number; pulledBack: boolean; reason: string } | null = null;
      
      for (let i = 0; i < dayCandles.length; i++) {
        const c = dayCandles[i]; buffer.push(c); if (buffer.length > 300) buffer = buffer.slice(-300);
        const time = c.candleTime;
        const [h, m] = time.split(":").map(Number); const timeMin = h*60+m;
        const isAM = timeMin < 688;
        
        // 前場強制決済
        if (position && timeMin >= 687 && timeMin < 750) {
          const pnl = (c.close - position.price) * position.lots;
          allTrades.push({ date, sym, ...position, exitTime: time, exitReason: "前場決済", pnl: Math.round(pnl) });
          position = null; continue;
        }
        if (position && timeMin >= 925) {
          const pnl = (c.close - position.price) * position.lots;
          allTrades.push({ date, sym, ...position, exitTime: time, exitReason: "大引け", pnl: Math.round(pnl) });
          position = null; continue;
        }
        if (position) {
          const slPct = SL_MAP[sym]?.long || 0.5;
          const slPrice = position.price * (1 - slPct/100);
          const tpPrice = position.price * (1 + TP_LONG/100);
          if (c.low <= slPrice) { allTrades.push({ date, sym, ...position, exitTime: time, exitReason: "SL", pnl: Math.round((slPrice - position.price) * position.lots) }); slAfterTime = time; position = null; continue; }
          if (c.high >= tpPrice) { allTrades.push({ date, sym, ...position, exitTime: time, exitReason: "TP", pnl: Math.round((tpPrice - position.price) * position.lots) }); position = null; continue; }
          continue;
        }
        
        // 押し目確認ステートマシン処理
        if (pullbackState && opts.pullbackMode !== "none") {
          pullbackState.waitCount++;
          if (c.low < pullbackState.swingLow) { pullbackState = null; continue; }
          if (pullbackState.waitCount > PULLBACK_MAX_WAIT) { pullbackState = null; continue; }
          if (!pullbackState.pulledBack && c.close < pullbackState.signalPrice) pullbackState.pulledBack = true;
          if (pullbackState.pulledBack && c.close > pullbackState.signalPrice) {
            position = { side: "long", price: c.close, lots: LOTS[sym] || 100, time, method: "押し目確認LONG" };
            pullbackState = null;
          }
          continue;
        }
        
        if (timeMin < 570 || timeMin >= 905) continue;
        if (timeMin >= 750 && timeMin < 770) continue;
        if (position) continue;
        if (slAfterTime) {
          const slH = parseInt(slAfterTime.split(":")[0]), slM = parseInt(slAfterTime.split(":")[1]);
          if (timeMin - (slH*60+slM) < 30) continue;
          slAfterTime = null;
        }
        
        // isBullish
        let isBullish = false;
        if (buffer.length >= IS_BULLISH_MA_PERIOD + 1) {
          const ma = buffer.slice(-IS_BULLISH_MA_PERIOD).reduce((s: number, b: any) => s + b.close, 0) / IS_BULLISH_MA_PERIOD;
          const prevMa = buffer.slice(-IS_BULLISH_MA_PERIOD-1, -1).reduce((s: number, b: any) => s + b.close, 0) / IS_BULLISH_MA_PERIOD;
          isBullish = ((ma - prevMa) / prevMa * 100) > IS_BULLISH_SLOPE_THRESHOLD;
        }
        if (!isBullish) continue;
        
        // 直近高値更新
        if (buffer.length >= 21) {
          const maxHigh = Math.max(...buffer.slice(-21, -1).map((b: any) => b.high));
          if (c.close > maxHigh) {
            // 押し目深さフィルター
            if (buffer.length >= 20) {
              const lookback = buffer.slice(-20);
              const swingHigh = Math.max(...lookback.map((b: any) => b.high));
              const swingLow = Math.min(...lookback.map((b: any) => b.low));
              if (swingHigh > swingLow) {
                const depth = (swingHigh - c.close) / (swingHigh - swingLow);
                if (depth < DEPTH_MIN || depth > DEPTH_MAX) continue;
              }
            }
            
            if (opts.pullbackMode === "none") {
              // 即エントリー（押し目確認なし）
              position = { side: "long", price: c.close, lots: LOTS[sym] || 100, time, method: "即LONG(押し目なし)" };
            } else {
              // 押し目確認ステートマシンに登録
              const swingLow = Math.min(...buffer.slice(-20).map((b: any) => b.low));
              pullbackState = { signalPrice: c.close, swingLow, waitCount: 0, pulledBack: false, reason: "ダウ理論高値更新" };
            }
          }
        }
      }
      if (position) {
        const lastC = dayCandles[dayCandles.length - 1];
        const pnl = (lastC.close - position.price) * position.lots;
        allTrades.push({ date, sym, ...position, exitTime: "15:30", exitReason: "EOD", pnl: Math.round(pnl) });
        position = null;
      }
      buffer = dayCandles.slice(-100);
      pullbackState = null;
    }
  }
  return allTrades;
}

function report(label: string, trades: Trade[], days: number) {
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const total = trades.reduce((s, t) => s + t.pnl, 0);
  const gp = wins.reduce((s, t) => s + t.pnl, 0);
  const gl = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const pf = gl > 0 ? gp / gl : 999;
  const tpCount = trades.filter(t => t.exitReason === "TP").length;
  const slCount = trades.filter(t => t.exitReason === "SL").length;
  console.log(`[${label}]`);
  console.log(`  ${trades.length}件 ${wins.length}勝${losses.length}敗 勝率${(wins.length/trades.length*100).toFixed(1)}% ${total >= 0 ? "+" : ""}${total.toLocaleString()}円 PF${pf.toFixed(2)}`);
  console.log(`  TP到達: ${tpCount}件(${(tpCount/trades.length*100).toFixed(0)}%) SL到達: ${slCount}件(${(slCount/trades.length*100).toFixed(0)}%) 1日平均: ${Math.round(total/days).toLocaleString()}円`);
}

async function main() {
  const db = await getDb();
  const [dates] = await db.execute(sql`SELECT DISTINCT tradeDate FROM rt_candles WHERE symbol='8035' ORDER BY tradeDate DESC LIMIT 31`);
  const tradeDates = (dates as any[]).map(d => d.tradeDate).reverse();
  const simDates = tradeDates.slice(1);
  const days = simDates.length;
  
  console.log(`=== LONG押し目確認ステートマシン検証 (${simDates[0]}〜${simDates[simDates.length-1]}, ${days}営業日) ===\n`);
  
  // 現行: 押し目確認あり（MAX_WAIT=5, DEPTH 30-70%）
  const current = await simulateLong(db, simDates, tradeDates, { pullbackMode: "current", maxWait: 5, depthMin: 0.30, depthMax: 0.70 });
  report("現行: 押し目確認あり (WAIT=5, DEPTH 30-70%)", current, days);
  
  // 押し目確認なし（即エントリー）
  const noWait = await simulateLong(db, simDates, tradeDates, { pullbackMode: "none" });
  report("案A: 押し目確認なし（即エントリー）", noWait, days);
  
  // WAIT=3に短縮
  const wait3 = await simulateLong(db, simDates, tradeDates, { pullbackMode: "current", maxWait: 3, depthMin: 0.30, depthMax: 0.70 });
  report("案B: WAIT=3に短縮", wait3, days);
  
  // WAIT=2に短縮
  const wait2 = await simulateLong(db, simDates, tradeDates, { pullbackMode: "current", maxWait: 2, depthMin: 0.30, depthMax: 0.70 });
  report("案C: WAIT=2に短縮", wait2, days);
  
  // 深さフィルター緩和（10-90%）
  const relaxed = await simulateLong(db, simDates, tradeDates, { pullbackMode: "current", maxWait: 5, depthMin: 0.10, depthMax: 0.90 });
  report("案D: 深さフィルター緩和 (10-90%)", relaxed, days);
  
  // 深さフィルターなし（0-100%）
  const noDepth = await simulateLong(db, simDates, tradeDates, { pullbackMode: "current", maxWait: 5, depthMin: 0.0, depthMax: 1.0 });
  report("案E: 深さフィルターなし", noDepth, days);
  
  // 即エントリー + 深さフィルターなし
  const noAll = await simulateLong(db, simDates, tradeDates, { pullbackMode: "none", depthMin: 0.0, depthMax: 1.0 });
  report("案F: 即エントリー + 深さフィルターなし", noAll, days);
  
  // WAIT=3 + 深さフィルター緩和
  const wait3relaxed = await simulateLong(db, simDates, tradeDates, { pullbackMode: "current", maxWait: 3, depthMin: 0.10, depthMax: 0.90 });
  report("案G: WAIT=3 + 深さ緩和(10-90%)", wait3relaxed, days);
  
  process.exit(0);
}
main();
