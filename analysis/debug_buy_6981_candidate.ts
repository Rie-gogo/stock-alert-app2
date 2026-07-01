/**
 * Deep debug: 6981 6/30 - trace every BUY candidate and where it gets killed
 * Manually replicate detectSignals logic step by step
 */
import { getDb } from "../server/db";
import { rtCandles } from "../drizzle/schema";
import { eq, and } from "drizzle-orm";
import { calcBollinger } from "../server/routers/stockData";
import { calcVWAP, detectRoundLevel, detectHeadAndShoulders } from "../server/vwap";
import { calcATR, classifyIntradayRegime, isSignalAllowedInRegime } from "../server/intradayRegime";
import { evaluateConfirmation } from "../server/signalConfirmation";

// Replicate helper functions from stockData.ts
function trailingAvgVolume(volumes: number[], idx: number, window: number): number {
  let sum = 0, count = 0;
  for (let j = Math.max(0, idx - window); j < idx; j++) {
    sum += volumes[j]; count++;
  }
  return count > 0 ? sum / count : volumes[idx];
}

function isVolumeConfirmed(current: number, avg: number): boolean {
  return current >= avg * 0.8;
}

function ma25Slope(ma25Series: (number | null)[], i: number): number | null {
  if (i < 5) return null;
  const curr = ma25Series[i];
  const prev = ma25Series[i - 5];
  if (curr === null || prev === null || prev === 0) return null;
  return (curr - prev) / prev * 100;
}

function dayChangeRatio(close: number, dayOpen: number | null): number | null {
  if (dayOpen === null || dayOpen === 0) return null;
  return (close - dayOpen) / dayOpen * 100;
}

function isLongLowerShadow(c: { open: number; high: number; low: number; close: number }): boolean {
  const body = Math.abs(c.close - c.open);
  const lowerShadow = Math.min(c.open, c.close) - c.low;
  const totalRange = c.high - c.low;
  return totalRange > 0 && lowerShadow / totalRange >= 0.6 && body / totalRange <= 0.3;
}

