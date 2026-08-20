import { getDb } from "../server/db";
import { sql } from "drizzle-orm";

const IS_BULLISH_MA_PERIOD = 8;
const IS_BULLISH_SLOPE_THRESHOLD = 0;

const idealShort = [
  { sym: "6857", name: "アドバンテスト", start: "10:05", end: "10:19" },
  { sym: "8035", name: "東京エレクトロン", start: "10:05", end: "10:15" },
  { sym: "5803", name: "フジクラ", start: "10:00", end: "10:54" },
  { sym: "6981", name: "村田製作所", start: "10:07", end: "10:19" },
  { sym: "6976", name: "太陽誘電", start: "10:08", end: "10:19" },
  { sym: "6146", name: "ディスコ", start: "10:02", end: "10:14" },
];
const idealLong = [
  { sym: "6857", name: "アドバンテスト", start: "12:50", end: "13:40" },
  { sym: "8035", name: "東京エレクトロン", start: "12:40", end: "13:05" },
  { sym: "285A", name: "キオクシア", start: "10:33", end: "12:50" },
  { sym: "5803", name: "フジクラ", start: "12:42", end: "13:15" },
  { sym: "6981", name: "村田製作所1", start: "09:30", end: "09:50" },
  { sym: "6981", name: "村田製作所2", start: "11:10", end: "12:40" },
  { sym: "6976", name: "太陽誘電1", start: "09:30", end: "09:44" },
  { sym: "6976", name: "太陽誘電2", start: "11:20", end: "13:00" },
  { sym: "6146", name: "ディスコ", start: "12:42", end: "13:30" },
];

