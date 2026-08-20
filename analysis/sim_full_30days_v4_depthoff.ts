import { getDb } from "../server/db";
import { sql } from "drizzle-orm";

// 全ロジック30営業日シミュレーション v4
// 変更点: 案E（ダウ理論LONG押し目深さフィルター撤廃 + 押し目確認維持）を組み込み
// 比較: 現行（深さ30-70%で事実上0件）vs 案E（深さフィルターなし）
// 高値下落<1.5%フィルターも含む

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

async function simulate(db: any, simDates: string[], tradeDates: string[], useDepthFilter: boolean): Promise<any[]> {
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
      
      // ダウ理論LONG押し目確認ステート
      let pullbackState: { signalPrice: number; swingLow: number; waitCount: number; pulledBack: boolean; reason: string } | null = null;
      
      for (let i = 0; i < dayCandles.length; i++) {
        const c = dayCandles[i]; buffer.push(c); if (buffer.length > 300) buffer = buffer.slice(-300);
        const time = c.candleTime;
        const [h, m] = time.split(":").map(Number); const timeMin = h*60+m;
        const isAM = timeMin < 688;
        
        // 前場強制決済 (11:27)
        if (position && timeMin >= 687 && timeMin < 750) {
          const pnl = position.side === "short" ? (position.price - c.close) * position.lots : (c.close - position.price) * position.lots;
          allTrades.push({ date, sym, ...position, exitTime: time, exitReason: "前場決済", pnl: Math.round(pnl) });
          position = null; pullbackState = null; continue;
        }
        // 大引け (15:25)
        if (position && timeMin >= 925) {
          const pnl = position.side === "short" ? (position.price - c.close) * position.lots : (c.close - position.price) * position.lots;
          allTrades.push({ date, sym, ...position, exitTime: time, exitReason: "大引け", pnl: Math.round(pnl) });
          position = null; pullbackState = null; continue;
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
        
        // ★ 押し目確認ステートマシン処理（ダウ理論LONG）
        if (pullbackState) {
          pullbackState.waitCount++;
          if (c.low < pullbackState.swingLow) { pullbackState = null; /* キャンセル: 安値割れ */ }
          else if (pullbackState.waitCount > PULLBACK_MAX_WAIT) { pullbackState = null; /* キャンセル: タイムアウト */ }
          else {
            if (!pullbackState.pulledBack && c.close < pullbackState.signalPrice) pullbackState.pulledBack = true;
            if (pullbackState.pulledBack && c.close > pullbackState.signalPrice) {
              // 押し目確認完了 → エントリー
              position = { side: "long", price: c.close, lots: LOTS[sym] || 100, time, method: "押し目確認LONG", signal: "ダウ理論高値更新" };
              pullbackState = null;
            }
            if (pullbackState) continue; // まだ待機中
          }
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
        
        // === SHORT ===
        // 高値下落フィルター
        let shortBlocked = false;
        if (!isBullish && buffer.length >= 20) {
          const recentHigh = Math.max(...buffer.slice(-20).map((b: any) => b.high));
          const dropPct = (recentHigh - c.close) / recentHigh * 100;
          if (dropPct > SHORT_DROP_FROM_HIGH_MAX) shortBlocked = true;
        }
        
        // 大台割れSHORT
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
              position = { side: "short", price: c.close, lots: LOTS[sym] || 100, time, method, signal: "大台割れ" };
              break;
            }
          }
        }
        if (position) continue;
        
        // ダウ理論SHORT + 安値更新即(案1)
        if (!shortBlocked && buffer.length >= 21 && !isBullish) {
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
            
            // 押し目深さフィルター（案E: 撤廃 or 現行）
            let depthBlocked = false;
            if (useDepthFilter && buffer.length >= 20) {
              const lookback = buffer.slice(-20);
              const swingHigh = Math.max(...lookback.map((b: any) => b.high));
              const swingLow = Math.min(...lookback.map((b: any) => b.low));
              if (swingHigh > swingLow) {
                const depth = (swingHigh - c.close) / (swingHigh - swingLow);
                if (depth < 0.30 || depth > 0.70) depthBlocked = true;
              }
            }
            
            // 静かな上昇バイパス(緩和A) — 深さフィルター不要
            if (maDeviation < 0.5 && barBody < 0.2 && bearBars <= 4) {
              position = { side: "long", price: c.close, lots: LOTS[sym] || 100, time, method: "バイパスLONG", signal: "静かな上昇" };
            }
            // 出来高ブレイクLONG（前場のみ）— 深さフィルター不要
            if (!position && isAM) {
              const vol20 = buffer.slice(-21, -1).reduce((s: number, b: any) => s + b.volume, 0) / 20;
              const volRatio = vol20 > 0 ? c.volume / vol20 : 0;
              if (volRatio >= AM_VOL_BREAK_RATIO) {
                position = { side: "long", price: c.close, lots: LOTS[sym] || 100, time, method: "出来高ブレイク", signal: "出来高ブレイク" };
              }
            }
            // ★ダウ理論高値更新LONG → 押し目確認ステートマシンに登録
            if (!position && !depthBlocked && !pullbackState) {
              const swingLow = Math.min(...buffer.slice(-20).map((b: any) => b.low));
              pullbackState = { signalPrice: c.close, swingLow, waitCount: 0, pulledBack: false, reason: "ダウ理論高値更新" };
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
      pullbackState = null;
    }
  }
  return allTrades;
}

