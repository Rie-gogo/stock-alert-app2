/**
 * today_sim_uptrend_filter.mjs
 * 2026-06-04（本日）のJ-Quants 1分足データを使い、
 * 「上昇トレンドが強い銘柄へのショートを禁止する」フィルターを追加してシミュレーション。
 *
 * フィルター仕様:
 *   - 各足の時点で classifyIntradayRegime（MA25傾き + 当日騰落率）を計算
 *   - regime === "up" の場合はショートエントリーを禁止
 *   - regime === "down" の場合はロングエントリーを禁止（既存ロジックと同様）
 *   - neutral は両方許可
 *
 * 実行: cd /home/ubuntu/stock-alert-app && node analysis/today_sim_uptrend_filter.mjs
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TARGET_DATE = '2026-06-04';
const JQUANTS_API_KEY = process.env.JQUANTS_API_KEY;

if (!JQUANTS_API_KEY) {
  console.error('ERROR: JQUANTS_API_KEY environment variable is not set');
  process.exit(1);
}

const SIMULATION_STOCKS = [
  { symbol: '3436', name: 'SUMCO' },
  { symbol: '3778', name: 'さくらインターネット' },
  { symbol: '6981', name: '村田製作所' },
  { symbol: '6758', name: 'ソニーグループ' },
  { symbol: '8306', name: '三菱UFJ FG' },
  { symbol: '8035', name: '東京エレクトロン' },
  { symbol: '6857', name: 'アドバンテスト' },
  { symbol: '6920', name: 'レーザーテック' },
  { symbol: '7011', name: '三菱重工業' },
  { symbol: '9984', name: 'ソフトバンクグループ' },
];

const HIGH_VOL_SYMBOLS = new Set(['9984', '6920', '6758', '7011', '8306']);
const CAPITAL = 3_000_000;
const LOT_NORMAL = 0.49;
const LOT_SMALL = 0.05;
const LONG_STOP_LOSS_PERCENT = 2.0;
const SHORT_STOP_LOSS_PERCENT = 0.50;
const TRAILING_TRIGGER = 0.01;
const TRAILING_STOP = 0.005;
const BREAKEVEN_TRIGGER = 0.005;
const MAX_TRADES_PER_STOCK = 4;
const WARMUP_BARS = 10;
const SUPPRESS_AFTERNOON_ENTRY = true;
const LUNCH_EXIT_ALL_MINUTE = '11:20';
const SHORT_MAX_HOLD_BARS = 60;
const SHORT_GC_COOLDOWN_BARS = 15;
const RANGE_EFFICIENCY_THRESHOLD = 0.30;

// ---- レジーム判定パラメータ（intradayRegime.ts と同一） ----
const REGIME_SLOPE_THRESHOLD = 0.0015;
const REGIME_DAY_CHANGE_THRESHOLD = 0.006;
const REGIME_SLOPE_WINDOW = 10;

// ---- テクニカル指標 ----
function calcMA(data, period) {
  const result = new Array(data.length).fill(null);
  for (let i = period - 1; i < data.length; i++)
    result[i] = data.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period;
  return result;
}
function calcRSI(data, period = 14) {
  const result = new Array(data.length).fill(null);
  if (data.length < period + 1) return result;
  const gains = [], losses = [];
  for (let i = 1; i < data.length; i++) {
    const d = data[i] - data[i - 1];
    gains.push(Math.max(d, 0)); losses.push(Math.max(-d, 0));
  }
  let ag = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let al = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < data.length; i++) {
    result[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
    if (i < data.length - 1) {
      ag = (ag * (period - 1) + gains[i]) / period;
      al = (al * (period - 1) + losses[i]) / period;
    }
  }
  return result;
}
function calcBollinger(data, period = 20, m = 2) {
  const upper = new Array(data.length).fill(null);
  const lower = new Array(data.length).fill(null);
  for (let i = period - 1; i < data.length; i++) {
    const w = data.slice(i - period + 1, i + 1);
    const avg = w.reduce((a, b) => a + b, 0) / period;
    const std = Math.sqrt(w.reduce((a, b) => a + (b - avg) ** 2, 0) / period);
    upper[i] = avg + m * std; lower[i] = avg - m * std;
  }
  return { upper, lower };
}
function calcFlow(closes, lookback = 10) {
  const result = new Array(closes.length).fill(null);
  for (let i = lookback; i < closes.length; i++) {
    const slice = closes.slice(i - lookback, i + 1);
    let up = 0, down = 0;
    for (let j = 1; j < slice.length; j++) {
      if (slice[j] > slice[j - 1]) up++;
      else if (slice[j] < slice[j - 1]) down++;
    }
    result[i] = (up - down) / lookback;
  }
  return result;
}
function calcSlope(ma25arr, lookback = 5) {
  const result = new Array(ma25arr.length).fill(null);
  for (let i = lookback; i < ma25arr.length; i++) {
    if (ma25arr[i] !== null && ma25arr[i - lookback] !== null)
      result[i] = (ma25arr[i] - ma25arr[i - lookback]) / ma25arr[i - lookback];
  }
  return result;
}

// ---- レジーム判定（intradayRegime.ts の classifyIntradayRegime 相当） ----
function classifyRegime(slope, dayChange) {
  const slopeDown = slope !== null && slope < -REGIME_SLOPE_THRESHOLD;
  const slopeUp   = slope !== null && slope > REGIME_SLOPE_THRESHOLD;
  const dayDown   = dayChange !== null && dayChange < -REGIME_DAY_CHANGE_THRESHOLD;
  const dayUp     = dayChange !== null && dayChange > REGIME_DAY_CHANGE_THRESHOLD;
  const downSignals = (slopeDown ? 1 : 0) + (dayDown ? 1 : 0);
  const upSignals   = (slopeUp   ? 1 : 0) + (dayUp   ? 1 : 0);
  if (downSignals >= 1 && upSignals === 0) return 'down';
  if (upSignals   >= 1 && downSignals === 0) return 'up';
  return 'neutral';
}

function computeMarketEfficiency(dayStats) {
  const ranges = [], nets = [];
  for (const s of dayStats) {
    if (s.open > 0) {
      ranges.push((s.high - s.low) / s.open);
      nets.push(Math.abs(s.close - s.open) / s.open);
    }
  }
  if (ranges.length === 0) return 1;
  const avgRange = ranges.reduce((a, b) => a + b, 0) / ranges.length;
  const avgNet   = nets.reduce((a, b) => a + b, 0) / nets.length;
  return avgRange > 0 ? avgNet / avgRange : 1;
}

async function fetchJqMinute(symbol) {
  const jqCode = `${symbol}0`;
  const url = `https://api.jquants.com/v2/equities/bars/minute?code=${jqCode}&from=${TARGET_DATE}&to=${TARGET_DATE}`;
  const resp = await fetch(url, { headers: { 'x-api-key': JQUANTS_API_KEY } });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const json = await resp.json();
  return json.data ?? [];
}

function barsToCandles(bars) {
  const rawCandles = [];
  for (const bar of bars) {
    const timeStr = bar.Time;
    const [hh, mm] = timeStr.split(':').map(Number);
    const totalMin = hh * 60 + mm;
    if (totalMin < 9 * 60 || totalMin > 15 * 60 + 30) continue;
    rawCandles.push({
      time: timeStr, open: bar.O, high: bar.H, low: bar.L, close: bar.C, volume: bar.Vo,
      ma5: null, ma25: null, rsi: null, bbUpper: null, bbLower: null, flow: null, slope: null,
    });
  }
  if (rawCandles.length < 30) return null;
  const closes = rawCandles.map(c => c.close);
  const ma5    = calcMA(closes, 5);
  const ma25   = calcMA(closes, 25);
  const rsi    = calcRSI(closes, 14);
  const bb     = calcBollinger(closes, 20, 2);
  const flow   = calcFlow(closes, 10);
  // slopeはREGIME_SLOPE_WINDOWで計算
  const slopeArr = calcSlope(ma25, REGIME_SLOPE_WINDOW);
  rawCandles.forEach((c, i) => {
    c.ma5 = ma5[i]; c.ma25 = ma25[i]; c.rsi = rsi[i];
    c.bbUpper = bb.upper[i]; c.bbLower = bb.lower[i];
    c.flow = flow[i]; c.slope = slopeArr[i];
  });
  return rawCandles;
}

function simulateStock(symbol, name, candles, rangeBoundDay) {
  const isHighVol = HIGH_VOL_SYMBOLS.has(symbol);
  const lotRatio  = isHighVol ? LOT_SMALL : LOT_NORMAL;

  const [lunchHH, lunchMM] = LUNCH_EXIT_ALL_MINUTE.split(':').map(Number);
  const lunchMinute = lunchHH * 60 + lunchMM;

  // 当日始値（レジーム計算用）
  const dayOpen = candles[0]?.open ?? null;

  let position   = null;
  let tradeCount = 0;
  let totalPnl   = 0;
  let gcCooldown = 0;
  const trades   = [];
  const regimeLog = []; // デバッグ用

  for (let i = WARMUP_BARS; i < candles.length; i++) {
    const c    = candles[i];
    const prev = candles[i - 1];
    if (!c.ma5 || !c.ma25 || !prev.ma5 || !prev.ma25 || !c.rsi) continue;

    const [hh, mm] = c.time.split(':').map(Number);
    const totalMin  = hh * 60 + mm;
    const isAfternoon = SUPPRESS_AFTERNOON_ENTRY && totalMin >= 12 * 60 + 30;

    // ★ 各足でレジームを計算（MA25傾き + 当日騰落率）
    const dayChange = dayOpen ? (c.close - dayOpen) / dayOpen : null;
    const regime    = classifyRegime(c.slope, dayChange);

    // 昼休み前強制決済
    if (position && totalMin >= lunchMinute && totalMin < 12 * 60 + 30) {
      const pnl = position.type === 'long'
        ? (c.close - position.entryPrice) * position.shares
        : (position.entryPrice - c.close) * position.shares;
      totalPnl += pnl;
      trades.push({
        type: position.type, entryTime: position.entryTime, exitTime: c.time,
        entryPrice: position.entryPrice, exitPrice: c.close,
        shares: position.shares, pnl: Math.round(pnl), reason: '昼休み前強制決済',
        regime,
      });
      position = null;
      continue;
    }

    if (gcCooldown > 0) gcCooldown--;

    if (position) {
      const unrealizedPnl = position.type === 'long'
        ? (c.close - position.entryPrice) * position.shares
        : (position.entryPrice - c.close) * position.shares;
      if (unrealizedPnl > position.peakPnl) position.peakPnl = unrealizedPnl;
      if (!position.breakeven && unrealizedPnl >= position.entryPrice * position.shares * BREAKEVEN_TRIGGER)
        position.breakeven = true;

      let exitReason = null, exitPrice = c.close;

      if (position.type === 'long') {
        const stopPrice = position.breakeven
          ? position.entryPrice
          : position.entryPrice * (1 - LONG_STOP_LOSS_PERCENT / 100);
        if (c.close <= stopPrice) {
          exitReason = position.breakeven ? '建値ストップ' : '損切り';
          exitPrice  = stopPrice;
        } else if (position.peakPnl > position.entryPrice * position.shares * TRAILING_TRIGGER) {
          const tsp = position.entryPrice + (position.peakPnl / position.shares) * (1 - TRAILING_STOP);
          if (c.close <= tsp) exitReason = 'トレイリング利確';
        }
      } else {
        const stopPrice = position.entryPrice * (1 + SHORT_STOP_LOSS_PERCENT / 100);
        if (c.close >= stopPrice) {
          exitReason = '損切り(ショート)'; exitPrice = stopPrice;
        } else if (position.peakPnl > position.entryPrice * position.shares * TRAILING_TRIGGER) {
          const tsp = position.entryPrice - (position.peakPnl / position.shares) * (1 - TRAILING_STOP);
          if (c.close >= tsp) exitReason = 'トレイリング利確(ショート)';
        }
        if (!exitReason) {
          const entryIdx = candles.findIndex(cc => cc.time === position.entryTime);
          if (entryIdx >= 0 && i - entryIdx >= SHORT_MAX_HOLD_BARS)
            exitReason = '最大保有時間超過(ショート)';
        }
        const isGC = prev.ma5 <= prev.ma25 && c.ma5 > c.ma25;
        if (isGC && !exitReason) {
          const unrealized = (position.entryPrice - c.close) * position.shares;
          if (unrealized > 0 && c.rsi >= 40) {
            exitReason = 'GCカバー(ショート)';
            gcCooldown = SHORT_GC_COOLDOWN_BARS;
          }
        }
      }

      if (exitReason) {
        const pnl = position.type === 'long'
          ? (exitPrice - position.entryPrice) * position.shares
          : (position.entryPrice - exitPrice) * position.shares;
        totalPnl += pnl;
        trades.push({
          type: position.type, entryTime: position.entryTime, exitTime: c.time,
          entryPrice: position.entryPrice, exitPrice,
          shares: position.shares, pnl: Math.round(pnl), reason: exitReason,
          regime,
        });
        position = null;
      }
    }

    if (!position && tradeCount < MAX_TRADES_PER_STOCK && !isAfternoon && !rangeBoundDay) {
      const isGC   = prev.ma5 <= prev.ma25 && c.ma5 > c.ma25;
      const isDC   = prev.ma5 >= prev.ma25 && c.ma5 < c.ma25;
      const mktUp  = c.slope !== null && c.slope > 0.0005;
      const mktDown= c.slope !== null && c.slope < -0.0005;
      const flowBuy = c.flow !== null && c.flow > 0.2;
      const flowSell= c.flow !== null && c.flow < -0.2;

      // ★ レジームゲート
      const allowLong  = regime !== 'down';   // down相場ではロング禁止
      const allowShort = regime !== 'up';     // up相場ではショート禁止 ← 新規追加

      const shares = Math.floor((CAPITAL * lotRatio) / c.close);
      if (shares > 0) {
        if (allowLong && isGC && mktUp && flowBuy && gcCooldown === 0) {
          position = { type: 'long', entryPrice: c.close, entryTime: c.time, shares, peakPnl: 0, breakeven: false, entryRegime: regime };
          tradeCount++;
        } else if (allowLong && !isGC && c.ma5 > c.ma25 && mktUp && c.rsi < 45 && c.close <= c.ma25 * 1.005 && flowBuy) {
          position = { type: 'long', entryPrice: c.close, entryTime: c.time, shares, peakPnl: 0, breakeven: false, entryRegime: regime };
          tradeCount++;
        } else if (allowShort && !isDC && mktDown && c.rsi >= 55 && c.close <= c.ma25 * 1.002 && flowSell && gcCooldown === 0) {
          position = { type: 'short', entryPrice: c.close, entryTime: c.time, shares, peakPnl: 0, breakeven: false, entryRegime: regime };
          tradeCount++;
        } else if (allowShort && mktDown && c.ma5 < c.ma25 && c.close < c.ma25 && flowSell && c.rsi > 35 && gcCooldown === 0) {
          position = { type: 'short', entryPrice: c.close, entryTime: c.time, shares, peakPnl: 0, breakeven: false, entryRegime: regime };
          tradeCount++;
        }
      }
    }
  }

  // 引け値強制決済
  if (position) {
    const last = candles[candles.length - 1];
    const pnl  = position.type === 'long'
      ? (last.close - position.entryPrice) * position.shares
      : (position.entryPrice - last.close) * position.shares;
    totalPnl += pnl;
    trades.push({
      type: position.type, entryTime: position.entryTime, exitTime: last.time,
      entryPrice: position.entryPrice, exitPrice: last.close,
      shares: position.shares, pnl: Math.round(pnl), reason: '引け値強制決済',
    });
  }

  return { symbol, name, pnl: Math.round(totalPnl), trades };
}

async function main() {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`  本日（${TARGET_DATE}）シミュレーション【上昇トレンド銘柄へのショート禁止】`);
  console.log(`${'='.repeat(70)}\n`);

  // データ取得
  const candleMap = new Map();
  const dayStats  = [];

  for (const stock of SIMULATION_STOCKS) {
    try {
      const bars    = await fetchJqMinute(stock.symbol);
      if (bars.length === 0) continue;
      const candles = barsToCandles(bars);
      if (!candles) continue;
      candleMap.set(stock.symbol, candles);
      const chg = ((candles[candles.length-1].close - candles[0].open) / candles[0].open * 100).toFixed(2);
      dayStats.push({
        symbol: stock.symbol, name: stock.name,
        open:  candles[0].open,
        high:  Math.max(...candles.map(c => c.high)),
        low:   Math.min(...candles.map(c => c.low)),
        close: candles[candles.length - 1].close,
        chg,
      });
    } catch (err) {
      console.log(`${stock.name}: エラー ${err.message}`);
    }
    await new Promise(r => setTimeout(r, 300));
  }

  const marketEfficiency = computeMarketEfficiency(dayStats);
  const rangeBoundDay    = marketEfficiency < RANGE_EFFICIENCY_THRESHOLD;
  console.log(`市場効率: ${marketEfficiency.toFixed(3)} → ${rangeBoundDay ? 'レンジ相場' : 'トレンド相場'}`);

  // 各銘柄の終値レジームを表示
  console.log('\n【銘柄別 終値時点のレジーム（参考）】');
  for (const s of dayStats) {
    const candles  = candleMap.get(s.symbol);
    const last     = candles[candles.length - 1];
    const dayChange= (last.close - s.open) / s.open;
    const regime   = classifyRegime(last.slope, dayChange);
    const sign     = parseFloat(s.chg) >= 0 ? '+' : '';
    console.log(`  ${s.name.padEnd(20)} ${sign}${s.chg}%  レジーム: ${regime}`);
  }

  // シミュレーション実行
  const results = [];
  let totalPnl = 0, totalTrades = 0, winTrades = 0, lossTrades = 0;
  const blockedShorts = []; // ブロックされたショートを記録

  for (const stock of SIMULATION_STOCKS) {
    const candles = candleMap.get(stock.symbol);
    if (!candles) {
      results.push({ symbol: stock.symbol, name: stock.name, pnl: 0, trades: [] });
      continue;
    }
    const result = simulateStock(stock.symbol, stock.name, candles, rangeBoundDay);
    results.push(result);
    totalPnl += result.pnl;
    for (const t of result.trades) {
      totalTrades++;
      if (t.pnl > 0) winTrades++;
      else lossTrades++;
    }
  }

  const winRate = totalTrades > 0 ? (winTrades / totalTrades * 100).toFixed(1) : '-';

  // 銘柄別損益
  console.log('\n【銘柄別損益】');
  for (const r of results) {
    const sign = r.pnl >= 0 ? '+' : '';
    console.log(`  ${r.name}(${r.symbol}): ${sign}${r.pnl.toLocaleString()}円 (${r.trades.length}取引)`);
  }

  console.log(`\n${'='.repeat(70)}`);
  console.log(`  【合計損益】 ${totalPnl >= 0 ? '+' : ''}${totalPnl.toLocaleString()} 円`);
  console.log(`  取引数: ${totalTrades}件  勝: ${winTrades}  負: ${lossTrades}  勝率: ${winRate}%`);
  console.log(`${'='.repeat(70)}`);

  // 取引詳細
  console.log('\n【取引詳細】');
  for (const r of results) {
    if (!r.trades || r.trades.length === 0) continue;
    const sign = r.pnl >= 0 ? '+' : '';
    console.log(`\n  ▶ ${r.name}(${r.symbol}) ${sign}${r.pnl.toLocaleString()}円`);
    for (const t of r.trades) {
      const sign2   = t.pnl >= 0 ? '✅ +' : '❌ ';
      const typeStr = t.type === 'long' ? '買い' : '空売り';
      const regStr  = t.regime ? `[${t.regime}]` : '';
      console.log(`    ${sign2}${t.pnl.toLocaleString()}円  ${typeStr} ${t.entryTime}→${t.exitTime}  @${t.entryPrice}→${t.exitPrice}  ${t.shares}株  [${t.reason}] ${regStr}`);
    }
  }

  // 決済理由別集計
  const reasonMap = new Map();
  for (const r of results) {
    for (const t of r.trades) {
      if (!reasonMap.has(t.reason)) reasonMap.set(t.reason, { count: 0, pnl: 0 });
      const e = reasonMap.get(t.reason);
      e.count++; e.pnl += t.pnl;
    }
  }
  console.log('\n【決済理由別集計】');
  for (const [reason, stat] of [...reasonMap.entries()].sort((a, b) => b[1].pnl - a[1].pnl)) {
    const sign = stat.pnl >= 0 ? '+' : '';
    console.log(`  ${reason.padEnd(24)} ${stat.count}件  ${sign}${stat.pnl.toLocaleString()}円`);
  }

  // 比較
  const base = -9327;
  const diff = totalPnl - base;
  console.log(`\n【比較】`);
  console.log(`  ① 元のシステム（フィルターなし）:          ${base.toLocaleString()}円`);
  console.log(`  ② 上昇トレンド銘柄ショート禁止（今回）:   ${totalPnl >= 0 ? '+' : ''}${totalPnl.toLocaleString()}円`);
  console.log(`  差分:                                      ${diff >= 0 ? '+' : ''}${diff.toLocaleString()}円`);

  return { totalPnl, totalTrades, winTrades, lossTrades, winRate, results };
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
