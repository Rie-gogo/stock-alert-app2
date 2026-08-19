import { getDb } from "../server/db";
import { sql } from "drizzle-orm";

// 同一銘柄1ポジション制限撤廃シミュレーション（元金制限考慮）
// 3パターン比較:
// A) 現行: 同一銘柄1ポジション制限あり
// B) 制限なし（無制限）
// C) 元金制限のみ（同一銘柄制限なし、ただし証拠金上限あり）

const IS_BULLISH_MA_PERIOD = 8;
const IS_BULLISH_SLOPE_THRESHOLD = 0;
const ATR_FILTER_THRESHOLD = 0.12;
const FAST_ENTRY_VOL_RATIO = 1.5;
const FAST_ENTRY_PREV_DIST_PCT = 0.05;
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
const SYMBOLS = ["8035","6857","6976","6526","5803","6981","285A","6146","6594","8316"];

// 元金設定: 信用取引の場合、保証金率30%で計算
// 各銘柄の概算株価 × ロット数 × 保証金率30% = 必要証拠金
const APPROX_PRICES: Record<string, number> = {
  "8035": 57000, "6857": 8200, "285A": 2300, "6146": 43000,
  "6976": 3300, "6981": 2700, "8316": 3800, "5803": 5800, "6526": 3200, "6594": 2900,
};
const MARGIN_RATE = 0.30; // 保証金率30%
const TOTAL_CAPITAL = 3_000_000; // 元金300万円

function calcMarginRequired(sym: string, lots: number): number {
  return APPROX_PRICES[sym] * lots * MARGIN_RATE;
}

interface Position {
  sym: string; side: string; price: number; lots: number; time: string; date: string; method: string; signal: string; margin: number;
}

