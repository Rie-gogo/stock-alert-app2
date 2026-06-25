/**
 * フルシミュレーションのデバッグ: 最初のシグナルでなぜエントリーしないかを追跡
 */
import * as fs from "fs";
import { detectSignals, calcMA, calcRSI, calcBollinger, type CandleWithSignal } from "../server/routers/stockData";
import { TARGET_STOCKS } from "../shared/stocks";
import { getHigherTfTrend } from "../server/vwap";
import { calcATR } from "../server/intradayRegime";

const ALLOWED_SYMBOLS = new Set(TARGET_STOCKS.map(s => s.symbol));
const MIN_CANDLES_FOR_SIGNAL = 30;
const BOARD_SCORE_THRESHOLD = 1;
const ATR_FILTER_PERIOD = 7;
const ATR_FILTER_THRESHOLD = 0.0012;

interface RtCandleRow {
  symbol: string; tradeDate: string; candleTime: string;
  open: number; high: number; low: number; close: number; volume: number;
  boardSnapshot: any;
}

const dataPath = "/tmp/rt_candles_20260625.json";
const candles: RtCandleRow[] = JSON.parse(fs.readFileSync(dataPath, "utf8"));

// 8035のみ追跡
const symbol = "8035";
const rows = candles
  .filter(c => c.symbol === symbol)
  .filter(c => !(c.candleTime >= "11:30" && c.candleTime < "12:30"))
  .sort((a, b) => a.candleTime < b.candleTime ? -1 : 1);

console.log(`${symbol}: ${rows.length}本`);

const buffer: CandleWithSignal[] = [];
const bprHistory: number[] = [];
let signalFound = 0;

