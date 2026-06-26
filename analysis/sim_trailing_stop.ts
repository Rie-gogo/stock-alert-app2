/**
 * sim_trailing_stop.ts
 * 2段階損切り（トレーリングストップ）シミュレーション
 * 
 * 現行: 固定SL 0.5% / 固定TP 1.5%
 * 案4: 初期SL広め → 含み益で建値ストップ → トレーリング
 * 
 * 実行: cd /home/ubuntu/stock-alert-app && npx tsx analysis/sim_trailing_stop.ts
 */
import * as fs from "fs";
import { detectSignals, calcMA, calcRSI, calcBollinger, type CandleWithSignal } from "../server/routers/stockData";
import { TARGET_STOCKS } from "../shared/stocks";
import { getHigherTfTrend } from "../server/vwap";
import { calcATR, calcADX } from "../server/intradayRegime";
import type { BoardSnapshot } from "../drizzle/schema";

// === 定数 ===
const INITIAL_CAPITAL_PER_STOCK = 3_000_000;
const LOT_RATIO = 0.9;
const MARGIN_CAPITAL = 3_000_000;
const MARGIN_MULTIPLIER = 3.3;
const MARGIN_USAGE_LIMIT = 0.9;
const MAX_TOTAL_EXPOSURE = MARGIN_CAPITAL * MARGIN_MULTIPLIER * MARGIN_USAGE_LIMIT;
const NO_ENTRY_AFTER = "15:15";
const NO_ENTRY_BEFORE = "09:30";
const MIN_CANDLES_FOR_SIGNAL = 30;
const PULLBACK_MAX_WAIT = 5;
const ROUND_PULLBACK_MAX_WAIT = 5;
const ATR_FILTER_PERIOD = 7;
const ATR_FILTER_THRESHOLD = 0.0012;
const PULLBACK_DEPTH_LOOKBACK = 20;
const NO_REENTRY_AFTER_STOPLOSS_MIN = 30;
const VOLUME_UNAVAILABLE_RATIO = 0.9;
const BOARD_EARLY_EXIT_MIN_PROFIT_PCT = 0.05;
const ROUND_LEVEL_CONFIRM_BARS = 5;
const MARKET_CLOSE_TIME = "15:30";
const ALLOWED_SYMBOLS = new Set(TARGET_STOCKS.map(s => s.symbol));
const HIGH_VOL_SYMBOLS = new Set(["6920", "6981", "6976", "5016", "6526", "5803"]);

// === 2段階損切り設定 ===
interface TrailingStopConfig {
  label: string;
  // 初期損切り幅（%）
  initialSL: number;
  // 建値ストップ発動条件（含み益%）
  breakevenTrigger: number;
  // トレーリング開始条件（含み益%）
  trailTrigger: number;
  // トレーリング幅（ピークからの戻り%）
  trailGap: number;
  // 固定利確（0=無効、トレーリングのみで決済）
  fixedTP: number;
  // 板読み早期利確を使うか
  useBoardEarlyExit: boolean;
}

// === 型定義 ===
interface RtCandleRow { symbol: string; tradeDate: string; candleTime: string; open: number; high: number; low: number; close: number; volume: number; boardSnapshot: BoardSnapshot | null; }
interface OpenPosition {
  symbol: string; side: "long" | "short"; entryPrice: number; shares: number; entryTime: string; entryReason: string;
  // 2段階損切り用の追加ステート
  highWater: number;  // long: 最高値 / short: 最安値
  phase: "initial" | "breakeven" | "trailing";
}
interface Trade { date: string; time: string; sym: string; action: string; price: number; pnl?: number; reason: string; shares: number; exitPhase?: string; }

// === ヘルパー ===
function calcShares(price: number): number { return Math.max(100, Math.floor(Math.floor(INITIAL_CAPITAL_PER_STOCK * LOT_RATIO / price) / 100) * 100); }
function timeToMinutes(t: string): number { const [h, m] = t.split(":").map(Number); return h * 60 + m; }
function checkVolumeUnavailable(buffer: CandleWithSignal[]): boolean { if (buffer.length < 10) return false; const lb = Math.min(buffer.length, 20); const rc = buffer.slice(-lb); return (rc.filter(c => c.volume === 0).length / lb) >= VOLUME_UNAVAILABLE_RATIO; }
function calcCurrentExposure(op: Map<string, OpenPosition>): number { let t = 0; for (const p of op.values()) t += p.entryPrice * p.shares; return t; }

