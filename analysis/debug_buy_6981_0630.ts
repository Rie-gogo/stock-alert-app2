/**
 * Debug: 6981 (村田製作所) 6/30のBUYシグナルがどこでフィルターされるか追跡
 */
import { getDb } from "../server/db";
import { rtCandles } from "../drizzle/schema";
import { eq, and } from "drizzle-orm";
import { detectSignals, calcBollinger } from "../server/routers/stockData";
import { calcVWAP } from "../server/vwap";
import { calcATR } from "../server/intradayRegime";
import { evaluateConfirmation } from "../server/signalConfirmation";

async function main() {
  const db = await getDb();
  const candles = await db.select().from(rtCandles)
    .where(and(
      eq(rtCandles.tradeDate, "2026-06-30"),
      eq(rtCandles.symbol, "6981")
    ));
  candles.sort((a: any, b: any) => a.candleTime.localeCompare(b.candleTime));
  console.log("6981 candles on 6/30:", candles.length);

  const closes = candles.map((c: any) => Number(c.close));
  const highs = candles.map((c: any) => Number(c.high));
  const lows = candles.map((c: any) => Number(c.low));
  const vwapCandles = candles.map((c: any) => ({
    open: Number(c.open), high: Number(c.high), low: Number(c.low),
    close: Number(c.close), volume: Number(c.volume),
  }));
  const vwapArr = calcVWAP(vwapCandles);
  const bb = calcBollinger(closes, 20, 2);
  const atrArr = calcATR(highs, lows, closes, 14);

  const ma5: (number | null)[] = closes.map((_, i) => {
    if (i < 4) return null;
    return (closes[i] + closes[i - 1] + closes[i - 2] + closes[i - 3] + closes[i - 4]) / 5;
  });
  const ma25: (number | null)[] = closes.map((_, i) => {
    if (i < 24) return null;
    let sum = 0;
    for (let j = 0; j < 25; j++) sum += closes[i - j];
    return sum / 25;
  });

  const buffer = candles.map((c: any, i: number) => ({
    open: Number(c.open),
    high: Number(c.high),
    low: Number(c.low),
    close: Number(c.close),
    volume: Number(c.volume),
    time: c.candleTime,
    ma5: ma5[i],
    ma25: ma25[i],
    bbUpper: bb.upper[i] ?? null,
    bbLower: bb.lower[i] ?? null,
    bbMiddle: bb.middle[i] ?? null,
    vwap: vwapArr[i] ?? null,
    atr: atrArr[i] ?? null,
    dayKey: "2026-06-30",
  }));

  const signals = detectSignals(buffer as any);

  // Count all BUY signals and trace filters
  let buyCount = 0;
  let buyStrong = 0;
  let buyOdai = 0;
  let buyOdaiStrong = 0;
  let passVwap = 0;
  let passBullish = 0;
  const allBuySignals: any[] = [];

  for (let i = 0; i < signals.length; i++) {
    const sig = signals[i];
    if (sig === null || sig === undefined) continue;
    if (sig.side !== "BUY") continue;
    buyCount++;

    const conf = evaluateConfirmation(sig, buffer as any, i);
    const isStrong = conf.confidence === "strong";
    if (isStrong) buyStrong++;

    const isOdai = sig.reason.includes("大台超え");
    if (isOdai) {
      buyOdai++;
      if (isStrong) {
        buyOdaiStrong++;
        const close = Number(candles[i].close);
        const vwap = vwapArr[i];
        const vwapPass = vwap !== null && close > vwap;
        if (vwapPass) {
          passVwap++;
          if (i >= 2) {
            const recent3 = candles.slice(i - 2, i + 1);
            const bullish = recent3.filter((c: any) => Number(c.close) > Number(c.open)).length;
            if (bullish >= 2) {
              passBullish++;
              console.log(`  ✓ PASS ALL: ${candles[i].candleTime} close=${close} vwap=${vwap?.toFixed(1)} bullish=${bullish}/3`);
              console.log(`    reason: ${sig.reason}`);
            } else {
              console.log(`  ✗ FAIL(bullish=${bullish}/3): ${candles[i].candleTime} close=${close}`);
            }
          }
        } else {
          console.log(`  ✗ FAIL(close<=VWAP): ${candles[i].candleTime} close=${close} vwap=${vwap?.toFixed(1)}`);
        }
      }
    }

    allBuySignals.push({
      time: candles[i].candleTime,
      reason: sig.reason,
      confidence: conf.confidence,
      isOdai,
      close: Number(candles[i].close),
      vwap: vwapArr[i],
    });
  }

  console.log(`\n=== 6981 6/30 BUYシグナル集計 ===`);
  console.log(`BUY total: ${buyCount}`);
  console.log(`BUY strong: ${buyStrong}`);
  console.log(`大台超え: ${buyOdai}`);
  console.log(`大台超え+strong: ${buyOdaiStrong}`);
  console.log(`+VWAP通過: ${passVwap}`);
  console.log(`+陽線通過(全条件PASS): ${passBullish}`);

  // Show all BUY signal types
  console.log(`\n=== BUYシグナル種別一覧 ===`);
  const byType = new Map<string, number>();
  for (const s of allBuySignals) {
    const key = s.reason.split("(")[0].trim();
    byType.set(key, (byType.get(key) || 0) + 1);
  }
  for (const [type, count] of [...byType.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${type}: ${count}件`);
  }

  // Show strong BUY signals
  console.log(`\n=== strong BUYシグナル詳細 ===`);
  for (const s of allBuySignals.filter(s => s.confidence === "strong")) {
    console.log(`  ${s.time} | ${s.reason.slice(0, 50)} | close=${s.close} vwap=${s.vwap?.toFixed(1)}`);
  }

  // Price progression
  console.log(`\n=== 6981 価格推移 ===`);
  const open = Number(candles[0].close);
  const last = Number(candles[candles.length - 1].close);
  const dayHigh = Math.max(...highs);
  const dayLow = Math.min(...lows);
  console.log(`始値: ${open}, 終値: ${last}, 高値: ${dayHigh}, 安値: ${dayLow}`);
  console.log(`日中変動: ${((last - open) / open * 100).toFixed(2)}%`);
  console.log(`高値到達: +${((dayHigh - open) / open * 100).toFixed(2)}%`);

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
