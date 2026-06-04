/**
 * チャートシグナル（RSI・MA5/MA25クロス）ベースの本日シミュレーション
 * slope/flow/mktBias による追加フィルターなし
 * 元金300万円、信用取引なし（現物相当）
 */
import { writeFileSync } from 'fs';

const API_KEY = 'csmPTBGa6DCWH1aE2fK5ym3YNiITLt7HHQRwlVhmFSs';
const DATE = '2026-06-04';
const CAPITAL = 3_000_000;

// 10銘柄
const SYMBOLS = [
  { code: '34360', name: 'SUMCO', lotRatio: 0.49 },
  { code: '69810', name: '村田製作所', lotRatio: 0.49 },
  { code: '37780', name: 'さくらインターネット', lotRatio: 0.49 },
  { code: '67580', name: 'ソニーグループ', lotRatio: 0.49 },
  { code: '83060', name: '三菱UFJ FG', lotRatio: 0.49 },
  { code: '80350', name: '東京エレクトロン', lotRatio: 0.05 },
  { code: '68570', name: 'アドバンテスト', lotRatio: 0.49 },
  { code: '69200', name: 'レーザーテック', lotRatio: 0.05 },
  { code: '70110', name: '三菱重工業', lotRatio: 0.49 },
  { code: '99840', name: 'ソフトバンクG', lotRatio: 0.05 },
];

// RSI閾値
const RSI_BUY = 30;   // RSI 30以下で買い
const RSI_SELL = 70;  // RSI 70以上で売り
const WARMUP = 25;    // MA25計算のウォームアップ

function calcMA(arr, n) {
  return arr.map((_, i) => i < n - 1 ? null : arr.slice(i - n + 1, i + 1).reduce((a, b) => a + b, 0) / n);
}

function calcRSI(closes, period = 14) {
  const rsi = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return rsi;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return rsi;
}

async function fetchBars(code) {
  const url = `https://api.jquants.com/v2/equities/bars/minute?code=${code}&from=${DATE}&to=${DATE}`;
  const resp = await fetch(url, { headers: { 'x-api-key': API_KEY } });
  const j = await resp.json();
  return j.data || [];
}

