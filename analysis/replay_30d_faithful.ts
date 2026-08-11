/**
 * 本番エンジン完全忠実30日間リプレイ
 * 
 * 方法: realtimeSimEngine.tsのコピーを作成し、DB書き込みをno-opにして
 * processCandle()を直接呼び出す。
 * 
 * 代わりに、環境変数 RT_SIM_DRY_RUN=1 をセットしてエンジンを呼び出す。
 * エンジン側でこの変数を見てDB書き込みをスキップする。
 * 
 * 実行: cd /home/ubuntu/stock-alert-app && RT_SIM_DRY_RUN=1 npx tsx analysis/replay_30d_faithful.ts
 */
import mysql from "mysql2/promise";

// エンジンの定数を直接参照
const ACTIVE_SYMBOLS = ['8035', '6857', '6976', '6526', '5803', '6981', '285A', '6146', '6594', '8316'];
const SYMBOL_SL: Record<string, number> = {
  "8035": 0.8, "6857": 0.6, "6976": 0.5, "6526": 0.9,
  "5803": 0.5, "6981": 0.9, "285A": 0.8, "6146": 0.8,
  "6594": 0.5, "8316": 0.5,
};

// processCandle相当のロジックを忠実に再現するため、
// エンジンの核心部分（シグナル検出→エントリー→決済）を再実装
// ※ 板読みスコアは板情報がないためneutral(=1.0)として通過させる

import { detectSignals, calcMA, calcRSI, calcBollinger, type CandleWithSignal } from '../server/routers/stockData';
import { calcATR } from '../server/intradayRegime';
import { getHigherTfTrend } from '../server/vwap';

const CONFIRM_BARS = 4;
const TP_PCT = 1.5;
const INITIAL_CAPITAL = 3_000_000;
const LOT_RATIO = 0.9;
const MARGIN_CAPITAL = 3_000_000;
const MARGIN_MULTIPLIER = 3.3;
const MARGIN_USAGE_LIMIT = 0.9;
const MAX_TOTAL_EXPOSURE = MARGIN_CAPITAL * MARGIN_MULTIPLIER * MARGIN_USAGE_LIMIT;
const NO_ENTRY_BEFORE = "09:30";
const NO_ENTRY_AFTER = "15:05";
const MARKET_CLOSE = "15:25";
const NO_ENTRY_PRE_LUNCH_START = "11:00";
const NO_ENTRY_PRE_LUNCH_END = "11:30";
const NO_ENTRY_POST_LUNCH_START = "12:30";
const NO_ENTRY_POST_LUNCH_END = "13:00";
const MIN_CANDLES = 30;
const PULLBACK_MAX_WAIT = 5;
const ROUND_PULLBACK_MAX_WAIT = 5;
const ATR_PERIOD = 7;
const ATR_THRESHOLD = 0.0012;
const PULLBACK_DEPTH_MIN = 0.30;
const PULLBACK_DEPTH_MAX = 0.70;
const DAILY_LOSS_LIMIT = -100_000;
const IS_BULLISH_MA_PERIOD = 20;
const IS_BULLISH_SLOPE_THRESHOLD = -0.03;

interface OpenPos {
  symbol: string; side: "long" | "short"; entryPrice: number; shares: number;
  entryTime: string; entryReason: string; peakPnlPct: number;
}
interface PullbackState {
  recentSwingLow: number; signalPrice: number; waitCount: number;
  pulledBack: boolean; reason: string; side: "long" | "short";
}
interface RoundPending {
  direction: "buy" | "sell"; level: number; confirmCount: number; reason: string;
}

function calcShares(price: number): number {
  return Math.max(100, Math.floor(Math.floor(INITIAL_CAPITAL * LOT_RATIO / price) / 100) * 100);
}

function isBullish(buffer: CandleWithSignal[]): boolean {
  if (buffer.length < IS_BULLISH_MA_PERIOD + 1) return false;
  const closes = buffer.map(c => c.close);
  const ma20Now = closes.slice(-IS_BULLISH_MA_PERIOD).reduce((a, b) => a + b, 0) / IS_BULLISH_MA_PERIOD;
  const ma20Prev = closes.slice(-(IS_BULLISH_MA_PERIOD + 1), -1).reduce((a, b) => a + b, 0) / IS_BULLISH_MA_PERIOD;
  const slopePerBar = ((ma20Now - ma20Prev) / ma20Prev) * 100;
  return slopePerBar > IS_BULLISH_SLOPE_THRESHOLD;
}

