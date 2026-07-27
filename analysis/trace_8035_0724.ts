/**
 * 8035 (東京エレクトロン) 2026-07-24 シグナルエンジン完全トレース
 * 
 * 目的: なぜ取引0件だったのかを特定する
 * 
 * シグナルフロー:
 * 1. detectSignals() → 大台割れ/VWAP反発/ダウ理論シグナル検出
 * 2. isBullish判定 → SHORT禁止チェック
 * 3. 板読みスコア判定 → スコア不足ブロック
 * 4. HTFフィルター → 3分足トレンド逆方向ブロック
 * 5. 大台割れ → 確認バー(5本) → 押し目待ち(5本) → エントリー
 * 6. 大台乖離率フィルター → 0.8%超ブロック
 */
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { sql } from "drizzle-orm";

// Constants from the engine
const NO_ENTRY_BEFORE = "09:30";
const ROUND_LEVEL_CONFIRM_BARS = 5;
const ROUND_PULLBACK_MAX_WAIT = 5;
const ROUND_DISTANCE_BLOCK_THRESHOLD_PCT = 0.8;
const IS_BULLISH_MA_PERIOD = 20;
const IS_BULLISH_SLOPE_THRESHOLD = -0.03;

interface Candle {
  candleTime: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

function detectRoundLevelBreak(prev: Candle, curr: Candle): { level: number; direction: "sell" } | null {
  const step = curr.close >= 10000 ? 100 : 10;
  const prevLevel = Math.floor(prev.close / step) * step;
  const currLevel = Math.floor(curr.close / step) * step;
  if (currLevel < prevLevel) {
    // 大台割れ (下方向)
    return { level: prevLevel, direction: "sell" };
  }
  return null;
}

function calculateRoundDistancePct(price: number, level: number): number {
  return Math.abs((price - level) / level) * 100;
}

async function main() {
  const pool = mysql.createPool({ uri: process.env.DATABASE_URL || "", connectionLimit: 2 });
  const db = drizzle(pool);

  const result = await db.execute(sql`SELECT candleTime, open, high, low, close, volume FROM rt_candles WHERE symbol = '8035' AND tradeDate = '2026-07-24' ORDER BY candleTime ASC`);
  const rows = (result[0] as any[]).map(r => ({
    candleTime: r.candleTime,
    open: Number(r.open),
    high: Number(r.high),
    low: Number(r.low),
    close: Number(r.close),
    volume: Number(r.volume),
  }));

  console.log(`=== 8035 本日のローソク足: ${rows.length}本 ===`);
  console.log(`始値: ${rows[0]?.open} (${rows[0]?.candleTime})`);
  console.log(`安値: ${Math.min(...rows.map(r => r.low))}`);
  console.log(`終値: ${rows[rows.length - 1]?.close} (${rows[rows.length - 1]?.candleTime})`);

  // Simulate the full signal flow
  console.log("\n=== シグナルフロー完全トレース ===\n");

  interface PendingState {
    direction: "sell";
    level: number;
    confirmCount: number;
    reason: string;
    startTime: string;
  }
  interface PullbackState {
    direction: "sell";
    level: number;
    signalPrice: number;
    waitCount: number;
    pulledBack: boolean;
    reason: string;
  }

  let pendingState: PendingState | null = null;
  let pullbackState: PullbackState | null = null;
  let hasPosition = false;
  let entryCount = 0;

  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1];
    const curr = rows[i];
    const time = curr.candleTime;

    // Skip before entry time
    if (time < NO_ENTRY_BEFORE) {
      // But still detect signals for logging
      const roundBreak = detectRoundLevelBreak(prev, curr);
      if (roundBreak) {
        // console.log(`  [${time}] ★大台割れ検出 (${roundBreak.level}円) → エントリー禁止時間帯のためスキップ`);
      }
      continue;
    }