async function simulateSymbol(sym) {
  const bars = await fetchBars(sym.code);
  if (bars.length < WARMUP + 5) {
    return { ...sym, trades: [], totalPnl: 0, tradeCount: 0, winCount: 0, lossCount: 0, error: 'データ不足' };
  }

  const closes = bars.map(b => b.C);
  const ma5 = calcMA(closes, 5);
  const ma25 = calcMA(closes, 25);
  const rsi = calcRSI(closes, 14);

  const maxAmount = CAPITAL * sym.lotRatio;
  const openPrice = bars[0].O;
  const shares = Math.floor(maxAmount / openPrice / 100) * 100;

  const trades = [];
  let longShares = 0, longEntry = 0;
  let shortShares = 0, shortEntry = 0;
  let totalPnl = 0, winCount = 0, lossCount = 0;

  const STOP_LOSS_RATE = 0.03;   // 3%損切り
  const TAKE_PROFIT_RATE = 0.05; // 5%利確
  const TRAIL_RATE = 0.02;       // 2%トレイリング
  let longHighWater = 0, shortLowWater = Infinity;

  for (let i = WARMUP; i < bars.length; i++) {
    const bar = bars[i];
    const time = bar.Time;
    const price = bar.C;
    const m5 = ma5[i];
    const m25 = ma25[i];
    const r = rsi[i];
    if (m5 === null || m25 === null || r === null) continue;

    // 昼休み（12:00〜12:30）はエントリーしない
    if (time >= '12:00' && time < '12:30') continue;
    // 午後エントリー禁止（12:30以降）
    if (time >= '12:30' && longShares === 0 && shortShares === 0) continue;

    // ===== ロングポジション管理 =====
    if (longShares > 0) {
      if (price > longHighWater) longHighWater = price;
      const pnlRate = (price - longEntry) / longEntry;
      const trailDrop = (longHighWater - price) / longHighWater;

      // 損切り・利確・トレイリング
      const shouldExit = pnlRate <= -STOP_LOSS_RATE || pnlRate >= TAKE_PROFIT_RATE || trailDrop >= TRAIL_RATE;
      // GCからDCへの転換（MA5がMA25を下抜け）
      const prevM5 = ma5[i - 1], prevM25 = ma25[i - 1];
      const dcCross = prevM5 !== null && prevM25 !== null && prevM5 >= prevM25 && m5 < m25;

      if (shouldExit || dcCross || time >= '15:25') {
        const pnl = (price - longEntry) * longShares;
        totalPnl += pnl;
        if (pnl > 0) winCount++; else lossCount++;
        const reason = time >= '15:25' ? '引け強制決済' : dcCross ? 'DCクロス決済' : pnlRate <= -STOP_LOSS_RATE ? '損切り' : pnlRate >= TAKE_PROFIT_RATE ? '利確' : 'トレイリング';
        trades.push({ time, type: 'sell', entry: longEntry, exit: price, shares: longShares, pnl: Math.round(pnl), reason });
        longShares = 0; longEntry = 0; longHighWater = 0;
      }
    }

    // ===== ショートポジション管理 =====
    if (shortShares > 0) {
      if (price < shortLowWater) shortLowWater = price;
      const pnlRate = (shortEntry - price) / shortEntry;
      const trailRise = (price - shortLowWater) / shortLowWater;

      const shouldExit = pnlRate <= -STOP_LOSS_RATE || pnlRate >= TAKE_PROFIT_RATE || trailRise >= TRAIL_RATE;
      const prevM5 = ma5[i - 1], prevM25 = ma25[i - 1];
      const gcCross = prevM5 !== null && prevM25 !== null && prevM5 <= prevM25 && m5 > m25;

      if (shouldExit || gcCross || time >= '15:25') {
        const pnl = (shortEntry - price) * shortShares;
        totalPnl += pnl;
        if (pnl > 0) winCount++; else lossCount++;
        const reason = time >= '15:25' ? '引け強制決済' : gcCross ? 'GCクロス決済' : pnlRate <= -STOP_LOSS_RATE ? '損切り' : pnlRate >= TAKE_PROFIT_RATE ? '利確' : 'トレイリング';
        trades.push({ time, type: 'cover', entry: shortEntry, exit: price, shares: shortShares, pnl: Math.round(pnl), reason });
        shortShares = 0; shortEntry = 0; shortLowWater = Infinity;
      }
    }

    // ===== 新規エントリー =====
    if (shares === 0) continue;
    const prevM5 = ma5[i - 1], prevM25 = ma25[i - 1];

    // GCクロス（MA5がMA25を上抜け）+ RSI 30以上 → 買いエントリー
    if (longShares === 0 && shortShares === 0 && prevM5 !== null && prevM25 !== null) {
      const gcCross = prevM5 <= prevM25 && m5 > m25;
      if (gcCross && r >= RSI_BUY) {
        longShares = shares;
        longEntry = price;
        longHighWater = price;
        trades.push({ time, type: 'buy', entry: price, exit: null, shares, pnl: null, reason: `GCクロス RSI${r.toFixed(0)}` });
      }
    }

    // DCクロス（MA5がMA25を下抜け）+ RSI 70以下 → 売りエントリー
    if (longShares === 0 && shortShares === 0 && prevM5 !== null && prevM25 !== null) {
      const dcCross = prevM5 >= prevM25 && m5 < m25;
      if (dcCross && r <= RSI_SELL) {
        shortShares = shares;
        shortEntry = price;
        shortLowWater = price;
        trades.push({ time, type: 'short', entry: price, exit: null, shares, pnl: null, reason: `DCクロス RSI${r.toFixed(0)}` });
      }
    }

    // RSI過売り（30以下）でのリバーサルロング
    if (longShares === 0 && shortShares === 0 && r <= RSI_BUY) {
      const prevR = rsi[i - 1];
      if (prevR !== null && prevR <= RSI_BUY && r > prevR) { // RSIが底から反転
        longShares = shares;
        longEntry = price;
        longHighWater = price;
        trades.push({ time, type: 'buy', entry: price, exit: null, shares, pnl: null, reason: `RSI反転買い RSI${r.toFixed(0)}` });
      }
    }

    // RSI過買い（70以上）でのリバーサルショート
    if (longShares === 0 && shortShares === 0 && r >= RSI_SELL) {
      const prevR = rsi[i - 1];
      if (prevR !== null && prevR >= RSI_SELL && r < prevR) { // RSIが天井から反転
        shortShares = shares;
        shortEntry = price;
        shortLowWater = price;
        trades.push({ time, type: 'short', entry: price, exit: null, shares, pnl: null, reason: `RSI反転売り RSI${r.toFixed(0)}` });
      }
    }
  }

  // 未決済ポジションを引けで強制決済
  const lastBar = bars[bars.length - 1];
  if (longShares > 0) {
    const pnl = (lastBar.C - longEntry) * longShares;
    totalPnl += pnl;
    if (pnl > 0) winCount++; else lossCount++;
    trades.push({ time: lastBar.Time, type: 'sell', entry: longEntry, exit: lastBar.C, shares: longShares, pnl: Math.round(pnl), reason: '引け強制決済' });
  }
  if (shortShares > 0) {
    const pnl = (shortEntry - lastBar.C) * shortShares;
    totalPnl += pnl;
    if (pnl > 0) winCount++; else lossCount++;
    trades.push({ time: lastBar.Time, type: 'cover', entry: shortEntry, exit: lastBar.C, shares: shortShares, pnl: Math.round(pnl), reason: '引け強制決済' });
  }

  return {
    ...sym,
    trades,
    totalPnl: Math.round(totalPnl),
    tradeCount: trades.filter(t => t.pnl !== null).length,
    winCount,
    lossCount,
    shares,
    openPrice,
    dayHigh: Math.max(...bars.map(b => b.H)),
    dayLow: Math.min(...bars.map(b => b.L)),
    dayRange: ((Math.max(...bars.map(b => b.H)) - Math.min(...bars.map(b => b.L))) / bars[0].O * 100).toFixed(2),
  };
}

