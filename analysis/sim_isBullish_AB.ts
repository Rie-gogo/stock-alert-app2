/**
 * 本日(2026-07-23)の8035 1分足データを使って、
 * 案A（動的MA傾き判定）と案B（高値比フィルター）を
 * 現行ロジック（始値比0.2%）と比較シミュレーションする。
 *
 * シグナル検出は簡易版（大台割れ＋デッドクロス＋VWAPクロス下抜け）を使用。
 * エントリー後はSL=0.5%, TP=1.5%, EOD=15:25で決済。
 */
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { sql } from "drizzle-orm";

interface Candle {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// --- パラメータ ---
const SL_PCT = 0.5;
const TP_PCT = 1.5;
const POSITION_SIZE = 3_000_000; // 300万円
const NO_ENTRY_BEFORE = "09:30";
const NO_ENTRY_AFTER = "15:05";
const MARKET_CLOSE = "15:25";

// 案A: 動的MA傾き判定
const MA_PERIOD_A = 10; // 10分MA
const SLOPE_THRESHOLD_A = -0.05; // MA傾きが-0.05%/分以下なら下落と判定

// 案B: 高値比フィルター
const HIGH_DROP_THRESHOLD_B = 1.0; // 当日高値から-1.0%下落でisBullish解除

// --- ヘルパー ---
function calcMA(closes: number[], period: number): (number | null)[] {
  return closes.map((_, i) => {
    if (i < period - 1) return null;
    const slice = closes.slice(i - period + 1, i + 1);
    return slice.reduce((a, b) => a + b, 0) / period;
  });
}

function detectRoundLevel(prev: number, curr: number): { crossedBelow: boolean; level: number | null } {
  const step = 100;
  const prevLevel = Math.floor(prev / step) * step;
  const currLevel = Math.floor(curr / step) * step;
  if (currLevel < prevLevel) {
    return { crossedBelow: true, level: currLevel + step };
  }
  return { crossedBelow: false, level: null };
}

interface Trade {
  entryTime: string;
  entryPrice: number;
  exitTime: string;
  exitPrice: number;
  exitReason: string;
  pnl: number;
  signal: string;
}

function simulate(candles: Candle[], isBullishFn: (i: number, candles: Candle[], dayHigh: number) => boolean): Trade[] {
  const trades: Trade[] = [];
  let position: { entryTime: string; entryPrice: number; signal: string } | null = null;
  let dayHigh = 0;
  const closes = candles.map(c => c.close);
  const ma5 = calcMA(closes, 5);
  const ma25 = calcMA(closes, 25);

  // VWAP計算
  let cumVol = 0;
  let cumPV = 0;
  const vwap: number[] = [];
  for (const c of candles) {
    const tp = (c.high + c.low + c.close) / 3;
    cumVol += c.volume;
    cumPV += tp * c.volume;
    vwap.push(cumVol > 0 ? cumPV / cumVol : c.close);
  }

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prev = candles[i - 1];
    dayHigh = Math.max(dayHigh, c.high);

    // ポジション管理
    if (position) {
      // SL check (SHORT: 価格が上がったら損切り)
      const slPrice = position.entryPrice * (1 + SL_PCT / 100);
      if (c.high >= slPrice) {
        trades.push({
          ...position,
          exitTime: c.time,
          exitPrice: slPrice,
          exitReason: "SL",
          pnl: Math.round((position.entryPrice - slPrice) / position.entryPrice * POSITION_SIZE),
        });
        position = null;
        continue;
      }
      // TP check (SHORT: 価格が下がったら利確)
      const tpPrice = position.entryPrice * (1 - TP_PCT / 100);
      if (c.low <= tpPrice) {
        trades.push({
          ...position,
          exitTime: c.time,
          exitPrice: tpPrice,
          exitReason: "TP",
          pnl: Math.round((position.entryPrice - tpPrice) / position.entryPrice * POSITION_SIZE),
        });
        position = null;
        continue;
      }
      // EOD
      if (c.time >= MARKET_CLOSE) {
        const pnl = Math.round((position.entryPrice - c.close) / position.entryPrice * POSITION_SIZE);
        trades.push({
          ...position,
          exitTime: c.time,
          exitPrice: c.close,
          exitReason: "EOD",
          pnl,
        });
        position = null;
        continue;
      }
      continue; // ポジション保有中は新規エントリーしない
    }

    // エントリー時間制限
    if (c.time < NO_ENTRY_BEFORE || c.time >= NO_ENTRY_AFTER) continue;

    // isBullishチェック
    if (isBullishFn(i, candles, dayHigh)) continue; // SHORTブロック

    // シグナル検出（簡易版）
    let signal: string | null = null;

    // 1. 大台割れ
    const { crossedBelow, level } = detectRoundLevel(prev.close, c.close);
    if (crossedBelow && level !== null) {
      signal = `大台割れ (${level}円)`;
    }

    // 2. デッドクロス (MA5 < MA25)
    if (!signal && ma5[i] !== null && ma25[i] !== null && ma5[i - 1] !== null && ma25[i - 1] !== null) {
      if (ma5[i - 1]! >= ma25[i - 1]! && ma5[i]! < ma25[i]!) {
        signal = `デッドクロス (MA5:${ma5[i]!.toFixed(0)} < MA25:${ma25[i]!.toFixed(0)})`;
      }
    }

    // 3. VWAPクロス下抜け
    if (!signal && i >= 1) {
      if (prev.close > vwap[i - 1] && c.close <= vwap[i]) {
        signal = `VWAPクロス下抜け (VWAP:${vwap[i].toFixed(0)})`;
      }
    }

    if (signal && !position) {
      position = { entryTime: c.time, entryPrice: c.close, signal };
    }
  }