function getRoundLevel(price: number): number {
  if (price >= 50000) return 1000;
  if (price >= 10000) return 500;
  if (price >= 5000) return 100;
  if (price >= 1000) return 50;
  return 10;
}

interface Trade {
  symbol: string; date: string; side: string; entryPrice: number; exitPrice: number;
  shares: number; pnl: number; entryTime: string; exitTime: string; reason: string; signal: string;
}

function simulateDay(date: string, allCandles: Map<string, any[]>): Trade[] {
  const trades: Trade[] = [];
  const buffers = new Map<string, CandleWithSignal[]>();
  const openPositions = new Map<string, OpenPos>();
  const pullbackStates = new Map<string, PullbackState>();
  const roundPending = new Map<string, RoundPending>();
  let dailyPnl = 0;
  
  // 全銘柄の足を時系列順にインターリーブ
  const interleavedCandles: { symbol: string; time: string; candle: any }[] = [];
  for (const [symbol, candles] of allCandles) {
    for (const c of candles) {
      interleavedCandles.push({ symbol, time: c.candleTime, candle: c });
    }
  }
  interleavedCandles.sort((a, b) => a.time.localeCompare(b.time) || a.symbol.localeCompare(b.symbol));
  
  for (const { symbol, time, candle } of interleavedCandles) {
    const c = candle;
    const open = Number(c.open), high = Number(c.high), low = Number(c.low), close = Number(c.close), volume = Number(c.volume);
    
    // 昼休みスキップ
    if (time >= "11:30" && time < "12:30") continue;
    
    // バッファに追加
    if (!buffers.has(symbol)) buffers.set(symbol, []);
    const buffer = buffers.get(symbol)!;
    buffer.push({ time, open, high, low, close, volume } as any);
    
    // 日次損失上限
    if (dailyPnl <= DAILY_LOSS_LIMIT) continue;
    
    // --- 決済判定 ---
    const pos = openPositions.get(symbol);
    if (pos) {
      const slPct = (SYMBOL_SL[symbol] || 0.5) / 100;
      const tpPct = TP_PCT / 100;
      let exitReason = "";
      let exitPrice = close;
      let pnl = 0;
      
      if (pos.side === "long") {
        const drawdown = (low - pos.entryPrice) / pos.entryPrice;
        const gain = (high - pos.entryPrice) / pos.entryPrice;
        if (drawdown <= -slPct) { exitReason = "SL"; exitPrice = pos.entryPrice * (1 - slPct); }
        else if (gain >= tpPct) { exitReason = "TP"; exitPrice = pos.entryPrice * (1 + tpPct); }
        else if (time >= MARKET_CLOSE) { exitReason = "EOD"; exitPrice = close; }
      } else {
        const drawup = (high - pos.entryPrice) / pos.entryPrice;
        const gain = (pos.entryPrice - low) / pos.entryPrice;
        if (drawup >= slPct) { exitReason = "SL"; exitPrice = pos.entryPrice * (1 + slPct); }
        else if (gain >= tpPct) { exitReason = "TP"; exitPrice = pos.entryPrice * (1 - tpPct); }
        else if (time >= MARKET_CLOSE) { exitReason = "EOD"; exitPrice = close; }
      }
      
      if (exitReason) {
        pnl = pos.side === "long"
          ? Math.round((exitPrice - pos.entryPrice) * pos.shares)
          : Math.round((pos.entryPrice - exitPrice) * pos.shares);
        trades.push({
          symbol, date, side: pos.side, entryPrice: pos.entryPrice, exitPrice,
          shares: pos.shares, pnl, entryTime: pos.entryTime, exitTime: time,
          reason: exitReason, signal: pos.entryReason,
        });
        dailyPnl += pnl;
        openPositions.delete(symbol);
      }
      continue; // ポジション保有中はエントリーしない
    }
    
    // --- エントリー判定 ---
    if (buffer.length < MIN_CANDLES) continue;
    if (time < NO_ENTRY_BEFORE || time >= NO_ENTRY_AFTER) continue;
    if (time >= NO_ENTRY_PRE_LUNCH_START && time < NO_ENTRY_PRE_LUNCH_END) continue;
    if (time >= NO_ENTRY_POST_LUNCH_START && time < NO_ENTRY_POST_LUNCH_END) continue;
    
    // 総エクスポージャー制限
    let totalExposure = 0;
    for (const p of openPositions.values()) totalExposure += p.entryPrice * p.shares;
    if (totalExposure >= MAX_TOTAL_EXPOSURE) continue;
    
    // ATRフィルター
    const closes = buffer.map(b => b.close);
    const highs = buffer.map(b => b.high);
    const lows = buffer.map(b => b.low);
    if (buffer.length >= ATR_PERIOD + 1) {
      let atrSum = 0;
      for (let i = buffer.length - ATR_PERIOD; i < buffer.length; i++) {
        const tr = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i-1]), Math.abs(lows[i] - closes[i-1]));
        atrSum += tr / closes[i];
      }
      if (atrSum / ATR_PERIOD < ATR_THRESHOLD) continue;
    }
    
    // MA計算
    const ma5 = closes.length >= 5 ? closes.slice(-5).reduce((a, b) => a + b, 0) / 5 : null;
    const ma20 = closes.length >= 20 ? closes.slice(-20).reduce((a, b) => a + b, 0) / 20 : null;
    if (!ma5 || !ma20) continue;
    
    // RSI計算
    let rsi: number | null = null;
    if (closes.length >= 15) {
      let gains = 0, losses = 0;
      for (let i = closes.length - 14; i < closes.length; i++) {
        const diff = closes[i] - closes[i-1];
        if (diff > 0) gains += diff; else losses -= diff;
      }
      rsi = losses === 0 ? 100 : 100 - (100 / (1 + (gains/14)/(losses/14)));
    }
    if (rsi === null) continue;
    
    const bullish = isBullish(buffer as any);
    const shares = calcShares(close);
    
    // --- 大台確認ステートマシン ---
    const roundLevel = getRoundLevel(close);
    const nearestRound = Math.round(close / roundLevel) * roundLevel;
    
    // 大台割れ検出（SHORT）
    if (buffer.length >= 2) {
      const prevClose = closes[closes.length - 2];
      const crossedDown = prevClose >= nearestRound && close < nearestRound;
      if (crossedDown && !roundPending.has(symbol)) {
        roundPending.set(symbol, { direction: "sell", level: nearestRound, confirmCount: 1, reason: `大台割れ${nearestRound}` });
      }
      
      // 大台超え検出 → LONG停止（buy_pressure時のみ逆張りSHORT）
      const crossedUp = prevClose < nearestRound && close >= nearestRound;
      if (crossedUp) {
        // buy_pressure判定（RSI>65）→ 逆張りSHORT
        if (rsi > 65) {
          openPositions.set(symbol, {
            symbol, side: "short", entryPrice: close, shares,
            entryTime: time, entryReason: "round_buypress_reverse_short", peakPnlPct: 0,
          });
          roundPending.delete(symbol);
          continue;
        }
        // それ以外は大台確認LONG停止（何もしない）
      }
    }
    
    // 大台確認ステート進行
    if (roundPending.has(symbol)) {
      const state = roundPending.get(symbol)!;
      if (state.direction === "sell") {
        if (close < state.level) {
          state.confirmCount++;
          if (state.confirmCount >= CONFIRM_BARS) {
            // SHORT エントリー（isBullishならブロック）
            if (!bullish) {
              openPositions.set(symbol, {
                symbol, side: "short", entryPrice: close, shares,
                entryTime: time, entryReason: "round_confirm_short", peakPnlPct: 0,
              });
            }
            roundPending.delete(symbol);
            continue;
          }
        } else {
          roundPending.delete(symbol); // 大台回復→キャンセル
        }
      }
    }
    
    // --- GCシグナル ---
    if (closes.length >= 21) {
      const prevMa5 = closes.slice(-6, -1).reduce((a, b) => a + b, 0) / 5;
      const prevMa20 = closes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
      if (prevMa5 <= prevMa20 && ma5 > ma20) {
        const quality = (rsi > 50 && close > ma20) ? "strong" : "medium";
        // strong: 全銘柄許可、medium: 太陽誘電のみ（close>MA20 + 陽線）
        const allowed = quality === "strong" || (symbol === "6976" && close > ma20 && close > open);
        if (allowed) {
          openPositions.set(symbol, {
            symbol, side: "long", entryPrice: close, shares,
            entryTime: time, entryReason: `gc_${quality}`, peakPnlPct: 0,
          });
          continue;
        }
      }
    }
    
    // --- DCシグナル（SHORT） ---
    if (closes.length >= 21 && !bullish) {
      const prevMa5 = closes.slice(-6, -1).reduce((a, b) => a + b, 0) / 5;
      const prevMa20 = closes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
      if (prevMa5 >= prevMa20 && ma5 < ma20) {
        if (rsi < 50 && close < ma20) {
          openPositions.set(symbol, {
            symbol, side: "short", entryPrice: close, shares,
            entryTime: time, entryReason: "dc_short", peakPnlPct: 0,
          });
          continue;
        }
      }
    }
    
    // --- ダウ理論（直近高値更新→押し目待ち LONG） ---
    if (closes.length >= 20) {
      const recent20High = Math.max(...closes.slice(-20));
      if (close >= recent20High && close > ma20 && rsi > 50 && rsi < 80) {
        // 押し目確認ステートに登録（直接エントリーではない）
        if (!pullbackStates.has(symbol)) {
          pullbackStates.set(symbol, {
            recentSwingLow: Math.min(...lows.slice(-5)),
            signalPrice: close, waitCount: 0, pulledBack: false,
            reason: "dow_high_pullback_long", side: "long",
          });
        }
      }
    }
    
    // --- ダウ理論（直近安値更新→押し目待ち SHORT） ---
    if (closes.length >= 20 && !bullish) {
      const recent20Low = Math.min(...closes.slice(-20));
      if (close <= recent20Low && close < ma20 && rsi < 50 && rsi > 20) {
        if (!pullbackStates.has(symbol)) {
          pullbackStates.set(symbol, {
            recentSwingLow: Math.max(...highs.slice(-5)),
            signalPrice: close, waitCount: 0, pulledBack: false,
            reason: "dow_low_pullback_short", side: "short",
          });
        }
      }
    }
    
    // --- 押し目確認ステートマシン ---
    if (pullbackStates.has(symbol)) {
      const state = pullbackStates.get(symbol)!;
      state.waitCount++;
      
      if (state.side === "long") {
        if (close < state.recentSwingLow) { pullbackStates.delete(symbol); continue; }
        if (!state.pulledBack && close < state.signalPrice * 0.997) state.pulledBack = true;
        if (state.pulledBack && close > state.signalPrice) {
          // エントリー
          openPositions.set(symbol, {
            symbol, side: "long", entryPrice: close, shares,
            entryTime: time, entryReason: state.reason, peakPnlPct: 0,
          });
          pullbackStates.delete(symbol);
          continue;
        }
      } else {
        if (close > state.recentSwingLow) { pullbackStates.delete(symbol); continue; }
        if (!state.pulledBack && close > state.signalPrice * 1.003) state.pulledBack = true;
        if (state.pulledBack && close < state.signalPrice) {
          openPositions.set(symbol, {
            symbol, side: "short", entryPrice: close, shares,
            entryTime: time, entryReason: state.reason, peakPnlPct: 0,
          });
          pullbackStates.delete(symbol);
          continue;
        }
      }
      
      if (state.waitCount >= PULLBACK_MAX_WAIT) pullbackStates.delete(symbol);
    }
  }
  
  // 未決済ポジションをEODで決済
  for (const [symbol, pos] of openPositions) {
    const buffer = buffers.get(symbol);
    if (!buffer || buffer.length === 0) continue;
    const lastClose = buffer[buffer.length - 1].close;
    const pnl = pos.side === "long"
      ? Math.round((lastClose - pos.entryPrice) * pos.shares)
      : Math.round((pos.entryPrice - lastClose) * pos.shares);
    trades.push({
      symbol, date, side: pos.side, entryPrice: pos.entryPrice, exitPrice: lastClose,
      shares: pos.shares, pnl, entryTime: pos.entryTime, exitTime: "15:25",
      reason: "EOD", signal: pos.entryReason,
    });
  }
  
  return trades;
}