async function runSim(mode: "current" | "unlimited" | "capital_only") {
  const db = await getDb();
  const [dates] = await db.execute(sql`SELECT DISTINCT tradeDate FROM rt_candles WHERE symbol='8035' ORDER BY tradeDate DESC LIMIT 11`);
  const tradeDates = (dates as any[]).map(d => d.tradeDate).reverse();
  const simDates = tradeDates.slice(1);
  
  // 全銘柄のローソク足を日別にロード
  const allCandles: Record<string, Record<string, any[]>> = {};
  for (const sym of SYMBOLS) {
    const [rows] = await db.execute(sql`SELECT tradeDate, candleTime, open, high, low, close, volume FROM rt_candles WHERE symbol=${sym} AND tradeDate>=${tradeDates[0]} ORDER BY tradeDate, candleTime`);
    const candles = rows as any[];
    allCandles[sym] = {};
    for (const c of candles) {
      if (!allCandles[sym][c.tradeDate]) allCandles[sym][c.tradeDate] = [];
      allCandles[sym][c.tradeDate].push({...c, open:+c.open, high:+c.high, low:+c.low, close:+c.close, volume:+c.volume});
    }
  }
  
  const allTrades: any[] = [];
  
  for (const date of simDates) {
    // 全銘柄のローソク足を時間順に統合
    const dayEvents: { sym: string; idx: number; time: string; timeMin: number; candle: any }[] = [];
    for (const sym of SYMBOLS) {
      const dayCandles = allCandles[sym][date] || [];
      for (let i = 0; i < dayCandles.length; i++) {
        const c = dayCandles[i];
        const [h, m] = c.candleTime.split(":").map(Number);
        dayEvents.push({ sym, idx: i, time: c.candleTime, timeMin: h*60+m, candle: c });
      }
    }
    dayEvents.sort((a, b) => a.timeMin - b.timeMin || a.sym.localeCompare(b.sym));
    
    // ポジション管理
    const positions: Position[] = [];
    const symPositionCount: Record<string, number> = {};
    let usedMargin = 0;
    const slAfterTime: Record<string, number> = {}; // sym -> timeMin of last SL
    const buffers: Record<string, any[]> = {};
    for (const sym of SYMBOLS) {
      buffers[sym] = [...(allCandles[sym][tradeDates[0]] || []).slice(-100)];
      symPositionCount[sym] = 0;
    }
    
    for (const ev of dayEvents) {
      const { sym, time, timeMin, candle: c } = ev;
      buffers[sym].push(c);
      if (buffers[sym].length > 300) buffers[sym] = buffers[sym].slice(-300);
      
      // 前場強制決済 11:27
      if (timeMin >= 687 && timeMin < 750) {
        const toClose = positions.filter(p => p.sym === sym);
        for (const pos of toClose) {
          const pnl = pos.side === "short" ? (pos.price - c.close) * pos.lots : (c.close - pos.price) * pos.lots;
          allTrades.push({ date, sym, side: pos.side, price: pos.price, time: pos.time, exitTime: time, exitReason: "前場決済", pnl: Math.round(pnl), method: pos.method });
          usedMargin -= pos.margin;
          symPositionCount[sym]--;
          positions.splice(positions.indexOf(pos), 1);
        }
        continue;
      }
      
      // 大引け 15:25
      if (timeMin >= 925) {
        const toClose = positions.filter(p => p.sym === sym);
        for (const pos of toClose) {
          const pnl = pos.side === "short" ? (pos.price - c.close) * pos.lots : (c.close - pos.price) * pos.lots;
          allTrades.push({ date, sym, side: pos.side, price: pos.price, time: pos.time, exitTime: time, exitReason: "大引け", pnl: Math.round(pnl), method: pos.method });
          usedMargin -= pos.margin;
          symPositionCount[sym]--;
          positions.splice(positions.indexOf(pos), 1);
        }
        continue;
      }
      
      // SL/TP判定（この銘柄のポジション）
      const symPos = positions.filter(p => p.sym === sym);
      for (const pos of symPos) {
        const slPct = pos.side === "short" ? SL_MAP[sym]?.short || 0.8 : SL_MAP[sym]?.long || 0.5;
        const slPrice = pos.side === "short" ? pos.price * (1 + slPct/100) : pos.price * (1 - slPct/100);
        const tpPct = pos.side === "long" ? 0.5 : 1.5; // LONGはTP0.5%で検証
        const tpPrice = pos.side === "short" ? pos.price * (1 - tpPct/100) : pos.price * (1 + tpPct/100);
        
        let closed = false;
        if (pos.side === "short") {
          if (c.high >= slPrice) { allTrades.push({ date, sym, side: pos.side, price: pos.price, time: pos.time, exitTime: time, exitReason: "SL", pnl: Math.round((pos.price - slPrice) * pos.lots), method: pos.method }); closed = true; slAfterTime[sym] = timeMin; }
          else if (c.low <= tpPrice) { allTrades.push({ date, sym, side: pos.side, price: pos.price, time: pos.time, exitTime: time, exitReason: "TP", pnl: Math.round((pos.price - tpPrice) * pos.lots), method: pos.method }); closed = true; }
        } else {
          if (c.low <= slPrice) { allTrades.push({ date, sym, side: pos.side, price: pos.price, time: pos.time, exitTime: time, exitReason: "SL", pnl: Math.round((slPrice - pos.price) * pos.lots), method: pos.method }); closed = true; slAfterTime[sym] = timeMin; }
          else if (c.high >= tpPrice) { allTrades.push({ date, sym, side: pos.side, price: pos.price, time: pos.time, exitTime: time, exitReason: "TP", pnl: Math.round((tpPrice - pos.price) * pos.lots), method: pos.method }); closed = true; }
        }
        if (closed) { usedMargin -= pos.margin; symPositionCount[sym]--; positions.splice(positions.indexOf(pos), 1); }
      }
      
      // エントリー判定
      if (timeMin < 570 || timeMin >= 905) continue;
      if (timeMin >= 750 && timeMin < 770) continue;
      
      // 同一銘柄制限
      if (mode === "current" && symPositionCount[sym] > 0) continue;
      
      // 損切り後30分禁止
      if (slAfterTime[sym] && timeMin - slAfterTime[sym] < 30) continue;
      
      // 元金制限
      const marginNeeded = calcMarginRequired(sym, LOTS[sym] || 100);
      if (mode === "capital_only" && usedMargin + marginNeeded > TOTAL_CAPITAL) continue;
      
      const buffer = buffers[sym];
      
      // isBullish（MA8）
      if (buffer.length < IS_BULLISH_MA_PERIOD + 1) continue;
      const ma = buffer.slice(-IS_BULLISH_MA_PERIOD).reduce((s:number,b:any)=>s+b.close,0)/IS_BULLISH_MA_PERIOD;
      const prevMa = buffer.slice(-IS_BULLISH_MA_PERIOD-1,-1).reduce((s:number,b:any)=>s+b.close,0)/IS_BULLISH_MA_PERIOD;
      const isBullish = ((ma-prevMa)/prevMa*100) > IS_BULLISH_SLOPE_THRESHOLD;
      
      // ATRフィルター
      if (buffer.length >= 20) {
        const atrBuf = buffer.slice(-20);
        const atr = atrBuf.reduce((s:number,b:any)=>s+(b.high-b.low),0)/20;
        if (atr/c.close*100 < ATR_FILTER_THRESHOLD) continue;
      }
      
      let entryMade = false;
      
      // 大台割れSHORT
      if (buffer.length >= 2 && !isBullish) {
        const prev = buffer[buffer.length - 2];
        const roundLevels = [100, 500, 1000, 5000, 10000];
        for (const rl of roundLevels) {
          const nearestAbove = Math.ceil(prev.close / rl) * rl;
          if (prev.close >= nearestAbove && c.close < nearestAbove && (nearestAbove - c.close) / nearestAbove < 0.008) {
            const vol20 = buffer.length >= 21 ? buffer.slice(-21,-1).reduce((s:number,b:any)=>s+b.volume,0)/20 : 0;
            const volRatio = vol20 > 0 ? c.volume / vol20 : 0;
            const prevDist = prev.close > 0 ? (prev.close - nearestAbove) / nearestAbove * 100 : 999;
            let method = "CB2";
            if (volRatio >= FAST_ENTRY_VOL_RATIO) method = "即vol";
            else if (prevDist <= FAST_ENTRY_PREV_DIST_PCT) method = "即4a";
            
            const newPos: Position = { sym, side: "short", price: c.close, lots: LOTS[sym]||100, time, date, method, signal: "大台割れ", margin: marginNeeded };
            positions.push(newPos);
            usedMargin += marginNeeded;
            symPositionCount[sym]++;
            entryMade = true;
            break;
          }
        }
      }
      if (entryMade) continue;
      
      // ダウ理論SHORT
      if (buffer.length >= 21 && !isBullish) {
        const recent20 = buffer.slice(-21, -1);
        const minLow = Math.min(...recent20.map((b:any)=>b.low));
        if (c.close < minLow) {
          const newPos: Position = { sym, side: "short", price: c.close, lots: LOTS[sym]||100, time, date, method: "ダウ理論", signal: "ダウ理論SHORT", margin: marginNeeded };
          positions.push(newPos);
          usedMargin += marginNeeded;
          symPositionCount[sym]++;
          entryMade = true;
        }
      }
      if (entryMade) continue;
      
      // バイパスLONG
      if (buffer.length >= 21 && isBullish) {
        const recent20 = buffer.slice(-21, -1);
        const maxHigh = Math.max(...recent20.map((b:any)=>b.high));
        if (c.close > maxHigh) {
          const maDeviation = Math.abs((c.close - ma) / ma * 100);
          const barBody = Math.abs((c.close - c.open) / c.open * 100);
          const recentBars = buffer.slice(-10);
          const bearBars = recentBars.filter((b:any)=>b.close<b.open).length;
          if (maDeviation < 0.5 && barBody < 0.2 && bearBars <= 4) {
            const newPos: Position = { sym, side: "long", price: c.close, lots: LOTS[sym]||100, time, date, method: "バイパスLONG", signal: "ダウ理論LONG", margin: marginNeeded };
            positions.push(newPos);
            usedMargin += marginNeeded;
            symPositionCount[sym]++;
          }
        }
      }
    }
    
    // 日末に残ったポジションを決済
    for (const pos of [...positions]) {
      const lastCandles = allCandles[pos.sym][date] || [];
      const lastC = lastCandles[lastCandles.length - 1];
      if (lastC) {
        const pnl = pos.side === "short" ? (pos.price - lastC.close) * pos.lots : (lastC.close - pos.price) * pos.lots;
        allTrades.push({ date, sym: pos.sym, side: pos.side, price: pos.price, time: pos.time, exitTime: "15:30", exitReason: "EOD", pnl: Math.round(pnl), method: pos.method });
      }
      usedMargin -= pos.margin;
      symPositionCount[pos.sym]--;
      positions.splice(positions.indexOf(pos), 1);
    }
  }
  
  return { trades: allTrades, dates: simDates };
}