// 全銘柄シミュレーション実行
console.log(`\n=== チャートシグナルベース デイトレシミュレーション ${DATE} ===\n`);
const results = [];
for (const sym of SYMBOLS) {
  const r = await simulateSymbol(sym);
  results.push(r);
  const status = r.error ? `❌ ${r.error}` : `損益: ${r.totalPnl >= 0 ? '+' : ''}${r.totalPnl.toLocaleString()}円 (${r.tradeCount}取引, ${r.winCount}勝${r.lossCount}敗)`;
  console.log(`${sym.name}（${sym.code.replace(/0$/, '')}）: ${status}`);
}

const totalPnl = results.reduce((s, r) => s + r.totalPnl, 0);
const totalTrades = results.reduce((s, r) => s + r.tradeCount, 0);
const totalWins = results.reduce((s, r) => s + r.winCount, 0);
const totalLosses = results.reduce((s, r) => s + r.lossCount, 0);

console.log('\n=== 合計 ===');
console.log(`損益: ${totalPnl >= 0 ? '+' : ''}${totalPnl.toLocaleString()}円`);
console.log(`取引数: ${totalTrades}件 (${totalWins}勝${totalLosses}敗, 勝率${totalTrades > 0 ? (totalWins/totalTrades*100).toFixed(1) : 0}%)`);

// JSON保存
writeFileSync('/home/ubuntu/stock-alert-app/analysis/jq_out/chart_signal_today.json', JSON.stringify({ date: DATE, results, totalPnl, totalTrades, totalWins, totalLosses }, null, 2));
console.log('\n結果を chart_signal_today.json に保存しました');
