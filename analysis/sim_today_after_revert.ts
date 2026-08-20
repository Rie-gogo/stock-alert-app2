import { getDb } from "../server/db";
import { sql } from "drizzle-orm";

// 撤廃後の本日8/19エントリーを検証
// ユーザーの理想エントリー:
// LONG: 8035 9:30-9:40, 6146 9:30-9:50, 6857 9:30-9:50, 6981 9:40-10:05
// SHORT: 6981 10:44-12:56, 5803 10:09-12:35, 285A 10:10-13:00, 6146 10:10-11:05

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
  
  // 前日のバッファ用
  const [prevRows] = await db.execute(sql`
    SELECT DISTINCT tradeDate FROM rt_candles WHERE symbol='8035' AND tradeDate < '2026-08-19' ORDER BY tradeDate DESC LIMIT 1
  `);
  const prevDate = (prevRows as any[])[0]?.tradeDate;
  
  console.log("=== 撤廃後の本日8/19 シミュレーション ===\n");
  console.log("ユーザー理想エントリー:");
  console.log("  LONG: 8035 9:30-9:40, 6146 9:30-9:50, 6857 9:30-9:50, 6981 9:40-10:05");
  console.log("  SHORT: 6981 10:44-12:56, 5803 10:09-12:35, 285A 10:10-13:00, 6146 10:10-11:05\n");
  
  const allTrades: any[] = [];
  const allSignals: any[] = []; // 全シグナル記録（ブロック含む）
  
  for (const sym of SYMBOLS) {
    const [rows] = await db.execute(sql`
      SELECT tradeDate, candleTime, open, high, low, close, volume
      FROM rt_candles WHERE symbol=${sym} AND tradeDate >= ${prevDate} AND tradeDate <= '2026-08-19'
      ORDER BY tradeDate, candleTime
    `);
    const candles = rows as any[];
    if (candles.length < 50) continue;
    
    const byDate: Record<string, any[]> = {};
    for (const c of candles) { if (!byDate[c.tradeDate]) byDate[c.tradeDate] = []; byDate[c.tradeDate].push({...c, open:+c.open, high:+c.high, low:+c.low, close:+c.close, volume:+c.volume}); }
    
    let buffer: any[] = byDate[prevDate] || [];
    const dayCandles = byDate["2026-08-19"] || [];
    if (dayCandles.length < 10) continue;
    
    let position: any = null;
    let slAfterTime: string | null = null;
    
    for (let i = 0; i < dayCandles.length; i++) {
      const c = dayCandles[i]; buffer.push(c); if (buffer.length > 300) buffer = buffer.slice(-300);
      const time = c.candleTime;
      const [h, m] = time.split(":").map(Number); const timeMin = h*60+m;
      const isAM = timeMin < 688;
      
      // 前場強制決済
      if (position && timeMin >= 687 && timeMin < 750) {
        const pnl = position.side === "short" ? (position.price - c.close) * position.lots : (c.close - position.price) * position.lots;
        allTrades.push({ sym, ...position, exitTime: time, exitReason: "前場決済", pnl: Math.round(pnl) });
        position = null; continue;
      }
      // 大引け
      if (position && timeMin >= 925) {
        const pnl = position.side === "short" ? (position.price - c.close) * position.lots : (c.close - position.price) * position.lots;
        allTrades.push({ sym, ...position, exitTime: time, exitReason: "大引け", pnl: Math.round(pnl) });
        position = null; continue;
      }
      // SL/TP
      if (position) {
        const slPct = position.side === "short" ? SL_MAP[sym]?.short || 0.8 : SL_MAP[sym]?.long || 0.5;
        const tpPct = position.side === "short" ? TP_SHORT : TP_LONG;
        const slPrice = position.side === "short" ? position.price * (1 + slPct/100) : position.price * (1 - slPct/100);
        const tpPrice = position.side === "short" ? position.price * (1 - tpPct/100) : position.price * (1 + tpPct/100);
        if (position.side === "short") {
          if (c.high >= slPrice) { allTrades.push({ sym, ...position, exitTime: time, exitReason: "SL", pnl: Math.round((position.price - slPrice) * position.lots) }); slAfterTime = time; position = null; continue; }
          if (c.low <= tpPrice) { allTrades.push({ sym, ...position, exitTime: time, exitReason: "TP", pnl: Math.round((position.price - tpPrice) * position.lots) }); position = null; continue; }
        } else {
          if (c.low <= slPrice) { allTrades.push({ sym, ...position, exitTime: time, exitReason: "SL", pnl: Math.round((slPrice - position.price) * position.lots) }); slAfterTime = time; position = null; continue; }
          if (c.high >= tpPrice) { allTrades.push({ sym, ...position, exitTime: time, exitReason: "TP", pnl: Math.round((tpPrice - position.price) * position.lots) }); position = null; continue; }
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
      // 大台割れ（isBullish免除なし = 撤廃後）
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
            allSignals.push({ sym, time, side: "SHORT", method, isBullish, status: "ENTRY" });
            break;
          }
        }
        // isBullish=trueでブロックされた大台割れ
      } else if (i > 0 && buffer.length >= 2 && isBullish) {
        const prev = buffer[buffer.length - 2];
        for (const rl of [100, 500, 1000, 5000, 10000]) {
          const nearestAbove = Math.ceil(prev.close / rl) * rl;
          if (prev.close >= nearestAbove && c.close < nearestAbove && (nearestAbove - c.close) / nearestAbove < 0.008) {
            allSignals.push({ sym, time, side: "SHORT", method: "大台割れ(isBullishブロック)", isBullish, status: "BLOCKED" });
            break;
          }
        }
      }
      if (position) continue;
      
      // ダウ理論SHORT + 安値更新即
      if (buffer.length >= 21 && !isBullish) {
        const minLow = Math.min(...buffer.slice(-21, -1).map((b: any) => b.low));
        if (c.close < minLow) {
          const vol20 = buffer.slice(-21, -1).reduce((s: number, b: any) => s + b.volume, 0) / 20;
          const volRatio = vol20 > 0 ? c.volume / vol20 : 0;
          const method = volRatio >= SHORT_LOW_BREAK_VOL_RATIO ? "安値更新即" : "ダウ理論";
          position = { side: "short", price: c.close, lots: LOTS[sym] || 100, time, method, signal: "ダウ理論SHORT" };
          allSignals.push({ sym, time, side: "SHORT", method, isBullish, status: "ENTRY" });
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
          
          // バイパス
          if (maDeviation < 0.5 && barBody < 0.2 && bearBars <= 4) {
            position = { side: "long", price: c.close, lots: LOTS[sym] || 100, time, method: "バイパスLONG", signal: "静かな上昇" };
            allSignals.push({ sym, time, side: "LONG", method: "バイパスLONG", isBullish, status: "ENTRY" });
          }
          // 出来高ブレイク（前場のみ）
          if (!position && isAM) {
            const vol20 = buffer.slice(-21, -1).reduce((s: number, b: any) => s + b.volume, 0) / 20;
            const volRatio = vol20 > 0 ? c.volume / vol20 : 0;
            if (volRatio >= AM_VOL_BREAK_RATIO) {
              position = { side: "long", price: c.close, lots: LOTS[sym] || 100, time, method: "出来高ブレイク", signal: "出来高ブレイク" };
              allSignals.push({ sym, time, side: "LONG", method: "出来高ブレイク", isBullish, status: "ENTRY" });
            }
          }
          // ブロックされたLONG（条件不足）
          if (!position) {
            allSignals.push({ sym, time, side: "LONG", method: `高値更新(条件不足: MA乖離${maDeviation.toFixed(2)}% 実体${barBody.toFixed(2)}% 陰線${bearBars})`, isBullish, status: "BLOCKED" });
          }
        }
      }
    }
    
    if (position) {
      const lastC = dayCandles[dayCandles.length - 1];
      const pnl = position.side === "short" ? (position.price - lastC.close) * position.lots : (lastC.close - position.price) * position.lots;
      allTrades.push({ sym, ...position, exitTime: "15:30", exitReason: "EOD", pnl: Math.round(pnl) });
    }
  }
  
  // 取引一覧
  console.log("--- エントリー一覧 ---");
  for (const t of allTrades.sort((a, b) => a.time.localeCompare(b.time))) {
    console.log(`  ${t.time} ${t.sym} ${t.side.toUpperCase()} ${t.method} @${t.price} → ${t.exitTime} ${t.exitReason} ${t.pnl >= 0 ? "+" : ""}${t.pnl.toLocaleString()}円`);
  }
  const total = allTrades.reduce((s, t) => s + t.pnl, 0);
  const wins = allTrades.filter(t => t.pnl > 0).length;
  console.log(`\n合計: ${allTrades.length}件 ${wins}勝${allTrades.length-wins}敗 ${total >= 0 ? "+" : ""}${total.toLocaleString()}円`);
  
  // 理想エントリーとの対応
  console.log("\n--- 理想エントリーとの対応 ---");
  const idealLong = [
    { sym: "8035", start: "09:30", end: "09:40" },
    { sym: "6146", start: "09:30", end: "09:50" },
    { sym: "6857", start: "09:30", end: "09:50" },
    { sym: "6981", start: "09:40", end: "10:05" },
  ];
  const idealShort = [
    { sym: "6981", start: "10:44", end: "12:56" },
    { sym: "5803", start: "10:09", end: "12:35" },
    { sym: "285A", start: "10:10", end: "13:00" },
    { sym: "6146", start: "10:10", end: "11:05" },
  ];
  
  console.log("\nLONG理想:");
  for (const ideal of idealLong) {
    const entry = allTrades.find(t => t.sym === ideal.sym && t.side === "long" && t.time >= ideal.start && t.time <= ideal.end);
    const blocked = allSignals.filter(s => s.sym === ideal.sym && s.side === "LONG" && s.time >= ideal.start && s.time <= ideal.end && s.status === "BLOCKED");
    const entered = allSignals.filter(s => s.sym === ideal.sym && s.side === "LONG" && s.time >= ideal.start && s.time <= ideal.end && s.status === "ENTRY");
    if (entry) {
      console.log(`  ✓ ${ideal.sym} ${ideal.start}-${ideal.end}: ${entry.time} ${entry.method} @${entry.price} → ${entry.pnl >= 0 ? "+" : ""}${entry.pnl.toLocaleString()}円`);
    } else if (entered.length > 0) {
      console.log(`  △ ${ideal.sym} ${ideal.start}-${ideal.end}: シグナル発火したが別ポジション保有中`);
    } else if (blocked.length > 0) {
      console.log(`  ✗ ${ideal.sym} ${ideal.start}-${ideal.end}: ブロック(${blocked[0].method})`);
    } else {
      console.log(`  ✗ ${ideal.sym} ${ideal.start}-${ideal.end}: シグナルなし`);
    }
  }
  
  console.log("\nSHORT理想:");
  for (const ideal of idealShort) {
    const entry = allTrades.find(t => t.sym === ideal.sym && t.side === "short" && t.time >= ideal.start && t.time <= ideal.end);
    const blocked = allSignals.filter(s => s.sym === ideal.sym && s.side === "SHORT" && s.time >= ideal.start && s.time <= ideal.end && s.status === "BLOCKED");
    const entered = allSignals.filter(s => s.sym === ideal.sym && s.side === "SHORT" && s.time >= ideal.start && s.time <= ideal.end && s.status === "ENTRY");
    if (entry) {
      console.log(`  ✓ ${ideal.sym} ${ideal.start}-${ideal.end}: ${entry.time} ${entry.method} @${entry.price} → ${entry.pnl >= 0 ? "+" : ""}${entry.pnl.toLocaleString()}円`);
    } else if (entered.length > 0) {
      console.log(`  △ ${ideal.sym} ${ideal.start}-${ideal.end}: シグナル発火したが別ポジション保有中`);
    } else if (blocked.length > 0) {
      console.log(`  ✗ ${ideal.sym} ${ideal.start}-${ideal.end}: ブロック ${blocked.length}件 (例: ${blocked[0].method})`);
    } else {
      console.log(`  ✗ ${ideal.sym} ${ideal.start}-${ideal.end}: シグナルなし`);
    }
  }
  
  process.exit(0);
}
main();