function report(label: string, trades: any[], days: number) {
  const wins = trades.filter((t: any) => t.pnl > 0);
  const losses = trades.filter((t: any) => t.pnl <= 0);
  const totalPnl = trades.reduce((s: number, t: any) => s + t.pnl, 0);
  const shortTrades = trades.filter((t: any) => t.side === "short");
  const longTrades = trades.filter((t: any) => t.side === "long");
  const grossProfit = wins.reduce((s: number, t: any) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s: number, t: any) => s + t.pnl, 0));
  const pf = grossLoss > 0 ? grossProfit / grossLoss : 999;
  
  console.log(`\n=== ${label} ===`);
  console.log(`全体: ${trades.length}件 ${wins.length}勝${losses.length}敗 勝率${(wins.length/trades.length*100).toFixed(1)}% ${totalPnl >= 0 ? "+" : ""}${totalPnl.toLocaleString()}円 PF${pf.toFixed(2)}`);
  console.log(`SHORT: ${shortTrades.length}件 ${shortTrades.filter((t: any)=>t.pnl>0).length}勝 ${shortTrades.reduce((s: number,t: any)=>s+t.pnl,0) >= 0 ? "+" : ""}${shortTrades.reduce((s: number,t: any)=>s+t.pnl,0).toLocaleString()}円`);
  console.log(`LONG: ${longTrades.length}件 ${longTrades.filter((t: any)=>t.pnl>0).length}勝 ${longTrades.reduce((s: number,t: any)=>s+t.pnl,0) >= 0 ? "+" : ""}${longTrades.reduce((s: number,t: any)=>s+t.pnl,0).toLocaleString()}円`);
  console.log(`1日平均: ${Math.round(totalPnl/days).toLocaleString()}円/日`);
  
  // 方式別
  console.log(`\n--- 方式別 ---`);
  const methods = [...new Set(trades.map((t: any) => t.method))].sort();
  for (const m of methods) {
    const mt = trades.filter((t: any) => t.method === m);
    const mw = mt.filter((t: any) => t.pnl > 0).length;
    const mp = mt.reduce((s: number, t: any) => s + t.pnl, 0);
    const mgp = mt.filter((t: any)=>t.pnl>0).reduce((s: number,t: any)=>s+t.pnl,0);
    const mgl = Math.abs(mt.filter((t: any)=>t.pnl<=0).reduce((s: number,t: any)=>s+t.pnl,0));
    const mpf = mgl > 0 ? mgp / mgl : 999;
    console.log(`  ${m}: ${mt.length}件 ${mw}勝${mt.length-mw}敗 勝率${(mw/mt.length*100).toFixed(1)}% ${mp >= 0 ? "+" : ""}${mp.toLocaleString()}円 PF${mpf.toFixed(2)}`);
  }
  
  // 日別
  console.log(`\n--- 日別 ---`);
  const allDates = [...new Set(trades.map((t: any) => t.date))].sort();
  let plusDays = 0, minusDays = 0;
  const dayOfWeek = ["日", "月", "火", "水", "木", "金", "土"];
  for (const d of allDates) {
    const dt = trades.filter((t: any) => t.date === d);
    const dp = dt.reduce((s: number, t: any) => s + t.pnl, 0);
    const dw = dt.filter((t: any) => t.pnl > 0).length;
    const ds = dt.filter((t: any) => t.side === "short").reduce((s: number, t: any) => s + t.pnl, 0);
    const dl = dt.filter((t: any) => t.side === "long").reduce((s: number, t: any) => s + t.pnl, 0);
    const dateObj = new Date(d + "T00:00:00+09:00");
    const dow = dayOfWeek[dateObj.getDay()];
    if (dp > 0) plusDays++; else minusDays++;
    console.log(`  ${d}（${dow}） ${dt.length}件 ${dw}勝${dt.length-dw}敗 ${dp >= 0 ? "+" : ""}${dp.toLocaleString()}円 (S:${ds >= 0 ? "+" : ""}${ds.toLocaleString()} L:${dl >= 0 ? "+" : ""}${dl.toLocaleString()})`);
  }
  console.log(`  プラス日: ${plusDays}日 / マイナス日: ${minusDays}日`);
  
  // 銘柄別
  console.log(`\n--- 銘柄別 ---`);
  const SYMBOLS = ["8035", "6857", "6976", "6526", "5803", "6981", "285A", "6146", "6594", "8316"];
  for (const sym of SYMBOLS) {
    const st = trades.filter((t: any) => t.sym === sym);
    if (st.length === 0) continue;
    const sp = st.reduce((s: number, t: any) => s + t.pnl, 0);
    const sw = st.filter((t: any) => t.pnl > 0).length;
    const ss = st.filter((t: any) => t.side === "short").reduce((s: number, t: any) => s + t.pnl, 0);
    const sl = st.filter((t: any) => t.side === "long").reduce((s: number, t: any) => s + t.pnl, 0);
    console.log(`  ${sym}: ${st.length}件 ${sw}勝${st.length-sw}敗 ${sp >= 0 ? "+" : ""}${sp.toLocaleString()}円 (S:${ss >= 0 ? "+" : ""}${ss.toLocaleString()} L:${sl >= 0 ? "+" : ""}${sl.toLocaleString()})`);
  }
}