function estimateTickDirection(bprHistoryArr: number[], snapshot: BoardSnapshot | null): "uptick" | "downtick" | "neutral" {
  if (!snapshot) return "neutral";
  const mod = (snapshot as any).marketOrderDirection;
  if (mod === "buy") return "uptick"; if (mod === "sell") return "downtick";
  if (bprHistoryArr.length < 2) return "neutral";
  const last = bprHistoryArr[bprHistoryArr.length - 1];
  const avg = bprHistoryArr.slice(0, -1).reduce((a, b) => a + b, 0) / (bprHistoryArr.length - 1);
  const trend = last - avg;
  if (trend >= 0.2) return "uptick"; if (trend <= -0.2) return "downtick";
  if (last >= 1.3) return "uptick"; if (last <= 0.7) return "downtick";
  return "neutral";
}

function boardReadingScoreBC(bprHistoryArr: number[], side: "long" | "short", snapshot: BoardSnapshot | null): number {
  let score = 0;
  if (!snapshot) return 0;
  const bpr = snapshot.buyPressureRatio;
  if (side === "long") { if (bpr >= 1.5) score += 2; else if (bpr >= 1.2) score += 1; if (bpr < 0.7) score -= 2; else if (bpr < 0.9) score -= 1; }
  else { if (bpr <= 0.6) score += 2; else if (bpr <= 0.8) score += 1; if (bpr > 1.4) score -= 2; else if (bpr > 1.1) score -= 1; }
  const tickDir = estimateTickDirection(bprHistoryArr, snapshot);
  if (tickDir === "uptick") { if (side === "long") score += 2; else score -= 2; } else if (tickDir === "downtick") { if (side === "short") score += 2; else score -= 2; }
  if (bprHistoryArr.length >= 3) {
    const last3 = bprHistoryArr.slice(-3);
    const increasing = last3.every((v, i) => i === 0 || v >= last3[i - 1]);
    const decreasing = last3.every((v, i) => i === 0 || v <= last3[i - 1]);
    if (side === "long" && increasing) score += 1; if (side === "short" && decreasing) score += 1;
    if (side === "long" && decreasing) score -= 1; if (side === "short" && increasing) score -= 1;
  }
  const sig = snapshot.signal;
  if (sig === "buy_pressure" && side === "long") score += 1; if (sig === "sell_pressure" && side === "short") score += 1;
  if (sig === "buy_pressure" && side === "short") score -= 1; if (sig === "sell_pressure" && side === "long") score -= 1;
  return score;
}

function shouldBoardEarlyExit(pos: OpenPosition, currentPrice: number, boardSnapshot: BoardSnapshot | null): boolean {
  if (!boardSnapshot) return false;
  const profitPct = pos.side === "long" ? (currentPrice - pos.entryPrice) / pos.entryPrice : (pos.entryPrice - currentPrice) / pos.entryPrice;
  if (profitPct < BOARD_EARLY_EXIT_MIN_PROFIT_PCT) return false;
  if (pos.side === "long" && boardSnapshot.signal === "sell_pressure") return true;
  if (pos.side === "short" && boardSnapshot.signal === "buy_pressure") return true;
  return false;
}

// === データ読み込み ===
const DATES = ["2026-06-17", "2026-06-18", "2026-06-19", "2026-06-22", "2026-06-23", "2026-06-24", "2026-06-25"];

function loadDayData(date: string): RtCandleRow[] {
  const file = `/tmp/rt_candles_${date.replace(/-/g, "")}.json`;
  if (!fs.existsSync(file)) return [];
  const raw: any[] = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const c of raw) {
    c.open = Number(c.open); c.high = Number(c.high); c.low = Number(c.low); c.close = Number(c.close); c.volume = Number(c.volume);
    if (typeof c.boardSnapshot === "string") c.boardSnapshot = JSON.parse(c.boardSnapshot);
  }
  return raw as RtCandleRow[];
}

