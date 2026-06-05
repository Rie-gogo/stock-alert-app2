/**
 * today_report_20260604.mjs
 * 2026-06-04（本日）のJ-Quants 1分足データを取得し、
 * 現在のシステム（realSimulation.ts相当）でシミュレーションを実行して損益レポートを出力する。
 *
 * 実行: cd /home/ubuntu/stock-alert-app && node analysis/today_report_20260604.mjs
 */

import { createRequire } from 'module';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- 設定 ----
const TARGET_DATE = '2026-06-04';
const JQUANTS_API_KEY = process.env.JQUANTS_API_KEY;

if (!JQUANTS_API_KEY) {
  console.error('ERROR: JQUANTS_API_KEY environment variable is not set');
  process.exit(1);
}

// ---- 銘柄リスト（SIMULATION_STOCKS と同一） ----
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

// ---- HIGH_VOL_SYMBOLS（極小ロット銘柄） ----
const HIGH_VOL_SYMBOLS = new Set(['9984', '6920', '6758', '7011', '8306']);

// ---- パラメータ（realSimulation.tsと同一） ----
const CAPITAL = 3_000_000;
const LOT_NORMAL = 0.49;
const LOT_HIGH_VOL = 0.05;
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
const MAX_CONCURRENT = 3;
const DAILY_STOP_LOSS = -15_000;
const DAILY_PROFIT_TARGET = null; // 利益保護なし

// ---- テクニカル指標計算 ----
function calcMA(data, period) {
  const result = new Array(data.length).fill(null);
  for (let i = period - 1; i < data.length; i++) {
    result[i] = data.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period;
  }
  return result;
}

