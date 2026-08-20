import { getDb } from "../server/db";
import { sql } from "drizzle-orm";

// ① 高値下落<1.5%を現行全ロジックに組み込み
// ② 反転LONG改良版: 反転シグナル検出後、手前の山（直近の戻り高値）を超えたらエントリー

const IS_BULLISH_MA_PERIOD = 8;
const IS_BULLISH_SLOPE_THRESHOLD = 0;
const FAST_ENTRY_VOL_RATIO = 1.5;
const FAST_ENTRY_PREV_DIST_PCT = 0.05;
const SHORT_LOW_BREAK_VOL_RATIO = 1.2;
const AM_VOL_BREAK_RATIO = 1.5;
const TP_SHORT = 1.5;
const TP_LONG = 0.5;
const ATR_FILTER_THRESHOLD = 0.12;
const DROP_FILTER_PCT = 1.5; // 高値下落フィルター

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

interface Trade { date: string; sym: string; side: string; price: number; lots: number; time: string; method: string; exitTime: string; exitReason: string; pnl: number; }

async function simulate(db: any, simDates: string[], tradeDates: string[], opts: {
  dropFilter?: boolean;
  reversalLongV2?: boolean;
}): Promise<Trade[]> {
  const allTrades: Trade[] = [];
  
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
      
      // 反転LONG v2用: 当日の状態追跡
      let dayHigh = 0;
      let dayLow = 999999;
      let reversalPending = false; // 反転条件が成立したか
      let reversalPeakPrice = 0;  // 反転後の「手前の山」（直近の戻り高値）
      let reversalLowPrice = 0;   // 反転の起点（当日安値）
      let lastPeakUpdate = 0;     // 最後にpeakを更新した足のindex
      
      for (let i = 0; i < dayCandles.length; i++) {
        const c = dayCandles[i]; buffer.push(c); if (buffer.length > 300) buffer = buffer.slice(-300);
        const time = c.candleTime;
        const [h, m] = time.split(":").map(Number); const timeMin = h*60+m;
        const isAM = timeMin < 688;
        
        // 当日高値/安値
        if (c.high > dayHigh) dayHigh = c.high;
        if (c.low < dayLow) dayLow = c.low;
        
        // 反転LONG v2: 手前の山の追跡
        if (opts.reversalLongV2 && !reversalPending) {
          // 反転条件: 当日高値から1.5%以上下落 + 安値から0.3%以上反発開始
          const dayRange = dayHigh > 0 ? (dayHigh - dayLow) / dayHigh * 100 : 0;
          const riseFromLow = dayLow < 999999 ? (c.close - dayLow) / dayLow * 100 : 0;
          if (dayRange >= 1.5 && riseFromLow >= 0.3 && c.close > c.open) {
            // 反転検出! 手前の山 = 直近10本の高値
            const recentBuf = dayCandles.slice(Math.max(0, i - 10), i);
            if (recentBuf.length >= 3) {
              // 安値から反発した後の直近の戻り高値（安値の後の最高値）
              // dayLowを記録した足以降の最高値を「手前の山」とする
              let lowIdx = 0;
              for (let j = 0; j < i; j++) {
                if (dayCandles[j].low <= dayLow * 1.001) lowIdx = j;
              }
              const afterLow = dayCandles.slice(lowIdx, i);
              if (afterLow.length >= 2) {
                const peakAfterLow = Math.max(...afterLow.map((x: any) => x.high));
                if (peakAfterLow > dayLow && c.close < peakAfterLow) {
                  // まだ山を超えていない → pending
                  reversalPending = true;
                  reversalPeakPrice = peakAfterLow;
                  reversalLowPrice = dayLow;
                  lastPeakUpdate = i;
                }
              }
            }
          }
        }
        // 反転pending中: 新しい高値が出たらpeakを更新
        if (opts.reversalLongV2 && reversalPending && !position) {
          // 山を超えずに新安値を付けたらリセット
          if (c.low < reversalLowPrice * 0.998) {
            reversalPending = false;
            reversalPeakPrice = 0;
          }
          // 直近の高値でpeak更新（まだ超えていない場合）
          if (c.high > reversalPeakPrice && c.close < c.high) {
            reversalPeakPrice = c.high;
            lastPeakUpdate = i;
          }
        }
        
        // 前場強制決済
        if (position && timeMin >= 687 && timeMin < 750) {
          const pnl = position.side === "short" ? (position.price - c.close) * position.lots : (c.close - position.price) * position.lots;
          allTrades.push({ date, sym, ...position, exitTime: time, exitReason: "前場決済", pnl: Math.round(pnl) });
          position = null; continue;
        }
        if (position && timeMin >= 925) {
          const pnl = position.side === "short" ? (position.price - c.close) * position.lots : (c.close - position.price) * position.lots;
          allTrades.push({ date, sym, ...position, exitTime: time, exitReason: "大引け", pnl: Math.round(pnl) });
          position = null; continue;
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
        if (timeMin < 570 || timeMin >= 905) continue;
        if (timeMin >= 750 && timeMin < 770) continue;
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
        if (!isBullish) {
          // 高値下落フィルター
          let shortBlocked = false;
          if (opts.dropFilter && buffer.length >= 20) {
            const recentHigh = Math.max(...buffer.slice(-20).map((b: any) => b.high));
            const dropFromHigh = (recentHigh - c.close) / recentHigh * 100;
            if (dropFromHigh > DROP_FILTER_PCT) shortBlocked = true;
          }
          
          if (!shortBlocked) {
            // 大台割れ
            if (i > 0 && buffer.length >= 2) {
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
                  position = { side: "short", price: c.close, lots: LOTS[sym] || 100, time, method };
                  break;
                }
              }
            }
            if (position) continue;
            // 安値更新即
            if (buffer.length >= 21) {
              const minLow = Math.min(...buffer.slice(-21, -1).map((b: any) => b.low));
              if (c.close < minLow) {
                const vol20 = buffer.slice(-21, -1).reduce((s: number, b: any) => s + b.volume, 0) / 20;
                const volRatio = vol20 > 0 ? c.volume / vol20 : 0;
                const method = volRatio >= SHORT_LOW_BREAK_VOL_RATIO ? "安値更新即" : "ダウ理論";
                position = { side: "short", price: c.close, lots: LOTS[sym] || 100, time, method };
              }
            }
          }
        }
        if (position) continue;
        
        // === LONG ===
        // 静かな上昇バイパス + 出来高ブレイク
        if (buffer.length >= 21 && isBullish) {
          const maxHigh = Math.max(...buffer.slice(-21, -1).map((b: any) => b.high));
          if (c.close > maxHigh) {
            const ma = buffer.slice(-maPeriod).reduce((s: number, b: any) => s + b.close, 0) / maPeriod;
            const maDeviation = Math.abs((c.close - ma) / ma * 100);
            const barBody = Math.abs((c.close - c.open) / c.open * 100);
            const bearBars = buffer.slice(-10).filter((b: any) => b.close < b.open).length;
            if (maDeviation < 0.5 && barBody < 0.2 && bearBars <= 4) {
              position = { side: "long", price: c.close, lots: LOTS[sym] || 100, time, method: "バイパスLONG" };
            }
            if (!position && isAM) {
              const vol20 = buffer.slice(-21, -1).reduce((s: number, b: any) => s + b.volume, 0) / 20;
              const volRatio = vol20 > 0 ? c.volume / vol20 : 0;
              if (volRatio >= AM_VOL_BREAK_RATIO) {
                position = { side: "long", price: c.close, lots: LOTS[sym] || 100, time, method: "出来高ブレイク" };
              }
            }
          }
        }
        if (position) continue;
        
        // 反転LONG v2: 手前の山を超えたらエントリー
        if (opts.reversalLongV2 && reversalPending && isBullish && !position) {
          if (c.close > reversalPeakPrice) {
            // 山を超えた! エントリー
            position = { side: "long", price: c.close, lots: LOTS[sym] || 100, time, method: "反転LONG" };
            reversalPending = false;
            reversalPeakPrice = 0;
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
      // 日次リセット
      reversalPending = false; reversalPeakPrice = 0; reversalLowPrice = 0;
    }
  }
  return allTrades;
}