// === シミュレーション本体 ===
function simulateDay(dayData: RtCandleRow[], tsConfig: TrailingStopConfig): { trades: Trade[]; totalPnl: number } {
  const trades: Trade[] = [];
  let totalPnl = 0;
  const openPositions = new Map<string, OpenPosition>();
  const candleBuffers = new Map<string, CandleWithSignal[]>();
  const bprHistories = new Map<string, number[]>();
  const pullbackStates = new Map<string, any>();
  const roundLevelPendingStates = new Map<string, any>();
  const roundPullbackStates = new Map<string, any>();
  const lastStopLossTime = new Map<string, string>();

  const sorted = [...dayData].sort((a, b) => a.candleTime.localeCompare(b.candleTime) || a.symbol.localeCompare(b.symbol));

  for (const row of sorted) {
    const { symbol, tradeDate, candleTime, open, high, low, close, volume, boardSnapshot } = row;
    if (!ALLOWED_SYMBOLS.has(symbol)) continue;

    const buffer = candleBuffers.get(symbol) ?? [];
    candleBuffers.set(symbol, buffer);
    if (boardSnapshot) {
      const h = bprHistories.get(symbol) ?? [];
      h.push(boardSnapshot.buyPressureRatio);
      if (h.length > 5) h.shift();
      bprHistories.set(symbol, h);
    }
    const c4s: CandleWithSignal = { time: `${tradeDate}T${candleTime}:00`, dayKey: tradeDate, timestamp: new Date(`${tradeDate}T${candleTime}:00+09:00`).getTime(), open, high, low, close, volume, ma5: null, ma25: null, rsi: null, bbUpper: null, bbMiddle: null, bbLower: null };
    buffer.push(c4s);
    const closes = buffer.map(c => c.close);
    const li = buffer.length - 1;
    const ma5S = calcMA(closes, 5); const ma25S = calcMA(closes, 25); const rsiS = calcRSI(closes, 14); const bbS = calcBollinger(closes, 20);
    buffer[li].ma5 = ma5S[li]; buffer[li].ma25 = ma25S[li]; buffer[li].rsi = rsiS[li]; buffer[li].bbUpper = bbS.upper[li]; buffer[li].bbMiddle = bbS.middle[li]; buffer[li].bbLower = bbS.lower[li];

    // === 決済チェック（2段階損切り） ===
    const existingPos = openPositions.get(symbol);
    if (existingPos) {
      const { entryPrice, shares, side } = existingPos;

      // 大引け強制決済
      if (candleTime >= MARKET_CLOSE_TIME) {
        const pnl = side === "long" ? (close - entryPrice) * shares : (entryPrice - close) * shares;
        totalPnl += pnl; trades.push({ date: tradeDate, time: candleTime, sym: symbol, action: "forced_close", price: close, pnl, reason: "大引け強制決済", shares, exitPhase: existingPos.phase });
        openPositions.delete(symbol); continue;
      }

      // HighWater更新
      if (side === "long") {
        if (high > existingPos.highWater) existingPos.highWater = high;
      } else {
        if (low < existingPos.highWater) existingPos.highWater = low;
      }

      // 含み益率計算
      const gain = side === "long"
        ? (existingPos.highWater - entryPrice) / entryPrice
        : (entryPrice - existingPos.highWater) / entryPrice;

      // フェーズ遷移
      if (existingPos.phase === "initial" && gain >= tsConfig.breakevenTrigger) {
        existingPos.phase = "breakeven";
      }
      if (existingPos.phase === "breakeven" && gain >= tsConfig.trailTrigger) {
        existingPos.phase = "trailing";
      }

      // 損切りライン決定
      let stopPrice: number;
      let stopReason: string;

      if (side === "long") {
        if (existingPos.phase === "trailing") {
          stopPrice = existingPos.highWater * (1 - tsConfig.trailGap / 100);
          stopReason = `トレイリング利確(peak:${existingPos.highWater.toFixed(0)}→gap:${tsConfig.trailGap}%)`;
        } else if (existingPos.phase === "breakeven") {
          stopPrice = Math.max(entryPrice * (1 - tsConfig.initialSL / 100), entryPrice);
          stopReason = "建値ストップ";
        } else {
          stopPrice = entryPrice * (1 - tsConfig.initialSL / 100);
          stopReason = `初期損切り(${tsConfig.initialSL}%)`;
        }
      } else {
        if (existingPos.phase === "trailing") {
          stopPrice = existingPos.highWater * (1 + tsConfig.trailGap / 100);
          stopReason = `トレイリング利確(bottom:${existingPos.highWater.toFixed(0)}→gap:${tsConfig.trailGap}%)`;
        } else if (existingPos.phase === "breakeven") {
          stopPrice = Math.min(entryPrice * (1 + tsConfig.initialSL / 100), entryPrice);
          stopReason = "建値ストップ";
        } else {
          stopPrice = entryPrice * (1 + tsConfig.initialSL / 100);
          stopReason = `初期損切り(${tsConfig.initialSL}%)`;
        }
      }

      let exitPrice: number | null = null;
      let exitReason = "";

      // 損切り/トレーリング判定
      if (side === "long") {
        if (low <= stopPrice) { exitPrice = stopPrice; exitReason = stopReason; }
        // 固定TP（有効な場合）
        if (tsConfig.fixedTP > 0) {
          const tp = entryPrice * (1 + tsConfig.fixedTP / 100);
          if (high >= tp && (exitPrice === null || tp > exitPrice)) { exitPrice = tp; exitReason = `固定利確(${tsConfig.fixedTP}%)`; }
        }
      } else {
        if (high >= stopPrice) { exitPrice = stopPrice; exitReason = stopReason; }
        if (tsConfig.fixedTP > 0) {
          const tp = entryPrice * (1 - tsConfig.fixedTP / 100);
          if (low <= tp && (exitPrice === null || tp < exitPrice)) { exitPrice = tp; exitReason = `固定利確(${tsConfig.fixedTP}%)`; }
        }
      }

      // シグナル反転
      if (exitPrice === null && buffer.length >= MIN_CANDLES_FOR_SIGNAL) {
        const ws = detectSignals(buffer); const latest = ws[ws.length - 1]; buffer[buffer.length - 1] = latest;
        if (latest.signal) {
          if (side === "long" && latest.signal.type === "sell") { exitPrice = close; exitReason = "シグナル反転"; }
          else if (side === "short" && latest.signal.type === "buy") { exitPrice = close; exitReason = "シグナル反転"; }
        }
      }

      // 板読み早期利確
      if (exitPrice === null && tsConfig.useBoardEarlyExit && shouldBoardEarlyExit(existingPos, close, boardSnapshot)) {
        exitPrice = close; exitReason = "板読み早期利確";
      }

      if (exitPrice !== null) {
        const pnl = side === "long" ? (exitPrice - entryPrice) * shares : (entryPrice - exitPrice) * shares;
        totalPnl += pnl;
        trades.push({ date: tradeDate, time: candleTime, sym: symbol, action: "exit", price: exitPrice, pnl, reason: exitReason, shares, exitPhase: existingPos.phase });
        openPositions.delete(symbol);
        if (exitReason.includes("損切り") || exitReason.includes("建値")) lastStopLossTime.set(symbol, candleTime);
      }
      continue;
    }

    // === エントリー（現行と同じロジック） ===
    if (candleTime < NO_ENTRY_BEFORE || candleTime >= NO_ENTRY_AFTER) continue;
    if ((candleTime >= "11:00" && candleTime < "11:30") || (candleTime >= "12:30" && candleTime < "13:00")) continue;
    if (buffer.length < MIN_CANDLES_FOR_SIGNAL) continue;

    const withSignals = detectSignals(buffer); const latestSignal = withSignals[withSignals.length - 1]; buffer[buffer.length - 1] = latestSignal;
    const firstCandle = buffer[0]; const priceChangeRatio = (close - firstCandle.open) / firstCandle.open * 100; const isBullish = priceChangeRatio >= 0.2;

    if (!latestSignal.signal) continue;
    const sig = latestSignal.signal;
    const isMedium = sig.reason?.includes("信頼度：中");
    if (isMedium) continue; // medium禁止（現行と同じ）

    // 板読みスコア
    const bprH = bprHistories.get(symbol) ?? [];
    const brScore = boardReadingScoreBC(bprH, sig.type === "buy" ? "long" : "short", boardSnapshot);
    if (brScore < 1) continue;

    // ATRフィルター
    if (buffer.length >= ATR_FILTER_PERIOD + 1) {
      const atr = calcATR(buffer.slice(-ATR_FILTER_PERIOD - 1), ATR_FILTER_PERIOD);
      if (atr < ATR_FILTER_THRESHOLD * close) continue;
    }

    // 出来高チェック
    if (checkVolumeUnavailable(buffer)) continue;

    // 損切り後再エントリー禁止
    const lastSL = lastStopLossTime.get(symbol);
    if (lastSL && (timeToMinutes(candleTime) - timeToMinutes(lastSL)) < NO_REENTRY_AFTER_STOPLOSS_MIN) continue;

    const shares = calcShares(close);
    const amount = close * shares;
    if (calcCurrentExposure(openPositions) + amount > MAX_TOTAL_EXPOSURE) continue;

    // ダウ理論: 押し目待ちステートマシン
    if (sig.reason?.startsWith("ダウ理論")) {
      const side = sig.type === "buy" ? "long" : "short";
      pullbackStates.set(symbol, { side, peakPrice: close, waitCount: 0, reason: sig.reason });
      continue;
    }

    // 大台超え/割れ: 確認バー待ち
    if (sig.reason?.startsWith("大台超え") || sig.reason?.startsWith("大台割れ")) {
      const direction = sig.type === "buy" ? "buy" : "sell";
      const m = sig.reason.match(/(\d+(?:\.\d+)?)円/); const level = m ? parseFloat(m[1]) : close;
      roundLevelPendingStates.set(symbol, { direction, level, confirmCount: 0, reason: sig.reason });
      continue;
    }

    // 直接エントリー
    if (sig.type === "buy") {
      openPositions.set(symbol, { symbol, side: "long", entryPrice: close, shares, entryTime: candleTime, entryReason: sig.reason ?? "", highWater: close, phase: "initial" });
      trades.push({ date: tradeDate, time: candleTime, sym: symbol, action: "buy", price: close, reason: sig.reason ?? "", shares });
    } else {
      openPositions.set(symbol, { symbol, side: "short", entryPrice: close, shares, entryTime: candleTime, entryReason: sig.reason ?? "", highWater: close, phase: "initial" });
      trades.push({ date: tradeDate, time: candleTime, sym: symbol, action: "short", price: close, reason: sig.reason ?? "", shares });
    }
  }

  // ダウ理論押し目確認（簡易版: 各足で確認）
  // 注: 上のメインループ内で処理するのが正確だが、ここでは簡略化のため省略
  // 押し目ステートマシンは既にメインループ内で処理されているため、
  // ここでは残ったpullbackStatesをクリアするだけ

  return { trades, totalPnl };
}