async function main() {
  console.log(`=== 同一銘柄制限撤廃シミュレーション（10営業日） ===`);
  console.log(`元金: ${TOTAL_CAPITAL.toLocaleString()}円、保証金率: ${MARGIN_RATE*100}%`);
  console.log(`LONGのTP: 0.5%（最適値）、SHORTのTP: 1.5%\n`);
  
  // 各銘柄の1ポジション必要証拠金を表示
  console.log(`--- 銘柄別必要証拠金 ---`);
  let totalOnePos = 0;
  for (const sym of SYMBOLS) {
    const m = calcMarginRequired(sym, LOTS[sym]);
    totalOnePos += m;
    console.log(`  ${sym}: ${APPROX_PRICES[sym].toLocaleString()}円 × ${LOTS[sym]}株 × 30% = ${m.toLocaleString()}円`);
  }
  console.log(`  全銘柄1ポジずつ合計: ${totalOnePos.toLocaleString()}円`);
  console.log(`  元金${(TOTAL_CAPITAL/10000).toFixed(0)}万円で最大同時保有: 約${Math.floor(TOTAL_CAPITAL/totalOnePos*10)}ポジション（概算）\n`);
  
  for (const mode of ["current", "capital_only", "unlimited"] as const) {
    const label = mode === "current" ? "A) 現行（同一銘柄1ポジ制限）" : mode === "capital_only" ? "C) 元金制限のみ（銘柄制限なし）" : "B) 制限なし（無制限）";
    const { trades, dates } = await runSim(mode);
    const wins = trades.filter(t=>t.pnl>0);
    const losses = trades.filter(t=>t.pnl<=0);
    const totalPnl = trades.reduce((s,t)=>s+t.pnl,0);
    const shortT = trades.filter(t=>t.side==="short");
    const longT = trades.filter(t=>t.side==="long");
    const grossWin = wins.reduce((s,t)=>s+t.pnl,0);
    const grossLoss = Math.abs(losses.reduce((s,t)=>s+t.pnl,0));
    const pf = grossLoss > 0 ? (grossWin/grossLoss).toFixed(2) : "∞";
    
    console.log(`\n=== ${label} ===`);
    console.log(`全体: ${trades.length}件 ${wins.length}勝${losses.length}敗 勝率${(wins.length/trades.length*100).toFixed(1)}% ${totalPnl.toLocaleString()}円 PF${pf}`);
    console.log(`SHORT: ${shortT.length}件 ${shortT.filter(t=>t.pnl>0).length}勝 ${shortT.reduce((s,t)=>s+t.pnl,0).toLocaleString()}円`);
    console.log(`LONG: ${longT.length}件 ${longT.filter(t=>t.pnl>0).length}勝 ${longT.reduce((s,t)=>s+t.pnl,0).toLocaleString()}円`);
    console.log(`1日平均: ${Math.round(totalPnl/dates.length).toLocaleString()}円/日`);
    
    // 日別
    console.log(`  日別:`);
    for (const d of dates) {
      const dt = trades.filter(t=>t.date===d);
      console.log(`    ${d}: ${dt.length}件 ${dt.reduce((s,t)=>s+t.pnl,0).toLocaleString()}円`);
    }
    
    // 最大同時ポジション数を計算
    let maxConcurrent = 0;
    let maxMargin = 0;
    // 簡易計算: 日別の取引数からの推定
    for (const d of dates) {
      const dt = trades.filter(t=>t.date===d);
      // 同時刻のエントリー数を概算
      const byTime: Record<string, number> = {};
      for (const t of dt) { byTime[t.time] = (byTime[t.time]||0) + 1; }
      const maxInDay = Math.max(...Object.values(byTime), 0);
      maxConcurrent = Math.max(maxConcurrent, maxInDay);
    }
    console.log(`  最大同時エントリー（同一分）: ${maxConcurrent}件`);
  }
  
  process.exit(0);
}
main();