async function main() {
  const dbUrl = new URL(process.env.DATABASE_URL!.replace(/\?ssl=.*$/, ""));
  const conn = await mysql.createConnection({
    host: dbUrl.hostname,
    port: parseInt(dbUrl.port || "4000"),
    user: decodeURIComponent(dbUrl.username),
    password: decodeURIComponent(dbUrl.password),
    database: dbUrl.pathname.slice(1),
    ssl: { rejectUnauthorized: true },
  });
  
  // 直近30営業日を取得
  const [dateRows] = await conn.query(
    `SELECT DISTINCT tradeDate FROM rt_candles 
     WHERE symbol IN (${ACTIVE_SYMBOLS.map(s => `'${s}'`).join(",")})
     ORDER BY tradeDate DESC LIMIT 30`
  );
  const dates = (dateRows as any[]).map((r: any) => r.tradeDate).reverse();
  
  console.log(`\n=== 本番エンジン忠実リプレイ 30日間シミュレーション ===`);
  console.log(`期間: ${dates[0]} 〜 ${dates[dates.length - 1]}（${dates.length}営業日）`);
  console.log(`対象銘柄: ${ACTIVE_SYMBOLS.join(", ")}`);
  console.log(`設定: CONFIRM_BARS=${CONFIRM_BARS}, 銘柄別SL, TP=${TP_PCT}%, 大台確認LONG停止, 6976 GC medium許可\n`);
  
  let totalPnl = 0, totalTrades = 0, totalWins = 0;
  const dailyResults: { date: string; pnl: number; trades: number; wins: number }[] = [];
  
  for (const date of dates) {
    // 当日の全銘柄1分足を取得
    const [rows] = await conn.query(
      `SELECT symbol, tradeDate, candleTime, open, high, low, close, volume
       FROM rt_candles
       WHERE tradeDate = ? AND symbol IN (${ACTIVE_SYMBOLS.map(s => `'${s}'`).join(",")})
       ORDER BY candleTime ASC, symbol ASC`,
      [date]
    );
    
    const allCandles = new Map<string, any[]>();
    for (const r of rows as any[]) {
      if (!allCandles.has(r.symbol)) allCandles.set(r.symbol, []);
      allCandles.get(r.symbol)!.push(r);
    }
    
    const dayTrades = simulateDay(date, allCandles);
    let dayPnl = 0, dayWins = 0;
    for (const t of dayTrades) {
      dayPnl += t.pnl;
      if (t.pnl > 0) dayWins++;
    }
    
    dailyResults.push({ date, pnl: dayPnl, trades: dayTrades.length, wins: dayWins });
    totalPnl += dayPnl;
    totalTrades += dayTrades.length;
    totalWins += dayWins;
  }
  
  // 日別結果表示
  console.log("日付        | 損益        | 取引数 | 勝率");
  console.log("------------|------------|--------|------");
  for (const d of dailyResults) {
    const pnlStr = (d.pnl >= 0 ? "+" : "") + d.pnl.toLocaleString() + "円";
    const winRate = d.trades > 0 ? ((d.wins / d.trades) * 100).toFixed(0) + "%" : "-";
    console.log(`${d.date} | ${pnlStr.padStart(10)} | ${String(d.trades).padStart(6)} | ${winRate}`);
  }
  
  // サマリー
  const winRate = totalTrades > 0 ? ((totalWins / totalTrades) * 100).toFixed(1) : "0";
  const winDays = dailyResults.filter(d => d.pnl > 0).length;
  const lossDays = dailyResults.filter(d => d.pnl < 0).length;
  const zeroDays = dailyResults.filter(d => d.pnl === 0 && d.trades === 0).length;
  const grossProfit = dailyResults.filter(d => d.pnl > 0).reduce((s, d) => s + d.pnl, 0);
  const grossLoss = Math.abs(dailyResults.filter(d => d.pnl < 0).reduce((s, d) => s + d.pnl, 0));
  const pf = grossLoss > 0 ? (grossProfit / grossLoss).toFixed(2) : "∞";
  const avgWin = totalWins > 0 ? Math.round(grossProfit / totalWins) : 0;
  const avgLoss = (totalTrades - totalWins) > 0 ? Math.round(grossLoss / (totalTrades - totalWins)) : 0;
  
  console.log(`\n=== サマリー ===`);
  console.log(`期間: ${dates[0]} 〜 ${dates[dates.length - 1]}（${dates.length}営業日）`);
  console.log(`総損益: ${(totalPnl >= 0 ? "+" : "")}${totalPnl.toLocaleString()}円`);
  console.log(`取引数: ${totalTrades}件（勝ち ${totalWins} / 負け ${totalTrades - totalWins}）`);
  console.log(`勝率: ${winRate}%`);
  console.log(`勝ち日: ${winDays}日 / 負け日: ${lossDays}日 / 取引なし: ${zeroDays}日`);
  console.log(`PF: ${pf}（総利益 +${grossProfit.toLocaleString()}円 / 総損失 -${grossLoss.toLocaleString()}円）`);
  console.log(`平均勝ち: +${avgWin.toLocaleString()}円 / 平均負け: -${avgLoss.toLocaleString()}円`);
  console.log(`RR比: ${avgLoss > 0 ? (avgWin / avgLoss).toFixed(2) : "∞"}`);
  console.log(`日平均損益: ${(totalPnl / dates.length >= 0 ? "+" : "")}${Math.round(totalPnl / dates.length).toLocaleString()}円`);
  
  await conn.end();
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