    // Process pending confirmation state
    if (pendingState) {
      if (hasPosition) {
        console.log(`  [${time}] 大台確認待ち: ポジション保有中のためキャンセル`);
        pendingState = null;
      } else {
        const stillValid = curr.close <= pendingState.level;
        if (stillValid) {
          pendingState.confirmCount++;
          if (pendingState.confirmCount >= ROUND_LEVEL_CONFIRM_BARS) {
            console.log(`  [${time}] ★大台確認完了 (${ROUND_LEVEL_CONFIRM_BARS}本維持) → 押し目待ち開始 (キリ番:${pendingState.level}円)`);
            pullbackState = {
              direction: "sell",
              level: pendingState.level,
              signalPrice: curr.close,
              waitCount: 0,
              pulledBack: false,
              reason: `大台確認(${ROUND_LEVEL_CONFIRM_BARS}本維持): ${pendingState.reason}`,
            };
            pendingState = null;
          }
        } else {
          console.log(`  [${time}] ✗ 大台確認キャンセル: キリ番上抜け (${curr.close} > ${pendingState.level}円) [確認${pendingState.confirmCount}/${ROUND_LEVEL_CONFIRM_BARS}本]`);
          pendingState = null;
        }
        if (pendingState) continue; // Still waiting for confirmation
      }
    }

    // Process pullback state
    if (pullbackState) {
      pullbackState.waitCount++;
      // キリ番を上抜けたらキャンセル
      if (curr.close > pullbackState.level) {
        console.log(`  [${time}] ✗ 押し目待ちキャンセル: キリ番上抜け (${curr.close} > ${pullbackState.level}円) [待ち${pullbackState.waitCount}本]`);
        pullbackState = null;
      } else if (pullbackState.waitCount > ROUND_PULLBACK_MAX_WAIT) {
        // タイムアウト → 強トレンドエントリー
        // Check isBullish
        const isBullish = checkIsBullish(rows, i);
        if (isBullish) {
          console.log(`  [${time}] ✗ 押し目タイムアウト: isBullishでSHORTブロック`);
        } else {
          // Check 大台乖離率
          const distPct = calculateRoundDistancePct(curr.close, pullbackState.level);
          if (distPct > ROUND_DISTANCE_BLOCK_THRESHOLD_PCT) {
            console.log(`  [${time}] ✗ 押し目タイムアウト→大台乖離率フィルター: 乖離${distPct.toFixed(2)}% > ${ROUND_DISTANCE_BLOCK_THRESHOLD_PCT}% (価格:${curr.close}, キリ番:${pullbackState.level}円)`);
          } else {
            // Check HTF filter
            const htfTrend = getHTFTrend(rows, i);
            if (htfTrend === "up") {
              console.log(`  [${time}] ✗ 押し目タイムアウト→HTFフィルター: 3分足上昇トレンドでSHORTブロック`);
            } else {
              console.log(`  [${time}] ★★★ エントリー可能! 押し目なし強トレンド SHORT @${curr.close}円 (キリ番:${pullbackState.level}円, 乖離:${distPct.toFixed(2)}%)`);
              entryCount++;
              hasPosition = true;
            }
          }
        }
        pullbackState = null;
      } else {
        // Check pullback
        if (!pullbackState.pulledBack && curr.close > pullbackState.signalPrice) {
          pullbackState.pulledBack = true;
        }
        if (pullbackState.pulledBack && curr.close < pullbackState.signalPrice) {
          // Pullback confirmed → entry attempt
          const isBullish = checkIsBullish(rows, i);
          if (isBullish) {
            console.log(`  [${time}] ✗ 押し目確認: isBullishでSHORTブロック`);
            pullbackState = null;
          } else {
            const distPct = calculateRoundDistancePct(curr.close, pullbackState.level);
            if (distPct > ROUND_DISTANCE_BLOCK_THRESHOLD_PCT) {
              console.log(`  [${time}] ✗ 押し目確認→大台乖離率フィルター: 乖離${distPct.toFixed(2)}% > ${ROUND_DISTANCE_BLOCK_THRESHOLD_PCT}% (価格:${curr.close}, キリ番:${pullbackState.level}円)`);
              pullbackState = null;
            } else {
              const htfTrend = getHTFTrend(rows, i);
              if (htfTrend === "up") {
                console.log(`  [${time}] ✗ 押し目確認→HTFフィルター: 3分足上昇トレンドでSHORTブロック`);
                pullbackState = null;
              } else {
                console.log(`  [${time}] ★★★ エントリー可能! 押し目確認SHORT @${curr.close}円 (キリ番:${pullbackState.level}円, 乖離:${distPct.toFixed(2)}%)`);
                entryCount++;
                hasPosition = true;
                pullbackState = null;
              }
            }
          }
        }
      }
      if (pullbackState) continue;
    }

