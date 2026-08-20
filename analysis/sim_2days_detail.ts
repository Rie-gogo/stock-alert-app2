import { getDb } from "../server/db";
import { sql } from "drizzle-orm";

// 8/19, 8/20の全エントリー詳細シミュレーション（現在の全ロジック）
// 高値下落<1.5%フィルター + 押し目深さフィルター撤廃 + 案1安値更新即 + 出来高ブレイクLONG前場のみ

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

interface Trade {
  date: string; sym: string; side: string; price: number; lots: number;
  time: string; method: string; signal: string;
  exitTime: string; exitPrice: number; exitReason: string; pnl: number;
}

async function simulateDay(db: any, targetDate: string, prevDate: string): Promise<Trade[]> {
  const trades: Trade[] = [];
  
  for (const sym of SYMBOLS) {
    // バッファ用に前日+当日のデータを取得
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
    let pullbackState: { signalPrice: number; swingLow: number; waitCount: number; pulledBack: boolean; reason: string } | null = null;
    
    for (let i = 0; i < dayCandles.length; i++) {
      const c = dayCandles[i]; buffer.push(c); if (buffer.length > 300) buffer = buffer.slice(-300);
      const time = c.candleTime;
      const [h, m] = time.split(":").map(Number); const timeMin = h*60+m;
      const isAM = timeMin < 688;
      
      // 前場強制決済 (11:27)
      if (position && timeMin >= 687 && timeMin < 750) {
        const pnl = position.side === "short" ? (position.price - c.close) * position.lots : (c.close - position.price) * position.lots;
        trades.push({ ...position, date: targetDate, exitTime: time, exitPrice: c.close, exitReason: "前場決済", pnl: Math.round(pnl) });
        position = null; pullbackState = null; continue;
      }
      // 大引け (15:25)
      if (position && timeMin >= 925) {
        const pnl = position.side === "short" ? (position.price - c.close) * position.lots : (c.close - position.price) * position.lots;
        trades.push({ ...position, date: targetDate, exitTime: time, exitPrice: c.close, exitReason: "大引け", pnl: Math.round(pnl) });
        position = null; pullbackState = null; continue;
      }
      // SL/TP
      if (position) {
        const slPct = position.side === "short" ? SL_MAP[sym]?.short || 0.8 : SL_MAP[sym]?.long || 0.5;
        const tpPct = position.side === "short" ? TP_SHORT : TP_LONG;
        const slPrice = position.side === "short" ? position.price * (1 + slPct/100) : position.price * (1 - slPct/100);
        const tpPrice = position.side === "short" ? position.price * (1 - tpPct/100) : position.price * (1 + tpPct/100);
        if (position.side === "short") {
          if (c.high >= slPrice) { trades.push({ ...position, date: targetDate, exitTime: time, exitPrice: slPrice, exitReason: "SL", pnl: Math.round((position.price - slPrice) * position.lots) }); slAfterTime = time; position = null; continue; }
          if (c.low <= tpPrice) { trades.push({ ...position, date: targetDate, exitTime: time, exitPrice: tpPrice, exitReason: "TP", pnl: Math.round((position.price - tpPrice) * position.lots) }); position = null; continue; }
        } else {
          if (c.low <= slPrice) { trades.push({ ...position, date: targetDate, exitTime: time, exitPrice: slPrice, exitReason: "SL", pnl: Math.round((slPrice - position.price) * position.lots) }); slAfterTime = time; position = null; continue; }
          if (c.high >= tpPrice) { trades.push({ ...position, date: targetDate, exitTime: time, exitPrice: tpPrice, exitReason: "TP", pnl: Math.round((tpPrice - position.price) * position.lots) }); position = null; continue; }
        }
        continue;
      }
      
      // 押し目確認ステートマシン処理
      if (pullbackState) {
        pullbackState.waitCount++;
        if (c.low < pullbackState.swingLow) { pullbackState = null; }
        else if (pullbackState.waitCount > PULLBACK_MAX_WAIT) { pullbackState = null; }
        else {
          if (!pullbackState.pulledBack && c.close < pullbackState.signalPrice) pullbackState.pulledBack = true;
          if (pullbackState.pulledBack && c.close > pullbackState.signalPrice) {
            position = { sym, side: "long", price: c.close, lots: LOTS[sym] || 100, time, method: "押し目確認LONG", signal: "ダウ理論高値更新" };
            pullbackState = null;
          }
          if (pullbackState) continue;
        }
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
      // ATR
      if (buffer.length >= 20) {
        const atrBuf = buffer.slice(-20);
        const atr = atrBuf.reduce((s: number, b: any) => s + (b.high - b.low), 0) / 20;
        if (atr / c.close * 100 < ATR_FILTER_THRESHOLD) continue;
      }
      
      // === SHORT ===
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
            position = { sym, side: "short", price: c.close, lots: LOTS[sym] || 100, time, method, signal: `大台割れ(${nearestAbove}円)` };
            break;
          }
        }
      }
      if (position) continue;
      
      // ダウ理論SHORT + 安値更新即
      if (!shortBlocked && buffer.length >= 21 && !isBullish) {
        const minLow = Math.min(...buffer.slice(-21, -1).map((b: any) => b.low));
        if (c.close < minLow) {
          const vol20 = buffer.slice(-21, -1).reduce((s: number, b: any) => s + b.volume, 0) / 20;
          const volRatio = vol20 > 0 ? c.volume / vol20 : 0;
          const method = volRatio >= SHORT_LOW_BREAK_VOL_RATIO ? "安値更新即" : "ダウ理論SHORT";
          position = { sym, side: "short", price: c.close, lots: LOTS[sym] || 100, time, method, signal: "直近安値更新" };
        }
      }
      if (position) continue;
      
      // === LONG ===
      if (buffer.length >= 21 && isBullish) {
        const maxHigh = Math.max(...buffer.slice(-21, -1).map((b: any) => b.high));
        if (c.close > maxHigh) {
          const ma = buffer.slice(-IS_BULLISH_MA_PERIOD).reduce((s: number, b: any) => s + b.close, 0) / IS_BULLISH_MA_PERIOD;
          const maDeviation = Math.abs((c.close - ma) / ma * 100);
          const barBody = Math.abs((c.close - c.open) / c.open * 100);
          const bearBars = buffer.slice(-10).filter((b: any) => b.close < b.open).length;
          
          // 静かな上昇バイパス(緩和A)
          if (maDeviation < 0.5 && barBody < 0.2 && bearBars <= 4) {
            position = { sym, side: "long", price: c.close, lots: LOTS[sym] || 100, time, method: "バイパスLONG", signal: "静かな上昇" };
          }
          // 出来高ブレイクLONG（前場のみ）
          if (!position && isAM) {
            const vol20 = buffer.slice(-21, -1).reduce((s: number, b: any) => s + b.volume, 0) / 20;
            const volRatio = vol20 > 0 ? c.volume / vol20 : 0;
            if (volRatio >= AM_VOL_BREAK_RATIO) {
              position = { sym, side: "long", price: c.close, lots: LOTS[sym] || 100, time, method: "出来高ブレイク", signal: "出来高ブレイク" };
            }
          }
          // ダウ理論高値更新LONG → 押し目確認ステートマシン
          if (!position && !pullbackState) {
            const swingLow = Math.min(...buffer.slice(-20).map((b: any) => b.low));
            pullbackState = { signalPrice: c.close, swingLow, waitCount: 0, pulledBack: false, reason: "ダウ理論高値更新" };
          }
        }
      }
    }
    // EOD
    if (position) {
      const lastC = dayCandles[dayCandles.length - 1];
      const pnl = position.side === "short" ? (position.price - lastC.close) * position.lots : (lastC.close - position.price) * position.lots;
      trades.push({ ...position, date: targetDate, exitTime: "15:30", exitPrice: lastC.close, exitReason: "EOD", pnl: Math.round(pnl) });
    }
  }
  return trades;
}