// === 設定パターン ===
const CONFIGS: TrailingStopConfig[] = [
  // 現行仕様: 固定SL 0.5% / 固定TP 1.5%
  {
    label: "現行仕様(SL:0.5%/TP:1.5%固定)",
    initialSL: 0.5,
    breakevenTrigger: 999, // 発動しない（実質無効）
    trailTrigger: 999,     // 発動しない
    trailGap: 0.5,
    fixedTP: 1.5,
    useBoardEarlyExit: true,
  },
  // 案4-A: 初期SL 0.8% → 建値0.3% → トレーリング0.5%（TP無効）
  {
    label: "案4-A(SL:0.8%→建値0.3%→トレイル0.5%)",
    initialSL: 0.8,
    breakevenTrigger: 0.3,
    trailTrigger: 0.8,
    trailGap: 0.5,
    fixedTP: 0,  // 固定TP無効、トレーリングのみ
    useBoardEarlyExit: true,
  },
  // 案4-B: 初期SL 1.0% → 建値0.5% → トレーリング0.5%（TP無効）
  {
    label: "案4-B(SL:1.0%→建値0.5%→トレイル0.5%)",
    initialSL: 1.0,
    breakevenTrigger: 0.5,
    trailTrigger: 1.0,
    trailGap: 0.5,
    fixedTP: 0,
    useBoardEarlyExit: true,
  },
  // 案4-C: 初期SL 1.0% → 建値0.5% → トレーリング0.3%（狭いトレイル）
  {
    label: "案4-C(SL:1.0%→建値0.5%→トレイル0.3%)",
    initialSL: 1.0,
    breakevenTrigger: 0.5,
    trailTrigger: 1.0,
    trailGap: 0.3,
    fixedTP: 0,
    useBoardEarlyExit: true,
  },
  // 案4-D: 初期SL 1.0% → 建値0.5% → トレーリング0.5% + 固定TP 2.0%
  {
    label: "案4-D(SL:1.0%→建値0.5%→トレイル0.5%+TP:2%)",
    initialSL: 1.0,
    breakevenTrigger: 0.5,
    trailTrigger: 1.0,
    trailGap: 0.5,
    fixedTP: 2.0,
    useBoardEarlyExit: true,
  },
  // 案4-E: 初期SL 0.8% → 建値0.3% → トレーリング0.4% + 固定TP 2.0%
  {
    label: "案4-E(SL:0.8%→建値0.3%→トレイル0.4%+TP:2%)",
    initialSL: 0.8,
    breakevenTrigger: 0.3,
    trailTrigger: 0.8,
    trailGap: 0.4,
    fixedTP: 2.0,
    useBoardEarlyExit: true,
  },
];