async function main() {
  const db = await getDb();
  const candles = await db.select().from(rtCandles)
    .where(and(
      eq(rtCandles.tradeDate, "2026-06-30"),
      eq(rtCandles.symbol, "6981")
    ));
  candles.sort((a: any, b: any) => a.candleTime.localeCompare(b.candleTime));

  const closes = candles.map((c: any) => Number(c.close));
  const highs = candles.map((c: any) => Number(c.high));
  const lows = candles.map((c: any) => Number(c.low));
  const opens = candles.map((c: any) => Number(c.open));
  const volumes = candles.map((c: any) => Number(c.volume));
  const dayOpen = opens[0];

  // MA
  const ma5: (number | null)[] = closes.map((_, i) => {
    if (i < 4) return null;
    return (closes[i] + closes[i-1] + closes[i-2] + closes[i-3] + closes[i-4]) / 5;
  });
  const ma25: (number | null)[] = closes.map((_, i) => {
    if (i < 24) return null;
    let sum = 0; for (let j = 0; j < 25; j++) sum += closes[i-j]; return sum / 25;
  });

  // VWAP
  const vwapCandles = candles.map((c: any) => ({
    open: Number(c.open), high: Number(c.high), low: Number(c.low),
    close: Number(c.close), volume: Number(c.volume),
  }));
  const vwapArr = calcVWAP(vwapCandles);

  // RSI (14)
  const rsi: (number | null)[] = [];
  let avgGain = 0, avgLoss = 0;
  for (let i = 0; i < closes.length; i++) {
    if (i === 0) { rsi.push(null); continue; }
    const change = closes[i] - closes[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    if (i <= 14) {
      avgGain += gain; avgLoss += loss;
      if (i === 14) { avgGain /= 14; avgLoss /= 14; }
      rsi.push(i < 14 ? null : (avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)));
    } else {
      avgGain = (avgGain * 13 + gain) / 14;
      avgLoss = (avgLoss * 13 + loss) / 14;
      rsi.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
    }
  }

  // Track candidates
  const stats = {
    total: 0,
    gcCandidate: 0,
    rsiCandidate: 0,
    vwapCrossUp: 0,
    dowTheory: 0,
    lowerShadow: 0,
    harami: 0,
    roundLevel: 0,
    vwapBounce: 0,
    doubleBottom: 0,
    ihs: 0,
    noCandidate: 0,
    regimeBlocked: 0,
    adxBlocked: 0,
    confirmBarBlocked: 0,
    weakBlocked: 0,
    signalEmitted: 0,
  };

  // Simplified: just check what BUY candidates form and where they die
  let buyCandidates = 0;
  const candidateLog: string[] = [];

  for (let i = 25; i < candles.length; i++) {
    const c5 = ma5[i]!;
    const c25 = ma25[i]!;
    const p5 = ma5[i - 1];
    const p25 = ma25[i - 1];
    if (c5 === null || c25 === null || p5 === null || p25 === null) continue;

    const close = closes[i];
    const prev = { close: closes[i - 1], open: opens[i - 1], high: highs[i - 1], low: lows[i - 1] };
    const curr = { close: closes[i], open: opens[i], high: highs[i], low: lows[i] };

    // Regime
    const slope = ma25Slope(ma25, i);
    const dayChange = dayChangeRatio(close, dayOpen);
    const regime = classifyIntradayRegime({ slope, dayChange });

    // GC check
    const isGC = p5 <= p25 && c5 > c25;
    const maDiv = c25 !== 0 ? Math.abs(c5 - c25) / c25 * 100 : 0;

    // VWAP cross up
    const vwapCurr = vwapArr[i];
    const vwapPrev = vwapArr[i - 1];
    const vwapCrossUp = vwapCurr !== null && vwapPrev !== null &&
      closes[i - 1] < vwapPrev && closes[i] >= vwapCurr;

    // Round level
    const { crossedAbove: roundUp, level: roundLevel } = detectRoundLevel(closes[i - 1], closes[i]);

    let candidateType: string | null = null;

    // Evaluate in priority order (same as detectSignals)
    if (isGC && maDiv >= 0.1) {
      candidateType = "GC";
    } else if (vwapCrossUp && regime !== "down" && isVolumeConfirmed(volumes[i], trailingAvgVolume(volumes, i, 10))) {
      candidateType = "VWAPクロス上抜け";
    } else if (roundUp && roundLevel !== null && regime !== "down") {
      candidateType = `大台超え(${roundLevel}円)`;
    }
    // Simplified - skip other patterns for now

    if (candidateType) {
      buyCandidates++;

      // Check regime
      const allowed = isSignalAllowedInRegime("buy", regime);
      if (!allowed) {
        stats.regimeBlocked++;
        candidateLog.push(`${candles[i].candleTime} ${candidateType} → REGIME BLOCKED (${regime})`);
        continue;
      }

      // Check confirmation (simplified)
      const cRsi = rsi[i] ?? 50;
      const isStrongUp = c5 > c25 && close >= c5;

      // GC confirmation bar filter
      if (candidateType === "GC" && close < c5) {
        stats.confirmBarBlocked++;
        candidateLog.push(`${candles[i].candleTime} ${candidateType} → CONFIRM BAR BLOCKED (close < MA5)`);
        continue;
      }

      // If passed all filters
      candidateLog.push(`${candles[i].candleTime} ${candidateType} → PASSED (regime=${regime}, close=${close})`);
      stats.signalEmitted++;
    }
  }

  console.log(`\n=== BUY候補トレース (6981 6/30) ===`);
  console.log(`BUY候補数: ${buyCandidates}`);
  console.log(`regime blocked: ${stats.regimeBlocked}`);
  console.log(`confirm bar blocked: ${stats.confirmBarBlocked}`);
  console.log(`signal emitted: ${stats.signalEmitted}`);

  console.log(`\n=== 候補ログ (最初の30件) ===`);
  for (const log of candidateLog.slice(0, 30)) {
    console.log(`  ${log}`);
  }
  console.log(`  ... (合計 ${candidateLog.length}件)`);

  // Now check: in the real detectSignals, what's different?
  // The key difference is RSI+BB check comes before VWAP and round level
  // And Dow theory (swingHighBreak) also comes before round level
  // Let's check if Dow theory signals are being generated
  console.log(`\n=== ダウ理論チェック ===`);
  let swingHighCount = 0;
  const lookback = 20;
  for (let i = lookback; i < candles.length; i++) {
    // Simple swing high break detection
    const recentHighs = highs.slice(Math.max(0, i - lookback), i);
    const recentMax = Math.max(...recentHighs);
    if (highs[i] > recentMax && c5 !== null && c25 !== null && ma5[i]! > ma25[i]!) {
      swingHighCount++;
    }
  }
  console.log(`ダウ理論(直近高値更新+上昇トレンド): ${swingHighCount}回`);

  // The real issue: in detectSignals, the candidate is formed but then
  // evaluateConfirmation returns shouldNotify=false (weak confidence)
  // Let's check this
  console.log(`\n=== evaluateConfirmation結果チェック ===`);
  let weakCount = 0, mediumCount = 0, strongCount = 0;
  for (const log of candidateLog.filter(l => l.includes("PASSED"))) {
    const timeStr = log.split(" ")[0];
    const idx = candles.findIndex((c: any) => c.candleTime === timeStr);
    if (idx < 0) continue;
    const conf = evaluateConfirmation({
      type: "buy",
      close: closes[idx],
      volume: volumes[idx],
      avgVolume: trailingAvgVolume(volumes, idx, 10),
      ma5: ma5[idx]!,
      ma25: ma25[idx]!,
      momentum: 0,
      regime: classifyIntradayRegime({ slope: ma25Slope(ma25, idx), dayChange: dayChangeRatio(closes[idx], dayOpen) }),
    });
    if (conf.confidence === "weak") weakCount++;
    else if (conf.confidence === "medium") mediumCount++;
    else strongCount++;
    if (conf.confidence !== "weak") {
      console.log(`  ${timeStr}: ${conf.confidence} shouldNotify=${conf.shouldNotify} | ${conf.summary}`);
    }
  }
  console.log(`\n  weak: ${weakCount}, medium: ${mediumCount}, strong: ${strongCount}`);

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