function calcRSI(data, period = 14) {
  const result = new Array(data.length).fill(null);
  if (data.length < period + 1) return result;
  const gains = [], losses = [];
  for (let i = 1; i < data.length; i++) {
    const d = data[i] - data[i - 1];
    gains.push(Math.max(d, 0));
    losses.push(Math.max(-d, 0));
  }
  let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < data.length; i++) {
    if (avgLoss === 0) result[i] = 100;
    else { const rs = avgGain / avgLoss; result[i] = 100 - 100 / (1 + rs); }
    if (i < data.length - 1) {
      avgGain = (avgGain * (period - 1) + gains[i]) / period;
      avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
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
    upper[i] = avg + m * std;
    lower[i] = avg - m * std;
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

function calcSlope(ma25, lookback = 5) {
  const result = new Array(ma25.length).fill(null);
  for (let i = lookback; i < ma25.length; i++) {
    if (ma25[i] !== null && ma25[i - lookback] !== null) {
      result[i] = (ma25[i] - ma25[i - lookback]) / ma25[i - lookback];
    }
  }
  return result;
}

function computeMarketEfficiency(closes) {
  if (closes.length < 2) return 0;
  const netMove = Math.abs(closes[closes.length - 1] - closes[0]);
  const totalPath = closes.slice(1).reduce((sum, c, i) => sum + Math.abs(c - closes[i]), 0);
  return totalPath === 0 ? 0 : netMove / totalPath;
}

// ---- J-Quants API からデータ取得 ----
async function fetchJqMinute(symbol) {
  const jqCode = `${symbol}0`;
  const url = `https://api.jquants.com/v2/equities/bars/minute?code=${jqCode}&from=${TARGET_DATE}&to=${TARGET_DATE}`;
  const resp = await fetch(url, {
    headers: { 'x-api-key': JQUANTS_API_KEY },
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`J-Quants API HTTP ${resp.status}: ${body.slice(0, 200)}`);
  }
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
    const jstDate = new Date(`${bar.Date}T${timeStr}:00+09:00`);
    rawCandles.push({
      time: timeStr,
      timestamp: jstDate.getTime(),
      open: bar.O, high: bar.H, low: bar.L, close: bar.C, volume: bar.Vo,
      ma5: null, ma25: null, rsi: null, bbUpper: null, bbLower: null,
      flow: null, slope: null,
    });
  }
  if (rawCandles.length < 30) return null;
  const closes = rawCandles.map(c => c.close);
  const ma5 = calcMA(closes, 5);
  const ma25 = calcMA(closes, 25);
  const rsi = calcRSI(closes, 14);
  const bb = calcBollinger(closes, 20, 2);
  const flow = calcFlow(closes, 10);
  const slopeArr = calcSlope(ma25, 5);
  rawCandles.forEach((c, i) => {
    c.ma5 = ma5[i]; c.ma25 = ma25[i]; c.rsi = rsi[i];
    c.bbUpper = bb.upper[i]; c.bbLower = bb.lower[i];
    c.flow = flow[i]; c.slope = slopeArr[i];
  });
  return rawCandles;
}

// ---- シミュレーション（realSimulation.ts の simulateStockReal と同等） ----
function simulateStock(symbol, candles, lotMultiplier = 1.0) {
  const isHighVol = HIGH_VOL_SYMBOLS.has(symbol);
  const lotRatio = isHighVol ? LOT_HIGH_VOL : LOT_NORMAL;
  const effectiveLot = Math.min(lotRatio * lotMultiplier, 0.6);

  const [lunchHH, lunchMM] = LUNCH_EXIT_ALL_MINUTE.split(':').map(Number);
  const lunchMinute = lunchHH * 60 + lunchMM;

  let position = null; // { type: 'long'|'short', entryPrice, entryTime, shares, peakPnl, breakeven, gcCooldown }
  let tradeCount = 0;
  let totalPnl = 0;
  let gcCooldown = 0;
  const trades = [];

  // レンジ相場チェック
  const closes = candles.map(c => c.close);
  const efficiency = computeMarketEfficiency(closes);
  if (efficiency < 0.30) {
    return { symbol, pnl: 0, trades: [], skipped: true, reason: `レンジ相場 (効率=${efficiency.toFixed(2)})` };
  }

  for (let i = WARMUP_BARS; i < candles.length; i++) {
    const c = candles[i];
    const prev = candles[i - 1];
    if (!c.ma5 || !c.ma25 || !prev.ma5 || !prev.ma25 || !c.rsi) continue;

    const [hh, mm] = c.time.split(':').map(Number);
    const totalMin = hh * 60 + mm;

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
      });
      position = null;
      continue;
    }

    // デイリーストップ
    if (totalPnl <= DAILY_STOP_LOSS && !position) break;

    // 午後エントリー禁止
    const isAfternoon = totalMin >= 12 * 60 + 30;

    if (gcCooldown > 0) gcCooldown--;

    if (position) {
      const unrealizedPnl = position.type === 'long'
        ? (c.close - position.entryPrice) * position.shares
        : (position.entryPrice - c.close) * position.shares;

      // ピーク更新
      if (unrealizedPnl > position.peakPnl) position.peakPnl = unrealizedPnl;

      // 建値ストップ設定
      if (!position.breakeven && unrealizedPnl >= position.entryPrice * position.shares * BREAKEVEN_TRIGGER) {
        position.breakeven = true;
      }

      let exitReason = null;
      let exitPrice = c.close;

      if (position.type === 'long') {
        const stopPrice = position.breakeven
          ? position.entryPrice
          : position.entryPrice * (1 - LONG_STOP_LOSS_PERCENT / 100);
        if (c.close <= stopPrice) {
          exitReason = position.breakeven ? '建値ストップ' : '損切り';
          exitPrice = stopPrice;
        } else if (position.peakPnl > position.entryPrice * position.shares * TRAILING_TRIGGER) {
          const trailingStop = position.entryPrice + (position.peakPnl / position.shares) - position.entryPrice * TRAILING_STOP;
          if (c.close <= trailingStop) { exitReason = 'トレイリング利確'; }
        }
        // GCでのロング決済は廃止済み
      } else {
        // ショート
        const stopPrice = position.entryPrice * (1 + SHORT_STOP_LOSS_PERCENT / 100);
        if (c.close >= stopPrice) {
          exitReason = '損切り(ショート)';
          exitPrice = stopPrice;
        } else if (position.peakPnl > position.entryPrice * position.shares * TRAILING_TRIGGER) {
          const trailingStop = position.entryPrice - (position.peakPnl / position.shares) + position.entryPrice * TRAILING_STOP;
          if (c.close >= trailingStop) { exitReason = 'トレイリング利確(ショート)'; }
        }
        // 最大保有時間
        const holdBars = trades.length > 0 ? i - (candles.findIndex(cc => cc.time === position.entryTime) || 0) : 0;
        if (holdBars >= SHORT_MAX_HOLD_BARS && !exitReason) {
          exitReason = '最大保有時間超過(ショート)';
        }
        // GCカバー
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
        });
        position = null;
      }
    }

    if (!position && tradeCount < MAX_TRADES_PER_STOCK && !isAfternoon) {
      const isGC = prev.ma5 <= prev.ma25 && c.ma5 > c.ma25;
      const isDC = prev.ma5 >= prev.ma25 && c.ma5 < c.ma25;
      const mktUp = c.slope !== null && c.slope > 0.0005;
      const mktDown = c.slope !== null && c.slope < -0.0005;
      const flowBuy = c.flow !== null && c.flow > 0.2;
      const flowSell = c.flow !== null && c.flow < -0.2;

      // ロングエントリー
      if (isGC && mktUp && flowBuy && gcCooldown === 0) {
        const shares = Math.floor((CAPITAL * effectiveLot) / c.close);
        if (shares > 0) {
          position = { type: 'long', entryPrice: c.close, entryTime: c.time, shares, peakPnl: 0, breakeven: false };
          tradeCount++;
        }
      }
      // 押し目買い
      else if (!isGC && c.ma5 > c.ma25 && mktUp && c.rsi !== null && c.rsi < 45 && c.close <= c.ma25 * 1.005 && flowBuy) {
        const shares = Math.floor((CAPITAL * effectiveLot) / c.close);
        if (shares > 0) {
          position = { type: 'long', entryPrice: c.close, entryTime: c.time, shares, peakPnl: 0, breakeven: false };
          tradeCount++;
        }
      }
      // ショートエントリー（戻り売り）
      else if (!isDC && mktDown && c.rsi !== null && c.rsi >= 55 && c.close <= c.ma25 * 1.002 && flowSell && gcCooldown === 0) {
        const shares = Math.floor((CAPITAL * effectiveLot) / c.close);
        if (shares > 0) {
          position = { type: 'short', entryPrice: c.close, entryTime: c.time, shares, peakPnl: 0, breakeven: false };
          tradeCount++;
        }
      }
      // ショートエントリー（ブレイク売り）
      else if (mktDown && c.ma5 < c.ma25 && c.close < c.ma25 && flowSell && c.rsi !== null && c.rsi > 35 && gcCooldown === 0) {
        const shares = Math.floor((CAPITAL * effectiveLot) / c.close);
        if (shares > 0) {
          position = { type: 'short', entryPrice: c.close, entryTime: c.time, shares, peakPnl: 0, breakeven: false };
          tradeCount++;
        }
      }
    }
  }

  // 引け値強制決済（午後エントリー禁止なので通常は不要だが念のため）
  if (position) {
    const lastCandle = candles[candles.length - 1];
    const pnl = position.type === 'long'
      ? (lastCandle.close - position.entryPrice) * position.shares
      : (position.entryPrice - lastCandle.close) * position.shares;
    totalPnl += pnl;
    trades.push({
      type: position.type, entryTime: position.entryTime, exitTime: lastCandle.time,
      entryPrice: position.entryPrice, exitPrice: lastCandle.close,
      shares: position.shares, pnl: Math.round(pnl), reason: '引け値強制決済',
    });
    position = null;
  }

  return { symbol, pnl: Math.round(totalPnl), trades, skipped: false };
}