function report(label: string, trades: Trade[], days: number) {
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const total = trades.reduce((s, t) => s + t.pnl, 0);
  const shortT = trades.filter(t => t.side === "short");
  const longT = trades.filter(t => t.side === "long");
  const gp = wins.reduce((s, t) => s + t.pnl, 0);
  const gl = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const pf = gl > 0 ? gp / gl : 999;
  console.log(`\n[${label}]`);
  console.log(`  全体: ${trades.length}件 ${wins.length}勝${losses.length}敗 勝率${(wins.length/trades.length*100).toFixed(1)}% ${total >= 0 ? "+" : ""}${total.toLocaleString()}円 PF${pf.toFixed(2)}`);
  console.log(`  SHORT: ${shortT.length}件 ${shortT.filter(t=>t.pnl>0).length}勝 ${shortT.reduce((s,t)=>s+t.pnl,0) >= 0 ? "+" : ""}${shortT.reduce((s,t)=>s+t.pnl,0).toLocaleString()}円`);
  console.log(`  LONG: ${longT.length}件 ${longT.filter(t=>t.pnl>0).length}勝 ${longT.reduce((s,t)=>s+t.pnl,0) >= 0 ? "+" : ""}${longT.reduce((s,t)=>s+t.pnl,0).toLocaleString()}円`);
  console.log(`  1日平均: ${Math.round(total/days).toLocaleString()}円/日`);
  const methods = [...new Set(trades.map(t => t.method))].sort();
  for (const m of methods) {
    const mt = trades.filter(t => t.method === m);
    const mw = mt.filter(t => t.pnl > 0).length;
    const mp = mt.reduce((s, t) => s + t.pnl, 0);
    const mgp = mt.filter(t=>t.pnl>0).reduce((s,t)=>s+t.pnl,0);
    const mgl = Math.abs(mt.filter(t=>t.pnl<=0).reduce((s,t)=>s+t.pnl,0));
    const mpf = mgl > 0 ? mgp / mgl : 999;
    console.log(`    ${m}: ${mt.length}件 ${mw}勝${mt.length-mw}敗 ${mp >= 0 ? "+" : ""}${mp.toLocaleString()}円 PF${mpf.toFixed(2)}`);
  }
  // 日別で反転LONGがある日を表示
  const reversalTrades = trades.filter(t => t.method === "反転LONG");
  if (reversalTrades.length > 0) {
    console.log(`\n  [反転LONG v2 詳細]`);
    const rDates = [...new Set(reversalTrades.map(t => t.date))].sort();
    let plusDays = 0, minusDays = 0;
    for (const d of rDates) {
      const dt = reversalTrades.filter(t => t.date === d);
      const dp = dt.reduce((s, t) => s + t.pnl, 0);
      if (dp > 0) plusDays++; else minusDays++;
      console.log(`    ${d}: ${dt.length}件 ${dp >= 0 ? "+" : ""}${dp.toLocaleString()}円`);
    }
    const rTotal = reversalTrades.reduce((s, t) => s + t.pnl, 0);
    const rWins = reversalTrades.filter(t => t.pnl > 0).length;
    console.log(`    合計: ${reversalTrades.length}件 ${rWins}勝${reversalTrades.length-rWins}敗 ${rTotal >= 0 ? "+" : ""}${rTotal.toLocaleString()}円 プラス日${plusDays}/マイナス日${minusDays}`);
  }
}