async function main() {
  const db = await getDb();
  
  // 8/19と8/20のデータを取得
  const targetDates = ["2026-08-19", "2026-08-20"];
  const prevDates = ["2026-08-18", "2026-08-19"];
  const dayOfWeek = ["日", "月", "火", "水", "木", "金", "土"];
  
  for (let d = 0; d < targetDates.length; d++) {
    const date = targetDates[d];
    const prev = prevDates[d];
    const dateObj = new Date(date + "T00:00:00+09:00");
    const dow = dayOfWeek[dateObj.getDay()];
    
    const trades = await simulateDay(db, date, prev);
    const wins = trades.filter(t => t.pnl > 0);
    const total = trades.reduce((s, t) => s + t.pnl, 0);
    const shortT = trades.filter(t => t.side === "short");
    const longT = trades.filter(t => t.side === "long");
    
    console.log(`\n${"=".repeat(80)}`);
    console.log(`${date}（${dow}曜日）: ${trades.length}件 ${wins.length}勝${trades.length-wins.length}敗 ${total >= 0 ? "+" : ""}${total.toLocaleString()}円`);
    console.log(`  SHORT: ${shortT.length}件 ${shortT.filter(t=>t.pnl>0).length}勝 ${shortT.reduce((s,t)=>s+t.pnl,0) >= 0 ? "+" : ""}${shortT.reduce((s,t)=>s+t.pnl,0).toLocaleString()}円`);
    console.log(`  LONG:  ${longT.length}件 ${longT.filter(t=>t.pnl>0).length}勝 ${longT.reduce((s,t)=>s+t.pnl,0) >= 0 ? "+" : ""}${longT.reduce((s,t)=>s+t.pnl,0).toLocaleString()}円`);
    console.log(`${"=".repeat(80)}`);
    
    // 全エントリー詳細
    console.log(`\n# | 時刻 | 銘柄 | 方向 | 方式 | エントリー | 決済時刻 | 決済価格 | 決済理由 | 損益`);
    console.log(`--|------|------|------|------|-----------|---------|---------|---------|------`);
    trades.sort((a, b) => a.time.localeCompare(b.time));
    for (let i = 0; i < trades.length; i++) {
      const t = trades[i];
      const name = NAMES[t.sym] || t.sym;
      const pnlStr = t.pnl >= 0 ? `+${t.pnl.toLocaleString()}` : t.pnl.toLocaleString();
      console.log(`${(i+1).toString().padStart(2)} | ${t.time} | ${t.sym} ${name} | ${t.side.toUpperCase()} | ${t.method} | ${t.price.toLocaleString()}円 | ${t.exitTime} | ${t.exitPrice.toLocaleString()}円 | ${t.exitReason} | ${pnlStr}円`);
    }
    
    // 銘柄別サマリー
    console.log(`\n--- 銘柄別 ---`);
    for (const sym of SYMBOLS) {
      const st = trades.filter(t => t.sym === sym);
      if (st.length === 0) continue;
      const sp = st.reduce((s, t) => s + t.pnl, 0);
      const sw = st.filter(t => t.pnl > 0).length;
      console.log(`  ${sym} ${NAMES[sym]}: ${st.length}件 ${sw}勝${st.length-sw}敗 ${sp >= 0 ? "+" : ""}${sp.toLocaleString()}円`);
    }
  }
  
  process.exit(0);
}
main();
