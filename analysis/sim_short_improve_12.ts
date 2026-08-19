import { getDb } from "../server/db";
import { sql } from "drizzle-orm";

// 案1: 直近安値更新で即エントリー（大台割れに加え、直近20本安値更新でも即SHORT）
// 案2: 確認バー中のisBullish再チェック免除（確認バー開始時にisBullish=falseなら待機中にtrueに戻ってもキャンセルしない）

const SL_MAP: Record<string, { long: number; short: number }> = {
  "8035": { long: 0.8, short: 0.8 }, "6857": { long: 0.6, short: 0.6 },
  "6976": { long: 0.6, short: 0.8 }, "6526": { long: 0.9, short: 1.0 },
  "5803": { long: 0.5, short: 0.6 }, "6981": { long: 0.4, short: 0.9 },
  "285A": { long: 0.8, short: 0.6 }, "6146": { long: 0.8, short: 0.8 },
  "6594": { long: 0.5, short: 0.5 }, "8316": { long: 0.5, short: 0.5 },
};
const LOTS: Record<string, number> = { "8035":100,"6857":100,"285A":100,"6146":100,"6976":200,"6981":300,"8316":400,"5803":400,"6526":1400,"6594":1000 };
const SYMBOLS = ["8035","6857","6976","6526","5803","6981","285A","6146","6594","8316"];
const TP_SHORT = 1.5;
const IS_BULLISH_MA_PERIOD = 8;
const ROUND_SHORT_CONFIRM_BARS = 2;
const ROUND_SHORT_PULLBACK_MAX_WAIT = 1;
const FAST_ENTRY_VOL_RATIO = 1.5;
const FAST_ENTRY_PREV_DIST_PCT = 0.05;

type Mode = "current" | "plan1" | "plan2" | "plan1_2";

async function runSim(mode: Mode) {
  const db = await getDb();
  const [dates] = await db.execute(sql`SELECT DISTINCT tradeDate FROM rt_candles WHERE symbol='8035' ORDER BY tradeDate DESC LIMIT 31`);
  const tradeDates = (dates as any[]).map(d => d.tradeDate).reverse();
  const simDates = tradeDates.slice(1);
  
  const allData: Record<string, Record<string, any[]>> = {};
  for (const sym of SYMBOLS) {
    const [rows] = await db.execute(sql`SELECT tradeDate, candleTime, open, high, low, close, volume FROM rt_candles WHERE symbol=${sym} AND tradeDate>=${tradeDates[0]} ORDER BY tradeDate, candleTime`);
    allData[sym] = {};
    for (const r of rows as any[]) {
      if (!allData[sym][r.tradeDate]) allData[sym][r.tradeDate] = [];
      allData[sym][r.tradeDate].push({...r, open:+r.open, high:+r.high, low:+r.low, close:+r.close, volume:+r.volume});
    }
  }
  
  let trades: any[] = [];
  
  for (const sym of SYMBOLS) {
    let buffer: any[] = allData[sym][tradeDates[0]] || [];
    
    for (const date of simDates) {
      const dayCandles = allData[sym][date] || [];
      if (dayCandles.length < 10) continue;
      let position: any = null;
      let slAfterTime: number | null = null;
      
      // 確認バーステートマシン
      let pendingState: { level: number; confirmCount: number; reason: string; isBullishAtStart: boolean } | null = null;
      
      for (let i = 0; i < dayCandles.length; i++) {
        const c = dayCandles[i]; buffer.push(c); if (buffer.length > 300) buffer = buffer.slice(-300);
        const [h, m] = c.candleTime.split(":").map(Number); const timeMin = h*60+m;
        
        // 決済
        if (position) {
          if (timeMin >= 687 && timeMin < 750) { trades.push({...position, pnl: Math.round((position.price-c.close)*position.lots), exit:"前場"}); position=null; continue; }
          if (timeMin >= 925) { trades.push({...position, pnl: Math.round((position.price-c.close)*position.lots), exit:"大引け"}); position=null; continue; }
          const sl = SL_MAP[sym]?.short || 0.5;
          const slP = position.price*(1+sl/100); const tpP = position.price*(1-TP_SHORT/100);
          if (c.high>=slP) { trades.push({...position, pnl: Math.round((position.price-slP)*position.lots), exit:"SL"}); slAfterTime=timeMin; position=null; continue; }
          if (c.low<=tpP) { trades.push({...position, pnl: Math.round((position.price-tpP)*position.lots), exit:"TP"}); position=null; continue; }
          continue;
        }
        
        if (timeMin<570||timeMin>=905) continue;
        if (timeMin>=750&&timeMin<770) continue; // 12:30-12:50禁止
        if (slAfterTime && timeMin-slAfterTime<30) continue;
        
        // isBullish計算
        let isBullish = false;
        if (buffer.length >= IS_BULLISH_MA_PERIOD + 1) {
          const ma = buffer.slice(-IS_BULLISH_MA_PERIOD).reduce((s, b) => s + b.close, 0) / IS_BULLISH_MA_PERIOD;
          const prevMa = buffer.slice(-IS_BULLISH_MA_PERIOD - 1, -1).reduce((s, b) => s + b.close, 0) / IS_BULLISH_MA_PERIOD;
          isBullish = ((ma - prevMa) / prevMa * 100) > 0;
        }
        
        // 確認バーステートマシン処理
        if (pendingState) {
          // 案2: 確認バー中のisBullish再チェック免除
          if (mode === "plan2" || mode === "plan1_2") {
            // 開始時にisBullish=falseだったなら、待機中にtrueに戻ってもキャンセルしない
            // → isBullishチェックをスキップ
          } else {
            // 現行: isBullishがtrueに戻ったらキャンセル
            if (isBullish) { pendingState = null; continue; }
          }
          
          pendingState.confirmCount++;
          // キリ番を上回ったらキャンセル
          if (c.close > pendingState.level) { pendingState = null; continue; }
          
          if (pendingState.confirmCount >= ROUND_SHORT_CONFIRM_BARS) {
            // 確認完了 → エントリー
            position = { sym, date, time: c.candleTime, price: c.close, lots: LOTS[sym]||100, method: "CB確認" };
            pendingState = null;
            continue;
          }
          continue;
        }
        
        // SHORTシグナル検出
        if (isBullish) continue; // isBullish=trueならSHORT禁止
        
        // 大台割れ検出
        if (i > 0) {
          const prev = buffer[buffer.length - 2];
          for (const rl of [100, 500, 1000, 5000, 10000]) {
            const near = Math.floor(prev.close / rl) * rl;
            if (near > 0 && prev.close >= near && c.close < near) {
              // 即エントリー判定（出来高）
              let fastEntry = false;
              if (buffer.length >= 21) {
                const avgVol = buffer.slice(-21, -1).reduce((s, b) => s + b.volume, 0) / 20;
                const volRatio = avgVol > 0 ? c.volume / avgVol : 0;
                if (volRatio >= FAST_ENTRY_VOL_RATIO) fastEntry = true;
              }
              // 即エントリー判定（前足近接）
              if (!fastEntry) {
                const prevDist = (prev.close - near) / near * 100;
                if (prevDist <= FAST_ENTRY_PREV_DIST_PCT) fastEntry = true;
              }
              
              if (fastEntry) {
                position = { sym, date, time: c.candleTime, price: c.close, lots: LOTS[sym]||100, method: "即エントリー" };
              } else {
                // 確認バー待機開始
                pendingState = { level: near, confirmCount: 0, reason: `大台割れ(${near}円)`, isBullishAtStart: isBullish };
              }
              break;
            }
          }
        }
        if (position) continue;
        
        // 案1: 直近安値更新で即エントリー
        if ((mode === "plan1" || mode === "plan1_2") && buffer.length >= 21) {
          const recent20 = buffer.slice(-21, -1);
          const minLow = Math.min(...recent20.map(b => b.low));
          if (c.close < minLow) {
            // 出来高確認（1.2倍以上）
            const avgVol = buffer.slice(-21, -1).reduce((s, b) => s + b.volume, 0) / 20;
            const volRatio = avgVol > 0 ? c.volume / avgVol : 0;
            if (volRatio >= 1.2) {
              position = { sym, date, time: c.candleTime, price: c.close, lots: LOTS[sym]||100, method: "安値更新即" };
            }
          }
        }
      }
      
      if (position) { const last = dayCandles[dayCandles.length-1]; trades.push({...position, pnl: Math.round((position.price-last.close)*position.lots), exit:"EOD"}); position = null; }
      buffer = dayCandles.slice(-100);
    }
  }
  return { trades, simDates };
}

