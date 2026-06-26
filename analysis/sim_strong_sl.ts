/**
 * sim_strong_sl.ts
 * シグナル強の場合のみSL 0.8%に変更するシミュレーション
 * 
 * 現行: 全シグナル SL 0.5% / TP 1.5%
 * 提案: シグナル強 → SL 0.8% / TP 1.5%、それ以外 → SL 0.5% / TP 1.5%
 * 
 * 実行: cd /home/ubuntu/stock-alert-app && npx tsx analysis/sim_strong_sl.ts
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

// === 設定 ===
interface SimConfig {
  label: string;
  strongSL: number;   // シグナル強のSL%
  normalSL: number;   // それ以外のSL%
  fixedTP: number;    // 固定TP%
}

// === 型定義 ===
interface RtCandleRow { symbol: string; tradeDate: string; candleTime: string; open: number; high: number; low: number; close: number; volume: number; boardSnapshot: BoardSnapshot | null; }
interface OpenPosition {
  symbol: string; side: "long" | "short"; entryPrice: number; shares: number; entryTime: string; entryReason: string;
  isStrong: boolean;  // シグナル強かどうか
}
interface Trade { date: string; time: string; sym: string; action: string; price: number; pnl?: number; reason: string; shares: number; isStrong?: boolean; }

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
  return score;
}

function shouldBoardEarlyExit(pos: OpenPosition, currentPrice: number, snapshot: BoardSnapshot | null): boolean {
  if (!snapshot) return false;
  const profitPct = pos.side === "long"
    ? (currentPrice - pos.entryPrice) / pos.entryPrice * 100
    : (pos.entryPrice - currentPrice) / pos.entryPrice * 100;
  if (profitPct < BOARD_EARLY_EXIT_MIN_PROFIT_PCT) return false;
  if (pos.side === "long" && (snapshot as any).signal === "sell_pressure") return true;
  if (pos.side === "short" && (snapshot as any).signal === "buy_pressure") return true;
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
function simulateDay(dayData: RtCandleRow[], config: SimConfig): { trades: Trade[]; totalPnl: number } {
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

    // === 決済チェック ===
    const existingPos = openPositions.get(symbol);
    if (existingPos) {
      const { entryPrice, shares, side, isStrong } = existingPos;

      // 大引け強制決済
      if (candleTime >= MARKET_CLOSE_TIME) {
        const pnl = side === "long" ? (close - entryPrice) * shares : (entryPrice - close) * shares;
        totalPnl += pnl; trades.push({ date: tradeDate, time: candleTime, sym: symbol, action: "forced_close", price: close, pnl, reason: "大引け強制決済", shares, isStrong });
        openPositions.delete(symbol); continue;
      }

      // SL/TP判定（シグナル強かどうかでSL幅を変える）
      const sl = isStrong ? config.strongSL : config.normalSL;
      const tp = config.fixedTP;

      let exitPrice: number | null = null;
      let exitReason = "";

      if (side === "long") {
        const slPrice = entryPrice * (1 - sl / 100);
        const tpPrice = entryPrice * (1 + tp / 100);
        if (low <= slPrice) { exitPrice = slPrice; exitReason = `損切り(${sl}%${isStrong ? "/強" : ""})`; }
        if (high >= tpPrice && (exitPrice === null || tpPrice > (exitPrice ?? 0))) { exitPrice = tpPrice; exitReason = `利確(${tp}%)`; }
      } else {
        const slPrice = entryPrice * (1 + sl / 100);
        const tpPrice = entryPrice * (1 - tp / 100);
        if (high >= slPrice) { exitPrice = slPrice; exitReason = `損切り(${sl}%${isStrong ? "/強" : ""})`; }
        if (low <= tpPrice && (exitPrice === null || tpPrice < (exitPrice ?? Infinity))) { exitPrice = tpPrice; exitReason = `利確(${tp}%)`; }
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
      if (exitPrice === null && shouldBoardEarlyExit(existingPos, close, boardSnapshot)) {
        exitPrice = close; exitReason = "板読み早期利確";
      }

      if (exitPrice !== null) {
        const pnl = side === "long" ? (exitPrice - entryPrice) * shares : (entryPrice - exitPrice) * shares;
        totalPnl += pnl;
        trades.push({ date: tradeDate, time: candleTime, sym: symbol, action: "exit", price: exitPrice, pnl, reason: exitReason, shares, isStrong });
        openPositions.delete(symbol);
        if (exitReason.includes("損切り")) lastStopLossTime.set(symbol, candleTime);
      }
      continue;
    }

    // === エントリー ===
    if (candleTime < NO_ENTRY_BEFORE || candleTime >= NO_ENTRY_AFTER) continue;
    if ((candleTime >= "11:00" && candleTime < "11:30") || (candleTime >= "12:30" && candleTime < "13:00")) continue;
    if (buffer.length < MIN_CANDLES_FOR_SIGNAL) continue;

    const withSignals = detectSignals(buffer); const latestSignal = withSignals[withSignals.length - 1]; buffer[buffer.length - 1] = latestSignal;

    if (!latestSignal.signal) continue;
    const sig = latestSignal.signal;
    const isMedium = sig.reason?.includes("信頼度：中");
    if (isMedium) continue;

    const isStrong = sig.reason?.includes("信頼度：強") ?? false;

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
      pullbackStates.set(symbol, { side, peakPrice: close, waitCount: 0, reason: sig.reason, isStrong });
      continue;
    }

    // 大台超え/割れ: 確認バー待ち
    if (sig.reason?.startsWith("大台超え") || sig.reason?.startsWith("大台割れ")) {
      const direction = sig.type === "buy" ? "buy" : "sell";
      const m = sig.reason.match(/(\d+(?:\.\d+)?)円/); const level = m ? parseFloat(m[1]) : close;
      roundLevelPendingStates.set(symbol, { direction, level, confirmCount: 0, reason: sig.reason, isStrong });
      continue;
    }

    // 直接エントリー
    if (sig.type === "buy") {
      openPositions.set(symbol, { symbol, side: "long", entryPrice: close, shares, entryTime: candleTime, entryReason: sig.reason ?? "", isStrong });
      trades.push({ date: tradeDate, time: candleTime, sym: symbol, action: "buy", price: close, reason: sig.reason ?? "", shares, isStrong });
    } else {
      openPositions.set(symbol, { symbol, side: "short", entryPrice: close, shares, entryTime: candleTime, entryReason: sig.reason ?? "", isStrong });
      trades.push({ date: tradeDate, time: candleTime, sym: symbol, action: "short", price: close, reason: sig.reason ?? "", shares, isStrong });
    }
  }

  // === ダウ理論押し目確認（各足でチェック） ===
  // 注: メインループ内で押し目確認を処理すべきだが、簡略化のため
  // pullbackStatesに残ったものは未確認として扱う（エントリーなし）

  // === 大台超え確認バー ===
  // 同上

  return { trades, totalPnl };
}

// === 設定パターン ===
const CONFIGS: SimConfig[] = [
  { label: "現行仕様(全SL:0.5%/TP:1.5%)", strongSL: 0.5, normalSL: 0.5, fixedTP: 1.5 },
  { label: "提案: 強SL:0.8%/他SL:0.5%/TP:1.5%", strongSL: 0.8, normalSL: 0.5, fixedTP: 1.5 },
  { label: "参考A: 強SL:1.0%/他SL:0.5%/TP:1.5%", strongSL: 1.0, normalSL: 0.5, fixedTP: 1.5 },
  { label: "参考B: 強SL:0.8%/他SL:0.5%/TP:2.0%", strongSL: 0.8, normalSL: 0.5, fixedTP: 2.0 },
  { label: "参考C: 強SL:1.0%/他SL:0.5%/TP:2.0%", strongSL: 1.0, normalSL: 0.5, fixedTP: 2.0 },
];

// === メイン実行 ===
console.log("=".repeat(80));
console.log("シグナル強のみSL拡大シミュレーション");
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

const sortedResults = [...detailResults].sort((a, b) => b.totalPnl - a.totalPnl);
const basePnl = detailResults[0].totalPnl;

console.log("順位 | 設定                                     | 合計損益      | 差分       | 取引数 | 勝率  | 平均損益");
console.log("-----|------------------------------------------|-------------|-----------|--------|-------|--------");
for (let i = 0; i < sortedResults.length; i++) {
  const r = sortedResults[i];
  const closed = r.trades.filter(t => t.pnl !== undefined);
  const wins = closed.filter(t => (t.pnl ?? 0) > 0).length;
  const wr = closed.length > 0 ? Math.round(wins / closed.length * 100) : 0;
  const diff = r.totalPnl - basePnl;
  const avgPnl = closed.length > 0 ? Math.round(r.totalPnl / closed.length) : 0;
  console.log(`  ${i + 1}  | ${r.label.padEnd(40)} | ${(r.totalPnl >= 0 ? "+" : "") + Math.round(r.totalPnl).toLocaleString().padStart(9)}円 | ${(diff >= 0 ? "+" : "") + Math.round(diff).toLocaleString().padStart(7)}円 | ${String(closed.length).padStart(4)}T | ${String(wr).padStart(3)}%  | ${(avgPnl >= 0 ? "+" : "") + avgPnl.toLocaleString()}円`);
}

// === 日別比較 ===
console.log("");
console.log("=".repeat(80));
console.log("日別損益比較");
console.log("=".repeat(80));
console.log("");

const header = "日付       | " + detailResults.map(r => r.label.substring(0, 20).padEnd(20)).join(" | ");
console.log(header);
console.log("-".repeat(header.length));
for (let i = 0; i < DATES.length; i++) {
  const d = DATES[i];
  const cells = detailResults.map(r => {
    const day = r.daily[i];
    return `${(day.pnl >= 0 ? "+" : "") + Math.round(day.pnl).toLocaleString().padStart(8)}円(${day.trades}T)`.padEnd(20);
  });
  console.log(`${d} | ${cells.join(" | ")}`);
}

// === 全トレード詳細 ===
console.log("");
console.log("=".repeat(80));
console.log("全トレード詳細（現行 vs 提案）");
console.log("=".repeat(80));
console.log("");

for (let ci = 0; ci < 2; ci++) {
  const r = detailResults[ci];
  console.log(`--- ${r.label} ---`);
  console.log("日付       | 時刻  | 銘柄 | 方向  | 強? | エントリー | 決済     | 損益       | 理由");
  console.log("-----------|-------|------|-------|-----|-----------|---------|-----------|----");
  for (const t of r.trades.filter(t => t.pnl !== undefined)) {
    const entry = r.trades.find(e => e.sym === t.sym && e.date === t.date && (e.action === "buy" || e.action === "short") && e.time <= t.time);
    const strongMark = t.isStrong ? "★" : " ";
    console.log(`${t.date} | ${t.time} | ${t.sym} | ${(entry?.action ?? "?").padEnd(5)} | ${strongMark}   | ${(entry?.price?.toFixed(0) ?? "?").padStart(9)} | ${t.price.toFixed(0).padStart(7)} | ${((t.pnl ?? 0) >= 0 ? "+" : "") + Math.round(t.pnl ?? 0).toLocaleString().padStart(8)}円 | ${t.reason}`);
  }
  console.log("");
}

// === 強シグナルのみ抽出 ===
console.log("=".repeat(80));
console.log("シグナル強のトレードのみ抽出（現行 vs 提案）");
console.log("=".repeat(80));
console.log("");

for (let ci = 0; ci < 2; ci++) {
  const r = detailResults[ci];
  const strongTrades = r.trades.filter(t => t.pnl !== undefined && t.isStrong);
  const strongPnl = strongTrades.reduce((s, t) => s + (t.pnl ?? 0), 0);
  console.log(`--- ${r.label} ---`);
  console.log(`  強シグナル取引数: ${strongTrades.length}件  合計損益: ${(strongPnl >= 0 ? "+" : "")}${Math.round(strongPnl).toLocaleString()}円`);
  for (const t of strongTrades) {
    const entry = r.trades.find(e => e.sym === t.sym && e.date === t.date && (e.action === "buy" || e.action === "short") && e.time <= t.time);
    console.log(`    ${t.date} ${t.time} ${t.sym} ${(entry?.action ?? "?").padEnd(5)} @${(entry?.price?.toFixed(0) ?? "?").padStart(7)} → ${t.price.toFixed(0).padStart(7)} ${((t.pnl ?? 0) >= 0 ? "+" : "") + Math.round(t.pnl ?? 0).toLocaleString().padStart(8)}円 ${t.reason}`);
  }
  console.log("");
}

// === 損切りで終わったトレードの「もしSLが広ければ」分析 ===
console.log("=".repeat(80));
console.log("損切りトレードの詳細分析（SL拡大で救えたか？）");
console.log("=".repeat(80));
console.log("");

const baseResult = detailResults[0]; // 現行
const proposalResult = detailResults[1]; // 提案

const baseSLTrades = baseResult.trades.filter(t => t.reason?.includes("損切り"));
for (const slTrade of baseSLTrades) {
  const entry = baseResult.trades.find(e => e.sym === slTrade.sym && e.date === slTrade.date && (e.action === "buy" || e.action === "short") && e.time <= slTrade.time);
  if (!entry) continue;
  
  // 提案での同じトレードを探す
  const proposalTrade = proposalResult.trades.find(t => t.sym === slTrade.sym && t.date === slTrade.date && t.pnl !== undefined);
  const proposalEntry = proposalResult.trades.find(e => e.sym === slTrade.sym && e.date === slTrade.date && (e.action === "buy" || e.action === "short"));
  
  console.log(`  ${slTrade.date} ${slTrade.sym} ${entry.action} @${entry.price.toFixed(0)}`);
  console.log(`    現行: ${slTrade.time} 決済@${slTrade.price.toFixed(0)} ${((slTrade.pnl ?? 0) >= 0 ? "+" : "")}${Math.round(slTrade.pnl ?? 0).toLocaleString()}円 [${slTrade.reason}] 強=${slTrade.isStrong ? "YES" : "NO"}`);
  if (proposalTrade) {
    console.log(`    提案: ${proposalTrade.time} 決済@${proposalTrade.price.toFixed(0)} ${((proposalTrade.pnl ?? 0) >= 0 ? "+" : "")}${Math.round(proposalTrade.pnl ?? 0).toLocaleString()}円 [${proposalTrade.reason}] 強=${proposalTrade.isStrong ? "YES" : "NO"}`);
  } else {
    console.log(`    提案: エントリーなし`);
  }
  console.log("");
}