for (const row of rows) {
  if (row.boardSnapshot) {
    bprHistory.push(row.boardSnapshot.buyPressureRatio);
    if (bprHistory.length > 5) bprHistory.shift();
  }

  buffer.push({
    time: `${row.tradeDate}T${row.candleTime}:00`,
    dayKey: row.tradeDate,
    timestamp: new Date(`${row.tradeDate}T${row.candleTime}:00+09:00`).getTime(),
    open: row.open, high: row.high, low: row.low, close: row.close, volume: row.volume,
    ma5: null, ma25: null, rsi: null,
    bbUpper: null, bbMiddle: null, bbLower: null,
  });

  const closes = buffer.map(c => c.close);
  const ma5S = calcMA(closes, 5);
  const ma25S = calcMA(closes, 25);
  const rsiS = calcRSI(closes, 14);
  const bbS = calcBollinger(closes, 20);
  const li = buffer.length - 1;
  buffer[li].ma5 = ma5S[li];
  buffer[li].ma25 = ma25S[li];
  buffer[li].rsi = rsiS[li];
  buffer[li].bbUpper = bbS.upper[li];
  buffer[li].bbMiddle = bbS.middle[li];
  buffer[li].bbLower = bbS.lower[li];

  if (row.candleTime < "09:30" || row.candleTime >= "15:15") continue;
  if (buffer.length < MIN_CANDLES_FOR_SIGNAL) continue;

  const withSignals = detectSignals(buffer);
  const latest = withSignals[withSignals.length - 1];
  buffer[buffer.length - 1] = latest;

  if (!latest.signal) continue;
  signalFound++;
  if (signalFound > 10) continue;

  const sig = latest.signal;
  const bs = row.boardSnapshot;
  
  console.log(`\n--- ${row.candleTime} ${sig.type} [${sig.reason.slice(0, 50)}] ---`);
  console.log(`  close=${row.close}, volume=${row.volume}`);
  console.log(`  boardSnapshot: signal=${bs?.signal}, bpr=${bs?.buyPressureRatio}, marketOrderRatio=${bs?.marketOrderRatio}`);
  
  // VWAPクロス上抜け無効化チェック
  if (sig.type === "buy" && sig.reason.includes("VWAPクロス上抜け")) {
    console.log(`  → VWAPクロス上抜け無効化`);
    continue;
  }
  
  // sell_pressure / buy_pressure チェック
  if (sig.type === "buy" && bs?.signal === "sell_pressure") {
    console.log(`  → sell_pressure時LONG禁止`);
    continue;
  }
  if (sig.type === "sell" && bs?.signal === "buy_pressure") {
    console.log(`  → buy_pressure時SHORT禁止`);
    continue;
  }

  // 板読みスコア計算（簡易版）
  let score = 0;
  if (bs) {
    const side = sig.type === "buy" ? "long" : "short";
    // A) アグレッシブ注文
    if (bs.marketOrderRatio >= 0.08) {
      if (bs.marketOrderDirection === "buy") score += (side === "long" ? 2 : -2);
      else if (bs.marketOrderDirection === "sell") score += (side === "short" ? 2 : -2);
    }
    // B) 厚い板
    if (side === "long" && bs.largeBuyWall) score += 1;
    if (side === "long" && bs.largeSellWall) score -= 1;
    if (side === "short" && bs.largeSellWall) score += 1;
    if (side === "short" && bs.largeBuyWall) score -= 1;
    // C) 板圧力トレンド
    if (bprHistory.length >= 3) {
      const first = bprHistory[0];
      const last = bprHistory[bprHistory.length - 1];
      const delta = last - first;
      if (delta >= 0.15 && side === "long") score += 1;
      if (delta <= -0.15 && side === "short") score += 1;
      if (delta >= 0.15 && side === "short") score -= 1;
      if (delta <= -0.15 && side === "long") score -= 1;
    }
    // D) 相場モード
    if (bs.marketOrderRatio >= 0.08) score += 1;
    else if (bs.largeBuyWall || bs.largeSellWall) {
      if (bs.buyPressureRatio >= 1.3 || bs.buyPressureRatio <= 0.7) score += 1;
      else score -= 2;
    } else score -= 2;
    // E) 板圧力の強さ
    if (bs.buyPressureRatio >= 1.4 && side === "long") score += 1;
    if (bs.buyPressureRatio <= 0.65 && side === "short") score += 1;
    if (bs.buyPressureRatio >= 1.4 && side === "short") score -= 1;
    if (bs.buyPressureRatio <= 0.65 && side === "long") score -= 1;
  }
  console.log(`  板読みスコア: ${score} (閾値: ${BOARD_SCORE_THRESHOLD})`);
  if (score < BOARD_SCORE_THRESHOLD) {
    console.log(`  → 板読みスコア不足でブロック`);
    continue;
  }

  // ダウ理論 → 5分足フィルター
  if (sig.reason.startsWith("ダウ理論: 直近高値更新") && sig.recentSwingLow != null) {
    const htfTrend = getHigherTfTrend(buffer, buffer.length - 1, 5);
    console.log(`  5分足トレンド: ${htfTrend}`);
    if (htfTrend !== "up") {
      console.log(`  → 5分足フィルターでブロック`);
      continue;
    }
  }
  if (sig.reason.startsWith("ダウ理論: 直近安値更新")) {
    const htfTrend = getHigherTfTrend(buffer, buffer.length - 1, 5);
    console.log(`  5分足トレンド: ${htfTrend}`);
    if (htfTrend !== "down") {
      console.log(`  → 5分足フィルターでブロック`);
      continue;
    }
  }

  // 大台超え → ステートマシン
  if (sig.reason.startsWith("大台超え") || sig.reason.startsWith("大台割れ")) {
    console.log(`  → 大台確認バーステートマシンに登録`);
    continue;
  }

  // ATRフィルター
  if (buffer.length >= ATR_FILTER_PERIOD + 1) {
    const highs = buffer.map(c => c.high);
    const lows = buffer.map(c => c.low);
    const closesArr = buffer.map(c => c.close);
    const atrSeries = calcATR(highs, lows, closesArr, ATR_FILTER_PERIOD);
    const latestATR = atrSeries[atrSeries.length - 1];
    if (latestATR !== null && row.close > 0) {
      const atrRatio = latestATR / row.close;
      console.log(`  ATR率: ${(atrRatio * 100).toFixed(4)}% (閾値: ${(ATR_FILTER_THRESHOLD * 100).toFixed(2)}%)`);
      if (atrRatio < ATR_FILTER_THRESHOLD) {
        console.log(`  → ATRフィルターでブロック`);
        continue;
      }
    }
  }

  console.log(`  → エントリー可能!`);
}