// === メイン実行 ===
console.log("=".repeat(80));
console.log("2段階損切り（トレーリングストップ）シミュレーション");
console.log("（7日間: 6/17〜6/25）");
console.log("=".repeat(80));
console.log("");

// データプリロード
const allDayData = new Map<string, RtCandleRow[]>();
for (const date of DATES) { allDayData.set(date, loadDayData(date)); }

interface DetailResult {
  label: string;
  totalPnl: number;
  trades: Trade[];
  daily: { date: string; pnl: number; trades: number }[];
}
const detailResults: DetailResult[] = [];

for (const config of CONFIGS) {
  let totalPnl = 0;
  const allTrades: Trade[] = [];
  const daily: { date: string; pnl: number; trades: number }[] = [];

  for (const date of DATES) {
    const dayData = allDayData.get(date)!;
    if (dayData.length === 0) { daily.push({ date, pnl: 0, trades: 0 }); continue; }
    const result = simulateDay(dayData, config);
    const closed = result.trades.filter(t => t.pnl !== undefined);
    totalPnl += result.totalPnl;
    allTrades.push(...result.trades);
    daily.push({ date, pnl: result.totalPnl, trades: closed.length });
  }

  detailResults.push({ label: config.label, totalPnl, trades: allTrades, daily });
}