async function main() {
  const db = await getDb();
  const [dates] = await db.execute(sql`SELECT DISTINCT tradeDate FROM rt_candles WHERE symbol='8035' ORDER BY tradeDate DESC LIMIT 31`);
  const tradeDates = (dates as any[]).map(d => d.tradeDate).reverse();
  const simDates = tradeDates.slice(1);
  const days = simDates.length;
  
  console.log(`=== 30営業日シミュレーション (${simDates[0]}〜${simDates[simDates.length-1]}) ===`);
  
  // 現行
  const baseline = await simulate(db, simDates, tradeDates, {});
  report("現行", baseline, days);
  
  // ① 高値下落<1.5%フィルター組み込み
  const withDrop = await simulate(db, simDates, tradeDates, { dropFilter: true });
  report("① 高値下落<1.5%フィルター", withDrop, days);
  
  // ② 反転LONG v2（手前の山超え）
  const withReversal = await simulate(db, simDates, tradeDates, { reversalLongV2: true });
  report("② 反転LONG v2（山超え）", withReversal, days);
  
  // ①+② 両方
  const withBoth = await simulate(db, simDates, tradeDates, { dropFilter: true, reversalLongV2: true });
  report("①+② 両方適用", withBoth, days);
  
  process.exit(0);
}
main();