async function main() {
  const db = await getDb();
  const prevDate = "2026-08-19";
  
  console.log("=== 本日8/20 理想エントリー分析 ===\n");
  
  // 全銘柄のデータ取得
  const allSymbols = [...new Set([...idealShort, ...idealLong].map(i => i.sym))];
  const symData: Record<string, any[]> = {};
  
  for (const sym of allSymbols) {
    const [rows] = await db.execute(sql`
      SELECT tradeDate, candleTime, open, high, low, close, volume
      FROM rt_candles WHERE symbol=${sym} AND tradeDate >= ${prevDate} AND tradeDate <= '2026-08-20'
      ORDER BY tradeDate, candleTime
    `);
    symData[sym] = (rows as any[]).map((r: any) => ({
      ...r, open: +r.open, high: +r.high, low: +r.low, close: +r.close, volume: +r.volume
    }));
  }
  
  // === SHORT理想分析 ===
  console.log("========== SHORT理想エントリー ==========\n");
  for (const ideal of idealShort) {
    const candles = symData[ideal.sym];
    const todayCandles = candles.filter((c: any) => c.tradeDate === "2026-08-20");
    const allBuffer = candles.filter((c: any) => c.tradeDate <= "2026-08-20");
    
    console.log(`--- ${ideal.sym} ${ideal.name} SHORT ${ideal.start}〜${ideal.end} ---`);
    
    // 理想時間帯の値動き
    const rangeCandles = todayCandles.filter((c: any) => c.candleTime >= ideal.start && c.candleTime <= ideal.end);
    if (rangeCandles.length > 0) {
      const startPrice = rangeCandles[0].open;
      const endPrice = rangeCandles[rangeCandles.length - 1].close;
      const minLow = Math.min(...rangeCandles.map((c: any) => c.low));
      const maxHigh = Math.max(...rangeCandles.map((c: any) => c.high));
      console.log(`  値動き: ${startPrice}→${endPrice} (${((endPrice-startPrice)/startPrice*100).toFixed(2)}%)`);
      console.log(`  高値: ${maxHigh} 安値: ${minLow}`);
    }
    
    // 各足でのisBullish状態とシグナル条件チェック
    let foundEntry = false;
    for (const c of rangeCandles) {
      const idx = allBuffer.findIndex((b: any) => b.tradeDate === c.tradeDate && b.candleTime === c.candleTime);
      if (idx < IS_BULLISH_MA_PERIOD + 1) continue;
      const buf = allBuffer.slice(0, idx + 1);
      
      // isBullish
      const maPeriod = IS_BULLISH_MA_PERIOD;
      const ma = buf.slice(-maPeriod).reduce((s: number, b: any) => s + b.close, 0) / maPeriod;
      const prevMa = buf.slice(-maPeriod - 1, -1).reduce((s: number, b: any) => s + b.close, 0) / maPeriod;
      const slope = ((ma - prevMa) / prevMa * 100);
      const isBullish = slope > IS_BULLISH_SLOPE_THRESHOLD;
      
      // 大台割れチェック
      const prev = buf[buf.length - 2];
      let roundBreak = "";
      for (const rl of [100, 500, 1000, 5000, 10000]) {
        const nearestAbove = Math.ceil(prev.close / rl) * rl;
        if (prev.close >= nearestAbove && c.close < nearestAbove) {
          roundBreak = `${nearestAbove}円割れ`;
        }
      }
      
      // 直近安値更新チェック
      let lowBreak = false;
      if (buf.length >= 21) {
        const minLow20 = Math.min(...buf.slice(-21, -1).map((b: any) => b.low));
        if (c.close < minLow20) lowBreak = true;
      }
      
      // 出来高
      let volRatio = 0;
      if (buf.length >= 21) {
        const vol20 = buf.slice(-21, -1).reduce((s: number, b: any) => s + b.volume, 0) / 20;
        volRatio = vol20 > 0 ? c.volume / vol20 : 0;
      }
      
      // ATR
      let atrPct = 0;
      if (buf.length >= 20) {
        const atrBuf = buf.slice(-20);
        const atr = atrBuf.reduce((s: number, b: any) => s + (b.high - b.low), 0) / 20;
        atrPct = atr / c.close * 100;
      }
      
      const blocks: string[] = [];
      if (isBullish) blocks.push(`isBullish=true(MA8傾き${slope.toFixed(3)}%)`);
      if (atrPct < 0.12) blocks.push(`ATR不足(${atrPct.toFixed(3)}%)`);
      if (!roundBreak && !lowBreak) blocks.push("シグナルなし(大台割れ/安値更新なし)");
      
      const signal = roundBreak || (lowBreak ? "安値更新" : "");
      
      if (!foundEntry) {
        console.log(`  ${c.candleTime}: close=${c.close} isBullish=${isBullish}(${slope.toFixed(3)}%) vol=${volRatio.toFixed(1)}x ATR=${atrPct.toFixed(3)}% ${signal ? "★"+signal : ""} ${blocks.length > 0 ? "ブロック:["+blocks.join(", ")+"]" : "→ エントリー可能"}`);
      }
      if (blocks.length === 0 && signal && !foundEntry) {
        foundEntry = true;
        console.log(`  ★ ${c.candleTime}でSHORTエントリー可能!`);
      }
    }
    if (!foundEntry) {
      console.log(`  ✗ 理想時間帯内でSHORTエントリー不可`);
    }
    console.log();
  }
  
  // === LONG理想分析 ===
  console.log("\n========== LONG理想エントリー ==========\n");
  for (const ideal of idealLong) {
    const sym = ideal.sym;
    const candles = symData[sym];
    const todayCandles = candles.filter((c: any) => c.tradeDate === "2026-08-20");
    const allBuffer = candles.filter((c: any) => c.tradeDate <= "2026-08-20");
    
    console.log(`--- ${sym} ${ideal.name} LONG ${ideal.start}〜${ideal.end} ---`);
    
    const rangeCandles = todayCandles.filter((c: any) => c.candleTime >= ideal.start && c.candleTime <= ideal.end);
    if (rangeCandles.length > 0) {
      const startPrice = rangeCandles[0].open;
      const endPrice = rangeCandles[rangeCandles.length - 1].close;
      console.log(`  値動き: ${startPrice}→${endPrice} (${((endPrice-startPrice)/startPrice*100).toFixed(2)}%)`);
    }
    
    let foundEntry = false;
    for (const c of rangeCandles) {
      const idx = allBuffer.findIndex((b: any) => b.tradeDate === c.tradeDate && b.candleTime === c.candleTime);
      if (idx < IS_BULLISH_MA_PERIOD + 1) continue;
      const buf = allBuffer.slice(0, idx + 1);
      
      const maPeriod = IS_BULLISH_MA_PERIOD;
      const ma = buf.slice(-maPeriod).reduce((s: number, b: any) => s + b.close, 0) / maPeriod;
      const prevMa = buf.slice(-maPeriod - 1, -1).reduce((s: number, b: any) => s + b.close, 0) / maPeriod;
      const slope = ((ma - prevMa) / prevMa * 100);
      const isBullish = slope > IS_BULLISH_SLOPE_THRESHOLD;
      
      // 直近高値更新
      let highBreak = false;
      if (buf.length >= 21) {
        const maxHigh20 = Math.max(...buf.slice(-21, -1).map((b: any) => b.high));
        if (c.close > maxHigh20) highBreak = true;
      }
      
      // バイパス条件
      const maDeviation = Math.abs((c.close - ma) / ma * 100);
      const barBody = Math.abs((c.close - c.open) / c.open * 100);
      const bearBars = buf.slice(-10).filter((b: any) => b.close < b.open).length;
      
      // 出来高
      let volRatio = 0;
      if (buf.length >= 21) {
        const vol20 = buf.slice(-21, -1).reduce((s: number, b: any) => s + b.volume, 0) / 20;
        volRatio = vol20 > 0 ? c.volume / vol20 : 0;
      }
      
      const [h, m2] = c.candleTime.split(":").map(Number);
      const timeMin = h * 60 + m2;
      const isAM = timeMin < 688;
      
      const blocks: string[] = [];
      if (!isBullish) blocks.push(`isBullish=false(MA8傾き${slope.toFixed(3)}%)`);
      if (!highBreak) blocks.push("高値更新なし");
      if (highBreak && isBullish) {
        // バイパス条件チェック
        const bypassOk = maDeviation < 0.5 && barBody < 0.2 && bearBars <= 4;
        const volBreakOk = isAM && volRatio >= 1.5;
        if (!bypassOk && !volBreakOk) {
          blocks.push(`条件不足(MA乖離${maDeviation.toFixed(2)}% 実体${barBody.toFixed(2)}% 陰線${bearBars} vol${volRatio.toFixed(1)}x ${isAM?"前場":"後場"})`);
        }
      }
      
      if (!foundEntry && (c.candleTime === rangeCandles[0].candleTime || c.candleTime === rangeCandles[Math.min(2, rangeCandles.length-1)].candleTime || c.candleTime === rangeCandles[Math.min(5, rangeCandles.length-1)].candleTime || c.candleTime === rangeCandles[Math.min(10, rangeCandles.length-1)].candleTime || blocks.length === 0)) {
        console.log(`  ${c.candleTime}: close=${c.close} isBullish=${isBullish}(${slope.toFixed(3)}%) 高値更新=${highBreak} MA乖離=${maDeviation.toFixed(2)}% 実体=${barBody.toFixed(2)}% 陰線=${bearBars} vol=${volRatio.toFixed(1)}x ${blocks.length > 0 ? "ブロック:["+blocks.join(", ")+"]" : "→ エントリー可能"}`);
      }
      if (blocks.length === 0 && !foundEntry) {
        foundEntry = true;
        console.log(`  ★ ${c.candleTime}でLONGエントリー可能!`);
      }
    }
    if (!foundEntry) {
      console.log(`  ✗ 理想時間帯内でLONGエントリー不可`);
    }
    console.log();
  }
  
  process.exit(0);
}
main();