// === サマリー ===
console.log("=".repeat(80));
console.log("サマリー（合計損益順）");
console.log("=".repeat(80));
console.log("");

const sorted = [...detailResults].sort((a, b) => b.totalPnl - a.totalPnl);
const basePnl = detailResults[0].totalPnl;

console.log("順位 | 設定                                              | 合計損益      | 差分       | 取引数 | 勝率  | 平均損益");
console.log("-----|---------------------------------------------------|-------------|-----------|--------|-------|--------");
for (let i = 0; i < sorted.length; i++) {
  const r = sorted[i];
  const closed = r.trades.filter(t => t.pnl !== undefined);
  const wins = closed.filter(t => (t.pnl ?? 0) > 0).length;
  const wr = closed.length > 0 ? Math.round(wins / closed.length * 100) : 0;
  const diff = r.totalPnl - basePnl;
  const avgPnl = closed.length > 0 ? Math.round(r.totalPnl / closed.length) : 0;
  console.log(`  ${i + 1}  | ${r.label.padEnd(49)} | ${(r.totalPnl >= 0 ? "+" : "") + Math.round(r.totalPnl).toLocaleString().padStart(9)}円 | ${(diff >= 0 ? "+" : "") + Math.round(diff).toLocaleString().padStart(7)}円 | ${String(closed.length).padStart(4)}T | ${String(wr).padStart(3)}%  | ${(avgPnl >= 0 ? "+" : "") + avgPnl.toLocaleString()}円`);
}

// === 日別比較 ===
console.log("");
console.log("=".repeat(80));
console.log("日別損益比較");
console.log("=".repeat(80));
console.log("");

const header = "日付       | " + detailResults.map(r => r.label.substring(0, 22).padEnd(22)).join(" | ");
console.log(header);
console.log("-".repeat(header.length));
for (let i = 0; i < DATES.length; i++) {
  const d = DATES[i];
  const cells = detailResults.map(r => {
    const day = r.daily[i];
    return `${(day.pnl >= 0 ? "+" : "") + Math.round(day.pnl).toLocaleString().padStart(8)}円(${day.trades}T)`.padEnd(22);
  });
  console.log(`${d} | ${cells.join(" | ")}`);
}

// === トレード詳細（現行 vs 最良案） ===
console.log("");
console.log("=".repeat(80));
console.log("全トレード詳細比較（現行 vs 最良案）");
console.log("=".repeat(80));
console.log("");

