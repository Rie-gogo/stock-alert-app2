import { getDb } from "../server/db";
import { sql } from "drizzle-orm";

// 同一銘柄・同一日でSHORTとLONGが競合するケースを調査

const IS_BULLISH_MA_PERIOD = 8;
const FAST_ENTRY_VOL_RATIO = 1.5;
const FAST_ENTRY_PREV_DIST_PCT = 0.05;
const SHORT_LOW_BREAK_VOL_RATIO = 1.2;
const AM_BOOST_MA_DEV_MAX = 1.0;
const AM_BOOST_BODY_MAX = 0.5;
const AM_BOOST_BEAR_MAX = 5;
const AM_VOL_BREAK_RATIO = 1.5;
const SYMBOLS = ["8035", "6857", "6976", "6526", "5803", "6981", "285A", "6146", "6594", "8316"];

async function main() {
  const db = await getDb();
  const [dates] = await db.execute(sql`SELECT DISTINCT tradeDate FROM rt_candles WHERE symbol='8035' ORDER BY tradeDate DESC LIMIT 11`);
  const tradeDates = (dates as any[]).map(d => d.tradeDate).reverse();
  const simDates = tradeDates.slice(1);
  
  let conflicts = 0;
  let totalShortFirst = 0;
  let totalLongFirst = 0;
  const examples: any[] = [];
  
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
      
      // 前場のシグナルを全て記録（ポジション制限なし）
      const amSignals: { time: string; side: string; method: string; price: number; isBullish: boolean }[] = [];
      
      for (let i = 0; i < dayCandles.length; i++) {
        const c = dayCandles[i]; buffer.push(c); if (buffer.length > 300) buffer = buffer.slice(-300);
        const [h, m] = c.candleTime.split(":").map(Number); const timeMin = h*60+m;
        if (timeMin < 570 || timeMin >= 688) continue; // 前場のみ (09:30-11:27)
        if (buffer.length < 21) continue;
        
        const ma = buffer.slice(-8).reduce((s:number,b:any)=>s+b.close,0)/8;
        const prevMa = buffer.slice(-9,-1).reduce((s:number,b:any)=>s+b.close,0)/8;
        const isBullish = ((ma-prevMa)/prevMa*100) > 0;
        
        // SHORT検出
        let shortSignal = false;
        let shortMethod = "";
        // 大台割れ
        if (i > 0) {
          const prev = buffer[buffer.length - 2];
          for (const rl of [100, 500, 1000, 5000, 10000]) {
            const nearestAbove = Math.ceil(prev.close / rl) * rl;
            if (prev.close >= nearestAbove && c.close < nearestAbove && (nearestAbove - c.close) / nearestAbove < 0.008) {
              shortSignal = true;
              const vol20 = buffer.length >= 21 ? buffer.slice(-21, -1).reduce((s:number, b:any) => s + b.volume, 0) / 20 : 0;
              const volRatio = vol20 > 0 ? c.volume / vol20 : 0;
              shortMethod = volRatio >= FAST_ENTRY_VOL_RATIO ? "大台割れ即vol" : "大台割れCB";
              break;
            }
          }
        }
        // ダウ理論安値更新
        if (!shortSignal && !isBullish) {
          const minLow = Math.min(...buffer.slice(-21, -1).map((b:any) => b.low));
          if (c.close < minLow) {
            const vol20 = buffer.slice(-21, -1).reduce((s:number, b:any) => s + b.volume, 0) / 20;
            const volRatio = vol20 > 0 ? c.volume / vol20 : 0;
            shortSignal = true;
            shortMethod = volRatio >= SHORT_LOW_BREAK_VOL_RATIO ? "安値更新即" : "ダウ理論SHORT";
          }
        }
        
        // LONG検出
        let longSignal = false;
        let longMethod = "";
        if (isBullish) {
          const maxHigh = Math.max(...buffer.slice(-21, -1).map((b:any) => b.high));
          if (c.close > maxHigh) {
            const maDeviation = Math.abs((c.close - ma) / ma * 100);
            const barBody = Math.abs((c.close - c.open) / c.open * 100);
            const bearBars = buffer.slice(-10).filter((b:any) => b.close < b.open).length;
            if (maDeviation < 0.5 && barBody < 0.2 && bearBars <= 4) {
              longSignal = true; longMethod = "バイパスLONG";
            } else if (maDeviation < AM_BOOST_MA_DEV_MAX && barBody < AM_BOOST_BODY_MAX && bearBars <= AM_BOOST_BEAR_MAX) {
              longSignal = true; longMethod = "前場ブースト";
            }
            if (!longSignal && buffer.length >= 21) {
              const vol20 = buffer.slice(-21, -1).reduce((s:number, b:any) => s + b.volume, 0) / 20;
              const volRatio = vol20 > 0 ? c.volume / vol20 : 0;
              if (volRatio >= AM_VOL_BREAK_RATIO) { longSignal = true; longMethod = "出来高ブレイク"; }
            }
          }
        }
        
        if (shortSignal) amSignals.push({ time: c.candleTime, side: "SHORT", method: shortMethod, price: c.close, isBullish });
        if (longSignal) amSignals.push({ time: c.candleTime, side: "LONG", method: longMethod, price: c.close, isBullish });
      }
      
      // 同一日にSHORTとLONGの両方がある場合
      const shorts = amSignals.filter(s => s.side === "SHORT");
      const longs = amSignals.filter(s => s.side === "LONG");
      if (shorts.length > 0 && longs.length > 0) {
        conflicts++;
        const firstShort = shorts[0];
        const firstLong = longs[0];
        if (firstShort.time < firstLong.time) totalShortFirst++;
        else totalLongFirst++;
        
        if (examples.length < 20) {
          examples.push({
            date, sym,
            shortCount: shorts.length, longCount: longs.length,
            firstShort: `${firstShort.time} ${firstShort.method} @${firstShort.price} isBullish=${firstShort.isBullish}`,
            firstLong: `${firstLong.time} ${firstLong.method} @${firstLong.price} isBullish=${firstLong.isBullish}`,
            order: firstShort.time < firstLong.time ? "SHORT先" : "LONG先",
          });
        }
      }
      
      buffer = dayCandles.slice(-100);
    }
  }
  
  console.log(`=== 前場のSHORT/LONG競合分析（10営業日） ===\n`);
  console.log(`競合発生: ${conflicts}件（同一銘柄・同一日の前場にSHORTとLONG両方のシグナル）`);
  console.log(`  SHORT先: ${totalShortFirst}件`);
  console.log(`  LONG先: ${totalLongFirst}件\n`);
  
  console.log(`--- 具体例（最大20件） ---`);
  for (const e of examples) {
    console.log(`\n  ${e.date} ${e.sym} [${e.order}]`);
    console.log(`    SHORT: ${e.firstShort}`);
    console.log(`    LONG:  ${e.firstLong}`);
    console.log(`    (SHORT ${e.shortCount}件, LONG ${e.longCount}件)`);
  }
  
  process.exit(0);
}
main();