    // Detect new signals
    if (!hasPosition) {
      const roundBreak = detectRoundLevelBreak(prev, curr);
      if (roundBreak) {
        // Check isBullish FIRST (before entering pending state)
        const isBullish = checkIsBullish(rows, i);
        if (isBullish) {
          console.log(`  [${time}] 大台割れ(${roundBreak.level}円) → isBullishでSHORTブロック (slope=${getSlopeStr(rows, i)})`);
          continue;
        }
        
        // Note: In the actual engine, board score is checked BEFORE entering pending state
        // But we don't have board data here, so we skip that check
        
        console.log(`  [${time}] ★大台割れ検出 → 確認待機開始 (キリ番:${roundBreak.level}円, 価格:${curr.close}円)`);
        pendingState = {
          direction: "sell",
          level: roundBreak.level,
          confirmCount: 0,
          reason: `大台割れ (${roundBreak.level}円割り込み)`,
          startTime: time,
        };
      }
    }
  }

  console.log(`\n=== 結果 ===`);
  console.log(`エントリー可能回数: ${entryCount}`);
  if (entryCount === 0) {
    console.log("\n理由分析:");
    console.log("上記トレースで ✗ マークの箇所がブロック原因です。");
  }

  await pool.end();
}

function checkIsBullish(rows: Candle[], idx: number): boolean {
  if (idx < 2) return false;
  const maPeriod = IS_BULLISH_MA_PERIOD;
  if (idx < maPeriod) {
    const openPrice = rows[0].open;
    const ratio = (rows[idx].close - openPrice) / openPrice * 100;
    return ratio >= 0.2;
  }
  const currentSlice = rows.slice(idx - maPeriod + 1, idx + 1).map(r => r.close);
  const currentMA = currentSlice.reduce((a, b) => a + b, 0) / maPeriod;
  const prevSlice = rows.slice(idx - maPeriod, idx).map(r => r.close);
  const prevMA = prevSlice.reduce((a, b) => a + b, 0) / maPeriod;
  const slope = (currentMA - prevMA) / prevMA * 100;
  return slope > IS_BULLISH_SLOPE_THRESHOLD;
}

function getSlopeStr(rows: Candle[], idx: number): string {
  if (idx < IS_BULLISH_MA_PERIOD) return "fallback";
  const maPeriod = IS_BULLISH_MA_PERIOD;
  const currentSlice = rows.slice(idx - maPeriod + 1, idx + 1).map(r => r.close);
  const currentMA = currentSlice.reduce((a, b) => a + b, 0) / maPeriod;
  const prevSlice = rows.slice(idx - maPeriod, idx).map(r => r.close);
  const prevMA = prevSlice.reduce((a, b) => a + b, 0) / maPeriod;
  const slope = (currentMA - prevMA) / prevMA * 100;
  return slope.toFixed(4) + "%";
}

function getHTFTrend(rows: Candle[], idx: number): "up" | "down" | "neutral" {
  // Simplified 3-min HTF trend: compare 3-min MA direction
  const htfPeriod = 3;
  if (idx < htfPeriod * 2) return "neutral";
  
  const recent3 = rows.slice(idx - htfPeriod + 1, idx + 1);
  const prev3 = rows.slice(idx - htfPeriod * 2 + 1, idx - htfPeriod + 1);
  
  const recentAvg = recent3.reduce((a, b) => a + b.close, 0) / htfPeriod;
  const prevAvg = prev3.reduce((a, b) => a + b.close, 0) / htfPeriod;
  
  const change = (recentAvg - prevAvg) / prevAvg * 100;
  if (change > 0.05) return "up";
  if (change < -0.05) return "down";
  return "neutral";
}

main().catch((e) => { console.error(e); process.exit(1); });