// ---- メイン ----
async function main() {
  console.log(`\n=== 本日（${TARGET_DATE}）損益シミュレーション ===\n`);

  const results = [];
  let totalPnl = 0;
  let totalTrades = 0;
  let winTrades = 0;
  let lossTrades = 0;

  for (const stock of SIMULATION_STOCKS) {
    process.stdout.write(`  ${stock.name}(${stock.symbol}) ... `);
    try {
      const bars = await fetchJqMinute(stock.symbol);
      if (bars.length === 0) {
        console.log('データなし');
        results.push({ ...stock, pnl: 0, trades: [], skipped: true, reason: 'データなし', bars: 0 });
        continue;
      }
      const candles = barsToCandles(bars);
      if (!candles) {
        console.log(`データ不足 (${bars.length}本)`);
        results.push({ ...stock, pnl: 0, trades: [], skipped: true, reason: `データ不足(${bars.length}本)`, bars: bars.length });
        continue;
      }
      const result = simulateStock(stock.symbol, candles);
      results.push({ ...stock, ...result, bars: candles.length });
      totalPnl += result.pnl;
      for (const t of result.trades) {
        totalTrades++;
        if (t.pnl > 0) winTrades++;
        else lossTrades++;
      }
      const sign = result.pnl >= 0 ? '+' : '';
      console.log(`${sign}${result.pnl.toLocaleString()}円 (${result.trades.length}取引${result.skipped ? ' ※スキップ' : ''})`);
    } catch (err) {
      console.log(`エラー: ${err.message}`);
      results.push({ ...stock, pnl: 0, trades: [], skipped: true, reason: `エラー: ${err.message}`, bars: 0 });
    }
    // レート制限対策
    await new Promise(r => setTimeout(r, 300));
  }

  const winRate = totalTrades > 0 ? (winTrades / totalTrades * 100).toFixed(1) : '0.0';

  console.log('\n' + '='.repeat(60));
  console.log(`合計損益: ${totalPnl >= 0 ? '+' : ''}${totalPnl.toLocaleString()} 円`);
  console.log(`総取引数: ${totalTrades}件 (勝: ${winTrades} / 負: ${lossTrades} / 勝率: ${winRate}%)`);
  console.log('='.repeat(60));

  // 取引詳細
  console.log('\n--- 銘柄別詳細 ---');
  for (const r of results) {
    if (r.skipped) {
      console.log(`\n[${r.name}(${r.symbol})] スキップ: ${r.reason}`);
      continue;
    }
    const sign = r.pnl >= 0 ? '+' : '';
    console.log(`\n[${r.name}(${r.symbol})] ${sign}${r.pnl.toLocaleString()}円 (${r.bars}本, ${r.trades.length}取引)`);
    for (const t of r.trades) {
      const sign2 = t.pnl >= 0 ? '+' : '';
      const typeStr = t.type === 'long' ? '買い' : '売り';
      console.log(`  ${typeStr} ${t.entryTime}→${t.exitTime} @${t.entryPrice}→${t.exitPrice} ${t.shares}株 ${sign2}${t.pnl.toLocaleString()}円 [${t.reason}]`);
    }
  }

  // JSON保存
  const outputPath = path.join(__dirname, `jq_out/today_${TARGET_DATE}.json`);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify({
    date: TARGET_DATE,
    totalPnl,
    totalTrades,
    winTrades,
    lossTrades,
    winRate: parseFloat(winRate),
    results,
  }, null, 2));
  console.log(`\n詳細データ保存: ${outputPath}`);

  return { totalPnl, totalTrades, winTrades, lossTrades, winRate, results };
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