async function main() {
  const db = await getDb();
  const [dates] = await db.execute(sql`SELECT DISTINCT tradeDate FROM rt_candles WHERE symbol='8035' ORDER BY tradeDate DESC LIMIT 31`);
  const tradeDates = (dates as any[]).map((d: any) => d.tradeDate).reverse();
  const simDates = tradeDates.slice(1);
  const days = simDates.length;
  
  console.log(`期間: ${simDates[0]}〜${simDates[simDates.length-1]} (${days}営業日)\n`);
  
  // 現行（深さフィルターあり 30-70%）
  const current = await simulate(db, simDates, tradeDates, true);
  report("現行（深さフィルター30-70%あり）", current, days);
  
  // 案E（深さフィルター撤廃）
  const planE = await simulate(db, simDates, tradeDates, false);
  report("案E（深さフィルター撤廃 + 押し目確認維持）", planE, days);
  
  // 比較
  const currentPnl = current.reduce((s: number, t: any) => s + t.pnl, 0);
  const planEPnl = planE.reduce((s: number, t: any) => s + t.pnl, 0);
  const currentLong = current.filter((t: any) => t.side === "long");
  const planELong = planE.filter((t: any) => t.side === "long");
  const currentPullback = current.filter((t: any) => t.method === "押し目確認LONG");
  const planEPullback = planE.filter((t: any) => t.method === "押し目確認LONG");
  
  console.log(`\n=== 比較 ===`);
  console.log(`全体損益: 現行 ${currentPnl >= 0 ? "+" : ""}${currentPnl.toLocaleString()}円 → 案E ${planEPnl >= 0 ? "+" : ""}${planEPnl.toLocaleString()}円 (差: ${(planEPnl-currentPnl) >= 0 ? "+" : ""}${(planEPnl-currentPnl).toLocaleString()}円)`);
  console.log(`LONG損益: 現行 ${currentLong.reduce((s: number,t: any)=>s+t.pnl,0).toLocaleString()}円 → 案E ${planELong.reduce((s: number,t: any)=>s+t.pnl,0).toLocaleString()}円`);
  console.log(`押し目確認LONG: 現行 ${currentPullback.length}件 → 案E ${planEPullback.length}件`);
  if (planEPullback.length > 0) {
    const pbPnl = planEPullback.reduce((s: number, t: any) => s + t.pnl, 0);
    const pbWins = planEPullback.filter((t: any) => t.pnl > 0).length;
    console.log(`  押し目確認LONG詳細: ${planEPullback.length}件 ${pbWins}勝${planEPullback.length-pbWins}敗 ${pbPnl >= 0 ? "+" : ""}${pbPnl.toLocaleString()}円`);
  }
  
  process.exit(0);
}
main();
