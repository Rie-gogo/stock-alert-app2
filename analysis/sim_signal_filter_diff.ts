/**
 * sim_signal_filter_diff.ts
 * シグナル別フィルター強度差別化シミュレーション
 * 
 * 設計思想:
 * - ダウ理論/大台超え: 信頼度高 → フィルター緩め（medium許可、押し目深さ緩和）
 * - ダブルボトム/逆三尊: 中間 → 出来高フィルター追加
 * - MAクロス: ダマシ多い → 現行維持（厳しいまま）
 * - RSI+BB: 逆張り → 板読み+出来高追加
 * - VWAP反発: 中間 → 現行維持
 * 
 * 実行: cd /home/ubuntu/stock-alert-app && npx tsx analysis/sim_signal_filter_diff.ts
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

// === シグナル分類 ===
type SignalFamily = "dow" | "roundLevel" | "maCross" | "rsiBB" | "vwap" | "doubleBottom" | "other";

function classifySignal(reason: string): SignalFamily {
  if (reason.startsWith("ダウ理論")) return "dow";
  if (reason.startsWith("大台超え") || reason.startsWith("大台割れ")) return "roundLevel";
  if (reason.includes("ゴールデンクロス") || reason.includes("デッドクロス") || reason.includes("戻り売り")) return "maCross";
  if (reason.includes("RSI") || reason.includes("BB")) return "rsiBB";
  if (reason.includes("VWAP")) return "vwap";
  if (reason.includes("ダブルボトム") || reason.includes("逆三尊") || reason.includes("ダブルトップ") || reason.includes("三尊")) return "doubleBottom";
  return "other";
}

// === シグナル別フィルター設定 ===
interface SignalFilterPolicy {
  // mediumシグナルを許可するか
  allowMedium: boolean;
  // medium条件付き許可: 板読みスコアがこの値以上ならmediumでもエントリー許可（0=無効）
  mediumMinBoardScore: number;
  // 板読みスコア最低閾値
  minBoardScore: number;
  // 出来高増加フィルター（直近平均の何倍以上か、0=無効）
  volumeSurgeMultiplier: number;
  // 押し目深さフィルター適用するか（ダウ理論用）
  usePullbackDepth: boolean;
  // 押し目深さ範囲（緩和用）
  pullbackMin: number;
  pullbackMax: number;
}

interface SimConfig {
  label: string;
  // シグナル別フィルターポリシー
  policies: Record<SignalFamily, SignalFilterPolicy>;
  // 共通設定
  timeFilter: boolean;
  highVolSL: number;
  highVolTP: number;
  defaultSL: number;
  defaultTP: number;
}

// === 型定義 ===
interface RtCandleRow { symbol: string; tradeDate: string; candleTime: string; open: number; high: number; low: number; close: number; volume: number; boardSnapshot: BoardSnapshot | null; }
interface OpenPosition { symbol: string; side: "long" | "short"; entryPrice: number; shares: number; entryTime: string; entryReason: string; }
interface Trade { date: string; time: string; sym: string; action: string; price: number; pnl?: number; reason: string; shares: number; confidence?: string; signalFamily?: string; }

// === ヘルパー ===
function calcShares(price: number): number { return Math.max(100, Math.floor(Math.floor(INITIAL_CAPITAL_PER_STOCK * LOT_RATIO / price) / 100) * 100); }
function timeToMinutes(t: string): number { const [h, m] = t.split(":").map(Number); return h * 60 + m; }
function checkVolumeUnavailable(buffer: CandleWithSignal[]): boolean { if (buffer.length < 10) return false; const lb = Math.min(buffer.length, 20); const rc = buffer.slice(-lb); return (rc.filter(c => c.volume === 0).length / lb) >= VOLUME_UNAVAILABLE_RATIO; }
function calcCurrentExposure(op: Map<string, OpenPosition>): number { let t = 0; for (const p of op.values()) t += p.entryPrice * p.shares; return t; }

// 出来高急増チェック
function isVolumeSurge(buffer: CandleWithSignal[], multiplier: number): boolean {
  if (multiplier <= 0) return true; // 無効=常に通過
  if (buffer.length < 11) return true; // データ不足=通過
  const recent = buffer.slice(-11, -1); // 直近10本（現在足除く）
  const avgVol = recent.reduce((s, c) => s + c.volume, 0) / recent.length;
  if (avgVol <= 0) return true;
  const currentVol = buffer[buffer.length - 1].volume;
  return currentVol >= avgVol * multiplier;
}

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

// === シミュレーション本体 ===
function simulateDay(dayData: RtCandleRow[], config: SimConfig): { trades: Trade[]; totalPnl: number; blockedCount: number; blockedReasons: string[] } {
  const trades: Trade[] = [];
  let totalPnl = 0;
  let blockedCount = 0;
  const blockedReasons: string[] = [];
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

    const isHighVol = HIGH_VOL_SYMBOLS.has(symbol);
    const slPct = isHighVol ? config.highVolSL : config.defaultSL;
    const tpPct = isHighVol ? config.highVolTP : config.defaultTP;

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

    // 決済チェック
    const existingPos = openPositions.get(symbol);
    if (existingPos) {
      const { entryPrice, shares, side } = existingPos;
      if (candleTime >= MARKET_CLOSE_TIME) {
        const pnl = side === "long" ? (close - entryPrice) * shares : (entryPrice - close) * shares;
        totalPnl += pnl; trades.push({ date: tradeDate, time: candleTime, sym: symbol, action: "forced_close", price: close, pnl, reason: "大引け強制決済", shares });
        openPositions.delete(symbol); continue;
      }
      let exitPrice: number | null = null, exitReason = "";
      if (side === "long") {
        const sl = entryPrice * (1 - slPct / 100); const tp = entryPrice * (1 + tpPct / 100);
        if (low <= sl) { exitPrice = sl; exitReason = "損切り"; } else if (high >= tp) { exitPrice = tp; exitReason = "利確"; }
      } else {
        const sl = entryPrice * (1 + slPct / 100); const tp = entryPrice * (1 - tpPct / 100);
        if (high >= sl) { exitPrice = sl; exitReason = "損切り"; } else if (low <= tp) { exitPrice = tp; exitReason = "利確"; }
      }
      if (exitPrice === null && buffer.length >= MIN_CANDLES_FOR_SIGNAL) {
        const ws = detectSignals(buffer); const latest = ws[ws.length - 1]; buffer[buffer.length - 1] = latest;
        if (latest.signal) {
          if (side === "long" && latest.signal.type === "sell") { exitPrice = close; exitReason = "シグナル反転"; }
          else if (side === "short" && latest.signal.type === "buy") { exitPrice = close; exitReason = "シグナル反転"; }
        }
      }
      if (exitPrice === null && shouldBoardEarlyExit(existingPos, close, boardSnapshot)) { exitPrice = close; exitReason = "板読み早期利確"; }
      if (exitPrice !== null) {
        const pnl = side === "long" ? (exitPrice - entryPrice) * shares : (entryPrice - exitPrice) * shares;
        totalPnl += pnl; trades.push({ date: tradeDate, time: candleTime, sym: symbol, action: "exit", price: exitPrice, pnl, reason: exitReason, shares });
        openPositions.delete(symbol); if (exitReason === "損切り") lastStopLossTime.set(symbol, candleTime);
      }
      continue;
    }

    // エントリー禁止
    if (candleTime < NO_ENTRY_BEFORE || candleTime >= NO_ENTRY_AFTER) continue;
    if (config.timeFilter && ((candleTime >= "11:00" && candleTime < "11:30") || (candleTime >= "12:30" && candleTime < "13:00"))) continue;
    if (buffer.length < MIN_CANDLES_FOR_SIGNAL) continue;

    // シグナル検出
    const withSignals = detectSignals(buffer); const latestSignal = withSignals[withSignals.length - 1]; buffer[buffer.length - 1] = latestSignal;
    const firstCandle = buffer[0]; const priceChangeRatio = (close - firstCandle.open) / firstCandle.open * 100; const isBullish = priceChangeRatio >= 0.2;

    const sig = latestSignal.signal;
    if (!sig) continue;

    const getBoardScore = (side: "long" | "short") => boardReadingScoreBC(bprHistories.get(symbol) ?? [], side, boardSnapshot);
    const family = classifySignal(sig.reason);
    const policy = config.policies[family];

    // 押し目確認ステートマシン
    const ps = pullbackStates.get(symbol);
    if (ps) {
      ps.waitCount++;
      if (low < ps.recentSwingLow || ps.waitCount > PULLBACK_MAX_WAIT) { pullbackStates.delete(symbol); }
      else {
        if (!ps.pulledBack && close < ps.signalPrice) ps.pulledBack = true;
        if (ps.pulledBack && close > ps.signalPrice) {
          pullbackStates.delete(symbol);
          if (boardSnapshot?.signal === "sell_pressure") continue;
          const brScore = getBoardScore("long");
          if (brScore < 1) continue;
          const shares = calcShares(close); const amount = close * shares;
          if (buffer.length >= ATR_FILTER_PERIOD + 1) { const h = buffer.map(c => c.high); const l = buffer.map(c => c.low); const cl = buffer.map(c => c.close); const atr = calcATR(h, l, cl, ATR_FILTER_PERIOD); if (atr[atr.length-1] !== null && close > 0 && (atr[atr.length-1]! / close) < ATR_FILTER_THRESHOLD) continue; }
          if (calcCurrentExposure(openPositions) + amount > MAX_TOTAL_EXPOSURE) continue;
          if (checkVolumeUnavailable(buffer)) continue;
          const lastSL = lastStopLossTime.get(symbol); if (lastSL && timeToMinutes(candleTime) - timeToMinutes(lastSL) < NO_REENTRY_AFTER_STOPLOSS_MIN) continue;
          openPositions.set(symbol, { symbol, side: "long", entryPrice: close, shares, entryTime: candleTime, entryReason: ps.reason });
          trades.push({ date: tradeDate, time: candleTime, sym: symbol, action: "buy", price: close, reason: `押し目確認: ${ps.reason}`, shares, signalFamily: "dow" });
        }
      }
      continue;
    }

    // 大台確認バーステートマシン
    const rp = roundLevelPendingStates.get(symbol);
    if (rp) {
      if (openPositions.has(symbol)) { roundLevelPendingStates.delete(symbol); }
      else {
        const valid = rp.direction === "buy" ? close >= rp.level : close <= rp.level;
        if (valid) { rp.confirmCount++; if (rp.confirmCount >= ROUND_LEVEL_CONFIRM_BARS) { roundLevelPendingStates.delete(symbol); roundPullbackStates.set(symbol, { ...rp, signalPrice: close, waitCount: 0, pulledBack: false }); } }
        else { roundLevelPendingStates.delete(symbol); }
        continue;
      }
    }

    // 大台確認後の押し目待ち
    const rpb = roundPullbackStates.get(symbol);
    if (rpb) {
      rpb.waitCount++;
      const side: "long" | "short" = rpb.direction === "buy" ? "long" : "short";
      if ((rpb.direction === "buy" && close < rpb.level) || (rpb.direction === "sell" && close > rpb.level)) { roundPullbackStates.delete(symbol); continue; }
      if (rpb.waitCount > ROUND_PULLBACK_MAX_WAIT) {
        roundPullbackStates.delete(symbol);
        if (boardSnapshot && side === "long" && boardSnapshot.signal === "sell_pressure") continue;
        if (boardSnapshot && side === "short" && boardSnapshot.signal === "buy_pressure") continue;
        const brScore = getBoardScore(side);
        if (brScore < 1) continue;
        const shares = calcShares(close); const amount = close * shares;
        if (buffer.length >= ATR_FILTER_PERIOD + 1) { const h = buffer.map(c => c.high); const l = buffer.map(c => c.low); const cl = buffer.map(c => c.close); const atr = calcATR(h, l, cl, ATR_FILTER_PERIOD); if (atr[atr.length-1] !== null && close > 0 && (atr[atr.length-1]! / close) < ATR_FILTER_THRESHOLD) continue; }
        if (calcCurrentExposure(openPositions) + amount > MAX_TOTAL_EXPOSURE) continue;
        if (checkVolumeUnavailable(buffer)) continue;
        openPositions.set(symbol, { symbol, side, entryPrice: close, shares, entryTime: candleTime, entryReason: `${rpb.reason} (押し目なし)` });
        trades.push({ date: tradeDate, time: candleTime, sym: symbol, action: side === "long" ? "buy" : "short", price: close, reason: `${rpb.reason} (押し目なし)`, shares, signalFamily: "roundLevel" });
        continue;
      }
      if (rpb.direction === "buy") {
        if (!rpb.pulledBack && close < rpb.signalPrice) rpb.pulledBack = true;
        if (rpb.pulledBack && close > rpb.signalPrice) {
          roundPullbackStates.delete(symbol);
          if (boardSnapshot?.signal === "sell_pressure") continue;
          const brScore = getBoardScore("long");
          if (brScore < 1) continue;
          const shares = calcShares(close); const amount = close * shares;
          if (buffer.length >= ATR_FILTER_PERIOD + 1) { const h = buffer.map(c => c.high); const l = buffer.map(c => c.low); const cl = buffer.map(c => c.close); const atr = calcATR(h, l, cl, ATR_FILTER_PERIOD); if (atr[atr.length-1] !== null && close > 0 && (atr[atr.length-1]! / close) < ATR_FILTER_THRESHOLD) continue; }
          if (calcCurrentExposure(openPositions) + amount > MAX_TOTAL_EXPOSURE) continue;
          openPositions.set(symbol, { symbol, side: "long", entryPrice: close, shares, entryTime: candleTime, entryReason: `${rpb.reason} (押し目確認後)` });
          trades.push({ date: tradeDate, time: candleTime, sym: symbol, action: "buy", price: close, reason: `${rpb.reason} (押し目確認後)`, shares, signalFamily: "roundLevel" });
          continue;
        }
      } else {
        if (!rpb.pulledBack && close > rpb.signalPrice) rpb.pulledBack = true;
        if (rpb.pulledBack && close < rpb.signalPrice) {
          roundPullbackStates.delete(symbol);
          if (boardSnapshot?.signal === "buy_pressure") continue;
          const brScore = getBoardScore("short");
          if (brScore < 1) continue;
          const shares = calcShares(close); const amount = close * shares;
          if (buffer.length >= ATR_FILTER_PERIOD + 1) { const h = buffer.map(c => c.high); const l = buffer.map(c => c.low); const cl = buffer.map(c => c.close); const atr = calcATR(h, l, cl, ATR_FILTER_PERIOD); if (atr[atr.length-1] !== null && close > 0 && (atr[atr.length-1]! / close) < ATR_FILTER_THRESHOLD) continue; }
          if (calcCurrentExposure(openPositions) + amount > MAX_TOTAL_EXPOSURE) continue;
          openPositions.set(symbol, { symbol, side: "short", entryPrice: close, shares, entryTime: candleTime, entryReason: `${rpb.reason} (押し目確認後)` });
          trades.push({ date: tradeDate, time: candleTime, sym: symbol, action: "short", price: close, reason: `${rpb.reason} (押し目確認後)`, shares, signalFamily: "roundLevel" });
          continue;
        }
      }
      continue;
    }

    // === ここからが直接エントリー判定 ===
    const isMedium = sig.confidence === "medium";

    // 買いエントリー
    if (sig.type === "buy" && !openPositions.has(symbol)) {
      if (sig.reason?.includes("VWAPクロス上抜け")) continue;
      if (boardSnapshot?.signal === "sell_pressure") continue;
      const brScore = getBoardScore("long");
      if (brScore < policy.minBoardScore) {
        blockedCount++;
        blockedReasons.push(`${tradeDate} ${candleTime} ${symbol} BUY blocked: 板スコア不足(${brScore}<${policy.minBoardScore}) ${sig.reason}`);
        continue;
      }

      if (sig.reason?.startsWith("ダウ理論: 直近高値更新") && sig.recentSwingLow != null) {
        const dowPolicy = config.policies.dow;
        // ダウ理論: 5分足フィルター
        const htf = getHigherTfTrend(buffer, buffer.length - 1, 5);
        if (htf !== "up") continue;
        // 押し目深さフィルター（ポリシーで制御）
        if (dowPolicy.usePullbackDepth && buffer.length >= PULLBACK_DEPTH_LOOKBACK) {
          const lw = buffer.slice(-PULLBACK_DEPTH_LOOKBACK); const sh = Math.max(...lw.map(c => c.high)); const sl2 = Math.min(...lw.map(c => c.low));
          if (sh > sl2) { const pd = (sh - close) / (sh - sl2); if (pd < dowPolicy.pullbackMin || pd > dowPolicy.pullbackMax) { blockedCount++; blockedReasons.push(`${tradeDate} ${candleTime} ${symbol} BUY blocked: 押し目深さ(${(pd*100).toFixed(1)}%) ${sig.reason}`); continue; } }
        }
        pullbackStates.set(symbol, { recentSwingLow: sig.recentSwingLow, signalPrice: close, waitCount: 0, pulledBack: false, reason: sig.reason });
      } else if (sig.reason?.startsWith("大台超え")) {
        const m = sig.reason.match(/(\d+(?:\.\d+)?)円/); const level = m ? parseFloat(m[1]) : close;
        roundLevelPendingStates.set(symbol, { direction: "buy", level, confirmCount: 0, reason: sig.reason });
      } else {
        // === 直接エントリー ===
        // medium判定: ポリシーに基づく
        if (isMedium && !policy.allowMedium) {
          // 条件付き許可: 板読みスコアが閾値以上ならmediumでも通過
          if (policy.mediumMinBoardScore > 0 && brScore >= policy.mediumMinBoardScore) {
            // 条件付き許可 → 通過
          } else {
            blockedCount++;
            blockedReasons.push(`${tradeDate} ${candleTime} ${symbol} BUY blocked: medium禁止(${family}, 板${brScore}<${policy.mediumMinBoardScore}) ${sig.reason}`);
            continue;
          }
        }
        // 出来高フィルター（ポリシーに基づく）
        if (!isVolumeSurge(buffer, policy.volumeSurgeMultiplier)) {
          blockedCount++;
          blockedReasons.push(`${tradeDate} ${candleTime} ${symbol} BUY blocked: 出来高不足(${family}) ${sig.reason}`);
          continue;
        }
        const shares = calcShares(close); const amount = close * shares;
        if (buffer.length >= ATR_FILTER_PERIOD + 1) { const h = buffer.map(c => c.high); const l = buffer.map(c => c.low); const cl = buffer.map(c => c.close); const atr = calcATR(h, l, cl, ATR_FILTER_PERIOD); if (atr[atr.length-1] !== null && close > 0 && (atr[atr.length-1]! / close) < ATR_FILTER_THRESHOLD) continue; }
        if (calcCurrentExposure(openPositions) + amount > MAX_TOTAL_EXPOSURE) continue;
        if (checkVolumeUnavailable(buffer)) continue;
        const lastSL = lastStopLossTime.get(symbol); if (lastSL && timeToMinutes(candleTime) - timeToMinutes(lastSL) < NO_REENTRY_AFTER_STOPLOSS_MIN) continue;
        openPositions.set(symbol, { symbol, side: "long", entryPrice: close, shares, entryTime: candleTime, entryReason: sig.reason });
        trades.push({ date: tradeDate, time: candleTime, sym: symbol, action: "buy", price: close, reason: sig.reason, shares, confidence: sig.confidence, signalFamily: family });
      }
    }

    // 売りエントリー
    if (sig.type === "sell" && !openPositions.has(symbol)) {
      if (isBullish) continue;
      if (boardSnapshot?.signal === "buy_pressure") continue;
      const brScore = getBoardScore("short");
      if (brScore < policy.minBoardScore) {
        blockedCount++;
        blockedReasons.push(`${tradeDate} ${candleTime} ${symbol} SELL blocked: 板スコア不足(${brScore}<${policy.minBoardScore}) ${sig.reason}`);
        continue;
      }

      if (sig.reason?.startsWith("ダウ理論: 直近安値更新")) {
        const dowPolicy = config.policies.dow;
        const htf = getHigherTfTrend(buffer, buffer.length - 1, 5);
        if (htf !== "down") continue;
        if (dowPolicy.usePullbackDepth && buffer.length >= PULLBACK_DEPTH_LOOKBACK) {
          const lw = buffer.slice(-PULLBACK_DEPTH_LOOKBACK); const sh = Math.max(...lw.map(c => c.high)); const sl2 = Math.min(...lw.map(c => c.low));
          if (sh > sl2) { const pd = (close - sl2) / (sh - sl2); if (pd < dowPolicy.pullbackMin || pd > dowPolicy.pullbackMax) continue; }
        }
      } else if (sig.reason?.startsWith("大台割れ")) {
        const m = sig.reason.match(/(\d+(?:\.\d+)?)円/); const level = m ? parseFloat(m[1]) : close;
        roundLevelPendingStates.set(symbol, { direction: "sell", level, confirmCount: 0, reason: sig.reason });
      } else {
        // === 直接エントリー ===
        if (isMedium && !policy.allowMedium) {
          // 条件付き許可: 板読みスコアが閾値以上ならmediumでも通過
          if (policy.mediumMinBoardScore > 0 && brScore >= policy.mediumMinBoardScore) {
            // 条件付き許可 → 通過
          } else {
            blockedCount++;
            blockedReasons.push(`${tradeDate} ${candleTime} ${symbol} SELL blocked: medium禁止(${family}, 板${brScore}<${policy.mediumMinBoardScore}) ${sig.reason}`);
            continue;
          }
        }
        if (!isVolumeSurge(buffer, policy.volumeSurgeMultiplier)) {
          blockedCount++;
          blockedReasons.push(`${tradeDate} ${candleTime} ${symbol} SELL blocked: 出来高不足(${family}) ${sig.reason}`);
          continue;
        }
        const shares = calcShares(close); const amount = close * shares;
        if (buffer.length >= ATR_FILTER_PERIOD + 1) { const h = buffer.map(c => c.high); const l = buffer.map(c => c.low); const cl = buffer.map(c => c.close); const atr = calcATR(h, l, cl, ATR_FILTER_PERIOD); if (atr[atr.length-1] !== null && close > 0 && (atr[atr.length-1]! / close) < ATR_FILTER_THRESHOLD) continue; }
        if (calcCurrentExposure(openPositions) + amount > MAX_TOTAL_EXPOSURE) continue;
        if (checkVolumeUnavailable(buffer)) continue;
        const lastSL = lastStopLossTime.get(symbol); if (lastSL && timeToMinutes(candleTime) - timeToMinutes(lastSL) < NO_REENTRY_AFTER_STOPLOSS_MIN) continue;
        openPositions.set(symbol, { symbol, side: "short", entryPrice: close, shares, entryTime: candleTime, entryReason: sig.reason });
        trades.push({ date: tradeDate, time: candleTime, sym: symbol, action: "short", price: close, reason: sig.reason, shares, confidence: sig.confidence, signalFamily: family });
      }
    }
  }

  // 残ポジション強制決済
  for (const [symbol, pos] of openPositions.entries()) {
    const symCandles = sorted.filter(c => c.symbol === symbol);
    const last = symCandles[symCandles.length - 1];
    if (!last) continue;
    const pnl = pos.side === "long" ? (last.close - pos.entryPrice) * pos.shares : (pos.entryPrice - last.close) * pos.shares;
    totalPnl += pnl;
    trades.push({ date: last.tradeDate, time: last.candleTime, sym: symbol, action: "forced_close", price: last.close, pnl, reason: "データ終了時決済", shares: pos.shares });
  }

  return { trades, totalPnl, blockedCount, blockedReasons };
}

// === データローダー ===
const DATES = ["2026-06-17", "2026-06-18", "2026-06-19", "2026-06-22", "2026-06-23", "2026-06-24", "2026-06-25"];

function loadDayData(date: string): RtCandleRow[] {
  const file = `/tmp/rt_candles_${date.replace(/-/g, "")}.json`;
  if (!fs.existsSync(file)) return [];
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const c of raw) {
    c.open = Number(c.open); c.high = Number(c.high); c.low = Number(c.low); c.close = Number(c.close); c.volume = Number(c.volume);
    if (typeof c.boardSnapshot === "string") c.boardSnapshot = JSON.parse(c.boardSnapshot);
  }
  return raw;
}

// === 設定定義 ===
// 現行仕様: 全シグナルmedium禁止、板読み≥1、出来高フィルターなし
const CURRENT_POLICY: SignalFilterPolicy = {
  allowMedium: false,
  mediumMinBoardScore: 0, // 無効
  minBoardScore: 1,
  volumeSurgeMultiplier: 0, // 無効
  usePullbackDepth: true,
  pullbackMin: 0.30,
  pullbackMax: 0.70,
};

const CONFIGS: SimConfig[] = [
  // ベースライン: 現行仕様（medium全面禁止）
  {
    label: "現行仕様（medium全面禁止）",
    policies: {
      dow: { ...CURRENT_POLICY },
      roundLevel: { ...CURRENT_POLICY },
      maCross: { ...CURRENT_POLICY },
      rsiBB: { ...CURRENT_POLICY },
      vwap: { ...CURRENT_POLICY },
      doubleBottom: { ...CURRENT_POLICY },
      other: { ...CURRENT_POLICY },
    },
    timeFilter: true, highVolSL: 0.5, highVolTP: 1.5, defaultSL: 0.5, defaultTP: 1.5,
  },
  // 提案E: medium + 板読みスコア≥3 → 全シグナル許可
  {
    label: "提案E: medium+板≥3なら全シグナル許可",
    policies: {
      dow: { allowMedium: false, mediumMinBoardScore: 3, minBoardScore: 1, volumeSurgeMultiplier: 0, usePullbackDepth: true, pullbackMin: 0.30, pullbackMax: 0.70 },
      roundLevel: { allowMedium: false, mediumMinBoardScore: 3, minBoardScore: 1, volumeSurgeMultiplier: 0, usePullbackDepth: false, pullbackMin: 0.30, pullbackMax: 0.70 },
      maCross: { allowMedium: false, mediumMinBoardScore: 3, minBoardScore: 1, volumeSurgeMultiplier: 0, usePullbackDepth: true, pullbackMin: 0.30, pullbackMax: 0.70 },
      rsiBB: { allowMedium: false, mediumMinBoardScore: 3, minBoardScore: 1, volumeSurgeMultiplier: 0, usePullbackDepth: false, pullbackMin: 0.30, pullbackMax: 0.70 },
      vwap: { allowMedium: false, mediumMinBoardScore: 3, minBoardScore: 1, volumeSurgeMultiplier: 0, usePullbackDepth: false, pullbackMin: 0.30, pullbackMax: 0.70 },
      doubleBottom: { allowMedium: false, mediumMinBoardScore: 3, minBoardScore: 1, volumeSurgeMultiplier: 0, usePullbackDepth: false, pullbackMin: 0.30, pullbackMax: 0.70 },
      other: { allowMedium: false, mediumMinBoardScore: 3, minBoardScore: 1, volumeSurgeMultiplier: 0, usePullbackDepth: true, pullbackMin: 0.30, pullbackMax: 0.70 },
    },
    timeFilter: true, highVolSL: 0.5, highVolTP: 1.5, defaultSL: 0.5, defaultTP: 1.5,
  },
  // 提案F: medium+板≥2なら全シグナル許可（より緩い）
  {
    label: "提案F: medium+板≥2なら全シグナル許可",
    policies: {
      dow: { allowMedium: false, mediumMinBoardScore: 2, minBoardScore: 1, volumeSurgeMultiplier: 0, usePullbackDepth: true, pullbackMin: 0.30, pullbackMax: 0.70 },
      roundLevel: { allowMedium: false, mediumMinBoardScore: 2, minBoardScore: 1, volumeSurgeMultiplier: 0, usePullbackDepth: false, pullbackMin: 0.30, pullbackMax: 0.70 },
      maCross: { allowMedium: false, mediumMinBoardScore: 2, minBoardScore: 1, volumeSurgeMultiplier: 0, usePullbackDepth: true, pullbackMin: 0.30, pullbackMax: 0.70 },
      rsiBB: { allowMedium: false, mediumMinBoardScore: 2, minBoardScore: 1, volumeSurgeMultiplier: 0, usePullbackDepth: false, pullbackMin: 0.30, pullbackMax: 0.70 },
      vwap: { allowMedium: false, mediumMinBoardScore: 2, minBoardScore: 1, volumeSurgeMultiplier: 0, usePullbackDepth: false, pullbackMin: 0.30, pullbackMax: 0.70 },
      doubleBottom: { allowMedium: false, mediumMinBoardScore: 2, minBoardScore: 1, volumeSurgeMultiplier: 0, usePullbackDepth: false, pullbackMin: 0.30, pullbackMax: 0.70 },
      other: { allowMedium: false, mediumMinBoardScore: 2, minBoardScore: 1, volumeSurgeMultiplier: 0, usePullbackDepth: true, pullbackMin: 0.30, pullbackMax: 0.70 },
    },
    timeFilter: true, highVolSL: 0.5, highVolTP: 1.5, defaultSL: 0.5, defaultTP: 1.5,
  },
  // 提案G: medium+板≥4なら全シグナル許可（より厳しい）
  {
    label: "提案G: medium+板≥4なら全シグナル許可",
    policies: {
      dow: { allowMedium: false, mediumMinBoardScore: 4, minBoardScore: 1, volumeSurgeMultiplier: 0, usePullbackDepth: true, pullbackMin: 0.30, pullbackMax: 0.70 },
      roundLevel: { allowMedium: false, mediumMinBoardScore: 4, minBoardScore: 1, volumeSurgeMultiplier: 0, usePullbackDepth: false, pullbackMin: 0.30, pullbackMax: 0.70 },
      maCross: { allowMedium: false, mediumMinBoardScore: 4, minBoardScore: 1, volumeSurgeMultiplier: 0, usePullbackDepth: true, pullbackMin: 0.30, pullbackMax: 0.70 },
      rsiBB: { allowMedium: false, mediumMinBoardScore: 4, minBoardScore: 1, volumeSurgeMultiplier: 0, usePullbackDepth: false, pullbackMin: 0.30, pullbackMax: 0.70 },
      vwap: { allowMedium: false, mediumMinBoardScore: 4, minBoardScore: 1, volumeSurgeMultiplier: 0, usePullbackDepth: false, pullbackMin: 0.30, pullbackMax: 0.70 },
      doubleBottom: { allowMedium: false, mediumMinBoardScore: 4, minBoardScore: 1, volumeSurgeMultiplier: 0, usePullbackDepth: false, pullbackMin: 0.30, pullbackMax: 0.70 },
      other: { allowMedium: false, mediumMinBoardScore: 4, minBoardScore: 1, volumeSurgeMultiplier: 0, usePullbackDepth: true, pullbackMin: 0.30, pullbackMax: 0.70 },
    },
    timeFilter: true, highVolSL: 0.5, highVolTP: 1.5, defaultSL: 0.5, defaultTP: 1.5,
  },
  // 提案H: シグナル別差別化（ダウ理論/大台は板≥2、MAクロス/RSIは板≥4）
  {
    label: "提案H: シグナル別差別化(ダウ板≥2,MA板≥4)",
    policies: {
      dow: { allowMedium: false, mediumMinBoardScore: 2, minBoardScore: 1, volumeSurgeMultiplier: 0, usePullbackDepth: true, pullbackMin: 0.30, pullbackMax: 0.70 },
      roundLevel: { allowMedium: false, mediumMinBoardScore: 2, minBoardScore: 1, volumeSurgeMultiplier: 0, usePullbackDepth: false, pullbackMin: 0.30, pullbackMax: 0.70 },
      maCross: { allowMedium: false, mediumMinBoardScore: 4, minBoardScore: 1, volumeSurgeMultiplier: 0, usePullbackDepth: true, pullbackMin: 0.30, pullbackMax: 0.70 },
      rsiBB: { allowMedium: false, mediumMinBoardScore: 4, minBoardScore: 1, volumeSurgeMultiplier: 0, usePullbackDepth: false, pullbackMin: 0.30, pullbackMax: 0.70 },
      vwap: { allowMedium: false, mediumMinBoardScore: 3, minBoardScore: 1, volumeSurgeMultiplier: 0, usePullbackDepth: false, pullbackMin: 0.30, pullbackMax: 0.70 },
      doubleBottom: { allowMedium: false, mediumMinBoardScore: 3, minBoardScore: 1, volumeSurgeMultiplier: 0, usePullbackDepth: false, pullbackMin: 0.30, pullbackMax: 0.70 },
      other: { allowMedium: false, mediumMinBoardScore: 3, minBoardScore: 1, volumeSurgeMultiplier: 0, usePullbackDepth: true, pullbackMin: 0.30, pullbackMax: 0.70 },
    },
    timeFilter: true, highVolSL: 0.5, highVolTP: 1.5, defaultSL: 0.5, defaultTP: 1.5,
  },
];

// === メイン実行 ===
console.log("=".repeat(80));
console.log("シグナル別フィルター強度差別化 シミュレーション");
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
  blockedCount: number;
  blockedReasons: string[];
}
const detailResults: DetailResult[] = [];

for (const config of CONFIGS) {
  let totalPnl = 0;
  const allTrades: Trade[] = [];
  const daily: { date: string; pnl: number; trades: number }[] = [];
  let totalBlocked = 0;
  const allBlockedReasons: string[] = [];

  for (const date of DATES) {
    const dayData = allDayData.get(date)!;
    if (dayData.length === 0) { daily.push({ date, pnl: 0, trades: 0 }); continue; }
    const result = simulateDay(dayData, config);
    const closed = result.trades.filter(t => t.pnl !== undefined);
    totalPnl += result.totalPnl;
    allTrades.push(...result.trades);
    daily.push({ date, pnl: result.totalPnl, trades: closed.length });
    totalBlocked += result.blockedCount;
    allBlockedReasons.push(...result.blockedReasons);
  }

  detailResults.push({ label: config.label, totalPnl, trades: allTrades, daily, blockedCount: totalBlocked, blockedReasons: allBlockedReasons });
}

// === サマリー ===
console.log("=".repeat(80));
console.log("サマリー（合計損益順）");
console.log("=".repeat(80));
console.log("");

const sorted = [...detailResults].sort((a, b) => b.totalPnl - a.totalPnl);
const basePnl = detailResults[0].totalPnl;

console.log("順位 | 設定                                          | 合計損益      | 差分       | 取引数 | 勝率  | ブロック");
console.log("-----|-----------------------------------------------|-------------|-----------|--------|-------|--------");
for (let i = 0; i < sorted.length; i++) {
  const r = sorted[i];
  const closed = r.trades.filter(t => t.pnl !== undefined);
  const wins = closed.filter(t => (t.pnl ?? 0) > 0).length;
  const wr = closed.length > 0 ? Math.round(wins / closed.length * 100) : 0;
  const diff = r.totalPnl - basePnl;
  console.log(`  ${i + 1}  | ${r.label.padEnd(45)} | ${(r.totalPnl >= 0 ? "+" : "") + Math.round(r.totalPnl).toLocaleString().padStart(9)}円 | ${(diff >= 0 ? "+" : "") + Math.round(diff).toLocaleString().padStart(7)}円 | ${String(closed.length).padStart(4)}T | ${String(wr).padStart(3)}%  | ${r.blockedCount}`);
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
  const cols = detailResults.map(r => {
    const day = r.daily[i];
    return `${(day.pnl >= 0 ? "+" : "") + Math.round(day.pnl).toLocaleString().padStart(8)}円(${day.trades}T)`;
  });
  console.log(`${d} | ${cols.map(c => c.padEnd(20)).join(" | ")}`);
}

// === シグナル種別別損益 ===
console.log("");
console.log("=".repeat(80));
console.log("シグナル種別別損益（各提案 vs 現行）");
console.log("=".repeat(80));
console.log("");

for (let ci = 0; ci < detailResults.length; ci++) {
  const r = detailResults[ci];
  const closed = r.trades.filter(t => t.pnl !== undefined);
  const byFamily = new Map<string, { pnl: number; count: number; wins: number }>();
  
  for (const t of closed) {
    // エントリーのsignalFamilyを探す
    const entryTrade = r.trades.find(et => et.sym === t.sym && et.date === t.date && (et.action === "buy" || et.action === "short") && !et.pnl);
    const fam = entryTrade?.signalFamily ?? "unknown";
    const existing = byFamily.get(fam) ?? { pnl: 0, count: 0, wins: 0 };
    existing.pnl += (t.pnl ?? 0);
    existing.count++;
    if ((t.pnl ?? 0) > 0) existing.wins++;
    byFamily.set(fam, existing);
  }
  
  console.log(`--- ${r.label} ---`);
  console.log("シグナル種別   | 損益         | 取引数 | 勝率");
  console.log("--------------|-------------|--------|------");
  for (const [fam, data] of [...byFamily.entries()].sort((a, b) => b[1].pnl - a[1].pnl)) {
    const wr = data.count > 0 ? Math.round(data.wins / data.count * 100) : 0;
    console.log(`${fam.padEnd(14)} | ${(data.pnl >= 0 ? "+" : "") + Math.round(data.pnl).toLocaleString().padStart(9)}円 | ${String(data.count).padStart(4)}T | ${String(wr).padStart(3)}%`);
  }
  console.log("");
}

// === ブロックされたシグナルの詳細（提案A） ===
console.log("=".repeat(80));
console.log("提案Eでブロックされたシグナル詳細（medium+板≥3）");
console.log("=".repeat(80));
console.log("");
const proposalE = detailResults[1];
for (const reason of proposalE.blockedReasons.slice(0, 30)) {
  console.log(`  ${reason}`);
}
if (proposalE.blockedReasons.length > 30) {
  console.log(`  ... 他${proposalE.blockedReasons.length - 30}件`);
}

// === 追加エントリーの詳細（提案A vs 現行） ===
console.log("");
console.log("=".repeat(80));
console.log("提案Eで追加されたエントリー（現行にはないトレード）");
console.log("=".repeat(80));
console.log("");

const baseEntries = new Set(detailResults[0].trades.filter(t => t.action === "buy" || t.action === "short").map(t => `${t.date}_${t.time}_${t.sym}_${t.action}`));
const eEntries = detailResults[1].trades.filter(t => (t.action === "buy" || t.action === "short") && !baseEntries.has(`${t.date}_${t.time}_${t.sym}_${t.action}`));

if (eEntries.length === 0) {
  console.log("  追加エントリーなし");
} else {
  console.log("日付       | 時刻  | 銘柄   | 方向  | 理由                                    | 信頼度  | 結果");
  console.log("-----------|-------|--------|------|----------------------------------------|--------|------");
  for (const entry of eEntries) {
    const exitTrade = detailResults[1].trades.find(t => t.sym === entry.sym && t.date === entry.date && t.pnl !== undefined && t.time > entry.time);
    const pnlStr = exitTrade ? `${(exitTrade.pnl ?? 0) >= 0 ? "+" : ""}${Math.round(exitTrade.pnl ?? 0).toLocaleString()}円` : "未決済";
    console.log(`${entry.date} | ${entry.time} | ${entry.sym.padEnd(6)} | ${entry.action.padEnd(5)} | ${(entry.reason ?? "").substring(0, 40).padEnd(40)} | ${(entry.confidence ?? "").padEnd(6)} | ${pnlStr}`);
  }
}

// === 現行にあって提案Aにないエントリー（ブロックされたもの） ===
console.log("");
console.log("=".repeat(80));
console.log("提案Eでブロックされたエントリー（現行にはあるが提案Eにはないトレード）");
console.log("=".repeat(80));
console.log("");

const eEntriesSet = new Set(detailResults[1].trades.filter(t => t.action === "buy" || t.action === "short").map(t => `${t.date}_${t.time}_${t.sym}_${t.action}`));
const blockedEntries = detailResults[0].trades.filter(t => (t.action === "buy" || t.action === "short") && !eEntriesSet.has(`${t.date}_${t.time}_${t.sym}_${t.action}`));

if (blockedEntries.length === 0) {
  console.log("  ブロックされたエントリーなし");
} else {
  console.log("日付       | 時刻  | 銘柄   | 方向  | 理由                                    | 結果");
  console.log("-----------|-------|--------|------|----------------------------------------|------");
  for (const entry of blockedEntries) {
    const exitTrade = detailResults[0].trades.find(t => t.sym === entry.sym && t.date === entry.date && t.pnl !== undefined && t.time > entry.time);
    const pnlStr = exitTrade ? `${(exitTrade.pnl ?? 0) >= 0 ? "+" : ""}${Math.round(exitTrade.pnl ?? 0).toLocaleString()}円` : "未決済";
    console.log(`${entry.date} | ${entry.time} | ${entry.sym.padEnd(6)} | ${entry.action.padEnd(5)} | ${(entry.reason ?? "").substring(0, 40).padEnd(40)} | ${pnlStr}`);
  }
}