const bestIdx = detailResults.indexOf(sorted[0]);
const baseResult = detailResults[0];
const bestResult = detailResults[bestIdx];

console.log(`--- 現行仕様 トレード一覧 ---`);
console.log("日付       | 時刻  | 銘柄 | 方向  | エントリー | 決済     | 損益       | 理由");
console.log("-----------|-------|------|-------|-----------|---------|-----------|----");
for (const t of baseResult.trades.filter(t => t.pnl !== undefined)) {
  const entry = baseResult.trades.find(e => e.sym === t.sym && e.date === t.date && (e.action === "buy" || e.action === "short") && e.time < t.time);
  console.log(`${t.date} | ${t.time} | ${t.sym} | ${(entry?.action ?? "?").padEnd(5)} | ${(entry?.price?.toFixed(0) ?? "?").padStart(9)} | ${t.price.toFixed(0).padStart(7)} | ${((t.pnl ?? 0) >= 0 ? "+" : "") + Math.round(t.pnl ?? 0).toLocaleString().padStart(8)}円 | ${t.reason}`);
}

if (bestIdx !== 0) {
  console.log("");
  console.log(`--- ${bestResult.label} トレード一覧 ---`);
  console.log("日付       | 時刻  | 銘柄 | 方向  | エントリー | 決済     | 損益       | 理由                    | フェーズ");
  console.log("-----------|-------|------|-------|-----------|---------|-----------|------------------------|--------");
  for (const t of bestResult.trades.filter(t => t.pnl !== undefined)) {
    const entry = bestResult.trades.find(e => e.sym === t.sym && e.date === t.date && (e.action === "buy" || e.action === "short") && e.time < t.time);
    console.log(`${t.date} | ${t.time} | ${t.sym} | ${(entry?.action ?? "?").padEnd(5)} | ${(entry?.price?.toFixed(0) ?? "?").padStart(9)} | ${t.price.toFixed(0).padStart(7)} | ${((t.pnl ?? 0) >= 0 ? "+" : "") + Math.round(t.pnl ?? 0).toLocaleString().padStart(8)}円 | ${(t.reason ?? "").substring(0, 24).padEnd(24)} | ${t.exitPhase ?? ""}`);
  }
}

// === 決済理由の内訳 ===
console.log("");
console.log("=".repeat(80));
console.log("決済理由の内訳");
console.log("=".repeat(80));
console.log("");

for (const r of detailResults) {
  const closed = r.trades.filter(t => t.pnl !== undefined);
  const reasons = new Map<string, { count: number; totalPnl: number }>();
  for (const t of closed) {
    const key = t.reason.split("(")[0]; // パラメータ部分を除去
    const existing = reasons.get(key) ?? { count: 0, totalPnl: 0 };
    existing.count++;
    existing.totalPnl += t.pnl ?? 0;
    reasons.set(key, existing);
  }
  console.log(`--- ${r.label} ---`);
  for (const [reason, stats] of [...reasons.entries()].sort((a, b) => b[1].totalPnl - a[1].totalPnl)) {
    console.log(`  ${reason.padEnd(25)} | ${String(stats.count).padStart(2)}件 | ${(stats.totalPnl >= 0 ? "+" : "") + Math.round(stats.totalPnl).toLocaleString().padStart(8)}円`);
  }
  console.log("");
}

// === JX金属・ソシオネクストの個別追跡 ===
console.log("=".repeat(80));
console.log("注目銘柄の詳細追跡（本日6/26のケースに類似する6/25のトレード）");
console.log("=".repeat(80));
console.log("");

for (const targetSym of ["5016", "6526"]) {
  console.log(`--- ${targetSym} ---`);
  for (const r of detailResults) {
    const symTrades = r.trades.filter(t => t.sym === targetSym);
    if (symTrades.length === 0) continue;
    console.log(`  [${r.label.substring(0, 30)}]`);
    for (const t of symTrades) {
      const pnlStr = t.pnl !== undefined ? `${(t.pnl >= 0 ? "+" : "")}${Math.round(t.pnl).toLocaleString()}円` : "";
      console.log(`    ${t.date} ${t.time} ${t.action.padEnd(12)} @${t.price.toFixed(0).padStart(7)} ${pnlStr.padStart(10)} ${t.reason} [${t.exitPhase ?? ""}]`);
    }
  }
  console.log("");
}