async function main() {
  for (const mode of ["current", "plan1", "plan2", "plan1_2"] as Mode[]) {
    const label = mode === "current" ? "現行（大台割れSHORT: 即vol/即4a/CB2MW1）"
      : mode === "plan1" ? "案1: 直近安値更新即エントリー追加（出来高1.2倍以上）"
      : mode === "plan2" ? "案2: 確認バー中isBullish再チェック免除"
      : "案1+2: 両方適用";
    const { trades, simDates } = await runSim(mode);
    
    const wins = trades.filter(t => t.pnl > 0);
    const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
    const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
    const grossLoss = Math.abs(trades.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
    const pf = grossLoss > 0 ? (grossWin / grossLoss).toFixed(2) : "∞";
    
    console.log(`\n=== ${label} ===`);
    console.log(`  全体: ${trades.length}件 ${wins.length}勝${trades.length - wins.length}敗 勝率${(wins.length / trades.length * 100).toFixed(1)}% ${totalPnl.toLocaleString()}円 PF${pf}`);
    console.log(`  1日平均: ${Math.round(totalPnl / simDates.length).toLocaleString()}円/日`);
    
    // 方式別
    for (const m of ["即エントリー", "CB確認", "安値更新即"]) {
      const mt = trades.filter(t => t.method === m);
      if (mt.length === 0) continue;
      const mw = mt.filter(t => t.pnl > 0);
      const mp = mt.reduce((s, t) => s + t.pnl, 0);
      const mgw = mw.reduce((s, t) => s + t.pnl, 0);
      const mgl = Math.abs(mt.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
      const mpf = mgl > 0 ? (mgw / mgl).toFixed(2) : "∞";
      console.log(`  ${m}: ${mt.length}件 ${mw.length}勝${mt.length - mw.length}敗 勝率${(mw.length / mt.length * 100).toFixed(1)}% ${mp.toLocaleString()}円 PF${mpf}`);
    }
    
    // 本日8/19
    const today = trades.filter(t => t.date === "2026-08-19");
    if (today.length > 0) {
      console.log(`  ★本日8/19: ${today.length}件 ${today.filter(t => t.pnl > 0).length}勝${today.filter(t => t.pnl <= 0).length}敗 ${today.reduce((s, t) => s + t.pnl, 0).toLocaleString()}円`);
      for (const t of today) console.log(`    ${t.time} ${t.sym} @${t.price} ${t.method} → ${t.exit} ${t.pnl > 0 ? "+" : ""}${t.pnl.toLocaleString()}円`);
    }
  }
  
  process.exit(0);
}
main();