  return trades;
}

async function main() {
  const pool = mysql.createPool(process.env.DATABASE_URL || "");
  const db = drizzle(pool);

  // 8035の本日1分足を取得
  const result = await db.execute(sql`
    SELECT candleTime, open, high, low, close, volume
    FROM rt_candles
    WHERE symbol = '8035' AND tradeDate = '2026-07-23'
    ORDER BY candleTime ASC
  `);
  const candles: Candle[] = (result[0] as any[]).map(r => ({
    time: r.candleTime,
    open: Number(r.open),
    high: Number(r.high),
    low: Number(r.low),
    close: Number(r.close),
    volume: Number(r.volume),
  }));

  console.log(`=== 8035 本日シミュレーション (${candles.length}本) ===`);
  console.log(`始値(buffer[0].open): ${candles[0].open}`);
  console.log(`高値: ${Math.max(...candles.map(c => c.high))}`);
  console.log(`安値: ${Math.min(...candles.map(c => c.low))}`);
  console.log(`終値: ${candles[candles.length - 1].close}`);
  console.log("");

  // --- 現行ロジック: 始値比0.2% ---
  const currentTrades = simulate(candles, (i, cds) => {
    const openPrice = cds[0].open;
    return (cds[i].close - openPrice) / openPrice * 100 >= 0.2;
  });

  // --- 案A: 動的MA傾き判定 ---
  // MA10の傾きが負（下落中）ならisBullish=false
  const planATrades = simulate(candles, (i, cds) => {
    if (i < MA_PERIOD_A) {
      // ウォームアップ中は現行ロジックにフォールバック
      const openPrice = cds[0].open;
      return (cds[i].close - openPrice) / openPrice * 100 >= 0.2;
    }
    const closes = cds.slice(i - MA_PERIOD_A + 1, i + 1).map(c => c.close);
    const ma = closes.reduce((a, b) => a + b, 0) / closes.length;
    const prevCloses = cds.slice(i - MA_PERIOD_A, i).map(c => c.close);
    const prevMa = prevCloses.reduce((a, b) => a + b, 0) / prevCloses.length;
    // 傾き = (現在MA - 前MA) / 前MA * 100 (%)
    const slope = (ma - prevMa) / prevMa * 100;
    // 傾きが閾値以下なら下落中 → isBullish=false
    return slope > SLOPE_THRESHOLD_A;
  });

  // --- 案B: 高値比フィルター ---
  // 当日高値から-1.0%以上下落したらisBullish解除
  const planBTrades = simulate(candles, (i, cds, dayHigh) => {
    const openPrice = cds[0].open;
    const basicBullish = (cds[i].close - openPrice) / openPrice * 100 >= 0.2;
    if (!basicBullish) return false; // 始値比で既にfalseなら解除
    // 高値比チェック
    const dropFromHigh = (dayHigh - cds[i].close) / dayHigh * 100;
    if (dropFromHigh >= HIGH_DROP_THRESHOLD_B) return false; // 高値から1%以上下落 → 解除
    return true;
  });

  // --- 結果出力 ---
  console.log("=== 現行ロジック（始値比0.2%） ===");
  if (currentTrades.length === 0) {
    console.log("取引なし（終日SHORTブロック）");
  } else {
    for (const t of currentTrades) {
      console.log(`  ${t.entryTime} SHORT @${t.entryPrice} → ${t.exitTime} @${t.exitPrice} (${t.exitReason}) pnl=${t.pnl.toLocaleString()} | ${t.signal}`);
    }
  }
  const currentPnl = currentTrades.reduce((s, t) => s + t.pnl, 0);
  console.log(`  合計: ${currentTrades.length}件, 損益=${currentPnl.toLocaleString()}円`);

  console.log("\n=== 案A: 動的MA傾き判定 (MA10傾き < -0.05%/分でSHORT許可) ===");
  for (const t of planATrades) {
    console.log(`  ${t.entryTime} SHORT @${t.entryPrice} → ${t.exitTime} @${t.exitPrice} (${t.exitReason}) pnl=${t.pnl.toLocaleString()} | ${t.signal}`);
  }
  const planAPnl = planATrades.reduce((s, t) => s + t.pnl, 0);
  console.log(`  合計: ${planATrades.length}件, 損益=${planAPnl.toLocaleString()}円`);

  console.log("\n=== 案B: 高値比フィルター (高値から-1.0%でSHORT許可) ===");
  for (const t of planBTrades) {
    console.log(`  ${t.entryTime} SHORT @${t.entryPrice} → ${t.exitTime} @${t.exitPrice} (${t.exitReason}) pnl=${t.pnl.toLocaleString()} | ${t.signal}`);
  }
  const planBPnl = planBTrades.reduce((s, t) => s + t.pnl, 0);
  console.log(`  合計: ${planBTrades.length}件, 損益=${planBPnl.toLocaleString()}円`);

  // --- isBullish解除タイミング比較 ---
  console.log("\n=== isBullish解除タイミング ===");
  let dayHigh = 0;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    dayHigh = Math.max(dayHigh, c.high);
    
    // 現行
    const currentBullish = (c.close - candles[0].open) / candles[0].open * 100 >= 0.2;
    
    // 案A
    let planABullish = true;
    if (i >= MA_PERIOD_A) {
      const closes = candles.slice(i - MA_PERIOD_A + 1, i + 1).map(x => x.close);
      const ma = closes.reduce((a, b) => a + b, 0) / closes.length;
      const prevCloses = candles.slice(i - MA_PERIOD_A, i).map(x => x.close);
      const prevMa = prevCloses.reduce((a, b) => a + b, 0) / prevCloses.length;
      const slope = (ma - prevMa) / prevMa * 100;
      planABullish = slope > SLOPE_THRESHOLD_A;
    }
    
    // 案B
    const basicBullish = (c.close - candles[0].open) / candles[0].open * 100 >= 0.2;
    const dropFromHigh = (dayHigh - c.close) / dayHigh * 100;
    const planBBullish = basicBullish && dropFromHigh < HIGH_DROP_THRESHOLD_B;

    // 解除タイミングを表示（変化があった時のみ）
    if (i > 0) {
      const prevC = candles[i - 1];
      let prevDayHigh = 0;
      for (let j = 0; j <= i - 1; j++) prevDayHigh = Math.max(prevDayHigh, candles[j].high);
      
      const prevCurrentBullish = (prevC.close - candles[0].open) / candles[0].open * 100 >= 0.2;
      
      let prevPlanABullish = true;
      if (i - 1 >= MA_PERIOD_A) {
        const pc = candles.slice(i - MA_PERIOD_A, i).map(x => x.close);
        const pma = pc.reduce((a, b) => a + b, 0) / pc.length;
        const ppc = candles.slice(i - MA_PERIOD_A - 1, i - 1).map(x => x.close);
        const ppma = ppc.reduce((a, b) => a + b, 0) / ppc.length;
        prevPlanABullish = (pma - ppma) / ppma * 100 > SLOPE_THRESHOLD_A;
      }
      
      const prevBasicBullish = (prevC.close - candles[0].open) / candles[0].open * 100 >= 0.2;
      const prevDropFromHigh = (prevDayHigh - prevC.close) / prevDayHigh * 100;
      const prevPlanBBullish = prevBasicBullish && prevDropFromHigh < HIGH_DROP_THRESHOLD_B;

      if (prevCurrentBullish && !currentBullish) {
        console.log(`  現行: ${c.time} で解除 (始値比=${((c.close - candles[0].open) / candles[0].open * 100).toFixed(2)}%)`);
      }
      if (prevPlanABullish && !planABullish) {
        console.log(`  案A: ${c.time} で解除 (MA10傾き下落検知)`);
      }
      if (prevPlanBBullish && !planBBullish) {
        console.log(`  案B: ${c.time} で解除 (高値${dayHigh}から-${dropFromHigh.toFixed(2)}%下落)`);
      }
    }
  }

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
