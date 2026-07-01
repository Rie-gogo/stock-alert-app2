/**
 * Deep debug: 6981 (村田製作所) 6/30 - なぜBUYシグナルが0件なのか
 * detectSignals内部の各ステップを手動でトレースする
 */
import { getDb } from "../server/db";
import { rtCandles } from "../drizzle/schema";
import { eq, and } from "drizzle-orm";
import { calcBollinger } from "../server/routers/stockData";
import { calcVWAP, detectRoundLevel } from "../server/vwap";
import { calcATR, classifyIntradayRegime, isSignalAllowedInRegime } from "../server/intradayRegime";

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

  // MA計算
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

  // dayOpen
  const dayOpen = Number(candles[0].open);
  console.log(`dayOpen: ${dayOpen}`);

  // 大台超え検出
  let roundLevelBreakups = 0;
  let regimeBlocked = 0;
  let candidateButHigherPriority = 0;

  for (let i = 1; i < candles.length; i++) {
    const prevClose = Number(candles[i - 1].close);
    const currClose = Number(candles[i].close);

    // 大台超え判定
    const { crossedAbove, level } = detectRoundLevel(prevClose, currClose);
    if (crossedAbove && level !== null) {
      roundLevelBreakups++;

      // レジーム判定
      const c5 = ma5[i];
      const c25 = ma25[i];
      // MA25 slope
      let slope: number | null = null;
      if (i >= 29 && ma25[i] !== null && ma25[i - 5] !== null) {
        slope = (ma25[i]! - ma25[i - 5]!) / ma25[i - 5]! * 100;
      }
      const dayChange = (currClose - dayOpen) / dayOpen * 100;
      const regime = classifyIntradayRegime({ slope, dayChange });
      const allowed = isSignalAllowedInRegime("buy", regime);

      // 他のシグナルが先に評価されるか確認
      // GC, RSI+BB, VWAPクロス上抜け, ダウ理論, 長い下ヒゲ, はらみ線 が先に評価される
      // これらのいずれかが成立していれば大台超えは評価されない（else if構造）
      const hasGC = i >= 1 && ma5[i - 1] !== null && ma25[i - 1] !== null && ma5[i] !== null && ma25[i] !== null
        && ma5[i - 1]! <= ma25[i - 1]! && ma5[i]! > ma25[i]!;

      const time = candles[i].candleTime;
      if (!allowed) {
        regimeBlocked++;
        if (roundLevelBreakups <= 10 || !allowed) {
          console.log(`  大台超え ${time}: ${level}円突破 | regime=${regime}(slope=${slope?.toFixed(3)},dayChg=${dayChange.toFixed(2)}%) → BLOCKED(regime)`);
        }
      } else {
        console.log(`  大台超え ${time}: ${level}円突破 | regime=${regime}(slope=${slope?.toFixed(3)},dayChg=${dayChange.toFixed(2)}%) → ALLOWED`);
        console.log(`    ※ else if構造のため、先行シグナル(GC/RSI+BB/VWAP/ダウ理論等)が成立していれば到達しない`);
      }
    }
  }

  console.log(`\n=== サマリー ===`);
  console.log(`大台超え検出: ${roundLevelBreakups}回`);
  console.log(`  regime blocked: ${regimeBlocked}回`);
  console.log(`  regime allowed: ${roundLevelBreakups - regimeBlocked}回`);

  // 価格帯チェック
  console.log(`\n=== 価格推移（100円単位の大台） ===`);
  let lastLevel = Math.floor(Number(candles[0].close) / 100) * 100;
  for (let i = 1; i < candles.length; i++) {
    const currLevel = Math.floor(Number(candles[i].close) / 100) * 100;
    if (currLevel !== lastLevel) {
      const time = candles[i].candleTime;
      const close = Number(candles[i].close);
      const dir = currLevel > lastLevel ? "↑" : "↓";
      console.log(`  ${time}: ${lastLevel} → ${currLevel} (${dir}) close=${close}`);
      lastLevel = currLevel;
    }
  }

  // レジーム推移
  console.log(`\n=== レジーム推移（30分ごと） ===`);
  for (let i = 30; i < candles.length; i += 30) {
    const currClose = Number(candles[i].close);
    let slope: number | null = null;
    if (i >= 29 && ma25[i] !== null && ma25[i - 5] !== null) {
      slope = (ma25[i]! - ma25[i - 5]!) / ma25[i - 5]! * 100;
    }
    const dayChange = (currClose - dayOpen) / dayOpen * 100;
    const regime = classifyIntradayRegime({ slope, dayChange });
    console.log(`  ${candles[i].candleTime}: regime=${regime} | slope=${slope?.toFixed(4)} | dayChg=${dayChange.toFixed(2)}% | close=${currClose}`);
  }

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
